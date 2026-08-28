// ============================================================
// src/room-core.js — what a "room" *is*, with no sockets and no timers.
//
// Both relay backends drive this: `relay/server.js` (Node, raw RFC6455, for
// self-hosting) and `worker/` (Cloudflare Durable Object, for people who do not
// want to run a server at all). Membership, host election, room state, votes,
// rate windows and fan-out targets are decided here, so the two cannot drift
// apart on the rules while differing only in plumbing.
//
// It is pure on purpose: time is an argument, output is a list of `{to, m}`
// envelopes, and nothing here knows what a connection is. That is what makes
// test/room-core.test.mjs able to cover the semantics in microseconds, and why
// the Durable Object version can survive being evicted between messages — the
// whole world is `snapshot()`/`restore()`.
// ============================================================

export const ROOM_DEFAULTS = {
    ver: 1,
    maxPlayers: 8,
    maxTextPerSec: 60,
    chatMax: 3,
    chatWindowMs: 10_000,
    chatChars: 240,
    nameChars: 24,
    idChars: 32,
    avChars: 64,
    maxJsonBytes: 64 * 1024,
    maxFrameBytes: 512 * 1024,
    voteMs: 8_000,
};

const rid = () => (globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 8))
    || Math.random().toString(36).slice(2, 10);

const str = (v, max, fallback = '') => {
    if (v == null) return fallback;
    const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return s ? s.slice(0, max) : fallback;
};

/** Room key: the Discord instance id, or whatever a browser tab typed in. */
export function roomKeyOf(raw) {
    return String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'lobby';
}

export class RoomCore {
    /**
     * @param {string} key   sanitised room key
     * @param {object} [opts] overrides for ROOM_DEFAULTS
     */
    constructor(key, opts = {}) {
        this.key = roomKeyOf(key);
        this.o = { ...ROOM_DEFAULTS, ...opts };
        /** @type {Map<string, object>} cid → player; insertion order is join order */
        this.players = new Map();
        this.host = null;
        this.pin = null;
        this.vote = null;
        this.state = { mode: 'solo', opts: {}, pad: null, padUntil: 0, tag: '' };
        this.createdAt = 0;
        this.drops = 0;
    }

