// ============================================================
// src/discord.js — the Discord *Activities* (Embedded App SDK) layer.
//
// Everything identity-shaped in this app comes from here, never from a
// text box. What the SDK actually gives an Activity (measured against the
// vendored @discord/embedded-app-sdk v2.5.0 in ../lib/ and
// https://docs.discord.com/developers/developer-tools/embedded-app-sdk):
//
//   sdk.instanceId                the room. Same for everyone who joined the
//                                 same Activity in the same voice channel;
//                                 gone when everyone leaves. → our room code.
//   sdk.guildId / channelId       where it was launched from.
//   sdk.platform                  'desktop' | 'mobile' (mobile ⇒ touch UI).
//   ready() payload data.user     {id, username, discriminator, avatar} of the
//                                 PLAYER RUNNING US — no OAuth scope needed.
//   getInstanceConnectedParticipants()  every user connected to this instance,
//                                 with global_name + avatar hash — no scope.
//   ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE  join/leave pushes for that roster.
//   openInviteDialog()            native "add people to this channel/activity"
//                                 modal, no scope needed.
//   inviteUserEmbedded()          DM an invite card to one user (v2.x, no scope).
//   shareLink()                 native share modal for a deep link.
//   setActivity()               rich presence ("Playing SM64 with 4 others")
//                                 — needs a token with rpc.activities.write.
//   ACTIVITY_LAYOUT_MODE_UPDATE  FOCUSED / PIP / GRID → we shrink the chrome.
//   ORIENTATION_UPDATE, THERMAL_STATE_UPDATE → mobile quality knobs.
//   openExternalLink()           the only way out of the iframe.
//   captureLog()                 push our console into Discord's logs.
//
// What it deliberately does NOT give you: any transport for game state. The
// proxy supports HTTP + WebSockets but not WebRTC, so multiplayer lives in
// src/net.js on top of the small relay in ../relay/server.js.
//
// OPTIONAL AUTH: `authorize()` returns an authorization *code* only; swapping it
// for an access token needs your app secret, i.e. a server. We therefore treat
// auth as an upgrade: with zero backend you still get names, avatars, roster,
// invites, layout events. Point `TOKEN_ENDPOINT` at a tiny exchange endpoint
// and you additionally get global_name everywhere, rich presence, guild nick
// avatars and voice "who's talking". See docs/SDK-NOTES.md §Auth.
// ============================================================

import { sanitizeName } from './protocol.js';
import { mockSDK } from './discord-mock.js';

/** `?mock=1` — develop/demo the Discord data path in a plain tab (src/discord-mock.js). */
export function mockRequested() {
    try {
        const q = new URLSearchParams(location.search);
        return q.get('mock') === '1' && q.get('discord') !== '0';
    } catch { return false; }
}

const SDK_URL = '../lib/discord-embedded-sdk.js';   // relative to src/ — the vendored bundle sits at the root

/** Set to a same-origin path (e.g. '/auth/token') if you ship a token exchanger. */
export const TOKEN_ENDPOINT = '';
/** Scopes we ask for. Everything is optional; the roster works without them. */
export const SCOPES = ['identify', 'guilds', 'guilds.members.read', 'rpc.activities.write'];

const LAYOUT = { UNHANDLED: -1, FOCUSED: 0, PIP: 1, GRID: 2 };

// ── state shared with the rest of the app ──────────────────────────────
export const dc = {
    active: false,           // are we inside a Discord client?
    sdk: null,
    clientId: null,
    instanceId: null,
    guildId: null,
    channelId: null,
    platform: 'desktop',
    cdnHost: 'cdn.discordapp.com',
    apiEndpoint: '/discord',
    authed: false,
    scopes: [],
    me: null,                // {id, username, global_name, discriminator, avatar}
    roster: [],              // instance participants from the SDK
    layoutMode: LAYOUT.UNHANDLED,
    speakers: new Set(),     // user ids currently talking (needs rpc.voice.read)
    error: null,
};

