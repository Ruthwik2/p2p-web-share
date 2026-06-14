import { randomBytes } from 'node:crypto';

/**
 * URL-safe, human-friendly room IDs.
 * Excludes visually ambiguous characters (0/O, 1/I/l) so codes can be read
 * aloud or typed without confusion. ~5.16 bits/char -> a 10-char id has
 * ~51 bits of entropy, far more than enough for ephemeral rooms.
 */
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function makeId(length = 10) {
  const bytes = randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i += 1) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

const ROOM_ID_RE = new RegExp(`^[${ALPHABET}]{6,32}$`);

export function isValidRoomId(value) {
  return typeof value === 'string' && ROOM_ID_RE.test(value);
}

/**
 * RoomRegistry owns all signaling state. It never sees file payloads — only
 * which sockets belong to which room, so it can relay SDP/ICE between them and
 * clean up when peers leave.
 *
 * A room is intentionally generic: `maxPeers` defaults to 2 (1-to-1 transfer)
 * but can be raised to support mesh swarming without touching this class.
 */
export class RoomRegistry {
  constructor({ ttlMs = 1000 * 60 * 30, maxPeers = 2, sweepMs = 1000 * 60 } = {}) {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, string>} socketId -> roomId */
    this.socketIndex = new Map();
    this.ttlMs = ttlMs;
    this.maxPeers = maxPeers;
    this._sweeper = setInterval(() => this.sweep(), sweepMs);
    // Don't keep the process alive solely for the sweep timer.
    if (typeof this._sweeper.unref === 'function') this._sweeper.unref();
  }

  /** Create a room owned by `hostId`. Returns the new room id. */
  create(hostId) {
    let id = makeId();
    // Astronomically unlikely, but never hand out a duplicate id.
    while (this.rooms.has(id)) id = makeId();

    const now = Date.now();
    const room = {
      id,
      hostId,
      peers: new Set([hostId]),
      createdAt: now,
      lastActivity: now,
    };
    this.rooms.set(id, room);
    this.socketIndex.set(hostId, id);
    return id;
  }

  get(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  /**
   * Add a guest to an existing room.
   * @returns {{ ok: true, room: Room, peers: string[] }
   *          | { ok: false, code: string, message: string }}
   */
  join(roomId, guestId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, code: 'ROOM_NOT_FOUND', message: 'This share link has expired or never existed.' };
    }
    if (room.peers.has(guestId)) {
      return { ok: true, room, peers: this.peersExcept(room, guestId) };
    }
    if (room.peers.size >= this.maxPeers) {
      return { ok: false, code: 'ROOM_FULL', message: 'This room already has the maximum number of peers.' };
    }
    room.peers.add(guestId);
    room.lastActivity = Date.now();
    this.socketIndex.set(guestId, roomId);
    return { ok: true, room, peers: this.peersExcept(room, guestId) };
  }

  /** All peer ids in a room except `selfId`. */
  peersExcept(room, selfId) {
    return [...room.peers].filter((id) => id !== selfId);
  }

  /** Look up the room a socket currently belongs to. */
  roomOf(socketId) {
    const roomId = this.socketIndex.get(socketId);
    return roomId ? this.rooms.get(roomId) ?? null : null;
  }

  touch(roomId) {
    const room = this.rooms.get(roomId);
    if (room) room.lastActivity = Date.now();
  }

  /**
   * Remove a socket from whatever room it was in.
   * @returns {{ roomId: string, remaining: string[], deleted: boolean } | null}
   * `remaining` are the peers that should be told this socket left.
   */
  removePeer(socketId) {
    const roomId = this.socketIndex.get(socketId);
    this.socketIndex.delete(socketId);
    if (!roomId) return null;

    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.peers.delete(socketId);
    room.lastActivity = Date.now();

    const remaining = [...room.peers];
    let deleted = false;
    if (room.peers.size === 0) {
      this.rooms.delete(roomId);
      deleted = true;
    }
    return { roomId, remaining, deleted };
  }

  /** Drop rooms that have been idle past their TTL. */
  sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, room] of this.rooms) {
      if (room.lastActivity < cutoff) {
        for (const peerId of room.peers) this.socketIndex.delete(peerId);
        this.rooms.delete(id);
      }
    }
  }

  stats() {
    return { rooms: this.rooms.size, peers: this.socketIndex.size };
  }

  dispose() {
    clearInterval(this._sweeper);
    this.rooms.clear();
    this.socketIndex.clear();
  }
}

/**
 * @typedef {Object} Room
 * @property {string} id
 * @property {string} hostId
 * @property {Set<string>} peers
 * @property {number} createdAt
 * @property {number} lastActivity
 */
