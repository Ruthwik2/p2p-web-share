import { SIGNALING_URL } from '../config.js';

// Pulls the ICE server list (STUN/TURN) from the signaling server's
// /ice-config endpoint. STUN lets two peers discover a route to each other
// through NAT; TURN (if the server is configured with credentials) relays
// the bytes when a direct path can't be found.
//
// If the endpoint can't be reached, we fall back to public Google STUN so a
// direct connection on friendly networks still works.
const FALLBACK = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export async function fetchIceServers() {
  try {
    const res = await fetch(`${SIGNALING_URL}/ice-config`, { mode: 'cors' });
    if (!res.ok) throw new Error(`ice-config ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body?.iceServers) && body.iceServers.length) {
      return body.iceServers;
    }
  } catch {
    // fall through to the public STUN list
  }
  return FALLBACK;
}
