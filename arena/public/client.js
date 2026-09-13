// ─────────────────────────────────────────────────────────────────────────────
// MARIO ARENA — viewer client.
//
// This is the whole thing every player downloads. There is no sm64.wasm here and
// no emulator: the game runs on the server and this page decodes its video and
// forwards your button presses into a global pile.
//
// Everyone who opens this — in any Discord server, any voice channel — is
// pressing buttons on the SAME Mario at the SAME time.
// ─────────────────────────────────────────────────────────────────────────────

import { initDiscordActivity } from './discord-activity.js';

const KIND = { VCONF: 1, VKEY: 2, VDELTA: 3, ACONF: 4, ACHUNK: 5 };

// Versioned like every other asset — Cloudflare rewrites our cache headers, so
// an unversioned worklet would sit stale for hours after a deploy.
const AUDIO_WORKLET_URL = (() => {
    const m = document.querySelector('script[type=module]');
    const v = m && m.src.includes('?v=') ? m.src.split('?v=')[1] : '';
    return './audio-worklet.js' + (v ? '?v=' + v : '');
})();

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');

let ws = null;
let hostUp = false;
let audioUnlocked = false;
let discord = null;
let isAdmin = false;
let consented = false;
let banned = false;
let banReason = '';
let rulesVersion = 1;
let myProfile = null;

// ── Site-account session ─────────────────────────────────────────────────────
// Discord gives us a session id from the SDK. On the plain web there is no SDK,
// so the login/register form minted one and we keep it here in the same shape
// (a bearer string). Both hit the same socket and the same /api/check.
const SESSION_KEY = 'arena_session';
function storedSession() {
    try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}
function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
}

function setMyProfile(profile) {
    myProfile = profile || null;
    const btn = $('btn-profile');
    if (btn) btn.classList.toggle('hidden', !(myProfile && myProfile.username));
}

async function loadMyProfile() {
    const sid = storedSession();
    if (!sid) return;
    try {
        const r = await fetch(`./api/check?s=${encodeURIComponent(sid)}`);
        const data = await r.json();
        if (r.ok && data.kind === 'account') setMyProfile(data.profile);
    } catch {}
}

function openProfile() {
    if (!myProfile) return;
    $('profile-name').value = myProfile.displayName || myProfile.username;
    $('profile-bio').value = myProfile.bio || '';
    $('profile-modal').classList.remove('hidden');
    $('profile-modal').setAttribute('aria-hidden', 'false');
}

function closeProfile() {
    $('profile-modal').classList.add('hidden');
    $('profile-modal').setAttribute('aria-hidden', 'true');
}

async function saveProfile() {
    const btn = $('profile-save'), error = $('profile-error');
    error.classList.add('hidden'); btn.disabled = true; btn.textContent = 'saving…';
    try {
        const file = $('profile-avatar').files[0];
        let avatar;
        if (file) {
            if (!['image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 2 * 1024 * 1024) throw new Error('choose a png, webp, or gif under 2 MB');
            const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(file); });
            avatar = { name: file.name, type: file.type, data };
        }
        const body = { session: storedSession(), displayName: $('profile-name').value, bio: $('profile-bio').value };
        if (avatar) body.avatar = avatar;
        const r = await fetch('./api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json.error || `save failed (${r.status})`);
        setMyProfile(json.profile); closeProfile();
        addSystem('profile updated');
    } catch (e) { error.textContent = String(e.message || e).slice(0, 200); error.classList.remove('hidden'); }
    finally { btn.disabled = false; btn.textContent = 'save profile'; }
}
function mySession() {
    if (discord && discord.session) return discord.session;
    return storedSession();
}

function profileImage(user) {
    if (user && typeof user.avatarUrl === 'string' && /^\/api\/profile-pic\?u=[A-Za-z0-9_-]{3,24}$/.test(user.avatarUrl)) return user.avatarUrl;
    return '';
}

// ── Identity rendering ───────────────────────────────────────────────────────
// The server only ever sends a Discord id + avatar HASH, never a URL, so a
// hostile client can't make everyone's browser fetch an arbitrary origin.
// We build the CDN link here and fall back to initials if it won't load
// (no avatar set, or Discord's CSP blocking the CDN inside the activity).
function avatarEl(user, size = 18) {
    const initials = document.createElement('span');
    initials.className = 'av initials';
    initials.style.width = initials.style.height = size + 'px';
    const name = (user && user.name) || '?';
    initials.textContent = name.slice(0, 2).toUpperCase();
    // Stable colour per person so faces stay recognisable between rounds.
    const seed = String((user && user.discordId) || name);
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
    initials.style.background = `hsl(${h} 65% 62%)`;
    initials.title = name;

    // Discord id and avatar hash are server-supplied (session + roster), but a
    // hostile relay can't be trusted to keep them clean: an avatar hash that
    // isn't exactly `[a-z0-9_]` never produces a working URL, and only a
    // numeric id can — the regexes are the last word, not the API.
    const discId = /^\d{5,25}$/.test(String(user && user.discordId)) ? String(user.discordId) : '';
    const hash = /^[a-z0-9_]+$/i.test(String(user && user.avatar)) ? String(user.avatar) : '';
    const localAvatar = profileImage(user);
    if (localAvatar) {
        const img = document.createElement('img'); img.className = 'av'; img.style.width = img.style.height = size + 'px'; img.alt = name; img.title = name; img.src = localAvatar;
        img.addEventListener('error', () => { img.replaceWith(initials); }, { once: true }); return img;
    }
    if (!discId || !hash) return initials;

    const img = document.createElement('img');
    img.className = 'av';
    img.style.width = img.style.height = size + 'px';
    img.alt = name;
    img.title = name;
    const ext = hash.startsWith('a_') ? 'gif' : 'png';
    img.src = `https://cdn.discordapp.com/avatars/${discId}/${hash}.${ext}?size=64`;
    img.addEventListener('error', () => { img.replaceWith(initials); }, { once: true });
    return img;
}

function renderFaces(container, users, size = 18, max = 8) {
    container.textContent = '';
    for (const u of users.slice(0, max)) container.appendChild(avatarEl(u, size));
    if (users.length > max) {
        const more = document.createElement('span');
        more.className = 'av initials';
        more.style.width = more.style.height = size + 'px';
        more.style.background = '#2b3147';
        more.style.color = '#e8ecf8';
        more.textContent = '+' + (users.length - max);
        container.appendChild(more);
    }
}

// ── Video ────────────────────────────────────────────────────────────────────
let videoDecoder = null;
let waitingForKeyframe = true;

function b64ToBuf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function configureVideo(config) {
    if (!config || !config.codec) return;
    try { if (videoDecoder && videoDecoder.state !== 'closed') videoDecoder.close(); } catch {}

    const decoderConfig = {
        codec: config.codec,
        codedWidth: config.codedWidth || 640,
        codedHeight: config.codedHeight || 480,
        optimizeForLatency: true,
    };
    if (config.description) decoderConfig.description = b64ToBuf(config.description);

    try {
        const support = await VideoDecoder.isConfigSupported(decoderConfig);
        if (!support || !support.supported) { setStatus(`this browser can't decode ${config.codec}`); return; }
    } catch { /* older builds lack isConfigSupported; just try */ }

    videoDecoder = new VideoDecoder({
        output: (videoFrame) => {
            if (canvas.width !== videoFrame.displayWidth || canvas.height !== videoFrame.displayHeight) {
                canvas.width = videoFrame.displayWidth;
                canvas.height = videoFrame.displayHeight;
            }
            ctx.drawImage(videoFrame, 0, 0);
            videoFrame.close();
            setStatus('');
        },
        error: () => { waitingForKeyframe = true; },
    });
    videoDecoder.configure(decoderConfig);
    waitingForKeyframe = true;
    // Configuring is async, so any keyframe already pushed to us is gone. Ask
    // for a fresh one — the difference between an instant picture and 2s black.
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'needkey' }));
}

