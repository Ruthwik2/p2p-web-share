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
 * Membership has two layers so a peer can survive a reconnect (the basis of
 * connection auto-resume on churn):
 *
 *   - `peers`   — the set of *live* socket ids in the room (signal addressing).
 *   - `members` — clientId -> current socketId, the *durable* membership. A
 *                 socket that drops involuntarily is removed from `peers` but
 *                 kept in `members` during a grace window, so the returning
 *                 socket (a new id) can reclaim the slot via rejoin().
 *
 * Capacity is measured in members, so a peer mid-reconnect still holds its slot
 * and a stranger can't steal it.
 *
 * A room is intentionally generic: `maxPeers` defaults to 2 (1-to-1 transfer)
 * but can be raised to support mesh swarming without touching this class.
 */
export class RoomRegistry {
  constructor({ ttlMs = 1000 * 60 * 30, maxPeers = 2, sweepMs = 1000 * 60 } = {}) {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, string>} socketId -> roomId (live sockets) */
    this.socketIndex = new Map();
    /** @type {Map<string, string>} clientId -> roomId (durable members) */
    this.clientIndex = new Map();
    this.ttlMs = ttlMs;
    this.maxPeers = maxPeers;
    this._sweeper = setInterval(() => this.sweep(), sweepMs);
    // Don't keep the process alive solely for the sweep timer.
    if (typeof this._sweeper.unref === 'function') this._sweeper.unref();
  }

  /** Create a room owned by `hostId`. Returns the new room id. */
  create(hostId, clientId = hostId) {
    let id = makeId();
    // Astronomically unlikely, but never hand out a duplicate id.
    while (this.rooms.has(id)) id = makeId();

    const now = Date.now();
    const room = {
      id,
      hostId,
      peers: new Set([hostId]),
      members: new Map([[clientId, hostId]]),
      createdAt: now,
      lastActivity: now,
    };
    this.rooms.set(id, room);
    this.socketIndex.set(hostId, id);
    this.clientIndex.set(clientId, id);
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
  join(roomId, guestId, clientId = guestId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, code: 'ROOM_NOT_FOUND', message: 'This share link has expired or never existed.' };
    }
    // Already a member (e.g. the same client opened the link twice): refresh the
    // live socket rather than consuming a second slot.
    if (room.members.has(clientId)) {
      this._bindSocket(room, clientId, guestId);
      return { ok: true, room, peers: this.peersExcept(room, guestId) };
    }
    if (room.members.size >= this.maxPeers) {
      return { ok: false, code: 'ROOM_FULL', message: 'This room already has the maximum number of peers.' };
    }
    this._bindSocket(room, clientId, guestId);
    return { ok: true, room, peers: this.peersExcept(room, guestId) };
  }

  /**
   * Reclaim a slot after a reconnect: the client is still a member but its
   * socket id changed. Swaps in the new socket and reports the prior one so the
   * caller can retarget any peers that were addressing the old id.
   * @returns {{ ok: true, room: Room, oldSocketId: string|null, peers: string[] }
   *          | { ok: false, code: string, message: string }}
   */
  rejoin(roomId, clientId, newSocketId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, code: 'ROOM_NOT_FOUND', message: 'This share link has expired or never existed.' };
    }
    if (!room.members.has(clientId)) {
      return { ok: false, code: 'NOT_A_MEMBER', message: 'Your place in this room has expired.' };
    }
    const oldSocketId = room.members.get(clientId);
    this._bindSocket(room, clientId, newSocketId);
    return { ok: true, room, oldSocketId, peers: this.peersExcept(room, newSocketId) };
  }

  /** Point a member's clientId at a (new) live socket, retiring any old one. */
  _bindSocket(room, clientId, socketId) {
    const prev = room.members.get(clientId);
    if (prev && prev !== socketId) {
      room.peers.delete(prev);
      this.socketIndex.delete(prev);
    }
    room.members.set(clientId, socketId);
    room.peers.add(socketId);
    this.socketIndex.set(socketId, room.id);
    this.clientIndex.set(clientId, room.id);
    room.lastActivity = Date.now();
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
   * Take a live socket offline WITHOUT giving up its membership — used for an
   * involuntary drop that we hope to recover from. The member is kept (its slot
   * reserved) until removeMember() is called when the grace window expires.
   * @returns {{ roomId: string, clientId: string|null, remaining: string[] } | null}
   */
  disconnectSocket(socketId) {
    const roomId = this.socketIndex.get(socketId);
    this.socketIndex.delete(socketId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.peers.delete(socketId);
    room.lastActivity = Date.now();
    return { roomId, clientId: this._clientOfSocket(room, socketId), remaining: [...room.peers] };
  }

  /**
   * Finalise a departure by clientId (grace window expired). Mirrors removePeer
   * but keyed on the durable membership, since the socket is already gone.
   * @returns {{ roomId: string, remaining: string[], deleted: boolean } | null}
   */
  removeMember(clientId) {
    const roomId = this.clientIndex.get(clientId);
    this.clientIndex.delete(clientId);
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const socketId = room.members.get(clientId);
    room.members.delete(clientId);
    if (socketId) {
      room.peers.delete(socketId);
      this.socketIndex.delete(socketId);
    }
    room.lastActivity = Date.now();

    const remaining = [...room.peers];
    let deleted = false;
    if (room.members.size === 0) {
      this.rooms.delete(roomId);
      deleted = true;
    }
    return { roomId, remaining, deleted };
  }

  /**
   * Remove a socket and its membership immediately (a voluntary/explicit leave).
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
    const clientId = this._clientOfSocket(room, socketId);
    if (clientId) {
      room.members.delete(clientId);
      this.clientIndex.delete(clientId);
    }
    room.lastActivity = Date.now();

    const remaining = [...room.peers];
    let deleted = false;
    if (room.members.size === 0) {
      this.rooms.delete(roomId);
      deleted = true;
    }
    return { roomId, remaining, deleted };
  }

  /** Reverse-lookup the clientId currently bound to a socket in a room. */
  _clientOfSocket(room, socketId) {
    for (const [clientId, sid] of room.members) {
      if (sid === socketId) return clientId;
    }
    return null;
  }

  /** Drop rooms that have been idle past their TTL. */
  sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, room] of this.rooms) {
      if (room.lastActivity < cutoff) {
        for (const peerId of room.peers) this.socketIndex.delete(peerId);
        for (const clientId of room.members.keys()) this.clientIndex.delete(clientId);
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
    this.clientIndex.clear();
  }
}

/**
 * @typedef {Object} Room
 * @property {string} id
 * @property {string} hostId
 * @property {Set<string>} peers           live socket ids
 * @property {Map<string,string>} members  clientId -> current socketId
 * @property {number} createdAt
 * @property {number} lastActivity
 */
