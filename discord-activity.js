// Discord Embedded App bootstrap. Safe no-op when opened in a normal browser.
// Client ID is inferred from https://<APP_ID>.discordsays.com when hosted as an Activity.

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
    try { return localStorage.getItem('sm64_discord_client_id') || ''; } catch { return ''; }
}

// Discord's ACTIVITY_LAYOUT_MODE_UPDATE event gives us a layout_mode enum:
//   UNHANDLED:-1, FOCUSED:0, PIP:1, GRID:2
// When the activity is popped out to a tiny Picture-In-Picture tile, or tiled
// into a GRID with other activities, the viewport shrinks a LOT. The game
// canvas already fills 100vw/vh, so we only need to shrink the CHROME (HUD +
// overlays). We tag <html> with a class per layout so styles.css can scale.
function applyLayoutMode(mode) {
    const html = document.documentElement;
    html.classList.remove('discord-layout-focused', 'discord-layout-pip', 'discord-layout-grid');
    if (mode === 0) html.classList.add('discord-layout-focused');
    else if (mode === 1) html.classList.add('discord-layout-pip');
    else if (mode === 2) html.classList.add('discord-layout-grid');
    // Even if Discord never sends the event, keep a viewport-sized fallback so
    // the UI never overflows a small panel. Small viewports => compact chrome.
    applyViewportCompaction();
}

