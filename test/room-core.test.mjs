// ============================================================
// src/room-core.js is the rulebook BOTH relays follow: relay/server.js (Node,
// the one you run on a VPS) and worker/ (Cloudflare Durable Objects). These
// tests are the reason that split is safe — the protocol contract in
// docs/PROTOCOL.md, expressed as assertions, with no sockets and no clock.
//
// If you ever change a rule here, change docs/PROTOCOL.md in the same commit.
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomCore, roomKeyOf, ROOM_DEFAULTS } from '../src/room-core.js';

const T0 = 1_700_000_000_000;
const open = (core, name, extra = {}) => {
    const r = core.join({ name, now: T0, ...extra });
    assert.equal(r.ok, true, `${name} joined`);
    return r.cid;
};
/** The messages a fan-out produced for one recipient, flattened. */
const forCid = (emit, cid) => emit.filter((o) => o.to === cid || o.to === '*').map((o) => o.m);

test('room keys are sanitised, never empty', () => {
    assert.equal(roomKeyOf('  My Room!!  '), 'myroom');
    assert.equal(roomKeyOf('dc:1234_5678'), 'dc1234_5678');
    assert.equal(roomKeyOf(''), 'lobby', 'a blank room is still a room');
    assert.equal(roomKeyOf('x'.repeat(99)).length, 40, 'bounded: a hostile query string cannot grow the keyspace forever');
});

test('the first engine-loaded player hosts, and inputs route to them only', () => {
    const core = new RoomCore('test');
    const a = open(core, 'Mario', { ready: true });
    const b = open(core, 'Luigi', { ready: true });
    const c = open(core, 'Peach', { ready: false });
    assert.equal(core.host, a, 'the first engine-loaded player hosts');
    core.handle(c, { t: 'ready', ready: true }, T0 + 5);
    assert.equal(core.host, a, 'election is first-ready in join order, not most-recent');

    const out = core.handle(b, { t: 'in', s: 1 | 16, f: 3 }, T0 + 10);
    assert.deepEqual(out.emit, [{ to: a, m: { t: 'input', from: b, s: 17, f: 3 } }],
        'a viewer press is delivered to the host and nobody else');
    const own = core.handle(a, { t: 'in', s: 2, f: 4 }, T0 + 11);
    assert.deepEqual(own.emit, [], 'the host applies its own inputs locally; the relay is a star, not a hub');
    assert.equal(core.players.get(b).bits, 17, 'roster still carries the press for the HUD');

    core.leave(a, T0 + 12);
    assert.equal(core.host, b, 'and election walks down that same order when the host leaves');
    open(core, 'Yoshi', { ready: true });
    assert.equal(core.host, b, 'a newcomer never steals the pad from a running host');
});

test('only the host may write room state', () => {
    const core = new RoomCore('test');
    const a = open(core, 'Mario', { ready: true });
    const b = open(core, 'Luigi', { ready: true });
    const bad = core.handle(b, { t: 'state', s: { mode: 'anarchy' } }, T0);
    assert.deepEqual(forCid(bad.emit, b), [{ t: 'err', code: 'not_host', msg: 'only the host sets state' }]);
    assert.equal(core.state.mode, 'solo', 'a viewer cannot change the mode');

    const good = core.handle(a, { t: 'state', s: { mode: 'mash', opts: { hold: 25_000 } } }, T0);
    assert.equal(core.state.mode, 'mash');
    assert.equal(core.state.opts.hold, 25_000);
    assert.equal(good.persist, true, 'the Durable Object must write this to storage');
    const roster = good.emit[0].m;
    assert.equal(roster.host, a);
    assert.deepEqual(roster.players.map((p) => p.name), ['Mario', 'Luigi']);
    assert.equal(roster.players[0].host, true, 'the host flag is computed into every row');
});

test('host election follows an explicit leave, and a stale host is demoted', () => {
    const core = new RoomCore('test');
    const a = open(core, 'Mario', { ready: true });
    const b = open(core, 'Luigi', { ready: true });
    const out = core.leave(a, T0 + 1);
    assert.equal(out.hostChanged, true);
    assert.equal(core.host, b, 'the next ready player takes over — a discarded copy must not stay "host"');
    assert.equal(out.emit[0].m.players.length, 1);

    core.handle(b, { t: 'in', s: 8, f: 1 }, T0 + 2);
    assert.deepEqual(core.handle(a, { t: 'in', s: 8, f: 1 }, T0 + 3).emit, [], 'a closed socket cannot inject into the room');
    const left = core.leave(b, T0 + 4);
    assert.equal(left.empty, true, 'an empty room is the transport\'s cue to delete state');
});

