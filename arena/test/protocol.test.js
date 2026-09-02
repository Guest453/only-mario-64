// Protocol + controller-merge tests for the arena relay.
//
// Each run spawns its OWN relay on its own port and kills it afterwards.
// That is not ceremony: the arena is deliberately ONE global session that keeps
// its mode, its open vote and its vote cooldown for the life of the process, so
// consecutive runs against a shared relay contaminate each other. The first
// version of this file reused a long-lived server and scored 16/16, then 10/16,
// then 8/16 on identical code — run 1 left mode=democracy and a cooldown that
// made run 2's vote silently never open.
//
//   node arena/test/protocol.test.js

'use strict';
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

const PORT = 8099 + Math.floor(Math.random() * 300);
const TOKEN = 'testtoken123';
const URL = `ws://127.0.0.1:${PORT}`;

const results = [];
const ok = (name, cond, detail = '') => results.push([cond, name, detail]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
    return new Promise((res) => {
        const s = net.connect(port, '127.0.0.1');
        s.on('connect', () => { s.destroy(); res(true); });
        s.on('error', () => res(false));
    });
}

function viewer(name, discordId) {
    const ws = new WebSocket(URL + '/ws');
    ws.held = null; ws.welcomed = false; ws.mode = null; ws.vote = null;
    ws.on('message', (d, bin) => {
        if (bin) return;
        const m = JSON.parse(d.toString());
        if (m.t === 'welcome') { ws.welcomed = true; ws.mode = m.mode; }
        if (m.t === 'held') ws.held = m.keys;
        if (m.t === 'mode') ws.mode = m.mode;
        if (m.t === 'vote') ws.vote = m;
        if (m.t === 'chat') ws.lastChat = m;
    });
    return new Promise((res) => ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', name, discordId }));
        res(ws);
    }));
}

