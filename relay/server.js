// ============================================================
// sm64-mp relay — a ~zero-dependency WebSocket room server.
//
// This is the *only* backend this Activity needs. Discord hands you identity,
// a room (the activity instance), a roster, invites and presence — it does NOT
// hand you a transport for game state, and WebRTC is unavailable in the Activity
// sandbox. WebSockets are available, so this file is the transport:
//
//   • rooms keyed by the Discord instance id (or a manual code in a browser tab)
//   • membership + deterministic host election (first player whose engine loaded)
//   • input fan-in (players → host) and state/roster fan-out (host → everyone)
//   • video fan-out for spectators, with drop-on-backpressure
//   • room chat and mode votes
//
// No npm install: the WebSocket framing is implemented here (RFC 6455 subset:
// text/binary/continuation, ping/pong/close, client-to-server masking).
//
//   node relay/server.js                 # http://0.0.0.0:8790
//   PORT=1234 node relay/server.js
//
// Behind Discord, add a URL mapping `/relay -> your-host:8790` in the developer
// portal (see DISCORD.md) and the client will reach it through the proxy.
// ============================================================

import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 2 * 1024 * 1024;      // hard cap per assembled message
const MAX_TEXT_PER_SEC = 60;              // per-connection flood guard
const CHAT_WINDOW_MS = 10_000;
const CHAT_MAX = 3;                       // chat messages per window
const VOTE_MS = 8_000;
const HEARTBEAT_MS = 25_000;
const DEAD_MS = 80_000;
const MAX_PLAYERS = 8;                    // SM64 in 4:3 is already a crowd

// ── tiny utils ─────────────────────────────────────────────────────────
const now = () => Date.now();
const rid = (n = 10) => crypto.randomBytes(n).toString('base64url');

function json(sock, obj) {
    sendFrame(sock, Buffer.from(JSON.stringify(obj), 'utf8'), 0x1);
}

/**
 * Send an unmasked WS frame. `dropIfSlow` is used for video: when a viewer's
 * TCP window is full we throw frames away instead of building latency, because
 * a stale frame of Mario is worse than no frame.
 */
function sendFrame(sock, payload, opcode, dropIfSlow = false) {
    if (!sock || sock.destroyed || sock.writableEnded) return false;
    if (dropIfSlow && sock.writableNeedDrain) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
        sock.write(Buffer.concat([header, payload]));
        return true;
    } catch {
        return false;
    }
}

// ── incoming-frame parser ──────────────────────────────────────────────
/**
 * Incremental RFC6455 decoder. Returns {messages:[[opcode, buffer]], close}
 * and is fed raw TCP chunks; leftovers stay in `state.buf`.
 */
function makeParser() {
    const state = { buf: Buffer.alloc(0), frag: null, fragOp: 0 };

    return function feed(chunk) {
        state.buf = state.buf.length ? Buffer.concat([state.buf, chunk]) : chunk;
        const out = { messages: [], close: null, error: null };

        for (;;) {
            const b = state.buf;
            if (b.length < 2) break;
            const fin = (b[0] & 0x80) !== 0;
            const opcode = b[0] & 0x0f;
            const masked = (b[1] & 0x80) !== 0;
            let len = b[1] & 0x7f;
            let off = 2;

            if (len === 126) {
                if (b.length < off + 2) break;
                len = b.readUInt16BE(off); off += 2;
            } else if (len === 127) {
                if (b.length < off + 8) break;
                const big = b.readBigUInt64BE(off); off += 8;
                if (big > BigInt(MAX_MESSAGE)) { out.error = 'too_big'; break; }
                len = Number(big);
            }
            if (len > MAX_MESSAGE) { out.error = 'too_big'; break; }

            let maskKey = null;
            if (masked) {
                if (b.length < off + 4) break;
                maskKey = b.subarray(off, off + 4); off += 4;
            }
            if (b.length < off + len) break;         // wait for the rest
            let payload = b.subarray(off, off + len);
            state.buf = b.subarray(off + len);

            if (masked && maskKey) {
                const un = Buffer.allocUnsafe(len);
                for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3];
                payload = un;
            }

            if (opcode === 0x8) { out.close = true; break; }
            if (opcode === 0x9) { sendFrame(state.sock, payload, 0xa); continue; }   // ping → pong
            if (opcode === 0xa) { out.messages.push([0xa, payload]); continue; }      // pong

            if (opcode === 0x0) {                                                     // continuation
                if (state.frag === null) { out.error = 'stray_continuation'; break; }
                state.frag.push(payload);
                if (fin) {
                    out.messages.push([state.fragOp, Buffer.concat(state.frag)]);
                    state.frag = null; state.fragOp = 0;
                }
                continue;
            }
            if (!fin) { state.frag = [payload]; state.fragOp = opcode; continue; }      // start of fragment
            out.messages.push([opcode, payload]);
        }
        return out;
    };
}

