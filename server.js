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
    const relay = createRelay({ server, log: process.env.QUIET !== '1' });
    relay.attach(server);
    process.on('SIGTERM', () => relay.close());
}

server.listen(PORT, HOST, () => {
    console.log(`🍄 sm64-mp on http://${HOST}:${PORT}`);
    console.log(`   game:    http://localhost:${PORT}`);
    if (process.env.NO_RELAY !== '1') {
        console.log(`   relay:   ws://localhost:${PORT}/ws?room=lobby  (same origin, so two tabs = two players)`);
        console.log(`   status:  http://localhost:${PORT}/status`);
    }
});
