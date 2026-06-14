import { useCallback, useRef, useState } from 'react';
import { MAX_FILE_BYTES } from '../config.js';
import { formatBytes } from '../lib/format.js';

// The entry point: drop a file or pick one. Enforces the 50 MB ceiling here so
// the rejection is immediate and explained, rather than failing mid-transfer.
export default function DropZone({ onFile }) {
  const [dragging, setDragging] = useState(false);
  const [reason, setReason] = useState(null);
  const inputRef = useRef(null);

  const accept = useCallback(
    (file) => {
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        setReason(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`);
        return;
      }
      if (file.size === 0) {
        setReason('That file is empty.');
        return;
      }
      setReason(null);
      onFile(file);
    },
    [onFile],
  );

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragging(false);
      accept(e.dataTransfer.files?.[0]);
    },
    [accept],
  );

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={[
          'group relative flex w-full flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors',
          dragging
            ? 'border-signal bg-surface-2'
            : 'border-line bg-surface hover:border-muted/60 hover:bg-surface-2',
        ].join(' ')}
      >
        {/* glyph: a file crossing into a node */}
        <svg viewBox="0 0 64 48" className="h-12 w-16" aria-hidden="true">
          <rect
            x="6"
            y="10"
            width="22"
            height="28"
            rx="3"
            fill="none"
            stroke={dragging ? 'var(--signal)' : 'var(--muted)'}
            strokeWidth="2"
          />
          <line x1="11" y1="18" x2="23" y2="18" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" />
          <line x1="11" y1="24" x2="23" y2="24" stroke="var(--muted)" strokeWidth="2" strokeLinecap="round" />
          <line
            x1="30"
            y1="24"
            x2="50"
            y2="24"
            stroke={dragging ? 'var(--signal)' : 'var(--line)'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="2 4"
          />
          <circle cx="56" cy="24" r="5" fill={dragging ? 'var(--signal)' : 'var(--surface-2)'} stroke={dragging ? 'var(--signal)' : 'var(--line)'} strokeWidth="2" />
        </svg>

        <div className="flex flex-col gap-1">
          <span className="font-display text-base font-medium text-ink">
            {dragging ? 'Release to load' : 'Drop a file to send'}
          </span>
          <span className="font-mono text-[11px] text-muted">
            or click to choose · up to {formatBytes(MAX_FILE_BYTES)}
          </span>
        </div>

        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          onChange={(e) => accept(e.target.files?.[0])}
        />
      </button>

      {reason && (
        <p className="font-mono text-xs" style={{ color: 'var(--alert)' }} role="alert">
          {reason}
        </p>
      )}
    </div>
  );
}
