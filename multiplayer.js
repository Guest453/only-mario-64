// Crowd control: EVERYONE in the room controls ONE Mario.
//
// Exactly one browser in a room runs the SM64 wasm — the HOST, elected by
// claiming the room's deterministic PeerJS id. Everyone else is a controller
// plus a viewer: their keypresses travel to the host over the PeerJS data
// channel, and the host's live canvas travels back over WebRTC video. The host
// merges every player's held keys into ONE virtual controller and replays it on
// its wasm (main.js `window.__sm64crowd`).
//
// Merge modes:
//   anarchy   — every key anybody holds is held. Total chaos, instant response.
//   democracy — the keys with the most votes win each tick. Slower, funnier.
//
// Stream lock: the only outbound media is #canvas.captureStream (no camera,
// mic, or screen). Inbound camera/screen/audio tracks are dropped. This is how
// we keep the room Mario-only — we set *what* is streamed, not a post-hoc filter.

function nickDefault() {
    try {
        const n = localStorage.getItem('sm64_nick');
        if (n) return n;
    } catch {}
    return 'Mario' + Math.floor(100 + Math.random() * 900);
}

function roomSlug(s) {
    return String(s || 'lobby').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'lobby';
}

function hostPeerId(room) {
    return 'sm64h' + roomSlug(room);
}

