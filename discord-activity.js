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
        console.log('[Discord] Activity ready', {
            instanceId: info.instanceId,
            platform: info.platform,
        });
    } catch (err) {
        console.warn('[Discord] SDK init failed — continuing without RPC', err);
    }

    return info;
}
