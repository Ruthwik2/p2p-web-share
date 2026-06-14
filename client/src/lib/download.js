/**
 * Trigger a local download of an in-memory Blob. Used by the receiver to save
 * the reassembled file automatically once every chunk has arrived and the
 * integrity check has passed.
 */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the navigation/download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
