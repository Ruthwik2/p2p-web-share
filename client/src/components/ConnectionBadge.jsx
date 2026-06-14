// A compact status pill. The dot's color is the connection's whole story:
// teal when live, amber mid-transfer, coral on a drop.
const MAP = {
  idle: { label: 'Idle', color: 'var(--muted)', pulse: false },
  connecting: { label: 'Connecting', color: 'var(--signal)', pulse: true },
  connected: { label: 'Connected', color: 'var(--signal)', pulse: false },
  transferring: { label: 'Transferring', color: 'var(--transfer)', pulse: true },
  verifying: { label: 'Verifying', color: 'var(--signal)', pulse: true },
  reconnecting: { label: 'Reconnecting', color: 'var(--transfer)', pulse: true },
  disconnected: { label: 'Disconnected', color: 'var(--alert)', pulse: false },
  failed: { label: 'Connection failed', color: 'var(--alert)', pulse: false },
};

export default function ConnectionBadge({ state = 'idle' }) {
  const s = MAP[state] ?? MAP.idle;
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1">
      <span className="relative flex h-2 w-2">
        {s.pulse && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            style={{ backgroundColor: s.color }}
          />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
      </span>
      <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: s.color }}>
        {s.label}
      </span>
    </span>
  );
}
