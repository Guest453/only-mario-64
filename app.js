// ============================================================
// app.js — Super Mario 64 Multiplayer, Discord Activity edition.
//
//   one SM64 engine (wasm) · one pad · everybody in the voice channel
//
// Responsibilities, in the order they matter:
//   1. ask Discord who we are and which room we are in        (src/discord.js)
//   2. get the wasm engine up                                    (src/engine.js)
//   3. join the relay room, become host if we are the engine        (src/net.js)
//   4. turn N players' buttons into one controller mask           (src/modes.js)
//   5. feed that mask to the engine as a phantom keyboard          (src/input.js)
//   6. push the picture to anyone who is not hosting              (src/stream.js)
//   7. keep the chrome honest about all of it                        (src/ui.js)
//
// Deliberately absent: any AI, any API key, any third-party account. Discord is
// the identity provider, the voice channel is the lobby, and only four things
// ever go on the wire: input masks, roster/state, chat, and low-res frames.
// ============================================================

import {
    dc, initDiscord, onDiscord, displayName, userColor, openInvite, shareLink,
    setPresence, installFocusGuard, refreshRoster, setLocalNick, isSmall,
} from './src/discord.js';
import { mockScenario } from './src/discord-mock.js';
import { Net, relayUrl } from './src/net.js';
import { Arbitrator, allowedMask } from './src/modes.js';
import { LocalController, attachTouch, applyMask, releaseAllInjected } from './src/input.js';
import { FrameStream, FramePlayer } from './src/stream.js';
import { whenEngine, setMuted, resumeAudio, engineSize, engineReady } from './src/engine.js';
import * as UI from './src/ui.js';
import { GROUPS, MODES, modeById, sanitizeName } from './src/protocol.js';

const $ = (id) => document.getElementById(id);

const S = {
    net: null,
    arb: null,
    local: null,
    player: null,
    stream: null,
    joined: false,
    shared: false,        // a relay room is driving the pad
    detached: false,      // a viewer chose to play their own copy instead
    quality: 'auto',      // auto | high | low | off
    muted: false,
    roleBits: 0xffff,
    rosterJson: '',
    padKey: '',
    note: '',
    engineOk: false,
    rotAt: 0,
};

boot();

// ── boot ───────────────────────────────────────────────────────────────
async function boot() {
    UI.setLoading(0.05, 'saying hello to Discord…');
    try { await initDiscord(); }
    catch (err) { console.warn('[app] discord init failed', err); dc.error = String(err?.message || err); }

    if (dc.sdk?.__mock) mockScenario(dc.sdk);
    UI.setLoading(0.12, 'loading the engine…');
    const enginePromise = whenEngine();      // parallel: nobody waits on nobody

    // Identity gate. Inside Discord there is nothing to fill in — the SDK tells
    // us who you are. Standalone we need a nickname and a room code, because
    // there is no activity instance to borrow one from.
    if (!dc.active || !dc.me?.id) showLobbyGate();
    else enter();

    S.engineOk = await enginePromise;
    UI.hideLoading();
    if (!S.engineOk) UI.toast('engine did not start — sm64.wasm missing, blocked, or too old a browser', 'bad', 12000);
    if (S.joined) S.net?.setReady(true);
    render();
}

function showLobbyGate() {
    const gate = $('lobby');
    if (!gate) return;
    gate.hidden = false;
    $('lobby-name').value = dc.me?.global_name || dc.me?.username || '';
    $('lobby-room').value = dc.instanceId || 'lobby';
    $('lobby-lead').textContent = dc.active
        ? 'Discord did not hand us an identity (old client, or the RPC bridge is unavailable). '
          + 'Pick a name — the room is still this Activity instance, so your friends land in it automatically.'
        : 'You are not inside Discord, so the Activity SDK cannot supply your account name, the voice-channel '
          + 'room, or invites. Everything else still works: pick a name and share a room code.';
    $('lobby-go').onclick = () => {
        if (!dc.active) {
            setLocalNick($('lobby-name').value || 'Guest');
            dc.instanceId = sanitizeName($('lobby-room').value, 'lobby');
        }
        gate.hidden = true;
        enter();
    };
    $('lobby-room').addEventListener('input', () => { $('lobby-go').disabled = false; });
    setTimeout(() => { try { $('lobby-name').focus({ preventScroll: true }); } catch {} }, 80);
}