const listeners = new Set();
const emit = (what, payload) => { for (const l of listeners) { try { l(what, payload, dc); } catch (e) { console.warn('[discord] listener', e); } } };
export const onDiscord = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// ── environment sniffing ───────────────────────────────────────────────
export function detectActivity() {
    const q = new URLSearchParams(location.search);
    if (q.get('discord') === '0') return false;
    if (mockRequested()) return true;
    if (q.has('frame_id') && q.has('instance_id')) return true;
    if (/^\d+\.discordsays\.com$/i.test(location.hostname)) return true;
    if (window.parent && window.parent !== window && q.has('frame_id')) return true;
    return false;
}

/** <app-id>.discordsays.com encodes the client id; a dev can also paste one. */
export function detectClientId() {
    const m = location.hostname.match(/^(\d+)\.discordsays\.com$/i);
    if (m) return m[1];
    const q = new URLSearchParams(location.search).get('client_id');
    if (q) return q;
    try { return localStorage.getItem('sm64mp_client_id') || null; } catch { return null; }
}

// ── users: names + avatars ─────────────────────────────────────────────
/** Best human-readable name for a Discord user object (roster or READY). */
export function displayName(user, fallback = 'Player') {
    if (!user) return fallback;
    const g = user.global_name || user.nick || user.username;
    const legacy = user.discriminator && user.discriminator !== '0' ? `#${user.discriminator}` : '';
    return sanitizeName(g ? `${g}${legacy}` : fallback, fallback);
}

