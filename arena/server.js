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
// Site-account login: users who are not in Discord register an account here.
// Accounts live in a JSON file on the persistent volume, NOT in the image, so
// they survive container recreation. No account AND no Discord OAuth = nothing:
// the /ws socket only accepts server-minted sessions.
const ACCOUNTS_FILE = process.env.ARENA_ACCOUNTS_FILE || '/data/accounts.json';
const ACCOUNT_SESSIONS_FILE = process.env.ARENA_ACCOUNT_SESSIONS_FILE || '/data/account-sessions.json';
const ACCOUNT_TTL_MS = Number(process.env.ARENA_ACCOUNT_TTL_MS || 30 * 24 * 60 * 60 * 1000);
// Optional: the arena account username that also gets admin powers (mirror of
// ADMIN_ID for people reaching the site without Discord). Empty = no admin via
// accounts. The crowd still can't claim it: both checks are server-side.
const ADMIN_USER = process.env.ARENA_ADMIN_USER || '';
// Account usernames that also get the admin panel (comma-separated). retrox is
// the owner's own account; the Discord id above is the same person.
const ADMIN_USERS = new Set(
    String([process.env.ARENA_ADMIN_USERS || '', ADMIN_USER, 'retrox'].join(','))
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

// ── Moderation / safety limits ───────────────────────────────────────────────
const RULES_VERSION = Number(process.env.ARENA_RULES_VERSION || 1);
const BANS_FILE = process.env.ARENA_BANS_FILE || '/data/bans.json';
const CONSENT_FILE = process.env.ARENA_CONSENT_FILE || '/data/consent.json';
const MOD_URL = process.env.ARENA_MOD_URL || 'https://gen.pollinations.ai/v1/chat/completions';
const MOD_MODEL = process.env.ARENA_MOD_MODEL || 'openai';
const MOD_BLOCK_MINUTES = Number(process.env.ARENA_MOD_BLOCK_MINUTES || 10);
const MOD_SKIP_ADMIN = process.env.ARENA_MOD_SKIP_ADMIN !== '0';
// A browser-ish UA is REQUIRED: Cloudflare answers a bot signature with 403/1010
// and the moderator silently disappears. The key comes from the environment or,
// failing that, /data/mod.key — a file, so it is never in a command line, a
// shell history, or a log.
let MOD_KEY = process.env.ARENA_MOD_KEY || process.env.POLLINATIONS_API_KEY || '';
try { if (!MOD_KEY) MOD_KEY = fs.readFileSync('/data/mod.key', 'utf8').trim(); } catch {}
const MOD_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PROFILE_MAX_BYTES = 2 * 1024 * 1024;

// ── Limits ───────────────────────────────────────────────────────────────────
const MAX_VIEWERS      = 400;      // hard cap on concurrent viewers
const MAX_TEXT_FRAME   = 4 * 1024; // a viewer's JSON frame may not exceed this
const MAX_MEDIA_FRAME  = 4 * 1024 * 1024; // a host media chunk (keyframes are big)
const CHAT_MIN_GAP_MS  = 900;      // per-viewer chat rate limit
const CHAT_MAX_LEN     = 300;
const INPUT_STALE_MS   = 2500;     // a viewer's held keys expire if they go quiet
// Controller merge rate. This is pure added input latency: at 30Hz a keypress
// waits up to 33ms just to be noticed, which is brutal for a rhythm game. The
// merge itself is a few set operations over a handful of viewers, so running it
// at 120Hz costs almost nothing and cuts that to ~8ms.
const TICK_HZ          = Number(process.env.ARENA_TICK_HZ || 120);

// Keys that are disruptive when mashed rather than held. Under a union merge a
// single person spamming Start pauses/unpauses the game for everyone at 30Hz,
// and no amount of per-viewer politeness fixes that — the limit has to be
// GLOBAL, on the merged controller, or one client just ignores it.
// Cooldowns are env-overridable so the suite can prove the behaviour in
// milliseconds instead of sitting through a real 1.2s per assertion.
const RATE_LIMITED = new Map([
    ['Enter', Number(process.env.ARENA_ENTER_COOLDOWN_MS || 1200)],   // Start / pause
    ['Escape', Number(process.env.ARENA_ESCAPE_COOLDOWN_MS || 2000)], // menus / quit
]);

// The only keys that exist. Anything else a client sends is dropped on the floor.
//
// The wasm build needs seven; the desktop build runs arbitrary emulators and
// needs the whole keyboard, so ARENA_FULL_KEYBOARD widens it. Both lists come
// from arena/keys.js so the relay and the input injector can never disagree
// about what is legal — when they drifted apart the symptom was "some buttons
// just don't work", with nothing in any log.
const { SM64_KEYS, FULL_KEYS } = require('./keys.js');
const FULL_KEYBOARD = process.env.ARENA_FULL_KEYBOARD === '1';
const VALID_KEYS = new Set(FULL_KEYBOARD ? FULL_KEYS : SM64_KEYS);

// ── Which game is running, and what the crowd wants instead ──────────────────
//
// The picker lives here rather than on the X display: the desktop image has
// nothing installed that could draw a menu, and putting one on screen would
// hand the crowd a menu to escape through.
//
// One vote each. A game switches when it reaches a strict majority of everyone
// connected — the same floor(n/2)+1 rule the rest of the codebase uses, so
// "majority" means one thing everywhere.
let currentGame = null;          // id of the running game, or null when idle
let gameList = [];               // [{id,name,system,layout}] reported by the agent
const gameVotes = new Map();     // viewerId -> gameId | '__stop__'
let switchCooldownUntil = 0;
const SWITCH_COOLDOWN_MS = Number(process.env.ARENA_SWITCH_COOLDOWN_MS || 10000);
const STOP = '__stop__';

function gameVotesNeeded() {
    return Math.floor(viewers.size / 2) + 1;
}

function tallyGameVotes() {
    const counts = new Map();
    for (const [viewerId, choice] of gameVotes) {
        if (!viewers.has(viewerId)) { gameVotes.delete(viewerId); continue; }
        counts.set(choice, (counts.get(choice) || 0) + 1);
    }
    return counts;
}

function gameStateSnapshot() {
    const counts = tallyGameVotes();
    return {
        t: 'gamestate',
        current: currentGame,
        games: gameList,
        needed: gameVotesNeeded(),
        votes: Object.fromEntries(counts),
        cooldown: Math.max(0, switchCooldownUntil - Date.now()),
    };
}

function castGameVote(v, choice) {
    if (choice !== STOP && !gameList.some((g) => g.id === choice)) return;
    if (choice === currentGame) return;          // already playing it
    gameVotes.set(v.id, choice);
    checkGameSwitch();
    broadcastJson(gameStateSnapshot());
}

function checkGameSwitch() {
    if (Date.now() < switchCooldownUntil) return;
    const need = gameVotesNeeded();
    for (const [choice, count] of tallyGameVotes()) {
        if (count < need) continue;
        switchCooldownUntil = Date.now() + SWITCH_COOLDOWN_MS;
        gameVotes.clear();
        if (choice === STOP) {
            currentGame = null;
            sendHost({ t: 'stop' });
            broadcastJson({ t: 'notice', text: 'vote passed — game stopped' });
        } else {
            currentGame = choice;
            sendHost({ t: 'launch', id: choice });
            const name = (gameList.find((g) => g.id === choice) || {}).name || choice;
            broadcastJson({ t: 'notice', text: `vote passed — launching ${name}` });
        }
        return;
    }
}

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
const durableSessions = loadDurableSessions(); // token hash -> { username, expires }
let durableSessionsDirty = false;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// Escape hatch for LOCAL development only (no Discord in the loop). Never set
// this in production: it re-opens anonymous access.
const ALLOW_GUEST = process.env.ARENA_ALLOW_GUEST === '1';

function newSession(user) {
    const id = crypto.randomBytes(32).toString('hex');
    sessions.set(id, {
        discordId: String(user.id || ''),
        name: cleanSafe(user.global_name || user.username || 'Mario') || 'Mario',
        avatar: (typeof user.avatar === 'string' && /^[a-z0-9_]+$/i.test(user.avatar) ? user.avatar : null),
        admin: String(user.id) === ADMIN_ID,
        expires: Date.now() + SESSION_TTL_MS,
        kind: 'discord',
    });
    return id;
}

function getSession(id) {
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) {
        const record = durableSessions.get(hashSessionToken(id));
        if (!record) return null;
        if (Date.now() > record.expires || !accounts[record.username]) {
            durableSessions.delete(hashSessionToken(id));
            durableSessionsDirty = true;
            saveDurableSessions();
            return null;
        }
        return restoreAccountSession(id, record.username, record.expires);
    }
    if (Date.now() > s.expires) { sessions.delete(id); return null; }
    return s;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now > s.expires) sessions.delete(id);
    for (const [token, record] of durableSessions) {
        if (now > record.expires || !accounts[record.username]) {
            durableSessions.delete(token);
            durableSessionsDirty = true;
        }
    }
    saveDurableSessions();
}, 60 * 60 * 1000);