// If a viewer's machine (or tab) can't keep up, decoded frames pile up and the
// stream drifts permanently behind — you end up watching the past with no way
// to catch up, which is worse than a visible skip. Above this depth we stop
// feeding deltas and wait for the next keyframe, which snaps back to live.
const MAX_DECODE_QUEUE = 6;

function decodeVideo(kind, timestamp, payload) {
    if (!videoDecoder || videoDecoder.state !== 'configured') return;
    const isKey = kind === KIND.VKEY;
    if (!isKey && videoDecoder.decodeQueueSize > MAX_DECODE_QUEUE) {
        waitingForKeyframe = true;   // drop to live at the next keyframe
        return;
    }
    if (waitingForKeyframe && !isKey) return;   // deltas before a keyframe = guaranteed error
    if (isKey) waitingForKeyframe = false;
    try {
        videoDecoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data: payload }));
    } catch { waitingForKeyframe = true; }
}

// ── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
let audioDecoder = null;
let audioNode = null;      // AudioWorkletNode running the ring buffer

async function configureAudio(config) {
    if (!config || !config.codec) return;
    try { if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close(); } catch {}
    const decoderConfig = {
        codec: config.codec,
        sampleRate: config.sampleRate || 48000,
        numberOfChannels: config.numberOfChannels || 2,
    };
    if (config.description) decoderConfig.description = b64ToBuf(config.description);

    audioDecoder = new AudioDecoder({
        output: (audioData) => {
            // Hand raw samples to the ring buffer. No per-packet scheduling:
            // that is what made playback chop at every 20ms boundary.
            if (!audioNode) { audioData.close(); return; }
            try {
                const chans = [];
                for (let c = 0; c < audioData.numberOfChannels; c++) {
                    const tmp = new Float32Array(audioData.numberOfFrames);
                    audioData.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
                    chans.push(tmp);
                }
                // Transfer the backing buffers rather than copying them again.
                audioNode.port.postMessage({ type: 'samples', channels: chans },
                    chans.map((c) => c.buffer));
            } catch { /* a dropped audio packet is not worth a stack trace */ }
            audioData.close();
        },
        error: () => {},
    });
    audioDecoder.configure(decoderConfig);
}

function decodeAudio(timestamp, payload) {
    if (!audioDecoder || audioDecoder.state !== 'configured') return;
    try { audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: payload })); } catch {}
}

let audioStarting = false;
async function unlockAudio() {
    if (audioUnlocked || audioStarting) return;
    audioStarting = true;
    try {
        // Match the stream's rate exactly. Letting the context run at 44.1kHz
        // while Opus decodes at 48kHz makes the browser resample every packet,
        // which is both wasteful and another source of boundary artefacts.
        const Ctor = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctor({ sampleRate: 48000, latencyHint: 'interactive' });
        await audioCtx.audioWorklet.addModule(AUDIO_WORKLET_URL);
        audioNode = new AudioWorkletNode(audioCtx, 'arena-player', {
            numberOfInputs: 0,
            outputChannelCount: [2],
            processorOptions: { channels: 2, targetMs: 120, maxMs: 400, ringSeconds: 2 },
        });
        audioNode.connect(audioCtx.destination);
        await audioCtx.resume();
        audioUnlocked = true;
        $('btn-sound').textContent = '🔊';
    } catch (err) {
        console.warn('[arena] audio unlock failed', err);
        audioStarting = false;
    }
}

