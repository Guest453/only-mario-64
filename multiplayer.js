// Watch other people's AIs over WebRTC (PeerJS).
// Same Discord activity instance auto-joins one room. Elsewhere, share a room code.

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

export function initMultiplayer({ discord } = {}) {
    const peers = new Map(); // peerId -> DataConnection
    const others = new Map(); // id -> { id, name, thought, region, playing, stars, coins, lives, frame, mode, updated }

    let peer = null;
    let role = 'idle';
    let room = 'lobby';
    let myId = '';
    let lastStatusAt = 0;
    let lastFrameAt = 0;
    let pendingFrame = null;

    const me = {
        name: nickDefault(),
        thought: '',
        region: 'unknown',
        playing: false,
        stars: null,
        coins: null,
        lives: null,
        mode: '',
        frame: null,
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

    function relayOrBroadcast(msg, fromId) {
        if (role === 'host') broadcast(msg, fromId);
    }

    function onPeerMessage(fromId, msg) {
        if (!msg || typeof msg !== 'object') return;
        if (role === 'host' && msg.t !== 'hello') relayOrBroadcast(msg, fromId);

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
            render();
            return;
        }
        if (msg.t === 'roster' && Array.isArray(msg.players)) {
            for (const p of msg.players) {
                if (p.id && p.id !== myId) others.set(p.id, { ...(others.get(p.id) || {}), ...p, updated: Date.now() });
            }
            render();
            return;
        }
        if (msg.t === 'state' && msg.id && msg.id !== myId) {
            others.set(msg.id, { ...(others.get(msg.id) || {}), ...msg, updated: Date.now() });
            render();
            return;
        }
        if (msg.t === 'frame' && msg.id && msg.id !== myId) {
            const prev = others.get(msg.id) || { id: msg.id };
            others.set(msg.id, { ...prev, frame: msg.frame, updated: Date.now() });
            render();
            return;
        }
        if (msg.t === 'bye' && msg.id) {
            others.delete(msg.id);
            render();
        }
    }

    function attach(conn) {
        const pid = conn.peer;
        peers.set(pid, conn);
        conn.on('data', (msg) => onPeerMessage(pid, msg));
        conn.on('open', () => {
            send(conn, { t: 'hello', ...snapshot() });
            setStatus(role === 'host'
                ? `Hosting “${room}” · ${peers.size + 1} in lobby`
                : `In “${room}” · watching ${others.size} other AI${others.size === 1 ? '' : 's'}`);
        });
        conn.on('close', () => {
            peers.delete(pid);
            for (const [id, p] of others) {
                if (p._via === pid) others.delete(id);
            }
            render();
        });
        conn.on('error', (e) => console.warn('[MP] conn', e));
    }

    function destroyPeer() {
        try { peer?.destroy(); } catch {}
        peer = null;
        peers.clear();
        others.clear();
        role = 'idle';
        myId = '';
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
        try {
            await becomeHost(roomName);
        } catch {
            try {
                await becomeClient(roomName);
            } catch (err) {
                setStatus('Could not connect lobby: ' + (err?.message || err));
            }
        }
    }

    function card(p, isMe) {
        const playing = p.playing ? '🤖 AI' : '🎮 idle';
        const stats = [
            p.stars != null ? `⭐${p.stars}` : null,
            p.coins != null ? `🪙${p.coins}` : null,
            p.lives != null ? `🍄${p.lives}` : null,
        ].filter(Boolean).join(' ');
        const img = p.frame
            ? `<img class="mp-frame" alt="" src="${p.frame}">`
            : `<div class="mp-frame ph">${isMe ? 'Your AI feed' : 'Waiting for a frame…'}</div>`;
        return `<article class="mp-card${isMe ? ' me' : ''}">
            <header><b>${esc(p.name || '???')}</b> <span>${playing}</span></header>
            ${img}
            <p class="mp-thought">${esc(p.thought || '—')}</p>
            <footer>${esc(p.region || '')} ${stats} ${esc(p.mode || '')}</footer>
        </article>`;
    }

    function render() {
        const grid = $('mp-grid');
        const dock = $('mp-dock');
        const list = [
            { ...me, id: myId || 'me', name: me.name + ' (you)', thought: me.thought, frame: me.frame, playing: me.playing, region: me.region, stars: me.stars, coins: me.coins, lives: me.lives, mode: me.mode },
            ...[...others.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
        ];
        if (grid) grid.innerHTML = list.map((p, i) => card(p, i === 0)).join('') || '<p class="mp-empty">Nobody else is here yet. Share the room code.</p>';
        if (dock) {
            const othersList = [...others.values()];
            dock.classList.toggle('open', othersList.length > 0);
            dock.innerHTML = othersList.map(p => `
                <div class="mp-dock-item" title="${esc(p.name)}">
                    ${p.frame ? `<img src="${p.frame}" alt="">` : '<div class="ph"></div>'}
                    <span>${esc((p.name || '?').slice(0, 12))}</span>
                    <small>${p.playing ? '🤖' : '💤'} ${esc((p.thought || '').slice(0, 42))}</small>
                </div>`).join('');
        }
        const count = $('mp-count');
        if (count) count.textContent = String(others.size);
        if (role === 'host') setStatus(`Hosting “${room}” · ${others.size + 1} in lobby`);
        else if (role === 'client') setStatus(`In “${room}” · ${others.size} other AI${others.size === 1 ? '' : 's'}`);
    }

    function wireUi() {
        $('mp-toggle-btn')?.addEventListener('click', () => {
            const p = $('mp-panel');
            if (!p) return;
            p.classList.toggle('open');
            $('mp-toggle-btn')?.classList.toggle('active', p.classList.contains('open'));
        });
        $('mp-close-btn')?.addEventListener('click', () => {
            $('mp-panel')?.classList.remove('open');
            $('mp-toggle-btn')?.classList.remove('active');
        });
        $('mp-join-btn')?.addEventListener('click', () => joinRoom($('mp-room')?.value || 'lobby'));
        $('mp-room')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); joinRoom($('mp-room').value); }
        });
        $('mp-copy-btn')?.addEventListener('click', async () => {
            const code = $('mp-room')?.value || room;
            try { await navigator.clipboard.writeText(code); setStatus(`Copied “${code}”`); } catch {}
        });
        const nick = $('auth-nick') || $('mp-nick');
        if (nick) {
            nick.value = me.name;
            nick.addEventListener('change', () => {
                me.name = nick.value.trim().slice(0, 24) || me.name;
                try { localStorage.setItem('sm64_nick', me.name); } catch {}
                broadcast(snapshot());
                render();
            });
        }
    }

    // ── hooks from the AI player ──
    const api = {
        onStatus(message) {
            me.thought = String(message || '').slice(0, 180);
            const now = Date.now();
            if (now - lastStatusAt < 400) return;
            lastStatusAt = now;
            me.playing = !!(window.aiPlayerActive) || /AI|Think|Executing|Turbo|RL|Teach/i.test(me.thought);
            try {
                const region = document.getElementById('badge-location')?.textContent || '';
                if (region) me.region = region.replace(/^📍\s*/, '');
            } catch {}
            broadcast(snapshot());
            render();
        },
        async onFrame(dataUrl) {
            const now = Date.now();
            if (now - lastFrameAt < 1800) { pendingFrame = dataUrl; return; }
            lastFrameAt = now;
            const small = await shrinkFrame(dataUrl);
            if (!small) return;
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
        },
        join: joinRoom,
    };

    window.__sm64mp = api;
    wireUi();
    render();

    const savedRoom = (() => { try { return localStorage.getItem('sm64_mp_room'); } catch { return null; } })();
    const autoRoom = discord?.instanceId
        ? 'dc' + roomSlug(discord.instanceId)
        : (savedRoom || 'lobby');
    const roomInput = $('mp-room');
    if (roomInput) roomInput.value = autoRoom;

    // Auto-join Discord instance rooms; otherwise wait for Join (still auto-join public lobby).
    setTimeout(() => joinRoom(autoRoom), 400);

    window.addEventListener('beforeunload', () => {
        broadcast({ t: 'bye', id: myId });
        destroyPeer();
    });

    return api;
}
