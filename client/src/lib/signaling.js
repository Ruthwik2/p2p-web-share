import { io } from 'socket.io-client';
import { Emitter } from './emitter.js';

/**
 * Thin, promise-friendly wrapper over the socket.io signaling channel.
 *
 * Emits: 'connect', 'disconnect', 'peer:join' {peerId}, 'peer:leave' {peerId},
 *        'signal' {from, data}.
 *
 * This object knows nothing about WebRTC or files — it just moves small control
 * messages between this browser and the relay.
 */
export class SignalingClient extends Emitter {
  constructor(url) {
    super();
    this.url = url;
    this.socket = null;
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
    this.socket.on('signal', (m) => this.emit('signal', m));
  }

  get id() {
    return this.socket?.id ?? null;
  }

  /** Ask the relay to mint a new room; resolves with its id. */
  createRoom() {
    return new Promise((resolve, reject) => {
      this.socket.emit('room:create', {}, (res) => {
        if (res?.roomId) resolve(res.roomId);
        else reject(new Error('Could not create a room.'));
      });
    });
  }

  /** Join an existing room; resolves with {ok, peers} or rejects with a coded error. */
  joinRoom(roomId) {
    return new Promise((resolve, reject) => {
      this.socket.emit('room:join', { roomId }, (res) => {
        if (res?.ok) resolve(res);
        else {
          const err = new Error(res?.message || 'Could not join the room.');
          err.code = res?.code || 'JOIN_FAILED';
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
