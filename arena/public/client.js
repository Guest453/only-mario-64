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

    if (!user || !user.discordId || !user.avatar) return initials;

    const img = document.createElement('img');
    img.className = 'av';
    img.style.width = img.style.height = size + 'px';
    img.alt = name;
    img.title = name;
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    img.src = `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.${ext}?size=64`;
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
};

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
    // Admin: send the raw code for ANY key. Everyone else is limited to the
    // mapped game buttons, which the server re-checks anyway.
    const code = isAdmin ? (KEYMAP[e.code] || e.code) : KEYMAP[e.code];
    if (!code) return;
    e.preventDefault();
    if (!e.repeat) pressKey(code, true);
});
window.addEventListener('keyup', (e) => {
    if (isTyping(e)) return;
    const code = isAdmin ? (KEYMAP[e.code] || e.code) : KEYMAP[e.code];
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
function paintHeld(keys) {
    const set = new Set(keys);
    document.querySelectorAll('[data-key]').forEach((el) => el.classList.toggle('live', set.has(el.dataset.key)));
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

    const rows = gameState.games.map((g) => ({
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
    const s = discord && discord.session ? `?s=${encodeURIComponent(discord.session)}` : '';
    // The Activity is configured with a ROOT url mapping (/ -> this origin), so
    // the iframe is served from <app_id>.discordsays.com and every request —
    // WebSocket upgrades included — is proxied same-origin. No /.proxy prefix:
    // that is only for extra mappings, and would point at a path Discord never
    // mapped.
    return `${proto}//${location.host}/ws${s}`;
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
                    addSystem('admin mode: full keyboard, and you can force game switches');
                }
                if (msg.video) configureVideo(msg.video);
                if (msg.audio) configureAudio(msg.audio);
                if (!hostUp) setStatus('the game is booting…');
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
                renderGames();
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
        setStatus('reconnecting…');
        waitingForKeyframe = true;
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

    $('btn-games').addEventListener('click', () => {
        $('games').classList.toggle('hidden');
        renderGames();
    });
    $('games-close').addEventListener('click', () => $('games').classList.add('hidden'));

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
    // stop. No Discord auth, no game.
    try {
        discord = await initDiscordActivity();
    } catch (err) {
        console.warn('[arena] discord init failed', err);
    }

    if (!discord || !discord.session) {
        showGate(discord);
        return;
    }
    connect();
})();

function showGate(d) {
    const msg = $('gate-msg');
    if (!d || !d.active) {
        msg.textContent = 'Open this inside Discord to play.';
    } else if (d.authError) {
        msg.textContent = 'Discord sign-in failed.';
        // Show the real reason. Hiding it behind a generic message is what made
        // the first failure take a log dig to explain.
        const detail = $('gate-detail');
        detail.textContent = String(d.authError).slice(0, 200);
        detail.classList.remove('hidden');
        $('gate-retry').classList.remove('hidden');
        console.warn('[arena] gate reason:', d.authError);
    } else {
        msg.textContent = 'Sign in with Discord to play.';
        $('gate-retry').classList.remove('hidden');
    }
    $('gate-retry').addEventListener('click', () => location.reload(), { once: true });
    $('gate').classList.remove('hidden');
    setStatus('');
}