/** Avatar URL from the CDN. a_ prefixed hashes are animated (gif). */
export function avatarUrl(user, size = 64, cdnHost = dc.cdnHost) {
    if (!user?.id) return null;
    if (user.avatar) {
        const ext = String(user.avatar).startsWith('a_') ? 'gif' : 'png';
        return `https://${cdnHost}/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
    }
    // Default avatar: new usernames derive from the snowflake, legacy from the discriminator.
    let idx;
    try {
        idx = user.discriminator && user.discriminator !== '0'
            ? Number(user.discriminator) % 5
            : Number((BigInt(user.id) >> 22n) % 6n);
    } catch { idx = 0; }
    return `https://${cdnHost}/embed/avatars/${idx}.png`;
}

/** Deterministic accent colour per user — used for nametags and pad highlights. */
export function userColor(user) {
    let h = 0;
    const key = String(user?.id || user?.username || user?.name || 'x');
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    const palette = ['#5865f2', '#eb459e', '#f0b232', '#23a559', '#f23f43', '#3ba55c', '#8b5cf6', '#00a8fc'];
    return palette[h % palette.length];
}

// ── init ───────────────────────────────────────────────────────────────
export async function initDiscord({ allowMock = true } = {}) {
    dc.active = detectActivity();
    if (dc.active) document.documentElement.classList.add('in-discord');
    if (!dc.active && !allowMock) return dc;

    const q = new URLSearchParams(location.search);
    dc.instanceId = q.get('instance_id') || null;
    dc.platform = q.get('platform') || 'desktop';

    if (!dc.active) {
        // Plain browser tab: invent a stable-ish identity so the app is usable
        // (and testable) outside Discord. Never used for network trust.
        dc.instanceId = q.get('room') || localRoom();
        dc.me = localMe();
        console.info('[discord] not inside Discord — running in standalone mode');
        applyLayoutMode(null);
        return dc;
    }

    let sdk = null;
    if (mockRequested()) {
        sdk = mockSDK(location.search);
        window.__mock = sdk;                 // demo controls: addParticipant/speaking/layout
        console.info('[discord] mock SDK via ?mock=1 — identity and roster are faked, no Discord traffic');
    } else {
        const clientId = detectClientId();
        if (!clientId) {
            dc.error = 'no_client_id';
            console.warn('[discord] inside Discord but no client id on the URL — cannot handshake');
            return dc;
        }
        dc.clientId = clientId;
        try {
            const mod = await import(SDK_URL);
            const DiscordSDK = mod.DiscordSDK || mod.default?.DiscordSDK || mod.default;
            sdk = new DiscordSDK(clientId);
        } catch (err) {
            dc.error = 'sdk_load_failed';
            console.warn('[discord] could not construct DiscordSDK', err);
            return dc;
        }
    }
    dc.sdk = sdk;
    dc.instanceId = sdk.instanceId || dc.instanceId;
    dc.guildId = sdk.guildId || null;
    dc.channelId = sdk.channelId || null;
    dc.platform = sdk.platform || dc.platform;

    // ready() must resolve before other commands; never let a missing RPC bridge
    // wedge the whole app, so race it with a timeout.
    const ready = await Promise.race([
        sdk.ready().then((p) => p).catch((e) => { dc.error = String(e?.message || e); return null; }),
        new Promise((r) => setTimeout(() => r(null), 8000)),
    ]);
    if (!ready) {
        console.warn('[discord] no READY payload — continuing without RPC (multiplayer still works)');
        return dc;
    }

    // ── identity, for free: READY carries the current user ────────────
    const data = ready?.data || {};
    if (data.config?.cdn_host) dc.cdnHost = data.config.cdn_host;
    if (data.user) {
        dc.me = data.user;
        emit('user', dc.me);
    }
    console.info('[discord] ready', { clientId: dc.clientId, instanceId: dc.instanceId, guild: dc.guildId, channel: dc.channelId, you: dc.me?.username });

    // ── roster of everyone connected to THIS instance ─────────────────
    await refreshRoster(sdk);
    safe(() => sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', (p) => {
        applyRoster(Array.isArray(p?.participants) ? p.participants : null, /*pushed*/ true);
        emit('roster', dc.roster);
    }));

    // Display-name changes (and post-auth user updates) land here.
    safe(() => sdk.subscribe('CURRENT_USER_UPDATE', (u) => {
        if (u?.id) { dc.me = { ...dc.me, ...u }; emit('user', dc.me); }
    }));

    // ── layout: FOCUSED / PIP / GRID ─────────────────────────────────
    safe(() => sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', (p) => applyLayoutMode(p?.layout_mode)));
    applyViewportClass();
    addEventListener('resize', applyViewportClass, { passive: true });

    // Mobile: we drive a gamepad-ish UI, so let the page rotate but keep PIP free.
    if (dc.platform === 'mobile') {
        safe(() => sdk.commands.setOrientationLockState({
            lock_state: 1,                       // UNLOCKED
            picture_in_picture_lock_state: 1,
            grid_lock_state: 1,
        }));
    }
    safe(() => sdk.commands.setConfig({ use_interactive_pip: true }).catch(() => {}));

    // The mock client already "has" the voice scope, so the lobby's mic
    // indicators can be exercised without a token exchange.
    if (sdk.__mock) subscribeVoice(sdk);

    // Optional auth upgrade.
    await maybeAuthenticate(sdk).catch(() => {});

    // Forward our console into Discord's devtools for players who report bugs.
    safe(() => {
        addEventListener('error', (e) => sdk.commands.captureLog({
            level: 'error', message: `[sm64mp] ${e.message} @ ${e.filename}:${e.lineno}`,
        }).catch(() => {}));
    });

    return dc;
}

function safe(fn) { try { fn(); } catch (e) { console.debug('[discord] optional call failed', e?.message || e); } }

export async function refreshRoster(sdk = dc.sdk) {
    if (!sdk) return dc.roster;
    const res = await safeCmd(() => sdk.commands.getInstanceConnectedParticipants());
    applyRoster(Array.isArray(res?.participants) ? res.participants : null, false);
    return dc.roster;
}

const safeCmd = (fn) => { try { const r = fn(); return r?.catch ? r.catch((e) => { console.debug('[discord] cmd failed', e?.message || e); return null; }) : r; } catch { return Promise.resolve(null); } };

