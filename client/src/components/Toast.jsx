import { useCallback, useRef, useState } from 'react';

// Minimal ephemeral notifications. Used sparingly: a dropped peer, a copied
// link. Errors in the interface's own voice — they say what happened, not sorry.
const ACCENT = {
  info: 'var(--signal)',
  warn: 'var(--transfer)',
  error: 'var(--alert)',
};

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message, kind = 'info', ttl = 4000) => {
      const id = (idRef.current += 1);
      setToasts((list) => [...list, { id, message, kind }]);
      if (ttl) setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}

export function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className="pointer-events-auto flex max-w-md animate-toast-in items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-left shadow-lg"
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: ACCENT[t.kind] }} />
          <span className="text-sm text-ink">{t.message}</span>
        </button>
      ))}
    </div>
  );
}