function enter() {
    const app = $('app');
    if (app) app.hidden = false;
    UI.hideLoading();

    S.arb = new Arbitrator({ mode: 'solo', selfCid: null });
    wireChrome();
    connect();
    requestAnimationFrame(tick);

    // Discord iframes start WITHOUT keyboard focus, which silently eats every
    // keypress; the guard reclaims it right after the user touches us.
    installFocusGuard(() => (UI.isTyping() ? $('chat-input') : ($('canvas') || document.body)));

    addEventListener('pointerdown', () => resumeAudio(), { once: true });
    addEventListener('keydown', (e) => {
        if (UI.isTyping()) return;
        if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey) toggleHelp();
        if (e.code === 'Slash' || e.code === 'KeyF1') { e.preventDefault(); toggleHelp(true); }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) S.local?.releaseAll();
        else if (S.shared) { resumeAudio(); render(); }
    });
    addEventListener('resize', () => render(), { passive: true });
}

// ── networking ─────────────────────────────────────────────────────────
function connect() {
    const profile = {
        id: dc.me?.id || null,
        name: displayName(dc.me || {}, 'Player'),
        avatar: dc.me?.avatar || null,
    };

    S.net = new Net({
        isReady: () => engineReady(),
        onWelcome: (m) => {
            S.joined = true;
            S.arb.selfCid = m.you;
            S.net.setReady(true);
            syncFromRoom();
            applyInputPolicy();      // settles host vs viewer for good
            UI.toast(`in room ${m.room} · ${m.players.length} connected`, 'good', 3200);
            if (!m.host || m.host !== m.you) startWatching(true);
            else UI.toast('you are hosting — your engine is the session', 'info', 4200);
        },
        onRoster: () => { syncFromRoom(); render(); },
        onHost: () => { onHostChanged(); render(); },
        onInput: (from, bits) => S.arb.setInput(from, bits),
        onChat: (m) => UI.pushChat($('chat-log'), {
            name: m.from === S.net.you ? null : m.name, text: m.m, self: m.from === S.net.you,
        }),
        onVote: (v) => { S.vote = v; UI.renderVote($('vote'), v, { onBallot: (yes) => S.net.ballot(yes), meCid: S.net.you }); },
        onVoteEnd: (v) => {
            S.vote = null;
            UI.renderVote($('vote'), null, { onBallot: () => {}, meCid: null });
            UI.toast(v.passed ? `vote passed → ${modeById(v.value).label}` : 'vote failed', v.passed ? 'good' : 'warn');
            syncFromRoom();
            if (v.passed && v.kind === 'mode') applyInputPolicy();
        },
        onFrame: (f) => S.player?.push(f),
        onPong: () => render(),
        onStatus: (st, net, detail) => {
            UI.chip($('chip-net'), {
                text: st === 'online' ? '● live' : st === 'connecting' ? '◌ linking' : st === 'retryping' ? '↻ retry' : '○ solo',
                tone: st === 'online' ? 'ok' : st === 'offline' ? 'bad' : 'warn',
                title: `relay ${detail || st}\n${relayUrl(dc.instanceId || 'lobby')}`,
            });
            // No relay ⇒ everybody plays their own copy. That's the designed
            // fallback, not a crash: an Activity must be playable alone.
            const wasShared = S.shared;
            S.shared = st === 'online';
            if (wasShared && !S.shared) { S.detached = false; releaseAllInjected(); }
            applyInputPolicy();
            render();
        },
        onError: (m) => {
            if (m.code === 'room_full') {
                UI.toast(`room is full (${m.max || 8}) — start a second Activity in another voice channel`, 'bad', 9000);
                S.shared = false;
                applyInputPolicy();
            } else if (m.code !== 'rate_limited') {
                UI.toast(`relay: ${m.msg || m.code}`, 'warn', 5000);
            }
        },
    });
    S.net.connect(dc.instanceId || 'lobby', profile);

    UI.chip($('chip-room'), {
        text: `room ${dc.instanceId || 'lobby'}`,
        title: [
            dc.active ? `Discord instance · guild ${dc.guildId || '?'} · channel ${dc.channelId || '?'}` : 'local session',
            `relay ${relayUrl(dc.instanceId || 'lobby').split('?')[0]}`,
        ].join('\n'),
    });
}