// ── Site accounts ────────────────────────────────────────────────────────────
//
// Discord OAuth is the identity path inside an Activity. In a normal browser the
// SDK reports "not in Discord" and the old gate just gave up with "Open this
// inside Discord to play." Now a site visitor can register/login with a username
// and password; the server verifies the password (scrypt, salted) and mints the
// SAME kind of session the WS gate requires. No account + no OAuth = the socket
// still refuses, so anonymous browsers still get nothing.
const accounts = loadAccounts();
let accountsDirty = false;

function loadAccounts() {
    try {
        const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
        return (parsed && typeof parsed.users === 'object') ? parsed.users : {};
    } catch { return {}; }
}

function saveAccounts() {
    if (!accountsDirty) return;
    try {
        fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
        const tmp = ACCOUNTS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ users: accounts }));
        fs.renameSync(tmp, ACCOUNTS_FILE);
        accountsDirty = false;
    } catch (err) { console.warn('[arena] account save failed:', err.message); }
}

function hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function loadDurableSessions() {
    try {
        const parsed = JSON.parse(fs.readFileSync(ACCOUNT_SESSIONS_FILE, 'utf8'));
        return new Map(Object.entries(parsed && typeof parsed === 'object' ? parsed : {}));
    } catch { return new Map(); }
}

function saveDurableSessions() {
    if (!durableSessionsDirty) return;
    try {
        fs.mkdirSync(path.dirname(ACCOUNT_SESSIONS_FILE), { recursive: true });
        const tmp = ACCOUNT_SESSIONS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(durableSessions)));
        fs.renameSync(tmp, ACCOUNT_SESSIONS_FILE);
        durableSessionsDirty = false;
    } catch (err) { console.warn('[arena] session save failed:', err.message); }
}
setInterval(saveDurableSessions, 5000);
process.on('SIGTERM', saveDurableSessions);
process.on('SIGINT', saveDurableSessions);
// Durability without fsync-on-every-register: flush any pending writes on a
// 5s cadence and on termination.
setInterval(saveAccounts, 5000);
process.on('SIGTERM', saveAccounts);
process.on('SIGINT', saveAccounts);

function hashPassword(pass, salt) {
    return crypto.scryptSync(pass, salt, 64).toString('hex');
}

function newAccountSession(username) {
    const id = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + ACCOUNT_TTL_MS;
    durableSessions.set(hashSessionToken(id), { username, expires });
    durableSessionsDirty = true;
    saveDurableSessions();
    return restoreAccountSession(id, username, expires);
}

function restoreAccountSession(id, username, expires) {
    const name = cleanSafe(username) || 'player';
    const profile = accounts[username]?.profile || {};
    sessions.set(id, {
        discordId: null,
        name,
        avatar: null,
        avatarUrl: profile.avatar ? `/api/profile-pic?u=${encodeURIComponent(username)}` : null,
        bio: cleanSafe(profile.bio || ''),
        accountUsername: username,
        admin: ADMIN_USERS.has(String(name).toLowerCase()),
        expires,
        kind: 'account',
    });
    return id;
}

function accountResponse(username) {
    const p = accounts[username]?.profile || {};
    return {
        username,
        displayName: cleanSafe(p.displayName || username) || username,
        bio: cleanSafe(p.bio || ''),
        avatarUrl: p.avatar ? `/api/profile-pic?u=${encodeURIComponent(username)}` : null,
    };
}

function refreshAccountSessions(username) {
    const profile = accountResponse(username);
    for (const session of sessions.values()) {
        if (session.kind !== 'account' || session.accountUsername !== username) continue;
        session.name = profile.displayName;
        session.bio = profile.bio;
        session.avatarUrl = profile.avatarUrl;
    }
    for (const viewer of viewers.values()) {
        if (viewer.accountUsername !== username) continue;
        viewer.name = profile.displayName;
        viewer.bio = profile.bio;
        viewer.avatarUrl = profile.avatarUrl;
    }
    broadcastRoster();
}

