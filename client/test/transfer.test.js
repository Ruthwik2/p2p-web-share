/**
 * End-to-end test of the transfer engine (FileSender + FileReceiver) without a
 * browser or real WebRTC. Two MockPeers are wired into a loopback so a real file
 * flows sender -> receiver through the exact production code path: chunking,
 * framing, optional AES-GCM encryption, reassembly, and SHA-256 verification.
 *
 * Node 22 provides the real Web Crypto, Blob, and File globals; we only shim
 * FileReader (browser-only) so fileio.js can run.
 *
 * Run: node client/test/transfer.test.js
 */
import { FileSender } from '../src/lib/sender.js';
import { FileReceiver } from '../src/lib/receiver.js';
import { Emitter } from '../src/lib/emitter.js';
import { generateKey } from '../src/lib/crypto.js';
import { isControlMessage } from '../src/lib/protocol.js';

// --- FileReader shim (browser-only API) backed by Blob.arrayBuffer ---
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob
      .arrayBuffer()
      .then((buf) => {
        this.result = buf;
        this.onload?.();
      })
      .catch((err) => {
        this.error = err;
        this.onerror?.();
      });
  }
};

/**
 * A peer that delivers whatever it's sent straight to its partner's message
 * listeners, asynchronously (like a real channel). Supports an optional
 * `tamper` hook to corrupt a frame in flight.
 */
class MockPeer extends Emitter {
  constructor({ tamper = null } = {}) {
    super();
    this.partner = null;
    this.tamper = tamper;
    this.bufferedAmount = 0; // instant loopback => no backpressure
    this.maxMessageSize = 64 * 1024;
  }

  link(partner) {
    this.partner = partner;
  }

  send(data) {
    let payload = data;
    if (!isControlMessage(data) && this.tamper) {
      payload = this.tamper(data);
    }
    queueMicrotask(() => this.partner.emit('message', payload));
  }

  waitForBufferedLow() {
    return Promise.resolve();
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { pass += 1; console.log('  PASS', label); }
  else { fail += 1; console.log('  FAIL', label); }
}

function randomFile(name, size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes.subarray(0, Math.min(size, 65536)));
  // Fill the rest with a deterministic pattern (getRandomValues caps at 64KB).
  for (let i = 65536; i < size; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
  return new File([bytes], name, { type: 'application/octet-stream' });
}

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function equalBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Run one full transfer; resolve with the receiver's 'done'/'error' outcome. */
function runTransfer({ file, encrypt, key, tamper = null }) {
  return new Promise(async (resolve) => {
    const senderPeer = new MockPeer({ tamper });
    const receiverPeer = new MockPeer();
    senderPeer.link(receiverPeer);
    receiverPeer.link(senderPeer);

    const receiver = new FileReceiver({ peer: receiverPeer, key });
    const sender = new FileSender({ peer: senderPeer, file, encrypt, key });

    const result = { progressEvents: 0, maxPercent: 0 };
    receiver.on('progress', (p) => {
      result.progressEvents += 1;
      result.maxPercent = Math.max(result.maxPercent, p.percent);
    });
    receiver.on('done', (d) => resolve({ ok: true, ...d, ...result }));
    receiver.on('error', (e) => resolve({ ok: false, error: e.message, ...result }));
    sender.on('error', (e) => {
      // Surface sender-side failures too (e.g. peer reported integrity error).
      if (!receiver.finished) resolve({ ok: false, error: e.message, ...result });
    });

    await sender.prepare();
    sender.start();
  });
}

async function main() {
  console.log('transfer engine — end to end\n');

  // 1. Plain transfer, multi-chunk file
  {
    const file = randomFile('plain.bin', 200 * 1024); // ~3+ chunks at 64KB
    const original = await bytesOf(file);
    const out = await runTransfer({ file, encrypt: false, key: null });
    check('plain: completes', out.ok === true);
    check('plain: integrity verified', out.verified === true);
    check('plain: bytes match exactly', out.blob && equalBytes(await bytesOf(out.blob), original));
    check('plain: filename preserved', out.name === 'plain.bin');
    check('plain: progress reported', out.progressEvents > 0 && out.maxPercent === 1);
  }

  // 2. Encrypted transfer (zero-knowledge AES-GCM)
  {
    const key = await generateKey();
    const file = randomFile('secret.bin', 150 * 1024);
    const original = await bytesOf(file);
    const out = await runTransfer({ file, encrypt: true, key });
    check('encrypted: completes', out.ok === true);
    check('encrypted: integrity verified', out.verified === true);
    check('encrypted: decrypted bytes match', out.blob && equalBytes(await bytesOf(out.blob), original));
  }

  // 3. Tampered chunk is rejected (encrypted -> GCM auth catches it)
  {
    const key = await generateKey();
    const file = randomFile('tampered.bin', 150 * 1024);
    let flipped = false;
    const tamper = (frame) => {
      if (flipped) return frame;
      flipped = true;
      const bytes = new Uint8Array(frame.slice(0)); // copy, then corrupt one byte
      bytes[bytes.length - 1] ^= 0xff;
      return bytes.buffer;
    };
    const out = await runTransfer({ file, encrypt: true, key, tamper });
    check('tampered (encrypted): rejected', out.ok === false);
  }

  // 4. Tampered chunk is rejected (plain -> whole-file SHA-256 catches it)
  {
    const file = randomFile('tampered2.bin', 200 * 1024);
    let flipped = false;
    const tamper = (frame) => {
      if (flipped) return frame;
      flipped = true;
      const bytes = new Uint8Array(frame.slice(0));
      bytes[10] ^= 0x01; // flip a payload bit (byte 0-3 are the index header)
      return bytes.buffer;
    };
    const out = await runTransfer({ file, encrypt: false, key: null, tamper });
    check('tampered (plain): integrity mismatch caught', out.ok === false);
  }

  // 5. Empty file edge case
  {
    const file = new File([new Uint8Array(0)], 'empty.bin', { type: 'application/octet-stream' });
    const out = await runTransfer({ file, encrypt: false, key: null });
    check('empty file: completes and verifies', out.ok === true && out.verified === true);
    check('empty file: zero bytes', out.blob && out.blob.size === 0);
  }

  // 6. Single small file fitting in one chunk
  {
    const file = randomFile('tiny.bin', 1024);
    const original = await bytesOf(file);
    const out = await runTransfer({ file, encrypt: false, key: null });
    check('single-chunk: bytes match', out.ok && equalBytes(await bytesOf(out.blob), original));
  }

  await wait(50);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
