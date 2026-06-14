import { Emitter } from './emitter.js';
import { RateMeter } from './rate.js';
import { sha256OfBlob } from './hash.js';
import { decryptChunk } from './crypto.js';
import {
  MsgType,
  parseFrame,
  encodeControl,
  decodeControl,
  isControlMessage,
} from './protocol.js';

/**
 * Receives a single file from the connected peer.
 *
 * Lifecycle: [peer sends meta] -> accept -> collect + (decrypt) chunks ->
 * reassemble -> re-hash and compare to the sender's digest -> confirm + save.
 *
 * Emits: 'meta' {...}, 'phase' (string), 'progress' {...},
 *        'done' {blob, name, verified, hash}, 'error' (Error), 'cancelled' {by}.
 */
export class FileReceiver extends Emitter {
  constructor({ peer, key = null }) {
    super();
    this.peer = peer;
    this.key = key;

    this.meta = null;
    this.chunks = []; // plaintext chunks indexed by chunk index
    this.receivedCount = 0;
    this.bytesReceived = 0;
    this.cancelled = false;
    this.finished = false;
    this.meter = new RateMeter();
    this._startedAt = 0;

    this._offMessage = this.peer.on('message', (data) => this._onMessage(data));
  }

  async _onMessage(data) {
    if (this.cancelled || this.finished) return;

    if (isControlMessage(data)) {
      let msg;
      try {
        msg = decodeControl(data);
      } catch {
        return;
      }
      if (msg.t === MsgType.META) await this._onMeta(msg);
      else if (msg.t === MsgType.ERROR) this.emit('error', new Error(msg.message || 'The sender reported an error.'));
      else if (msg.t === MsgType.CANCEL) this.emit('cancelled', { by: 'peer' });
      return;
    }

    // Otherwise it's a binary chunk frame.
    await this._onChunk(data);
  }

  async _onMeta(meta) {
    if (meta.encrypted && !this.key) {
      this._fail('This file is encrypted, but the link is missing its decryption key.');
      return;
    }
    this.meta = meta;
    this.chunks = new Array(meta.totalChunks);
    this._startedAt = performance.now();
    this.emit('meta', meta);
    this.emit('phase', 'receiving');
    this.peer.send(encodeControl({ t: MsgType.ACCEPT }));
    this._emitProgress();

    // A zero-byte file has no chunks — finalize immediately.
    if (meta.totalChunks === 0) await this._finalize();
  }

  async _onChunk(data) {
    if (!this.meta) return; // ignore stray frames before metadata
    const { index, payload } = parseFrame(data);

    let plaintext;
    try {
      plaintext = this.meta.encrypted ? await decryptChunk(this.key, payload) : new Uint8Array(payload);
    } catch {
      // AES-GCM authentication failed: corruption or tampering on this chunk.
      this._fail('A chunk failed decryption — the data may be corrupted or tampered with.');
      return;
    }

    if (index < 0 || index >= this.chunks.length || this.chunks[index]) return; // guard duplicates/out-of-range
    this.chunks[index] = plaintext;
    this.receivedCount += 1;
    this.bytesReceived += plaintext.byteLength;
    this.meter.update(this.bytesReceived);
    this._emitProgress();

    if (this.receivedCount === this.meta.totalChunks) await this._finalize();
  }

  async _finalize() {
    if (this.finished || this.cancelled) return;
    this.emit('phase', 'verifying');

    const blob = new Blob(this.chunks, { type: this.meta.mime });
    this.chunks = []; // release chunk references; the blob owns the bytes now

    // Re-hash the reassembled bytes and compare to the sender's digest. Equal
    // digests prove every byte survived the trip intact.
    const hash = await sha256OfBlob(blob);
    const verified = hash === this.meta.hash;

    this.peer.send(encodeControl({ t: MsgType.COMPLETE, ok: verified }));

    if (!verified) {
      this._fail('Integrity check failed: the received file does not match the original.');
      return;
    }

    this.finished = true;
    this.emit('done', { blob, name: this.meta.name, verified: true, hash });
  }

  _fail(message) {
    if (this.finished || this.cancelled) return;
    try {
      this.peer.send(encodeControl({ t: MsgType.ERROR, message }));
    } catch { /* channel may be gone */ }
    this.emit('error', new Error(message));
  }

  _emitProgress() {
    const total = this.meta?.size ?? 0;
    const remaining = Math.max(0, total - this.bytesReceived);
    this.emit('progress', {
      bytesReceived: this.bytesReceived,
      total,
      percent: total ? this.bytesReceived / total : 0,
      speed: this.meter.bytesPerSecond,
      etaMs: this.meter.etaMs(remaining),
      elapsedMs: this._startedAt ? performance.now() - this._startedAt : 0,
    });
  }

  cancel() {
    if (this.cancelled || this.finished) return;
    this.cancelled = true;
    try {
      this.peer.send(encodeControl({ t: MsgType.CANCEL }));
    } catch { /* channel may be gone */ }
    this.emit('cancelled', { by: 'self' });
  }

  dispose() {
    this._offMessage?.();
    this.removeAllListeners();
    this.chunks = [];
  }
}