// ── Input ────────────────────────────────────────────────────────────────────
const KEYMAP = {
    ArrowUp: 'ArrowUp', KeyW: 'ArrowUp',
    ArrowDown: 'ArrowDown', KeyS: 'ArrowDown',
    ArrowLeft: 'ArrowLeft', KeyA: 'ArrowLeft',
    ArrowRight: 'ArrowRight', KeyD: 'ArrowRight',
    KeyX: 'KeyX', KeyK: 'KeyX',          // A — jump
    KeyC: 'KeyC', KeyJ: 'KeyC',          // B — dive / punch
    Space: 'Space', ShiftLeft: 'Space',  // Z — crouch / ground pound
    Enter: 'Enter',                      // Start
    KeyQ: 'KeyQ', KeyE: 'KeyE',          // L / R triggers (GBA, SNES)
};

// Games whose layouts live and die by the FULL keyboard (FNF charts, the XFCE
// desktop). When one of these is running, every viewer's keys go up RAW — no
// KEYMAP funnel — and the on-screen pad is replaced by a live keyboard strip.
const KEYBOARD_LAYOUTS = new Set(['rhythm', 'desktop']);
let kbMode = false;

// Admin-only comfort toggle: make WASD act as the d-pad for ME while every
// other key still passes through raw. Persisted, because preferences outlive
// sessions.
const WASD_AS_ARROWS = { KeyW: 'ArrowUp', KeyA: 'ArrowLeft', KeyS: 'ArrowDown', KeyD: 'ArrowRight' };
let wasdArrows = false;
function loadWasdPref() {
    try { wasdArrows = localStorage.getItem('arena_wasd') === '1'; } catch {}
}
function applyWasdBtn() {
    const btn = $('btn-wasd');
    if (!btn) return;
    btn.classList.toggle('on', wasdArrows);
    btn.title = wasdArrows ? 'WASD currently acts as arrows (click to unbind)' : 'Bind WASD to the d-pad for you only';
}
function toggleWasd() {
    wasdArrows = !wasdArrows;
    try { localStorage.setItem('arena_wasd', wasdArrows ? '1' : '0'); } catch {}
    applyWasdBtn();
    // Held keys were routed under the old mapping — release them all rather
    // than guess. The server's stale-input expiry mops up anything lingering.
    if (myKeys.size) { myKeys.clear(); sendInput(); paintMyKeys(); }
}

// The ONE place a physical key becomes a wire code.
//   admin            → raw code (whole keyboard), with the WASD toggle folded in
//   keyboard-mode    → raw code for EVERYONE (FNF charts need letters, not arrows)
//   classic pad game → the mapped buttons only
function routeKey(raw) {
    if (isAdmin) return (wasdArrows && WASD_AS_ARROWS[raw]) ? WASD_AS_ARROWS[raw] : raw;
    if (kbMode) return raw;
    return KEYMAP[raw];
}

function updateKbMode() {
    const game = (gameState.games || []).find((g) => g.id === gameState.current);
    const want = KEYBOARD_LAYOUTS.has(game && game.layout);
    if (want === kbMode) return;
    // Mode flips invalidate whatever is held under the old mapping — release
    // everything so a stuck W doesn't become a stuck arrow (or vice versa).
    kbMode = want;
    document.body.dataset.kb = kbMode ? 'on' : 'off';
    if (myKeys.size) { myKeys.clear(); sendInput(); paintMyKeys(); }
    renderKbHeld([]);
}

const myKeys = new Set();

function sendInput() {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'input', keys: [...myKeys] }));
}

function pressKey(code, down) {
    if (!code) return;
    const had = myKeys.has(code);
    if (down) myKeys.add(code); else myKeys.delete(code);
    if (myKeys.has(code) !== had) { sendInput(); paintMyKeys(); }
}

function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
}

window.addEventListener('keydown', (e) => {
    if (isTyping(e)) return;
    const code = routeKey(e.code);
    if (!code) return;
    e.preventDefault();
    if (!e.repeat) pressKey(code, true);
});
window.addEventListener('keyup', (e) => {
    if (isTyping(e)) return;
    const code = routeKey(e.code);
    if (!code) return;
    e.preventDefault();
    pressKey(code, false);
});
// Losing focus mid-press would leave a key stuck down forever, and one stuck
// key pins Mario against a wall for everybody.
window.addEventListener('blur', () => {
    if (myKeys.size) { myKeys.clear(); sendInput(); paintMyKeys(); }
});
// The server expires held keys after ~2.5s of silence; keep them alive.
setInterval(() => { if (myKeys.size > 0) sendInput(); }, 500);

// ── Pointer ──────────────────────────────────────────────────────────────────
// Desktop mode needs a mouse, and so do emulator menus. Coordinates are sent
// NORMALISED so the server never has to know how big the client's canvas is.
//
// The canvas is object-fit: contain, so the video is letterboxed inside the
// element — the pointer has to be mapped through those bars or every click
// lands offset.
const mouseButtons = new Set();

function videoCoords(ev) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height || !canvas.width || !canvas.height) return null;
    const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
    const vw = canvas.width * scale, vh = canvas.height * scale;
    const ox = r.left + (r.width - vw) / 2, oy = r.top + (r.height - vh) / 2;
    const x = (ev.clientX - ox) / vw, y = (ev.clientY - oy) / vh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;   // in the letterbox
    return { x, y };
}

function sendMouse(extra) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ t: 'mouse', buttons: [...mouseButtons], ...extra }));
}

