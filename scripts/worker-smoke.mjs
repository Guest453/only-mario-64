#!/usr/bin/env node
// ============================================================
// scripts/worker-smoke.mjs — drive a live relay over real WebSockets.
//
// This is the "does my deployment actually work" script. It speaks exactly what
// the game speaks (join → election → presses routed to the host → mode broadcast
// → video to watchers → chat → leave → rejoin), so it is a fair test of ANY
// backend that claims to implement docs/PROTOCOL.md:
//
//   npx wrangler dev --config worker/wrangler.toml        # then:
//   node scripts/worker-smoke.mjs
//
//   node relay/server.js                                   # then:
//   node scripts/worker-smoke.mjs --url ws://127.0.0.1:8790
//
//   # the shape Discord's proxy hands you, with the prefix kept on the path:
//   node scripts/worker-smoke.mjs --url ws://127.0.0.1:8790 --path /relay/ws
//
//   # against a deployed host, just give it the wss:// URL
//   node scripts/worker-smoke.mjs --url wss://sm64relay.exe.xyz
//
// It only ever opens a WebSocket and a GET — never a raw TCP connection, which
// is the point: if this passes, Discord's proxy can reach it too. Failures print
// what the client actually received.
// ============================================================

import assert from 'node:assert/strict';
import { wsClient } from '../test/ws-client.mjs';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg('url', 'ws://127.0.0.1:8788');
const WSPATH = arg('path', '/ws');
const PREFIX = arg('prefix', 'smoke');
// Durable Object state outlives a process, so a fixed room name would inherit
// players from the last run. Always start from a clean key.
const ROOM = `${PREFIX}${Math.floor(Math.random() * 1e6)}`;
const target = new URL(`${BASE}${WSPATH}`);
const dial = (room, query) => wsClient({
    host: target.hostname,
    port: Number(target.port) || (target.protocol === 'wss:' ? 443 : 80),
    path: `${target.pathname}?room=${room}${query}`,
});

/**
 * A client that remembers every message instead of handing them out one at a
 * time: the relay is chatty, and a `waitFor` that consumes the message another
 * assertion needed is how a good deployment looks broken.
 */
function peer(name, { ready = true, room = ROOM } = {}) {
    const c = dial(room, `&name=${name}&ready=${ready ? 1 : 0}`);
    const log = [];
    const pumping = (async () => {
        for (;;) {
            const m = await c.next(120_000).catch(() => null);
            if (m == null) return;
            log.push(m);
        }
    })();
    const api = {
        name, room, log,
        send: (m) => c.send(m),
        sendBin: (b) => c.sendBin(b),
        close: () => c.close(),
        async waitFor(pred, what = 'a message', ms = 6000) {
            const end = Date.now() + ms;
            for (;;) {
                const hit = log.find(pred);
                if (hit) return hit;
                if (Date.now() > end) {
                    const seen = log.map((m) => (Buffer.isBuffer(m) ? `<binary ${m.length}B>` : m.t)).join(', ');
                    throw new Error(`waited ${ms}ms for ${what}; ${name} saw [${seen || 'nothing'}]`);
                }
                await new Promise((r) => setTimeout(r, 40));
            }
        },
        join() { return api.waitFor((m) => m.t === 'welcome' || m.t === 'err', 'the welcome frame'); },
        async idle() { await pumping; },
    };
    return api;
}

