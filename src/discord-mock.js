// A stand-in for the Discord client, so the Activity's identity/roster/presence
// path can be developed and demoed in a plain browser tab.
//
// It implements exactly the surface src/discord.js touches, with payloads shaped
// like the real ones (schemas taken from the zod definitions inside the vendored
// SDK — see docs/SDK-NOTES.md). Open the site with `?mock=1` and you get Discord
// names + avatars, a couple of participants who are deliberately NOT in the relay
// room (which is what "in the Activity but not in this game" looks like), plus
// scripted roster/speaking/layout events. `window.__mock` is the object itself.
//
// Everything here is fake by definition — it must never be reachable without the
// `?mock` flag, and it never sends anything to Discord.

const USER_KEYS = ['id', 'username', 'discriminator', 'global_name', 'avatar', 'avatar_decoration_data', 'bot', 'flags', 'premium_type'];

/** A Discord `User` object, as delivered by READY / participants / CURRENT_USER_UPDATE. */
function user({ id, username, globalName = null, avatar = null, discriminator = '0', bot = false }) {
    return {
        id, username, discriminator, global_name: globalName, avatar,
        avatar_decoration_data: null, bot, flags: 0, premium_type: 0,
    };
}

const CAST = [
    user({ id: '292286049784184849', username: 'mario_kart_tour', globalName: 'Mario', avatar: 'cff886bef71bf3f25ce8f59228105ee3' }),
    user({ id: '868906312801234944', username: 'toadsworthette', globalName: 'Toadsworthette', avatar: '0e2962832d56bfe3838a274a84fbdf10' }),
    user({ id: '1042507688320962620', username: 'coolpope64', discriminator: '0001' }),
];

export function mockSDK(search = '') {
    const q = new URLSearchParams(search || (typeof location !== 'undefined' ? location.search : ''));
    const me = CAST[0];
    // A fixed instance id, so `?mock=1` in two tabs joins the same room.
    const instanceId = q.get('instance') || '123456789012345678';
    const listeners = new Map();
    const log = (...a) => console.info('%c[mock sdk]', 'color:#5865f2', ...a);

    const sdk = {
        clientId: '000000000000000001',
        instanceId,
        guildId: '110000000000000001',
        channelId: '110000000000000002',
        platform: 'desktop',
        sdkVersion: 'mock',
        __mock: true,
        _extra: [],           // pretend participants added at runtime
        close() {},

        ready() {
            return Promise.resolve({
                evt: 'READY',
                data: {
                    v: '1.1',
                    config: { cdn_host: 'cdn.discordapp.com', api_endpoint: 'https://discord.com/api', environment: 'development' },
                    user: me,
                },
            });
        },
        async subscribe(evt, cb) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt).add(cb);
            return { evt, unsubscribe: () => listeners.get(evt)?.delete(cb) };
        },
        async unsubscribe(evt, cb) { listeners.get(evt)?.delete(cb); },
        emitEvent(evt, data) {
            log('emit', evt, data);
            for (const cb of listeners.get(evt) || []) cb(data);
        },
        commands: {
            async getInstanceConnectedParticipants() {
                return { participants: [me, ...CAST.slice(1), ...sdk._extra] };
            },
            async getPlatformBehaviors() { return { iosKeyboardResizesView: true }; },
            async setConfig(o) { log('setConfig', o); return {}; },
            async setActivity(o) { log('setActivity', o); return {}; },
            async openInviteDialog() { log('openInviteDialog'); return {}; },
            async inviteUserEmbedded(o) { log('inviteUserEmbedded', o); return {}; },
            async shareLink(o) { log('shareLink', o); return { client_id: sdk.clientId }; },
            async authorize() { return { code: 'mock_code' }; },
            async authenticate() { throw new Error('mock sdk has no token'); },
            async patchUrlMappings(m) { return m; },
        },

        // ---- demo controls, handy from the console -------------------------
        /** Fake someone joining the Activity (they still need the relay to play). */
        addParticipant(u) {
            const p = u || user({ id: String(1e17 + Math.floor(Math.random() * 1e17)), username: `player_${Math.floor(Math.random() * 900 + 100)}` });
            sdk._extra.push(p);
            sdk.emitEvent('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', { participants: [me, ...CAST.slice(1), ...sdk._extra] });
            return p;
        },
        speaking(userIds, on = true) {
            for (const id of [].concat(userIds)) {
                sdk.emitEvent(on ? 'SPEAKING_START' : 'SPEAKING_STOP', { user_id: id });
            }
        },
        layout(mode = 0) {
            const layout_mode = { FOCUSED: 0, PIP: 1, GRID: 2 }[mode] ?? mode;
            sdk.emitEvent('ACTIVITY_LAYOUT_MODE_UPDATE', { layout_mode });
        },
    };
    // The keys the SDK validates users by — asserted so the shapes above can't
    // silently drift from what src/discord.js expects.
    console.assert(USER_KEYS.every((k) => k in me), 'mock user shape');
    return sdk;
}

/** Scripted events, so a static demo of the lobby feels alive. */
export function mockScenario(sdk, { delay = 4000 } = {}) {
    if (!sdk?.__mock) return () => {};
    const timers = [];
    timers.push(setTimeout(() => {
        const late = sdk.addParticipant();
        sdk.speaking([late.id], true);
    }, delay));
    timers.push(setTimeout(() => sdk.speaking([CAST[1].id], true), delay + 3200));
    timers.push(setTimeout(() => sdk.speaking([CAST[1].id], false), delay + 6000));
    return () => timers.forEach(clearTimeout);
}