canvas.addEventListener('pointermove', (e) => {
    const c = videoCoords(e);
    if (c) sendMouse(c);
});
canvas.addEventListener('pointerdown', (e) => {
    unlockAudio();
    const c = videoCoords(e);
    if (!c) return;
    e.preventDefault();
    mouseButtons.add(e.button === 1 ? 2 : e.button === 2 ? 3 : 1);
    sendMouse(c);
});
canvas.addEventListener('pointerup', (e) => {
    mouseButtons.delete(e.button === 1 ? 2 : e.button === 2 ? 3 : 1);
    sendMouse(videoCoords(e) || {});
});
canvas.addEventListener('pointerleave', () => {
    if (mouseButtons.size) { mouseButtons.clear(); sendMouse({}); }
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());   // right-click is the game's
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    sendMouse({ wheel: e.deltaY < 0 ? 'up' : 'down' });
}, { passive: false });

function bindButton(el) {
    const code = el.dataset.key;
    const down = (e) => { e.preventDefault(); unlockAudio(); pressKey(code, true); el.classList.add('down'); };
    const up   = (e) => { e.preventDefault(); pressKey(code, false); el.classList.remove('down'); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('pointercancel', up);
}

function paintMyKeys() {
    document.querySelectorAll('[data-key]').forEach((el) => el.classList.toggle('mine', myKeys.has(el.dataset.key)));
}
// Prettify a KeyboardEvent code for the keyboard strip: "KeyW" → "W",
// "ArrowUp" → "↑", "Digit1" → "1", "F5" stays "F5".
function keyLabel(code) {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad') && code.length > 6) return 'N' + code.slice(6);
    const arrows = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
    if (arrows[code]) return arrows[code];
    return code;
}
function renderKbHeld(keys) {
    const strip = $('kbraw');
    if (!strip || document.body.dataset.kb !== 'on') return;
    strip.textContent = '';
    for (const k of (keys || []).slice(0, 18)) {
        const chip = document.createElement('span');
        chip.className = 'kbchip';
        chip.textContent = keyLabel(k);
        strip.appendChild(chip);
    }
}
function paintHeld(keys) {
    const set = new Set(keys);
    document.querySelectorAll('[data-key]').forEach((el) => el.classList.toggle('live', set.has(el.dataset.key)));
    renderKbHeld(keys);
}

// ── Panel toggles ────────────────────────────────────────────────────────────
// The on-screen pad and the chat column hide INDEPENDENTLY, and both start
// hidden. A Discord activity panel can be tiny, and a d-pad plus a chat column
// leave the game a postage stamp. The keyboard works whether or not the pad is
// shown, so "everything hidden" is a full playing mode.
function setPanel(name, on) {
    document.body.dataset[name] = on ? 'on' : 'off';
    const btn = $('btn-' + name);
    if (btn) btn.classList.toggle('on', on);
    try { localStorage.setItem('arena_' + name, on ? 'on' : 'off'); } catch {}
}

function togglePanel(name) {
    setPanel(name, document.body.dataset[name] !== 'on');
}

// ── Game picker ──────────────────────────────────────────────────────────────
// One vote each; a game switches on a strict majority of everyone connected.
// The list only contains games the agent reported as actually launchable, so a
// missing ROM never shows up as a broken vote.
let gameState = { current: null, games: [], votes: {}, needed: 0, cooldown: 0 };
let myGameVote = null;

function renderGames() {
    const list = $('games-list');
    list.textContent = '';
    $('games-needed').textContent = gameState.needed;
    $('games-total').textContent = $('count').textContent || '0';

    const rows = gameState.games.filter((g) => !g.hidden).map((g) => ({
        id: g.id,
        name: g.name,
        sub: g.system,
        current: g.id === gameState.current,
    }));
    // Stopping is a vote like any other — it is the only sanctioned way out of a
    // running game, since the desktop itself gives the crowd no exit.
    rows.push({ id: '__stop__', name: 'Stop the game', sub: 'back to idle', stop: true });

    for (const r of rows) {
        const row = document.createElement('div');
        row.className = 'game-row'
            + (r.current ? ' current' : '')
            + (r.stop ? ' stop' : '')
            + (myGameVote === r.id ? ' voted' : '');

        const label = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'g-name';
        name.textContent = r.name + (r.current ? '  ▶ now playing' : '');
        const sub = document.createElement('div');
        sub.className = 'g-sys';
        sub.textContent = r.sub;
        label.appendChild(name); label.appendChild(sub);

        const spacer = document.createElement('div');
        spacer.className = 'g-spacer';
        const votes = document.createElement('div');
        votes.className = 'g-votes';
        votes.textContent = `${gameState.votes[r.id] || 0} / ${gameState.needed}`;

        row.appendChild(label); row.appendChild(spacer); row.appendChild(votes);
        if (isAdmin) {
            const force = document.createElement('button');
            force.className = 'g-force';
            force.textContent = r.stop ? 'FORCE STOP' : 'FORCE';
            force.title = 'Admin: switch immediately, no vote';
            force.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (!ws || ws.readyState !== 1) return;
                ws.send(JSON.stringify(r.stop
                    ? { t: 'admin', action: 'stop' }
                    : { t: 'admin', action: 'launch', id: r.id }));
            });
            row.appendChild(force);
        }
        if (!r.current) {
            row.addEventListener('click', () => {
                myGameVote = r.id;
                if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'gamevote', game: r.id }));
                renderGames();
            });
        }
        list.appendChild(row);
    }

    const cool = $('games-cooldown');
    if (gameState.cooldown > 0) {
        cool.textContent = `just switched — voting reopens in ${Math.ceil(gameState.cooldown / 1000)}s`;
        cool.classList.remove('hidden');
    } else {
        cool.classList.add('hidden');
    }
}

