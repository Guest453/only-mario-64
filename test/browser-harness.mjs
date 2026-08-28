// Shared jsdom harness for the browser-level tests.
//
// There is no headless browser here, and the interesting bugs in this app all
// live in the seam between a real DOM and real sockets (focus, key shielding,
// roster diffing, sanitising) — so: a jsdom window running the real app modules,
// optionally against the real relay, with a WebSocket that forwards through the
// raw-socket client in test/ws-client.mjs.
//
// jsdom is a soft dev dependency (`npm i -D jsdom`). When it is absent,
// `jsdomAvailable` is false and the calling test skips itself, so a bare
// checkout still passes `npm test`.
//
// WARNING: these tests bridge jsdom onto Node's globals, so one jsdom window per
// process, full stop. Node's test runner gives each file its own process.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

let JSDOM = null;
try { ({ JSDOM } = require_('jsdom')); } catch { /* optional */ }

export const jsdomAvailable = !!JSDOM;

/** Poll `fn` until it is truthy (returns its value) or throw after `ms`. */
export async function waitFor(fn, ms = 4000, label = 'condition') {
    const end = Date.now() + ms;
    for (;;) {
        let v = null;
        try { v = fn(); } catch { /* keep polling */ }
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** A WebSocket that talks to the in-process relay through raw sockets. */
function installWebSocketShim(win, port, wsClient) {
    class BridgedWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.binaryType = 'blob';
            this.bufferedAmount = 0;
            this.onopen = this.onmessage = this.onclose = this.onerror = null;
            const parts = new URL(url, 'http://x');
            // Honour the port the app asked for (that is the point of tests that
            // route through a proxy); `port` is only the fallback for relative URLs.
            this._c = wsClient({
                port: Number(parts.port) || port,
                host: parts.hostname || '127.0.0.1',
                path: parts.pathname + parts.search,
            });
            this._c.sock.on('connect', () => {
                this.readyState = 1;
                this.onopen?.({ type: 'open' });
                this._pump();
            });
            // A browser fires `error` then `close` when the socket cannot connect;
            // mirror that so the app's "relay is down" path is the one under test.
            this._c.sock.on('error', () => this.onerror?.({ type: 'error', message: 'connection refused' }));
            this._c.sock.on('close', () => {
                this.readyState = 3;
                this.onclose?.({ code: 1006, type: 'close' });
            });
        }
        async _pump() {
            for (;;) {
                let m;
                try { m = await this._c.next(3600000); } catch { return; }
                if (m === null || m === undefined) return;
                // text frames are already parsed objects; the app re-parses them
                const data = Buffer.isBuffer(m)
                    ? m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength)
                    : (typeof m === 'string' ? m : JSON.stringify(m));
                this.onmessage?.({ data });
            }
        }
        send(data) {
            if (typeof data === 'string') this._c.send(JSON.parse(data));
            else this._c.sendBin(Buffer.from(data));
        }
        close() { this._c.close(); this.readyState = 3; }
    }
    win.WebSocket = BridgedWebSocket;
    Object.defineProperty(globalThis, 'WebSocket', { value: BridgedWebSocket, writable: true, configurable: true });
}

/**
 * Boot the real app in jsdom.
 * @param {object} o room, port for the relay shim, extra query string,
 *   nick (null leaves the lobby gate open unless `enter`), enter = click Join.
 */
export async function bootBrowser({ room = 'test', port = 0, extra = '', nick = 'Tester', enter = true } = {}) {
    const { wsClient } = await import('./ws-client.mjs');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: `http://localhost:${port}/?room=${room}${extra}`,
        pretendToBeVisual: true,
        runScripts: 'outside-only',
    });
    const win = dom.window;

    // Bridge the jsdom globals the modules touch by bare name. Node 22 ships some
    // of these as getter-only globals, so define rather than assign.
    const define = (key, value) => Object.defineProperty(globalThis, key, {
        value, writable: true, configurable: true, enumerable: false,
    });
    for (const key of ['document', 'location', 'navigator', 'localStorage', 'sessionStorage',
        'Image', 'getComputedStyle', 'matchMedia', 'HTMLElement', 'Node', 'requestAnimationFrame',
        'cancelAnimationFrame', 'ResizeObserver', 'devicePixelRatio', 'Blob', 'URL', 'Event',
        'KeyboardEvent', 'CustomEvent', 'MessageEvent', 'innerWidth', 'innerHeight',
        'OffscreenCanvas', 'createImageBitmap']) {
        // NB: `performance` stays Node's own — jsdom's Performance.now re-enters
        // itself when adopted as a global.
        if (!(key in win)) continue;
        const v = win[key];
        define(key, typeof v === 'function'
            && /^(requestAnimationFrame|cancelAnimationFrame|getComputedStyle|matchMedia)$/.test(key) ? v.bind(win) : v);
    }
    define('window', win);
    define('addEventListener', (...a) => win.addEventListener(...a));
    define('removeEventListener', (...a) => win.removeEventListener(...a));
    // getContext() returns null in jsdom; the app has to survive that anyway.
    win.HTMLCanvasElement.prototype.getContext = () => ({
        drawImage() {}, fillRect() {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    });
    win.HTMLCanvasElement.prototype.toBlob = (cb) => cb(null);
    if (port) installWebSocketShim(win, port, wsClient);

    // Spy on the CANVAS, which is what the engine listens to: only the phantom
    // keyboard puts events there, so the spy is an unambiguous signal.
    const keys = [];
    const canvas = win.document.getElementById('canvas');
    canvas.addEventListener('keydown', (e) => keys.push(['down', e.code]));
    canvas.addEventListener('keyup', (e) => keys.push(['up', e.code]));

    // Load the real app (cache-busted so two files can each import it once).
    const appUrl = new URL(`../app.js?bust=${nick}-${Math.random()}`, import.meta.url).href;
    await import(appUrl);

    if (nick) win.document.getElementById('lobby-name').value = nick;
    if (room) win.document.getElementById('lobby-room').value = room;
    if (enter) {
        await waitFor(() => !win.document.getElementById('lobby-go').disabled, 3000, 'engine ready (gate unlocks)');
        win.document.getElementById('lobby-go').dispatchEvent(new win.Event('click', { bubbles: true }));
    }
    return { dom, win, document: win.document, keys };
}
