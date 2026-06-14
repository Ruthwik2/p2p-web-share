import { isValidRoomId } from './rooms.js';

// Socket.io disconnect reasons that mean the peer left on purpose (closed the
// tab, navigated away). Anything else — 'transport close', 'ping timeout',
// 'transport error' — is involuntary churn we try to recover from.
const GRACEFUL_REASONS = new Set(['client namespace disconnect', 'server namespace disconnect']);

/**
 * Wire a connected socket into the signaling protocol.
 *
 * Protocol (all payloads are tiny SDP/ICE control messages — never file bytes):
 *
 *   client -> server
 *     "room:create" { clientId }            -> ack { roomId }
 *     "room:join"   { roomId, clientId }     -> ack { ok, peers? , code?, message? }
 *     "room:rejoin" { roomId, clientId }     -> ack { ok, peers? , code?, message? }
 *     "signal"      { to, data }             -> forwarded as "signal" { from, data }
 *     "room:leave"  { roomId }
 *
 *   server -> client
 *     "peer:join"        { peerId }              // a guest arrived; host should offer
 *     "peer:disconnected"{ peerId }              // a peer's socket dropped; may recover
 *     "peer:reconnect"   { peerId, prevPeerId }  // a peer came back with a new socket id
 *     "peer:leave"       { peerId }              // gone for good (graceful, or grace expired)
 *     "signal"           { from, data }          // relayed SDP / ICE candidate
 *
 * Auto-resume on churn: an involuntary disconnect doesn't evict the peer
 * immediately. Its slot is held for `resumeGraceMs` so the returning socket (a
 * fresh id) can reclaim it via "room:rejoin", at which point survivors are told
 * the new id with "peer:reconnect". Only if the window lapses is "peer:leave"
 * broadcast.
 */
export function registerSignaling(io, registry, log = console, { resumeGraceMs = 15000 } = {}) {
  /** @type {Map<string, NodeJS.Timeout>} clientId -> pending eviction timer */
  const graceTimers = new Map();

  function clearGrace(clientId) {
    const timer = graceTimers.get(clientId);
    if (timer) {
      clearTimeout(timer);
      graceTimers.delete(clientId);
    }
  }

  io.on('connection', (socket) => {
    log.info?.(`socket connected: ${socket.id}`);

    socket.on('room:create', ({ clientId } = {}, ack) => {
      const roomId = registry.create(socket.id, clientId || socket.id);
      socket.join(roomId);
      log.info?.(`room created: ${roomId} by ${socket.id}`);
      respond(ack, { roomId });
    });

    socket.on('room:join', ({ roomId, clientId } = {}, ack) => {
      if (!isValidRoomId(roomId)) {
        return respond(ack, { ok: false, code: 'BAD_ROOM_ID', message: 'That share link is malformed.' });
      }
      const result = registry.join(roomId, socket.id, clientId || socket.id);
      if (!result.ok) {
        log.info?.(`join rejected (${result.code}): ${roomId} <- ${socket.id}`);
        return respond(ack, result);
      }

      socket.join(roomId);
      // Tell everyone already in the room that a new peer arrived. The host
      // reacts by creating the WebRTC offer toward this socket.
      socket.to(roomId).emit('peer:join', { peerId: socket.id });
      log.info?.(`peer joined: ${roomId} <- ${socket.id}`);
      respond(ack, { ok: true, peers: result.peers });
    });

    socket.on('room:rejoin', ({ roomId, clientId } = {}, ack) => {
      if (!isValidRoomId(roomId)) {
        return respond(ack, { ok: false, code: 'BAD_ROOM_ID', message: 'That share link is malformed.' });
      }
      if (!clientId) {
        return respond(ack, { ok: false, code: 'NOT_A_MEMBER', message: 'Missing client id.' });
      }
      const result = registry.rejoin(roomId, clientId, socket.id);
      if (!result.ok) {
        log.info?.(`rejoin rejected (${result.code}): ${roomId} <- ${socket.id}`);
        return respond(ack, result);
      }

      clearGrace(clientId);
      socket.join(roomId);
      // Survivors were addressing the old socket id — point them at the new one
      // so an ICE-restart handshake can complete over the relay.
      for (const peerId of result.peers) {
        io.to(peerId).emit('peer:reconnect', { peerId: socket.id, prevPeerId: result.oldSocketId });
      }
      log.info?.(`peer rejoined: ${roomId} <- ${socket.id} (was ${result.oldSocketId})`);
      respond(ack, { ok: true, peers: result.peers });
    });

    socket.on('signal', ({ to, data } = {}) => {
      // Only relay within a room this socket actually belongs to, and only to a
      // peer that shares that room. This blocks cross-room / spoofed signaling.
      const room = registry.roomOf(socket.id);
      if (!room || !to || !room.peers.has(to)) return;
      registry.touch(room.id);
      io.to(to).emit('signal', { from: socket.id, data });
    });

    socket.on('room:leave', ({ roomId } = {}) => {
      if (roomId) socket.leave(roomId);
      departImmediately(socket.id);
    });

    socket.on('disconnect', (reason) => {
      log.info?.(`socket disconnected: ${socket.id} (${reason})`);
      if (GRACEFUL_REASONS.has(reason)) {
        departImmediately(socket.id);
      } else {
        departWithGrace(socket.id);
      }
    });

    /** A peer left for good: evict now and notify the others. */
    function departImmediately(socketId) {
      const result = registry.removePeer(socketId);
      if (!result) return;
      for (const peerId of result.remaining) {
        io.to(peerId).emit('peer:leave', { peerId: socketId });
      }
    }

    /**
     * A peer's socket dropped involuntarily. Hold its slot for the grace window
     * so it can reconnect and reclaim it; only evict if the window lapses.
     */
    function departWithGrace(socketId) {
      const dropped = registry.disconnectSocket(socketId);
      if (!dropped) return;
      const { clientId, remaining } = dropped;

      // Without a clientId we can't recognise a returning socket (shouldn't
      // happen — create/join always register one) — finalise immediately.
      if (!clientId) {
        for (const peerId of remaining) {
          io.to(peerId).emit('peer:leave', { peerId: socketId });
        }
        return;
      }

      // Let the survivors show a "reconnecting" state instead of a hard leave.
      for (const peerId of remaining) {
        io.to(peerId).emit('peer:disconnected', { peerId: socketId });
      }

      clearGrace(clientId);
      const timer = setTimeout(() => {
        graceTimers.delete(clientId);
        const result = registry.removeMember(clientId);
        if (!result) return;
        for (const peerId of result.remaining) {
          io.to(peerId).emit('peer:leave', { peerId: socketId });
        }
        log.info?.(`grace expired: ${clientId} evicted from ${result.roomId}`);
      }, resumeGraceMs);
      if (typeof timer.unref === 'function') timer.unref();
      graceTimers.set(clientId, timer);
    }
  });
}

function respond(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}
