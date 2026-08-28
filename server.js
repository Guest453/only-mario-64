// ============================================================
// Static file server for the Activity (dev + self-host).
//
// Two things matter here and both bit the previous version of this repo:
//   1. .wasm must be served as application/wasm, and
//   2. COOP/COEP must stay OFF. require-corp breaks Discord's iframe proxying;
//      the engine here is single-threaded, so it doesn't need SharedArrayBuffer.
// ============================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay/server.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3823);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.wasm': 'application/wasm',
    '.ttf': 'font/ttf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

let relay = null;

/** Relay routes that live on this origin too (`/` stays the game itself). */
const RELAY_HTTP = new Set(['/status', '/api/status', '/relay', '/relay/status']);

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        });
        return res.end();
    }
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    // Mounted mode: the relay's own routes answer on the same origin, so one
    // process is enough for a two-tab party and the client can dial a relative
    // /ws (the only shape that survives Discord's proxy).
    if (relay && RELAY_HTTP.has(url) && relay.handleHttp(req, res)) return;
    if (url === '/') url = '/index.html';
    const target = path.normalize(path.join(ROOT, url));
    if (!target.startsWith(ROOT)) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.stat(target, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
            return;
        }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': st.size,
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            // HTML always revalidated; the 16 MB wasm gets a short cache so a
            // GitHub-Pages-backed Activity updates without a hard refresh party.
            'Cache-Control': ext === '.html'
                ? 'no-cache'
                : (ext === '.wasm' ? 'public, max-age=3600, immutable' : 'no-cache'),
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(target).pipe(res);
    });
});

// Mount the multiplayer relay on the SAME origin as the game. Two reasons:
//   • `node server.js` alone gives you working multiplayer (two tabs, one room),
//   • and the client can then use a relative `wss://<host>/ws` URL, which is the
//     only shape that survives Discord's proxy (WebRTC does not).
// Set NO_RELAY=1 to serve the static site only.
if (process.env.NO_RELAY !== '1') {
    relay = createRelay({ server, log: process.env.QUIET !== '1' });
    relay.attach(server);        // idempotent: only one 'upgrade' listener
    // Containers send SIGTERM and then SIGKILL; exiting promptly (after a bounded
    // drain) is what makes a restart clean instead of a stale-task crash.
    const shutdown = (sig) => () => {
        console.log(`\n${sig} — draining`);
        relay.close().finally(() => server.close(() => process.exit(0)));
        setTimeout(() => process.exit(0), 2500).unref?.();
    };
    process.on('SIGTERM', shutdown('SIGTERM'));
    process.on('SIGINT', shutdown('SIGINT'));
}

server.listen(PORT, HOST, () => {
    // Read the socket, not PORT: PORT=0 is a real deployment config (containers,
    // CI), and a banner that says :0 is worse than no banner.
    const port = server.address()?.port || PORT;
    console.log(`🍄 sm64-mp on http://${HOST}:${port}`);
    console.log(`   game:    http://localhost:${port}`);
    if (process.env.NO_RELAY !== '1') {
        console.log(`   relay:   ws://localhost:${port}/ws?room=lobby  (same origin, so two tabs = two players)`);
        console.log(`   status:  http://localhost:${port}/status`);
    }
});
