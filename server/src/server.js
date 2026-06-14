import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as SocketServer } from 'socket.io';

import { RoomRegistry } from './rooms.js';
import { registerSignaling } from './signaling.js';

const PORT = Number(process.env.PORT) || 4000;

// Comma-separated allowlist, e.g. "http://localhost:5173,https://share.example.com".
// "*" allows any origin (handy for local dev; tighten for production).
const RAW_ORIGINS = process.env.CLIENT_ORIGIN || '*';
const ORIGINS = RAW_ORIGINS === '*' ? '*' : RAW_ORIGINS.split(',').map((s) => s.trim());

const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 1000 * 60 * 30;
const MAX_PEERS = Number(process.env.MAX_PEERS) || 2;

// How long a peer's room slot is held after an involuntary disconnect, so a
// reconnecting socket can reclaim it and the transfer can auto-resume.
const RESUME_GRACE_MS = Number(process.env.RESUME_GRACE_MS) || 15000;

const log = {
  info: (...a) => console.log(new Date().toISOString(), '·', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), '·', ...a),
};

/**
 * ICE server configuration handed to clients. Public STUN works for most NATs;
 * a TURN relay (configured via env) is the fallback for symmetric NATs where a
 * direct path can't be punched. TURN only relays the *encrypted* media/data —
 * it still never sees plaintext file contents.
 */
function iceServers() {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
  ];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: ORIGINS }));
app.use(express.json({ limit: '64kb' }));

const registry = new RoomRegistry({ ttlMs: ROOM_TTL_MS, maxPeers: MAX_PEERS });

app.get('/', (_req, res) => {
  res.json({
    service: 'p2p-web-share-signaling',
    role: 'Coordinates WebRTC handshakes. Never reads, processes, or stores file data.',
    health: '/health',
    iceConfig: '/ice-config',
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ...registry.stats() });
});

app.get('/ice-config', (_req, res) => {
  res.json({ iceServers: iceServers() });
});

const server = http.createServer(app);

const io = new SocketServer(server, {
  cors: { origin: ORIGINS, methods: ['GET', 'POST'] },
  // Signaling messages are tiny; cap the buffer so the socket channel can never
  // be abused to push large payloads. File bytes travel over WebRTC, not here.
  maxHttpBufferSize: 1024 * 256,
  pingTimeout: 20000,
});

registerSignaling(io, registry, log, { resumeGraceMs: RESUME_GRACE_MS });

server.listen(PORT, () => {
  log.info(`signaling server listening on :${PORT}`);
  log.info(`allowed origins: ${RAW_ORIGINS}`);
});

function shutdown(signal) {
  log.warn(`${signal} received, shutting down`);
  io.close();
  registry.dispose();
  server.close(() => process.exit(0));
  // Force-exit if connections linger.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server, io, registry };
