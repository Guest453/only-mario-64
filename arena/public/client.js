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

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');

let ws = null;
let mode = 'anarchy';
let hostUp = false;
let audioUnlocked = false;
let discord = null;
let myVote = null;   // 'yes' | 'no' | null, for the current vote only

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

function decodeVideo(kind, timestamp, payload) {
    if (!videoDecoder || videoDecoder.state !== 'configured') return;
    const isKey = kind === KIND.VKEY;
    if (waitingForKeyframe && !isKey) return;   // deltas before a keyframe = guaranteed error
    if (isKey) waitingForKeyframe = false;
    try {
        videoDecoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data: payload }));
    } catch { waitingForKeyframe = true; }
}

// ── Audio ────────────────────────────────────────────────────────────────────
let audioCtx = null;
let audioDecoder = null;
let playHead = 0;
const JITTER_S = 0.10;

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
            if (!audioUnlocked || !audioCtx) { audioData.close(); return; }
            try {
                const channels = audioData.numberOfChannels;
                const frames = audioData.numberOfFrames;
                const buf = audioCtx.createBuffer(channels, frames, audioData.sampleRate);
                for (let c = 0; c < channels; c++) {
                    const tmp = new Float32Array(frames);
                    audioData.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
                    buf.copyToChannel(tmp, c);
                }
                const src = audioCtx.createBufferSource();
                src.buffer = buf;
                src.connect(audioCtx.destination);
                const now = audioCtx.currentTime;
                if (playHead < now + 0.01) playHead = now + JITTER_S;  // re-anchor after a stall
                src.start(playHead);
                playHead += buf.duration;
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

function unlockAudio() {
    if (audioUnlocked) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        audioUnlocked = true;
        playHead = 0;
        $('btn-sound').textContent = '🔊';
    } catch (err) { console.warn('[arena] audio unlock failed', err); }
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
    const code = KEYMAP[e.code];
    if (!code) return;
    e.preventDefault();
    if (!e.repeat) pressKey(code, true);
});
window.addEventListener('keyup', (e) => {
    if (isTyping(e)) return;
    const code = KEYMAP[e.code];
    if (!code) return;
    e.preventDefault();
    pressKey(code, false);
});
// Losing focus mid-press would leave a key stuck down forever, and in anarchy
// one stuck key pins Mario against a wall for everybody.
window.addEventListener('blur', () => {
    if (myKeys.size) { myKeys.clear(); sendInput(); paintMyKeys(); }
});
// The server expires held keys after ~2.5s of silence; keep them alive.
setInterval(() => { if (myKeys.size > 0) sendInput(); }, 500);

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

// ── Chrome collapse ──────────────────────────────────────────────────────────
// Discord panels can be tiny; the pad and chat suffocate the game. This hides
// all of it. The keyboard keeps working, so it is a real playing mode.
function setChrome(on) {
    document.body.dataset.chrome = on ? 'on' : 'off';
    $('btn-chrome').textContent = on ? '⤢' : '⤡';
    $('btn-chrome').title = on ? 'Hide the controls and chat' : 'Show the controls and chat';
    try { localStorage.setItem('arena_chrome', on ? 'on' : 'off'); } catch {}
}

// ── Vote UI ──────────────────────────────────────────────────────────────────
let voteEndsAt = 0;

function showVote(v) {
    if (!v.open) {
        $('vote').classList.add('hidden');
        myVote = null;
        if (typeof v.passed === 'boolean') {
            addSystem(v.passed
                ? `vote passed — ${String(v.mode).toUpperCase()} mode`
                : `vote failed — staying in ${mode.toUpperCase()}`);
        }
        return;
    }
    $('vote').classList.remove('hidden');
    $('vote-title').textContent = `switch to ${String(v.mode).toUpperCase()}?`;
    $('vote-by').textContent = v.by || 'someone';
    $('vote-yes-n').textContent = v.yes.length;
    $('vote-no-n').textContent = v.no.length;
    $('vote-needed').textContent = v.needed;
    renderFaces($('vote-yes-faces'), v.yes, 20);
    renderFaces($('vote-no-faces'), v.no, 20);
    voteEndsAt = v.endsAt || 0;
    $('vote-yes').classList.toggle('cast', myVote === 'yes');
    $('vote-no').classList.toggle('cast', myVote === 'no');
}

setInterval(() => {
    if ($('vote').classList.contains('hidden') || !voteEndsAt) return;
    const left = Math.max(0, Math.ceil((voteEndsAt - Date.now()) / 1000));
    $('vote-timer').textContent = left + 's';
}, 250);

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

function setMode(next) {
    mode = next;
    $('modepill').textContent = String(next).toUpperCase();
    $('modepill').style.background = next === 'democracy' ? 'rgba(77,163,255,.28)' : 'rgba(255,216,61,.24)';
}

// ── Connection ───────────────────────────────────────────────────────────────
function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The Activity is configured with a ROOT url mapping (/ -> this origin), so
    // the iframe is served from <app_id>.discordsays.com and every request —
    // WebSocket upgrades included — is proxied same-origin. No /.proxy prefix:
    // that is only for extra mappings, and would point at a path Discord never
    // mapped.
    return `${proto}//${location.host}/ws`;
}

function connect() {
    setStatus('connecting…');
    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        setStatus('waiting for the game…');
        ws.send(JSON.stringify({
            t: 'hello',
            name: (discord && discord.detectedName) || 'Guest',
            discordId: (discord && discord.userId) || null,
            avatar: (discord && discord.avatar) || null,
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
                setMode(msg.mode);
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
            case 'vote': showVote(msg); break;
            case 'mode': setMode(msg.mode); break;
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

    // Start collapsed if the panel is small or the player asked for it last time.
    let chrome = 'on';
    try { chrome = localStorage.getItem('arena_chrome') || 'on'; } catch {}
    if (window.innerWidth < 480 || window.innerHeight < 380) chrome = 'off';
    setChrome(chrome === 'on');
    $('btn-chrome').addEventListener('click', () => setChrome(document.body.dataset.chrome !== 'on'));

    // Calling a vote proposes the OTHER mode — there are only two.
    $('btn-vote').addEventListener('click', () => {
        if (!ws || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ t: 'modevote', mode: mode === 'anarchy' ? 'democracy' : 'anarchy' }));
    });
    $('vote-yes').addEventListener('click', () => {
        myVote = 'yes';
        ws && ws.send(JSON.stringify({ t: 'votecast', yes: true }));
        $('vote-yes').classList.add('cast'); $('vote-no').classList.remove('cast');
    });
    $('vote-no').addEventListener('click', () => {
        myVote = 'no';
        ws && ws.send(JSON.stringify({ t: 'votecast', yes: false }));
        $('vote-no').classList.add('cast'); $('vote-yes').classList.remove('cast');
    });

    const chatInput = $('chatinput');
    chatInput.addEventListener('keydown', (e) => {
        e.stopPropagation();   // never let chat typing reach the controller
        if (e.key === 'Enter' && chatInput.value.trim()) {
            ws && ws.send(JSON.stringify({ t: 'chat', text: chatInput.value.trim() }));
            chatInput.value = '';
        }
    });

    // Identity first, so the very first hello carries a real name and avatar.
    try { discord = await initDiscordActivity(); } catch (err) { console.warn('[arena] discord init failed', err); }
    connect();
})();