let step = 0;
const ok = (msg) => console.log(`  ${String(++step).padStart(2)}. ✓ ${msg}`);
try {
    const alice = peer('Alice');
    const wa = await alice.join();
    assert.equal(wa.t, 'welcome', `the relay said: ${JSON.stringify(wa)}`);
    assert.equal(wa.room, ROOM, 'the relay echoes the room it put us in');
    assert.equal(wa.host, wa.you, 'the first engine-loaded player is the host');
    assert.ok(wa.maxPlayers >= 1, 'welcome advertises the cap');
    assert.equal(wa.state.mode, 'solo', 'a new room starts in Solo');
    ok(`joined ${WSPATH} → room ${ROOM}, host=${wa.you}, cap ${wa.maxPlayers}`);

    const bob = peer('Bob');
    const wb = await bob.join();
    assert.equal(wb.players.length, 2, 'two clients, ONE room');
    assert.equal(wb.host, wa.you, 'the host did not change when a viewer arrived');
    assert.deepEqual(wb.players.map((p) => p.name).sort(), ['Alice', 'Bob'],
        'names ride the query string, which is how src/net.js sends them');
    ok('second player landed in the same room without moving the pad');

    await alice.waitFor((m) => m.t === 'roster' && m.players.length === 2, 'roster(2) at the host');
    ok('the host was told about the newcomer');

    // A viewer press must reach the host and nobody else: the star the game needs.
    bob.send({ t: 'in', s: 1 | 16, f: 7 });
    const inp = await alice.waitFor((m) => m.t === 'input' && m.s === 17, 'the input frame');
    assert.equal(inp.from, wb.you, 'presses are attributed, not merged blindly');
    ok(`press routed to the host only (mask ${inp.s}, frame ${inp.f})`);

    // Mode is room state: the host writes it, the relay repeats it to everyone.
    alice.send({ t: 'state', s: { mode: 'mash', opts: { hold: 25000 } } });
    const st = await bob.waitFor((m) => m.t === 'roster' && m.state?.mode === 'mash', 'roster with mode=mash');
    assert.equal(st.state.opts.hold, 25000, 'mode options travel with the mode');
    assert.equal(st.players.find((p) => p.name === 'Alice').host, true,
        'the host flag is a field on each row, never a separate message');
    ok('mode + options broadcast to every other player');

    // Video flows host → watchers, only to those who asked, untouched.
    bob.send({ t: 'watch', on: true });
    await alice.waitFor((m) => m.t === 'roster' && m.players.find((p) => p.name === 'Bob')?.watching, 'Bob marked watching');
    const frame = Buffer.concat([Buffer.from('SM6F'), Buffer.alloc(4), Buffer.alloc(4096, 0x5a)]);
    alice.sendBin(frame);
    const got = await bob.waitFor((m) => Buffer.isBuffer(m) || m instanceof Uint8Array, 'a binary frame');
    assert.equal(Buffer.from(got).length, frame.length, 'the frame is relayed byte for byte');
    ok(`host frame relayed to the watcher (${Buffer.from(got).length} bytes, "${Buffer.from(got).subarray(0, 4).toString()}")`);

    bob.send({ t: 'chat', m: 'brain on the right side, brain on the left' });
    const chat = await alice.waitFor((m) => m.t === 'chat' && /brain/.test(m.m), 'the chat line');
    assert.equal(chat.name, 'Bob', 'chat is attributed by name as well as cid');
    ok('chat relayed with attribution');

    // A room is a wall, not a suggestion: nothing from above may appear there.
    const zoe = peer('Zoe', { room: `${ROOM}iso` });
    const wz = await zoe.join();
    assert.equal(wz.room, `${ROOM}iso`, 'separate keys, separate rooms');
    assert.equal(wz.players.length, 1, 'and a private roster');
    zoe.close();
    ok('isolation: the neighbouring room saw only itself');

    // Vote: the relay settles it, because it owns the state (and arms the timer).
    bob.send({ t: 'vote', kind: 'mode', value: 'democracy', opts: { windowMs: 400 } });
    const ballot = await alice.waitFor((m) => m.t === 'vote_new' && m.value === 'democracy', 'the open ballot');
    assert.equal(ballot.need, 2, 'a majority of the room, floor of two');
    alice.send({ t: 'vote_ballot', yes: true });
    // the relay settles a ballot when its deadline fires (8 s), not on quorum,
    // so this wait has to outlast the vote window
    const end = await bob.waitFor((m) => m.t === 'vote_end' && m.yes.length === 2, 'the verdict', 12_000);
    assert.equal(end.passed, true, '2 of 2 is enough');
    await alice.waitFor((m) => m.t === 'roster' && m.state?.mode === 'democracy', 'the mode the vote passed');
    ok('vote opened, tallied by the relay, and the mode followed');

    bob.close();
    const after = await alice.waitFor((m) => m.t === 'roster' && m.players.length === 1, 'roster(1) after a leave');
    assert.equal(after.host, wa.you, 'a viewer leaving does not move the pad');
    ok('leave → roster shrinks, host unchanged');

    // The Durable Object promise: a socket that never existed finds the room as
    // it was left, because state is written on every mutation.
    const carlos = peer('Carlos');
    const wl = await carlos.join();
    assert.equal(wl.state.mode, 'democracy', 'room state survived the whole session');
    assert.equal(wl.players.length, 2, 'and the late joiner sees who is here');
    assert.equal(wl.host, wa.you, 'and who is driving');
    ok('a fresh join finds the live mode and roster');

    for (const p of [alice, carlos]) { try { p.close(); } catch { /* already gone */ } }
    console.log('\n  ✅ this relay speaks docs/PROTOCOL.md; Discord can be pointed at it.\n');
    process.exit(0);
} catch (err) {
    console.error(`\n  ✗ step ${step + 1}: ${err?.message || err}`);
    console.error(`     (relay under test: ${BASE}${WSPATH} — see docs/RELAY.md for what has to be true)\n`);
    process.exit(1);
}
