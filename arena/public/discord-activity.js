// ─────────────────────────────────────────────────────────────────────────────
// Discord Embedded App bootstrap for Mario Arena.
//
// Adapted from the repo's original discord-activity.js, with one deliberate
// deletion: this build does NOT key a room off `instance_id`.
//
// The old game gave every voice channel its own lobby. This one is the opposite
// by design — there is a single global Mario, and every Activity instance in
// every guild is a window onto the same session. instanceId/guildId are still
// read, but only as labels; they never route anything.
//
// Safe no-op when the page is opened in a normal browser.
// ─────────────────────────────────────────────────────────────────────────────

export function isDiscordActivity() {
    try {
        const q = new URLSearchParams(location.search);
        if (q.has('frame_id') || q.has('instance_id')) return true;
        if (/\.discordsays\.com$/i.test(location.hostname)) return true;
        if (q.get('discord') === '1') return true;
    } catch {}
    return false;
}

export function discordClientId() {
    const m = location.hostname.match(/^(\d+)\.discordsays\.com$/i);
    if (m) return m[1];
    try { return localStorage.getItem('arena_discord_client_id') || ''; } catch { return ''; }
}

// layout_mode enum: UNHANDLED -1, FOCUSED 0, PIP 1, GRID 2. Popped out to a PIP
// tile the viewport gets tiny, so tag <html> and let client.css shrink the chrome.
function applyLayoutMode(mode) {
    const html = document.documentElement;
    html.classList.remove('discord-layout-focused', 'discord-layout-pip', 'discord-layout-grid');
    if (mode === 0) html.classList.add('discord-layout-focused');
    else if (mode === 1) html.classList.add('discord-layout-pip');
    else if (mode === 2) html.classList.add('discord-layout-grid');
}

export async function initDiscordActivity() {
    const active = isDiscordActivity();
    if (active) {
        document.documentElement.classList.add('discord-activity');
        document.body?.classList.add('discord-activity');
    }

    const info = {
        active,
        sdk: null,
        clientId: discordClientId(),
        instanceId: null,     // label only — never a room key
        guildId: null,
        channelId: null,
        platform: null,
        user: null,
        userId: null,
        avatar: null,          // Discord avatar hash
        detectedName: null,
        authenticated: false,
        participants: [],
        refreshParticipants: async () => [],
    };

    if (!active) return info;

    const q = new URLSearchParams(location.search);
    info.instanceId = q.get('instance_id') || null;
    info.platform = q.get('platform') || null;

    // Discord hands the iframe to the user without keyboard focus, and the
    // client only routes keystrokes in while the frame owns it. The arena IS a
    // controller, so a frame that never takes focus is a game nobody can play.
    // Claim it on load and after any in-frame interaction — but never steal it
    // back while the user is typing in Discord's own chat.
    let lastInFrame = 0;
    document.addEventListener('pointerdown', () => { lastInFrame = Date.now(); }, true);
    document.addEventListener('keydown', () => { lastInFrame = Date.now(); }, true);
    const grabFocus = () => {
        const el = document.getElementById('stage') || document.body;
        try { el.focus({ preventScroll: true }); } catch {}
    };
    try {
        grabFocus();
        window.addEventListener('blur', () => {
            if (Date.now() - lastInFrame < 2000) grabFocus();
        }, true);
    } catch {}

    const clientId = info.clientId;
    if (!clientId) {
        console.warn('[Discord] inside Discord but no client id on hostname');
        return info;
    }

    try {
        const mod = await import('./lib/discord-embedded-sdk.js');
        const DiscordSDK = mod.DiscordSDK || mod.default?.DiscordSDK || mod.default;
        if (!DiscordSDK) throw new Error('DiscordSDK export missing');
        const sdk = new DiscordSDK(clientId);

        info.instanceId = sdk.instanceId || info.instanceId;
        info.guildId = sdk.guildId || null;
        info.channelId = sdk.channelId || null;
        info.platform = sdk.platform || info.platform;

        // Never let a missing RPC bridge block the game. If the handshake is
        // slow or absent, we still connect to the arena — you just show up
        // without a Discord nametag.
        const ready = await Promise.race([
            sdk.ready().then(() => true),
            new Promise((r) => setTimeout(() => r(false), 6000)),
        ]);
        if (!ready) {
            console.warn('[Discord] SDK handshake timed out — playing anonymously');
            info.sdk = sdk;
            return info;
        }
        info.sdk = sdk;

        try { await sdk.commands.setConfig({ use_interactive_pip: false }); } catch {}

        // ── OAuth: get the player's REAL Discord name and avatar ─────────
        //
        // The Activity SDK's own CURRENT_USER_UPDATE event is not guaranteed to
        // fire, and gives us nothing to prove identity with. The supported flow
        // is authorize -> exchange the code server-side for a token -> hand the
        // token back to the client via authenticate(). Only the server ever
        // holds the client secret.
        //
        // `prompt: 'none'` means no consent screen for anyone who has already
        // authorized the app, so for almost everyone this is invisible.
        try {
            const { code } = await sdk.commands.authorize({
                client_id: clientId,
                response_type: 'code',
                state: '',
                prompt: 'none',
                scope: ['identify'],
            });
            if (code) {
                const res = await fetch('/api/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code }),
                });
                const payload = await res.json();
                if (payload && payload.access_token) {
                    const auth = await sdk.commands.authenticate({ access_token: payload.access_token });
                    const u = auth && auth.user;
                    if (u) {
                        info.user = u;
                        info.userId = u.id || null;
                        info.avatar = u.avatar || null;
                        info.detectedName = u.global_name || u.username || null;
                        info.authenticated = true;
                    }
                } else {
                    console.warn('[Discord] token exchange returned no access_token', payload && payload.error);
                }
            }
        } catch (err) {
            // Not fatal. Without OAuth you still see and play the game, you just
            // show up without a Discord name and picture.
            console.warn('[Discord] OAuth failed — continuing unauthenticated', err);
        }

        info.refreshParticipants = async () => {
            try {
                const res = await sdk.commands.getInstanceConnectedParticipants();
                info.participants = Array.isArray(res?.participants) ? res.participants : [];
                return info.participants;
            } catch { return info.participants; }
        };

        try {
            sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', (p) => {
                applyLayoutMode(typeof p?.layout_mode === 'number' ? p.layout_mode : null);
            });
        } catch {}

        try {
            sdk.subscribe('CURRENT_USER_UPDATE', (u) => {
                info.user = u;
                info.userId = u?.id || null;
                const name = u?.global_name || u?.username;
                if (name && !info.authenticated) {
                    info.detectedName = name;
                    info.avatar = u?.avatar || info.avatar;
                    info.userId = u?.id || info.userId;
                    window.__arenaSetName?.(name);
                }
            });
        } catch {}

        console.log('[Discord] arena ready', { guildId: info.guildId, platform: info.platform });
    } catch (err) {
        console.warn('[Discord] SDK init failed — playing anonymously', err);
    }

    return info;
}