// Cheap per-IP throttle on the two auth endpoints. Nobody needs to register
// twenty accounts in a minute, and this stops credential-spraying from turning
// scrypt into a free CPU sink.
const authAttempts = new Map();     // ip -> { n, windowStart }
function authAllowed(ip) {
    const now = Date.now();
    let a = authAttempts.get(ip);
    if (!a || now - a.windowStart > 600000) { a = { n: 0, windowStart: now }; authAttempts.set(ip, a); }
    if (a.n >= 20) return false;
    a.n++;
    return true;
}

// ── Moderation state: consent, blocks, bans ─────────────────────────────────
//
// The arena is a public screen that strangers share, so before anyone can act
// (input, chat, votes) they must accept the rules — including that an AI may
// read what they type. No consent, no connection. Blocks are temporary and
// silence one viewer's inputs; bans are permanent and refuse the socket.
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, file);
    } catch (err) { console.warn('[arena] persist failed:', err.message); }
}

let bans = readJson(BANS_FILE, { entries: [] });
if (!bans || !Array.isArray(bans.entries)) bans = { entries: [] };
const consent = readJson(CONSENT_FILE, {});
const blocks = new Map();   // key -> { until, reason, by }

function viewerKeyOf(session) {
    if (session.discordId) return 'discord:' + session.discordId;
    if (session.accountUsername) return 'account:' + session.accountUsername;
    return 'guest';
}
function viewerKey(v) {
    if (v.discordId) return 'discord:' + v.discordId;
    if (v.accountUsername) return 'account:' + v.accountUsername;
    return 'guest';
}
function isBanned(key) { return bans.entries.some((b) => b.key === key); }
function activeBlock(key) {
    const b = blocks.get(key);
    if (!b) return null;
    if (Date.now() > b.until) { blocks.delete(key); return null; }
    return b;
}
function setBlock(key, minutes, reason, by) {
    const until = Date.now() + Math.max(1, Math.min(1440, Number(minutes) || MOD_BLOCK_MINUTES)) * 60000;
    blocks.set(key, { until, reason: String(reason || '').slice(0, 120), by: by || 'admin' });
    for (const v of viewers.values()) if (viewerKey(v) === key) v.keys = new Set();
    return until;
}
function isConsented(key) {
    const c = consent[key];
    return !!(c && Number(c.rules) >= RULES_VERSION && c.ai === true);
}
function setConsent(key, ai) {
    consent[key] = { rules: RULES_VERSION, ai: !!ai, at: Date.now() };
    writeJson(CONSENT_FILE, consent);
}
function persistBans() { writeJson(BANS_FILE, bans); }
function humanLeft(until) {
    const m = Math.max(1, Math.round((until - Date.now()) / 60000));
    return m === 1 ? '1 minute' : m + ' minutes';
}
function resolveTargetKey(target) {
    if (typeof target !== 'string') return '';
    if (/^(discord|account|guest)/.test(target)) return target;
    const byId = [...viewers.values()].find((x) => x.id === target);
    return byId ? viewerKey(byId) : '';
}
function playerList() {
    return {
        t: 'players',
        rulesVersion: RULES_VERSION,
        players: [...viewers.values()].map((x) => {
            const b = activeBlock(x.key);
            return {
                id: x.id, name: x.name, admin: x.admin, key: x.key,
                discordId: x.discordId || null, username: x.accountUsername || null,
                consented: !!x.consented,
                block: b ? { until: b.until, reason: b.reason, minutesLeft: Math.max(1, Math.round((b.until - Date.now()) / 60000)) } : null,
                banned: isBanned(x.key),
            };
        }),
    };
}

// AI moderation. Two layers:
//   1. heuristics — offline, instant, free. Catches the obvious (slurs, threats,
//      sexual, doxxing, scam links) even when no model is reachable.
//   2. the model — nuance, when a working endpoint/key exists.
// FAIL-OPEN on purpose for the model: if it is unreachable nobody gets punished
// by an outage. (The heuristics never fail, so obvious abuse is still blocked.)
const BAD_PATTERNS = [
    // threats / violence
    /\b(i(')?ll|i will|im gonna|i'm gonna|gonna|going to)\s+(kill|hurt|find|beat|rape|stab|shoot)\b/i,
    /\b(kill|hurt|beat|stab|shoot)\s+(you|yourself|him|her|them|u)\b/i,
    /\bkys\b/i,
    // slurs / hate (leetspeak tolerant)
    /\b(n[i1]gg|f[a4]gg|retard|tr[a4]nny|k[i1]ke|sp[i1]c|ch[i1]nk)\w*/i,
    // sexual content
    /\b(nudes?|porn|horny|cum|blowjob|dick pic|send pics)\b/i,
    // doxxing / personal info
    /\b(dox|doxx|swat)\b/i,
    /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
    /(?:\+?\d[\s-]?){9,}/,
    // scams / illegal
    /\bfree\s+(robux|vbucks|nitro|v-?bucks)\b/i,
    /\b(claim your|click (this|here) to win)\b/i,
    /\b(buy|sell)\s+(drugs|coke|weed|meth|cp)\b/i,
];
function heuristicFlag(text) {
    for (const re of BAD_PATTERNS) if (re.test(text)) return 'blocked phrase';
    return null;
}

const modCache = new Map();   // text -> {bad, reason}
async function moderateText(text) {
    // Layer 1: heuristics, always.
    const flagged = heuristicFlag(text);
    if (flagged) return { bad: true, reason: flagged, via: 'heuristic' };
    // Layer 2: the model, only if we have somewhere to send it.
    if (!MOD_KEY || !MOD_URL) return { bad: false, disabled: true };
    const hit = modCache.get(text);
    if (hit) return hit;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch(MOD_URL, {
            method: 'POST', signal: ctrl.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + MOD_KEY,
                'User-Agent': MOD_UA,
            },
            body: JSON.stringify({
                model: MOD_MODEL,
                messages: [
                    { role: 'system', content: 'You are a strict chat moderator for a public game arena where strangers share one screen. Judge the user text. Reply with ONLY compact JSON: {"bad":true|false,"reason":"<max 8 words>"}. bad=true for: slurs or hate, threats or violence, sexual content, illegal activity, sharing personal info/doxxing, scams or spam links. Otherwise bad=false.' },
                    { role: 'user', content: String(text).slice(0, 400) },
                ],
            }),
        });
        clearTimeout(timer);
        if (!r.ok) {
            // A 422 (or any "content management policy" rejection) means the
            // MODERATOR'S OWN upstream filter refused the text — that is a
            // stronger verdict than any JSON we could have asked for.
            const body = await r.text().catch(() => '');
            if (r.status === 422 || /content management policy|filtered due to/i.test(body)) {
                return { bad: true, reason: 'blocked by AI content filter', via: 'ai' };
            }
            return { bad: false, error: 'moderator http ' + r.status };
        }
        const j = await r.json();
        const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        const m = content.match(/\{[\s\S]*\}/);
        const v = m ? JSON.parse(m[0]) : { bad: false };
        const out = { bad: !!v.bad, reason: String(v.reason || '').slice(0, 80), via: 'ai' };
        modCache.set(text, out);
        if (modCache.size > 500) modCache.delete(modCache.keys().next().value);
        return out;
    } catch (err) {
        return { bad: false, error: String((err && err.message) || err).slice(0, 80) };
    }
}

