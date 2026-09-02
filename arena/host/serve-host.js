// Internal-only static server for the host page.
//
// Bound to loopback and never proxied by nginx: the 16 MB sm64.wasm and the
// host page exist for the container's own Chromium and nobody else. Viewers get
// video, not the game. Keeping this separate from server.js is what makes that
// guarantee structural rather than a routing accident.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.HOST_STATIC_PORT || 8091);
// Files live in two places: the host page itself, and the game binaries which
// stay at the repo root so the AI-player build keeps working off the same copy.
const ROOTS = [__dirname, path.resolve(__dirname, '..', '..')];

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.ttf': 'font/ttf',
    '.css': 'text/css; charset=utf-8',
};

http.createServer((req, res) => {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/') url = '/host.html';
    const rel = path.normalize(url).replace(/^(\.\.[/\\])+/, '');

    for (const root of ROOTS) {
        const target = path.join(root, rel);
        if (!target.startsWith(root + path.sep)) continue;
        try {
            const data = fs.readFileSync(target);
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
            });
            res.end(data);
            return;
        } catch { /* try the next root */ }
    }
    res.writeHead(404).end('not found');
}).listen(PORT, '127.0.0.1', () => {
    console.log(`[host-static] 127.0.0.1:${PORT} serving host.html + sm64 binaries`);
});