function applyRoster(list, pushed) {
    if (!Array.isArray(list)) {
        // The push event can carry an empty list before our fetch resolves; keep
        // what we have rather than flashing an empty lobby.
        if (pushed) return;
        dc.roster = [];
        emit('roster', dc.roster);
        return;
    }
    dc.roster = list;
    // The roster is also the source of truth for OUR name if READY didn't have it.
    if (!dc.me && dc.myUserId) {
        const self = list.find((u) => String(u.id) === String(dc.myUserId));
        if (self) { dc.me = self; emit('user', self); }
    }
    emit('roster', dc.roster);
}

let voiceBound = false;
/**
 * `SPEAKING_START/STOP` are per-voice-channel and only delivered once the
 * `rpc.voice.read` scope is granted, so this is called either after a successful
 * authenticate() or by the mock client. Idempotent by design: re-subscribing
 * would double every toggle.
 */
function subscribeVoice(sdk) {
    if (voiceBound || !sdk || !dc.channelId) return;
    voiceBound = true;
    safe(() => sdk.subscribe('SPEAKING_START', (p) => { dc.speakers.add(String(p.user_id)); emit('speaking', dc.speakers); }, { channel_id: dc.channelId }));
    safe(() => sdk.subscribe('SPEAKING_STOP', (p) => { dc.speakers.delete(String(p.user_id)); emit('speaking', dc.speakers); }, { channel_id: dc.channelId }));
}

// ── optional OAuth upgrade (needs a token-exchange endpoint) ───────────
async function maybeAuthenticate(sdk) {
    if (!TOKEN_ENDPOINT) return;
    try {
        const res = await safeCmd(() => sdk.commands.authorize({
            client_id: dc.clientId,
            response_type: 'code',
            state: '',
            prompt: 'none',
            scope: SCOPES,
        }));
        if (!res?.code) return;
        const r = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: res.code, redirect_uri: location.origin }),
        });
        const { access_token: token } = await r.json();
        if (!token) return;
        const auth = await sdk.commands.authenticate({ access_token: token });
        if (auth?.user) { dc.me = { ...dc.me, ...auth.user }; emit('user', dc.me); }
        dc.authed = true;
        dc.scopes = auth?.scopes || [];
        // "Who is talking" needs the voice scope, i.e. a token.
        if (dc.scopes.includes('rpc.voice.read')) subscribeVoice(sdk);
    } catch (err) {
        console.debug('[discord] auth skipped', err?.message || err);
    }
}

/**
 * Set how this Activity shows up in Discord members' profiles.
 * Requires a token with rpc.activities.write, so it no-ops without auth — the
 * "Playing SM64 Multiplayer" line is a bonus, not a dependency.
 */
export async function setPresence({ details, state, partySize, partyMax } = {}) {
    if (!dc.sdk) return;
    await safeCmd(() => dc.sdk.commands.setActivity({
        type: 0,                                  // Playing
        details: details?.slice(0, 128),
        state: state?.slice(0, 128),
        party: partySize != null ? { id: dc.instanceId || 'sm64', size: [partySize, partyMax ?? 8] } : undefined,
        timestamps: { start: appStartTs },
    }));
}
let appStartTs = Math.floor(Date.now() / 1000);