// ── Input scrubbing (one trust boundary) ─────────────────────────────────────
//
// Every string that started with a human (Discord name, chat line, account
// handle) leaves endings through textContent on the client, so classic payloads
// can't execute there anyway. This is the second layer: strip the invisible
// stuff that is NOT html-dangerous but IS socially-dangerous — control bytes,
// bidi overrides (a name that right-to-left-renders "admin ⭐" is a phish, not
// an XSS) and zero-width joiners. Applied wherever a user string enters the
// wire, so no future DOM sink can ever see them either.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;
function cleanSafe(s, max = 64) {
    if (typeof s !== 'string') return '';
    return s.replace(CONTROL_RE, '').trim().slice(0, max);
}

// ── Session state (there is only one, forever) ───────────────────────────────
const viewers = new Map();   // id -> viewer
let hostSock = null;         // the headless Chromium running the game
let hostAlive = false;

let lastSentKeys = '';
let lastMouseAt = 0;       // serialized merged controller, to skip no-op sends

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
                    /(\.\/)(client\.js|client\.css|discord-activity\.js|audio-worklet\.js)(?!\?)/g,
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
            'X-Content-Type-Options': 'nosniff',
            // Platform-level XSS kill switch on the app shell. Even if a sink
            // ever sneaks into a future build, an injected script/style has
            // nowhere left to load from — this turns any payload into a 404.
            // frame-ancestors stays open because Discord must be able to embed
            // us on <app>.discordsays.com, and style-src allows the inline
            // styles client.js sets on avatars and state classes.
            ...(ext === '.html' ? {
                'Content-Security-Policy': [
                    "default-src 'self'",
                    "script-src 'self'",
                    "style-src 'self' 'unsafe-inline'",
                    "img-src 'self' https://cdn.discordapp.com data:",
                    "connect-src 'self' https://discord.com",
                    "font-src 'self'",
                    "media-src 'self' blob:",
                    "object-src 'none'",
                    "base-uri 'none'",
                    "frame-ancestors *",
                    "worklet-src 'self'",
                ].join('; '),
            } : {}),
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

// ── Site account register / login ────────────────────────────────────────────
// Both paths mint a session indistinguishable (to the WS gate) from Discord's,
// so the client only ever cares about "do I have a session id, yes/no".
async function handleAccount(req, res, isRegister) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!authAllowed(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'too many attempts — try again in a few minutes' }));
        return;
    }
    let username = '', password = '';
    try {
        const parsed = JSON.parse(await readBody(req));
        username = typeof parsed.username === 'string' ? parsed.username.trim() : '';
        password = typeof parsed.password === 'string' ? parsed.password : '';
    } catch {}
    username = username.slice(0, 24);
    if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'username: 3-24 characters, letters, numbers, _ or -' }));
        return;
    }
    if (password.length < 8 || password.length > 128) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'password must be 8-128 characters' }));
        return;
    }

    if (isRegister) {
        if (accounts[username]) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
               .end(JSON.stringify({ error: 'that username is taken' }));
            return;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        accounts[username] = { salt, hash: hashPassword(password, salt), created: Date.now() };
        accountsDirty = true;
        saveAccounts();
        const session = newAccountSession(username);
        console.log(`[arena] registered account "${username}"`);
        res.writeHead(200, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ session, user: { username } }));
        return;
    }

    // login
    const record = accounts[username];
    if (!record || !record.hash || !record.salt) {
        // Same body as the wrong-password case; leaking which usernames exist
        // would turn this into an oracle.
        res.writeHead(401, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'bad username or password' }));
        return;
    }
    let ok = false;
    try {
        const mine = Buffer.from(hashPassword(password, record.salt), 'hex');
        ok = mine.length === Buffer.from(record.hash, 'hex').length &&
            crypto.timingSafeEqual(mine, Buffer.from(record.hash, 'hex'));
    } catch { ok = false; }
    if (!ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'bad username or password' }));
        return;
    }
    const session = newAccountSession(username);
    console.log(`[arena] account login "${username}"`);
    res.writeHead(200, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ session, user: { username } }));
}

// Tells the client whether its stored session is still valid WITHOUT opening a
// socket. The client uses this at boot and after a reconnect loop starts, so an
// expired session dumps it on the login gate instead of spinning on 401s.
function handleCheck(req, res) {
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    const s = getSession(q.get('s') || '');
    if (!s) { res.writeHead(401).end(); return; }
    // A banned session is dead everywhere: this endpoint tells the client to
    // stop trying, instead of letting it reconnect into a 403 forever.
    if (isBanned(viewerKeyOf(s))) {
        const b = bans.entries.find((x) => x.key === viewerKeyOf(s)) || {};
        res.writeHead(403, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'banned', reason: b.reason || '' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ ok: true, admin: s.admin, name: s.name, kind: s.kind || 'discord', profile: s.kind === 'account' ? accountResponse(s.accountUsername) : null }));
}

function jsonReply(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
       .end(JSON.stringify(body));
}

function sessionFromBody(body) {
    return getSession(typeof body.session === 'string' ? body.session : '');
}