// Fallback driven by the real iframe size (Discord sends resize to the iframe).
function applyViewportCompaction() {
    const html = document.documentElement;
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    const compact = w > 0 && h > 0 && (w < 560 || h < 460);
    html.classList.toggle('discord-compact', compact);
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
        instanceId: null,
        platform: null,
        guildId: null,
        channelId: null,
        user: null,
        userId: null,
        // Discord display name detected from the CURRENT_USER_UPDATE event.
        // Buffered here so multiplayer picks it up even if it fired before
        // initMultiplayer() mounted.
        detectedName: null,
        // Roster of every Discord user connected to this activity instance.
        // Populated lazily via getInstanceConnectedParticipants() and kept fresh
        // by the ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE event. Used in the lobby.
        participants: [],
        openExternal: async (url) => { window.open(url, '_blank', 'noopener'); },
        // Re-fetch the connected-participants roster (SDK command).
        refreshParticipants: async () => [],
        // Apply layout mode manually (used by resize fallback + tests).
        setLayoutMode: applyLayoutMode,
    };

    if (!active) return info;

    // Discord's activity iframe starts out without keyboard focus, and the
    // client only routes keystrokes into the frame while it owns focus. The
    // app's own `canvas.focus()` call runs before the game canvas exists, so
    // focus lands nowhere and typing in inputs does nothing. Grab focus on a
    // REAL, visible element (focus() on a hidden element is a no-op) at boot,
    // and whenever Discord's client steals focus WHILE the user is interacting
    // with the activity. We never steal focus while the user is doing
    // something else (e.g. typing in Discord's own chat box).
    let _lastInFrame = 0;
    let _lastField = null;
    document.addEventListener('pointerdown', () => { _lastInFrame = Date.now(); }, true);
    document.addEventListener('keydown',    () => { _lastInFrame = Date.now(); }, true);
    // Remember the last field the user was typing in, so a focus reclaim
    // lands back in THAT field instead of a hardcoded one.
    document.addEventListener('focusin', (e) => {
        const el = e.target;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
            _lastField = el;
            _lastInFrame = Date.now();
        }
    }, true);
    function authGateOpen() {
        const overlay = document.getElementById('auth-overlay');
        return !!(overlay && !overlay.classList.contains('hidden'));
    }
    function grabFrameFocus(force) {
        if (authGateOpen()) {
            const authKey = document.getElementById('auth-apikey');
            if (authKey && authKey.offsetParent !== null) {
                try { authKey.focus({ preventScroll: true }); } catch { try { authKey.focus(); } catch {} }
                return;
            }
        }
        if (!force) return;   // at boot: leave focus on the game canvas
        const target = (_lastField && _lastField.isConnected) ? _lastField
            : (document.getElementById('ai-instruction') || document.body);
        try { target.focus({ preventScroll: true }); } catch { try { target.focus(); } catch {} }
    }
    try {
        grabFrameFocus(false);
        window.addEventListener('blur', () => {
            // Only reclaim focus right after the user was using THIS app
            // (click or key inside the frame in the last ~2s) — never when
            // they've switched away to Discord's UI for longer.
            if (Date.now() - _lastInFrame < 2000) grabFrameFocus(true);
        }, true);
    } catch {}

    window.addEventListener('resize', () => applyViewportCompaction(), { passive: true });
    applyLayoutMode(null);   // seed the viewport fallback now

    const q = new URLSearchParams(location.search);
    info.instanceId = q.get('instance_id') || null;
    info.platform = q.get('platform') || null;

    const clientId = info.clientId;
    if (!clientId) {
        console.warn('[Discord] running inside Discord but no client id on hostname');
        return info;
    }

    try {
        const mod = await import('./lib/discord-embedded-sdk.js');
        const DiscordSDK = mod.DiscordSDK || mod.default?.DiscordSDK || mod.default;
        if (!DiscordSDK) throw new Error('DiscordSDK export missing');
        const sdk = new DiscordSDK(clientId);

        // instanceId / channelId / guildId are all available BEFORE ready().
        info.instanceId = sdk.instanceId || info.instanceId;
        info.guildId = sdk.guildId || null;
        info.channelId = sdk.channelId || null;
        info.platform = sdk.platform || info.platform;

        // Wait for the handshake, but never let a missing/down RPC server block
        // the whole app. If Discord's RPC bridge is absent (e.g. opened in a
        // normal browser with fake params), fall through after a timeout and
        // leave the SDK as best-effort, so multiplayer still initialises.
        const ready = await Promise.race([
            sdk.ready().then(() => true),
            new Promise((resolve) => setTimeout(() => resolve(false), 6000)),
        ]);
        if (!ready) {
            console.warn('[Discord] SDK handshake timed out — continuing without RPC');
            info.sdk = sdk;
            return info;
        }
        info.sdk = sdk;

        info.openExternal = async (url) => {
            try {
                await sdk.commands.openExternalLink({ url });
            } catch {
                window.open(url, '_blank', 'noopener');
            }
        };
        try {
            await sdk.commands.setConfig({ use_interactive_pip: false });
        } catch {}

        // ── Participant roster (the SDK's multiplayer primitive) ──────────
        info.refreshParticipants = async () => {
            try {
                const res = await sdk.commands.getInstanceConnectedParticipants();
                const list = Array.isArray(res?.participants) ? res.participants : [];
                info.participants = list;
                return list;
            } catch (err) {
                console.warn('[Discord] getInstanceConnectedParticipants failed', err);
                return info.participants || [];
            }
        };
        try {
            sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', (payload) => {
                const list = Array.isArray(payload?.participants) ? payload.participants : null;
                if (list) {
                    info.participants = list;
                    window.__sm64mp?.onParticipants?.(list);
                }
            });
        } catch {}

        // ── Layout mode → UI scaling class ───────────────────────────────
        try {
            sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', (payload) => {
                applyLayoutMode(typeof payload?.layout_mode === 'number' ? payload.layout_mode : null);
            });
        } catch {}
        // A fresh activity may be in PIP/GRID before we subscribe; fetch the
        // current window size as a best-effort proxy for the first paint.
        applyViewportCompaction();

        // ── Current user ─────────────────────────────────────────────────
        try {
            sdk.subscribe('CURRENT_USER_UPDATE', (u) => {
                info.user = u;
                info.userId = u?.id || null;
                const name = u?.global_name || u?.username;
                if (name) {
                    info.detectedName = name;
                    window.__sm64mp?.setName?.(name);
                }
            });
        } catch {}

        console.log('[Discord] Activity ready', {
            instanceId: info.instanceId,
            platform: info.platform,
        });
    } catch (err) {
        console.warn('[Discord] SDK init failed — continuing without RPC', err);
    }

    return info;
}