(async () => {
    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        // ARENA_ALLOW_GUEST lets the suite exercise the merge/vote protocol
        // without standing up a fake Discord. The gate itself is covered by its
        // own server below, started WITHOUT this flag.
        env: { ...process.env, ARENA_PORT: String(PORT), ARENA_HOST_TOKEN: TOKEN, ARENA_BIND: '127.0.0.1', ARENA_ALLOW_GUEST: '1' },
        stdio: 'ignore',
    });
    const stop = () => { try { server.kill('SIGTERM'); } catch {} };
    process.on('exit', stop);

    for (let i = 0; i < 100; i++) { if (await portOpen(PORT)) break; await wait(50); }

    try {
        // ── host authentication ────────────────────────────────────────────
        const bad = new WebSocket(URL + '/host?token=wrong');
        const badRes = await new Promise((r) => {
            bad.on('open', () => r('open')); bad.on('error', () => r('rejected')); bad.on('close', () => r('rejected'));
        });
        ok('host socket rejects a wrong token', badRes === 'rejected', badRes);

        const host = new WebSocket(URL + '/host?token=' + TOKEN);
        host.inputs = [];
        host.on('message', (d) => {
            const m = JSON.parse(d.toString());
            if (m.t === 'input') host.inputs.push(m.keys.slice().sort().join(','));
        });
        ok('host socket accepts the correct token',
            await new Promise((r) => { host.on('open', () => r('open')); host.on('error', () => r('err')); }) === 'open');

        const a = await viewer('alice', '111111111111111111');
        const b = await viewer('bob', '222222222222222222');
        await wait(200);
        ok('viewers receive welcome', a.welcomed && b.welcomed);
        ok('a fresh arena starts in anarchy', a.mode === 'anarchy', String(a.mode));

        // ── anarchy = union ────────────────────────────────────────────────
        a.send(JSON.stringify({ t: 'input', keys: ['ArrowUp'] }));
        await wait(250);
        ok('anarchy: one viewer pressing moves Mario', (a.held || []).includes('ArrowUp'), JSON.stringify(a.held));

        b.send(JSON.stringify({ t: 'input', keys: ['KeyX'] }));
        await wait(250);
        ok('anarchy: two viewers UNION into one controller',
            (a.held || []).slice().sort().join(',') === 'ArrowUp,KeyX', JSON.stringify(a.held));

        // ── the key allowlist ──────────────────────────────────────────────
        a.send(JSON.stringify({ t: 'input', keys: ['KeyQ', 'Escape', 'F12', 'ArrowUp'] }));
        await wait(250);
        ok('junk keys are dropped, valid ones survive',
            (a.held || []).slice().sort().join(',') === 'ArrowUp,KeyX', JSON.stringify(a.held));

        ok('the merged controller reaches the host',
            host.inputs.some((k) => k.includes('ArrowUp')), JSON.stringify(host.inputs.slice(-3)));

        a.send(JSON.stringify({ t: 'input', keys: [] }));
        b.send(JSON.stringify({ t: 'input', keys: [] }));
        await wait(300);
        ok('releasing clears the controller', (a.held || []).length === 0, JSON.stringify(a.held));

        // ── identity is the SERVER's, never the client's ───────────────────
        // These viewers said hello as "alice" and "bob". The server must ignore
        // that entirely and use the session name — otherwise anyone could wear
        // anyone else's name, and (before this was fixed) claim the admin id and
        // be handed the admin star.
        b.send(JSON.stringify({ t: 'chat', text: 'hello' }));
        await wait(250);
        ok('chat uses the session name, ignoring the client-claimed one',
            a.lastChat && a.lastChat.from === 'Guest' && a.lastChat.from !== 'bob',
            JSON.stringify(a.lastChat && a.lastChat.from));

        b.send(JSON.stringify({ t: 'hello', name: 'TotallyTheAdmin', discordId: '1246945967102623755' }));
        b.send(JSON.stringify({ t: 'chat', text: 'am i admin' }));
        await wait(300);
        ok('a client cannot claim the admin id to get admin',
            a.lastChat && a.lastChat.admin !== true && a.lastChat.from !== 'TotallyTheAdmin',
            JSON.stringify(a.lastChat));

        // ── the mode vote ──────────────────────────────────────────────────
        a.send(JSON.stringify({ t: 'modevote', mode: 'democracy' }));
        await wait(250);
        ok('proposing a mode change opens a vote', a.vote && a.vote.open === true);
        ok('the proposer counts as a yes', a.vote && a.vote.yes.length === 1);
        ok('a 2-person room needs BOTH votes', a.vote && a.vote.needed === 2, a.vote && String(a.vote.needed));
        ok('one vote alone does not flip the mode', a.mode !== 'democracy', String(a.mode));
        ok('the vote names the voter from the session',
            a.vote && a.vote.yes[0] && a.vote.yes[0].name === 'Guest',
            JSON.stringify(a.vote && a.vote.yes[0]));

        b.send(JSON.stringify({ t: 'votecast', yes: true }));
        await wait(300);
        ok('a passing vote flips the mode', a.mode === 'democracy', String(a.mode));

        // ── democracy = strict majority, tallied per unique voter ──────────
        a.send(JSON.stringify({ t: 'input', keys: ['ArrowLeft'] }));
        b.send(JSON.stringify({ t: 'input', keys: ['ArrowLeft'] }));
        await wait(900);
        ok('democracy: a unanimous vote passes', (a.held || []).includes('ArrowLeft'), JSON.stringify(a.held));

        a.send(JSON.stringify({ t: 'input', keys: ['ArrowLeft'] }));
        b.send(JSON.stringify({ t: 'input', keys: ['ArrowRight'] }));
        await wait(900);
        const split = a.held || [];
        ok('democracy: a 1-1 split passes NEITHER direction',
            !(split.includes('ArrowLeft') && split.includes('ArrowRight')), JSON.stringify(split));

        // ── robustness ─────────────────────────────────────────────────────
        a.send(JSON.stringify({ t: 'chat', text: 'x'.repeat(50000) }));
        await wait(200);
        ok('an oversized frame does not kill the connection', a.readyState === 1);

        // ── the auth gate ──────────────────────────────────────────────────
        // A second relay with guest access OFF: no session, no socket.
        const GATE_PORT = PORT + 1;
        const gated = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: { ...process.env, ARENA_PORT: String(GATE_PORT), ARENA_HOST_TOKEN: TOKEN, ARENA_BIND: '127.0.0.1' },
            stdio: 'ignore',
        });
        for (let i = 0; i < 100; i++) { if (await portOpen(GATE_PORT)) break; await wait(50); }

        const anon = new WebSocket(`ws://127.0.0.1:${GATE_PORT}/ws`);
        const anonRes = await new Promise((r) => {
            anon.on('open', () => r('open'));
            anon.on('error', () => r('refused'));
            anon.on('close', () => r('refused'));
        });
        ok('a viewer with NO discord session is refused', anonRes === 'refused', anonRes);

        const fake = new WebSocket(`ws://127.0.0.1:${GATE_PORT}/ws?s=deadbeef`);
        const fakeRes = await new Promise((r) => {
            fake.on('open', () => r('open'));
            fake.on('error', () => r('refused'));
            fake.on('close', () => r('refused'));
        });
        ok('a forged session id is refused', fakeRes === 'refused', fakeRes);
        try { gated.kill('SIGTERM'); } catch {}
    } catch (err) {
        ok('suite ran without throwing', false, err.message);
    }

    stop();
    console.log('');
    for (const [c, n, d] of results) console.log(`${c ? ' PASS' : ' FAIL'}  ${n}${c ? '' : '   <-- got: ' + d}`);
    const failed = results.filter((r) => !r[0]).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