function validateAvatar(file) {
    if (!file || typeof file !== 'object') return null;
    const name = typeof file.name === 'string' ? file.name.toLowerCase() : '';
    const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
    const ext = name.endsWith('.png') ? 'png' : name.endsWith('.webp') ? 'webp' : name.endsWith('.gif') ? 'gif' : '';
    const expected = { png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
    if (!ext || type !== expected || typeof file.data !== 'string' || file.data.length > Math.ceil(PROFILE_MAX_BYTES * 4 / 3) + 16) return null;
    let buf;
    try { buf = Buffer.from(file.data, 'base64'); } catch { return null; }
    if (!buf.length || buf.length > PROFILE_MAX_BYTES) return null;
    const png = ext === 'png' && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const gif = ext === 'gif' && (buf.subarray(0, 6).toString() === 'GIF87a' || buf.subarray(0, 6).toString() === 'GIF89a');
    const webp = ext === 'webp' && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
    return (png || gif || webp) ? { ext, type, data: buf.toString('base64') } : null;
}

async function handleProfile(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body;
    try { body = JSON.parse(await readBody(req, PROFILE_MAX_BYTES * 2)); } catch { jsonReply(res, 400, { error: 'bad profile payload' }); return; }
    const session = sessionFromBody(body);
    if (!session || session.kind !== 'account' || !session.accountUsername) {
        jsonReply(res, 403, { error: 'only arena accounts can edit profiles' }); return;
    }
    const username = session.accountUsername;
    const profile = accounts[username]?.profile || {};
    if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
        if (typeof body.displayName !== 'string') { jsonReply(res, 400, { error: 'bad display name' }); return; }
        const displayName = cleanSafe(body.displayName, 32);
        if (!displayName) { jsonReply(res, 400, { error: 'display name cannot be empty' }); return; }
        profile.displayName = displayName;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'bio')) {
        if (typeof body.bio !== 'string') { jsonReply(res, 400, { error: 'bad bio' }); return; }
        profile.bio = cleanSafe(body.bio, 160);
    }
    if (body.avatar === null) profile.avatar = null;
    else if (Object.prototype.hasOwnProperty.call(body, 'avatar')) {
        const avatar = validateAvatar(body.avatar);
        if (!avatar) { jsonReply(res, 400, { error: 'profile picture must be a valid png, webp, or gif under 2 MB' }); return; }
        profile.avatar = avatar;
    }
    accounts[username].profile = profile;
    accountsDirty = true;
    saveAccounts();
    refreshAccountSessions(username);
    jsonReply(res, 200, { profile: accountResponse(username) });
}

function handleProfilePic(req, res) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const username = new URL(req.url, 'http://x').searchParams.get('u') || '';
    if (!/^[A-Za-z0-9_-]{3,24}$/.test(username) || !accounts[username]?.profile?.avatar) {
        res.writeHead(404).end(); return;
    }
    const avatar = accounts[username].profile.avatar;
    const type = { png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[avatar.ext];
    if (!type) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(avatar.data, 'base64'),
        'Cache-Control': 'public, max-age=3600, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
    }).end(Buffer.from(avatar.data, 'base64'));
}

async function handleToken(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (!CLIENT_ID || !CLIENT_SECRET) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'discord credentials not configured' }));
        return;
    }
    let code;
    try {
        const parsed = JSON.parse(await readBody(req));
        code = typeof parsed.code === 'string' ? parsed.code : null;
    } catch { code = null; }
    if (!code || code.length > 512) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ error: 'bad code' }));
        return;
    }
    try {
        // Exactly the four fields Discord documents for the activity flow. No
        // redirect_uri: the RPC authorize never used one, so sending it here
        // would only produce an invalid_grant mismatch.
        const body = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'authorization_code',
            code,
        });
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

// ── Containers: joinable desktops, no addresses on the wire ──────────────────
//
// A small registry (desktop/containers.json) of desktops a viewer can join.
// The client only ever receives an id and a same-origin path or a public
// hostname — never an IP and never a raw wss link. Anything that looks like an
// address is dropped HERE, server-side; the client is not trusted to filter.
const CONTAINERS_FILE = process.env.ARENA_CONTAINERS_FILE || path.join(__dirname, 'desktop', 'containers.json');
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const JOIN_RE = /^(?:desktop|https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[^\s]*)?|\/[a-z0-9._~\/-]*)$/i;

// Containers are just games with kind:"container" — the agent reports them and
// the launcher switches to them exactly like a game. Joining one is therefore a
// VOTE for everyone (one shared screen), not a private overlay or a new tab.
function handleContainers(req, res) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    // Local containers: games tagged kind=container (the launcher launches them).
    const list = (gameList || [])
        .filter((g) => g && g.kind === 'container')
        .map((g) => ({
            id: String(g.id || '').slice(0, 40),
            name: String(g.name || g.id || '').slice(0, 60),
            system: String(g.system || '').slice(0, 40),
            desc: String(g.desc || '').slice(0, 160),
            game: String(g.id || '').slice(0, 40),   // vote target = the launcher id
            online: g.id === currentGame ? true : null,
        }))
        .filter((c) => c.id && c.game);
    // Self-hosted nodes register THEMSELVES; expired ones drop off on their own.
    // name/desc/games come FROM THE NODE, never hardcoded here.
    for (const [id, n] of Object.entries(liveNodes())) {
        list.push({
            id: 'node:' + id,
            name: n.name,
            system: n.system || 'self-hosted',
            desc: n.desc || '',
            game: null,
            vnc: !!(n.vnc && n.vnc.port),
            online: true,
        });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
       .end(JSON.stringify({ containers: list }));
}

// ── Self-hosted nodes: boxes register THEMSELVES, nothing hardcoded ─────────
// A node (any machine the owner points at the arena) runs a tiny agent that
// detects its own hardware/games and posts them here every minute. Entries
// expire if the heartbeat stops, so a dead box vanishes from the list on its
// own. Name + description come FROM THE NODE, not from this server.
const NODES_FILE = process.env.ARENA_NODES_FILE || '/data/nodes.json';
const NODE_SECRET_FILE = process.env.ARENA_NODE_SECRET_FILE || '/data/node-secret';
const NODE_TTL_MS = Number(process.env.ARENA_NODE_TTL_MS || 5 * 60 * 1000);

function loadNodes() {
    try { return JSON.parse(fs.readFileSync(NODES_FILE, 'utf8')); } catch { return {}; }
}
function saveNodes(nodes) {
    try {
        fs.mkdirSync(path.dirname(NODES_FILE), { recursive: true });
        const tmp = NODES_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(nodes));
        fs.renameSync(tmp, NODES_FILE);
    } catch (err) { console.warn('[arena] node save failed:', err.message); }
}
function nodeSecret() {
    try { return fs.readFileSync(NODE_SECRET_FILE, 'utf8').trim(); } catch { return ''; }
}
function liveNodes() {
    const nodes = loadNodes();
    const now = Date.now();
    const out = {};
    for (const [id, n] of Object.entries(nodes)) {
        if (n.lastSeen && now - n.lastSeen < NODE_TTL_MS) out[id] = n;
    }
    return out;
}

