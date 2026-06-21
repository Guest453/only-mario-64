// SM64 AI Player — Node.js server
// Serves the game with proper headers for WASM, CORS, and other assets.
// Usage: node server.js  (then open http://localhost:3823)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3823;
const ROOT = __dirname;

const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.wasm': 'application/wasm',           // critical — browsers gate WASM on correct MIME
    '.ttf':  'font/ttf',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.json': 'application/json',
    '.md':   'text/markdown',
    '.txt':  'text/plain',
};

function mimeFor(file) {
    const ext = path.extname(file).toLowerCase();
    return MIME[ext] || 'application/octet-stream';
}

const server = http.createServer((req, res) => {
    // decode url and strip query string
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') url = '/index.html';

    // security: prevent directory traversal
    const target = path.normalize(path.join(ROOT, url));
    if (!target.startsWith(ROOT)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(target, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Server error');
            }
            return;
        }

        const headers = {
            'Content-Type': mimeFor(target),
            // CORS — allow the page to work if opened from anywhere
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        };

        // COOP/COEP headers required for SharedArrayBuffer (used by Emscripten pthread builds)
        // If the game uses threads, these are mandatory. If not, they are harmless.
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp';

        // Cache static assets for 1h (WASM/JS/CSS don't change often)
        headers['Cache-Control'] = 'public, max-age=3600';

        res.writeHead(200, headers);
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`🍄 SM64 AI Player server running at http://localhost:${PORT}`);
    console.log(`   Serving from: ${ROOT}`);
    console.log(`   Press Ctrl+C to stop`);
});