/** Native Discord invite modal — the "get your friends in here" button. */
export async function openInvite() {
    if (!dc.sdk) {
        // Outside Discord, copy the link with the room code instead.
        const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(dc.instanceId || '')}`;
        try { await navigator.clipboard?.writeText(url); return 'copied'; } catch { return url; }
    }
    // Prefer the activity-specific invite (v2.x), fall back to the channel dialog.
    const invited = await safeCmd(() => dc.sdk.commands.openInviteDialog());
    if (!invited || invited?.error) await safeCmd(() => dc.sdk.commands.openInviteDialog({ type: 0 }));
    return 'opened';
}

/** Share a deep link to this instance into a channel/DM of the user's choice. */
export async function shareLink(message = 'Join my SM64 session') {
    if (!dc.sdk) return false;
    const res = await safeCmd(() => dc.sdk.commands.shareLink({ message, custom_id: `room:${dc.instanceId || ''}`.slice(0, 64) }));
    return !!(res?.success || res?.didCopyLink);
}

export async function openExternal(url) {
    if (dc.sdk) {
        const r = await safeCmd(() => dc.sdk.commands.openExternalLink({ url }));
        if (r) return;
    }
    window.open(url, '_blank', 'noopener');
}

// ── layout / density ───────────────────────────────────────────────────
function applyLayoutMode(mode) {
    dc.layoutMode = typeof mode === 'number' ? mode : LAYOUT.UNHANDLED;
    const el = document.documentElement;
    el.classList.remove('layout-focused', 'layout-pip', 'layout-grid');
    if (dc.layoutMode === LAYOUT.PIP) el.classList.add('layout-pip');
    else if (dc.layoutMode === LAYOUT.GRID) el.classList.add('layout-grid');
    else if (dc.layoutMode === LAYOUT.FOCUSED) el.classList.add('layout-focused');
    applyViewportClass();
}

export const isSmall = () => dc.layoutMode === LAYOUT.PIP || dc.layoutMode === LAYOUT.GRID
    || (innerWidth > 0 && (innerWidth < 620 || innerHeight < 470));

function applyViewportClass() {
    const html = document.documentElement;
    html.classList.toggle('compact', isSmall());
    html.classList.toggle('tall', innerHeight > innerWidth);
    // Coarse pointer ⇒ render the touch pad. It drives the very same input mask,
    // so mobile players are first-class rather than "unsupported".
    try { html.classList.toggle('coarse', matchMedia('(pointer: coarse)').matches); } catch {}
}

// ── keyboard focus, the Discord iframe special case ────────────────────
// Discord's activity iframe does not start with keyboard focus, and the client
// only routes keystrokes into the frame while it owns focus. If we don't
// reclaim it, players press keys and Mario sits still. Reclaim only right after
// the user was actually interacting with us, so we never steal the caret out of
// Discord's own chat box.
export function installFocusGuard(getPreferredField) {
    if (!dc.active) return () => {};
    let lastInFrame = 0;
    const mark = () => { lastInFrame = Date.now(); };
    document.addEventListener('pointerdown', mark, true);
    document.addEventListener('keydown', mark, true);

    const grab = () => {
        const el = getPreferredField?.();
        if (el && el.offsetParent !== null) { try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch {} } }
        else { try { document.getElementById('stage')?.focus?.(); } catch {} }
    };
    const onBlur = () => { if (Date.now() - lastInFrame < 2000) grab(); };
    addEventListener('blur', onBlur, true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) grab(); });
    setTimeout(grab, 300);
    return () => { removeEventListener('blur', onBlur, true); document.removeEventListener('pointerdown', mark, true); };
}

// ── standalone (no Discord) identity + room ────────────────────────────
function localRoom() {
    try {
        let r = sessionStorage.getItem('sm64mp_room');
        if (!r) { r = 'local-' + Math.random().toString(36).slice(2, 6); sessionStorage.setItem('sm64mp_room', r); }
        return r;
    } catch { return 'local-' + Math.random().toString(36).slice(2, 6); }
}

function localMe() {
    let name = null, id = null;
    try {
        name = localStorage.getItem('sm64mp_nick');
        id = localStorage.getItem('sm64mp_uid');
    } catch {}
    if (!id) {
        id = 'anon' + Math.random().toString(36).slice(2, 8);
        try { localStorage.setItem('sm64mp_uid', id); } catch {}
    }
    return { id, username: name || 'Guest' + id.slice(-3), global_name: name || null, discriminator: '0', avatar: null };
}

/** Nickname override for standalone testing only. Inside Discord it is ignored. */
export function setLocalNick(name) {
    const clean = sanitizeName(name, 'Guest');
    dc.me = { ...dc.me, username: clean, global_name: clean };
    try { localStorage.setItem('sm64mp_nick', clean); } catch {}
    emit('user', dc.me);
    return clean;
}
