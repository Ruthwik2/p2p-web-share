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
 * Events: 'signal' {kind,...}, 'open', 'close', 'message' (data),
 *         'state' {connection, ice}, 'bufferedlow', 'error' (Error).
 */
export class Peer extends Emitter {
  constructor({ iceServers = [], initiator = false } = {}) {
    super();
    this.initiator = initiator;
    this.pc = new RTCPeerConnection({ iceServers });
    this.channel = null;
    this._remoteSet = false;
    this._pendingCandidates = []; // ICE that arrived before remoteDescription

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.emit('signal', { kind: 'candidate', candidate: e.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      this.emit('state', { connection: this.pc.connectionState, ice: this.pc.iceConnectionState });
      if (this.pc.connectionState === 'failed') {
        this.emit('error', new Error('The peer connection failed (no viable network path).'));
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      this.emit('state', { connection: this.pc.connectionState, ice: this.pc.iceConnectionState });
    };
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
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  async _onOffer(sdp) {
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
    await this.pc.addIceCandidate(candidate);
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
    try {
      this.channel?.close();
    } catch { /* already closing */ }
    try {
      this.pc.close();
    } catch { /* already closed */ }
    this.removeAllListeners();
  }
}
