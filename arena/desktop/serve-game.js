// Loopback-only static server for the in-browser SM64 build.
//
// Serves the minimal page plus sm64.js / sm64.wasm to the container's own
// Chromium and nothing else. Never proxied: the 16MB wasm is for the container,
// viewers get video.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.GAME_STATIC_PORT || 8094);
const ROOTS = [__dirname, '/app'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.wasm': 'application/wasm' };

http.createServer((req, res) => {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/') url = '/sm64.html';
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
}).listen(PORT, '127.0.0.1', () => console.log(`[game-static] 127.0.0.1:${PORT} serving sm64.html + wasm`));
