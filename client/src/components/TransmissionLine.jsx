import { useMemo } from 'react';

/**
 * The signature element: two nodes joined by a live link.
 *
 * The line is not decoration — it carries state. It illuminates teal when the
 * peer connection is up, fills amber from source to destination as bytes move
 * (so the link itself is the progress bar), and breaks into coral on a fault.
 *
 * Geometry is symmetric: the right-hand node is always the one "filling up",
 * so the same component serves both sides — sender (YOU -> PEER) and receiver
 * (SENDER -> YOU) — with the fill growing left to right in both.
 *
 * props:
 *   leftLabel, rightLabel : node captions
 *   state    : 'idle' | 'connecting' | 'connected' | 'transferring' | 'verifying' | 'done' | 'error'
 *   percent  : 0..1 fill amount (used while transferring/verifying)
 *   encrypted: show the lock badge on the link
 */
const X1 = 84;
const X2 = 336;
const Y = 58;
const SPAN = X2 - X1;

const COLORS = {
  idle: 'var(--line)',
  connecting: 'var(--signal)',
  connected: 'var(--signal)',
  transferring: 'var(--transfer)',
  verifying: 'var(--signal)',
  done: 'var(--signal)',
  error: 'var(--alert)',
};

export default function TransmissionLine({
  leftLabel = 'YOU',
  rightLabel = 'PEER',
  state = 'idle',
  percent = 0,
  encrypted = false,
}) {
  const color = COLORS[state] ?? COLORS.idle;
  const isError = state === 'error';
  const isActive = state === 'transferring' || state === 'verifying';
  const isLive = state === 'connected' || state === 'done' || isActive;
  const rightLit = state !== 'idle';
  const leftLit = true;

  const fillX = useMemo(() => {
    if (state === 'done' || state === 'connected') return X2;
    if (isActive) return X1 + SPAN * Math.min(1, Math.max(0, percent));
    return X1;
  }, [state, percent, isActive]);

  return (
    <svg
      viewBox="0 0 420 112"
      className="w-full max-w-[420px]"
      role="img"
      aria-label={`Link from ${leftLabel} to ${rightLabel}: ${state}`}
    >
      {/* base track */}
      {isError ? (
        <>
          <line x1={X1} y1={Y} x2={196} y2={Y} stroke="var(--alert)" strokeWidth="2" strokeLinecap="round" />
          <line x1={224} y1={Y} x2={X2} y2={Y} stroke="var(--alert)" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
          {/* break marker */}
          <path d="M204 50 L216 66 M216 50 L204 66" stroke="var(--alert)" strokeWidth="2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <line x1={X1} y1={Y} x2={X2} y2={Y} stroke="var(--line)" strokeWidth="2" strokeLinecap="round" />
          {/* filled / live portion */}
          <line
            x1={X1}
            y1={Y}
            x2={fillX}
            y2={Y}
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            style={{ transition: 'all 120ms linear' }}
          />
          {/* flowing current over the live portion */}
          {isActive && (
            <line
              x1={X1}
              y1={Y}
              x2={fillX}
              y2={Y}
              stroke={color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="2 10"
              className="animate-flow-dash"
              opacity="0.9"
            />
          )}
        </>
      )}

      {/* encrypted badge sits on the link */}
      {encrypted && !isError && (
        <g transform={`translate(210 ${Y})`}>
          <circle r="13" fill="var(--bg)" stroke="var(--encrypted)" strokeWidth="1.5" />
          <rect x="-4.5" y="-1.5" width="9" height="7" rx="1.5" fill="var(--encrypted)" />
          <path d="M-2.5 -1.5 V-4 a2.5 2.5 0 0 1 5 0 V-1.5" fill="none" stroke="var(--encrypted)" strokeWidth="1.4" />
        </g>
      )}

      {/* nodes */}
      <Node cx={X1} lit={leftLit} color={isError ? 'var(--alert)' : 'var(--signal)'} pulse={false} />
      <Node
        cx={X2}
        lit={rightLit}
        color={isError ? 'var(--alert)' : color}
        pulse={state === 'connecting'}
      />

      {/* directional chevron at destination while live */}
      {isLive && !isError && (
        <path
          d={`M${X2 - 26} 52 L${X2 - 20} ${Y} L${X2 - 26} 64`}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.8"
        />
      )}

      {/* labels */}
      <text x={X1} y="96" textAnchor="middle" className="fill-muted" style={labelStyle}>
        {leftLabel}
      </text>
      <text x={X2} y="96" textAnchor="middle" className="fill-muted" style={labelStyle}>
        {rightLabel}
      </text>
    </svg>
  );
}

function Node({ cx, lit, color, pulse }) {
  return (
    <g>
      {lit && <circle cx={cx} cy={Y} r="16" fill={color} opacity="0.14" />}
      <circle
        cx={cx}
        cy={Y}
        r="8"
        fill={lit ? color : 'var(--surface-2)'}
        stroke={lit ? color : 'var(--line)'}
        strokeWidth="1.5"
        className={pulse ? 'animate-pulse-node' : undefined}
        style={{ transformOrigin: `${cx}px ${Y}px` }}
      />
      <circle cx={cx} cy={Y} r="3" fill="var(--bg)" opacity={lit ? 0.85 : 0.4} />
    </g>
  );
}

const labelStyle = {
  fontFamily: '"IBM Plex Mono", monospace',
  fontSize: '11px',
  letterSpacing: '0.16em',
};
