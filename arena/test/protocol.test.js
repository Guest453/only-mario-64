// Protocol + controller-merge tests for the arena relay.
//
// Each run spawns its OWN relay on its own port and kills it afterwards.
// That is not ceremony: the arena is deliberately ONE global session that keeps
// state for the life of the process, so consecutive runs against a shared relay
// contaminate each other. An earlier version reused a long-lived server and
// scored 16/16, then 10/16, then 8/16 on identical code.
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
    ws.held = null; ws.welcomed = false;
    ws.on('message', (d, bin) => {
        if (bin) return;
        const m = JSON.parse(d.toString());
        if (m.t === 'welcome') ws.welcomed = true;
        if (m.t === 'held') ws.held = m.keys;
        if (m.t === 'chat') ws.lastChat = m;
    });
    return new Promise((res) => ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', name, discordId }));
        res(ws);
    }));
}

(async () => {
    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        // ARENA_ALLOW_GUEST lets the suite exercise the merge protocol
        // without standing up a fake Discord. The gate itself is covered by its
        // own server below, started WITHOUT this flag.
        env: { ...process.env, ARENA_PORT: String(PORT), ARENA_HOST_TOKEN: TOKEN, ARENA_BIND: '127.0.0.1', ARENA_ALLOW_GUEST: '1', ARENA_ENTER_COOLDOWN_MS: '1000' },
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
        // ── the merge is a union: any press by anyone counts ───────────────
        a.send(JSON.stringify({ t: 'input', keys: ['ArrowUp'] }));
        await wait(250);
        ok('one viewer pressing moves Mario', (a.held || []).includes('ArrowUp'), JSON.stringify(a.held));

        b.send(JSON.stringify({ t: 'input', keys: ['KeyX'] }));
        await wait(250);
        ok('two viewers UNION into one controller',
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

        // ── Start-spam throttle ────────────────────────────────────────────
        // Under a union merge one person mashing Start strobes the pause menu
        // for everyone at 30Hz, so the limit is on the MERGED controller, not
        // per viewer — a client that ignores its own cooldown must still lose.
        host.inputs.length = 0;
        a.send(JSON.stringify({ t: 'input', keys: ['Enter'] }));
        await wait(200);
        const firstStart = host.inputs.some((k) => k.includes('Enter'));
        ok('the first Start press gets through', firstStart, JSON.stringify(host.inputs));

        a.send(JSON.stringify({ t: 'input', keys: [] }));
        await wait(120);
        host.inputs.length = 0;
        a.send(JSON.stringify({ t: 'input', keys: ['Enter'] }));   // re-press immediately
        await wait(200);
        ok('an immediate re-press is swallowed',
            !host.inputs.some((k) => k.includes('Enter')), JSON.stringify(host.inputs));

        a.send(JSON.stringify({ t: 'input', keys: [] }));
        await wait(1200);  // longer than the 1000ms test cooldown
        host.inputs.length = 0;
        a.send(JSON.stringify({ t: 'input', keys: ['Enter'] }));
        await wait(200);
        ok('Start works again after the cooldown',
            host.inputs.some((k) => k.includes('Enter')), JSON.stringify(host.inputs));
        a.send(JSON.stringify({ t: 'input', keys: [] }));
        await wait(150);

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

        // ── the video-stall watchdog ───────────────────────────────────────
        // A host that connects but never sends a frame is the exact production
        // failure: the game crashed, the socket stayed up, and nothing noticed.
        // The relay must ask it to reload.
        const WD_PORT = PORT + 2;
        const wd = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: {
                ...process.env, ARENA_PORT: String(WD_PORT), ARENA_HOST_TOKEN: TOKEN,
                ARENA_BIND: '127.0.0.1', ARENA_ALLOW_GUEST: '1',
                ARENA_STALL_RELOAD_MS: '300', ARENA_STALL_EXIT_MS: '60000',
                ARENA_WATCHDOG_TICK_MS: '100',
            },
            stdio: 'ignore',
        });
        for (let i = 0; i < 100; i++) { if (await portOpen(WD_PORT)) break; await wait(50); }

        const mute = new WebSocket(`ws://127.0.0.1:${WD_PORT}/host?token=${TOKEN}`);
        let gotReload = false;
        mute.on('message', (d) => {
            try { if (JSON.parse(d.toString()).t === 'reload') gotReload = true; } catch {}
        });
        await new Promise((r) => { mute.on('open', r); mute.on('error', r); });
        await wait(1200);   // longer than the 300ms stall threshold
        ok('a silent host gets told to reload', gotReload === true, String(gotReload));
        try { mute.close(); wd.kill('SIGTERM'); } catch {}
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