async function handleNodeRegister(req, res) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = {};
    try { body = JSON.parse(await readBody(req, 16 * 1024)); } catch { res.writeHead(400).end(); return; }
    const secret = nodeSecret();
    const ok = secret && typeof body.secret === 'string' && body.secret.length === secret.length &&
        crypto.timingSafeEqual(Buffer.from(body.secret), Buffer.from(secret));
    if (!ok) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'forbidden' })); return; }
    const id = String(body.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
    if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'bad id' })); return; }
    const nodes = loadNodes();
    nodes[id] = {
        name: cleanSafe(body.name || id, 60) || id,
        system: cleanSafe(body.system || 'self-hosted', 40),
        desc: cleanSafe(body.desc || '', 200),
        games: Array.isArray(body.games) ? body.games.slice(0, 24).map((g) => ({
            name: cleanSafe(g && g.name || '', 60),
            system: cleanSafe(g && g.system || '', 40),
        })).filter((g) => g.name) : [],
        vnc: (body.vnc && Number(body.vnc.port) > 0 && Number(body.vnc.port) < 65536)
            ? { host: '127.0.0.1', port: Number(body.vnc.port) }   // relay-side: always loopback
            : null,
        lastSeen: Date.now(),
    };
    saveNodes(nodes);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, ttl: NODE_TTL_MS }));
}

// ── Direct VNC for containers (the "main arena" VNC pipeline, reused) ────────
// A viewer's own browser runs noVNC against the vnc-backend relay: the relay
// opens raw RFB to the target its server-minted token names. Same-origin, no
// address on the wire, no browser-in-browser, no re-encode.
const VNC_TARGETS_FILE = process.env.ARENA_VNC_TARGETS_FILE || '/data/vnc-targets.json';
const VNC_SECRET_FILE = process.env.ARENA_VNC_SECRET_FILE || '/data/vnc-secret';

function containerGateway() {
    // The arena's X display lives INSIDE this container, so the host's services
    // are reached via the default gateway (parse /proc/net/route).
    try {
        const lines = fs.readFileSync('/proc/net/route', 'utf8').split('\n');
        for (const line of lines) {
            const f = line.trim().split(/\s+/);
            if (f.length > 3 && f[1] === '00000000') {
                const hex = f[2];
                const ip = [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.');
                return ip;
            }
        }
    } catch {}
    return '';
}

async function handleVncToken(req, res) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    const session = getSession(q.get('s') || '');
    if (!session) { res.writeHead(401).end(); return; }
    if (isBanned(viewerKeyOf(session))) { res.writeHead(403).end(); return; }
    let targets = {};
    try { targets = JSON.parse(fs.readFileSync(VNC_TARGETS_FILE, 'utf8')); } catch {}
    const gameId = (q.get('game') || '').slice(0, 40);
    let t = targets[gameId];
    if (!t && gameId.startsWith('node:')) {
        const n = liveNodes()[gameId.slice(5)];
        if (n && n.vnc) t = n.vnc;
    }
    if (!t || !t.host || !t.port) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no VNC target for that container' })); return; }
    let secret = '';
    try { secret = fs.readFileSync(VNC_SECRET_FILE, 'utf8').trim(); } catch {}
    if (!secret) { res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'vnc relay not configured' })); return; }
    const gw = containerGateway();
    if (!gw) { res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no route to relay' })); return; }
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(`http://${gw}:8002/vncapi/target`, {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret, host: String(t.host), port: Number(t.port) }),
        });
        clearTimeout(timer);
        const j = await r.json();
        if (!r.ok || !j.token) { res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: j.error || 'relay refused' })); return; }
        // Same-origin wrapper: title bar + back link, noVNC in an iframe.
        const url = `/novnc/arena.html?path=randomws&token=${encodeURIComponent(j.token)}&autoconnect=1&resize=scale&game=${encodeURIComponent(gameId)}`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
           .end(JSON.stringify({ url }));
    } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String((err && err.message) || err).slice(0, 120) }));
    }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/api/token' || url === '/.proxy/api/token') return handleToken(req, res);
    if (url === '/api/check' || url === '/.proxy/api/check') return handleCheck(req, res);
    if (url === '/api/containers' || url === '/.proxy/api/containers') return handleContainers(req, res);
    if (url === '/api/vnc-token' || url === '/.proxy/api/vnc-token') return handleVncToken(req, res);
    if (url === '/api/node/register' || url === '/.proxy/api/node/register') return handleNodeRegister(req, res);
    if (url === '/api/profile' || url === '/.proxy/api/profile') return handleProfile(req, res);
    if (url === '/api/profile-pic' || url === '/.proxy/api/profile-pic') return handleProfilePic(req, res);
    if (url === '/api/register' || url === '/.proxy/api/register') return handleAccount(req, res, true);
    if (url === '/api/login' || url === '/.proxy/api/login') return handleAccount(req, res, false);
    if (url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            ok: true, host: hostAlive, viewers: viewers.size,
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
    let sid = '';
    if (isView) {
        if (viewers.size >= MAX_VIEWERS) { socket.destroy(); return; }
        sid = new URL(req.url, 'http://x').searchParams.get('s') || '';
        session = getSession(sid);
        if (!session) {
            if (!ALLOW_GUEST) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            session = { discordId: null, name: 'Guest', avatar: null, admin: false };
        }
        // Bans are absolute: no socket, no stream, no reconnect. The client can
        // never argue its way past this — the key comes from the verified session.
        if (isBanned(viewerKeyOf(session))) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        if (isHost) attachHost(ws); else attachViewer(ws, session, sid);
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
        if (msg.t === 'games') {
            gameList = Array.isArray(msg.list) ? msg.list : [];
            if (typeof msg.current !== 'undefined') currentGame = msg.current;
            broadcastJson(gameStateSnapshot());
        }
        else if (msg.t === 'current') {
            currentGame = msg.id || null;
            broadcastJson(gameStateSnapshot());
        }
        else if (msg.t === 'vconfig') { videoConfig = msg.config || null; broadcastJson({ t: 'vconfig', config: videoConfig }); }
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
// A viewer's id comes from nextId() and id is what roster/merge/gamestate key
// on. A tab that drops and reconnects (network blip, Discord iframe reload,
// the 1.5s reconnect loop) would otherwise show up as a BRAND NEW viewer every
// time: count flickers, the roster churns, and a vote-heavy room can flood
// itself with churn. Sessions get a 30s identity-reuse window so reconnects
// re-join as the SAME viewer — quiet instead of spammy.
const viewerIdsBySession = new Map();   // sessionId -> { id, at }

function attachViewer(ws, session, sid) {
    let v = null;
    if (sid) {
        const prev = viewerIdsBySession.get(sid);
        if (prev && Date.now() - prev.at < 30000 && viewers.has(prev.id)) {
            v = viewers.get(prev.id);
            try { v.ws.close(4000, 'replaced'); } catch {}
            v.ws = ws;
        }
    }
    if (!v) {
        v = {
            id: nextId(),
            ws,
            // All four come from the server's own verified session. The client
            // is never asked, so it can never lie — including about admin.
            name: session.name,
            bio: session.bio || '',
            discordId: session.discordId,
            avatar: session.avatar,
            avatarUrl: session.avatarUrl || null,
            accountUsername: session.accountUsername || null,
            admin: session.admin,
            key: viewerKeyOf(session),
            consented: isConsented(viewerKeyOf(session)),
            keys: new Set(),
            keysAt: 0,
            lastChat: 0,
            joinedAt: Date.now(),
            guildId: null,
        };
        if (sid) viewerIdsBySession.set(sid, { id: v.id, at: Date.now() });
    }
    viewers.set(v.id, v);
    wireViewer(v, sid);
}

function wireViewer(v, sid) {
    const ws = v.ws;
    send(v, {
        t: 'welcome',
        you: { id: v.id, admin: v.admin, name: v.name },
        viewers: viewers.size,
        host: hostAlive,
        video: videoConfig,
        audio: audioConfig,
        rules: { version: RULES_VERSION, consented: !!v.consented },
    });
    // No consent, no game: the client must show the rules and opt in before any
    // input, chat or vote will be accepted.
    if (!v.consented) send(v, { t: 'consentRequired', version: RULES_VERSION });
    send(v, gameStateSnapshot());
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
        // A replaced socket (identity reuse) must not clean up the viewer the
        // new socket now owns. Only the CURRENT socket may delete it.
        if (v.ws !== ws) return;
        viewers.delete(v.id);
        if (sid) viewerIdsBySession.delete(sid);
        // A leaver's vote must stop counting, or a switch can never reach a
        // majority of a room that has since emptied out.
        gameVotes.delete(v.id);
        broadcastJson(gameStateSnapshot());
        broadcastRoster();
    });
    ws.on('error', () => {});
}

