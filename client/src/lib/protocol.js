/**
 * The data-channel wire protocol.
 *
 * Two kinds of messages travel over the RTCDataChannel:
 *
 *  1. Control messages — JSON, sent as strings. Distinguished at the receiver by
 *     `typeof event.data === 'string'`.
 *  2. Chunk frames — binary ArrayBuffers. Each is prefixed with a 4-byte
 *     little-endian uint32 chunk index, so frames are self-describing and could
 *     be applied out of order or resumed after a reconnect.
 *
 *       plain:      [ 4B index ][ raw bytes ]
 *       encrypted:  [ 4B index ][ 12B IV ][ ciphertext+tag ]   (IV framing lives in crypto.js)
 */

export const MsgType = Object.freeze({
  META: 'meta', // sender -> receiver: file descriptor, sent once up front
  ACCEPT: 'accept', // receiver -> sender: buffers ready, start sending
  COMPLETE: 'complete', // receiver -> sender: all chunks received + integrity result
  ERROR: 'error', // either direction: fatal problem, abort
  CANCEL: 'cancel', // either direction: user cancelled
});

export const HEADER_BYTES = 4; // uint32 chunk index

/** Prefix a chunk payload with its little-endian uint32 index. */
export function frameChunk(index, payload) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(HEADER_BYTES + body.byteLength);
  new DataView(out.buffer).setUint32(0, index, true);
  out.set(body, HEADER_BYTES);
  return out.buffer;
}

/** Split a received frame into its index and payload (a view, no copy). */
export function parseFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const index = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const payload = bytes.subarray(HEADER_BYTES);
  return { index, payload };
}

export function encodeControl(message) {
  return JSON.stringify(message);
}

export function decodeControl(text) {
  return JSON.parse(text);
}

export function isControlMessage(data) {
  return typeof data === 'string';
}
