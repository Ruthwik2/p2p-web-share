import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalingClient } from '../lib/signaling.js';
import { Peer } from '../lib/peer.js';
import { FileReceiver } from '../lib/receiver.js';
import { importKey } from '../lib/crypto.js';
import { triggerDownload } from '../lib/download.js';
import { SIGNALING_URL } from '../config.js';
import { fetchIceServers } from './ice.js';

// Friendlier wording for the coded join failures the relay can return.
const JOIN_MESSAGES = {
  ROOM_NOT_FOUND: 'This share room has expired or doesn’t exist. Ask the sender for a fresh link.',
  ROOM_FULL: 'This room already has two people in it. Direct transfers are one-to-one.',
  BAD_ROOM_ID: 'That share link is malformed.',
};

/**
 * Drives the receiving side of one transfer.
 *
 * Sequence: import the key from the URL fragment -> join the room -> answer the
 * sender's WebRTC offer (we are not the initiator) -> accept chunks, decrypt
 * them, reassemble in memory, verify the whole-file SHA-256, and auto-download.
 *
 * Ordering note: the answering peer and the receiver engine are constructed
 * *before* we connect and join. The sender begins generating its offer the
 * instant the relay tells it we joined, and that offer can race ahead of our
 * own room:join acknowledgement. Building the peer up front guarantees an
 * inbound offer is always handled instead of silently dropped.
 */
export function useReceiver(roomId, keyStr) {
  const [state, setState] = useState({
    status: 'joining', // joining | connecting | receiving | verifying | done | error | peer-left
    connection: 'connecting', // connecting | connected | reconnecting | failed | disconnected
    meta: null, // { name, size, mime, encrypted, totalChunks, ... }
    progress: { percent: 0, bytesReceived: 0, total: 0, speed: 0, etaMs: 0 },
    verified: false,
    hash: null,
    error: null,
    resume: null, // { attempt, max } while a churned link is being recovered
  });

  const refs = useRef({ signaling: null, peer: null, receiver: null, hostId: null, joined: false });
  const patch = useCallback((p) => setState((s) => ({ ...s, ...p })), []);

  const cancel = useCallback(() => {
    refs.current.receiver?.cancel();
    patch({ status: 'peer-left', connection: 'disconnected' });
  }, [patch]);

  useEffect(() => {
    if (!roomId) return undefined;
    let disposed = false;
    const r = refs.current;

    async function begin() {
      // Without the key fragment there is nothing to decrypt with.
      if (!keyStr) {
        patch({
          status: 'error',
          error: 'This link is missing its decryption key. Use the full link the sender gave you.',
        });
        return;
      }

      let key;
      try {
        key = await importKey(keyStr);
      } catch {
        patch({ status: 'error', error: 'The decryption key in this link is invalid.' });
        return;
      }

      const iceServers = await fetchIceServers();
      if (disposed) return;

      const signaling = new SignalingClient(SIGNALING_URL);
      r.signaling = signaling;

      // --- Build the answering peer + receiver engine NOW (before connecting) so
      //     an early offer is never dropped. ----------------------------------
      const peer = new Peer({ iceServers, initiator: false });
      r.peer = peer;

      peer.on('signal', (data) => {
        // The answer/ICE are routed back to the sender. hostId is known by this
        // point: either from the join ack or from the offer that triggered them.
        if (r.hostId) signaling.signal(r.hostId, data);
      });
      peer.on('state', ({ connection }) => {
        if (connection === 'connected') patch({ connection: 'connected', status: 'connecting', resume: null });
      });
      // Churn recovery: a dropped link is renegotiated in place. As the
      // responder we ask the sender to ICE-restart; only an exhausted recovery
      // emits 'error'.
      peer.on('resuming', (info) => patch({ connection: 'reconnecting', resume: info }));
      peer.on('resumed', () => patch({ connection: 'connected', resume: null }));
      peer.on('error', (err) =>
        patch({ status: 'error', error: err?.message || 'The connection failed.' }),
      );

      const receiver = new FileReceiver({ peer, key });
      r.receiver = receiver;

      receiver.on('meta', (meta) => patch({ meta, status: 'receiving' }));
      receiver.on('progress', (p) =>
        patch({
          progress: {
            percent: p.percent,
            bytesReceived: p.bytesReceived,
            total: p.total,
            speed: p.speed,
            etaMs: p.etaMs,
          },
        }),
      );
      receiver.on('phase', (phase) => {
        if (phase === 'verifying') patch({ status: 'verifying' });
      });
      receiver.on('done', ({ blob, name, hash }) => {
        patch({ status: 'done', verified: true, hash, connection: 'connected' });
        triggerDownload(blob, name); // auto-download the verified file
      });
      receiver.on('error', (err) =>
        patch({ status: 'error', error: err?.message || 'The transfer failed.' }),
      );
      receiver.on('cancelled', ({ by }) =>
        patch({
          status: 'peer-left',
          connection: 'disconnected',
          error: by === 'peer' ? 'The sender cancelled the transfer.' : null,
        }),
      );

      signaling.on('error', () => {
        // After we've joined, a connect_error is just a reconnection attempt
        // failing — Socket.io keeps retrying and peer-level recovery covers a
        // true loss. Only an error before we've joined is fatal.
        if (r.joined) return;
        patch({ status: 'error', error: 'Can’t reach the signaling server. Is it running?' });
      });

      // Join the room once connected; remember who the host is for answer routing.
      // A reconnect (new socket id) reclaims our slot instead of joining afresh.
      signaling.on('connect', async () => {
        if (r.joined) {
          try {
            await signaling.rejoinRoom(roomId);
            r.peer?.nudgeResume();
          } catch {
            /* grace window lapsed; peer:leave will have already surfaced */
          }
          return;
        }
        try {
          const res = await signaling.joinRoom(roomId);
          if (disposed) return;
          r.joined = true;
          if (!r.hostId) r.hostId = res.peers?.[0] ?? null;
        } catch (err) {
          patch({
            status: 'error',
            error: JOIN_MESSAGES[err.code] || err.message || 'Couldn’t join the room.',
          });
        }
      });

      // Inbound offer/ICE from the sender. Capture the sender's id from the first
      // signal in case it arrives before the join ack has listed a peer.
      signaling.on('signal', ({ from, data }) => {
        if (!r.hostId && from) r.hostId = from;
        r.peer?.handleSignal(data);
      });

      // The sender's socket dropped but may recover within the grace window.
      signaling.on('peer:disconnected', () => {
        setState((s) => (s.status === 'done' ? s : { ...s, connection: 'reconnecting' }));
      });

      // The sender came back with a new socket id — retarget answer routing and
      // ask it to ICE-restart so the path is rebuilt.
      signaling.on('peer:reconnect', ({ peerId }) => {
        r.hostId = peerId;
        r.peer?.nudgeResume();
      });

      // The sender left for good (or the grace window lapsed).
      signaling.on('peer:leave', () => {
        setState((s) =>
          s.status === 'done'
            ? s
            : {
                ...s,
                status: 'peer-left',
                connection: 'disconnected',
                error: s.error || 'The sender disconnected before the transfer finished.',
              },
        );
        r.receiver?.cancel();
      });

      signaling.connect();
    }

    begin();

    return () => {
      disposed = true;
      try {
        r.receiver?.dispose();
        r.peer?.close();
        r.signaling?.disconnect();
      } catch {
        /* best-effort teardown */
      }
      refs.current = { signaling: null, peer: null, receiver: null, hostId: null, joined: false };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, keyStr]);

  return { ...state, cancel };
}
