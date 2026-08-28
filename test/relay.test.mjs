// Integration tests for the relay: real TCP sockets, real RFC6455 framing,
// no mocks. These are the tests that keep the *contract* honest, since the
// client in src/net.js assumes exactly this behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../relay/server.js';
import { wsClient } from './ws-client.mjs';

async function withRelay(fn) {
    const relay = createRelay({ log: false });
    await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
    const port = relay.server.address().port;
    const clients = [];
    const open = (path) => {
        const c = wsClient({ port, path });
        clients.push(c);
        return c.join().then((w) => Object.assign(c, { w, cid: w.you }));
    };
    try { await fn(port, open, relay); } finally {
        // Never let a half-finished test hang the suite: close everything, then
        // give the server 1s to drain before we stop caring.
        for (const c of clients) { try { c.close(); } catch {} }
        await Promise.race([relay.close().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
        relay.rooms.clear();
    }
}

test('welcome carries the room, and a lone player is host', async (t) => {
    await withRelay(async (port, open) => {
        const a = await open('/ws?room=test');
        assert.equal(a.w.room, 'test');
        assert.equal(a.w.host, a.cid, 'lone player hosts');
        assert.equal(a.w.players.length, 1);
        assert.equal(a.w.maxPlayers, 8);
        a.close();
        t.diagnostic('ok');
    });
});

test('host election follows the loaded engine, join order breaks ties', async () => {
    await withRelay(async (port, open) => {
        const a = await open('/ws?room=elect');
        const b = await open('/ws?room=elect');
        assert.equal(b.w.host, a.cid, 'first joiner hosts while nobody is ready');

        b.send({ t: 'ready', ready: true });
        const ra = await a.until((m) => m.t === 'roster' && m.host === b.cid);
        assert.equal(ra.players.find((p) => p.cid === b.cid).ready, true);
        const rb = await b.until((m) => m.t === 'roster' && m.host === b.cid);
        assert.ok(rb, 'the new host is told too');
        a.close(); b.close();
    });
});

test('inputs reach the host only, and follow a host hand-over', async () => {
    await withRelay(async (port, open) => {
        const a = await open('/ws?room=in');
        const b = await open('/ws?room=in');
        const c = await open('/ws?room=in');

        b.send({ t: 'in', s: 1 | 16, f: 7 });
        const got = await a.until((m) => m.t === 'input' && m.from === b.cid);
        assert.deepEqual([got.s, got.f], [17, 7], 'mask + frame counter survive intact');

        a.send({ t: 'in', s: 2, f: 1 });
        const echo = await c.until((m) => m.t === 'input', 300).then(() => 'leaked', () => null);
        assert.equal(echo, null, 'non-hosts get no input traffic');

        // Hand-over requires the target to actually have an engine loaded.
        a.send({ t: 'promote', cid: c.cid });
        assert.ok(await a.until((m) => m.t === 'err' && m.code === 'no_host'), 'refused while c is not ready');
        c.send({ t: 'ready', ready: true });
        await a.until((m) => m.t === 'roster' && m.host === c.cid);
        b.send({ t: 'in', s: 4, f: 9 });
        const again = await c.until((m) => m.t === 'input' && m.s === 4);
        assert.equal(again.from, b.cid, 'inputs follow the new host');
        a.close(); b.close(); c.close();
    });
});

test('chat fans out; flood control kicks in', async () => {
    await withRelay(async (port, open) => {
        const a = await open('/ws?room=chat');
        const b = await open('/ws?room=chat');
        b.send({ t: 'chat', m: 'hello from b' });
        const msg = await a.until((m) => m.t === 'chat');
        assert.equal(msg.m, 'hello from b');
        assert.equal(msg.name, 'Player');
        for (let i = 0; i < 4; i++) b.send({ t: 'chat', m: `spam ${i}` });
        assert.ok(await b.until((m) => m.t === 'err' && m.code === 'rate_limited', 1500));
        a.close(); b.close();
    });
});

test('a majority vote rewrites the room mode, and late joiners inherit it', async () => {
    await withRelay(async (port, open) => {
        const a = await open('/ws?room=vote');
        const b = await open('/ws?room=vote');
        const c = await open('/ws?room=vote');

        b.send({ t: 'vote', kind: 'mode', value: 'democracy' });
        const started = await a.until((m) => m.t === 'vote_new');
        assert.equal(started.need, 2, '3 players → 2 votes to pass');
        c.send({ t: 'vote_ballot', yes: true });
        a.send({ t: 'vote_ballot', yes: true });
        const end = await a.until((m) => m.t === 'vote_end', 9500);
        assert.equal(end.passed, true);
        assert.equal(end.value, 'democracy');

        const late = await open('/ws?room=vote');
        assert.equal(late.w.state.mode, 'democracy', 'state survives for joiners');
        a.close(); b.close(); c.close(); late.close();
    });
});

test('binary frames fan out to watchers only, untouched', async () => {
    await withRelay(async (port, open) => {
        const host = await open('/ws?room=vid&ready=1');
        assert.equal(host.w.host, host.cid);
        const viewer = await open('/ws?room=vid');
        const busybody = await open('/ws?room=vid');

        viewer.send({ t: 'watch', on: true });
        await host.until((m) => m.t === 'roster' && m.players.find((p) => p.cid === viewer.cid && p.watching));

        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
        const hdr = Buffer.alloc(12);
        hdr.writeUInt32BE(0x534d3646, 0);
        hdr.writeUInt32BE(42, 4);
        hdr.writeUInt32BE(1234, 8);
        host.sendBin(Buffer.concat([hdr, jpeg]));

        const got = await viewer.until((m) => Buffer.isBuffer(m), 2000);
        assert.ok(Buffer.isBuffer(got), 'viewer receives a binary frame');
        assert.equal(got.length, 12 + jpeg.length);
        assert.equal(got.readUInt32BE(4), 42, 'frame index preserved');
        assert.deepEqual([...got.subarray(12)], [...jpeg], 'jpeg bytes untouched');
        // The busybody gets roster chatter, but must never be sent a video frame.
        const leak = await busybody.until((m) => Buffer.isBuffer(m), 400).then(() => 'leaked', () => null);
        assert.equal(leak, null, 'non-watchers are skipped');
        host.close(); viewer.close(); busybody.close();
    });
});

test('hello re-asserts readiness, and a wrong protocol version is refused', async (t) => {
    await withRelay(async (port, open) => {
        const a = await open('/ws?room=sync');
        const b = await open('/ws?room=sync');            // joined with ready unset
        assert.equal(b.w.host, a.cid, 'a hosts while b has no engine');
        assert.equal(b.w.players.find((p) => p.cid === b.cid).ready, false);

        b.send({ t: 'hello', ver: 1, ready: true, plat: 'mobile' });
        const flip = await b.until((m) => m.t === 'roster' && m.host === b.cid);
        assert.ok(flip, 'hello{ready:true} elects b as host');
        await a.until((m) => m.t === 'roster' && m.host === b.cid);
        assert.equal(flip.players.find((p) => p.cid === b.cid).plat, 'mobile', 'platform too');

        // A v99 client: told, then dropped. (Handshake first — writing to a
        // socket that has not connected yet is an error, not a queue.)
        const bad = wsClient({ port, path: '/ws?room=sync' });
        await bad.join();
        bad.send({ t: 'hello', ver: 99 });
        const err = await bad.until((m) => m.t === 'err' && m.code === 'version');
        assert.match(err.msg, /v99/);
        t.diagnostic(`relay said: ${err.msg}`);
        a.close(); b.close(); bad.close();
    });
});

test('room capacity is enforced, and leaving frees a slot', async () => {
    await withRelay(async (port, open, relay) => {
        const socks = [];
        for (let i = 0; i < 8; i++) socks.push(await open('/ws?room=full'));
        const ninth = await open('/ws?room=full').catch((e) => e);
        const err = ninth.w && ninth.w.t === 'err' ? ninth.w : await ninth.until((m) => m.t === 'err' && m.code === 'room_full', 1500);
        assert.ok(err && err.code === 'room_full', 'ninth player is refused');
        assert.equal(err.max, 8);

        socks[7].close();
        await new Promise((r) => setTimeout(r, 200));
        const tenth = await open('/ws?room=full');
        assert.equal(tenth.w.t, 'welcome', 'slot freed after a leave');
        assert.equal([...relay.rooms.get('full').players.values()].length, 8);
        socks.slice(0, 7).forEach((s) => s.close());
        ninth.close(); tenth.close();
    });
});
