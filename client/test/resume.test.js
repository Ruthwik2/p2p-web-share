/**
 * Unit test for the Peer auto-resume-on-churn state machine.
 *
 * WebRTC isn't available in Node, so we drive a controllable fake
 * RTCPeerConnection: it lets the test push connection-state transitions and
 * records the SDP offers the Peer produces. This exercises the real recovery
 * logic in peer.js — churn detection, ICE-restart offers, the responder's
 * resume request, successful resume, and the bounded retry that eventually
 * gives up — without a browser.
 *
 * Run: node client/test/resume.test.js
 */
import { Peer } from '../src/lib/peer.js';

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass += 1; console.log('  PASS', label); }
  else { fail += 1; console.log('  FAIL', label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake RTCPeerConnection whose state the test can puppet. */
class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.sctp = { maxMessageSize: 64 * 1024 };
    this.lastOfferOptions = null;
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.ondatachannel = null;
  }
  createDataChannel() {
    return {
      binaryType: '', bufferedAmountLowThreshold: 0,
      onopen: null, onclose: null, onerror: null, onmessage: null, onbufferedamountlow: null,
      close() {},
    };
  }
  async createOffer(options = {}) {
    this.lastOfferOptions = options;
    return { type: 'offer', sdp: options.iceRestart ? 'sdp-restart' : 'sdp-initial' };
  }
  async createAnswer() { return { type: 'answer', sdp: 'sdp-answer' }; }
  async setLocalDescription(desc) { this.localDescription = desc; }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }

  /** Push a transition and fire the handlers the Peer listens on. */
  drive(connectionState, iceConnectionState = connectionState) {
    this.connectionState = connectionState;
    this.iceConnectionState = iceConnectionState;
    this.onconnectionstatechange?.();
  }
}

let pcs = [];
globalThis.RTCPeerConnection = class extends FakePC {
  constructor() { super(); pcs.push(this); }
};

/** Collect every emitted event of interest from a Peer. */
function trace(peer) {
  const events = { signal: [], resuming: [], resumed: 0, 'resume-failed': 0, error: [] };
  peer.on('signal', (d) => events.signal.push(d));
  peer.on('resuming', (d) => events.resuming.push(d));
  peer.on('resumed', () => { events.resumed += 1; });
  peer.on('resume-failed', () => { events['resume-failed'] += 1; });
  peer.on('error', (e) => events.error.push(e));
  return events;
}

async function main() {
  console.log('peer auto-resume — churn recovery\n');

  // 1. Initiator: an established link that fails triggers an ICE-restart offer,
  //    and a restored link reports 'resumed'.
  {
    const peer = new Peer({ initiator: true, resume: { disconnectGraceMs: 5, retryDelayMs: 1000, maxAttempts: 5 } });
    const ev = trace(peer);
    await peer.start();
    const pc = pcs.at(-1);

    pc.drive('connected');           // come up
    pc.drive('failed');              // churn
    await wait(20);

    const restartOffer = ev.signal.find((s) => s.kind === 'offer' && s.sdp?.sdp === 'sdp-restart');
    check('initiator: churn emits a resuming event', ev.resuming.length >= 1 && ev.resuming[0].attempt === 1);
    check('initiator: churn produces an ICE-restart offer', Boolean(restartOffer));
    check('initiator: createOffer asked for iceRestart', pc.lastOfferOptions?.iceRestart === true);

    pc.drive('connected');           // path restored
    await wait(10);
    check('initiator: restored link reports resumed', ev.resumed === 1);
    check('initiator: no fatal error on a recovered churn', ev.error.length === 0);
    peer.close();
  }

  // 2. Responder: it must NOT offer (that would glare) — it asks the initiator
  //    to restart with a 'resume' signal.
  {
    const peer = new Peer({ initiator: false, resume: { disconnectGraceMs: 5, retryDelayMs: 1000, maxAttempts: 5 } });
    const ev = trace(peer);
    const pc = pcs.at(-1);

    pc.drive('connected');
    pc.drive('failed');
    await wait(20);

    const resumeReq = ev.signal.find((s) => s.kind === 'resume');
    const anyOffer = ev.signal.find((s) => s.kind === 'offer');
    check('responder: requests a resume from the initiator', Boolean(resumeReq));
    check('responder: never emits its own offer (no glare)', !anyOffer);
    peer.close();
  }

  // 3. A transient 'disconnected' that self-heals within the grace window spends
  //    no restart at all.
  {
    const peer = new Peer({ initiator: true, resume: { disconnectGraceMs: 40, retryDelayMs: 1000, maxAttempts: 5 } });
    const ev = trace(peer);
    await peer.start();
    const pc = pcs.at(-1);

    pc.drive('connected');
    pc.drive('disconnected');        // wobble
    await wait(10);
    pc.drive('connected');           // self-heals before grace elapses
    await wait(60);
    check('transient disconnect that self-heals spends no restart', ev.resuming.length === 0);
    peer.close();
  }

  // 4. A drop that never recovers exhausts the retries and becomes fatal.
  {
    const peer = new Peer({ initiator: true, resume: { disconnectGraceMs: 1, retryDelayMs: 8, maxAttempts: 3 } });
    const ev = trace(peer);
    await peer.start();
    const pc = pcs.at(-1);

    pc.drive('connected');
    pc.drive('failed');
    await wait(120);                 // let all retries run out
    check('exhausted recovery emits resume-failed', ev['resume-failed'] === 1);
    check('exhausted recovery surfaces a fatal error', ev.error.length === 1);
    check('recovery is bounded to maxAttempts tries', ev.resuming.length === 3);
    peer.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
