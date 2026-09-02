// ─────────────────────────────────────────────────────────────────────────────
// MARIO ARENA — one global Super Mario 64, controlled by everyone at once.
//
// There is exactly ONE game. It runs in a headless Chromium inside this box's
// Docker container ("the host"), not in anybody's browser. Every Discord
// Activity instance — in every guild, in every voice channel — connects to this
// same session and votes on the same controller. 45894854958 servers, one Mario.
//
// Why server-side and not per-client WASM: a shared Mario needs ONE authoritative
// game state and ONE save file. Running the wasm per-viewer and syncing inputs
// would need frame-perfect determinism across every browser, and any drift
// silently forks the world. Rendering once and shipping pixels can't desync.
//
// Why not VNC (asked and answered): VNC re-encodes a generic desktop framebuffer
// with a codec designed for text. Here the host page hands us already-encoded
// H.264/VP8 straight out of the GPU-less WebCodecs encoder, and viewers decode it
// with a hardware VideoDecoder. No X server, no framebuffer diffing, no
// websockify. See docs/ARENA.md.
//
//   viewer ──ws /ws────► [ merge inputs ] ──ws /host──► headless Chromium
//   viewer ◄─ video/audio chunks ────────────────────── (sm64.wasm + WebCodecs)
//
// Security posture matches the vnc-activity backend on this box: no shell, no
// eval, no child_process anywhere on a network-reachable path; every inbound
// frame is size-capped, every client is counted, chat is rate-limited.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT        = Number(process.env.ARENA_PORT || 8090);
const PUBLIC_DIR  = path.join(__dirname, 'public');
const HOST_TOKEN  = process.env.ARENA_HOST_TOKEN || '';
const CLIENT_ID   = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
// Discord user id that gets the admin panel. Same owner as the vnc-activity box.
const ADMIN_ID    = process.env.ARENA_ADMIN_ID || '1246945967102623755';
// Public origin, if the activity is ever served from our own domain rather than
// <client_id>.discordsays.com. Only used to allowlist redirect_uri.
const ARENA_ORIGIN = process.env.ARENA_ORIGIN || '';

// ── Limits ───────────────────────────────────────────────────────────────────
const MAX_VIEWERS      = 400;      // hard cap on concurrent viewers
const MAX_TEXT_FRAME   = 4 * 1024; // a viewer's JSON frame may not exceed this
const MAX_MEDIA_FRAME  = 4 * 1024 * 1024; // a host media chunk (keyframes are big)
const CHAT_MIN_GAP_MS  = 900;      // per-viewer chat rate limit
const CHAT_MAX_LEN     = 300;
const INPUT_STALE_MS   = 2500;     // a viewer's held keys expire if they go quiet
const TICK_HZ          = 30;       // controller merge rate (SM64 runs at 30fps)
const DEMOCRACY_WINDOW = 400;      // ms per democracy tally window

// The only keys that exist. Anything else a client sends is dropped on the floor
// — this is the whole allowlist for "what can a stranger do to our Mario".
const VALID_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', // analog stick
    'KeyX',   // A — jump
    'KeyC',   // B — dive / punch / grab
    'Space',  // Z — crouch / ground pound
    'Enter',  // Start
]);

// ── Sessions: server-VERIFIED Discord identity ───────────────────────────────
//
// Identity used to be whatever the client claimed in its hello frame. That was
// both a bug and a hole: a browser whose OAuth silently failed still connected
// and showed up as "Guest", and any client could simply claim the admin's
// discordId and be handed the admin star.
//
// Now the server does the whole exchange — code -> access_token -> GET
// /users/@me — and mints a session. The socket refuses anyone without one, so
// the name and avatar on screen are Discord's answer, never the client's.
const sessions = new Map();   // sessionId -> {discordId, name, avatar, admin, expires}
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// Escape hatch for LOCAL development only (no Discord in the loop). Never set
// this in production: it re-opens anonymous access.
const ALLOW_GUEST = process.env.ARENA_ALLOW_GUEST === '1';

