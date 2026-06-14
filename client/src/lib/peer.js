import { Emitter } from './emitter.js';

/**
 * RTCPeerConnection + RTCDataChannel wrapper for a single 1-to-1 link.
 *
 * Roles:
 *   initiator (the file host) creates the data channel and the SDP offer.
 *   responder (the receiver) answers and picks up the channel via ondatachannel.
 *
 * Signaling is delegated: this object EMITS 'signal' with payloads the caller
 * relays through the signaling server, and is fed remote payloads via
 * handleSignal(). It never touches the signaling transport itself.
 *
 * Auto-resume on churn:
 *   A connection that has come up once and then drops ('disconnected'/'failed')
 *   is recovered by an *ICE restart* rather than a teardown. The SCTP
 *   association — and therefore the RTCDataChannel and any in-flight transfer —
 *   survives an ICE restart, so renegotiating the network path lets the transfer
 *   continue seamlessly. The initiator is the sole restart driver (so there's no
 *   glare); the responder asks for one with a 'resume' signal. Recovery is
 *   retried with a bounded number of attempts before the drop is declared fatal.
 *
 * Events: 'signal' {kind,...}, 'open', 'close', 'message' (data),
 *         'state' {connection, ice}, 'bufferedlow', 'error' (Error),
 *         'resuming' {attempt, max}, 'resumed', 'resume-failed'.
 */