/** Relay room state → the local arbitrator (mode, options, rotation, pad). */
function syncFromRoom() {
    const net = S.net;
    if (!net) return;
    const state = net.state || {};
    const mode = modeById(state.mode || 'solo');
    const opts = { ...mode.opts, ...(state.opts || {}) };
    const changed = S.arb.mode !== mode.id || JSON.stringify(S.arb.opts) !== JSON.stringify(opts);
    S.arb.mode = mode.id;
    S.arb.opts = opts;
    if (typeof state.rot === 'number' && state.rot !== S.arb.offset) S.arb.rotate(state.rot);
    else if (changed) S.arb.reassign();
    S.arb.padHolder = state.pad || null;
    S.arb.padUntil = state.padUntil || 0;
    S.arb.setPlayers(playersList());
    if (changed) applyInputPolicy();
    schedulePresence();
}

function playersList() {
    const net = S.net;
    if (!net) return [];
    return [...net.players.values()].map((p) => ({
        cid: p.cid, id: p.id, name: p.name || 'Player', av: p.av,
        ready: !!p.ready, host: !!p.host, watching: !!p.watching, bits: p.bits | 0,
    }));
}

function onHostChanged() {
    const net = S.net;
    if (!net || !S.joined) return;
    if (net.isHost) {
        S.detached = false;
        releaseAllInjected();
        net.setState({ mode: S.arb.mode, opts: S.arb.opts, pad: null, padUntil: 0 });
        startStream();
        UI.toast('this session now runs on your engine', 'good', 4200);
    } else {
        applyMask(0);
        stopStream();
        startWatching(true);
        UI.toast('the session moved to another player — you are watching + pressing', 'warn', 4200);
    }
    applyInputPolicy();
}

// ── the multiplayer loop: N button streams → one controller mask ──────────
let lastTick = 0;
function tick() {
    requestAnimationFrame(tick);
    const net = S.net;
    if (!net || !S.shared || S.detached || document.hidden) return;
    const now = Date.now();
    if (now - lastTick < 16) return;         // ~60 Hz ceiling; the engine samples at 30
    lastTick = now;

    if (net.isHost) {
        const mask = S.arb.step(now, S.local?.bits ?? 0) & 0xffff;
        applyMask(mask);

        // coop auto-rotation lives in room state so every client agrees
        const rot = S.arb.opts.rotate | 0;
        if (S.arb.mode === 'coop' && rot > 0) {
            if (!S.rotAt) S.rotAt = now;
            if (now - S.rotAt > rot * 1000) {
                S.rotAt = now;
                net.setState({ rot: S.arb.rotate() });
            }
        }
        // hot-potato: the holder is room state, not host-local state
        if (S.arb.mode === 'potato') {
            const key = `${S.arb.padHolder}:${S.arb.padUntil}`;
            if (key !== S.padKey) { S.padKey = key; net.setState({ pad: S.arb.padHolder, padUntil: S.arb.padUntil }); }
        }
        const note = S.arb.note || '';
        if (note !== S.note) { S.note = note; $('mode-note').textContent = note; }
    } else {
        // Viewers run the same arbitrator locally, purely so the HUD can show
        // which slice of the pad belongs to them right now.
        S.arb.step(now, S.local?.bits ?? 0);
    }
}

/**
 * Which input path is live:
 *   shared + host    → keys swallowed; engine sees only the arbitrated mask
 *   shared + viewer  → keys swallowed; mask goes to the host over the relay
 *   detached / solo  → keys pass straight into the local engine (classic play)
 */