function newSession(user) {
    const id = crypto.randomBytes(32).toString('hex');
    sessions.set(id, {
        discordId: user.id,
        name: (user.global_name || user.username || 'Mario').slice(0, 32),
        avatar: user.avatar || null,
        admin: user.id === ADMIN_ID,
        expires: Date.now() + SESSION_TTL_MS,
    });
    return id;
}

function getSession(id) {
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    if (Date.now() > s.expires) { sessions.delete(id); return null; }
    return s;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now > s.expires) sessions.delete(id);
}, 60 * 60 * 1000);

// ── Session state (there is only one, forever) ───────────────────────────────
const viewers = new Map();   // id -> viewer
let hostSock = null;         // the headless Chromium running the game
let hostAlive = false;

let mode = 'anarchy';        // 'anarchy' | 'democracy'
let lastSentKeys = '';       // serialized merged controller, to skip no-op sends
let democracyBucket = new Map();
let democracyUntil = 0;

// Cached so a viewer who joins mid-session can start decoding immediately
// instead of staring at a black canvas until the next keyframe.
let videoConfig = null;      // {codec, description(base64), width, height}
let audioConfig = null;      // {codec, sampleRate, numberOfChannels, description}
let lastKeyframe = null;     // Buffer — most recent video keyframe
let keyframeRequestedAt = 0;

let stats = { frames: 0, bytes: 0, since: Date.now() };

// ── Watchdog ─────────────────────────────────────────────────────────────────
// The game can die while everything around it looks healthy. Observed in
// production: sm64.js threw "Maximum call stack size exceeded" ~5 minutes in;
// video stopped dead, audio kept flowing, the host socket stayed connected and
// the container stayed "Up" — because Chromium was fine, only the page had
// crashed. `restart: unless-stopped` cannot see that, so nothing recovered and
// the arena was a black screen until a human noticed.
//
// So watch the only thing that actually proves the game is alive: video frames.
// Two tiers, because a page reload is cheap and keeps the profile (and the save)
// warm, while a container restart is the bigger hammer if the reload didn't take.
let lastVideoAt = Date.now();
let reloadSentAt = 0;
// Configurable so the test suite can exercise the stall path in milliseconds
// instead of waiting a real minute for it.
const VIDEO_STALL_RELOAD_MS = Number(process.env.ARENA_STALL_RELOAD_MS || 20000);
const VIDEO_STALL_EXIT_MS = Number(process.env.ARENA_STALL_EXIT_MS || 75000);
const WATCHDOG_TICK_MS = Number(process.env.ARENA_WATCHDOG_TICK_MS || 5000);

const nextId = (() => { let n = 0; return () => `v${++n}`; })();

// ── Binary media framing ─────────────────────────────────────────────────────
// [0] uint8  kind   1=video-config 2=video-key 3=video-delta 4=audio-config 5=audio
// [1..8]     f64    timestamp (microseconds, as the encoder reported it)
// [9..]      payload
const KIND = { VCONF: 1, VKEY: 2, VDELTA: 3, ACONF: 4, ACHUNK: 5 };

function mediaKind(buf) {
    return buf.length > 0 ? buf[0] : 0;
}

// ── Static file serving ──────────────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.ttf':  'font/ttf',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

// Build id = hash of the app shell, computed at start. The server restarts on
// every deploy, so this changes exactly when the code does.
//
// This exists because Cloudflare REWRITES our Cache-Control. The origin sends
// "no-cache" for .js/.css and the browser receives "max-age=14400" — the zone's
// 4h Browser Cache TTL overriding origin headers. So a deploy stranded every
// player on the previous build for four hours, and inside a Discord activity
// there is no hard reload. Fighting it with headers cannot work from here.
//
// Versioned URLs sidestep it entirely: a new build references URLs that have
// never been cached by anyone. Cloudflare's default cache level keys on the
// full URL including query string, so ?v= is enough.
const BUILD = (() => {
    const h = crypto.createHash('sha1');
    for (const f of ['client.js', 'client.css', 'index.html', 'discord-activity.js']) {
        try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))); } catch {}
    }
    return h.digest('hex').slice(0, 10);
})();

