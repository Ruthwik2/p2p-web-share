import { Link } from 'react-router-dom';

// Consistent chrome around every view. The wordmark carries a two-node glyph —
// the same motif as the transmission line — so the brand and the mechanism are
// the same idea.
export default function Shell({ children }) {
  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-xl flex-col px-5 py-6 sm:py-10">
      <header className="flex items-center justify-between">
        <Link to="/" className="group flex items-center gap-2.5">
          <svg viewBox="0 0 40 16" className="h-4 w-10" aria-hidden="true">
            <line x1="6" y1="8" x2="34" y2="8" stroke="var(--line)" strokeWidth="2" strokeLinecap="round" />
            <circle cx="6" cy="8" r="4" fill="var(--signal)" />
            <circle cx="34" cy="8" r="4" fill="var(--surface-2)" stroke="var(--signal)" strokeWidth="1.5" />
          </svg>
          <span className="font-display text-lg font-semibold tracking-tight text-ink">Relay</span>
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          P2P · encrypted
        </span>
      </header>

      <main className="flex flex-1 flex-col justify-center py-8">{children}</main>

      <footer className="border-t border-line pt-4">
        <p className="font-mono text-[10px] leading-relaxed text-muted">
          No accounts, no uploads. The signaling server only introduces the two browsers — it never
          sees the file or the key.
        </p>
      </footer>
    </div>
  );
}
