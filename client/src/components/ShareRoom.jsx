import { useEffect, useRef } from 'react';
import { useSender } from '../hooks/useSender.js';
import { useToasts, ToastStack } from './Toast.jsx';
import TransmissionLine from './TransmissionLine.jsx';
import ConnectionBadge from './ConnectionBadge.jsx';
import ProgressBar from './ProgressBar.jsx';
import StatRow from './StatRow.jsx';
import FileCard from './FileCard.jsx';
import ShareCard from './ShareCard.jsx';
import { formatBytes, formatSpeed, formatEta } from '../lib/format.js';

// Maps the transfer status onto the signature line's visual state.
const LINE_STATE = {
  creating: 'idle',
  waiting: 'idle',
  connecting: 'connecting',
  transferring: 'transferring',
  verifying: 'verifying',
  done: 'done',
  'peer-left': 'error',
  cancelled: 'idle',
  error: 'error',
};

function badgeState(s) {
  if (s.status === 'transferring') return 'transferring';
  if (s.status === 'verifying') return 'verifying';
  if (s.status === 'done') return 'connected';
  return s.connection;
}

export default function ShareRoom({ file, onReset }) {
  const s = useSender(file);
  const { toasts, push, dismiss } = useToasts();
  const prev = useRef(s.status);

  // Surface lifecycle moments as toasts, in the interface's own voice.
  useEffect(() => {
    if (prev.current !== s.status) {
      if (s.status === 'peer-left') push('The other side disconnected.', 'warn');
      if (s.status === 'done') push('Sent and verified.', 'info');
      if (s.status === 'connecting') push('Recipient joined. Opening a direct link…', 'info', 2500);
      prev.current = s.status;
    }
  }, [s.status, push]);

  const active = s.status === 'transferring' || s.status === 'verifying';
  const waiting = s.status === 'creating' || s.status === 'waiting';
  const finished = s.status === 'done';
  const faulted = s.status === 'error' || s.status === 'peer-left' || s.status === 'cancelled';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <ConnectionBadge state={badgeState(s)} />
        <button
          onClick={onReset}
          className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
        >
          ← New transfer
        </button>
      </div>

      <FileCard
        name={file.name}
        size={file.size}
        mime={file.type}
        hash={s.hash}
        encrypted={s.encrypted}
        verified={finished}
      />

      {/* signature: the live link */}
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-8">
        <TransmissionLine
          leftLabel="YOU"
          rightLabel="PEER"
          state={LINE_STATE[s.status] ?? 'idle'}
          percent={s.progress.percent}
          encrypted={s.encrypted}
        />
        <StatusLine status={s.status} error={s.error} />
      </div>

      {waiting && s.link && (
        <ShareCard link={s.link} onCopy={() => push('Link copied.', 'info', 1800)} />
      )}

      {waiting && !s.link && (
        <p className="text-center font-mono text-xs text-muted">Setting up a secure room…</p>
      )}

      {active && (
        <div className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5">
          <ProgressBar percent={s.progress.percent} state={s.status} />
          <div className="grid grid-cols-3 gap-4">
            <StatRow label="Speed" value={formatSpeed(s.progress.speed)} accent="var(--transfer)" />
            <StatRow label="Sent" value={formatBytes(s.progress.bytesSent)} />
            <StatRow label="ETA" value={formatEta(s.progress.etaMs)} />
          </div>
        </div>
      )}

      {finished && (
        <div className="rounded-2xl border p-5" style={{ borderColor: 'var(--signal)', backgroundColor: 'rgba(94,230,196,0.06)' }}>
          <p className="font-display text-sm font-medium" style={{ color: 'var(--signal)' }}>
            Transfer complete
          </p>
          <p className="mt-1 font-mono text-[11px] text-muted">
            {formatBytes(file.size)} delivered and verified against its SHA-256 hash.
          </p>
        </div>
      )}

      {faulted && (
        <div className="flex flex-col gap-3 rounded-2xl border p-5" style={{ borderColor: 'var(--alert)', backgroundColor: 'rgba(255,107,107,0.06)' }}>
          <p className="font-display text-sm font-medium" style={{ color: 'var(--alert)' }}>
            {s.status === 'cancelled' ? 'Transfer cancelled' : 'Transfer interrupted'}
          </p>
          {s.error && <p className="font-mono text-[11px] leading-relaxed text-muted">{s.error}</p>}
          <button
            onClick={onReset}
            className="self-start rounded-lg border border-line px-4 py-2 font-display text-sm text-ink transition-colors hover:bg-surface-2"
          >
            Start over
          </button>
        </div>
      )}

      {active && (
        <button
          onClick={s.cancel}
          className="self-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink"
          style={{ color: 'var(--alert)' }}
        >
          Cancel transfer
        </button>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function StatusLine({ status, error }) {
  const TEXT = {
    creating: 'Preparing room',
    waiting: 'Waiting for the recipient to open the link',
    connecting: 'Negotiating a direct connection',
    transferring: 'Streaming directly to the recipient',
    verifying: 'Verifying integrity',
    done: 'Delivered and verified',
    'peer-left': 'The recipient disconnected',
    cancelled: 'Cancelled',
    error: error || 'Something went wrong',
  };
  const color =
    status === 'done'
      ? 'var(--signal)'
      : status === 'transferring' || status === 'verifying'
        ? 'var(--transfer)'
        : status === 'error' || status === 'peer-left'
          ? 'var(--alert)'
          : 'var(--muted)';
  return (
    <p className="font-mono text-[11px] tracking-[0.04em]" style={{ color }}>
      {TEXT[status] ?? ''}
    </p>
  );
}