function serveStatic(req, res) {
    let url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/' || url === '') url = '/index.html';
    const target = path.normalize(path.join(PUBLIC_DIR, url));
    // Path traversal guard: the resolved path must stay inside PUBLIC_DIR.
    if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
    }
    fs.readFile(target, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
        const ext = path.extname(target).toLowerCase();
        // Stamp asset references with the build id.
        //
        // .js is rewritten too, not just .html: client.js imports
        // ./discord-activity.js by bare specifier, and that URL never appears in
        // the shell — so without this it could sit stale in cache for hours
        // while everything around it updated.
        if (ext === '.html' || ext === '.js') {
            data = Buffer.from(
                data.toString('utf8').replace(
                    /(\.\/)(client\.js|client\.css|discord-activity\.js)(?!\?)/g,
                    (_m, dot, file) => `${dot}${file}?v=${BUILD}`),
                'utf8');
        }
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            // Discord embeds us in an iframe on <app>.discordsays.com, so the
            // assets must be cross-origin readable. No COOP/COEP: it breaks the
            // Discord iframe (same lesson as the old server.js).
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            // The app shell must revalidate. With max-age on the JS/CSS, a deploy
            // leaves every player running the previous build until their cache
            // expires — and inside Discord there is no obvious way to hard
            // reload. 'no-cache' still allows 304s, so this costs a round trip,
            // not a re-download. Genuinely static vendored assets keep a TTL.
            // The shell must never be cached — it carries the build id that
            // points at everything else. Assets are versioned, so they are safe
            // to cache hard (and Cloudflare will do so regardless).
            'Cache-Control': ext === '.html'
                ? 'no-store, must-revalidate'
                : 'public, max-age=3600',
        }).end(data);
    });
}

