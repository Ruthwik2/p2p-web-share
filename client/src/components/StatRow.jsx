// One readout in the instrument panel: a quiet label over a mono value.
export default function StatRow({ label, value, accent }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">{label}</span>
      <span
        className="tnum font-mono text-lg leading-none"
        style={{ color: accent || 'var(--ink)' }}
      >
        {value}
      </span>
    </div>
  );
}
