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
        openExternal: async (url) => { window.open(url, '_blank', 'noopener'); },
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
        await sdk.ready();
        info.sdk = sdk;
        info.instanceId = sdk.instanceId || info.instanceId;
        info.guildId = sdk.guildId || null;
        info.channelId = sdk.channelId || null;
        info.platform = sdk.platform || info.platform;
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
        try {
            sdk.subscribe('CURRENT_USER_UPDATE', (u) => {
                info.user = u;
                const name = u?.global_name || u?.username;
                if (name) window.__sm64mp?.setName?.(name);
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
