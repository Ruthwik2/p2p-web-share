# Architecture

This document covers the moving parts of Relay: the signaling handshake, the
data-channel wire protocol, the encryption scheme, and the integrity guarantee.
It's aimed at a reviewer who wants to understand *how* the "server never sees
your file" claim is actually enforced.

---

## 1. Components

There are exactly two deployable units.

**The signaling server** (`server/`) is a thin Express + Socket.io service. Its
entire job is to let two browsers find each other and exchange the WebRTC
handshake. It keeps an in-memory registry of short-lived rooms and relays
messages between the members of a room. It has no database, no file storage, and
no awareness of file contents. It exposes three HTTP endpoints — `/` (service
info), `/health` (liveness), and `/ice-config` (the STUN/TURN list handed to
clients) — and a small set of Socket.io events.

**The client** (`client/`) is a React + Vite single-page app. The UI is a thin
shell around a framework-agnostic transfer engine in `client/src/lib/`. That
separation is deliberate: the engine has no React in it and is exercised directly
by the test suite over a loopback channel.

---

## 2. The signaling handshake

Signaling is the only phase the server participates in. The Socket.io event set
is small:

| Event (client → server) | Server response / broadcast            | Meaning                                  |
| ----------------------- | -------------------------------------- | ---------------------------------------- |
| `room:create`           | ack `{ roomId }`                       | Sender opens a new room.                 |
| `room:join { roomId }`  | ack `{ ok, peers }` or `{ ok:false, code }` | Receiver joins; host is notified via `peer:join`. |
| `signal { to, data }`   | relayed as `signal { from, data }`     | Relay one SDP/ICE payload to a roommate. |
| `room:leave`            | broadcast `peer:leave`                 | Explicit departure.                      |
| *disconnect*            | broadcast `peer:leave`                 | Socket dropped.                          |

Two correctness details matter here:

- **Fixed roles, no glare.** The room creator is always the WebRTC *initiator*
  and the joiner is always the *responder*. Because the roles are fixed, there's
  no "glare" (both sides offering simultaneously) to resolve.
- **Relay is membership-checked.** When the server receives a `signal` addressed
  `to` some socket, it only forwards it if that socket is in the *same room* as
  the sender. A client therefore can't inject signaling traffic into a room it
  hasn't joined.

### The early-offer ordering guarantee

The initiator starts producing its SDP offer the instant the server tells it a
peer joined. That offer can arrive at the receiver *before* the receiver's own
`room:join` acknowledgement has resolved. If the receiver only built its peer
connection inside the join-callback, such an early offer would be dropped and the
connection would intermittently hang in "connecting".

The receiver hook (`useReceiver.js`) avoids this by **constructing the peer
connection and receiver engine up front**, before connecting and joining, and
discovering the host's id from either the join acknowledgement *or* the `from`
field of the first inbound signal — whichever arrives first. Inbound offers are
therefore always handled.

---

## 3. The data channel

Once the offer/answer exchange completes and ICE finds a path, an
`RTCDataChannel` opens directly between the two browsers. **The signaling server
is not on this path** and sees none of what follows. The channel is DTLS-encrypted
by WebRTC itself, so even the bytes on the wire are protected in transit
independent of the application-layer encryption described below.

`client/src/lib/peer.js` wraps the raw connection and handles:

- **ICE candidate buffering** — candidates that arrive before the remote
  description is set are queued and flushed afterward.
- **Backpressure** — the data channel's `bufferedAmountLowThreshold` is set and
  the send loop awaits a `bufferedamountlow` event whenever the buffer fills,
  so a fast sender can't outrun a slow channel and exhaust memory.
- **Message sizing** — the maximum message size is read from the negotiated SCTP
  parameters (with a conservative fallback), and chunk sizes are derived from it.

---

## 4. Wire protocol

Two kinds of messages share the data channel, disambiguated trivially by type:
**control messages are JSON strings**, **chunk frames are binary**. The receiver
branches on `typeof data === 'string'`.

### Control messages (JSON strings)