// ── Chat / status ────────────────────────────────────────────────────────────
function setStatus(text) {
    $('status').textContent = text || '';
    $('status').classList.toggle('hidden', !text);
}

function addSystem(text) {
    const box = $('chatlog');
    const line = document.createElement('div');
    line.className = 'chatline system';
    line.textContent = text;
    box.appendChild(line);
    trimChat(box);
}

function addChat(user, text) {
    const box = $('chatlog');
    const line = document.createElement('div');
    line.className = 'chatline';
    line.appendChild(avatarEl(user, 18));
    const body = document.createElement('div');
    const who = document.createElement('span');
    who.className = 'who' + (user.admin ? ' admin' : '');
    who.textContent = (user.admin ? '⭐ ' : '') + user.name + ': ';
    body.appendChild(who);
    body.appendChild(document.createTextNode(text));
    line.appendChild(body);
    box.appendChild(line);
    trimChat(box);
}

function trimChat(box) {
    while (box.children.length > 80) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
}

// ── Connection ───────────────────────────────────────────────────────────────
function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const s = mySession();
    return `${proto}//${location.host}/ws${s ? `?s=${encodeURIComponent(s)}` : ''}`;
}

function connect() {
    setStatus('connecting…');
    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        setStatus('waiting for the game…');
        // Name, avatar and admin come from the server's verified session — the
        // client is not asked, and could not be trusted if it were.
        ws.send(JSON.stringify({
            t: 'hello',
            guildId: (discord && discord.guildId) || null,
        }));
    };

    ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
            const buf = new Uint8Array(ev.data);
            if (buf.length < 9) return;
            const kind = buf[0];
            const timestamp = new DataView(ev.data).getFloat64(1, true);
            const payload = buf.subarray(9);
            if (kind === KIND.VKEY || kind === KIND.VDELTA) decodeVideo(kind, timestamp, payload);
            else if (kind === KIND.ACHUNK) decodeAudio(timestamp, payload);
            return;
        }
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg.t) {
            case 'welcome':
                hostUp = msg.host;
                isAdmin = !!(msg.you && msg.you.admin);
                if (isAdmin) {
                    document.body.classList.add('is-admin');
                    $('btn-admin').classList.remove('hidden');
                    addSystem('admin mode: full keyboard, players panel, and you can force game switches');
                }
                if (msg.video) configureVideo(msg.video);
                if (msg.audio) configureAudio(msg.audio);
                if (!hostUp) setStatus('the game is booting…');
                // Rules first: nothing is accepted until the opt-in is signed.
                if (msg.rules) rulesVersion = msg.rules.version || rulesVersion;
                if (msg.rules && !msg.rules.consented) showConsent();
                else { consented = true; hideConsent(); }
                break;
            case 'consentRequired':
                if (msg.version) rulesVersion = msg.version;
                showConsent();
                break;
            case 'consentOk':
                consented = true;
                hideConsent();
                addSystem('rules accepted — pick what to play');
                // Straight into the main menu: don't wait for a gamestate tick.
                if (!hubSeen) { hubSeen = true; openHub(); }
                break;
            case 'consentDenied':
                $('consent-fail').textContent = msg.reason || 'AI moderation opt-in is required to play';
                $('consent-fail').classList.remove('hidden');
                break;
            case 'blocked':
                showBlocked(msg.until, msg.reason);
                break;
            case 'banned':
                showDead(msg.reason);
                break;
            case 'players':
                renderAdmin(msg.players || []);
                break;
            case 'modalert':
                addSystem(`⚠ AI moderation: ${msg.name} — ${msg.reason || 'flagged'} (blocked)`);
                break;
            case 'vconfig': configureVideo(msg.config); break;
            case 'aconfig': configureAudio(msg.config); break;
            case 'host':
                hostUp = msg.up;
                setStatus(hostUp ? '' : 'the game went down — it will come back');
                if (hostUp) waitingForKeyframe = true;
                break;
            case 'roster':
                $('count').textContent = msg.count;
                renderFaces($('roster-faces'), msg.users || [], 18, 5);
                break;
            case 'held': paintHeld(msg.keys || []); break;
            case 'gamestate':
                gameState = {
                    current: msg.current, games: msg.games || [],
                    votes: msg.votes || {}, needed: msg.needed || 0,
                    cooldown: msg.cooldown || 0,
                };
                if (msg.current !== undefined) myGameVote = null;
                updateKbMode();
                renderGames();
                if (!$('hub').classList.contains('hidden')) renderHub();
                if (consented && !hubSeen) { hubSeen = true; openHub(); }
                break;
            case 'notice': addSystem(msg.text); break;
            case 'chat':
                // The wire format calls the speaker `from`; avatarEl/addChat want
                // a user-shaped object with `name`. Passing msg straight through
                // rendered every line as "undefined:".
                addChat({
                    name: msg.from,
                    admin: msg.admin,
                    discordId: msg.discordId,
                    avatar: msg.avatar,
                }, msg.text);
                break;
            default: break;
        }
    };

    ws.onclose = () => {
        // Banned means dead: no reconnect, no matter what.
        if (banned) { showDead(banReason); return; }
        setStatus('reconnecting…');
        waitingForKeyframe = true;
        // Account sessions expire server-side (restart, TTL). If ours is gone,
        // drop it and park on the gate instead of looping on 401s forever.
        if (!(discord && discord.session) && storedSession()) {
            fetch(`./api/check?s=${encodeURIComponent(storedSession())}`)
                .then((r) => {
                    if (r.status === 403) { return r.json().then((d) => { banned = true; banReason = (d && d.reason) || ''; showDead(banReason); }).catch(() => {}); }
                    if (!r.ok) { clearSession(); showGate(discord); }
                })
                .catch(() => {});
        }
        setTimeout(connect, 1500);
    };
    ws.onerror = () => {};
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
    document.querySelectorAll('[data-key]').forEach(bindButton);
    paintMyKeys();

    $('btn-sound').addEventListener('click', unlockAudio);
    document.addEventListener('pointerdown', unlockAudio, { once: true });

    // Both default to HIDDEN — game first. A returning player's choice wins.
    for (const name of ['pad', 'chat']) {
        let saved = null;
        try { saved = localStorage.getItem('arena_' + name); } catch {}
        setPanel(name, saved === 'on');
        $('btn-' + name).addEventListener('click', () => togglePanel(name));
    }

    // Admin WASD↔arrows preference — restored, not re-asked.
    loadWasdPref();
    applyWasdBtn();
    $('btn-wasd').addEventListener('click', toggleWasd);

    $('btn-games').addEventListener('click', () => {
        $('games').classList.toggle('hidden');
        renderGames();
    });
    $('games-close').addEventListener('click', () => $('games').classList.add('hidden'));

    $('btn-hub').addEventListener('click', openHub);
    $('hub-close').addEventListener('click', closeHub);
    $('hub-watch').addEventListener('click', closeHub);

    $('btn-containers').addEventListener('click', () => {
        const panel = $('containers');
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) loadContainers();
    });
    $('containers-close').addEventListener('click', () => $('containers').classList.add('hidden'));

    $('btn-admin').addEventListener('click', () => {
        const panel = $('admin');
        if (panel.classList.contains('hidden')) openAdmin();
        else panel.classList.add('hidden');
    });
    $('admin-close').addEventListener('click', () => $('admin').classList.add('hidden'));
    $('admin-refresh').addEventListener('click', () => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin', action: 'players' }));
    });
    $('btn-profile').addEventListener('click', openProfile);
    $('profile-close').addEventListener('click', closeProfile);
    $('profile-save').addEventListener('click', saveProfile);

    const chatInput = $('chatinput');
    chatInput.addEventListener('keydown', (e) => {
        e.stopPropagation();   // never let chat typing reach the controller
        if (e.key === 'Enter' && chatInput.value.trim()) {
            ws && ws.send(JSON.stringify({ t: 'chat', text: chatInput.value.trim() }));
            chatInput.value = '';
        }
    });

    // Authenticate BEFORE anything else. Without a server-minted session the
    // socket refuses us, so there is no point opening it — show the gate and
    // stop.
    try {
        discord = await initDiscordActivity();
    } catch (err) {
        console.warn('[arena] discord init failed', err);
    }

    if (!discord || !discord.session) loadMyProfile();

    if (discord && discord.session) { connect(); return; }

    // Not signed in through Discord. A stored site-account session that the
    // server still recognises counts — anything else lands on the gate.
    const sid = storedSession();
    if (sid) {
        try {
            const r = await fetch(`./api/check?s=${encodeURIComponent(sid)}`);
            if (r.ok) { const d = await r.clone().json().catch(() => null); if (d?.kind === 'account') setMyProfile(d.profile); connect(); return; }
            if (r.status === 403) { const d = await r.json().catch(() => ({})); showDead(d && d.reason); return; }
        } catch {}
        clearSession();
    }
    showGate(discord);
})();

