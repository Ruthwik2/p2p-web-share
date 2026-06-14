// Resolves the signaling server's base URL.
//
// Priority:
//   1. VITE_SIGNALING_URL  — set this in production (your Render/Railway URL).
//   2. Same host on port 4000 — convenient when developing across two devices
//      on the same LAN (open http://192.168.x.x:5173 on your phone and the
//      signaling server is found automatically at http://192.168.x.x:4000).
//   3. http://localhost:4000 — the local fallback.
//
// Only the room id ever reaches this server. The decryption key lives in the
// URL fragment (after #), which browsers never transmit, so the server cannot
// see it.

function resolveSignalingUrl() {
  const fromEnv = import.meta.env.VITE_SIGNALING_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return `${protocol}//${hostname}:4000`;
    }
  }
  return 'http://localhost:4000';
}

export const SIGNALING_URL = resolveSignalingUrl();

// Per-file ceiling for the core MVP. Larger files are technically streamable
// but are held back here to stay within comfortable browser-memory limits.
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
