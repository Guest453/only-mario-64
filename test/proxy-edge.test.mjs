// ============================================================
// The deployment shape that actually matters: the relay behind an HTTPS edge
// proxy that keeps a path prefix (that is exactly what Discord's activity proxy
// plus a VPS/PaaS front door looks like — `wss://<app>.discordsays.com/relay/ws`
// arrives as `/relay/ws?room=…`, and hosts like exe.dev forward one port with
// the path intact).
//
// So this test stands up a small edge in front of the real relay and drives the
// REAL app through it: the client must discover the room, get elected host, and
// turn a peer's buttons into phantom keys at the canvas — with a proxy in the
// middle that rewrites the URL. It also checks the two things operators always
// reach for: /status through the prefix, and a WS upgrade through the same hop.
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createRelay } from '../relay/server.js';
import { wsClient } from './ws-client.mjs';
import { bootBrowser, waitFor, jsdomAvailable } from './browser-harness.mjs';

/** Strip a leading `/relay` and forward, tunneling upgrades byte-for-byte. */
function edgeProxy(upstreamPort) {
    const AUTHORITY = `127.0.0.1:${upstreamPort}`;   // the backend's Host, not the public one
    const srv = http.createServer((req, res) => {
        const path = req.url.replace(/^\/relay/, '') || '/';
        const up = http.request(
            { port: upstreamPort, host: '127.0.0.1', path, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } },
            (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); },
        );
        up.on('error', () => res.writeHead(502).end('edge: backend down'));
        req.pipe(up);
    });
    srv.on('upgrade', (req, client) => {
        const sock = net.connect(upstreamPort, '127.0.0.1', () => {
            const head = [`GET ${req.url.replace(/^\/relay/, '') || '/'} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const k = req.rawHeaders[i];
                if (/^(host|connection|upgrade)$/i.test(k)) continue;
                head.push(`${k}: ${req.rawHeaders[i + 1]}`);
            }
            head.push('Connection: Upgrade', 'Upgrade: websocket', `Host: ${AUTHORITY}`);
            const request = head.join('\r\n') + '\r\n\r\n';     // blank line ends it
            // Directions matter here: `client` is the browser-side socket and
            // `sock` is the backend. Write the rewritten request upstream, then
            // pump both ways — a byte-for-byte tunnel, which is all a WebSocket
            // proxy has to be.
            sock.write(request);
            sock.pipe(client);
            client.pipe(sock);
            client.on('error', () => sock.destroy());
            sock.on('error', () => client.destroy());
        });
        sock.on('error', () => client.destroy());
    });
    return srv;
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const get = (port, path) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', (d) => b += d);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
});

test('the relay works behind a prefix-preserving HTTPS edge',
    { skip: jsdomAvailable ? false : 'npm i -D jsdom' }, async (t) => {
    const relay = createRelay({ log: false });
    const relayPort = await listen(relay.server);
    const edge = edgeProxy(relayPort);
    const edgePort = await listen(edge);
    const br = await bootBrowser({
        room: 'edge', port: relayPort,
        extra: `&relay=ws://127.0.0.1:${edgePort}/relay/ws`,   // ← the app is told to use the proxy
        nick: 'Host',
    });
    let peer;
    try {
        t.diagnostic(`app dialed ${br.win.__sm64.relayUrl()}`);
        assert.match(br.win.__sm64.relayUrl(), /\/relay\/ws\?room=edge$/, 'override wins and the room is carried');

        // 1 · even the operator endpoint answers through the prefix
        const status = await get(edgePort, '/relay/status');
        assert.equal(status.status, 200, '/status reachable via /relay');
        assert.equal(JSON.parse(status.body).ok, true);

        // 2 · the browser got through the proxy and into a room
        await waitFor(() => [...relay.rooms.get('edge').players.values()].length >= 1, 5000, 'browser joined through the edge');
        await waitFor(() => [...relay.rooms.get('edge').players.values()][0]?.ready, 5000, 'and is ready');
        assert.equal(br.document.getElementById('chip-net').textContent.includes('live'), true, 'chip says live through the proxy');

        // 3 · a second player joins the SAME room, also through the edge
        peer = wsClient({ port: edgePort, path: '/relay/ws?room=edge&name=Peach&ready=1' });
        const w = await peer.join();
        assert.equal(w.room, 'edge', 'same room through the prefix');
        assert.equal(w.players.length, 2, 'proxy did not split the room');
        assert.equal(w.host, [...relay.rooms.get('edge').players.values()][0].cid, 'the browser still hosts');

        await waitFor(() => br.document.querySelectorAll('#roster li').length === 2, 3000, 'roster through the edge');

        // 4 · MASH first: in Solo the host deliberately ignores other people's
        // buttons, so this also proves the mode rule survives the proxy hop.
        const mash = [...br.document.querySelectorAll('#modes .mode')].find((b) => /Mash/.test(b.textContent));
        mash.dispatchEvent(new br.win.Event('click', { bubbles: true }));
        const seen = await peer.until((m) => m.t === 'roster' && m.state?.mode === 'mash', 4000);
        assert.equal(seen.players.length, 2, 'both players see the new mode');

        // 5 · the whole point: a remote press, via the proxy, moves local Mario
        peer.send({ t: 'in', s: 1 | 16, f: 7 });
        await waitFor(() => br.keys.some(([d, c]) => d === 'down' && c === 'ArrowUp'), 3000, 'phantom ArrowUp through the edge');
        await waitFor(() => br.keys.some(([d, c]) => d === 'down' && c === 'KeyX'), 3000, 'phantom A through the edge');
        peer.send({ t: 'in', s: 0, f: 8 });
        await waitFor(() => br.keys.some(([d, c]) => d === 'up' && c === 'ArrowUp'), 3000, 'release through the edge');

    } finally {
        if (peer) peer.close();
        br.dom.window.close();
        edge.close();
        await Promise.race([relay.close().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
        relay.rooms.clear();
    }
});