function randomRoom() {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// PeerJS already ships a sensible default STUN+TURN (the peerjs cloud). We must
// NOT pass `config.iceServers`, because that REPLACES PeerJS's whole set and
// would drop its cloud TURN servers — that makes NAT traversal worse, not
// better. Keep debug log level low; keep everything else peerjs-default.
function peerOpts() {
    return { debug: 0 };
}

function shrinkFrame(dataUrl) {
    return new Promise((resolve) => {
        if (!dataUrl) { resolve(null); return; }
        const img = new Image();
        img.onload = () => {
            const w = 240, h = Math.max(80, Math.round(img.height * (w / img.width)));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            try { resolve(c.toDataURL('image/jpeg', 0.45)); } catch { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

function gameCanvas() {
    // Only the original SM64 wasm canvas is ever allowed on the wire.
    // Custom ROM / EmulatorJS / any other element is not streamable.
    if (window.SM64JS_MODE) return null;
    const wrap = document.getElementById('original-game-container');
    if (wrap && wrap.style.display === 'none') return null;
    return document.getElementById('canvas');
}

function isGameLikeVideoTrack(track) {
    if (!track || track.kind !== 'video') return false;
    const label = String(track.label || '');
    if (/camera|webcam|microphone|headset|display|screen|window|monitor|\btab\b|facetime|droidcam|\bobs\b|virtual/i.test(label)) {
        return false;
    }
    let s = {};
    try { s = track.getSettings() || {}; } catch {}
    // Cameras expose facingMode / deviceId. Screen share exposes displaySurface.
    if (s.facingMode || s.deviceId || s.groupId) return false;
    if (s.displaySurface || s.cursor || s.logicalSurface) return false;
    return true;
}

function sanitizeInboundStream(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return null;
    for (const t of stream.getAudioTracks?.() || []) {
        try { t.stop(); } catch {}
        try { stream.removeTrack(t); } catch {}
    }
    const videos = stream.getVideoTracks?.() || [];
    if (videos.length !== 1 || !isGameLikeVideoTrack(videos[0])) {
        for (const t of videos) { try { t.stop(); } catch {} }
        return null;
    }
    return stream;
}

function acceptThumb(dataUrl) {
    if (typeof dataUrl !== 'string') return false;
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) return false;
    if (dataUrl.length < 32 || dataUrl.length > 120000) return false;
    return true;
}

// ── The shared controller ────────────────────────────────────────────────────
// Game key code -> the button face we draw in the HUD.
const BUTTONS = [
    { code: 'ArrowUp',    label: '↑' },
    { code: 'ArrowLeft',  label: '←' },
    { code: 'ArrowDown',  label: '↓' },
    { code: 'ArrowRight', label: '→' },
    { code: 'KeyX',       label: 'A' },
    { code: 'KeyC',       label: 'B' },
    { code: 'Space',      label: 'Z' },
    { code: 'Enter',      label: 'START' },
];
const BUTTON_LABEL = Object.fromEntries(BUTTONS.map(b => [b.code, b.label]));
const MERGE_MODES = ['anarchy', 'democracy'];

// A player whose last input packet is older than this is treated as holding
// nothing, so a disconnect mid-jump can't pin the button down for everyone.
const INPUT_TTL_MS = 3000;

// Discord Activities run inside a sandboxed iframe at <app>.discordsays.com.
// Their CSP only lets network requests out through Discord's proxy. PeerJS
// reaches the public broker over a raw WebSocket, which the proxy must route.
// The SDK exposes `patchUrlMappings` for exactly this. To enable it, register
// a "URL mapping" for your PeerJS/TURN broker in the Discord Developer Portal
// (e.g. prefix `/peerjs` -> `https://0.peerjs.com`), then set:
//     window.__SM64_PEERJS_PROXY = { prefix: '/peerjs', target: '0.peerjs.com' };
// Without that mapping PeerJS still works in a normal browser tab; inside
// Discord it degrades to the participant-presence roster below.
async function wireDiscordProxy(discord) {
    if (!discord?.active || !discord?.sdk) return;
    const cfg = window.__SM64_PEERJS_PROXY;
    if (!cfg || !cfg.prefix || !cfg.target) return;
    try {
        const mod = await import('./lib/discord-embedded-sdk.js');
        if (typeof mod.patchUrlMappings !== 'function') return;
        mod.patchUrlMappings(
            [{ prefix: cfg.prefix, target: cfg.target, prefixHost: window.location.host }],
            { patchWebSocket: true, patchFetch: true, patchXhr: true },
        );
        console.log('[MP] PeerJS signaling routed through Discord proxy', cfg);
    } catch (err) {
        console.warn('[MP] Discord proxy wiring failed', err);
    }
}

export function initMultiplayer({ discord } = {}) {
    const peers = new Map();
    const others = new Map();
    const calls = new Map();

    let peer = null;
    let role = 'idle';
    let room = 'lobby';
    let myId = '';
    let lastStatusAt = 0;
    let lastFrameAt = 0;
    let localStream = null;
    let streamRetry = null;

    // ── Crowd state ─────────────────────────────────────────────────────────
    // Host side: who is holding what, keyed by player id (the host is in here
    // too, under myId — it votes like everyone else).
    const inputs = new Map();
    let mergeMode = 'anarchy';
    let myHeld = [];
    let lastSentHeld = '';
    let appliedHeld = '';
    let mergeLoop = null;
    let lastTallyAt = 0;
    let lastTallyKey = '';
    // What the room is currently pressing, mirrored on every client for the HUD:
    // { code: [names…] }.
    let tally = {};
    let mergedHeld = [];
    // The host's live view, as seen by a client.
    let hostStream = null;
    let hostFrame = null;

    // The Discord display name. Prefer the CURRENT_USER_UPDATE user object; also
    // fall back to the buffered detectedName so we never show a random nick in
    // Discord, even if the event fired before this module mounted.
    const discordName = discord?.user?.global_name || discord?.user?.username || discord?.detectedName || null;
    let discordParticipants = Array.isArray(discord?.participants) ? discord.participants : [];
    const me = {
        name: discordName || nickDefault(),
        userId: discord?.userId || (discord?.user && (discord.user.id || null)) || null,
        thought: '',
        region: 'unknown',
        playing: false,
        stars: null,
        coins: null,
        lives: null,
        mode: '',
        frame: null,
        discord: !!discordName,
    };

    const $ = (id) => document.getElementById(id);
    const crowd = () => window.__sm64crowd || null;
    const inRoom = () => role === 'host' || role === 'client';

    function setStatus(text) {
        const el = $('mp-status');
        if (el) el.textContent = text;
    }

    function snapshot() {
        return {
            t: 'state',
            id: myId,
            name: me.name,
            thought: me.thought,
            region: me.region,
            playing: me.playing,
            stars: me.stars,
            coins: me.coins,
            lives: me.lives,
            mode: me.mode,
            discord: me.discord,
        };
    }

    function send(conn, msg) {
        try { if (conn?.open) conn.send(msg); } catch {}
    }

    function broadcast(msg, exceptId) {
        for (const [id, conn] of peers) {
            if (id === exceptId) continue;
            send(conn, msg);
        }
    }

    // ── Input plumbing ──────────────────────────────────────────────────────
    // Local keys (physical or on-screen) arrive here from main.js, which owns
    // the window-capture guard and therefore sees them first.
    function onLocalHeld(held) {
        myHeld = Array.isArray(held) ? held : [];
        const key = myHeld.slice().sort().join(',');
        if (key === lastSentHeld) return;
        lastSentHeld = key;
        if (role === 'host') {
            noteInput(myId, me.name, myHeld);
            mergeNow();
        } else if (role === 'client') {
            broadcast({ t: 'input', id: myId, name: me.name, held: myHeld });
        }
        renderPad();
    }

    function noteInput(id, name, held) {
        if (!id) return;
        const clean = (Array.isArray(held) ? held : [])
            .filter(c => BUTTON_LABEL[c])
            .slice(0, BUTTONS.length);
        inputs.set(id, { name: String(name || '???').slice(0, 24), held: clean, at: Date.now() });
    }

    // Fold every player's held keys into the one set Mario actually gets.
    function mergeHeld() {
        const now = Date.now();
        const votes = new Map();
        let voters = 0;
        for (const [id, v] of inputs) {
            if (now - v.at > INPUT_TTL_MS) { inputs.delete(id); continue; }
            if (v.held.length) voters++;
            for (const c of v.held) {
                if (!votes.has(c)) votes.set(c, []);
                votes.get(c).push(v.name);
            }
        }
        let held;
        if (mergeMode === 'democracy') {
            // Only the most-wanted buttons make it through. Ties all win, so
            // "up + A" still works when the room agrees on both.
            let max = 0;
            for (const arr of votes.values()) max = Math.max(max, arr.length);
            held = max ? [...votes.entries()].filter(([, a]) => a.length === max).map(([c]) => c) : [];
        } else {
            held = [...votes.keys()];
        }
        const t = {};
        for (const [c, names] of votes) t[c] = names;
        return { held, tally: t, voters };
    }

    // Host only: recompute, drive the wasm, and mirror the tally to everyone.
    function mergeNow(force) {
        if (role !== 'host') return;
        const r = mergeHeld();
        mergedHeld = r.held;
        tally = r.tally;
        const key = r.held.slice().sort().join(',');
        if (key !== appliedHeld) {
            appliedHeld = key;
            try { crowd()?.setHeld(r.held); } catch {}
        }
        const now = Date.now();
        if (force || key !== lastTallyKey || now - lastTallyAt > 700) {
            lastTallyKey = key;
            lastTallyAt = now;
            broadcast({ t: 'crowd', mode: mergeMode, tally, held: r.held, voters: r.voters });
        }
        renderPad();
    }

    function setMergeMode(next, fromPeer) {
        if (!MERGE_MODES.includes(next)) return;
        mergeMode = next;
        try { localStorage.setItem('sm64_merge_mode', mergeMode); } catch {}
        if (role === 'host') mergeNow(true);
        else if (role === 'client' && !fromPeer) broadcast({ t: 'mode', mode: mergeMode });
        renderPad();
        render();
    }

    // Crowd control is live whenever we're in a room: keys become votes on every
    // machine, including the host's.
    function setCrowdActive(on) {
        const c = crowd();
        if (!c) return;
        try { c.setGuard(!!on); } catch {}
        if (on) {
            try { c.onLocal(onLocalHeld); } catch {}
        } else {
            try { c.onLocal(null); c.releaseAll(); } catch {}
            inputs.clear();
            tally = {};
            mergedHeld = [];
            appliedHeld = '';
            lastSentHeld = '';
        }
        // Only the host's Mario is seen and heard. Everyone else keeps their own
        // wasm running silently so any of them can take over instantly if the
        // host closes the tab.
        try { c.setLocalAudio(role !== 'client'); } catch {}
        document.getElementById('app')?.classList.toggle('crowd-on', !!on);
        document.getElementById('app')?.classList.toggle('crowd-viewer', on && role === 'client');
        if (mergeLoop) { clearInterval(mergeLoop); mergeLoop = null; }
        if (on && role === 'host') mergeLoop = setInterval(() => mergeNow(), 120);
        renderPad();
    }

    // ── Media ───────────────────────────────────────────────────────────────
    function grabLocalStream() {
        // Only the host has anything to show; clients never publish media.
        if (role === 'client') return null;
        if (localStream && localStream.active) {
            for (const t of localStream.getAudioTracks()) {
                try { t.stop(); } catch {}
                try { localStream.removeTrack(t); } catch {}
            }
            return localStream;
        }
        const c = gameCanvas();
        if (!c || typeof c.captureStream !== 'function') return null;
        try {
            // Hard lock: the only thing PeerJS ever gets is this canvas.
            // No getUserMedia, no getDisplayMedia, no extra tracks.
            localStream = c.captureStream(30);
            for (const t of localStream.getAudioTracks()) {
                try { t.stop(); } catch {}
                try { localStream.removeTrack(t); } catch {}
            }
            for (const t of localStream.getVideoTracks()) {
                try { t.contentHint = 'motion'; } catch {}
            }
            return localStream;
        } catch (err) {
            console.warn('[MP] captureStream failed', err);
            return null;
        }
    }

    function dropUnsafeStream(remoteId, reason) {
        console.warn('[MP] blocked inbound stream', remoteId, reason);
        hostStream = null;
        try { calls.get(remoteId)?.close(); } catch {}
        renderStage();
        setStatus('Blocked a non-Mario stream (camera/screen/audio aren’t allowed)');
    }

    function setupCall(call, remoteId) {
        if (!call || calls.has(remoteId)) return;
        calls.set(remoteId, call);
        call.on('stream', (stream) => {
            const safe = sanitizeInboundStream(stream);
            if (!safe) {
                dropUnsafeStream(remoteId, 'not a Mario canvas');
                return;
            }
            // The only stream that matters is the host's shared Mario.
            if (role === 'client') hostStream = safe;
            renderStage();
            render();
        });
        call.on('close', () => {
            calls.delete(remoteId);
            if (role === 'client') hostStream = null;
            renderStage();
        });
        call.on('error', (e) => console.warn('[MP] call', e));
    }

    // The host pushes its canvas to every player; clients never call out.
    function maybeCall(remoteId) {
        if (!remoteId || remoteId === myId || calls.has(remoteId)) return;
        if (role !== 'host') return;
        const stream = grabLocalStream();
        if (!stream || !peer) return;
        try {
            setupCall(peer.call(remoteId, stream), remoteId);
        } catch (err) {
            console.warn('[MP] call out', err);
        }
    }

    function callEveryone() {
        if (role !== 'host') return;
        grabLocalStream();
        for (const id of others.keys()) maybeCall(id);
        for (const id of peers.keys()) maybeCall(id);
    }

    // ── Wire protocol ───────────────────────────────────────────────────────
    function onPeerMessage(fromId, msg) {
        if (!msg || typeof msg !== 'object') return;
        // The host is the hub: fan out anything peers need to agree on. Inputs
        // stop at the host (it publishes the merged tally instead), and a crowd
        // tally is host-authored, so neither is relayed.
        if (role === 'host' && !['hello', 'input', 'crowd', 'mode'].includes(msg.t)) {
            broadcast(msg, fromId);
        }

        if (msg.t === 'hello') {
            others.set(msg.id, { ...(others.get(msg.id) || {}), ...msg, updated: Date.now() });
            send(peers.get(fromId), snapshot());
            if (role === 'host') {
                send(peers.get(fromId), {
                    t: 'roster',
                    players: [snapshot(), ...[...others.values()].filter(p => p.id !== msg.id)],
                });
                if (me.frame) send(peers.get(fromId), { t: 'frame', id: myId, frame: me.frame });
                send(peers.get(fromId), { t: 'crowd', mode: mergeMode, tally, held: mergedHeld, voters: inputs.size });
            }
            maybeCall(msg.id);
            render();
            renderStage();
            return;
        }
        if (msg.t === 'roster' && Array.isArray(msg.players)) {
            for (const p of msg.players) {
                if (p.id && p.id !== myId) {
                    others.set(p.id, { ...(others.get(p.id) || {}), ...p, updated: Date.now() });
                }
            }
            render();
            renderStage();
            return;
        }
        if (msg.t === 'state' && msg.id && msg.id !== myId) {
            others.set(msg.id, { ...(others.get(msg.id) || {}), ...msg, updated: Date.now() });
            render();
            return;
        }
        // A controller telling the host what it's holding.
        if (msg.t === 'input') {
            if (role !== 'host') return;
            noteInput(msg.id || fromId, msg.name || others.get(fromId)?.name, msg.held);
            mergeNow();
            return;
        }
        // The host telling everyone what the room is pressing.
        if (msg.t === 'crowd') {
            if (role === 'host') return;
            if (MERGE_MODES.includes(msg.mode)) mergeMode = msg.mode;
            tally = (msg.tally && typeof msg.tally === 'object') ? msg.tally : {};
            mergedHeld = Array.isArray(msg.held) ? msg.held : [];
            renderPad();
            return;
        }
        if (msg.t === 'mode') {
            setMergeMode(msg.mode, true);
            if (role === 'host') broadcast({ t: 'crowd', mode: mergeMode, tally, held: mergedHeld, voters: inputs.size });
            return;
        }
        if (msg.t === 'frame' && msg.id && msg.id !== myId) {
            if (!acceptThumb(msg.frame)) return;
            hostFrame = msg.frame;
            renderStage();
            return;
        }
        if (msg.t === 'bye' && msg.id) {
            others.delete(msg.id);
            inputs.delete(msg.id);
            try { calls.get(msg.id)?.close(); } catch {}
            calls.delete(msg.id);
            if (role === 'host') mergeNow(true);
            render();
            renderStage();
        }
    }

    function attach(conn) {
        const pid = conn.peer;
        peers.set(pid, conn);
        conn.on('data', (msg) => onPeerMessage(pid, msg));
        conn.on('open', () => {
            send(conn, { t: 'hello', ...snapshot() });
            maybeCall(pid);
            // Re-announce our held keys to a host we just (re)connected to.
            lastSentHeld = '';
            onLocalHeld(crowd()?.localHeld?.() || []);
            setStatus(role === 'host'
                ? `Hosting “${room}” · ${peers.size + 1} on the pad`
                : `In “${room}”`);
        });
        conn.on('close', () => {
            peers.delete(pid);
            others.delete(pid);
            inputs.delete(pid);
            try { calls.get(pid)?.close(); } catch {}
            calls.delete(pid);
            if (role === 'host') mergeNow(true);
            // The host went away — try to take over the room ourselves.
            if (role === 'client' && pid === hostPeerId(room)) {
                hostStream = null;
                setStatus('Host left — taking over…');
                setTimeout(() => joinRoom(room), 400 + Math.floor(Math.random() * 1200));
            }
            render();
            renderStage();
        });
        conn.on('error', (e) => console.warn('[MP] conn', e));
    }

    function destroyPeer() {
        for (const c of calls.values()) { try { c.close(); } catch {} }
        calls.clear();
        try { peer?.destroy(); } catch {}
        peer = null;
        peers.clear();
        others.clear();
        inputs.clear();
        hostStream = null;
        role = 'idle';
        myId = '';
        setCrowdActive(false);
        renderStage();
    }

    function becomeHost(roomName) {
        return new Promise((resolve, reject) => {
            const hid = hostPeerId(roomName);
            const p = new window.Peer(hid, peerOpts());
            const fail = (err) => { clearTimeout(timer); try { p.destroy(); } catch {} reject(err); };
            // Never let an unreachable broker keep us "Joining" forever: if the
            // id isn't available, or the socket never opens, fall back to client
            // (or surface the error) rather than hanging.
            const timer = setTimeout(() => fail(new Error('broker timed out')), 6000);
            p.on('error', (err) => {
                // unavailable-id just means someone else hosts — fall back.
                if (err?.type === 'unavailable-id') { fail(err); return; }
                // Any other error (network/CSP/rejected) is fatal for hosting.
                console.warn('[MP] host peer', err);
                fail(err);
            });
            p.on('open', (id) => {
                clearTimeout(timer);
                peer = p;
                myId = id;
                role = 'host';
                room = roomName;
                p.on('connection', attach);
                p.on('call', (call) => {
                    // Answer with our canvas so late joiners still see Mario.
                    call.answer(grabLocalStream() || undefined);
                    setupCall(call, call.peer);
                });
                setCrowdActive(true);
                setStatus(`Hosting “${room}” — this machine runs Mario`);
                render();
                renderStage();
                resolve('host');
            });
            p.on('disconnected', () => console.warn('[MP] broker disconnected'));
        });
    }

    function becomeClient(roomName) {
        return new Promise((resolve, reject) => {
            const p = new window.Peer(undefined, peerOpts());
            const timer = setTimeout(() => { try { p.destroy(); } catch {} reject(new Error('broker timed out')); }, 6000);
            p.on('error', (err) => {
                clearTimeout(timer);
                console.warn('[MP] client peer', err);
                reject(err);
            });
            p.on('open', (id) => {
                clearTimeout(timer);
                peer = p;
                myId = id;
                role = 'client';
                room = roomName;
                // Controllers publish nothing — answer the host's call empty.
                p.on('call', (call) => {
                    call.answer(undefined);
                    setupCall(call, call.peer);
                });
                // The host registers its PeerJS id at broker connect time; if we
                // arrive first we get peer-unavailable. Retry a few times so both
                // auto-joining users reliably pair up.
                const hostId = hostPeerId(roomName);
                let attempts = 0;
                const tryConnect = () => {
                    const c = p.connect(hostId, { reliable: true });
                    attach(c);
                    c.on('error', (err) => {
                        if (err?.type === 'peer-unavailable' && attempts < 6) {
                            attempts++;
                            peers.delete(hostId);
                            try { c.close(); } catch {}
                            setTimeout(tryConnect, 800 * attempts);
                        } else {
                            console.warn('[MP] could not reach host', err);
                        }
                    });
                };
                tryConnect();
                setCrowdActive(true);
                setStatus(`Joined “${room}” — you're on the shared controller`);
                render();
                renderStage();
                resolve('client');
            });
        });
    }

    async function joinRoom(roomName) {
        if (typeof window.Peer !== 'function') {
            setStatus('PeerJS failed to load — refresh?');
            return;
        }
        if (discord?.active) await wireDiscordProxy(discord);
        roomName = roomSlug(roomName);
        const input = $('mp-room');
        if (input) input.value = roomName;
        try { localStorage.setItem('sm64_mp_room', roomName); } catch {}
        destroyPeer();
        setStatus(`Joining “${roomName}”…`);
        try {
            await becomeHost(roomName);
            grabLocalStream();
        } catch {
            try {
                await becomeClient(roomName);
            } catch (err) {
                // Inside Discord the public PeerJS broker is usually unreachable
                // without a registered proxy URL mapping; give a helpful hint.
                setStatus(discord?.active
                    ? 'Could not reach the room broker — inside Discord, register a PeerJS proxy URL mapping (see console).'
                    : 'Could not connect lobby: ' + (err?.message || err));
                console.warn('[MP] join failed', err);
            }
        }
        updateNametag();
    }

    function updateNametag() {
        const tag = $('local-nametag');
        if (!tag) return;
        tag.textContent = role === 'host'
            ? `${me.name || 'You'} · hosting Mario`
            : (me.name || 'You');
    }

    // ── The shared view ─────────────────────────────────────────────────────
    // The host shows its own canvas. Everyone else replaces it with the host's
    // live video, so the whole room is literally looking at one Mario.
    function renderStage() {
        const stage = $('remote-stage');
        const app = document.getElementById('app');
        const viewer = role === 'client';
        app?.classList.toggle('crowd-viewer', viewer);
        if (!stage) return;
        if (!viewer) {
            stage.hidden = true;
            stage.innerHTML = '';
            return;
        }
        stage.hidden = false;
        let pane = stage.querySelector('.remote-pane');
        if (!pane) {
            pane = document.createElement('div');
            pane.className = 'remote-pane shared';
            pane.innerHTML = [
                '<div class="rp-live">LIVE</div>',
                '<video autoplay playsinline muted></video>',
                '<img class="rp-thumb" alt="">',
            ].join('');
            stage.innerHTML = '';
            stage.appendChild(pane);
        }
        pane.classList.toggle('live', !!hostStream);
        const liveEl = pane.querySelector('.rp-live');
        liveEl.textContent = hostStream ? 'LIVE · shared Mario' : 'CONNECTING…';
        liveEl.classList.toggle('connecting', !hostStream);

        const vid = pane.querySelector('video');
        const img = pane.querySelector('.rp-thumb');
        vid.muted = true;
        vid.autoplay = true;
        vid.playsInline = true;
        vid.disablePictureInPicture = true;
        if (hostStream && vid.srcObject !== hostStream) {
            vid.srcObject = hostStream;
            vid.style.display = 'block';
            img.style.display = 'none';
            vid.play?.().catch(() => {});
        } else if (!hostStream) {
            vid.style.display = 'none';
            if (hostFrame) { img.src = hostFrame; img.style.display = 'block'; }
            else { img.removeAttribute('src'); img.style.display = 'block'; }
        }
    }

    // ── The crowd HUD: what the room is pressing, right now ─────────────────
    function renderPad() {
        const pad = $('crowd-pad');
        if (!pad) return;
        pad.hidden = !inRoom();
        if (!inRoom()) return;
        const mine = new Set(myHeld);
        const held = new Set(mergedHeld);
        for (const b of BUTTONS) {
            let el = pad.querySelector(`[data-code="${b.code}"]`);
            if (!el) {
                el = document.createElement('button');
                el.type = 'button';
                el.className = 'crowd-key k-' + b.code;
                el.dataset.code = b.code;
                el.innerHTML = `<span class="ck-face">${b.label}</span><span class="ck-n"></span>`;
                pad.querySelector('.crowd-keys')?.appendChild(el);
            }
            const votes = (tally[b.code] || []).length;
            el.classList.toggle('mine', mine.has(b.code));
            el.classList.toggle('won', held.has(b.code));
            el.classList.toggle('voted', votes > 0);
            el.title = votes ? (tally[b.code] || []).join(', ') : 'nobody';
            el.querySelector('.ck-n').textContent = votes ? String(votes) : '';
        }
        const modeEl = pad.querySelector('.crowd-mode');
        if (modeEl) modeEl.textContent = mergeMode === 'democracy' ? '🗳️ DEMOCRACY' : '🔥 ANARCHY';
        const whoEl = pad.querySelector('.crowd-who');
        if (whoEl) {
            const n = others.size + 1;
            whoEl.textContent = `${n} on the pad · ${role === 'host' ? 'you run the game' : 'host runs the game'}`;
        }
    }

    function card(p, isMe) {
        const held = (p.id && role === 'host' ? inputs.get(p.id)?.held : null) || [];
        const keys = held.map(c => `<b class="mini-key">${BUTTON_LABEL[c] || '?'}</b>`).join('') || '<span class="mini-idle">idle</span>';
        return `<article class="mp-card${isMe ? ' me' : ''}">
            <header><b>${esc(p.name || '???')}</b> <span>${p.host ? '🕹️ runs Mario' : '🎮 controller'}</span></header>
            <div class="mp-keys">${keys}</div>
        </article>`;
    }

    function render() {
        const grid = $('mp-grid');
        const dock = $('mp-dock');
        const list = [
            { ...me, id: myId || 'me', name: me.name + ' (you)', host: role === 'host' },
            ...[...others.values()]
                .map(p => ({ ...p, host: role === 'client' && p.id === hostPeerId(room) }))
                .sort((a, b) => String(a.name).localeCompare(String(b.name))),
        ];
        if (grid) {
            grid.innerHTML = list.map((p, i) => card(p, i === 0)).join('')
                || '<p class="mp-empty">Share the room code — everyone who joins presses the same buttons on the same Mario.</p>';
        }
        if (dock) {
            const othersList = [...others.values()];
            dock.classList.toggle('open', false);
            dock.innerHTML = '';
        }
        const count = $('mp-count');
        if (count) count.textContent = String(others.size + (inRoom() ? 1 : 0));
        // While nobody is peer-connected yet but Discord says friends share the
        // activity, surface that so the room doesn't look dead.
        const here = (!others.size && discordParticipants.length > 1)
            ? ` · ${discordParticipants.length} in activity`
            : '';
        if (role === 'host') setStatus(`Room “${room}” · ${others.size + 1} controlling Mario — you run the game${here}`);
        else if (role === 'client') setStatus(`Room “${room}” · ${others.size + 1} controlling Mario${here}`);
        renderPad();
        updateNametag();
    }

    function openLobby(on) {
        const p = $('mp-panel');
        if (!p) return;
        const open = on == null ? !p.classList.contains('open') : !!on;
        p.classList.toggle('open', open);
        $('mp-toggle-btn')?.classList.toggle('active', open);
    }

    function wireChrome() {
        const moreBtn = $('more-btn');
        const menu = $('more-menu');
        moreBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!menu) return;
            menu.hidden = !menu.hidden;
        });
        document.addEventListener('click', () => { if (menu) menu.hidden = true; });
        menu?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.closest('button.more-item')) menu.hidden = true;
        });
    }

    // Touch/click the on-screen pad — Discord on mobile has no keyboard.
    function wirePad() {
        const pad = $('crowd-pad');
        if (!pad) return;
        const keys = pad.querySelector('.crowd-keys');
        const set = (el, down) => {
            const code = el?.dataset?.code;
            if (!code) return;
            try { window.__sm64crowd?.setVirtual(code, down); } catch {}
        };
        keys?.addEventListener('pointerdown', (e) => {
            const el = e.target.closest('.crowd-key');
            if (!el) return;
            e.preventDefault();
            try { el.setPointerCapture(e.pointerId); } catch {}
            set(el, true);
        });
        const release = (e) => {
            const el = e.target.closest?.('.crowd-key');
            if (el) set(el, false);
        };
        keys?.addEventListener('pointerup', release);
        keys?.addEventListener('pointercancel', release);
        keys?.addEventListener('pointerleave', release);
        pad.querySelector('.crowd-mode')?.addEventListener('click', () => {
            setMergeMode(mergeMode === 'anarchy' ? 'democracy' : 'anarchy');
        });
    }

    function wireUi() {
        wireChrome();
        wirePad();
        $('mp-toggle-btn')?.addEventListener('click', () => openLobby());
        $('mp-close-btn')?.addEventListener('click', () => openLobby(false));
        $('mp-join-btn')?.addEventListener('click', () => joinRoom($('mp-room')?.value || 'lobby'));
        $('mp-room')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); joinRoom($('mp-room').value); }
        });
        $('mp-copy-btn')?.addEventListener('click', async () => {
            const code = $('mp-room')?.value || room;
            try { await navigator.clipboard.writeText(code); setStatus(`Copied “${code}”`); } catch {}
        });
        $('mp-mode-btn')?.addEventListener('click', () => {
            setMergeMode(mergeMode === 'anarchy' ? 'democracy' : 'anarchy');
        });
        const nick = $('mp-nick') || $('auth-nick');
        const authNick = $('auth-nick');
        if (nick) nick.value = me.name;
        if (authNick && authNick !== nick) authNick.value = me.name;
        const onNick = (el) => {
            el?.addEventListener('change', () => {
                me.name = el.value.trim().slice(0, 24) || me.name;
                try { localStorage.setItem('sm64_nick', me.name); } catch {}
                if (nick && nick !== el) nick.value = me.name;
                if (authNick && authNick !== el) authNick.value = me.name;
                broadcast(snapshot());
                updateNametag();
                render();
            });
        };
        onNick(nick);
        if (authNick && authNick !== nick) onNick(authNick);
    }

    const api = {
        onStatus(message) {
            me.thought = String(message || '').slice(0, 180);
            const now = Date.now();
            if (now - lastStatusAt < 400) return;
            lastStatusAt = now;
            me.playing = /AI|Think|Executing|Turbo|RL|Teach/i.test(me.thought);
            try {
                const region = document.getElementById('badge-location')?.textContent || '';
                if (region) me.region = region.replace(/^📍\s*/, '');
            } catch {}
            broadcast(snapshot());
        },
        async onFrame(dataUrl) {
            // Only the host's Mario is worth showing, so only the host sends a
            // poster frame (it covers the gap before WebRTC video connects).
            if (role !== 'host' || !gameCanvas()) return;
            const now = Date.now();
            if (now - lastFrameAt < 1800) return;
            lastFrameAt = now;
            const small = await shrinkFrame(dataUrl);
            if (!acceptThumb(small)) return;
            me.frame = small;
            broadcast({ t: 'frame', id: myId, frame: small });
        },
        onGameState(state) {
            if (!state) return;
            me.stars = state.stars;
            me.coins = state.coins;
            me.lives = state.lives;
            me.region = state.levelName || me.region;
        },
        setPlaying(on) { me.playing = !!on; broadcast(snapshot()); render(); },
        setName(n) {
            me.name = String(n || me.name).slice(0, 24);
            // Keep the Discord user id in sync so it rides along in the snapshot.
            if (discord?.userId) me.userId = discord.userId;
            else if (discord?.user?.id) me.userId = discord.user.id;
            try { localStorage.setItem('sm64_nick', me.name); } catch {}
            broadcast(snapshot());
            updateNametag();
            render();
        },
        // Called by discord-activity.js whenever the participant roster changes.
        // We record it and, while nobody is peer-connected yet, surface who
        // shares the activity so the room doesn't look empty.
        onParticipants(list) {
            if (!Array.isArray(list)) return;
            discordParticipants = list;
            try { localStorage.setItem('sm64_discord_participants', JSON.stringify(list.map(p => ({ id: p?.id, name: p?.global_name || p?.username })))); } catch {}
            if (others.size === 0) render();
        },
        join: joinRoom,
        open: openLobby,
        setMode: setMergeMode,
        get role() { return role; },
    };

    window.__sm64mp = api;
    try {
        const saved = localStorage.getItem('sm64_merge_mode');
        if (MERGE_MODES.includes(saved)) mergeMode = saved;
    } catch {}
    wireUi();
    updateNametag();
    render();

    // Seed the roster from the Discord SDK and apply the detected Discord
    // display name. The participant list / user may have already populated before
    // multiplayer finished booting, so re-sync now; later updates arrive via the
    // subscription handlers.
    if (discord?.active) {
        (async () => {
            try {
                const found = discord.detectedName
                    || discord?.user?.global_name
                    || discord?.user?.username;
                if (found) api.setName(found);
                if (discord.participants?.length) api.onParticipants(discord.participants);
                if (typeof discord.refreshParticipants === 'function') {
                    const list = await discord.refreshParticipants();
                    if (list?.length) api.onParticipants(list);
                }
            } catch {}
        })();
    }

    const savedRoom = (() => { try { return localStorage.getItem('sm64_mp_room'); } catch { return null; } })();
    const autoRoom = discord?.instanceId
        ? 'dc' + roomSlug(discord.instanceId)
        : (savedRoom || randomRoom());
    const roomInput = $('mp-room');
    if (roomInput) roomInput.value = autoRoom;
    if (discord?.instanceId) {
        // Everyone launching the activity in this voice channel lands in the
        // same room automatically — that's what makes "everyone controls Mario"
        // work with zero setup.
        setStatus(`Auto-joining “${autoRoom}” (Discord activity)`);
    }

    setTimeout(() => {
        joinRoom(autoRoom);
        if (!localStream) {
            streamRetry = setInterval(() => {
                if (role !== 'host') return;
                if (grabLocalStream()) { clearInterval(streamRetry); streamRetry = null; callEveryone(); }
            }, 1500);
        }
        setInterval(() => {
            const c = gameCanvas();
            if (!c || c.width < 8) return;
            try { api.onFrame(c.toDataURL('image/jpeg', 0.45)); } catch {}
        }, 2800);
        // Heartbeat: keeps a held key alive past INPUT_TTL_MS and re-syncs a
        // controller whose input packet was lost.
        setInterval(() => {
            if (!inRoom() || !myHeld.length) return;
            if (role === 'host') noteInput(myId, me.name, myHeld);
            else broadcast({ t: 'input', id: myId, name: me.name, held: myHeld });
        }, 1200);
        // SDL's audio context is created lazily, often after we've already
        // joined — keep re-asserting that only the host's Mario is audible.
        setInterval(() => {
            if (!inRoom()) return;
            try { crowd()?.setLocalAudio(role !== 'client'); } catch {}
        }, 2000);
    }, 200);

    window.addEventListener('beforeunload', () => {
        broadcast({ t: 'bye', id: myId });
        destroyPeer();
    });

    return api;
}