function handleViewerMsg(v, msg) {
    if (!msg || typeof msg.t !== 'string') return;

    // Consent gate. Until the rules are accepted (including the AI-moderation
    // opt-in) a viewer may only talk about consent — every other frame is
    // dropped and they are told why.
    if (!v.consented && msg.t !== 'consent' && msg.t !== 'hello' && msg.t !== 'needkey') {
        send(v, { t: 'consentRequired', version: RULES_VERSION });
        return;
    }

    switch (msg.t) {
        case 'consent': {
            if (msg.rules !== RULES_VERSION || msg.ai !== true) {
                send(v, { t: 'consentDenied', reason: 'AI moderation opt-in is required to play' });
                return;
            }
            v.consented = true;
            setConsent(v.key, true);
            send(v, { t: 'consentOk', version: RULES_VERSION });
            broadcastRoster();
            break;
        }
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
            // A blocked viewer is silent. Tell them once every few seconds so
            // they can read why, but nothing they press ever reaches the game.
            const block = activeBlock(v.key);
            if (block) {
                if (!v.lastBlockNotice || Date.now() - v.lastBlockNotice > 4000) {
                    v.lastBlockNotice = Date.now();
                    send(v, { t: 'blocked', until: block.until, reason: block.reason });
                }
                v.keys = new Set();
                return;
            }
            const next = new Set();
            // The admin gets the WHOLE keyboard, not the allowlist. Identity
            // here comes from the server's own OAuth check against a
            // compile-time id, so this cannot be claimed by a client.
            if (v.admin) {
                for (const k of msg.keys.slice(0, 24)) {
                    if (typeof k === 'string' && k.length <= 24) next.add(k);
                }
            } else {
                // A d-pad tops out around 4; a keyboard with modifiers held plus
                // several game keys legitimately runs higher.
                for (const k of msg.keys.slice(0, 16)) if (VALID_KEYS.has(k)) next.add(k);
            }
            v.keys = next;
            v.keysAt = Date.now();
            break;
        }
        case 'admin': {
            // Override the vote entirely. Same verified-identity gate.
            if (!v.admin) return;
            if (msg.action === 'launch' && typeof msg.id === 'string') {
                gameVotes.clear();
                switchCooldownUntil = 0;
                currentGame = msg.id;
                sendHost({ t: 'launch', id: msg.id });
                const name = (gameList.find((g) => g.id === msg.id) || {}).name || msg.id;
                broadcastJson({ t: 'notice', text: `${v.name} (admin) launched ${name}` });
                broadcastJson(gameStateSnapshot());
            } else if (msg.action === 'stop') {
                gameVotes.clear();
                switchCooldownUntil = 0;
                currentGame = null;
                sendHost({ t: 'stop' });
                broadcastJson({ t: 'notice', text: `${v.name} (admin) stopped the game` });
                broadcastJson(gameStateSnapshot());
            } else if (msg.action === 'players') {
                send(v, playerList());
            } else if ((msg.action === 'ban' || msg.action === 'block') && typeof msg.target === 'string') {
                const tkey = resolveTargetKey(msg.target);
                if (!tkey) { send(v, { t: 'notice', text: 'no such player' }); return; }
                const reason = String(msg.reason || '').slice(0, 120);
                const target = [...viewers.values()].find((x) => viewerKey(x) === tkey);
                if (msg.action === 'ban') {
                    if (!isBanned(tkey)) {
                        bans.entries.push({ key: tkey, reason, at: Date.now(), by: v.name });
                        persistBans();
                    }
                    if (target) { try { send(target, { t: 'banned', reason }); } catch {} try { target.ws.close(4003, 'banned'); } catch {} }
                    broadcastJson({ t: 'notice', text: `${v.name} (admin) banned a player` });
                } else {
                    const until = setBlock(tkey, msg.minutes, reason || 'blocked by admin', v.name);
                    if (target) { send(target, { t: 'blocked', until, reason: reason || 'blocked by admin' }); target.keys = new Set(); }
                    send(v, { t: 'notice', text: `blocked for ${humanLeft(until)}` });
                }
                send(v, playerList());
            } else if ((msg.action === 'unban' || msg.action === 'unblock') && typeof msg.target === 'string') {
                const tkey = resolveTargetKey(msg.target);
                if (!tkey) { send(v, { t: 'notice', text: 'no such player' }); return; }
                if (msg.action === 'unban') { bans.entries = bans.entries.filter((b) => b.key !== tkey); persistBans(); }
                else blocks.delete(tkey);
                send(v, { t: 'notice', text: 'cleared' });
                send(v, playerList());
            }
            break;
        }
        case 'chat': {
            const now = Date.now();
            if (now - v.lastChat < CHAT_MIN_GAP_MS) return;
            v.lastChat = now;
            const block = activeBlock(v.key);
            if (block) { send(v, { t: 'blocked', until: block.until, reason: block.reason }); return; }
            const text = cleanSafe(String(msg.text || '').slice(0, CHAT_MAX_LEN));
            if (!text) return;
            broadcastJson({
                t: 'chat', from: v.name, admin: v.admin, text,
                discordId: v.discordId, avatar: v.avatar,
            });
            // "Full words" only: a real word (3+ letters) is worth a model call,
            // "lol" / emoji are not — this keeps the moderator off the hot path
            // for the noise, and its verdicts are cached anyway.
            if (!(MOD_SKIP_ADMIN && v.admin) && /[A-Za-z]{3,}/.test(text)) {
                const sender = v;
                moderateText(text).then((verdict) => {
                    if (!verdict || !verdict.bad) return;
                    if (!viewers.has(sender.id)) return;         // they already left
                    const reason = 'AI moderation: ' + (verdict.reason || 'flagged content');
                    const until = setBlock(sender.key, MOD_BLOCK_MINUTES, reason, 'AI');
                    sender.keys = new Set();
                    send(sender, { t: 'blocked', until, reason });
                    broadcastJson({ t: 'notice', text: `AI moderation flagged ${sender.name} — inputs blocked for ${humanLeft(until)}` });
                    for (const a of viewers.values()) {
                        if (a.admin) send(a, { t: 'modalert', name: sender.name, text, reason: verdict.reason || '', until });
                    }
                }).catch(() => {});
            }
            break;
        }
        case 'gamevote': {
            if (activeBlock(v.key)) { send(v, { t: 'blocked', until: activeBlock(v.key).until, reason: activeBlock(v.key).reason }); return; }
            const choice = typeof msg.game === 'string' ? msg.game.slice(0, 40) : null;
            if (choice) castGameVote(v, choice);
            break;
        }
        case 'mouse': {
            // Last mover wins. A union merge makes no sense for a pointer —
            // averaging positions would just park it in the middle of the
            // screen whenever two people move at once.
            const now = Date.now();
            if (now - lastMouseAt < 33) return;      // ~30Hz is plenty
            lastMouseAt = now;
            const x = typeof msg.x === 'number' ? Math.max(0, Math.min(1, msg.x)) : undefined;
            const y = typeof msg.y === 'number' ? Math.max(0, Math.min(1, msg.y)) : undefined;
            const buttons = Array.isArray(msg.buttons)
                ? msg.buttons.filter((b) => b === 1 || b === 2 || b === 3).slice(0, 3) : [];
            const wheel = msg.wheel === 'up' || msg.wheel === 'down' ? msg.wheel : undefined;
            sendHost({ t: 'mouse', x, y, buttons, wheel });
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
        users.push({ id: v.id, name: v.name, bio: v.bio || '', admin: v.admin, discordId: v.discordId, avatar: v.avatar, avatarUrl: v.avatarUrl || null });
    }
    broadcastJson({ t: 'roster', count: users.length, users: users.slice(0, 60) });
}

