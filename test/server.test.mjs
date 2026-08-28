// The one-process deployment — `node server.js` — has to serve the site AND
// answer the relay's routes on the same origin, because that same-origin shape is
// what makes a relative /ws work through Discord's proxy. These checks are dumb on
// purpose: they are the smoke test that catches "the app loads but never connects".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wsClient } from './ws-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const get = (port, urlPath, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => body += d);
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
    req.end();                      // http.request, unlike http.get, does not
});

async function withServer(fn) {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', QUIET: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const port = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`server never booted: ${out}`)), 8000);
        child.stdout.on('data', (d) => {
            out += d.toString();
            const m = out.match(/sm64-mp on https?:\/\/[\d.]+:(\d+)/);
            if (m) { clearTimeout(t); resolve(Number(m[1])); }
        });
        child.stderr.on('data', (d) => { out += d.toString(); });
        child.on('exit', (c) => { clearTimeout(t); reject(new Error(`server exited ${c}: ${out}`)); });
    });
    try { await fn(port); } finally {
        child.kill('SIGTERM');
        await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 1500))]);
    }
}

test('the static+relay server answers both halves on one origin', async (t) => {
    await withServer(async (port) => {
        t.diagnostic(`server on :${port}`);

        const page = await get(port, '/');
        assert.equal(page.status, 200);
        assert.match(page.type, /text\/html/);
        assert.match(page.body, /id="canvas"/, 'the game shell is served');
        // The page must boot the module app, which is what handshakes with the SDK.
        assert.match(page.body, /<script[^>]+type="module"[^>]+app\.js/, 'module entry point is wired');
        const app = await get(port, '/app.js');
        assert.match(app.body, /from '\.\/src\/discord\.js'/, 'app imports the Discord layer');
        const dl = await get(port, '/src/discord.js');
        assert.match(dl.body, /discord-embedded-sdk\.js/, 'which imports the vendored SDK bundle');

        for (const p of ['/status', '/relay/status', '/api/status']) {
            const r = await get(port, p);
            assert.equal(r.status, 200, `${p} answers`);
            assert.equal(JSON.parse(r.body).ok, true, `${p} is the relay`);
        }

        // The module graph has to be fetchable as real JS: a wrong MIME here and
        // the import() of the vendored SDK fails only inside Discord.
        // HEAD for these: sm64.wasm is 16 MB and the point is the content type.
        for (const [p, type] of [['/app.js', /javascript/], ['/src/discord.js', /javascript/],
            ['/lib/discord-embedded-sdk.js', /javascript/], ['/styles.css', /text\/css/],
            ['/sm64.js', /javascript/], ['/sm64.wasm', /application\/wasm/]]) {
            const r = await get(port, p, 'HEAD');
            assert.equal(r.status, 200, `${p} exists`);
            assert.match(r.type, type, `${p} is ${type}`);
        }

        // …and the WebSocket lives on the same origin, under either path.
        for (const p of ['/ws', '/relay/ws']) {
            const c = wsClient({ port, path: `${p}?room=smoke&name=Sokoke&ready=1` });
            const w = await c.join();
            assert.equal(w.room, 'smoke', `${p} joined the room`);
            assert.equal(w.host, w.you, `${p} elected us host`);
            c.close();
        }

        const missing = await get(port, '/nope-definitely-not-here');
        assert.equal(missing.status, 404, 'unknown paths still 404');
    });
});