// ── Auth gate ────────────────────────────────────────────────────────────────
let gateWired = false;
let registerMode = false;

function setGateMode(register) {
    registerMode = register;
    $('tab-login').classList.toggle('active', !register);
    $('tab-register').classList.toggle('active', register);
    $('tab-login').setAttribute('aria-selected', String(!register));
    $('tab-register').setAttribute('aria-selected', String(register));
    $('gate-submit').textContent = register ? 'Create account' : 'Log in';
    $('gate-pass').setAttribute('autocomplete', register ? 'new-password' : 'current-password');
    $('gate-msg').textContent = register ? 'Create your account' : 'Log in to play';
    $('gate-hint').textContent = register
        ? 'username: 3-24 chars · letters, numbers, _ or - · password: 8+ characters'
        : 'password must be 8+ characters';
}

function showGate(d) {
    const msg = $('gate-msg');
    const form = $('gate-form');
    const sub = $('gate-sub');

    if (d && d.authError && d.active) {
        // We ARE in Discord but OAuth broke. The real reason on screen, retry
        // button available — the account fallback is pointless inside an
        // activity, so the form stays hidden.
        form.classList.add('hidden');
        msg.textContent = 'Discord sign-in failed.';
        const detail = $('gate-detail');
        detail.textContent = String(d.authError).slice(0, 200);
        detail.classList.remove('hidden');
        $('gate-retry').classList.remove('hidden');
        console.warn('[arena] gate reason:', d.authError);
    } else if (!d || !d.active) {
        // Plain browser: log in with an arena account or make one. No account,
        // no OAuth, no game — the socket stays closed either way.
        sub.textContent = 'Inside Discord? It signs you in automatically. On the web? Log in or make an arena account — no account, no game.';
        form.classList.remove('hidden');
        if (!gateWired) wireGate();
    } else {
        form.classList.add('hidden');
        msg.textContent = 'Sign in with Discord to play.';
        $('gate-retry').classList.remove('hidden');
    }
    $('gate-retry').addEventListener('click', () => location.reload(), { once: true });
    $('gate').classList.remove('hidden');
    setStatus('');
}

function gateFail(text) {
    const fail = $('gate-fail');
    fail.textContent = text;                 // textContent — the error can never be markup
    fail.classList.remove('hidden');
}

