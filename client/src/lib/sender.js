import { Emitter } from './emitter.js';
import { RateMeter } from './rate.js';
import { readBlobAsArrayBuffer } from './fileio.js';
import { sha256Hex } from './hash.js';
import { encryptChunk, IV_BYTES } from './crypto.js';
import {
  MsgType,
  HEADER_BYTES,
  frameChunk,
  encodeControl,
  decodeControl,
  isControlMessage,
} from './protocol.js';

const GCM_TAG_BYTES = 16;
const HIGH_WATER_MARK = 8 * 1024 * 1024; // pause streaming above this buffered amount
const MAX_FRAME = 256 * 1024; // cap chunk frames even if SCTP allows more
const YIELD_EVERY = 16; // hand control back to the event loop periodically

const tick = () => new Promise((r) => setTimeout(r));

/**
 * Sends a single file to the connected peer over the data channel.
 *
 * Lifecycle: prepare() (read + hash) -> start() (announce) -> [peer accepts] ->
 * stream chunks with backpressure -> [peer confirms integrity] -> done.
 *
 * Emits: 'phase' (string), 'progress' {...}, 'done' {verified}, 'error' (Error),
 *        'cancelled' {by}.
 */
export class FileSender extends Emitter {
  constructor({ peer, file, encrypt = false, key = null }) {
    super();
    this.peer = peer;
    this.file = file;
    this.encrypt = encrypt && Boolean(key);
    this.key = key;

    this.buffer = null; // ArrayBuffer of the whole file (MVP: <50 MB in memory)
    this.fileHash = null;
    this.chunkSize = 16 * 1024;
    this.totalChunks = 0;
    this.bytesSent = 0;
    this.cancelled = false;
    this.meter = new RateMeter();
    this._startedAt = 0;

    this._offMessage = this.peer.on('message', (data) => this._onMessage(data));
  }

  /** Read the file into memory and compute its SHA-256 integrity digest. */
  async prepare() {
    this.emit('phase', 'reading');
    this.buffer = await readBlobAsArrayBuffer(this.file);
    this.emit('phase', 'hashing');
    this.fileHash = await sha256Hex(this.buffer);
    this.emit('ready', { hash: this.fileHash, size: this.file.size });
  }

  /** Announce the file to the peer. Streaming begins when the peer accepts. */
  start() {
    // Size chunks as large as the negotiated SCTP transport safely allows,
    // leaving room for the frame header and (if encrypting) the IV + GCM tag.
    const overhead = HEADER_BYTES + (this.encrypt ? IV_BYTES + GCM_TAG_BYTES : 0);
    const maxFrame = Math.min(this.peer.maxMessageSize, MAX_FRAME);
    this.chunkSize = Math.max(4096, maxFrame - overhead);
    this.totalChunks = Math.ceil(this.buffer.byteLength / this.chunkSize);

    this.peer.send(
      encodeControl({
        t: MsgType.META,
        name: this.file.name,
        size: this.file.size,
        mime: this.file.type || 'application/octet-stream',
        chunkSize: this.chunkSize,
        totalChunks: this.totalChunks,
        hash: this.fileHash,
        encrypted: this.encrypt,
      }),
    );
    this.emit('phase', 'awaiting-accept');
  }

  async _onMessage(data) {
    if (!isControlMessage(data)) return; // the sender never receives binary
    let msg;
    try {
      msg = decodeControl(data);
    } catch {
      return;
    }
    if (msg.t === MsgType.ACCEPT) {
      await this._stream();
    } else if (msg.t === MsgType.COMPLETE) {
      if (msg.ok) this.emit('done', { verified: true });
      else this.emit('error', new Error('The receiver detected an integrity mismatch.'));
    } else if (msg.t === MsgType.ERROR) {
      this.emit('error', new Error(msg.message || 'The receiver reported an error.'));
    } else if (msg.t === MsgType.CANCEL) {
      this.emit('cancelled', { by: 'peer' });
    }
  }

  async _stream() {
    this.emit('phase', 'transferring');
    this._startedAt = performance.now();
    const total = this.buffer.byteLength;
    let offset = 0;
    let index = 0;

    this._emitProgress();

    while (offset < total) {
      if (this.cancelled) return;

      const end = Math.min(offset + this.chunkSize, total);
      const view = new Uint8Array(this.buffer, offset, end - offset);
      const payload = this.encrypt ? await encryptChunk(this.key, view) : view;
      this.peer.send(frameChunk(index, payload));

      this.bytesSent += end - offset; // progress tracks plaintext throughput
      this.meter.update(this.bytesSent);
      offset = end;
      index += 1;
      this._emitProgress();

      // Backpressure: never let the send buffer balloon past the high-water mark.
      if (this.peer.bufferedAmount >= HIGH_WATER_MARK) {
        await this.peer.waitForBufferedLow();
      } else if (index % YIELD_EVERY === 0) {
        await tick(); // keep the UI responsive on fast links
      }
    }

    // Make sure every queued byte has actually left before we wait on the peer.
    this.emit('phase', 'flushing');
    await this._drainFully();
    if (this.cancelled) return;
    this.emit('phase', 'verifying');
  }

  async _drainFully() {
    // bufferedamountlow won't re-fire once already below threshold, so poll the
    // final tail of the buffer down to zero.
    while (this.peer.bufferedAmount > 0 && !this.cancelled) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  _emitProgress() {
    const total = this.buffer.byteLength;
    const remaining = total - this.bytesSent;
    this.emit('progress', {
      bytesSent: this.bytesSent,
      total,
      percent: total ? this.bytesSent / total : 1,
      speed: this.meter.bytesPerSecond,
      etaMs: this.meter.etaMs(remaining),
      elapsedMs: this._startedAt ? performance.now() - this._startedAt : 0,
    });
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    try {
      this.peer.send(encodeControl({ t: MsgType.CANCEL }));
    } catch { /* channel may already be gone */ }
    this.emit('cancelled', { by: 'self' });
  }

  dispose() {
    this._offMessage?.();
    this.removeAllListeners();
    this.buffer = null;
  }
}
