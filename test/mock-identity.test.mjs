// ============================================================
// Identity test: the Discord data path, exercised without Discord.
//
// `?mock=1` swaps in src/discord-mock.js — a stand-in client that speaks the same
// payloads as the real SDK. This asserts the part of the brief that says "for
// usernames and EVERYTHING, learn the Discord SDK": names, avatars, the roster,
// mic state, layout mode and presence all flow from the SDK layer, and the local
// nickname field is never consulted once the SDK has answered.
//
// It also pins the degradation path: with no relay listening, the Activity must
// still boot into a playable solo copy and say so.
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootBrowser, waitFor, jsdomAvailable } from './browser-harness.mjs';

test('Discord identity drives the UI (?mock=1)',
    { skip: jsdomAvailable ? false : 'npm i -D jsdom' }, async (t) => {
        // No relay on this port (0 ⇒ the harness installs no WebSocket shim).
        const br = await bootBrowser({
            // port: 1 = a closed port, so the relay is genuinely unreachable and we
            // also prove identity survives a dead network. mockscript=0 keeps the
            // roster deterministic.
            room: 'mockroom', port: 1, extra: '&mock=1&presence=1&mockscript=0',
            nick: null, enter: false,
        });
        const $ = (id) => br.document.getElementById(id);
        try {
            // 1 · the SDK answered with a user, so the name/room gate never appears.
            await waitFor(() => !$('app').hidden, 3000, 'boot went straight into the session');
            assert.equal($('lobby').hidden, true, 'no lobby form when Discord supplies identity');

            // 2 · the room is the activity instance id, verbatim.
            await waitFor(() => /123456789012345678/.test($('chip-room').textContent), 3000, 'instance id as room key');

            // 3 · roster = SDK participants; people in the Activity but not in the
            // game are shown, greyed, and labelled — presence is not authorship.
            await waitFor(() => $('roster').querySelectorAll('li').length >= 3, 3000, 'roster from participants');
            // Not an exact-array check: the participant list is Discord's, and a
            // late join would legitimately add a row mid-test.
            const names = [...$('roster').querySelectorAll('.pl-name > span')].map((n) => n.textContent);
            assert.deepEqual([...names].sort(), ['Mario', 'Toadsworthette', 'coolpope64#0001'],
                'global_name beats username; a legacy discriminator is kept, an invalid #0000 is not');
            assert.ok($('roster').querySelector('li.dc-only'), 'activity-only participants marked');
            assert.match($('roster').textContent, /in the activity, not in this game/);

            // 4 · avatars are built from (id, hash) against the CDN host in READY.
            const img = $('roster').querySelector('img');
            assert.match(img.src, /^https:\/\/cdn\.discordapp\.com\/avatars\/\d+\/[0-9a-f]+\.png\?size=\d+$/, `avatar url (${img.src})`);

            // 5 · voice state arrives as events and lands in the rows.
            br.win.__mock.speaking(['868906312801234944'], true);
            await waitFor(() => $('roster').querySelectorAll('.pl-meta .talking').length >= 1, 2500, 'mic indicator');

            // 6 · layout mode changes the chrome (PIP/GRID are tiny windows).
            br.win.__mock.layout('PIP');
            assert.ok(br.document.documentElement.classList.contains('layout-pip'), 'PIP class applied');
            br.win.__mock.layout('FOCUSED');
            assert.ok(!br.document.documentElement.classList.contains('layout-pip'), 'FOCUSED clears it');

            // 7 · presence goes through setActivity, and only when forced/authed.
            const seen = [];
            br.win.__mock.commands.setActivity = (o) => { seen.push(o); return Promise.resolve({}); };
            br.win.__sm64.schedulePresence();
            await waitFor(() => seen.length > 0, 4000, 'setActivity call');
            t.diagnostic(`setActivity ${JSON.stringify(seen.at(-1))}`);
            assert.match(seen.at(-1).details, /Solo/);
            assert.equal(seen.at(-1).party.size[1], 8, 'party of up to 8');

            // 8 · the fallback that makes an Activity safe to ship: no relay, no crash.
            const st = br.win.__sm64.state;
            assert.notEqual(st.net?.status, 'online', 'relay is unreachable here');
            await waitFor(() => /own copy/.test($('banner-text').textContent), 4000, 'banner explains the fallback');
            assert.equal(st.shared, false, 'pad is not shared, so keys go to the local engine');
            assert.equal(st.local.enabled, false, 'and the shield is down');
        } finally {
            br.dom.window.close();
        }
    });
