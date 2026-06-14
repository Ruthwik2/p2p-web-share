import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalingClient } from '../lib/signaling.js';
import { Peer } from '../lib/peer.js';
import { FileSender } from '../lib/sender.js';
import { generateKey, exportKey, encryptionAvailable } from '../lib/crypto.js';
import { SIGNALING_URL } from '../config.js';
import { fetchIceServers } from './ice.js';

/**
 * Drives the sending side of one transfer.
 *
 * Sequence: connect to the relay -> mint a room -> generate a per-transfer
 * AES-GCM key -> build a share link that carries the key in its URL fragment.
 * When a recipient joins, open a WebRTC connection (we are the initiator),
 * then stream the file once the data channel is live.
 *
 * The relay only ever learns the room id. The key lives after '#', which the
 * browser never sends over the network, so the relay cannot decrypt anything.
 */
export function useSender(file) {
  const [state, setState] = useState({
    status: 'init', // init | creating | waiting | connecting | transferring | verifying | done | error | peer-left | cancelled
    roomId: null,
    link: null,
    connection: 'idle', // idle | connecting | connected | disconnected | failed
    progress: { percent: 0, bytesSent: 0, total: file?.size ?? 0, speed: 0, etaMs: 0 },
    hash: null,
    verified: false,
    encrypted: encryptionAvailable(),
    error: null,
    peerPresent: false,
  });

  const refs = useRef({ signaling: null, peer: null, sender: null, key: null, peerId: null });
  const patch = useCallback((p) => setState((s) => ({ ...s, ...p })), []);

  // --- actions -------------------------------------------------------------
  const cancel = useCallback(() => {
    refs.current.sender?.cancel();
    patch({ status: 'cancelled', connection: 'disconnected' });
  }, [patch]);

  // --- lifecycle -----------------------------------------------------------
  useEffect(() => {
    if (!file) return undefined;
    let disposed = false;
    const r = refs.current;

    async function begin() {
      patch({ status: 'creating' });

      // ICE first, so a peer connection can be built synchronously the moment
      // a recipient appears (no async gap where a signal could be missed).
      const iceServers = await fetchIceServers();
      if (disposed) return;

      const key = await generateKey();
      const keyStr = await exportKey(key);
      r.key = key;

      const signaling = new SignalingClient(SIGNALING_URL);
      r.signaling = signaling;

      signaling.on('error', () =>
        patch({ status: 'error', error: 'Can’t reach the signaling server. Is it running?' }),
      );

      signaling.on('connect', async () => {
        try {
          const roomId = await signaling.createRoom();
          if (disposed) return;
          const link = `${window.location.origin}/r/${roomId}#k=${keyStr}`;
          patch({ status: 'waiting', roomId, link });
        } catch {
          patch({ status: 'error', error: 'Couldn’t create a share room. Try again.' });
        }
      });

      // A recipient opened the link and joined the room.
      signaling.on('peer:join', ({ peerId }) => {
        r.peerId = peerId;
        patch({ status: 'connecting', connection: 'connecting', peerPresent: true });

        const peer = new Peer({ iceServers, initiator: true });
        r.peer = peer;

        // Pipe this side's SDP/ICE out to the specific recipient.
        peer.on('signal', (data) => signaling.signal(peerId, data));
        peer.on('state', ({ connection }) => {
          if (connection === 'connected') patch({ connection: 'connected' });
          if (connection === 'failed') patch({ connection: 'failed' });
        });
        peer.on('error', (err) =>
          patch({ status: 'error', error: err?.message || 'The connection failed.' }),
        );

        // Channel is live -> read, hash, and stream the file.
        peer.on('open', async () => {
          const sender = new FileSender({ peer, file, encrypt: true, key });
          r.sender = sender;

          sender.on('ready', ({ hash }) => patch({ hash }));
          sender.on('phase', (phase) => {
            if (phase === 'transferring') patch({ status: 'transferring' });
            if (phase === 'verifying' || phase === 'flushing') patch({ status: 'verifying' });
          });
          sender.on('progress', (p) =>
            patch({
              progress: {
                percent: p.percent,
                bytesSent: p.bytesSent,
                total: p.total,
                speed: p.speed,
                etaMs: p.etaMs,
              },
            }),
          );
          sender.on('done', () =>
            patch({ status: 'done', verified: true, connection: 'connected' }),
          );
          sender.on('error', (err) =>
            patch({ status: 'error', error: err?.message || 'The transfer failed.' }),
          );
          sender.on('cancelled', ({ by }) =>
            patch({
              status: by === 'peer' ? 'peer-left' : 'cancelled',
              connection: 'disconnected',
            }),
          );

          try {
            await sender.prepare();
            sender.start();
          } catch (err) {
            patch({ status: 'error', error: err?.message || 'Couldn’t read the file.' });
          }
        });

        peer.start().catch((err) =>
          patch({ status: 'error', error: err?.message || 'Couldn’t open a connection.' }),
        );
      });

      // Forward inbound SDP/ICE answers into our peer.
      signaling.on('signal', ({ data }) => r.peer?.handleSignal(data));

      // Recipient dropped (closed tab, lost network).
      signaling.on('peer:leave', () => {
        setState((s) =>
          s.status === 'done'
            ? s
            : { ...s, status: 'peer-left', connection: 'disconnected', peerPresent: false },
        );
        r.sender?.cancel();
      });

      signaling.connect();
    }

    begin();

    return () => {
      disposed = true;
      try {
        r.sender?.dispose();
        r.peer?.close();
        r.signaling?.disconnect();
      } catch {
        /* best-effort teardown */
      }
      refs.current = { signaling: null, peer: null, sender: null, key: null, peerId: null };
    };
    // We intentionally key this effect to the file instance only; the engines
    // own all subsequent state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  return { ...state, cancel };
}