test('promote is honoured only while the target has an engine', () => {
    const core = new RoomCore('test');
    const a = open(core, 'Mario', { ready: true });
    const b = open(core, 'Sleepy', { ready: false });
    const nope = core.handle(a, { t: 'promote', cid: b }, T0);
    assert.deepEqual(forCid(nope.emit, a), [{ t: 'err', code: 'no_host', msg: 'that player has no engine loaded yet' }]);
    assert.equal(core.host, a);

    core.handle(b, { t: 'ready', ready: true }, T0 + 1);
    const yes = core.handle(a, { t: 'promote', cid: b }, T0 + 2);
    assert.equal(core.host, b);
    assert.deepEqual(yes.emit.map((o) => o.m.t), ['roster', 'promoted']);
    const demoted = core.handle(a, { t: 'promote', cid: a }, T0 + 3);
    assert.deepEqual(forCid(demoted.emit, a), [{ t: 'err', code: 'not_host', msg: 'only the host can hand over' }],
        'the ex-host lost the right to hand over again');
    assert.equal(core.host, b);
});

test('a vote needs a real majority and the relay writes the outcome', () => {
    const core = new RoomCore('test');
    const a = open(core, 'Mario', { ready: true });
    const b = open(core, 'Luigi', { ready: true });
    const c = open(core, 'Peach', { ready: true });

    const v = core.handle(a, { t: 'vote', kind: 'mode', value: 'coop', opts: { rotateMs: 30_000 } }, T0);
    assert.equal(v.alarmAt, T0 + ROOM_DEFAULTS.voteMs, 'the deadline is handed to the transport (setAlarm / setTimeout)');
    assert.equal(v.emit[0].m.need, 2, 'max(2, floor(n/2)+1): a lone player cannot self-pass');
    assert.deepEqual([...v.emit[0].m.yes], [a], 'the caller pre-counts as yes');
    const dupe = core.handle(b, { t: 'vote', kind: 'mode', value: 'anarchy' }, T0 + 1);
    assert.deepEqual(forCid(dupe.emit, b), [{ t: 'err', code: 'rate_limited', msg: 'vote already running' }]);

    core.handle(b, { t: 'vote_ballot', yes: true }, T0 + 2);
    core.handle(c, { t: 'vote_ballot', yes: false }, T0 + 3);
    // The transport owns the clock: it calls tally() when the alarm fires.
    const mid = core.tally(T0 + 3);
    assert.equal(mid.passed, true, 'yes 2 of 3 meets need=2');
    assert.equal(core.vote, null, 'a settled vote is cleared even if nobody ever re-votes');
    assert.deepEqual(mid.emit.map((o) => o.m.t), ['vote_end', 'roster'], 'result, then the new state');
    assert.equal(mid.emit[0].m.state, undefined, 'vote_end carries the verdict; roster carries state');
    assert.equal(core.state.mode, 'coop', 'the relay owns room state, so the relay applies the result');
    assert.equal(core.state.opts.rotateMs, 30_000, 'the motion carried its options with it');
    assert.equal(core.state.pad, null, 'a mode change resets who is holding the pad');

    // And a motion that never gathers a second yes fails instead of timing out forever.
    core.handle(a, { t: 'vote', kind: 'mode', value: 'anarchy' }, T0 + 20);
    const failed = core.tally(T0 + 20 + ROOM_DEFAULTS.voteMs);
    assert.equal(failed.passed, false, 'one yes is below need=2');
    assert.equal(core.state.mode, 'coop', 'a failed vote changes nothing');
    assert.equal(failed.persist, true);
});

test('spamming gets shed, and the socket is not punished for it', () => {
    const core = new RoomCore('test');
    const a = open(core, 'Mario', { ready: true });
    let relayed = 0;
    for (let i = 0; i < 200; i++) {          // 1 message per ms, 200 in a second
        const out = core.handle(a, { t: 'chat', m: `hi ${i}` }, T0 + i);
        relayed += out.emit.filter((o) => o.m.t === 'chat').length;
    }
    assert.equal(relayed, ROOM_DEFAULTS.chatMax, 'chat is 3 per 10 s window');

    let answered = 0;
    for (let i = 0; i < 200; i++) {
        const out = core.handle(a, { t: 'ping', c: i }, T0 + 11_000 + i);
        answered += out.emit.filter((o) => o.m.t === 'pong').length;
    }
    assert.equal(answered, ROOM_DEFAULTS.maxTextPerSec, `the ${ROOM_DEFAULTS.maxTextPerSec}/s ceiling sheds the rest silently`);
    assert.ok(core.players.has(a), 'over-rate is dropped, not disconnected — the sender is a browser on flaky WiFi');
});

