import { useState } from 'react';
import Shell from '../components/Shell.jsx';
import DropZone from '../components/DropZone.jsx';
import ShareRoom from '../components/ShareRoom.jsx';
import { encryptionAvailable } from '../lib/crypto.js';
import { cryptoAvailable } from '../lib/hash.js';

// The real sequence of a transfer — these aren't marketing steps, they're the
// actual flow, which is why they're numbered.
const STEPS = [
  ['01', 'Drop', 'Your file is read in the browser and never uploaded.'],
  ['02', 'Share', 'A one-time link carries the room and the decryption key.'],
  ['03', 'Stream', 'The two browsers connect and the file moves directly, encrypted.'],
];

export default function Home() {
  const [file, setFile] = useState(null);
  const supported = encryptionAvailable() && cryptoAvailable();

  if (file) {
    return (
      <Shell>
        <ShareRoom file={file} onReset={() => setFile(null)} />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex flex-col gap-8 animate-fade-up">
        <div className="flex flex-col gap-3">
          <span className="font-mono text-eyebrow uppercase text-muted">
            Direct browser-to-browser transfer
          </span>
          <h1 className="text-balance font-display text-3xl font-semibold leading-[1.1] tracking-tight text-ink sm:text-4xl">
            Send a file straight to another browser.
          </h1>
          <p className="max-w-md text-balance text-sm leading-relaxed text-muted">
            No middleman storage. The file streams peer-to-peer over an encrypted WebRTC channel and
            is checked against its SHA-256 hash on arrival.
          </p>
        </div>

        {!supported && (
          <p className="rounded-lg border px-4 py-3 font-mono text-xs leading-relaxed" style={{ borderColor: 'var(--alert)', color: 'var(--alert)' }}>
            This browser doesn’t expose the Web Crypto API over an insecure origin. Open the app over
            https (or on localhost) to enable encrypted transfers.
          </p>
        )}

        <DropZone onFile={setFile} />

        <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
          {STEPS.map(([n, title, body]) => (
            <div key={n} className="flex flex-col gap-2 bg-surface p-4">
              <span className="font-mono text-[11px] tracking-[0.14em] text-muted">{n}</span>
              <span className="font-display text-sm font-medium text-ink">{title}</span>
              <span className="text-[12px] leading-relaxed text-muted">{body}</span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
