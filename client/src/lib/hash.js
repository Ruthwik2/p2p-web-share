/**
 * Integrity helpers built on the native Web Crypto SubtleCrypto API.
 *
 * The transfer guarantees "zero data corruption" by hashing the file with
 * SHA-256 on the sender before transfer and re-hashing the reassembled bytes on
 * the receiver afterward. If the two digests match, every byte arrived intact.
 *
 * (When zero-knowledge encryption is enabled, AES-GCM additionally
 * authenticates each individual chunk via its tag — so corruption or tampering
 * is caught per-chunk as well as for the whole file.)
 */

const subtle = globalThis.crypto?.subtle;

export function cryptoAvailable() {
  return Boolean(subtle) && typeof subtle.digest === 'function';
}

/** Compute the SHA-256 digest of a buffer and return it as a lowercase hex string. */
export async function sha256Hex(buffer) {
  const digest = await subtle.digest('SHA-256', buffer);
  return bufferToHex(digest);
}

/** Compute SHA-256 over a Blob/File without forcing the caller to read it first. */
export async function sha256OfBlob(blob) {
  const buffer = await blob.arrayBuffer();
  return sha256Hex(buffer);
}

export function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