// ── relay ──────────────────────────────────────────────────────────────
export function createRelay(opts = {}) {
    const log = opts.log === false ? () => {} : (...a) => console.log('[relay]', ...a);
    /** @type {Map<string, Room>} */
    const rooms = new Map();
    let conns = 0;

    class Room {
        constructor(key) {
            this.key = key;
            this.players = new Map();       // cid → player, insertion order = join order
            this.host = null;               // cid
            this.state = { mode: 'solo', opts: {}, pad: null, padUntil: 0, tag: '' };
            this.vote = null;
            this.pin = null;                // explicit host hand-over
            this.createdAt = now();
        }

        // Host = the pinned player if the current host handed over, else the
        // first *engine-loaded* player, else first joined. Deterministic for
        // everyone because the relay is the single writer.
        electHost() {
            let pick = null;
            if (this.pin && this.players.has(this.pin)) pick = this.pin;
            if (!pick) for (const p of this.players.values()) {
                if (p.ready) { pick = p.cid; break; }
            }
            if (!pick) for (const p of this.players.values()) { pick = p.cid; break; }
            const changed = pick !== this.host;
            this.host = pick;
            if (changed) this.broadcast({ t: 'roster', host: this.host, players: this.public(), state: this.state });
            return changed;
        }

        public() {
            return [...this.players.values()].map((p) => ({
                cid: p.cid, id: p.id, name: p.name, av: p.av, plat: p.plat,
                ready: p.ready, host: p.cid === this.host, watching: p.watching,
                bits: p.bits, joinedAt: p.joinedAt,
            }));
        }

        broadcast(obj, exceptCid = null, dropIfSlow = false) {
            const buf = Buffer.from(JSON.stringify(obj), 'utf8');
            for (const p of this.players.values()) {
                if (p.cid === exceptCid) continue;
                sendFrame(p.sock, buf, 0x1, dropIfSlow);
            }
        }

        sendTo(cid, obj) {
            const p = this.players.get(cid);
            if (p) json(p.sock, obj);
        }

        scheduleVoteEnd() {
            if (this.voteTimer) clearTimeout(this.voteTimer);
            if (!this.vote) return;
            const ms = Math.max(0, this.vote.endsAt - now());
            this.voteTimer = setTimeout(() => this.tally(), ms);
            this.voteTimer.unref?.();
        }

        tally() {
            if (!this.vote) return;
            const v = this.vote;
            this.vote = null;
            const eligible = [...this.players.values()].filter((p) => !p.left);
            const need = Math.max(2, Math.floor(eligible.length / 2) + 1);
            const passed = v.yes.size >= need;
            this.broadcast({
                t: 'vote_end', kind: v.kind, value: v.value, by: v.by,
                yes: [...v.yes], no: [...v.no], need, passed,
            });
            // The relay applies accepted *mode* motions to the room state, so a
            // brand-new joiner sees the same mode as everyone else.
            if (passed && v.kind === 'mode') {
                this.state = { ...this.state, mode: v.value, opts: v.opts || {}, pad: null, padUntil: 0 };
                this.broadcast({ t: 'roster', host: this.host, players: this.public(), state: this.state });
            }
            this.gc();
        }

        gc() {
            if (this.players.size === 0 && !this.vote) {
                rooms.delete(this.key);
                if (this.voteTimer) clearTimeout(this.voteTimer);
            }
        }
    }

    function getRoom(key) {
        let r = rooms.get(key);
        if (!r) { r = new Room(key); rooms.set(key, r); log(`room ${key} opened`); }
        return r;
    }

    function handleText(room, player, text) {
        let m;
        try { m = JSON.parse(text); } catch { return json(player.sock, { t: 'err', code: 'bad_message', msg: 'not json' }); }
        if (!m || typeof m.t !== 'string') return;

        // flood guard
        const t = now();
        if (t - player.winStart > 1000) { player.winStart = t; player.winCount = 0; }
        if (++player.winCount > MAX_TEXT_PER_SEC) return;

        switch (m.t) {
            case 'hello': {
                // Sent right after the socket opens. The room itself is fixed by
                // the query string (it is the Discord instance id), so what this
                // frame really carries is the protocol version and a readiness
                // re-assert — a client that reconnects mid-boot knows more than it
                // did when the upgrade happened.
                if (m.ver && m.ver !== 1) {
                    json(player.sock, { t: 'err', code: 'version', msg: `relay speaks v1, client asked for v${m.ver}` });
                    try { player.sock.destroy(); } catch {}
                    return;
                }
                if (m.plat) player.plat = String(m.plat).slice(0, 12);
                if (typeof m.ready === 'boolean' && m.ready !== player.ready) {
                    player.ready = m.ready;
                    room.electHost();
                    room.broadcast({ t: 'roster', host: room.host, players: room.public(), state: room.state });
                }
                if (typeof m.watch === 'boolean' && m.watch !== player.watching) player.watching = m.watch;
                break;
            }
            case 'in': {
                const bits = (m.s | 0) & 0xffff;
                player.bits = bits;
                if (room.host && room.host !== player.cid) {
                    room.sendTo(room.host, { t: 'input', from: player.cid, s: bits, f: m.f | 0 });
                }
                break;
            }
            case 'profile':
                player.name = String(m.name || player.name).slice(0, 24);
                player.id = m.id ? String(m.id).slice(0, 32) : player.id;
                player.av = m.av ? String(m.av).slice(0, 64) : player.av;
                room.broadcast({ t: 'roster', host: room.host, players: room.public(), state: room.state });
                break;
            case 'ready':
                player.ready = !!m.ready;
                room.electHost();
                room.broadcast({ t: 'roster', host: room.host, players: room.public(), state: room.state });
                break;
            case 'watch':
                player.watching = !!m.on;
                room.electHost();
                room.broadcast({ t: 'roster', host: room.host, players: room.public(), state: room.state });
                break;
            case 'state':
                // Only the host may rewrite the session state.
                if (player.cid !== room.host) return json(player.sock, { t: 'err', code: 'not_host', msg: 'only the host sets state' });
                room.state = { ...room.state, ...(m.s || {}) };
                room.broadcast({ t: 'roster', host: room.host, players: room.public(), state: room.state });
                break;
            case 'chat': {
                const raw = String(m.m ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
                if (!raw) break;
                if (t - player.chatWin > CHAT_WINDOW_MS) { player.chatWin = t; player.chatN = 0; }
                if (++player.chatN > CHAT_MAX) return json(player.sock, { t: 'err', code: 'rate_limited', msg: 'slow down' });
                room.broadcast({ t: 'chat', from: player.cid, name: player.name, m: raw, ts: t });
                break;
            }
            case 'vote': {
                if (room.vote) return json(player.sock, { t: 'err', code: 'rate_limited', msg: 'vote already running' });
                const kind = String(m.kind || 'mode').slice(0, 16);
                const value = String(m.value ?? '').slice(0, 32);
                if (!value) break;
                const eligible = Math.max(2, Math.floor(room.players.size / 2) + 1);
                room.vote = {
                    kind, value, opts: m.opts || null, by: player.cid,
                    yes: new Set([player.cid]), no: new Set(), endsAt: t + VOTE_MS, need: eligible,
                };
                room.broadcast({
                    t: 'vote_new', kind, value, by: player.cid, name: player.name,
                    need: eligible, endsAt: room.vote.endsAt, yes: [player.cid], no: [],
                });
                room.scheduleVoteEnd();
                break;
            }
            case 'vote_ballot': {
                if (!room.vote) break;
                const set = m.yes ? room.vote.yes : room.vote.no;
                (m.yes ? room.vote.no : room.vote.yes).delete(player.cid);
                set.add(player.cid);
                room.broadcast({
                    t: 'vote_new', kind: room.vote.kind, value: room.vote.value, by: room.vote.by,
                    need: room.vote.need, endsAt: room.vote.endsAt,
                    yes: [...room.vote.yes], no: [...room.vote.no],
                });
                break;
            }
            case 'promote': {
                // "Hand the session to a friend": only the current host may pin,
                // and only onto a player who is actually here with a loaded engine.
                if (player.cid !== room.host) return json(player.sock, { t: 'err', code: 'not_host', msg: 'only the host can hand over' });
                const target = room.players.get(String(m.cid || ''));
                if (!target) break;
                room.pin = target.ready ? target.cid : null;
                if (!room.pin) return json(player.sock, { t: 'err', code: 'no_host', msg: 'that player has no engine loaded yet' });
                room.electHost();
                room.broadcast({ t: 'roster', host: room.host, players: room.public(), state: room.state });
                json(player.sock, { t: 'promoted', cid: room.pin });
                break;
            }
            case 'ping':
                json(player.sock, { t: 'pong', c: m.c, ts: t });
                break;
            case 'leave':
                player.left = true;
                break;
            default:
                break;
        }
    }

    function attach_(sock, roomKey, query) {
        conns++;
        sock.setNoDelay(true);
        const cid = rid(6);
        const room = getRoom(roomKey);
        const parse = makeParser();
        parse.sock = sock;

        const player = {
            cid, sock, room,
            id: query.get('id') || null,
            name: (query.get('name') || 'Player').slice(0, 24),
            av: query.get('av') || null,
            plat: query.get('plat') || 'desktop',
            ready: query.get('ready') === '1',
            watching: false,
            bits: 0,
            joinedAt: now(),
            lastSeen: now(),
            winStart: now(), winCount: 0,
            chatWin: 0, chatN: 0,
            left: false,
            drops: 0,
        };

        if (room.players.size >= MAX_PLAYERS) {
            json(sock, { t: 'err', code: 'room_full', msg: `${room.key} has ${room.players.size}/${MAX_PLAYERS}`, max: MAX_PLAYERS });
            sock.end();
            return;
        }

        room.players.set(cid, player);
        room.electHost();
        json(sock, {
            t: 'welcome', ver: 1, room: room.key, you: cid, sid: cid,
            host: room.host, players: room.public(), state: room.state,
            vote: room.vote ? { ...room.vote, yes: [...room.vote.yes], no: [...room.vote.no] } : null,
            maxPlayers: MAX_PLAYERS,
        });
        room.broadcast({ t: 'roster', host: room.host, players: room.public(), state: room.state }, cid);
        log(`${room.key}: ${player.name} joined (${room.players.size})`);

        sock.on('data', (chunk) => {
            player.lastSeen = now();
            const res = parse(chunk);
            if (res.error) { sock.destroy(); return; }
            for (const [op, payload] of res.messages) {
                if (op === 0x1) handleText(room, player, payload.toString('utf8'));
                else if (op === 0x2) {
                    // Video from the host → only the players who asked for a feed.
                    if (cid !== room.host) continue;
                    let n = 0;
                    for (const p of room.players.values()) {
                        if (p.cid === cid || !p.watching) continue;
                        if (sendFrame(p.sock, payload, 0x2, true)) n++; else p.drops++;
                    }
                    player.sent = (player.sent || 0) + n;
                }
            }
            if (res.close) { sock.end(); return; }
        });

        const cleanup = () => {
            if (player.removed) return;
            player.removed = true;
            room.players.delete(cid);
            conns--;
            const hadHost = room.host === cid;
            if (room.pin === cid) room.pin = null;
            room.electHost();
            if (room.vote && (room.vote.yes.has(cid) || room.vote.no.has(cid))) {
                room.vote.yes.delete(cid); room.vote.no.delete(cid);
            }
            room.broadcast({ t: 'roster', host: room.host, players: room.public(), state: room.state });
            log(`${room.key}: ${player.name} left (${room.players.size})${hadHost ? ' — host gone, re-elected ' + room.host : ''}`);
            room.gc();
            try { sock.destroy(); } catch {}
        };
        sock.on('close', cleanup);
        sock.on('error', cleanup);
        sock.on('end', cleanup);
    }

    // ── HTTP surface ───────────────────────────────────────────────────
    // Routes are relative (/status, /ws) so the whole thing can be mounted
    // inside the static server (`node server.js` does exactly that), which
    // keeps the relay same-origin and therefore reachable through Discord's
    // proxy with a single `/relay` URL mapping.
    function handleHttp(req, res) {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/status' || u.pathname === '/api/status' || u.pathname === '/relay/status') {
            const body = JSON.stringify({
                ok: true, relay: 'sm64-mp', time: new Date().toISOString(),
                rooms: [...rooms.values()].map((r) => ({
                    room: r.key, players: r.public(), host: r.host,
                    mode: r.state.mode, vote: r.vote ? 1 : 0, createdAt: new Date(r.createdAt).toISOString(),
                })),
                connections: conns, maxPlayers: MAX_PLAYERS,
            }, null, 2);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
            res.end(body);
            return true;
        }
        if (u.pathname === '/' || u.pathname === '/relay') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`sm64-mp relay\n\nWebSocket endpoint: ws://${req.headers.host}${u.pathname.startsWith('/relay') ? '/relay' : ''}/ws?room=CODE\nRooms open: ${rooms.size}\n`);
            return true;
        }
        return false;
    }

    function attach(server) {
        if (server.__sm64Relay) return server;
        server.__sm64Relay = true;
        server.on('upgrade', (req, socket) => {
            const u = new URL(req.url, 'http://x');
            // Tolerate both /ws and /relay/ws (the latter is what the Discord
            // proxy hands us after stripping its own prefix conventions).
            if (!/(^|\/)ws$/.test(u.pathname)) { socket.destroy(); return; }
            const key = req.headers['sec-websocket-key'];
            if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
            }
            const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
            const roomKey = (u.searchParams.get('room') || u.searchParams.get('instance_id') || 'lobby')
                .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'lobby';
            socket.write([
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${accept}`,
                '\r\n',
            ].join('\r\n'));
            attach_(socket, roomKey, u.searchParams);
        });
        return server;
    }

    const server = attach(http.createServer((req, res) => { if (!handleHttp(req, res)) { res.writeHead(404).end('not found'); } }));

    // heartbeat + dead-connection sweep
    const hb = setInterval(() => {
        const t = now();
        for (const room of rooms.values()) {
            for (const p of room.players.values()) {
                if (t - p.lastSeen > DEAD_MS) { try { p.sock.destroy(); } catch {} continue; }
                sendFrame(p.sock, Buffer.from('hb'), 0x9);
            }
        }
    }, HEARTBEAT_MS);
    hb.unref?.();

    return {
        server,
        attach,
        handleHttp,
        rooms,
        stats: () => ({ rooms: rooms.size, connections: conns }),
        close: () => new Promise((r) => { clearInterval(hb); server.close(r); }),
    };
}

// ── CLI ────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const PORT = Number(process.env.PORT || 8790);
    const HOST = process.env.HOST || '0.0.0.0';
    const relay = createRelay({ log: process.env.QUIET !== '1' });
    relay.server.listen(PORT, HOST, () => {
        console.log(`🍄 sm64-mp relay on ws://${HOST}:${PORT}/ws?room=CODE`);
        console.log(`   status: http://${HOST}:${PORT}/status`);
        console.log(`   inside Discord, map /relay → this host in the developer portal`);
    });
    process.on('SIGTERM', () => relay.close().then(() => process.exit(0)));
    process.on('SIGINT', () => relay.close().then(() => process.exit(0)));
}
