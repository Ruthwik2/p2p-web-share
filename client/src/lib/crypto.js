/**
 * Zero-knowledge encryption with AES-256-GCM (Web Crypto).
 *
 * Design: the sender generates a random symmetric key in the browser and places
 * it in the share link's URL *fragment* (`#k=...`). Fragments are never sent to
 * any server by the browser, so the signaling server only ever learns the room
 * id — never the key, never the plaintext. The receiver reads the key from its
 * own URL fragment and decrypts locally. End to end, the file is opaque to
 * every machine in the middle.
 *
 * Each chunk is sealed with a fresh 12-byte IV. GCM's authentication tag means
 * any bit-flip or tampering makes decryption fail loudly rather than silently
 * corrupting data.
 */

const subtle = globalThis.crypto?.subtle;

export const IV_BYTES = 12; // 96-bit nonce, the recommended size for AES-GCM
const KEY_ALGO = { name: 'AES-GCM', length: 256 };

export function encryptionAvailable() {
  return Boolean(subtle) && typeof subtle.encrypt === 'function';
}

export async function generateKey() {
  return subtle.generateKey(KEY_ALGO, true, ['encrypt', 'decrypt']);
}

/** Export a CryptoKey to a URL-safe base64 string for embedding in the link hash. */
export async function exportKey(key) {
  const raw = await subtle.exportKey('raw', key);
  return base64UrlEncode(new Uint8Array(raw));
}

/** Re-import a key from the base64url form produced by exportKey. */
export async function importKey(base64url) {
  const raw = base64UrlDecode(base64url);
  return subtle.importKey('raw', raw, KEY_ALGO, true, ['encrypt', 'decrypt']);
}

/**
 * Encrypt one chunk. Returns a single Uint8Array framed as [IV][ciphertext+tag]
 * so the receiver can decrypt it without any out-of-band IV bookkeeping.
 */
export async function encryptChunk(key, plaintext) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return out;
}

/** Decrypt a [IV][ciphertext+tag] frame back to plaintext bytes. */
export async function decryptChunk(key, framed) {
  const view = framed instanceof Uint8Array ? framed : new Uint8Array(framed);
  const iv = view.subarray(0, IV_BYTES);
  const ciphertext = view.subarray(IV_BYTES);
  const plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}

// --- base64url helpers (URL-fragment safe, no padding) ---

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