async function gateSubmit(ev) {
    if (ev) ev.preventDefault();
    const fail = $('gate-fail');
    fail.classList.add('hidden');
    $('gate-detail').classList.add('hidden');
    const btn = $('gate-submit');
    btn.disabled = true;
    btn.textContent = registerMode ? 'creating…' : 'signing in…';
    try {
        const r = await fetch(registerMode ? './api/register' : './api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: $('gate-user').value.trim(), password: $('gate-pass').value }),
        });
        const json = await r.json().catch(() => ({}));
        if (!r.ok || !json.session) {
            gateFail((json && json.error) || `sign-in failed (${r.status})`);
            return;
        }
        try { localStorage.setItem(SESSION_KEY, json.session); } catch {}
        await loadMyProfile();
        // THE important bit: the gate is a full-screen overlay. Login worked,
        // so it has to actually GO AWAY or the game sits invisible behind it.
        $('gate').classList.add('hidden');
        connect();
    } catch (err) {
        gateFail(String(err && err.message || 'network error').slice(0, 200));
    } finally {
        btn.disabled = false;
        btn.textContent = registerMode ? 'Create account' : 'Log in';
    }
}

function wireGate() {
    gateWired = true;
    $('tab-login').addEventListener('click', () => setGateMode(false));
    $('tab-register').addEventListener('click', () => setGateMode(true));
    $('gate-form').addEventListener('submit', gateSubmit);
    $('gate-eye').addEventListener('click', () => {
        const p = $('gate-pass');
        const show = p.type === 'password';
        p.type = show ? 'text' : 'password';
        $('gate-eye').textContent = show ? '🙈' : '👁';
    });
    setGateMode(false);
}

// ── Containers ───────────────────────────────────────────────────────────────
// Desktops a viewer can join. The server already stripped anything
// address-shaped: `join` is either a game id ("desktop") or a same-origin
// path / public hostname. Nothing here ever renders an IP or a raw wss link.
async function loadContainers() {
    const list = $('containers-list');
    list.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'games-cool';
    loading.textContent = 'looking for containers…';
    list.appendChild(loading);
    let containers = [];
    try {
        const r = await fetch('./api/containers', { cache: 'no-store' });
        const data = await r.json();
        containers = Array.isArray(data.containers) ? data.containers : [];
    } catch { /* fall through to the empty state */ }
    list.textContent = '';
    if (!containers.length) {
        const none = document.createElement('div');
        none.className = 'games-cool';
        none.textContent = 'no containers online right now';
        list.appendChild(none);
        return;
    }
    for (const c of containers) list.appendChild(containerRow(c));
}

function containerRow(c) {
    const row = document.createElement('div');
    row.className = 'game-row c-row';
    const label = document.createElement('div');
    label.className = 'c-info';
    const name = document.createElement('div');
    name.className = 'g-name';
    name.textContent = c.name;                       // textContent — never markup
    const sub = document.createElement('div');
    sub.className = 'g-sys';
    sub.textContent = c.system || 'container';
    label.appendChild(name); label.appendChild(sub);
    const side = document.createElement('div');
    side.className = 'c-side';
    const dot = document.createElement('span');
    dot.className = 'c-dot' + (c.online === true ? ' on' : c.online === false ? ' off' : '');
    dot.title = c.online === true ? 'online' : c.online === false ? 'offline' : 'unknown';
    const join = document.createElement('button');
    join.className = 'g-force';
    join.textContent = isAdmin ? 'FORCE' : 'JOIN';   // admins switch everyone instantly
    join.addEventListener('click', (ev) => { ev.stopPropagation(); joinContainer(c); });
    side.appendChild(dot); side.appendChild(join);
    row.appendChild(label); row.appendChild(side);
    return row;
}

function joinContainer(c) {
    if (!c || !c.game) return;
    $('containers').classList.add('hidden');
    // One shared screen: joining a container is a VOTE, exactly like a game
    // switch, so everyone sees the same thing. (A private overlay/new tab is
    // useless inside a Discord activity anyway.)
    if (ws && ws.readyState === 1) {
        if (isAdmin) ws.send(JSON.stringify({ t: 'admin', action: 'launch', id: c.game }));
        else ws.send(JSON.stringify({ t: 'gamevote', game: c.game }));
    }
    addSystem(isAdmin ? `switching everyone to ${c.name}` : `voted to switch everyone to ${c.name}`);
}
function closeContainerView() {
    $('container-frame').src = 'about:blank';
    $('container-view').classList.add('hidden');
    document.body.classList.remove('cv-open');
}

// ── Rules consent wall ───────────────────────────────────────────────────────
// Nothing works until this is signed — the server drops every frame until it
// sees a matching consent, so this is a real gate, not a nag screen.
let consentWired = false;
function showConsent() {
    consented = false;
    $('consent').classList.remove('hidden');
    if (!consentWired) wireConsent();
}
function hideConsent() { $('consent').classList.add('hidden'); }
function wireConsent() {
    consentWired = true;
    const box = $('consent-ai');
    const go = $('consent-go');
    box.addEventListener('change', () => { go.disabled = !box.checked; });
    go.addEventListener('click', () => {
        if (!box.checked) return;
        $('consent-fail').classList.add('hidden');
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'consent', rules: rulesVersion, ai: true }));
    });
}

// ── Blocked / banned ─────────────────────────────────────────────────────────
let blockedTimer = null;
function showBlocked(until, reason) {
    const el = $('blocked-banner');
    const mins = Math.max(1, Math.round((until - Date.now()) / 60000));
    el.textContent = `Your inputs have been blocked for ${mins} minute${mins === 1 ? '' : 's'}. Reason: ${reason || 'unspecified'}`;
    el.classList.remove('hidden');
    clearTimeout(blockedTimer);
    blockedTimer = setTimeout(() => el.classList.add('hidden'), Math.max(3000, until - Date.now()) + 500);
}
function showDead(reason) {
    banned = true;
    if (reason) banReason = reason;
    $('dead').classList.remove('hidden');
    $('dead-reason').textContent = banReason ? 'Reason: ' + banReason : '';
    setStatus('');
}

