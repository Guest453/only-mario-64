// Multiplayer: each client runs its own WASM Mario, then live-streams
// the canvas over WebRTC (PeerJS). Split-screen + nametags.
// Discord Activities auto-join the voice-channel instance as the room.
//
// Stream lock: the only outbound media is #canvas.captureStream (no camera,
// mic, or screen). Inbound camera/screen/audio tracks are dropped. This is
// how we keep the lobby Mario-only — we set *what* is streamed, not a
// post-hoc NSFW filter.

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

function shrinkFrame(dataUrl) {
    return new Promise((resolve) => {
        if (!dataUrl) { resolve(null); return; }
        const img = new Image();
        img.onload = () => {
            const w = 240, h = Math.max(80, Math.round(img.height * (w / img.width)));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/jpeg', 0.42));
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

    const discordName = discord?.user?.global_name || discord?.user?.username || null;
    const me = {
        name: discordName || nickDefault(),
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

    function grabLocalStream() {
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
            localStream = c.captureStream(24);
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
        const p = others.get(remoteId) || { id: remoteId };
        delete p.stream;
        p.blocked = true;
        others.set(remoteId, p);
        try { calls.get(remoteId)?.close(); } catch {}
        renderStage();
        render();
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
            const p = others.get(remoteId) || { id: remoteId };
            p.stream = safe;
            p.blocked = false;
            others.set(remoteId, p);
            renderStage();
            render();
        });
        call.on('close', () => {
            calls.delete(remoteId);
            const p = others.get(remoteId);
            if (p) { delete p.stream; others.set(remoteId, p); }
            renderStage();
        });
        call.on('error', (e) => console.warn('[MP] call', e));
    }

    function maybeCall(remoteId) {
        if (!remoteId || remoteId === myId || calls.has(remoteId)) return;
        const stream = grabLocalStream();
        if (!stream || !peer) return;
        // Deterministic: only the lexicographically greater id places the call.
        if (String(myId) < String(remoteId)) return;
        try {
            const call = peer.call(remoteId, stream);
            setupCall(call, remoteId);
        } catch (err) {
            console.warn('[MP] call out', err);
        }
    }

    function callEveryone() {
        grabLocalStream();
        for (const id of others.keys()) maybeCall(id);
        for (const id of peers.keys()) maybeCall(id);
    }

    function onPeerMessage(fromId, msg) {
        if (!msg || typeof msg !== 'object') return;
        if (role === 'host' && msg.t !== 'hello') broadcast(msg, fromId);

        if (msg.t === 'hello') {
            others.set(msg.id, { ...(others.get(msg.id) || {}), ...msg, updated: Date.now() });
            send(peers.get(fromId), snapshot());
            if (me.frame) send(peers.get(fromId), { t: 'frame', id: myId, frame: me.frame });
            if (role === 'host') {
                send(peers.get(fromId), {
                    t: 'roster',
                    players: [snapshot(), ...[...others.values()].filter(p => p.id !== msg.id)],
                });
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
                    maybeCall(p.id);
                }
            }
            render();
            renderStage();
            return;
        }
        if (msg.t === 'state' && msg.id && msg.id !== myId) {
            others.set(msg.id, { ...(others.get(msg.id) || {}), ...msg, updated: Date.now() });
            render();
            renderStage();
            return;
        }
        if (msg.t === 'frame' && msg.id && msg.id !== myId) {
            if (!acceptThumb(msg.frame)) return;
            const prev = others.get(msg.id) || { id: msg.id };
            others.set(msg.id, { ...prev, frame: msg.frame, updated: Date.now() });
            render();
            renderStage();
            return;
        }
        if (msg.t === 'bye' && msg.id) {
            others.delete(msg.id);
            try { calls.get(msg.id)?.close(); } catch {}
            calls.delete(msg.id);
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
            setStatus(role === 'host'
                ? `Hosting “${room}” · ${peers.size + 1} playing`
                : `In “${room}”`);
        });
        conn.on('close', () => {
            peers.delete(pid);
            others.delete(pid);
            try { calls.get(pid)?.close(); } catch {}
            calls.delete(pid);
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
        role = 'idle';
        myId = '';
        renderStage();
    }

    function becomeHost(roomName) {
        return new Promise((resolve, reject) => {
            const hid = hostPeerId(roomName);
            const p = new window.Peer(hid, { debug: 0 });
            const fail = (err) => { try { p.destroy(); } catch {} reject(err); };
            p.on('error', (err) => {
                if (err?.type === 'unavailable-id') fail(err);
                else console.warn('[MP] host peer', err);
            });
            p.on('open', (id) => {
                peer = p;
                myId = id;
                role = 'host';
                room = roomName;
                p.on('connection', attach);
                p.on('call', (call) => {
                    const stream = grabLocalStream();
                    call.answer(stream || undefined);
                    setupCall(call, call.peer);
                });
                setStatus(`Hosting “${room}” — share this code`);
                render();
                resolve('host');
            });
        });
    }

    function becomeClient(roomName) {
        return new Promise((resolve, reject) => {
            const p = new window.Peer(undefined, { debug: 0 });
            p.on('error', (err) => {
                console.warn('[MP] client peer', err);
                reject(err);
            });
            p.on('open', (id) => {
                peer = p;
                myId = id;
                role = 'client';
                room = roomName;
                p.on('call', (call) => {
                    const stream = grabLocalStream();
                    call.answer(stream || undefined);
                    setupCall(call, call.peer);
                });
                const conn = p.connect(hostPeerId(roomName), { reliable: true });
                attach(conn);
                setStatus(`Joined “${room}”`);
                render();
                resolve('client');
            });
        });
    }

    async function joinRoom(roomName) {
        if (typeof window.Peer !== 'function') {
            setStatus('PeerJS failed to load — refresh?');
            return;
        }
        roomName = roomSlug(roomName);
        const input = $('mp-room');
        if (input) input.value = roomName;
        try { localStorage.setItem('sm64_mp_room', roomName); } catch {}
        destroyPeer();
        setStatus(`Joining “${roomName}”…`);
        grabLocalStream();
        try {
            await becomeHost(roomName);
        } catch {
            try {
                await becomeClient(roomName);
            } catch (err) {
                setStatus('Could not connect lobby: ' + (err?.message || err));
            }
        }
        updateNametag();
    }

    function updateNametag() {
        const tag = $('local-nametag');
        if (tag) tag.textContent = me.name || 'You';
    }

    function renderStage() {
        const stage = $('remote-stage');
        const app = document.getElementById('app');
        // Show a pane for EVERY remote peer, so the spectate view is usable even
        // before a live WebRTC stream arrives — the broadcast thumbnail frame
        // fills in as a poster until the live video connects.
        const remotes = [...others.values()];
        const split = remotes.length > 0;
        app?.classList.toggle('mp-split', split);
        if (!stage) return;
        if (!split) {
            stage.hidden = true;
            stage.innerHTML = '';
            return;
        }
        stage.hidden = false;
        const n = remotes.length;
        stage.style.gridTemplateRows = n > 1 ? `repeat(${n}, 1fr)` : '1fr';
        const existing = new Set();
        for (const p of remotes) {
            existing.add(p.id);
            let pane = stage.querySelector(`[data-pid="${CSS.escape(p.id)}"]`);
            if (!pane) {
                pane = document.createElement('div');
                pane.className = 'remote-pane';
                pane.dataset.pid = p.id;
                pane.innerHTML = [
                    '<div class="rp-live">LIVE</div>',
                    '<div class="rp-hud">',
                    '  <span class="rp-name"></span>',
                    '  <span class="rp-tag"></span>',
                    '</div>',
                    '<video autoplay playsinline muted></video>',
                    '<img class="rp-thumb" alt="">',
                    '<div class="rp-foot">',
                    '  <span class="rp-stats"></span>',
                    '  <span class="rp-thought"></span>',
                    '</div>',
                ].join('');
                stage.appendChild(pane);
            }
            const hasStream = !!p.stream;
            pane.classList.toggle('live', hasStream);

            // Name — a 💬 prefix marks names that came from the Discord SDK.
            const nameEl = pane.querySelector('.rp-name');
            nameEl.textContent = p.name || '???';
            nameEl.classList.toggle('discord', !!p.discord);

            const tagEl = pane.querySelector('.rp-tag');
            tagEl.textContent = p.playing ? '🤖 AI' : '🎮';
            tagEl.classList.toggle('ai', !!p.playing);

            const stats = [
                p.stars != null ? `⭐ ${p.stars}` : null,
                p.coins != null ? `🪙 ${p.coins}` : null,
                p.lives != null ? `🍄 ${p.lives}` : null,
            ].filter(Boolean).join('  ');
            pane.querySelector('.rp-stats').textContent = stats;

            const region = p.region && p.region !== 'unknown' ? ` · ${p.region}` : '';
            pane.querySelector('.rp-thought').textContent = (p.thought || '—') + region;

            const liveEl = pane.querySelector('.rp-live');
            liveEl.textContent = hasStream ? 'LIVE' : 'CONNECT';
            liveEl.classList.toggle('connecting', !hasStream);

            const vid = pane.querySelector('video');
            const img = pane.querySelector('.rp-thumb');
            vid.muted = true;
            vid.autoplay = true;
            vid.playsInline = true;
            vid.disablePictureInPicture = true;
            if (p.stream && vid.srcObject !== p.stream) {
                vid.srcObject = p.stream;
                vid.style.display = 'block';
                img.style.display = 'none';
                vid.play?.().catch(() => {});
            } else if (!hasStream) {
                vid.style.display = 'none';
                if (p.frame) { img.src = p.frame; img.style.display = 'block'; }
                else { img.removeAttribute('src'); img.style.display = 'block'; }
            }
        }
        for (const pane of [...stage.querySelectorAll('.remote-pane')]) {
            if (!existing.has(pane.dataset.pid)) pane.remove();
        }
    }

    function card(p, isMe) {
        const playing = p.playing ? '🤖 AI' : '🎮 playing';
        const stats = [
            p.stars != null ? `⭐${p.stars}` : null,
            p.coins != null ? `🪙${p.coins}` : null,
            p.lives != null ? `🍄${p.lives}` : null,
        ].filter(Boolean).join(' ');
        const live = p.stream ? '<div class="mp-live">LIVE</div>' : '';
        const img = p.frame
            ? `<img class="mp-frame" alt="" src="${p.frame}">`
            : `<div class="mp-frame ph">${isMe ? 'Your Mario' : 'Waiting for stream…'}</div>`;
        return `<article class="mp-card${isMe ? ' me' : ''}">
            <header><b>${esc(p.name || '???')}</b> <span>${playing}</span></header>
            <div class="mp-frame-wrap">${live}${img}</div>
            <p class="mp-thought">${esc(p.thought || '—')}</p>
            <footer>${esc(p.region || '')} ${stats}</footer>
        </article>`;
    }

    function render() {
        const grid = $('mp-grid');
        const dock = $('mp-dock');
        const list = [
            { ...me, id: myId || 'me', name: me.name + ' (you)', thought: me.thought, frame: me.frame, playing: me.playing, region: me.region, stars: me.stars, coins: me.coins, lives: me.lives, mode: me.mode },
            ...[...others.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
        ];
        if (grid) {
            grid.innerHTML = list.map((p, i) => card(p, i === 0)).join('')
                || '<p class="mp-empty">Share the room code. When a friend joins, both Marios go split-screen.</p>';
        }
        if (dock) {
            const othersList = [...others.values()];
            dock.classList.toggle('open', othersList.length > 0 && !$('mp-panel')?.classList.contains('open'));
            dock.innerHTML = othersList.map(p => `
                <div class="mp-dock-item" title="${esc(p.name)}">
                    ${p.frame ? `<img src="${p.frame}" alt="">` : '<div class="ph"></div>'}
                    <span>${esc((p.name || '?').slice(0, 14))}</span>
                    <small>${p.stream ? 'LIVE' : (p.playing ? '🤖' : '💤')} ${esc((p.thought || '').slice(0, 36))}</small>
                </div>`).join('');
        }
        const n = String(others.size);
        const count = $('mp-count');
        if (count) count.textContent = n;
        if (role === 'host') setStatus(`Room “${room}” · ${others.size + 1} Mario${others.size ? 's' : ''} — streaming`);
        else if (role === 'client') setStatus(`In “${room}” · ${others.size + 1} Marios`);
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

    function wireUi() {
        wireChrome();
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
                renderStage();
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
            render();
        },
        async onFrame(dataUrl) {
            if (!gameCanvas()) return;
            const now = Date.now();
            if (now - lastFrameAt < 1800) return;
            lastFrameAt = now;
            const small = await shrinkFrame(dataUrl);
            if (!acceptThumb(small)) return;
            me.frame = small;
            broadcast({ t: 'frame', id: myId, frame: small });
            render();
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
            try { localStorage.setItem('sm64_nick', me.name); } catch {}
            broadcast(snapshot());
            updateNametag();
        },
        join: joinRoom,
        open: openLobby,
    };

    window.__sm64mp = api;
    wireUi();
    updateNametag();
    render();

    const savedRoom = (() => { try { return localStorage.getItem('sm64_mp_room'); } catch { return null; } })();
    const autoRoom = discord?.instanceId
        ? 'dc' + roomSlug(discord.instanceId)
        : (savedRoom || randomRoom());
    const roomInput = $('mp-room');
    if (roomInput) roomInput.value = autoRoom;

    setTimeout(() => {
        joinRoom(autoRoom);
        grabLocalStream();
        if (!localStream) {
            streamRetry = setInterval(() => {
                if (grabLocalStream()) { clearInterval(streamRetry); callEveryone(); }
            }, 1500);
        }
        setInterval(() => {
            const c = gameCanvas();
            if (!c || c.width < 8) return;
            try { api.onFrame(c.toDataURL('image/jpeg', 0.45)); } catch {}
        }, 2800);
    }, 500);

    window.addEventListener('beforeunload', () => {
        broadcast({ t: 'bye', id: myId });
        destroyPeer();
    });

    return api;
}
