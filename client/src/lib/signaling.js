import { io } from 'socket.io-client';
import { Emitter } from './emitter.js';

/** Stable per-session id so a socket that reconnects can reclaim its room slot. */
function makeClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Thin, promise-friendly wrapper over the socket.io signaling channel.
 *
 * Emits: 'connect', 'disconnect', 'peer:join' {peerId}, 'peer:leave' {peerId},
 *        'peer:disconnected' {peerId}, 'peer:reconnect' {peerId, prevPeerId},
 *        'signal' {from, data}.
 *
 * Note that socket.io reconnects on its own after a network blip (a *new* socket
 * id each time), so 'connect' can fire more than once on the same instance. The
 * stable `clientId` lets the relay recognise the returning peer across those id
 * changes; callers should re-establish room membership with rejoinRoom() on any
 * 'connect' after the first.
 *
 * This object knows nothing about WebRTC or files — it just moves small control
 * messages between this browser and the relay.
 */
export class SignalingClient extends Emitter {
  constructor(url) {
    super();
    this.url = url;
    this.socket = null;
    this.clientId = makeClientId();
  }

  connect() {
    if (this.socket) return;
    this.socket = io(this.url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 8,
    });

    this.socket.on('connect', () => this.emit('connect'));
    this.socket.on('disconnect', (reason) => this.emit('disconnect', reason));
    this.socket.on('connect_error', (err) => this.emit('error', err));
    this.socket.on('peer:join', (m) => this.emit('peer:join', m));
    this.socket.on('peer:leave', (m) => this.emit('peer:leave', m));
    this.socket.on('peer:disconnected', (m) => this.emit('peer:disconnected', m));
    this.socket.on('peer:reconnect', (m) => this.emit('peer:reconnect', m));
    this.socket.on('signal', (m) => this.emit('signal', m));
  }

  get id() {
    return this.socket?.id ?? null;
  }

  /** Ask the relay to mint a new room; resolves with its id. */
  createRoom() {
    return new Promise((resolve, reject) => {
      this.socket.emit('room:create', { clientId: this.clientId }, (res) => {
        if (res?.roomId) resolve(res.roomId);
        else reject(new Error('Could not create a room.'));
      });
    });
  }

  /** Join an existing room; resolves with {ok, peers} or rejects with a coded error. */
  joinRoom(roomId) {
    return new Promise((resolve, reject) => {
      this.socket.emit('room:join', { roomId, clientId: this.clientId }, (res) => {
        if (res?.ok) resolve(res);
        else {
          const err = new Error(res?.message || 'Could not join the room.');
          err.code = res?.code || 'JOIN_FAILED';
          reject(err);
        }
      });
    });
  }

  /**
   * Reclaim a room slot after a reconnect (our socket id changed but the relay
   * still holds our slot during its grace window). Resolves with {ok, peers}
   * where `peers` are the surviving roommates' *current* socket ids.
   */
  rejoinRoom(roomId) {
    return new Promise((resolve, reject) => {
      this.socket.emit('room:rejoin', { roomId, clientId: this.clientId }, (res) => {
        if (res?.ok) resolve(res);
        else {
          const err = new Error(res?.message || 'Could not rejoin the room.');
          err.code = res?.code || 'REJOIN_FAILED';
          reject(err);
        }
      });
    });
  }

  /** Relay an SDP/ICE payload to a specific peer. */
  signal(to, data) {
    this.socket?.emit('signal', { to, data });
  }

  leaveRoom(roomId) {
    this.socket?.emit('room:leave', { roomId });
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
    this.removeAllListeners();
  }
}
