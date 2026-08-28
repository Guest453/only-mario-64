// SM64 AI Player — Node.js server
// Serves the game with proper headers for WASM, CORS, and other assets.
// Usage: node server.js  (then open http://localhost:3823)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3823;
const ROOT = __dirname;
const USE_COOP = process.env.SM64_COOP === '1';

const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.wasm': 'application/wasm',
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
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        });
        res.end();
        return;
    }

    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') url = '/index.html';

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
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Cross-Origin-Resource-Policy': 'cross-origin',
        };

        // COOP/COEP break Discord iframes. Opt-in with SM64_COOP=1 for pthreads.
        if (USE_COOP) {
            headers['Cross-Origin-Opener-Policy'] = 'same-origin';
            headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
        }

        const ext = path.extname(target).toLowerCase();
        headers['Cache-Control'] = ext === '.html' ? 'no-cache' : 'public, max-age=3600';

        res.writeHead(200, headers);
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🍄 SM64 AI Player server running at http://0.0.0.0:${PORT}`);
    console.log(`   Serving from: ${ROOT}`);
    console.log(`   COOP/COEP: ${USE_COOP ? 'on' : 'off (Discord/iframe friendly)'}`);
    console.log(`   Press Ctrl+C to stop`);
});
