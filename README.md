# Relay — P2P Web Share

**Direct browser-to-browser file transfer. Your files never touch a server.**

Relay is a decentralized file-sharing web app. Two browsers establish a direct
[WebRTC](https://webrtc.org/) data channel and stream a file straight from one
to the other. A small signaling server introduces the two peers to each other —
but it only relays the connection handshake. It never sees, processes, or stores
a single byte of file data. Add the optional end-to-end encryption layer and the
server can't even see the key: it lives in the URL fragment, which browsers never
transmit.

This was built for **MARS Open Projects 2026**.

---

## Live links

> Fill these in after deploying (see [Deployment](#deployment)).

- **App (frontend):** `https://<your-app>.vercel.app`
- **Signaling server (backend):** `https://<your-signaling>.onrender.com`

---

## How it works

```
   Sender browser                Signaling server               Receiver browser
   ──────────────                ────────────────               ────────────────
        │                              │                               │
        │  1. create room   ─────────► │                               │
        │  ◄─────  roomId + link       │                               │
        │                              │                               │
        │   (share link out-of-band: copy / QR)  ──────────────────►   │
        │                              │                               │
        │                              │ ◄──────  2. join room         │
        │  ◄───── peer joined          │                               │
        │                              │                               │
        │  3. SDP offer / answer + ICE candidates  (relayed only)      │
        │ ◄═══════════════════════════════════════════════════════════►│
        │                              │                               │
        │  4. DIRECT WebRTC data channel — server is NOT in this path  │
        │ ◄════════════ encrypted file chunks, P2P ═══════════════════►│
        │                              │                               │
```

1. The **sender** drops a file. The app asks the signaling server to open a room
   and gets back a short room ID plus a shareable link.
2. The **receiver** opens that link and joins the room.
3. The two browsers exchange WebRTC session descriptions and ICE candidates
   *through* the signaling server. This is the only thing the server does.
4. Once a direct peer-to-peer channel is open, the file is chunked, optionally
   encrypted, and streamed **directly between the browsers**. The server is no
   longer involved and never sees the data.

The receiver verifies a whole-file **SHA-256** hash against the sender's before
the download is offered, so a corrupted or tampered transfer is caught rather
than silently saved.

---

## Features

### Core (MVP)

- **Drag-and-drop upload** with a 50 MB ceiling enforced client-side.
- **Unique room ID + shareable link**, plus a scannable **QR code** for sending
  to a phone.
- **Node.js + Express + Socket.io signaling server** that coordinates the
  handshake and nothing else.
- **WebRTC data-channel transfer** using the `FileReader` API to read the file,
  with backpressure handling so large files don't blow up browser memory.
- **SHA-256 integrity verification** — the reassembled file is re-hashed on the
  receiver and compared to the sender's hash. Zero-corruption guarantee.
- **Live progress** — percentage, throughput (MB/s), ETA, and connection status,
  all surfaced through a custom "transmission line" UI that visualizes the link
  between the two peers.
- **Graceful disconnect handling** — peer-leave events, room expiry (TTL), and
  capacity limits are all handled with clear user feedback.
- **Automatic download** when the transfer completes and verifies.

### Beyond the MVP

- **Zero-knowledge end-to-end encryption** — *fully implemented*. Each transfer
  generates an **AES-256-GCM** key via the Web Crypto API. The key is placed in
  the URL **fragment** (`#k=...`), which is never sent to any server. Every chunk
  carries its own IV and GCM authentication tag, giving both confidentiality and
  per-chunk tamper detection on top of the whole-file hash.

> **On the other brownie-point items** — the wire protocol was deliberately
> designed to make them reachable, and the project is honest about their status:
>
> - **Large files (>500 MB):** the protocol frames every chunk with an explicit
>   4-byte index, which is exactly the structure a streaming sink
>   (OPFS / `WritableStream` / IndexedDB) needs to write chunks to disk instead
>   of buffering them in memory. The current build holds the file in memory and
>   caps at 50 MB; swapping the receiver's in-memory array for a streaming sink
>   is a localized change, not an architectural one. **Designed-for, not shipped.**
> - **Multi-peer mesh swarming:** rooms, peer tracking, and per-message
>   addressed signaling already support more than two participants at the
>   protocol layer; the room capacity is intentionally set to 2 for the
>   one-to-one MVP. **Designed-for, not shipped.**
> - **Connection auto-resume on churn:** indexed chunks make "resume from chunk
>   N" tractable, but reconnection/replay logic is **not** implemented.
>
> These are described as extensions rather than claimed as done.

---

## Tech stack

| Layer        | Choice                                                         |
| ------------ | ------------------------------------------------------------- |
| Frontend     | React 18 + Vite, Tailwind CSS, React Router                   |
| Transport    | Native WebRTC (`RTCPeerConnection` + `RTCDataChannel`)        |
| Crypto       | Web Crypto API (AES-256-GCM, SHA-256)                         |
| Signaling    | Node.js + Express + Socket.io                                 |
| Hosting      | Vercel / Netlify (frontend) · Render / Railway (signaling)    |

No WebRTC wrapper library is used — the peer connection, data channel,
offer/answer flow, ICE buffering, and backpressure are all hand-written in
`client/src/lib/peer.js`. The protocol, chunking, hashing, and crypto are
likewise original and live in `client/src/lib/`.

---

## Project structure

```
p2p-web-share/
├── client/                     # React + Vite frontend
│   ├── src/
│   │   ├── lib/                # Transfer engine (framework-agnostic, unit-tested)
│   │   │   ├── peer.js         #   WebRTC peer connection + data channel
│   │   │   ├── protocol.js     #   Wire format: JSON control msgs + binary chunk frames
│   │   │   ├── sender.js       #   Chunking, backpressure, send loop
│   │   │   ├── receiver.js     #   Reassembly, decrypt, hash verify, download
│   │   │   ├── crypto.js       #   AES-256-GCM encrypt/decrypt + key export for URL
│   │   │   ├── hash.js         #   SHA-256 helpers
│   │   │   ├── rate.js         #   Sliding-window throughput / ETA meter
│   │   │   ├── signaling.js    #   Socket.io client wrapper
│   │   │   └── ...             #   fileio, download, format, emitter
│   │   ├── hooks/              # React glue: useSender, useReceiver, ICE config
│   │   ├── components/         # TransmissionLine, DropZone, ShareCard, QR, etc.
│   │   ├── pages/              # Home (send) and Receive
│   │   └── config.js           # Signaling URL resolution, file-size cap
│   ├── test/transfer.test.js   # End-to-end sender↔receiver engine tests (loopback)
│   ├── vercel.json             # SPA rewrite (deep links → index.html)
│   └── public/_redirects       # Same, for Netlify
│
├── server/                     # Signaling server
│   ├── src/
│   │   ├── server.js           # Express app, Socket.io, /health, /ice-config
│   │   ├── rooms.js            # Room registry: create/join/TTL sweep/capacity
│   │   └── signaling.js        # Socket event handlers (create/join/signal/leave)
│   ├── test/signaling.test.js  # Real Socket.io integration tests
│   ├── render.yaml             # Render deploy blueprint
│   └── Procfile                # Railway / Heroku-style process
│
└── docs/                       # Architecture deep-dive + demo script
```

---

## Running locally

You need **Node.js 18+**. The app runs as two processes: the signaling server
and the frontend dev server.

### 1. Start the signaling server

```bash
cd server
npm install
npm start
```

It listens on **http://localhost:4000**. Visit `/health` to confirm it's up.

### 2. Start the frontend (in a second terminal)

```bash
cd client
npm install
npm run dev
```

Vite serves the app on **http://localhost:5173**. The frontend auto-discovers
the signaling server at `localhost:4000` in development, so no config is needed.

### 3. Try a transfer

Open http://localhost:5173, drop a file, and copy the generated link. Open that
link in a **second tab or another browser** (an incognito window works well) to
play the receiver. The file streams directly between the two.

> **Testing across two devices on your LAN:** open the app on your phone at
> `http://<your-computer-ip>:5173`. The frontend will look for the signaling
> server at `<your-computer-ip>:4000` automatically.

---

## Configuration

Both packages ship a `.env.example`. Copy it to `.env` to override defaults.

### Server (`server/.env`)

| Variable        | Default        | Purpose                                                       |
| --------------- | -------------- | ------------------------------------------------------------- |
| `PORT`          | `4000`         | Port the signaling server listens on.                         |
| `CLIENT_ORIGIN` | `*`            | Comma-separated CORS allowlist. Set to your frontend URL in prod. |
| `ROOM_TTL_MS`   | `1800000`      | How long an idle room lives before it's swept (30 min).       |
| `MAX_PEERS`     | `2`            | Room capacity. `2` for one-to-one transfers.                  |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | — | Optional TURN relay for symmetric NATs. Relays only encrypted data. |

### Client (`client/.env`)

| Variable              | Default            | Purpose                                          |
| --------------------- | ------------------ | ------------------------------------------------ |
| `VITE_SIGNALING_URL`  | auto / localhost   | URL of the deployed signaling server in production. |

---

## Deployment

The two halves deploy independently.

### Signaling server → Render (or Railway)

- **Render:** the included `server/render.yaml` is a ready blueprint — point
  Render at the repo and it builds `server/` with `npm install` and runs
  `npm start`, health-checking `/health`. Set `CLIENT_ORIGIN` to your frontend's
  URL.
- **Railway:** the `server/Procfile` declares the web process; set the root
  directory to `server/`.

Note the deployed URL (e.g. `https://p2p-web-share-signaling.onrender.com`).

### Frontend → Vercel (or Netlify)

Set the project root to `client/` and add one environment variable:

```
VITE_SIGNALING_URL = https://<your-signaling-server-url>
```

- **Vercel:** `client/vercel.json` rewrites all routes to `index.html` so deep
  links like `/r/<roomId>` resolve instead of 404-ing.
- **Netlify:** `client/public/_redirects` does the same. Build command
  `npm run build`, publish directory `dist`.

Finally, set the server's `CLIENT_ORIGIN` to the frontend URL so CORS and the
Socket.io connection are accepted.

---

## Testing

The transfer engine and the signaling server both have test suites that run on
plain Node — no browser or test framework required.

```bash
# Transfer engine: full sender↔receiver round-trip over a loopback channel,
# covering plaintext, encrypted, tamper-rejection, empty, and single-chunk files.
cd client && node test/transfer.test.js

# Signaling server: real Socket.io clients exercising room create/join,
# capacity limits, cross-room signal blocking, and the health endpoint.
cd server && node test/signaling.test.js
```

Both suites pass (13 checks each). The encryption tests deliberately corrupt a
byte mid-stream and assert the transfer is **rejected** — once by the GCM auth
tag, once by the whole-file hash.

---

## Security model

- **The signaling server never sees file data.** File bytes travel only over the
  WebRTC data channel, which is itself DTLS-encrypted in transit. The server
  relays SDP and ICE candidates and nothing more.
- **Membership is enforced on relay.** A `signal` message is only forwarded to a
  peer in the same room, so a client can't spoof traffic into a room it isn't in.
- **Optional zero-knowledge encryption.** The AES-256-GCM key is generated in the
  browser and carried in the URL fragment (`#k=...`). Fragments are never sent in
  HTTP requests, so the signaling server — and any host serving the app — cannot
  observe the key. Each chunk is independently authenticated.
- **Integrity is verified before download.** The receiver re-computes the
  whole-file SHA-256 and compares it to the sender's. A mismatch aborts the
  download.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the wire protocol and a
deeper treatment.