test('a full room and a version mismatch are both explained, not swallowed', () => {
    const core = new RoomCore('test', { maxPlayers: 2 });
    open(core, 'Mario');
    open(core, 'Luigi');
    const full = core.join({ name: 'Peach', now: T0 });
    assert.equal(full.ok, false);
    assert.equal(full.code, 'room_full');
    assert.equal(full.max, 2, 'the cap is in the message so the UI can say "2/2"');

    const a = [...core.players.keys()][0];
    const ver = core.handle(a, { t: 'hello', ver: 99 }, T0);
    assert.equal(ver.close.code, 4000, 'a protocol-incompatible client is closed, not left half-joined');
    assert.match(ver.emit[0].m.msg, /v99/);
    assert.equal(core.handle(a, { t: 'nonsense' }, T0).emit.length, 0, 'unknown frames are ignored for forward-compat');
});

test('video only flows host → watchers, and nobody else', () => {
    const core = new RoomCore('test');
    const a = open(core, 'Mario', { ready: true });
    const b = open(core, 'Luigi', { ready: true });
    const c = open(core, 'Peach', { ready: true });
    core.handle(b, { t: 'watch', on: true }, T0);
    assert.deepEqual(core.targetsForBinary(a, 40_000).to, [b], 'watching is opt-in per viewer');
    assert.deepEqual(core.targetsForBinary(b, 40_000).to, [], 'a viewer\'s own frame is never relayed');
    core.handle(c, { t: 'watch', on: true }, T0);
    assert.deepEqual(core.targetsForBinary(a, 600_000).to, [], `${ROOM_DEFAULTS.maxFrameBytes / 1024} KiB ceiling on a frame`);
    core.targetsForBinary(a, 40_000);
    core.handle(a, { t: 'state', s: {} }, T0);
    assert.equal(core.drops, 0, 'a drop counter only moves when a frame had nowhere to go');
});

test('snapshot → restore rebuilds a room after the isolate is evicted', () => {
    const core = new RoomCore('dc:1234');
    const a = open(core, 'Mario', { ready: true, id: '111', av: 'hash', plat: 'mobile' });
    const b = open(core, 'Luigi', { ready: true });
    core.handle(a, { t: 'state', s: { mode: 'democracy', opts: { windowMs: 400 } } }, T0);
    core.handle(b, { t: 'watch', on: true }, T0);
    core.handle(a, { t: 'vote', kind: 'mode', value: 'potato' }, T0);

    const snap = JSON.parse(JSON.stringify(core.snapshot()));
    const woken = new RoomCore('junk').restore(snap);
    assert.equal(woken.key, 'dc1234', 'the key comes from the snapshot, not the constructor guess');
    assert.deepEqual(woken.public().map((p) => [p.name, p.host, p.watching, p.plat]),
        [['Mario', true, false, 'mobile'], ['Luigi', false, true, 'desktop']]);
    assert.equal(woken.state.mode, 'democracy', 'the mode survives eviction');
    assert.equal(woken.state.opts.windowMs, 400);
    assert.equal(woken.vote.value, 'potato', 'an open ballot survives too');
    assert.equal(woken.vote.kind, 'mode');
    assert.ok(woken.vote.yes instanceof Set, 'Sets are rebuilt from their snapshot arrays');
    assert.equal(woken.handle(b, { t: 'in', s: 1, f: 9 }, T0 + 1).emit[0].to, a,
        'and the woken room still routes to the same host');
});

test('dead sockets are named, not guessed', () => {
    const core = new RoomCore('test');
    const a = open(core, 'Mario', { ready: true });
    const b = open(core, 'Luigi', { ready: true });
    core.handle(a, { t: 'in', s: 0, f: 1 }, T0);
    core.handle(b, { t: 'in', s: 0, f: 1 }, T0 + ROOM_DEFAULTS.voteMs);
    assert.deepEqual(core.sweep(T0 + 79_000), [], '80 s of silence is the line');
    assert.deepEqual(core.sweep(T0 + 89_000), [a, b], 'both sides of the star go quiet together when a room is abandoned');
});
