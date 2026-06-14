import { formatBytes, shortHash } from '../lib/format.js';

// Summarizes the file under transfer: name, size, and — once known — the
// verified SHA-256 fingerprint. The lock marks the zero-knowledge path.
export default function FileCard({ name, size, mime, hash, encrypted, verified }) {
  const ext = name?.includes('.') ? name.split('.').pop().toUpperCase().slice(0, 4) : 'FILE';
  return (
    <div className="flex items-center gap-4 rounded-xl border border-line bg-surface-2 p-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-line bg-surface">
        <span className="font-mono text-[10px] tracking-[0.08em] text-muted">{ext}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-display text-sm font-medium text-ink" title={name}>
            {name || 'file'}
          </p>
          {encrypted && (
            <span
              className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em]"
              style={{ color: 'var(--encrypted)' }}
              title="Encrypted end-to-end"
            >
              ◆ enc
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted">
          <span className="tnum">{formatBytes(size || 0)}</span>
          {mime && <span className="truncate">{mime}</span>}
          {hash && (
            <span style={{ color: verified ? 'var(--signal)' : 'var(--muted)' }}>
              sha256 {shortHash(hash)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
