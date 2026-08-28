// ============================================================
// worker/room.js — one Durable Object per room.
//
// The DO *is* the room: single writer, no locks, no cross-instance fan-out, and
// it sleeps (hibernates) between messages so an idle party costs nothing. All the
// rules — host election, star routing for inputs, room state, votes, rate
// windows — come from src/room-core.js, shared with the Node relay.
//
// Two hibernation details shape this file:
//   • In-memory state can vanish between events, so the room is snapshotted to
//     storage on every mutation and restored on wake.
//   • Socket routing must not depend on reading other sockets' attachments, so
//     every socket is tagged with its cid (`getWebSockets(cid)` resolves a
//     target) and broadcasts skip the sender by object identity.
// ============================================================

import { DurableObject } from 'cloudflare:workers';
import { RoomCore, roomKeyOf } from '../src/room-core.js';

const SNAPSHOT_KEY = 'room';

export class Sm64Room extends DurableObject {
    constructor(state, env) {
        super(state, env);
        this.core = null;
        this.loading = null;
    }

    // ── lifecycle ─────────────────────────────────────────────────────────
    async #core() {
        if (this.core) return this.core;
        if (!this.loading) {
            this.loading = (async () => {
                const snap = await this.ctx.storage.get(SNAPSHOT_KEY);
                const key = roomKeyOf(snap?.key || 'lobby');
                const core = new RoomCore(key, { maxPlayers: Number(this.env?.MAX_PLAYERS) || 8 });
                if (snap) core.restore(snap);
                this.core = core;
                return core;
            })().finally(() => { this.loading = null; });
        }
        return this.loading;
    }

    /** Persist the room so a hibernation/eviction cannot lose the mode or host. */
    async #save() {
        if (!this.core) return;
        await this.ctx.storage.put(SNAPSHOT_KEY, { key: this.core.key, ...this.core.snapshot() });
    }

    /**
     * Called when a room goes empty. Deleting the storage lets the object
     * hibernate away entirely; a Discord activity instance dies with its voice
     * channel, so there is nothing worth preserving at zero players.
     */
    async #closeIfEmpty() {
        if (this.core && this.core.players.size) return false;
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.delete(SNAPSHOT_KEY);
        this.core = null;
        return true;
    }

    // ── HTTP: the upgrade, plus a tiny status surface ───────────────────────
    async fetch(request) {
        const url = new URL(request.url);
        const upgrade = String(request.headers.get('Upgrade') || '').toLowerCase();

        if (upgrade !== 'websocket') {
            const core = await this.#core();
            const body = {
                ok: true, room: core.key, players: core.public().length,
                host: core.host, mode: core.state.mode, vote: core.vote ? 1 : 0,
            };
            return new Response(JSON.stringify(body, null, 2), {
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            });
        }

        const core = await this.#core();
        const room = roomKeyOf(url.searchParams.get('room') || url.searchParams.get('instance_id') || core.key);
        if (room !== core.key) core.key = room;

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        const res = core.join({
            name: url.searchParams.get('name'),
            id: url.searchParams.get('id'),
            av: url.searchParams.get('av'),
            plat: url.searchParams.get('plat'),
            ready: url.searchParams.get('ready') === '1',
            now: Date.now(),
        });

        if (!res.ok) {
            // Full room: answer like the Node relay does — an err frame, then a
            // closed socket, so the client can show "room is full" instead of a
            // silent failure. Accepting just to close is how that is done here.
            this.ctx.acceptWebSocket(server);
            try {
                server.send(JSON.stringify({ t: 'err', code: res.code, msg: res.msg, max: res.max }));
                server.close(4099, res.code);
            } catch { /* already gone */ }
            return new Response(null, { status: 101, webSocket: client });
        }

        // The tag is what survives hibernation: `getWebSockets('cid:x')` resolves a
        // target even while its socket is asleep, so routing never needs to wake
        // anyone up just to read a field.
        this.ctx.acceptWebSocket(server, [`cid:${res.cid}`]);
        server.serializeAttachment({ cid: res.cid, joinedAt: Date.now() });
        server.send(JSON.stringify(res.welcome));

        this.#fan(res.emit, core);
        await this.#save();
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, message) {
        const core = await this.#core();
        const cid = ws.deserializeAttachment()?.cid;
        if (!cid || !core.players.has(cid)) {
            try { ws.close(4001, 'stale connection'); } catch { /* already gone */ }
            return;
        }

        if (typeof message === 'string') {
            let msg = null;
            try { msg = JSON.parse(message); } catch { core.handle(cid, { t: 'bad' }, Date.now(), message.length); return; }
            const out = core.handle(cid, msg, Date.now(), message.length);
            this.#fan(out.emit, core);
            if (out.persist) await this.#save();
            // A ballot is the only thing worth an alarm for: it must settle even
            // if every player goes quiet, and it must not hold the object awake
            // afterwards.
            if (out.alarmAt) await this.ctx.storage.setAlarm(out.alarmAt);
            if (out.close) { try { ws.close(out.close.code, out.close.reason); } catch { /* already gone */ } }
            return;
        }

        // Binary = a video frame from the host, copied untouched to watchers.
        const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
        const size = bytes?.byteLength ?? 0;
        const { to } = core.targetsForBinary(cid, size);
        for (const target of to) {
            const sock = this.ctx.getWebSockets(`cid:${target}`)[0];
            if (!sock) continue;
            try { sock.send(bytes); } catch { /* viewer stalled; drop the frame */ }
        }
    }

    async webSocketClose(ws) {
        const core = await this.#core();
        const cid = ws.deserializeAttachment()?.cid;
        if (cid) {
            const out = core.leave(cid, Date.now());
            this.#fan(out.emit, core);
            await this.#save();
        }
        await this.#closeIfEmpty();
    }

    async webSocketError(ws) { await this.webSocketClose(ws); }

    /**
     * Vote deadline. `alarm()` is the only timer this relay keeps, because it is
     * the only outcome a client cannot recompute locally (the relay owns room
     * state, so a passed motion has to be written by the relay).
     */
    async alarm() {
        const core = await this.#core();
        if (core.vote) {
            const out = core.tally(Date.now());
            this.#fan(out.emit, core);
        }
        await this.ctx.storage.deleteAlarm();
        if (core.players.size) await this.#save();
        else await this.#closeIfEmpty();
    }

    // ── fan-out ─────────────────────────────────────────────────────────────
    /**
     * `emit` entries are `{to, m}` with `to` either a cid or `'*'`; `except` is
     * matched by socket identity rather than attachment, which is what makes
     * hibernation safe here.
     */
    #fan(emit = [], core = null) {
        for (const out of emit) {
            const text = JSON.stringify(out.m);
            if (out.to === '*') {
                // Broadcast by *membership*, not by `getWebSockets()`: the room's
                // own player list is authoritative, and the tagged lookup is the
                // one call that is guaranteed to resolve a hibernated socket. (An
                // untagged getWebSockets() is documented to return every socket,
                // but in local workerd it comes back empty for tagged/hibernated
                // ones — which would silently swallow roster updates.)
                // `except` is the core's own rule (the joiner already has the
                // roster in their `welcome`) — never an identity guess about who
                // sent the frame, or a host would be excluded from its own room.
                const skip = out.except ?? null;
                const targets = core ? core.players.keys()
                    : this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment?.()?.cid);
                for (const cid of targets) {
                    if (cid === skip) continue;
                    const ws = this.ctx.getWebSockets(`cid:${cid}`)[0];
                    if (!ws) continue;
                    try { ws.send(text); } catch { /* raced with a disconnect */ }
                }
            } else {
                const ws = this.ctx.getWebSockets(`cid:${out.to}`)[0];
                if (!ws) continue;
                try { ws.send(text); } catch { /* raced with a disconnect */ }
            }
        }
    }
}