// ── Discord OAuth code -> access_token ───────────────────────────────────────
function readBody(req, cap = 8 * 1024) {
    return new Promise((resolve, reject) => {
        let n = 0; const chunks = [];
        req.on('data', (c) => {
            n += c.length;
            if (n > cap) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

async function handleToken(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (!CLIENT_ID || !CLIENT_SECRET) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'discord credentials not configured' }));
        return;
    }
    let code, redirectUri;
    try {
        const parsed = JSON.parse(await readBody(req));
        code = typeof parsed.code === 'string' ? parsed.code : null;
        // Must match the value used at authorize time or Discord answers
        // invalid_grant. Allowlisted by shape rather than passed through: this
        // is a value we hand to Discord on the user's behalf, so a client does
        // not get to put an arbitrary URL in it.
        const r = typeof parsed.redirect_uri === 'string' ? parsed.redirect_uri : '';
        if (/^https:\/\/\d{5,25}\.discordsays\.com$/.test(r)) redirectUri = r;
        else if (ARENA_ORIGIN && r === ARENA_ORIGIN) redirectUri = r;
    } catch { code = null; }
    if (!code || code.length > 512) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'bad code' }));
        return;
    }
    try {
        const params = {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
        };
        if (redirectUri) params.redirect_uri = redirectUri;
        const body = new URLSearchParams(params);
        const r = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const json = await r.json();
        if (!r.ok || !json.access_token) {
            const why = [json.error, json.error_description].filter(Boolean).join(': ') || String(r.status);
            console.warn('[arena] token exchange rejected by Discord:', why);
            // Pass Discord's own wording through to the gate. It is not
            // sensitive, and a generic message here is what made the last two
            // failures require a log dig.
            res.writeHead(502, { 'Content-Type': 'application/json' })
               .end(JSON.stringify({ error: 'exchange failed: ' + why.slice(0, 160) }));
            return;
        }

        // Ask Discord who this actually is. The access token never goes back to
        // the browser — it has no use there, and not returning it means a
        // compromised client cannot act as the user against Discord's API.
        const me = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${json.access_token}` },
        });
        if (!me.ok) {
            console.warn('[arena] /users/@me failed:', me.status);
            res.writeHead(502, { 'Content-Type': 'application/json' })
               .end(JSON.stringify({ error: 'identify failed' }));
            return;
        }
        const user = await me.json();
        const session = newSession(user);
        console.log(`[arena] authenticated ${user.global_name || user.username} (${user.id})`);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            session,
            user: { id: user.id, username: user.username, global_name: user.global_name, avatar: user.avatar },
        }));
    } catch (err) {
        console.warn('[arena] token exchange failed:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'exchange failed' }));
    }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/api/token' || url === '/.proxy/api/token') return handleToken(req, res);
    if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            ok: true, host: hostAlive, viewers: viewers.size, mode,
            fps: stats.frames / Math.max(1, (Date.now() - stats.since) / 1000),
        }));
        return;
    }
    serveStatic(req, res);
});

// ── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MEDIA_FRAME });

server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    const isHost = url === '/host' || url === '/.proxy/host';
    const isView = url === '/ws' || url === '/.proxy/ws';
    if (!isHost && !isView) { socket.destroy(); return; }

    if (isHost) {
        // The host link is local-only and token-gated. A stranger who got one
        // would BE the game — this is the one connection that must not be open.
        const token = new URL(req.url, 'http://x').searchParams.get('token') || '';
        const okToken = HOST_TOKEN && token.length === HOST_TOKEN.length &&
            crypto.timingSafeEqual(Buffer.from(token), Buffer.from(HOST_TOKEN));
        if (!okToken) { socket.destroy(); return; }
    }

    // Viewers must present a session minted by the verified OAuth exchange.
    // No Discord auth, no game — the socket is the only way to reach the
    // stream, so refusing here refuses everything.
    let session = null;
    if (isView) {
        if (viewers.size >= MAX_VIEWERS) { socket.destroy(); return; }
        const sid = new URL(req.url, 'http://x').searchParams.get('s') || '';
        session = getSession(sid);
        if (!session) {
            if (!ALLOW_GUEST) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            session = { discordId: null, name: 'Guest', avatar: null, admin: false };
        }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        if (isHost) attachHost(ws); else attachViewer(ws, session);
    });
});

// ── The host (headless Chromium running the actual game) ─────────────────────
function attachHost(ws) {
    if (hostSock) { try { hostSock.close(4000, 'replaced'); } catch {} }
    hostSock = ws;
    hostAlive = true;
    lastSentKeys = '';
    lastVideoAt = Date.now();   // give a booting page its grace period
    console.log('[arena] host connected');
    broadcastJson({ t: 'host', up: true });

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            if (data.length > MAX_MEDIA_FRAME) return;
            const kind = mediaKind(data);
            if (kind === KIND.VKEY) { lastKeyframe = Buffer.from(data); stats.frames++; lastVideoAt = Date.now(); }
            else if (kind === KIND.VDELTA) { stats.frames++; lastVideoAt = Date.now(); }
            stats.bytes += data.length;
            broadcastBinary(data);
            return;
        }
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        if (msg.t === 'vconfig') { videoConfig = msg.config || null; broadcastJson({ t: 'vconfig', config: videoConfig }); }
        else if (msg.t === 'aconfig') { audioConfig = msg.config || null; broadcastJson({ t: 'aconfig', config: audioConfig }); }
        else if (msg.t === 'gamestate') broadcastJson({ t: 'gamestate', state: msg.state });
        else if (msg.t === 'log') console.log('[host]', String(msg.text || '').slice(0, 300));
    });

    ws.on('close', () => {
        if (hostSock === ws) { hostSock = null; hostAlive = false; lastKeyframe = null; }
        console.log('[arena] host disconnected');
        broadcastJson({ t: 'host', up: false });
    });
    ws.on('error', () => {});
}

function sendHost(obj) {
    if (hostSock && hostSock.readyState === 1) {
        try { hostSock.send(JSON.stringify(obj)); } catch {}
    }
}

function requestKeyframe() {
    const now = Date.now();
    if (now - keyframeRequestedAt < 400) return; // don't let a join storm spam it
    keyframeRequestedAt = now;
    sendHost({ t: 'keyframe' });
}

// ── Viewers ──────────────────────────────────────────────────────────────────
function attachViewer(ws, session) {
    const v = {
        id: nextId(),
        ws,
        // All four come from the server's own call to Discord. The client is
        // never asked, so it can never lie — including about being the admin.
        name: session.name,
        discordId: session.discordId,
        avatar: session.avatar,
        admin: session.admin,
        keys: new Set(),
        keysAt: 0,
        lastChat: 0,
        joinedAt: Date.now(),
    };
    viewers.set(v.id, v);

    send(v, {
        t: 'welcome',
        you: { id: v.id },
        mode,
        viewers: viewers.size,
        host: hostAlive,
        video: videoConfig,
        audio: audioConfig,
    });
    // Prime the decoder: config first, then the most recent keyframe we have,
    // then ask the host for a fresh one so the picture snaps in fast.
    if (lastKeyframe) { try { ws.send(lastKeyframe); } catch {} }
    requestKeyframe();
    broadcastRoster();

    ws.on('message', (data, isBinary) => {
        if (isBinary || data.length > MAX_TEXT_FRAME) return; // viewers never send media
        let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
        handleViewerMsg(v, msg);
    });

    ws.on('close', () => {
        viewers.delete(v.id);
        // A viewer who leaves mid-vote must stop counting, both as a ballot and
        // as part of the electorate — otherwise a vote can never reach a
        // majority of a room that has since emptied out.
        if (vote) {
            vote.yes.delete(v.id);
            vote.no.delete(v.id);
            broadcastJson(voteSnapshot());
            tallyVote();
        }
        democracyVoters.delete(v.id);
        broadcastRoster();
    });
    ws.on('error', () => {});
}

function handleViewerMsg(v, msg) {
    switch (msg && msg.t) {
        case 'hello': {
            // Name, avatar and admin are already set from the verified session.
            // The only thing worth taking from the client is which guild the
            // activity was launched in, and that is a label with no privileges.
            if (typeof msg.guildId === 'string' && /^\d{5,25}$/.test(msg.guildId)) v.guildId = msg.guildId;
            broadcastRoster();
            break;
        }
        case 'input': {
            if (!Array.isArray(msg.keys)) return;
            const next = new Set();
            for (const k of msg.keys.slice(0, 8)) if (VALID_KEYS.has(k)) next.add(k);
            v.keys = next;
            v.keysAt = Date.now();
            break;
        }
        case 'chat': {
            const now = Date.now();
            if (now - v.lastChat < CHAT_MIN_GAP_MS) return;
            v.lastChat = now;
            const text = String(msg.text || '').slice(0, CHAT_MAX_LEN).trim();
            if (!text) return;
            broadcastJson({
                t: 'chat', from: v.name, admin: v.admin, text,
                discordId: v.discordId, avatar: v.avatar,
            });
            break;
        }
        case 'needkey': {
            // The viewer's decoder just finished configuring. Configuration is
            // async, so the keyframe we pushed at join time probably arrived
            // before there was anything to decode it. Send a fresh one now
            // instead of leaving them black until the periodic one.
            requestKeyframe();
            break;
        }
        case 'modevote': {
            const want = msg.mode === 'democracy' ? 'democracy' : 'anarchy';
            openVote(v, want);
            break;
        }
        case 'votecast': {
            castVote(v, msg.yes === true);
            break;
        }
        default: break;
    }
}

// ── Fan-out ──────────────────────────────────────────────────────────────────
function send(v, obj) {
    if (v.ws.readyState === 1) { try { v.ws.send(JSON.stringify(obj)); } catch {} }
}

function broadcastJson(obj) {
    const s = JSON.stringify(obj);
    for (const v of viewers.values()) {
        if (v.ws.readyState === 1) { try { v.ws.send(s); } catch {} }
    }
}

function broadcastBinary(buf) {
    for (const v of viewers.values()) {
        if (v.ws.readyState !== 1) continue;
        // Backpressure: if a viewer's socket is already backed up, drop this
        // frame for THEM rather than buffering the whole session into memory.
        // A dropped delta self-heals at the next keyframe.
        if (v.ws.bufferedAmount > 2 * 1024 * 1024) continue;
        try { v.ws.send(buf); } catch {}
    }
}

function broadcastRoster() {
    const users = [];
    for (const v of viewers.values()) {
        users.push({ id: v.id, name: v.name, admin: v.admin, discordId: v.discordId, avatar: v.avatar });
    }
    broadcastJson({ t: 'roster', count: users.length, users: users.slice(0, 60) });
}

// ── Mode votes ───────────────────────────────────────────────────────────────
// Flipping the whole world between ANARCHY and DEMOCRACY used to be a single
// click by a single person, which is obviously abusable when the room is public
// and global. Now it opens a vote that everyone sees and can answer.
let vote = null;   // { mode, byName, byId, yes:Set<viewerId>, no:Set<viewerId>, endsAt }
const VOTE_MS = 20000;
const VOTE_COOLDOWN_MS = 15000;
let voteCooldownUntil = 0;

function voteSnapshot() {
    if (!vote) return { t: 'vote', open: false };
    const naming = (ids) => [...ids]
        .map((id) => viewers.get(id))
        .filter(Boolean)
        .map((v) => ({ id: v.id, name: v.name, discordId: v.discordId, avatar: v.avatar }));
    return {
        t: 'vote',
        open: true,
        mode: vote.mode,
        by: vote.byName,
        yes: naming(vote.yes),
        no: naming(vote.no),
        needed: votesNeeded(),
        endsAt: vote.endsAt,
    };
}

// Strict majority of everyone currently connected — floor(n/2)+1, the same rule
// the democracy key-tally uses, so "majority" means one thing in this codebase.
// ceil(n/2) would make a 2-person room pass on ONE vote (50% is not a majority).
// In a big room this early-pass bar is high on purpose; the deadline path below
// falls back to simply "more yes than no".
function votesNeeded() {
    return Math.floor(viewers.size / 2) + 1;
}

function openVote(v, want) {
    const now = Date.now();
    if (vote) {                       // already one running — treat as a yes
        if (vote.mode === want) castVote(v, true);
        return;
    }
    if (want === mode) return;        // nothing to change
    if (now < voteCooldownUntil) {
        send(v, { t: 'notice', text: 'a vote just finished — give it a few seconds' });
        return;
    }
    vote = {
        mode: want,
        byName: v.name,
        byId: v.id,
        yes: new Set([v.id]),         // proposing IS voting yes
        no: new Set(),
        endsAt: now + VOTE_MS,
    };
    broadcastJson(voteSnapshot());
    tallyVote();
}

function castVote(v, yes) {
    if (!vote) return;
    vote.yes.delete(v.id);
    vote.no.delete(v.id);
    (yes ? vote.yes : vote.no).add(v.id);
    broadcastJson(voteSnapshot());
    tallyVote();
}

function tallyVote() {
    if (!vote) return;
    const need = votesNeeded();
    const expired = Date.now() >= vote.endsAt;
    // Pass early the moment a majority says yes; otherwise let the clock decide.
    const passed = vote.yes.size >= need || (expired && vote.yes.size > vote.no.size);
    if (!passed && !expired) return;

    const decidedMode = vote.mode;
    const by = vote.byName;
    vote = null;
    voteCooldownUntil = Date.now() + VOTE_COOLDOWN_MS;
    broadcastJson({ t: 'vote', open: false, passed, mode: decidedMode, by });

    if (passed) {
        mode = decidedMode;
        democracyBucket = new Map();
        lastDemocracyResult = new Set();
        broadcastJson({ t: 'mode', mode, by });
    }
}

// Close out a vote whose clock ran down even if nobody cast anything new, and
// keep the countdown honest for late joiners.
setInterval(() => { if (vote) tallyVote(); }, 1000);

// ── The controller merge — the actual "everyone controls Mario" ──────────────
function mergeAnarchy(active) {
    // Any held key from anybody is held. Chaotic, responsive, and the only mode
    // where a single person can still make Mario move when nobody else is on.
    const out = new Set();
    for (const v of active) for (const k of v.keys) out.add(k);
    return out;
}

// Tally by UNIQUE VOTER, not by tick.
//
// The first cut counted every tick a key was held and divided by the window
// length, which made "how long did you hold it" matter as much as "how many of
// you held it" — and with a threshold of ceil(voters/2) a 1-1 split passed BOTH
// directions at once, so democracy behaved exactly like anarchy. Mario would
// get ArrowLeft and ArrowRight simultaneously.
//
// Now: each viewer contributes at most one vote per key per window, and a key
// needs a strict majority (floor(n/2)+1) of the people actually voting.
function mergeDemocracy(active) {
    const now = Date.now();
    for (const v of active) {
        for (const k of v.keys) {
            if (!democracyBucket.has(k)) democracyBucket.set(k, new Set());
            democracyBucket.get(k).add(v.id);
        }
        if (v.keys.size > 0) democracyVoters.add(v.id);
    }
    if (now < democracyUntil) return lastDemocracyResult;
    democracyUntil = now + DEMOCRACY_WINDOW;

    const voters = democracyVoters.size;
    const out = new Set();
    if (voters > 0) {
        const threshold = Math.floor(voters / 2) + 1;   // strict majority
        for (const [k, who] of democracyBucket) {
            if (who.size >= threshold) out.add(k);
        }
    }
    democracyBucket = new Map();
    democracyVoters = new Set();
    lastDemocracyResult = out;
    return out;
}
let lastDemocracyResult = new Set();
let democracyVoters = new Set();

setInterval(() => {
    const now = Date.now();
    const active = [];
    for (const v of viewers.values()) {
        // A viewer who stopped sending input is treated as holding nothing, so a
        // rage-quit or a frozen tab can't pin Mario against a wall forever.
        if (now - v.keysAt > INPUT_STALE_MS) v.keys = new Set();
        active.push(v);
    }
    const held = mode === 'democracy' ? mergeDemocracy(active) : mergeAnarchy(active);
    const serialized = [...held].sort().join(',');
    if (serialized !== lastSentKeys) {
        lastSentKeys = serialized;
        sendHost({ t: 'input', keys: [...held] });
        // Let everyone see what the hive mind actually did with their vote.
        broadcastJson({ t: 'held', keys: [...held] });
    }
}, Math.round(1000 / TICK_HZ));

setInterval(() => {
    if (!hostAlive) return;
    const stalled = Date.now() - lastVideoAt;

    // Tier 2: the reload didn't bring it back. Exit so Docker recreates the
    // container. The save is synced to IDBFS every 5s, so this costs seconds.
    if (stalled > VIDEO_STALL_EXIT_MS) {
        console.error(`[arena] no video for ${(stalled / 1000) | 0}s after a reload — exiting for a container restart`);
        process.exit(1);
    }

    // Tier 1: tell the host page to reload itself.
    if (stalled > VIDEO_STALL_RELOAD_MS && Date.now() - reloadSentAt > VIDEO_STALL_EXIT_MS) {
        console.warn(`[arena] no video for ${(stalled / 1000) | 0}s — reloading the host page`);
        reloadSentAt = Date.now();
        sendHost({ t: 'reload' });
    }
}, WATCHDOG_TICK_MS);

// Periodic keyframe so a viewer who joins between keyframes isn't stuck black.
setInterval(() => { if (viewers.size > 0) requestKeyframe(); }, 2000);

setInterval(() => {
    const secs = (Date.now() - stats.since) / 1000;
    if (secs > 30) {
        console.log(`[arena] ${viewers.size} viewers | ${(stats.frames / secs).toFixed(1)} fps | ` +
                    `${(stats.bytes / secs / 1024).toFixed(0)} KiB/s | host=${hostAlive} | mode=${mode}`);
        stats = { frames: 0, bytes: 0, since: Date.now() };
    }
}, 30000);

// Bind 0.0.0.0, NOT loopback.
//
// Inside a container, 127.0.0.1 is the container's own loopback, so Docker's
// port proxy cannot reach the listener and every connection from outside dies
// silently — the port looks bound on the host and answers nothing.
//
// This is not an exposure: isolation comes from the PUBLISH side. compose maps
// "127.0.0.1:8090:8090", so the host only ever offers it on loopback, and the
// public entry point stays nginx.
server.listen(PORT, process.env.ARENA_BIND || '0.0.0.0', () => {
    console.log(`🍄 Mario Arena relay on 127.0.0.1:${PORT}`);
    console.log(`   viewers: ws://…/ws   host: ws://…/host?token=…`);
    console.log(`   admin id: ${ADMIN_ID}`);
});
