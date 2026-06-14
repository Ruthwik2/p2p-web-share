/**
 * Integration test for the signaling server.
 *
 * Spins up the real Express + Socket.io server and drives it with two (and a
 * third) socket.io-client connections, asserting the full room lifecycle:
 * create -> join -> peer:join notification -> bidirectional signal relay ->
 * disconnect -> peer:leave, plus the rejection paths (bad id, not found, full)
 * and cross-room signal isolation.
 *
 * Run: node server/test/signaling.test.js
 */
process.env.PORT = process.env.TEST_PORT || '4555';
process.env.CLIENT_ORIGIN = '*';
process.env.MAX_PEERS = '2';
// Short grace window so the auto-resume (churn) assertions run fast.
process.env.RESUME_GRACE_MS = process.env.RESUME_GRACE_MS || '600';

const BASE = `http://localhost:${process.env.PORT}`;

// socket.io-client lives in the client workspace; resolve it from there so the
// server package doesn't need a test-only dependency.
const { io } = await import(
  new URL('../../client/node_modules/socket.io-client/build/esm/index.js', import.meta.url)
);
const { server, io: ioServer, registry } = await import('../src/server.js');

let pass = 0, fail = 0;
const check = (label, cond) => {
  if (cond) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (opts = {}) => io(BASE, { transports: ['websocket'], forceNew: true, ...opts });
const once = (sock, ev) => new Promise((res) => sock.once(ev, res));
const emitAck = (sock, ev, payload) =>
  new Promise((res) => sock.emit(ev, payload, res));

async function main() {
  console.log('signaling server — integration\n');
  await wait(150); // let the server bind

  // --- Happy path: create, join, relay, leave ---
  const a = connect();
  await once(a, 'connect');
  const b = connect();
  await once(b, 'connect');

  const { roomId } = await emitAck(a, 'room:create', {});
  check('room:create returns a room id', typeof roomId === 'string' && roomId.length >= 6);

  const aGotJoin = once(a, 'peer:join');
  const joinRes = await emitAck(b, 'room:join', { roomId });
  check('room:join acks ok', joinRes.ok === true);
  check('joiner learns the host peer id', Array.isArray(joinRes.peers) && joinRes.peers[0] === a.id);
  const joinEvt = await aGotJoin;
  check('host is notified peer:join with joiner id', joinEvt.peerId === b.id);

  // Relay A -> B
  const bGotSignal = once(b, 'signal');
  a.emit('signal', { to: b.id, data: { kind: 'offer', sdp: 'DUMMY_SDP' } });
  const sigB = await bGotSignal;
  check('signal relays host -> joiner', sigB.from === a.id && sigB.data?.sdp === 'DUMMY_SDP');

  // Relay B -> A
  const aGotSignal = once(a, 'signal');
  b.emit('signal', { to: a.id, data: { kind: 'answer', sdp: 'DUMMY_ANSWER' } });
  const sigA = await aGotSignal;
  check('signal relays joiner -> host', sigA.from === b.id && sigA.data?.sdp === 'DUMMY_ANSWER');

  // Disconnect notification (capture the id first — the client clears
  // socket.id the moment it disconnects).
  const bId = b.id;
  const aGotLeave = once(a, 'peer:leave');
  b.disconnect();
  const leaveEvt = await aGotLeave;
  check('remaining peer notified peer:leave', leaveEvt.peerId === bId);

  // --- Rejection paths ---
  const badId = await emitAck(b.connected ? b : connect(), 'room:join', { roomId: 'BAD ID!!' });
  // reconnect a fresh socket for clean rejection tests
  const c = connect(); await once(c, 'connect');
  const malformed = await emitAck(c, 'room:join', { roomId: '!!!' });
  check('malformed room id rejected', malformed.ok === false && malformed.code === 'BAD_ROOM_ID');

  const missing = await emitAck(c, 'room:join', { roomId: 'abcdefghjk' });
  check('unknown room rejected', missing.ok === false && missing.code === 'ROOM_NOT_FOUND');

  // Room full: re-create with A, fill to capacity (2), third is rejected
  const { roomId: room2 } = await emitAck(a, 'room:create', {});
  const d = connect(); await once(d, 'connect');
  const e = connect(); await once(e, 'connect');
  const dJoin = await emitAck(d, 'room:join', { roomId: room2 });
  check('second peer joins (capacity 2)', dJoin.ok === true);
  const eJoin = await emitAck(e, 'room:join', { roomId: room2 });
  check('third peer rejected as full', eJoin.ok === false && eJoin.code === 'ROOM_FULL');

  // Cross-room isolation: e (not in room2) cannot signal into it, and a stray
  // signal to a non-member is dropped.
  let leaked = false;
  d.once('signal', () => { leaked = true; });
  e.emit('signal', { to: d.id, data: { sdp: 'SHOULD_NOT_ARRIVE' } });
  await wait(120);
  check('cross-room signal is blocked', leaked === false);

  // --- Auto-resume on churn: involuntary drop + rejoin reclaims the slot ---
  // A stable clientId lets a peer that drops its socket reclaim its place within
  // the grace window, so the survivor sees a reconnect rather than a hard leave.
  {
    const host = connect();
    await once(host, 'connect');
    // reconnection:false so the dropped socket stays down and we drive the
    // reconnect explicitly with a fresh socket carrying the same clientId.
    const guest = connect({ reconnection: false });
    await once(guest, 'connect');

    const { roomId: room3 } = await emitAck(host, 'room:create', { clientId: 'host-cid' });
    await emitAck(guest, 'room:join', { roomId: room3, clientId: 'guest-cid' });
    const guestOldId = guest.id;

    // An involuntary transport close must NOT immediately evict — the survivor
    // gets peer:disconnected and the slot is held.
    let leftDuringGrace = false;
    host.on('peer:leave', () => { leftDuringGrace = true; });
    const hostGotDrop = once(host, 'peer:disconnected');
    guest.io.engine.close(); // abrupt transport close == network churn
    const dropEvt = await hostGotDrop;
    check('survivor notified peer:disconnected on churn', dropEvt.peerId === guestOldId);

    // The returning peer reclaims its slot; the survivor learns the new id.
    const guest2 = connect();
    await once(guest2, 'connect');
    const hostGotReconnect = once(host, 'peer:reconnect');
    const rejoinRes = await emitAck(guest2, 'room:rejoin', { roomId: room3, clientId: 'guest-cid' });
    check('rejoin acks ok with surviving peers', rejoinRes.ok === true && rejoinRes.peers[0] === host.id);
    const reconnectEvt = await hostGotReconnect;
    check('survivor told peer:reconnect with new + prev ids',
      reconnectEvt.peerId === guest2.id && reconnectEvt.prevPeerId === guestOldId);
    check('no peer:leave fired during the grace window', leftDuringGrace === false);

    // Signaling flows over the reclaimed slot (so an ICE restart can complete).
    const hostGotSig = once(host, 'signal');
    guest2.emit('signal', { to: host.id, data: { kind: 'offer', sdp: 'RESUME_SDP' } });
    const sig = await hostGotSig;
    check('relay works after rejoin', sig.from === guest2.id && sig.data?.sdp === 'RESUME_SDP');

    host.disconnect();
    guest2.disconnect();
    await wait(30);
  }

  // --- Grace window expiry: an unrecovered drop becomes a real peer:leave ---
  {
    const host = connect();
    await once(host, 'connect');
    const guest = connect({ reconnection: false });
    await once(guest, 'connect');
    const { roomId: room4 } = await emitAck(host, 'room:create', { clientId: 'host-cid-2' });
    await emitAck(guest, 'room:join', { roomId: room4, clientId: 'guest-cid-2' });
    const guestOldId = guest.id;

    const hostGotLeave = once(host, 'peer:leave');
    guest.io.engine.close();
    const leaveEvt = await hostGotLeave; // arrives only after RESUME_GRACE_MS
    check('grace expiry yields peer:leave for the lost peer', leaveEvt.peerId === guestOldId);

    host.disconnect();
    await wait(30);
  }

  // Health endpoint reflects live state
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check('health endpoint reports ok', health.status === 'ok' && typeof health.rooms === 'number');

  // Cleanup
  for (const s of [a, c, d, e]) s.disconnect();
  await wait(50);

  console.log(`\n${pass} passed, ${fail} failed`);
  ioServer.close();
  registry.dispose();
  server.close(() => process.exit(fail === 0 ? 0 : 1));
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 1000).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