export class Peer extends Emitter {
  constructor({ iceServers = [], initiator = false, autoResume = true, resume = {} } = {}) {
    super();
    this.initiator = initiator;
    this.autoResume = autoResume;
    // Tunables for the recovery loop. Defaults give ~grace + 8 tries over ~20s,
    // comfortably outlasting a Socket.io reconnect after a full network change.
    this.resumeCfg = {
      maxAttempts: resume.maxAttempts ?? 8,
      disconnectGraceMs: resume.disconnectGraceMs ?? 2000,
      retryDelayMs: resume.retryDelayMs ?? 2500,
    };

    this.pc = new RTCPeerConnection({ iceServers });
    this.channel = null;
    this._remoteSet = false;
    this._pendingCandidates = []; // ICE that arrived before remoteDescription

    // Resume state machine.
    this._everConnected = false;
    this._resuming = false;
    this._resumeAttempts = 0;
    this._resumeTimer = null;
    this._destroyed = false;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.emit('signal', { kind: 'candidate', candidate: e.candidate });
    };
    this.pc.onconnectionstatechange = () => this._onTransportChange();
    this.pc.oniceconnectionstatechange = () => this._onTransportChange();
    // Responder receives the channel the initiator created.
    this.pc.ondatachannel = (e) => this._bindChannel(e.channel);
  }

  /** Initiator only: create the channel and kick off the offer. */
  async start() {
    if (!this.initiator) return;
    const channel = this.pc.createDataChannel('file', { ordered: true });
    this._bindChannel(channel);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.emit('signal', { kind: 'offer', sdp: this.pc.localDescription });
  }

  /** Route an inbound signaling payload to the right handler. */
  async handleSignal(data) {
    try {
      if (data.kind === 'offer') await this._onOffer(data.sdp);
      else if (data.kind === 'answer') await this._onAnswer(data.sdp);
      else if (data.kind === 'candidate') await this._onCandidate(data.candidate);
      else if (data.kind === 'resume') this._onResumeRequest();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  async _onOffer(sdp) {
    // The same path serves the initial offer and every later ICE-restart offer:
    // applying a fresh remote offer while stable simply renegotiates the path.
    await this.pc.setRemoteDescription(sdp);
    this._remoteSet = true;
    await this._drainCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.emit('signal', { kind: 'answer', sdp: this.pc.localDescription });
  }

  async _onAnswer(sdp) {
    await this.pc.setRemoteDescription(sdp);
    this._remoteSet = true;
    await this._drainCandidates();
  }

  async _onCandidate(candidate) {
    // Candidates can race ahead of the remote description; buffer until ready.
    if (!this._remoteSet) {
      this._pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // During an ICE restart a candidate can arrive against credentials that
      // aren't applied yet; that's recoverable, never fatal — keep the link.
      console.warn('failed to add ICE candidate:', err);
    }
  }

  async _drainCandidates() {
    const pending = this._pendingCandidates;
    this._pendingCandidates = [];
    for (const c of pending) {
      try {
        await this.pc.addIceCandidate(c);
      } catch (err) {
        console.warn('failed to add buffered ICE candidate:', err);
      }
    }
  }

  // --- resume state machine --------------------------------------------------

  /**
   * Unified handler for connection/ICE state transitions. Mirrors state out to
   * the UI and drives the recovery loop: a path that comes up clears any pending
   * recovery; one that drops after having been up triggers an ICE restart.
   */
  _onTransportChange() {
    const connection = this.pc.connectionState;
    const ice = this.pc.iceConnectionState;
    this.emit('state', { connection, ice });
    if (this._destroyed) return;

    if (connection === 'connected' || ice === 'connected' || ice === 'completed') {
      this._onRestored();
      return;
    }
    if (connection === 'failed' || ice === 'failed') {
      // A hard failure: try to recover immediately.
      this._scheduleResume(0);
    } else if ((connection === 'disconnected' || ice === 'disconnected') && this._everConnected) {
      // A transient wobble on an established link often self-heals — give it a
      // short grace window before spending a restart on it.
      this._scheduleResume(this.resumeCfg.disconnectGraceMs);
    }
  }

  _onRestored() {
    this._everConnected = true;
    if (this._resumeTimer) {
      clearTimeout(this._resumeTimer);
      this._resumeTimer = null;
    }
    if (this._resuming) {
      this._resuming = false;
      this._resumeAttempts = 0;
      this.emit('resumed');
    }
  }

  _scheduleResume(delay) {
    if (this._destroyed) return;
    if (!this.autoResume) {
      // Recovery disabled: preserve the original fail-fast behaviour.
      if (this.pc.connectionState === 'failed') {
        this.emit('error', new Error('The peer connection failed (no viable network path).'));
      }
      return;
    }
    this._resuming = true;
    if (this._resumeTimer) clearTimeout(this._resumeTimer);
    this._resumeTimer = setTimeout(() => this._attemptResume(), delay);
  }

  _attemptResume() {
    this._resumeTimer = null;
    if (this._destroyed || !this.autoResume) return;

    // Maybe the path recovered while the timer was pending.
    const connection = this.pc.connectionState;
    const ice = this.pc.iceConnectionState;
    if (connection === 'connected' || ice === 'connected' || ice === 'completed') {
      this._onRestored();
      return;
    }

    if (this._resumeAttempts >= this.resumeCfg.maxAttempts) {
      this._resuming = false;
      this.emit('resume-failed');
      this.emit('error', new Error('The connection dropped and could not be restored.'));
      return;
    }

    this._resumeAttempts += 1;
    this.emit('resuming', { attempt: this._resumeAttempts, max: this.resumeCfg.maxAttempts });

    if (this.initiator) {
      this._doIceRestart();
    } else {
      // The responder can't offer (that would cause glare) — ask the initiator
      // to restart. If the initiator already saw the drop it's a harmless no-op.
      this.emit('signal', { kind: 'resume' });
    }

    // Keep trying until the path is restored or attempts are exhausted. The next
    // attempt is cancelled the instant the connection reports 'connected'.
    this._resumeTimer = setTimeout(() => this._attemptResume(), this.resumeCfg.retryDelayMs);
  }

  /** Initiator: renegotiate ICE without tearing down the data channel. */
  async _doIceRestart() {
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.emit('signal', { kind: 'offer', sdp: this.pc.localDescription });
    } catch (err) {
      // Swallow: the scheduled retry will try again. A throw here would surface
      // as a fatal 'error' and defeat the whole point of auto-resume.
      console.warn('ICE restart offer failed; will retry:', err);
    }
  }

  /** Initiator side of a responder's 'resume' request. */
  _onResumeRequest() {
    if (!this.initiator || this._destroyed || !this.autoResume) return;
    if (this.pc.connectionState === 'connected') return; // already healthy
    this._scheduleResume(0);
  }

  /**
   * Nudge the recovery loop from the outside — e.g. once signaling has
   * reconnected after a network change, so a restart offer can finally be
   * relayed. No-op when the link is healthy or recovery is disabled.
   */
  nudgeResume() {
    if (this._destroyed || !this.autoResume) return;
    if (this.pc.connectionState === 'connected') return;
    this._scheduleResume(0);
  }

  /** True while a recovery cycle is in flight (for UI/diagnostics). */
  get resuming() {
    return this._resuming;
  }

  // --- channel & I/O ---------------------------------------------------------

  _bindChannel(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    // Fire 'bufferedlow' when the send buffer drains below the threshold so the
    // sender can resume streaming without overflowing memory.
    channel.bufferedAmountLowThreshold = 1 * 1024 * 1024;
    channel.onopen = () => this.emit('open');
    channel.onclose = () => this.emit('close');
    channel.onerror = (e) => this.emit('error', e.error || new Error('Data channel error.'));
    channel.onmessage = (e) => this.emit('message', e.data);
    channel.onbufferedamountlow = () => this.emit('bufferedlow');
  }

  send(data) {
    this.channel.send(data);
  }

  get bufferedAmount() {
    return this.channel?.bufferedAmount ?? 0;
  }

  get readyState() {
    return this.channel?.readyState ?? 'closed';
  }

  /**
   * Largest message the SCTP transport will accept, negotiated at connect time.
   * Used to size chunks as large as safely possible. Falls back to a
   * conservative 16 KiB when the value isn't exposed yet.
   */
  get maxMessageSize() {
    const size = this.pc.sctp?.maxMessageSize;
    if (typeof size === 'number' && size > 0 && Number.isFinite(size)) return size;
    return 16 * 1024;
  }

  /** Resolve once the send buffer has drained below the low threshold. */
  waitForBufferedLow() {
    return new Promise((resolve) => {
      const off = this.on('bufferedlow', () => {
        off();
        resolve();
      });
    });
  }

  close() {
    this._destroyed = true;
    if (this._resumeTimer) {
      clearTimeout(this._resumeTimer);
      this._resumeTimer = null;
    }
    try {
      this.channel?.close();
    } catch { /* already closing */ }
    try {
      this.pc.close();
    } catch { /* already closed */ }
    this.removeAllListeners();
  }
}
