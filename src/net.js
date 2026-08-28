// ============================================================
// src/net.js — multiplayer transport: a WebSocket relay client.
//
// Topology (star, relay-authoritative):
//
//     player B ─┐
//     player C ─┤ inputs        ┌──► merged inputs applied to ITS wasm engine
//     player D ─┘   │           │
//                   ▼           ▼
//                RELAY  ──►  HOST  ──► low-res JPEG of the shared screen ──► viewers
//                   │                      (the only "video" that survives the
//                   ▼                       no-WebRTC Activity sandbox)
//              roster/state/votes/chat
//
// The relay owns membership, host election and the room's session state, so a
// player who joins late converges without any handshake between clients. The
// host owns nothing but the engine: if it leaves, the relay promotes the next
// ready player and everyone keeps their inputs — play resumes on the new host's
// instance of the same game (a fresh save file, but a continuous lobby).
//
// Inside Discord this socket goes through Discord's proxy, which is exactly why
// it is plain WebSocket and not RTCPeerConnection.
// ============================================================

import { PROTOCOL_VERSION, clamp, decodeFrame } from './protocol.js';
import { dc } from './discord.js';

const PING_MS = 5000;
const INPUT_KEEPALIVE_MS = 250;

/** Where the relay lives. Override with ?relay=wss://host/ws or localStorage. */
export function relayUrl(roomKey, extra = {}) {
    let base = null;
    try {
        base = new URLSearchParams(location.search).get('relay')
            || localStorage.getItem('sm64mp_relay')
            || window.SM64_RELAY_URL
            || null;
    } catch { base = window.SM64_RELAY_URL || null; }

    if (!base) {
        if (dc.active) {
            // Sandboxed: must go through the app's proxy path. Requires the
            // `/relay -> your-host` URL mapping in the developer portal.
            base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay/ws`;
        } else {
            // Same-origin: `node server.js` mounts the relay on the same port.
            base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
        }
    }
    const u = new URL(base);
    u.searchParams.set('room', roomKey || 'lobby');
    for (const [k, v] of Object.entries(extra)) if (v != null) u.searchParams.set(k, String(v));
    return u.toString();
}

export class Net {
    constructor(handlers = {}) {
        this.h = handlers;            // {onWelcome,onRoster,onInput,onChat,onVote,onFrame,onStatus,onError,onPong}
        this.ws = null;
        this.status = 'offline';      // offline | connecting | online | retryping
        this.you = null;              // relay-assigned connection id
        this.room = null;
        this.players = new Map();     // cid → player
        this.host = null;             // cid of the host
        this.state = { mode: 'solo', opts: {}, pad: null, padUntil: 0 };
        this.rtt = 0;
        this.lastInputAt = 0;
        this._outBits = 0;
        this._retry = 0;
        this._closedByUs = false;
        this._stats = { sent: 0, recv: 0, dropped: 0, framesIn: 0, bytesIn: 0, bytesOut: 0 };
    }

    get isHost() { return !!this.you && this.host === this.you; }
    get me() { return this.players.get(this.you) || null; }
    get others() { return [...this.players.values()].filter((p) => p.cid !== this.you); }
    /** Players counted as "in the game" for arbitration (ready = engine loaded). */
    get activePlayers() { return [...this.players.values()].filter((p) => p.ready); }

    async connect(roomKey, profile = {}) {
        this.room = roomKey;
        this.profile = profile;
        this._closedByUs = false;
        this._open();
    }

    _open() {
        const url = relayUrl(this.room, {
            name: this.profile?.name, id: this.profile?.id,
            av: this.profile?.avatar, plat: dc.platform,
        });
        this._setStatus('connecting', url);
        let ws;
        try { ws = new WebSocket(url); }
        catch (err) { this._setStatus('offline', String(err?.message || err)); return this._again(); }
        this.ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            this._retry = 0;
            this._setStatus('online');
            this._send({ t: 'hello', ver: PROTOCOL_VERSION, room: this.room, ready: !!this.h.isReady?.(), plat: dc.platform });
            this._pinger = setInterval(() => this._send({ t: 'ping', c: Date.now() }), PING_MS);
            this._keepalive = setInterval(() => {
                // Level-triggered inputs still need a periodic refresh so a
                // dropped packet can't leave Mario running into a wall forever.
                if (Date.now() - this.lastInputAt > INPUT_KEEPALIVE_MS) this.sendInput(this._outBits, true);
            }, INPUT_KEEPALIVE_MS);
            this.h.onStatus?.('online', this);
        };

        ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') { this._stats.bytesIn += ev.data.length; this._onText(ev.data); }
            else { this._stats.bytesIn += ev.data.byteLength; this._onBinary(ev.data); }
        };
        ws.onerror = () => { this._setStatus('offline', 'socket error'); };
        ws.onclose = (ev) => {
            clearInterval(this._pinger); clearInterval(this._keepalive);
            this.ws = null;
            this._setStatus(this._closedByUs ? 'offline' : 'retryping', ev.reason || `code ${ev.code}`);
            if (!this._closedByUs) this._again();
        };
    }

    _again() {
        if (this._closedByUs) return;
        this._retry++;
        const ms = clamp(700 * 2 ** Math.min(this._retry, 5), 700, 12000) + Math.random() * 400;
        clearTimeout(this._t);
        this._t = setTimeout(() => this._open(), ms);
    }

    disconnect() {
        this._closedByUs = true;
        clearInterval(this._pinger); clearInterval(this._keepalive); clearTimeout(this._t);
        try { this._send({ t: 'leave' }); this.ws?.close(1000, 'bye'); } catch {}
        this.ws = null;
        this._setStatus('offline', 'left');
    }

    _setStatus(status, detail) {
        this.status = status;
        this.detail = detail || null;
        this.h.onStatus?.(status, this, detail);
    }

    _send(obj) {
        if (!this.ws || this.ws.readyState !== 1) return false;
        try {
            const s = JSON.stringify(obj);
            this.ws.send(s);
            this._stats.sent++; this._stats.bytesOut += s.length;
            return true;
        } catch { return false; }
    }

    // ── outgoing ───────────────────────────────────────────────────────
    sendInput(bits) {
        if (bits === this._outBits && Date.now() - this.lastInputAt < INPUT_KEEPALIVE_MS) return;
        this._outBits = bits;
        this.lastInputAt = Date.now();
        this._send({ t: 'in', s: bits, f: (this._frameNo = (this._frameNo || 0) + 1) });
    }
    setReady(ready) { this._send({ t: 'ready', ready: !!ready }); }
    /** Names can change (nickname edit, late identity); the relay only stores them at hello. */
    updateProfile(profile) {
        this.profile = profile;
        const q = new URLSearchParams({ name: profile.name || '', id: profile.id || '', av: profile.avatar || '' });
        this._send({ t: 'profile', ...Object.fromEntries(q) });
    }
    setWatching(on) { this._send({ t: 'watch', on: !!on }); }
    setState(patch) { this._send({ t: 'state', s: patch }); }
    chat(text) { const m = String(text || '').trim().slice(0, 240); if (m) this._send({ t: 'chat', m }); }
    vote(kind, value, opts) { this._send({ t: 'vote', kind, value, opts }); }
    promote(cid) { this._send({ t: 'promote', cid }); }
    ballot(yes) { this._send({ t: 'vote_ballot', yes: !!yes }); }

    /** Host → viewers. `jpegBytes` is a Uint8Array/ArrayBuffer of a JPEG. */
    sendFrame(index, ts, jpegBytes) {
        if (!this.ws || this.ws.readyState !== 1) return false;
        if (this.ws.bufferedAmount > 512 * 1024) { this._stats.dropped++; return false; }
        const buf = jpegBytes.buffer instanceof ArrayBuffer ? jpegBytes : new Uint8Array(jpegBytes);
        const out = new Uint8Array(12 + buf.byteLength);
        const v = new DataView(out.buffer);
        v.setUint32(0, 0x534d3646);            // 'SM6F'
        v.setUint32(4, index >>> 0);
        v.setUint32(8, ts >>> 0);
        out.set(buf, 12);
        try { this.ws.send(out); this._stats.framesOut = (this._stats.framesOut || 0) + 1; return true; }
        catch { return false; }
    }

    // ── incoming ───────────────────────────────────────────────────────
    _onText(raw) {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        this._stats.recv++;
        switch (m.t) {
            case 'welcome':
                this.you = m.you;
                this._applyRoom(m.host, m.players, m.state);
                this._vote = m.vote || null;
                this.h.onWelcome?.(m, this);
                break;
            case 'roster':
                this._applyRoom(m.host, m.players, m.state);
                this.h.onRoster?.(m, this);
                break;
            case 'input':
                if (this.isHost) this.h.onInput?.(m.from, m.s | 0, m.f | 0);
                break;
            case 'chat':
                this.h.onChat?.(m);
                break;
            case 'vote_new':
                this._vote = m; this.h.onVote?.(m, this);
                break;
            case 'vote_end':
                this._vote = null; this.h.onVoteEnd?.(m, this);
                break;
            case 'pong':
                this.rtt = Math.round(clamp(Date.now() - m.c, 0, 9999));
                this.h.onPong?.(this.rtt, this);
                break;
            case 'err':
                this._stats.errors = (this._stats.errors || 0) + 1;
                if (m.code === 'room_full') { this._closedByUs = true; try { this.ws?.close(); } catch {} }
                this.h.onError?.(m, this);
                break;
            default:
                break;
        }
    }

    _onBinary(buf) {
        const f = decodeFrame(buf);
        if (f) { this._stats.framesIn++; this.h.onFrame?.(f, this); }
    }

    _applyRoom(host, players, state) {
        const prev = this.host;
        if (host !== undefined) this.host = host;
        if (Array.isArray(players)) {
            const seen = new Set();
            for (const p of players) {
                seen.add(p.cid);
                const old = this.players.get(p.cid);
                this.players.set(p.cid, { ...(old || {}), ...p });
            }
            for (const cid of [...this.players.keys()]) if (!seen.has(cid)) this.players.delete(cid);
        }
        if (state) this.state = { ...this.state, ...state };
        if (host !== undefined && host !== prev) this.h.onHost?.(this.host, this);
    }

    /** Local player's display name for the relay (Discord name, never editable in-app). */
    profileName() { return this.profile?.name || 'Player'; }
}
