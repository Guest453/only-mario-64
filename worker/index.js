// ============================================================
// worker/index.js — the relay as a Cloudflare Worker.
//
// Why this file exists: the Node relay in relay/server.js is small, but "small"
// is not "nowhere to run it". This version needs no server at all — `npx
// wrangler deploy` and you have a public wss:// URL, which is the only thing the
// Discord activity proxy requires (it forwards HTTP and WebSockets, nothing else).
//
// All room logic is shared with the Node relay through src/room-core.js, so the
// two backends speak the identical protocol; the tests in test/room-core.test.mjs
// are the rules both must follow.
//
// Routing: one Durable Object per room (single writer, no locks, hibernates when
// idle so an empty party costs nothing).
// ============================================================

import { roomKeyOf } from '../src/room-core.js';

const TEXT = { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
const JSONH = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Any path ending in /ws: the Discord proxy hands over /relay/ws after
        // applying the mapping, a direct dev connection uses /ws.
        if (/\/ws$/.test(url.pathname)) {
            if (!env.ROOMS) return new Response('{"code":"no_do_namespace"}\n', { status: 500, headers: JSONH });
            const key = roomKeyOf(url.searchParams.get('room') || url.searchParams.get('instance_id'));
            // Forward the original request: the DO answers with a 101 whose
            // `webSocket` is streamed back through here to the browser.
            return env.ROOMS.get(env.ROOMS.idFromName(key)).fetch(request);
        }

        if (url.pathname === '/status' || url.pathname === '/relay/status' || url.pathname === '/api/status') {
            return new Response(JSON.stringify({
                ok: true,
                relay: 'sm64-mp@cloudflare',
                time: new Date().toISOString(),
                note: 'rooms live in one Durable Object each; ask a room directly with /status?room=CODE',
            }), { headers: JSONH });
        }

        if (url.pathname === '/' || url.pathname === '/relay') {
            const room = roomKeyOf(url.searchParams.get('room'));
            if (url.searchParams.has('room') && env.ROOMS) {
                return env.ROOMS.get(env.ROOMS.idFromName(room))
                    .fetch(new Request('https://internal/status'));
            }
            return new Response(
                'sm64-mp relay (Cloudflare Worker)\n\n'
                + `WebSocket endpoint: wss://${url.host}/ws?room=CODE\n`
                + 'Room status:            /status?room=CODE\n'
                + 'Inside Discord, map /relay → this host in the developer portal.\n',
                { headers: TEXT },
            );
        }

        return new Response('not found\n', { status: 404, headers: TEXT });
    },
};