function applyInputPolicy() {
    const shared = S.shared && !S.detached;
    if (S.local) {
        S.local.enabled = shared;
        S.local.swallow = () => shared;
        if (!shared) releaseAllInjected();
    }
    const role = shared && S.net ? S.arb.localRole(S.net.you) : null;
    S.roleBits = shared ? allowedMask(S.arb.mode, role) : 0xffff;

    const root = document.documentElement;
    root.classList.toggle('shared-pad', shared);
    root.classList.toggle('is-host', !!(shared && S.net?.isHost));
    root.classList.toggle('free-roam', !shared);

    const feed = $('feed-wrap');
    if (feed) feed.hidden = !(shared && S.net && !S.net.isHost && S.quality !== 'off');
    const note = $('solo-note');
    if (note) note.hidden = shared;

    const banner = $('banner-text');
    if (banner) {
        if (!S.joined && S.net?.status === 'offline') banner.textContent = 'relay unreachable — this is your own copy. docs/RELAY.md takes 2 minutes';
        else if (S.detached) banner.textContent = 'you are on your own copy — the shared session keeps running';
        else if (!shared) banner.textContent = '';
        else if (S.net?.isHost) banner.textContent = `hosting · ${modeById(S.arb.mode).label} · ${S.net.activePlayers.length} pressing`;
        else if (role) banner.textContent = `you control ${role.icon} ${role.label} — ${role.hint}`;
    }
    const btn = $('btn-detach');
    if (btn) btn.textContent = S.detached ? '🔁 back to the shared pad' : '🎮 play my own copy';

    // Watching means listening to the host too: your own copy keeps running
    // silently underneath, and two SM64s at once is just noise. A manual mute
    // always wins.
    if (!S.muteLock) {
        const quiet = shared && S.net && !S.net.isHost;
        if (quiet !== S.muted) { S.muted = quiet; setMuted(quiet); }
        const mb = $('btn-mute');
        if (mb) mb.textContent = S.muted ? '🔇' : '🔊';
    }
    startWatching(!!(shared && S.net && !S.net.isHost && S.quality !== 'off'));
    render();
}

// ── spectating: the only "video" the Activity sandbox allows ──────────────
function startWatching(on) {
    const net = S.net;
    if (!net) return;
    if (on && !S.player) S.player = new FramePlayer($('feed'));
    if (!!on !== !!S.watching) { S.watching = !!on; net.setWatching(!!on); }
}

function startStream() {
    if (S.stream || !S.net) return;
    S.stream = new FrameStream({
        source: $('canvas'),
        viewers: () => [...S.net.players.values()].filter((p) => p.watching && p.cid !== S.net.you).length,
        send: (bytes, i, t) => S.net.sendFrame(i, t, bytes),
    });
    S.stream.start();
}

function stopStream() {
    if (!S.stream) return;
    S.stream.stop();
    S.stream = null;
}

