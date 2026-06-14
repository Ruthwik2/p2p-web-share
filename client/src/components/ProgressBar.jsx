import { formatPercent } from '../lib/format.js';

// A thin, precise progress track. Amber while moving, teal once verified.
export default function ProgressBar({ percent = 0, state = 'transferring' }) {
  const pct = Math.min(1, Math.max(0, percent));
  const color = state === 'done' || state === 'verifying' ? 'var(--signal)' : 'var(--transfer)';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Progress</span>
        <span className="tnum font-mono text-sm" style={{ color }}>
          {formatPercent(pct)}
        </span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct * 100}%`, backgroundColor: color, transition: 'width 120ms linear' }}
        />
        {/* a faint scanline travelling the filled region while active */}
        {state === 'transferring' && pct > 0 && pct < 1 && (
          <div
            className="absolute inset-y-0 w-16 animate-scan"
            style={{
              left: 0,
              background:
                'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
            }}
          />
        )}
      </div>
    </div>
  );
}