| Type       | Direction          | Payload                                            |
| ---------- | ------------------ | -------------------------------------------------- |
| `meta`     | sender → receiver  | File name, size, MIME type, whole-file SHA-256, encryption flag. Sent once. |
| `accept`   | receiver → sender  | Receiver's buffers are ready; begin streaming.     |
| `complete` | receiver → sender  | All chunks received; carries the integrity result. |
| `error`    | either             | Fatal problem; abort.                              |
| `cancel`   | either             | User cancelled.                                    |

### Chunk frames (binary)

Every chunk is length-framed with a 4-byte little-endian `uint32` index:

```
plain:      [ 4B index ][ raw bytes ]
encrypted:  [ 4B index ][ 12B IV ][ ciphertext + 16B GCM tag ]
```

The explicit index makes each frame self-describing. That's what makes the frame
format forward-compatible with out-of-order application and with resume-after-
reconnect: a receiver can place chunk *N* regardless of arrival order, and could
in principle ask a sender to resume from a specific index. (The current build
sends in order and reassembles in memory; the framing is what would make the
streaming and resume extensions tractable without a protocol change.)

Framing/parsing is implemented in `protocol.js` (`frameChunk` / `parseFrame`),
which uses `DataView.setUint32(…, true)` / `getUint32(…, true)` for the
little-endian index and returns the payload as a zero-copy subview.

---

## 5. Encryption (zero-knowledge)

When encryption is enabled, `client/src/lib/crypto.js`:

1. Generates a fresh **AES-256-GCM** key per transfer via
   `crypto.subtle.generateKey`.
2. Exports it as base64url and the sender places it in the share link's **URL
   fragment**: `…/r/<roomId>#k=<key>`. The fragment is never included in HTTP
   requests by browsers, so it reaches neither the signaling server nor whatever
   static host serves the app. Only someone with the full link can decrypt.
3. Encrypts each chunk under a **fresh 12-byte IV** (the recommended GCM nonce
   size). The IV is prepended to the ciphertext so the receiver needs no
   out-of-band IV bookkeeping:

   ```
   encryptChunk → [ 12B IV ][ ciphertext + 16B auth tag ]
   ```

4. The receiver imports the key from its own URL fragment and decrypts. A failed
   GCM authentication (i.e. a tampered or corrupted chunk) throws, and the
   transfer is rejected.

Because the key lives only in the fragment and the key material never leaves the
browser, the server is *structurally* unable to decrypt — this is what "zero
knowledge" means here, as opposed to a promise not to look.

---

## 6. Integrity

Relay verifies integrity at two levels:

- **Per-chunk** (encrypted mode): the AES-GCM authentication tag detects any
  modification of an individual chunk.
- **Whole-file** (always): the sender computes a SHA-256 over the entire file up
  front and ships it in the `meta` message. After reassembly, the receiver
  re-computes the SHA-256 of the bytes it actually has and compares. A mismatch
  aborts before the file is offered for download.

The test suite asserts both paths: it flips a byte mid-stream and confirms the
transfer is rejected — once caught by the GCM tag in encrypted mode, once by the
hash comparison in plaintext mode.

---

## 7. Lifecycle and failure handling

- **Room TTL.** Idle rooms are swept after `ROOM_TTL_MS` (default 30 minutes) so
  the registry can't grow without bound.
- **Capacity.** Rooms are capped at `MAX_PEERS` (default 2). A third joiner is
  rejected with a `ROOM_FULL` code that the UI translates to a friendly message.
- **Disconnects.** A dropped socket broadcasts `peer:leave`; the UI reflects the
  lost peer rather than hanging silently.
- **Coded join failures.** `ROOM_NOT_FOUND`, `ROOM_FULL`, and `BAD_ROOM_ID` are
  returned as machine-readable codes and mapped to human-readable copy on the
  client.

---

## 8. Why no WebRTC wrapper library

The peer connection, data channel, offer/answer flow, ICE buffering, backpressure,
chunking, hashing, protocol, and crypto are all written from scratch in
`client/src/lib/`. This keeps the data path auditable end-to-end — there's no
third-party transport layer between the file and the channel to reason about — and
it's a deliberate response to the project brief's emphasis on original work over
assembled templates.