// ── The controller merge — the actual "everyone controls Mario" ──────────────
function mergeInputs(active) {
    // Any held key from anybody is held. That is the whole game: chaotic,
    // instant, and one person alone can still move Mario when nobody else is on.
    const out = new Set();
    for (const v of active) for (const k of v.keys) out.add(k);
    return out;
}


// Rising-edge throttle on the MERGED controller.
//
// A press is only honoured if the key has been released for long enough. Holding
// Start is still fine — it stays down as long as somebody holds it — but
// releasing and re-pressing it faster than the cooldown does nothing. That is
// the difference between "pause the game" and "strobe the pause menu".
const lastPressAt = new Map();
const wasHeld = new Set();

function throttleSpammyKeys(held, adminHeld) {
    const now = Date.now();
    for (const [key, cooldownMs] of RATE_LIMITED) {
        if (!held.has(key)) { wasHeld.delete(key); continue; }
        if (wasHeld.has(key)) continue;              // already down: let it stay down
        const last = lastPressAt.get(key) || 0;
        if (now - last < cooldownMs) { held.delete(key); continue; }   // too soon
        lastPressAt.set(key, now);
        wasHeld.add(key);
    }
    return held;
}

setInterval(() => {
    const now = Date.now();
    const active = [];
    for (const v of viewers.values()) {
        // A viewer who stopped sending input is treated as holding nothing, so a
        // rage-quit or a frozen tab can't pin Mario against a wall forever.
        if (now - v.keysAt > INPUT_STALE_MS) v.keys = new Set();
        // Blocked or not-yet-consented viewers contribute NOTHING to the merge.
        if (!v.consented || activeBlock(v.key)) v.keys = new Set();
        active.push(v);
    }
    const held = throttleSpammyKeys(mergeInputs(active));
    // Keys held by an admin are passed through the agent's safety filter
    // untouched — that filter exists to stop the crowd escaping the session,
    // not to stop the owner using their own machine.
    const adminKeys = new Set();
    for (const v of active) if (v.admin) for (const k of v.keys) adminKeys.add(k);
    for (const k of adminKeys) held.add(k);

    const serialized = [...held].sort().join(',');
    if (serialized !== lastSentKeys) {
        lastSentKeys = serialized;
        sendHost({ t: 'input', keys: [...held], adminKeys: [...adminKeys] });
        // Let everyone see what the hive mind actually did with their press.
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
                    `${(stats.bytes / secs / 1024).toFixed(0)} KiB/s | host=${hostAlive}`);
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
    console.log(`   moderation: heuristics on${MOD_KEY ? ', ai endpoint configured' : ', no ai key (heuristics only)'}`);
});