    // ── membership ────────────────────────────────────────────────────────
    /**
     * @param {{name?:string,id?:string,av?:string,plat?:string,ready?:boolean,watch?:boolean,now?:number}} info
     * @returns {{ok:true,cid:string,welcome:object,emit:Array}|{ok:false,code:string,msg:string}}
     */
    join(info = {}) {
        const now = info.now ?? 0;
        if (this.players.size >= this.o.maxPlayers) {
            return {
                ok: false, code: 'room_full',
                msg: `${this.key} has ${this.players.size}/${this.o.maxPlayers}`,
                max: this.o.maxPlayers,
            };
        }
        const cid = rid();
        const player = {
            cid,
            id: str(info.id, this.o.idChars) || null,
            name: str(info.name, this.o.nameChars, 'Player'),
            av: str(info.av, this.o.avChars) || null,
            plat: str(info.plat, 12, 'desktop'),
            ready: !!info.ready,
            watching: false,
            bits: 0,
            left: false,
            joinedAt: now,
            lastSeen: now,
            winStart: now, winCount: 0,
            chatWin: 0, chatN: 0,
        };
        this.players.set(cid, player);
        this.createdAt ||= now;
        const elected = this.#electHost();
        const welcome = {
            t: 'welcome', ver: this.o.ver, room: this.key, you: cid, sid: cid,
            host: this.host, players: this.public(), state: this.state,
            vote: this.vote ? this.#votePublic() : null,
            maxPlayers: this.o.maxPlayers,
        };
        // Everyone else needs the new roster; the joiner gets `welcome` instead
        // (same payload + its own cid), which is what src/net.js expects.
        void elected;
        return { ok: true, cid, player, welcome, emit: [{ to: '*', except: cid, m: this.#roster() }] };
    }

    /** @returns {{emit:Array,hostChanged:boolean,empty:boolean}} */
    leave(cid, now = 0) {
        const p = this.players.get(cid);
        if (!p) return { emit: [], hostChanged: false, empty: this.players.size === 0 };
        this.players.delete(cid);
        if (this.pin === cid) this.pin = null;
        if (this.vote) { this.vote.yes.delete(cid); this.vote.no.delete(cid); }
        const hostChanged = this.#electHost();
        return {
            emit: [{ to: '*', m: this.#roster() }],
            hostChanged,
            empty: this.players.size === 0,
        };
    }

    /** Roster rows as clients see them (the host flag is computed, never stored). */
    public() {
        return [...this.players.values()].map((p) => ({
            cid: p.cid, id: p.id, name: p.name, av: p.av, plat: p.plat,
            ready: p.ready, host: p.cid === this.host, watching: p.watching,
            bits: p.bits, joinedAt: p.joinedAt,
        }));
    }

    // ── the one entry point for traffic ───────────────────────────────────
    /**
     * Apply one client frame.
     * @param {string} cid
     * @param {object} msg parsed JSON
     * @param {number} now epoch ms from the transport
     * @param {number} [bytes] size of the frame, for the size guard
     * @returns {{emit:Array,close?:{code:number,reason:string},drops?:number}}
     *   `emit` entries are `{to, m}`: `to` is a cid, or `'*'` for everyone
     *   (`except` optionally excludes one cid, usually the sender).
     */
    handle(cid, msg, now = Date.now(), bytes = 0) {
        const p = this.players.get(cid);
        if (!p) return { emit: [] };
        if (bytes > this.o.maxJsonBytes) return { emit: [{ to: cid, m: { t: 'err', code: 'too_big', msg: 'message too large' } }] };

        p.lastSeen = now;
        if (now - p.winStart > 1000) { p.winStart = now; p.winCount = 0; }
        if (++p.winCount > this.o.maxTextPerSec) return { emit: [] };   // silently shed

        const t = msg?.t;
        switch (t) {
            case 'hello': {
                // Re-asserted after a reconnect: the room is fixed by the query
                // string, so what matters is the version and readiness.
                if (msg.ver && msg.ver !== this.o.ver) {
                    return {
                        emit: [{ to: cid, m: { t: 'err', code: 'version', msg: `relay speaks v${this.o.ver}, client asked for v${msg.ver}` } }],
                        close: { code: 4000, reason: 'version' },
                    };
                }
                if (msg.plat) p.plat = str(msg.plat, 12, p.plat);
                const emit = [];
                if (typeof msg.watch === 'boolean' && msg.watch !== p.watching) p.watching = msg.watch;
                if (typeof msg.ready === 'boolean' && msg.ready !== p.ready) {
                    p.ready = msg.ready;
                    this.#electHost();
                    emit.push({ to: '*', m: this.#roster() });
                }
                return { emit };
            }
            case 'in': {
                const bits = (msg.s | 0) & 0xffff;
                p.bits = bits;
                // Star topology: inputs go to the one engine that drives Mario.
                if (this.host && this.host !== cid) return { emit: [{ to: this.host, m: { t: 'input', from: cid, s: bits, f: msg.f | 0 } }] };
                return { emit: [] };
            }
            case 'ready': {
                p.ready = !!msg.ready;
                this.#electHost();
                return { emit: [{ to: '*', m: this.#roster() }] };
            }
            case 'watch': {
                p.watching = !!msg.on;
                this.#electHost();
                return { emit: [{ to: '*', m: this.#roster() }] };
            }
            case 'state': {
                if (cid !== this.host) return { emit: [{ to: cid, m: { t: 'err', code: 'not_host', msg: 'only the host sets state' } }] };
                this.state = { ...this.state, ...(msg.s || {}) };
                return { emit: [{ to: '*', m: this.#roster() }], persist: true };
            }
            case 'profile': {
                p.name = str(msg.name, this.o.nameChars, p.name);
                p.id = msg.id ? str(msg.id, this.o.idChars) : p.id;
                p.av = msg.av ? str(msg.av, this.o.avChars) : p.av;
                return { emit: [{ to: '*', m: this.#roster() }] };
            }
            case 'chat': {
                const text = str(msg.m, this.o.chatChars);
                if (!text) return { emit: [] };
                if (now - p.chatWin > this.o.chatWindowMs) { p.chatWin = now; p.chatN = 0; }
                if (++p.chatN > this.o.chatMax) {
                    return { emit: [{ to: cid, m: { t: 'err', code: 'rate_limited', msg: 'slow down' } }] };
                }
                return { emit: [{ to: '*', m: { t: 'chat', from: cid, name: p.name, m: text, ts: now } }] };
            }
            case 'vote': {
                if (this.vote) return { emit: [{ to: cid, m: { t: 'err', code: 'rate_limited', msg: 'vote already running' } }] };
                const kind = str(msg.kind, 16, 'mode');
                const value = str(msg.value, 32);
                if (!value) return { emit: [] };
                this.vote = {
                    kind, value, opts: msg.opts || null, by: cid, name: p.name,
                    yes: new Set([cid]), no: new Set(),
                    endsAt: now + this.o.voteMs, need: this.#need(now),
                };
                // A timer the transport must arm; `alarmAt` is how the Durable
                // Object version stays correct even if its isolate is evicted.
                return { emit: [{ to: '*', m: { t: 'vote_new', ...this.#votePublic() } }], alarmAt: this.vote.endsAt, persist: true };
            }
            case 'vote_ballot': {
                if (!this.vote) return { emit: [] };
                const yes = !!msg.yes;
                (yes ? this.vote.no : this.vote.yes).delete(cid);
                (yes ? this.vote.yes : this.vote.no).add(cid);
                return { emit: [{ to: '*', m: { t: 'vote_new', ...this.#votePublic() } }] };
            }
            case 'promote': {
                if (cid !== this.host) return { emit: [{ to: cid, m: { t: 'err', code: 'not_host', msg: 'only the host can hand over' } }] };
                const target = this.players.get(String(msg.cid || ''));
                if (!target) return { emit: [] };
                this.pin = target.ready ? target.cid : null;
                if (!this.pin) return { emit: [{ to: cid, m: { t: 'err', code: 'no_host', msg: 'that player has no engine loaded yet' } }] };
                this.#electHost();
                return {
                    emit: [{ to: '*', m: this.#roster() }, { to: cid, m: { t: 'promoted', cid: this.pin } }],
                    persist: true,
                };
            }
            case 'ping':
                return { emit: [{ to: cid, m: { t: 'pong', c: msg.c, ts: now } }] };
            case 'leave':
                // Courtesy marker: stop counting this player before the socket dies.
                p.left = true;
                return { emit: [] };
            default:
                return { emit: [] };        // forward-compatible: ignore unknowns
        }
    }

    /**
     * Binary frames are video, and video only flows host → watchers. The payload
     * is never parsed, so `bytes` is only used for the size guard.
     * @returns {{to:string[],bytes:number}} `to` is empty when nobody should get it.
     */
    targetsForBinary(cid, bytes = 0) {
        if (cid !== this.host || bytes > this.o.maxFrameBytes) return { to: [], bytes };
        const to = [...this.players.values()].filter((p) => p.watching && p.cid !== cid).map((p) => p.cid);
        if (!to.length) this.drops++;
        return { to, bytes };
    }

    /** Called by the transport when its timer/alarm fires. */
    tally(now = Date.now()) {
        if (!this.vote) return { emit: [], alarmAt: null };
        const v = this.vote;
        this.vote = null;
        const passed = v.yes.size >= this.#need(now);
        const emit = [{ to: '*', m: { t: 'vote_end', kind: v.kind, value: v.value, by: v.by, yes: [...v.yes], no: [...v.no], need: this.#need(now), passed } }];
        if (passed && v.kind === 'mode') {
            this.state = { ...this.state, mode: v.value, opts: v.opts || {}, pad: null, padUntil: 0 };
            emit.push({ to: '*', m: this.#roster() });
        }
        return { emit, alarmAt: null, persist: true, passed };
    }

    /** Sockets the transport should drop as dead (silent longer than `ms`). */
    sweep(now = Date.now(), ms = 80_000) {
        const dead = [];
        for (const p of this.players.values()) if (now - p.lastSeen > ms) dead.push(p.cid);
        return dead;
    }

    /** Everything worth keeping across an eviction (or a restart). */
    snapshot() {
        return {
            key: this.key, host: this.host, pin: this.pin, state: this.state, createdAt: this.createdAt,
            players: [...this.players.values()].map((p) => ({
                cid: p.cid, id: p.id, name: p.name, av: p.av, plat: p.plat,
                ready: p.ready, watching: p.watching, joinedAt: p.joinedAt,
            })),
            vote: this.vote ? { ...this.vote, yes: [...this.vote.yes], no: [...this.vote.no] } : null,
        };
    }

    restore(snap = {}) {
        if (!snap) return this;
        this.host = snap.host ?? this.host;
        this.pin = snap.pin ?? null;
        if (snap.state) this.state = { ...this.state, ...snap.state };
        this.createdAt = snap.createdAt || 0;
        if (Array.isArray(snap.players)) {
            for (const p of snap.players) {
                if (!this.players.has(p.cid)) {
                    this.players.set(p.cid, {
                        ...p, bits: 0, left: false, lastSeen: 0, winStart: 0, winCount: 0, chatWin: 0, chatN: 0,
                    });
                }
            }
        }
        if (snap.vote) this.vote = { ...snap.vote, yes: new Set(snap.vote.yes || []), no: new Set(snap.vote.no || []) };
        return this;
    }

    #roster() { return { t: 'roster', host: this.host, players: this.public(), state: this.state }; }

    #votePublic() {
        const v = this.vote;
        return { kind: v.kind, value: v.value, by: v.by, name: v.name, need: v.need, endsAt: v.endsAt, yes: [...v.yes], no: [...v.no] };
    }

    /** Strict majority of the room, floor of 2 so a lone player can't self-pass. */
    #need() {
        const eligible = [...this.players.values()].filter((p) => !p.left);
        return Math.max(2, Math.floor(eligible.length / 2) + 1);
    }

    /** Pinned hand-over first, else first engine-loaded player, else first joiner. */
    #electHost() {
        let pick = null;
        if (this.pin && this.players.has(this.pin)) pick = this.pin;
        if (!pick) for (const p of this.players.values()) if (p.ready) { pick = p.cid; break; }
        if (!pick) for (const p of this.players.values()) { pick = p.cid; break; }
        const changed = pick !== this.host;
        this.host = pick;
        return changed;
    }
}
