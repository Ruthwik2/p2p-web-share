import { useEffect, useRef } from 'react';
import { useReceiver } from '../hooks/useReceiver.js';
import { useToasts, ToastStack } from './Toast.jsx';
import TransmissionLine from './TransmissionLine.jsx';
import ConnectionBadge from './ConnectionBadge.jsx';
import ProgressBar from './ProgressBar.jsx';
import StatRow from './StatRow.jsx';
import FileCard from './FileCard.jsx';
import { formatBytes, formatSpeed, formatEta } from '../lib/format.js';

const LINE_STATE = {
  joining: 'idle',
  connecting: 'connecting',
  receiving: 'transferring',
  verifying: 'verifying',
  done: 'done',
  'peer-left': 'error',
  error: 'error',
};

function badgeState(s) {
  if (s.status === 'receiving') return 'transferring';
  if (s.status === 'verifying') return 'verifying';
  if (s.status === 'done') return 'connected';
  if (s.status === 'joining') return 'connecting';
  return s.connection;
}

export default function ReceivePanel({ roomId, keyStr }) {
  const s = useReceiver(roomId, keyStr);
  const { toasts, push, dismiss } = useToasts();
  const prev = useRef(s.status);

  useEffect(() => {
    if (prev.current !== s.status) {
      if (s.status === 'done') push('File received, verified, and downloaded.', 'info');
      if (s.status === 'peer-left') push('The sender disconnected.', 'warn');
      if (s.status === 'receiving') push('Connected. Receiving file…', 'info', 2500);
      prev.current = s.status;
    }
  }, [s.status, push]);

  const meta = s.meta;
  const active = s.status === 'receiving' || s.status === 'verifying';
  const connecting = s.status === 'joining' || s.status === 'connecting';
  const finished = s.status === 'done';
  const faulted = s.status === 'error' || s.status === 'peer-left';
  const encrypted = meta?.encrypted ?? true;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <ConnectionBadge state={badgeState(s)} />
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
          Receiving
        </span>
      </div>

      {meta && (
        <FileCard
          name={meta.name}
          size={meta.size}
          mime={meta.mime}
          hash={s.hash}
          encrypted={encrypted}
          verified={finished}
        />
      )}

      <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-8">
        <TransmissionLine
          leftLabel="SENDER"
          rightLabel="YOU"
          state={LINE_STATE[s.status] ?? 'idle'}
          percent={s.progress.percent}
          encrypted={encrypted}
        />
        <StatusLine status={s.status} error={s.error} />
      </div>

      {connecting && !faulted && (
        <p className="text-center font-mono text-xs text-muted">
          {s.status === 'joining' ? 'Joining the room…' : 'Connecting to the sender…'}
        </p>
      )}

      {active && (
        <div className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5">
          <ProgressBar percent={s.progress.percent} state={s.status} />
          <div className="grid grid-cols-3 gap-4">
            <StatRow label="Speed" value={formatSpeed(s.progress.speed)} accent="var(--transfer)" />
            <StatRow label="Received" value={formatBytes(s.progress.bytesReceived)} />
            <StatRow label="ETA" value={formatEta(s.progress.etaMs)} />
          </div>
        </div>
      )}

      {finished && (
        <div className="rounded-2xl border p-5" style={{ borderColor: 'var(--signal)', backgroundColor: 'rgba(94,230,196,0.06)' }}>
          <p className="font-display text-sm font-medium" style={{ color: 'var(--signal)' }}>
            Received and verified
          </p>
          <p className="mt-1 font-mono text-[11px] text-muted">
            The download has started. The file matched its SHA-256 hash exactly.
          </p>
        </div>
      )}

      {faulted && (
        <div className="rounded-2xl border p-5" style={{ borderColor: 'var(--alert)', backgroundColor: 'rgba(255,107,107,0.06)' }}>
          <p className="font-display text-sm font-medium" style={{ color: 'var(--alert)' }}>
            Couldn’t complete the transfer
          </p>
          {s.error && <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted">{s.error}</p>}
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function StatusLine({ status, error }) {
  const TEXT = {
    joining: 'Joining the room',
    connecting: 'Negotiating a direct connection',
    receiving: 'Receiving directly from the sender',
    verifying: 'Verifying integrity',
    done: 'Received and verified',
    'peer-left': 'The sender disconnected',
    error: error || 'Something went wrong',
  };
  const color =
    status === 'done'
      ? 'var(--signal)'
      : status === 'receiving' || status === 'verifying'
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
