// ============================================================
// End-to-end DOM test: a real (jsdom) browser running the REAL app modules,
// a REAL relay process, and a second player simulated at the wire level.
//
// What this proves, and why it is worth the scaffolding:
//   • the module graph boots in a DOM without throwing,
//   • the lobby gate → Enter → relay join path works,
//   • the first engine-loaded player becomes host,
//   • a mode chosen in the UI reaches the relay and back into room state,
//   • a remote player's input mask is turned into phantom key events at the
//     canvas — the single most load-bearing trick in this Activity,
//   • chat round-trips and is rendered inert, and the roster follows joins
//     and leaves.
//
// Requires jsdom (soft dev dependency); skips itself on a bare checkout.
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../relay/server.js';
import { wsClient } from './ws-client.mjs';
import { bootBrowser, waitFor, jsdomAvailable } from './browser-harness.mjs';

test('shared session: join → host → mode → remote input → phantom keys',
    { skip: jsdomAvailable ? false : 'npm i -D jsdom' }, async (t) => {
        const relay = createRelay({ log: false });
        await new Promise((r) => relay.server.listen(0, '127.0.0.1', r));
        const port = relay.server.address().port;
        const br = await bootBrowser({ room: 'e2e', port, nick: 'Host' });
        try {
            // 1 · the lobby gate handed off to the session UI
            assert.equal(br.document.getElementById('lobby').hidden, true, 'gate closes after Enter');
            assert.equal(br.document.getElementById('app').hidden, false, 'shell is visible');
            await waitFor(() => [...relay.rooms.get('e2e').players.values()][0]?.ready, 4000, 'relay marks the player ready');
            assert.equal(br.document.getElementById('chip-net').textContent.includes('live'), true, 'relay chip says live');

            // 2 · host election: the lone engine-loaded player hosts, and `in`
            // traffic from peers is delivered to exactly that socket.
            const room = relay.rooms.get('e2e');
            const players = [...room.players.values()];
            assert.equal(room.host, players[0].cid, 'relay elected the browser as host');
            assert.equal(players[0].ready, true, 'because its engine signalled ready');
            assert.match(br.document.getElementById('banner-text').textContent, /hosting/, 'the HUD says so');

            // 3 · a second player appears in Discord terms first (roster row)
            const peer = wsClient({ port, path: '/ws?room=e2e&name=Peach&ready=1' });
            const pw = await peer.join();
            assert.equal(pw.players.length, 2, 'relay sees both');
            await waitFor(() => br.document.querySelectorAll('#roster li').length === 2, 2000, 'roster renders both rows');
            assert.match(br.document.getElementById('roster').textContent, /Peach/, 'names come from the wire, rendered as text');

            // 4 · the host picks MASH in the UI; it must land in room state
            const mashBtn = [...br.document.querySelectorAll('#modes .mode')].find((b) => /Mash/.test(b.textContent));
            assert.ok(mashBtn, 'mode chips are rendered');
            mashBtn.dispatchEvent(new br.win.Event('click', { bubbles: true }));
            await waitFor(() => relay.rooms.get('e2e').state.mode === 'mash', 2000, 'relay stored the mode');

            // 5 · the peer presses → phantom keydown at the engine
            peer.send({ t: 'in', s: 1 | 16, f: 1 });         // UP + A
            await waitFor(() => br.keys.some(([d, c]) => d === 'down' && c === 'ArrowUp'), 2500, 'ArrowUp injected');
            await waitFor(() => br.keys.some(([d, c]) => d === 'down' && c === 'KeyX'), 2500, 'KeyX injected');
            t.diagnostic(`injected so far: ${br.keys.map((k) => k.slice(0, 2).join(':')).join(' ')}`);

            // 6 · release propagates as keyup (a stuck key is worse than a lost one)
            peer.send({ t: 'in', s: 0, f: 2 });
            await waitFor(() => br.keys.some(([d, c]) => d === 'up' && c === 'ArrowUp'), 2500, 'ArrowUp released');
            await waitFor(() => br.keys.some(([d, c]) => d === 'up' && c === 'KeyX'), 2500, 'KeyX released');

            // 7 · chat from the peer lands in the log as text, not markup
            peer.send({ t: 'chat', m: '<img src=x onerror=alert(1)>' });
            await waitFor(() => br.document.querySelectorAll('#chat-log .msg').length >= 1, 2000, 'chat row');
            const last = [...br.document.querySelectorAll('#chat-log .msg')].pop();
            assert.equal(last.querySelector('img'), null, 'no HTML from remote strings');
            assert.match(last.textContent, /onerror/);

            // 8 · typing in chat must never reach the engine. This matters more
            // here than in a normal page: the pad is shared, so an accidental
            // keypress from the chat box would move Mario for the whole room.
            const input = br.document.getElementById('chat-input');
            input.focus();
            const before = br.keys.length;
            input.dispatchEvent(new br.win.KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
            assert.equal(br.keys.length, before, 'chat keystrokes stay out of the game');

            // 9 · the peer leaves → roster and count follow without a reload
            peer.close();
            await waitFor(() => br.document.querySelectorAll('#roster li').length === 1, 3000, 'roster shrinks');
            assert.equal(br.document.getElementById('chip-players').textContent.trim(), '👥 1');
        } finally {
            br.dom.window.close();
            await Promise.race([relay.close().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
            relay.rooms.clear();
        }
    });
