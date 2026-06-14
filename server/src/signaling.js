import { isValidRoomId } from './rooms.js';

/**
 * Wire a connected socket into the signaling protocol.
 *
 * Protocol (all payloads are tiny SDP/ICE control messages — never file bytes):
 *
 *   client -> server
 *     "room:create"                         -> ack { roomId }
 *     "room:join"   { roomId }              -> ack { ok, peers? , code?, message? }
 *     "signal"      { to, data }            -> forwarded as "signal" { from, data }
 *     "room:leave"  { roomId }
 *
 *   server -> client
 *     "peer:join"   { peerId }              // a guest arrived; host should offer
 *     "peer:leave"  { peerId }              // graceful or abrupt disconnect
 *     "signal"      { from, data }          // relayed SDP / ICE candidate
 *     "room:closed" { reason }              // the other side is gone for good
 */
export function registerSignaling(io, registry, log = console) {
  io.on('connection', (socket) => {
    log.info?.(`socket connected: ${socket.id}`);

    socket.on('room:create', (_payload, ack) => {
      const roomId = registry.create(socket.id);
      socket.join(roomId);
      log.info?.(`room created: ${roomId} by ${socket.id}`);
      respond(ack, { roomId });
    });

    socket.on('room:join', ({ roomId } = {}, ack) => {
      if (!isValidRoomId(roomId)) {
        return respond(ack, { ok: false, code: 'BAD_ROOM_ID', message: 'That share link is malformed.' });
      }
      const result = registry.join(roomId, socket.id);
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
      handleDeparture(socket.id);
    });

    socket.on('disconnect', (reason) => {
      log.info?.(`socket disconnected: ${socket.id} (${reason})`);
      handleDeparture(socket.id);
    });

    function handleDeparture(socketId) {
      const result = registry.removePeer(socketId);
      if (!result) return;
      // Notify the peers left behind so their UI can recover gracefully.
      for (const peerId of result.remaining) {
        io.to(peerId).emit('peer:leave', { peerId: socketId });
      }
    }
  });
}

function respond(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}
