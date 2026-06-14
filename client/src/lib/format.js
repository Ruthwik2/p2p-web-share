/**
 * Human-readable formatting helpers. Pure functions, no side effects — easy to
 * reason about and reuse anywhere in the UI.
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** Bytes -> "1.4 MB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}

/** Bytes-per-second -> "3.2 MB/s". */
export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Milliseconds remaining -> "about 12s" / "1m 30s". */
export function formatEta(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 1) return 'almost done';
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

/** 0..1 -> "42%". */
export function formatPercent(fraction) {
  if (!Number.isFinite(fraction)) return '0%';
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

/** Shorten a long hex digest for display: "a1b2…9f0e". */
export function shortHash(hex, head = 6, tail = 6) {
  if (!hex || hex.length <= head + tail) return hex ?? '';
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}