// ── chrome ───────────────────────────────────────────────────────────────
function wireChrome() {
    S.local = new LocalController({
        onBits: (bits) => {
            if (!S.net || !S.shared || S.detached) return;
            S.net.sendInput(bits & S.roleBits);
        },
        swallow: () => true,
    });
    attachTouch(S.local);
    applyInputPolicy();

    $('btn-invite').onclick = async () => {
        const r = await openInvite();
        if (typeof r === 'string' && r.startsWith('http')) UI.toast('invite link copied — paste it in the channel', 'good');
    };
    $('btn-share').onclick = async () => {
        const ok = await shareLink(`Join my ${modeById(S.arb.mode).label} SM64 session`);
        if (!ok) {
            const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(dc.instanceId || 'lobby')}`;
            try { await navigator.clipboard.writeText(url); UI.toast('link copied', 'good'); }
            catch { UI.toast(url, 'info', 9000); }
        }
    };
    // On tiny layouts the side panel is an overlay: the player count toggles it.
    $('chip-players').onclick = () => document.documentElement.classList.toggle('side-open');
    $('btn-help').onclick = () => toggleHelp(true);
    $('btn-help-close').onclick = () => toggleHelp(false);
    $('help').onclick = (e) => { if (e.target === $('help')) toggleHelp(false); };
    fillHelpModes();
    $('btn-mute').onclick = () => toggleMute();
    $('btn-shuffle').onclick = () => {
        if (S.net?.isHost) net_setRot((S.arb.offset | 0) + 1);
        else { S.net?.vote('mode', S.arb.mode, { rot: (S.arb.offset | 0) + 1 }); UI.toast('vote called to reshuffle', 'info'); }
    };
    $('btn-rotate').onclick = () => {
        const on = !(S.arb.opts.rotate | 0);
        S.arb.opts.rotate = on ? 30 : 0;
        if (S.net?.isHost) S.net.setState({ opts: { ...S.arb.opts } });
        else S.net?.vote('mode', S.arb.mode, { ...S.arb.opts });
        UI.toast(on ? 'groups rotate every 30s' : 'groups frozen', 'info', 2600);
    };
    $('btn-detach').onclick = () => {
        if (S.net?.isHost) { UI.toast('you ARE the session — detaching would stop it for everyone', 'warn'); return; }
        S.detached = !S.detached;
        if (S.detached) { applyMask(0); }
        applyInputPolicy();
    };
    $('btn-quality').onclick = () => {
        const order = ['auto', 'high', 'low', 'off'];
        S.quality = order[(order.indexOf(S.quality) + 1) % order.length];
        const b = $('btn-quality');
        if (b) b.textContent = `▦ ${S.quality}`;
        if (S.stream) {
            if (S.quality === 'low') { S.stream.width = 320; S.stream.fps = 6; S.stream.quality = 0.4; }
            if (S.quality === 'high') { S.stream.width = 640; S.stream.fps = 14; S.stream.quality = 0.6; }
            if (S.quality === 'auto') { S.stream.width = 480; S.stream.fps = 10; S.stream.quality = 0.5; }
        }
        applyInputPolicy();
    };
    $('btn-reconnect').onclick = () => {
        S.net.disconnect();
        S.joined = false;
        setTimeout(connect, 350);
    };

    const form = $('chat-form');
    form.onsubmit = (e) => {
        e.preventDefault();
        const input = $('chat-input');
        const v = input.value.trim();
        if (!v) return;
        if (S.net?.status !== 'online') { UI.toast('not in a room yet — your chat stays local', 'warn'); return; }
        S.net.chat(v);
        UI.pushChat($('chat-log'), { name: null, text: v, self: true });
        input.value = '';
    };
    // Chat must never steer Mario: input.js skips typing targets, and Esc leaves
    // the box so the pad goes back to the game.
    $('chat-input').addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') e.target.blur();
    });

    onDiscord((what) => {
        if (what === 'user' && S.net) {
            S.net.updateProfile({ id: dc.me?.id || null, name: displayName(dc.me || {}, 'Player'), avatar: dc.me?.avatar || null });
            render();
        }
        if (what === 'roster' || what === 'speaking') render();
        if (what === 'layout') render();
    });
}

function net_setRot(n) {
    S.arb.rotate(n);
    S.net.setState({ rot: S.arb.offset });
    UI.toast('groups reshuffled', 'info', 2200);
}

function toggleMute(force) {
    S.muted = typeof force === 'boolean' ? force : !S.muted;
    S.muteLock = true;                 // an explicit choice outranks auto-mute
    setMuted(S.muted);
    const b = $('btn-mute');
    if (b) b.textContent = S.muted ? '🔇' : '🔊';
}

function toggleHelp(on) {
    const box = $('help');
    if (!box) return;
    box.hidden = typeof on === 'boolean' ? !on : !box.hidden;
}

function fillHelpModes() {
    const ul = $('help-modes');
    if (!ul) return;
    ul.replaceChildren();
    for (const m of MODES) {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = `${m.icon} ${m.label}`;
        li.appendChild(b);
        li.appendChild(document.createTextNode(` — ${m.desc}`));
        ul.appendChild(li);
    }
}

// ── render (rAF-throttled, idempotent, no layout thrash) ─────────────────
let renderQueued = false;
function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; paint(); });
}

function paint() {
    const net = S.net;
    const players = net ? playersList() : [];
    const byId = new Map(players.map((p) => [p.cid, p]));
    const meCid = net?.you;
    const rows = [];

    // Discord's instance roster is a superset of the relay room (people in the
    // Activity, not yet in the room), so they show up greyed out with a nudge.
    const relayIds = new Set(players.map((p) => p.id).filter(Boolean));
    for (const u of dc.roster || []) {
        if (u?.id && !relayIds.has(String(u.id))) {
            rows.push({
                cid: `dc:${u.id}`, name: displayName(u, 'Player'), user: u,
                ready: false, isMe: String(u.id) === String(dc.me?.id), onlyDiscord: true,
                talking: dc.speakers.has(String(u.id)),
            });
        }
    }
    for (const p of players) {
        rows.push({
            cid: p.cid,
            name: p.name,
            user: { id: p.id, username: p.name, global_name: p.name, avatar: p.av },
            ready: p.ready,
            host: p.host,
            watching: p.watching,
            bits: p.bits,
            isMe: p.cid === meCid,
            talking: p.id ? dc.speakers.has(String(p.id)) : false,
            role: S.shared && S.arb ? S.arb.localRole(p.cid) : null,
            ping: p.cid === meCid ? (net?.rtt ?? null) : null,
        });
    }
    rows.sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0) || (a.isMe ? -1 : b.isMe ? 1 : 0)
        || String(a.name).localeCompare(String(b.name)));

    // Only rebuild the list when something visible changed — but "visible"
    // includes who is talking, which arrives over Discord, not the relay.
    const sig = JSON.stringify(rows.map((r) => [r.cid, r.ready, r.host, r.watching, r.bits, r.talking, r.role?.id]));
    if (sig !== S.rosterJson) {
        S.rosterJson = sig;
        UI.renderRoster($('roster'), rows, {
            canManage: !!net?.isHost,
            onMakeHost: (r) => { net.promote(r.cid); UI.toast(`handing the session to ${r.name}…`, 'info'); },
        });
        UI.chip($('chip-players'), { text: `👥 ${rows.length}`, title: `${players.filter((p) => p.ready).length} ready · ${dc.roster?.length || 0} in the Activity` });
        const sub = $('roster-sub');
        if (sub) sub.textContent = S.shared ? `relay ${net.status}${net.players.size >= 8 ? ' · full' : ''}` : 'your own copy';
        if (S.arb?.mode === 'coop') UI.renderGroups($('grpbar'), ownerByGroup(), byId, meCid);
        else {
            const gb = $('grpbar');
            if (gb) { gb.replaceChildren(); const m = modeById(S.arb?.mode || 'solo'); gb.appendChild(UI.h('div', 'fine', `${m.icon} ${m.label} — ${m.desc}`)); }
        }
        UI.renderModes($('modes'), S.arb?.mode || 'solo', {
            canHost: () => !!net?.isHost,
            onPick: (x) => setMode(x),
            onVote: (x) => { net?.vote('mode', x); UI.toast('vote called — 8s to agree', 'info'); },
        });
        paintTags(rows);
    }
    UI.chip($('chip-ping'), { text: net?.rtt ? `${net.rtt}ms` : '— ms', tone: (net?.rtt || 0) > 400 ? 'bad' : (net?.rtt || 0) > 180 ? 'warn' : 'ok' });
    paintDiag(players, net);
    if (S.stream && net?.isHost) S.stream.tune(net.ws?.bufferedAmount || 0);
    document.documentElement.classList.toggle('compact', isSmall());
}

/** group id → cid of whoever currently holds it, honouring the rotation. */
function ownerByGroup() {
    const out = new Map(GROUPS.map((g) => [g.id, null]));
    for (const [cid, gid] of S.arb.groupOf) if (out.has(gid)) out.set(gid, cid);
    return out;
}

/** Floating chips over the picture: who holds what, and whether they are pressing. */
function paintTags(rows) {
    const box = $('tags');
    if (!box) return;
    box.replaceChildren();
    if (!S.shared) return;
    for (const r of rows) {
        if (!r.ready) continue;
        const chip = UI.h('div', 'tag' + (r.isMe ? ' me' : '') + (r.host ? ' host' : '') + (r.bits ? ' pressing' : ''));
        chip.style.setProperty('--ring', userColor({ id: r.user?.id || r.cid }));
        chip.appendChild(UI.h('b', null, r.name));
        if (r.role) chip.appendChild(UI.h('i', null, `${r.role.icon}${r.role.label}`));
        box.appendChild(chip);
    }
    if (!box.children.length) box.appendChild(UI.h('div', 'tag empty', 'nobody ready yet'));
}

function paintDiag(players, net) {
    const d = $('diag');
    if (!d) return;
    const size = engineSize();
    const items = [
        ['platform', dc.active ? `discord · ${dc.platform}` : 'browser tab'],
        ['instance', dc.instanceId || '—'],
        ['client id', dc.clientId || (dc.active ? 'MISSING — sdk cannot handshake' : 'n/a')],
        ['identity', dc.authed ? 'oauth (authorized)' : 'SDK payload · no oauth needed'],
        ['you', `${displayName(dc.me || {}, 'Player')} · ${dc.me?.id || 'local'}`],
        ['relay', `${net?.status || '—'}${net?.detail ? ` (${net.detail})` : ''}`],
        ['host', net?.host ? (players.find((p) => p.cid === net.host)?.name || net.host) : '—'],
        ['mode', `${S.arb?.mode || 'solo'} · ${S.arb?.note || 'idle'}`],
        ['your slice', UI.maskLabel(S.roleBits & 0xffff)],
        ['tx/rx', `${net?._stats?.sent ?? 0} / ${net?._stats?.recv ?? 0} msgs · ${net?._stats?.dropped ?? 0} dropped`],
        ['uplink', S.stream ? `${S.stream.stats.kbps} kbit/s · ${S.stream.width}px · ${S.stream.stats.skipped} skipped` : 'not streaming'],
        ['downlink', S.player ? `${S.player.stats.frames} frames · ${S.player.stats.dropped} dropped · ${S.player.stats.latency}ms late` : '—'],
        ['engine', `${size.w}×${size.h} · ${S.engineOk ? 'ready' : 'starting'}`],
    ];
    d.replaceChildren();
    for (const [k, v] of items) { d.appendChild(UI.h('dt', null, k)); d.appendChild(UI.h('dd', null, v)); }
    const rel = $('diag-relay');
    if (rel) rel.textContent = relayUrl(dc.instanceId || 'lobby');
    const lat = $('feed-lat');
    if (lat) lat.textContent = S.player ? `${S.player.stats.latency}ms · ${S.player.stats.frames}f` : '—';
}

// ── modes ────────────────────────────────────────────────────────────────
function setMode(id) {
    const m = modeById(id);
    S.arb.mode = m.id;
    S.arb.opts = { ...m.opts };
    S.arb.reassign();
    if (S.net?.isHost) S.net.setState({ mode: m.id, opts: S.arb.opts, pad: null, padUntil: 0 });
    else { S.net?.vote('mode', m.id); UI.toast('only the host flips modes — a vote was called instead', 'info'); return; }
    applyInputPolicy();
    UI.toast(`${m.icon} ${m.label} — ${m.desc}`, 'info', 6500);
    schedulePresence();
}

// ── presence: "Playing SM64 · Democracy · 5 in party" ────────────────────
let presenceT = null;
function schedulePresence() {
    clearTimeout(presenceT);
    // setActivity needs rpc.activities.write, i.e. a token; `?presence=1` forces
    // the attempt anyway so the path can be exercised (mock SDK, local dev).
    if (!dc.active) return;
    const force = new URLSearchParams(location.search).get('presence') === '1';
    if (!dc.authed && !force) return;
    presenceT = setTimeout(() => {
        const n = S.net?.activePlayers.length || 1;
        const m = modeById(S.arb?.mode || 'solo');
        setPresence({
            details: `${m.icon} ${m.label}`,
            state: n > 1 ? `${n} sharing one pad` : 'waiting for the voice channel',
            partySize: n,
            partyMax: 8,
        });
    }, 1500);
}

// Console handle for poking a live session: __sm64.state, __sm64.dc,
// __sm64.setMode('anarchy'), __sm64.relayUrl(). Also how the tests reach in.
window.__sm64 = {
    get state() { return S; },
    dc, openInvite, shareLink, schedulePresence,
    join: enter, setMode, toast: (m, k) => UI.toast(m, k),
    relayUrl: () => relayUrl(dc.instanceId || 'lobby'),
};

// The Discord roster can move without any relay traffic (someone opens the
// Activity but has no relay reachable), so poll it gently.
setInterval(() => {
    if (dc.active) refreshRoster().catch(() => {});
    render();
}, 6000);