// ── Admin panel ──────────────────────────────────────────────────────────────
function openAdmin() {
    $('admin').classList.remove('hidden');
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin', action: 'players' }));
}
function adminAction(action, player) {
    if (!ws || ws.readyState !== 1) return;
    if (action === 'ban' || action === 'block') {
        let minutes = 10;
        if (action === 'block') {
            const m = window.prompt('Block inputs for how many minutes? (1-1440)', '10');
            if (m === null) return;
            minutes = Math.max(1, Math.min(1440, parseInt(m, 10) || 10));
        }
        const r = window.prompt(action === 'ban' ? 'Ban reason?' : 'Block reason?', '');
        if (r === null) return;
        ws.send(JSON.stringify({ t: 'admin', action, target: player.id, minutes, reason: r }));
    } else {
        ws.send(JSON.stringify({ t: 'admin', action, target: player.id }));
    }
}
function renderAdmin(players) {
    const list = $('admin-list');
    list.textContent = '';
    $('admin-sub').textContent = `${players.length} connected`;
    for (const p of players) list.appendChild(adminRow(p));
}
function adminRow(p) {
    const row = document.createElement('div');
    row.className = 'admin-row' + ((p.block || p.banned) ? ' blocked' : '');
    const label = document.createElement('div');
    label.style.flex = '1';
    const name = document.createElement('div');
    name.className = 'a-name';
    name.textContent = p.name + (p.admin ? ' ⭐' : '') + (p.consented ? '' : ' · no consent');
    const sub = document.createElement('div');
    sub.className = 'a-sub';
    sub.textContent = (p.username ? '@' + p.username : (p.discordId ? 'discord ' + p.discordId : 'guest'))
        + (p.banned ? ' · BANNED' : '')
        + (p.block ? ` · blocked ${p.block.minutesLeft}m (${p.block.reason})` : '');
    label.appendChild(name); label.appendChild(sub);
    row.appendChild(label);
    if (!p.admin) {
        const mk = (cls, text, act) => {
            const b = document.createElement('button');
            b.className = 'admin-btn ' + cls; b.textContent = text;
            b.addEventListener('click', () => adminAction(act, p));
            return b;
        };
        row.appendChild(p.banned ? mk('good', 'UNBAN', 'unban') : mk('danger', 'BAN', 'ban'));
        row.appendChild(p.block ? mk('good', 'UNBLOCK', 'unblock') : mk('', 'BLOCK', 'block'));
    }
    return row;
}


// ── Main menu (hub) ──────────────────────────────────────────────────────────
// Shown once on entry: containers on top, games below. Picking one casts the
// same vote a game switch uses, so EVERYONE ends up on the same screen.
let hubSeen = false;
function openHub() { renderHub(); $('hub').classList.remove('hidden'); }
function closeHub() { $('hub').classList.add('hidden'); }
function renderHub() {
    const cEl = $('hub-containers'), gEl = $('hub-games');
    if (!cEl || !gEl) return;
    cEl.textContent = ''; gEl.textContent = '';
    const all = gameState.games || [];
    const containers = all.filter((g) => g.kind === 'container');
    const games = all.filter((g) => !g.hidden && g.kind !== 'container');
    if (!containers.length) {
        const n = document.createElement('div'); n.className = 'hub-empty'; n.textContent = 'no containers online';
        cEl.appendChild(n);
    }
    for (const c of containers) cEl.appendChild(hubRow(c, true));
    for (const g of games) gEl.appendChild(hubRow(g, false));
}
function hubRow(g, isContainer) {
    const row = document.createElement('div');
    row.className = 'hub-row' + (gameState.current === g.id ? ' current' : '');
    const info = document.createElement('div'); info.className = 'hub-info';
    const name = document.createElement('div'); name.className = 'hub-name';
    name.textContent = g.name;                       // textContent — never markup
    const sys = document.createElement('div'); sys.className = 'hub-sys';
    sys.textContent = (g.system || '') + (gameState.current === g.id ? ' · now playing' : '');
    info.appendChild(name); info.appendChild(sys);
    const side = document.createElement('div'); side.className = 'hub-side';
    const votes = document.createElement('span'); votes.className = 'hub-votes';
    votes.textContent = `${gameState.votes[g.id] || 0}/${gameState.needed || 1}`;
    const btn = document.createElement('button');
    btn.className = 'hub-play' + (isAdmin ? ' force' : '');
    btn.title = isAdmin ? 'admin: switch everyone now, no vote' : '';
    btn.textContent = isAdmin ? 'FORCE'
        : (gameState.current === g.id ? 'WATCH' : (isContainer ? 'JOIN' : 'PLAY'));
    btn.addEventListener('click', () => pickFromHub(g));
    side.appendChild(votes); side.appendChild(btn);
    row.appendChild(info); row.appendChild(side);
    return row;
}
function pickFromHub(g) {
    if (ws && ws.readyState === 1) {
        // Admin: force it now, no vote. Everyone else: vote.
        if (isAdmin) ws.send(JSON.stringify({ t: 'admin', action: 'launch', id: g.id }));
        else ws.send(JSON.stringify({ t: 'gamevote', game: g.id }));
    }
    addSystem(isAdmin ? `forced everyone onto ${g.name}` : `voted to play ${g.name}`);
    closeHub();     // into the game UI
}
