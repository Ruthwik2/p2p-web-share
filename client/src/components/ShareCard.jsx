import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

// Hands the recipient the link, two ways: copy/paste, or scan to open on a
// phone (the laptop-to-phone path that makes a good demo). The key rides in the
// link's fragment, so whoever holds the link can decrypt — treat it like a key.
export default function ShareCard({ link, onCopy }) {
  const [qr, setQr] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!link) return;
    QRCode.toDataURL(link, {
      margin: 1,
      width: 320,
      color: { dark: '#E8EEF2', light: '#0E141B' },
      errorCorrectionLevel: 'M',
    })
      .then(setQr)
      .catch(() => setQr(null));
  }, [link]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard API can be blocked; fall back to a transient selection.
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    onCopy?.();
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Share link</span>
        <div className="flex items-stretch gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2.5 font-mono text-xs text-ink">
            {link}
          </code>
          <button
            onClick={copy}
            className="shrink-0 rounded-lg border px-4 py-2.5 font-display text-sm font-medium transition-colors"
            style={
              copied
                ? { borderColor: 'var(--signal)', color: 'var(--signal)', backgroundColor: 'rgba(94,230,196,0.08)' }
                : { borderColor: 'var(--line)', color: 'var(--ink)' }
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {qr && (
        <div className="flex items-center gap-4 rounded-xl border border-line bg-surface-2 p-4">
          <img src={qr} alt="QR code for the share link" className="h-28 w-28 rounded-md" />
          <div className="flex flex-col gap-1">
            <p className="font-display text-sm font-medium text-ink">Scan to receive</p>
            <p className="font-mono text-[11px] leading-relaxed text-muted">
              Open the camera on another device to start the transfer there.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
