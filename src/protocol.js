// ============================================================
// Wire protocol shared by the Activity client and the relay server.
//
// WHY A RELAY AT ALL
// -----------------
// Discord Activities give you identity, a room (the activity *instance*), a
// participant roster, invites and presence. They deliberately do NOT give you
// a game-state transport. And the Activity sandbox routes every request
// through Discord's Cloudflare-Worker proxy, where:
//
//   HTTP/HTTPS  ✅   WebSocket ✅   WebTransport ⏳   WebRTC ❌
//
// (https://docs.discord.com/developers/activities/development-guides/networking)
// So the usual "PeerJS/WebRTC because it's free" trick is *not an option*
// inside Discord. Plain WebSockets are. Hence: a tiny relay you self-host,
// reached through a URL mapping like every other network call an Activity makes.
//
// MESSAGE ENVELOPE
// ----------------
// Every text frame is one JSON object with a `t` (type) field.
// Binary frames are video: [magic u32][index u32][hostTs u32][jpeg bytes]
// ============================================================

export const PROTOCOL_VERSION = 1;

// ── Controller bits ────────────────────────────────────────────────────
// One 16-bit mask = a whole controller state. Compact, order-free, and it
// merges with bitwise ops, which is all arbitration needs.
export const BTN = {
    UP:    1 << 0,
    DOWN:  1 << 1,
    LEFT:  1 << 2,
    RIGHT: 1 << 3,
    A:     1 << 4,   // jump
    B:     1 << 5,   // punch / dive / grab
    Z:     1 << 6,   // crouch / long jump / ground pound
    START: 1 << 7,   // pause + menus
};

export const STICK_BITS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;

// Control groups for CO-OP mode: each group is one player's slice of the pad.
export const GROUPS = [
    { id: 'stick', label: 'Stick',  icon: '🕹️', bits: STICK_BITS,           hint: 'walk, climb, swim' },
    { id: 'jump',  label: 'A',      icon: '🅰️', bits: BTN.A,               hint: 'jump / kick / side-flip' },
    { id: 'tech',  label: 'B + Z',  icon: '🅱️', bits: BTN.B | BTN.Z,       hint: 'dive, grab, long jump, pound' },
    { id: 'menu',  label: 'Start',  icon: '⏸️', bits: BTN.START,           hint: 'pause, menus, enter doors' },
];

// Keys the wasm actually listens for. VERIFIED against this engine build:
//   Arrows = analog stick · KeyX = A · KeyC = B · Space = Z · Enter = Start.
// There is no keyboard camera in this build — Mario turns, the camera follows.
export const KEY_FOR_BIT = {
    [BTN.UP]:    'ArrowUp',
    [BTN.DOWN]:  'ArrowDown',
    [BTN.LEFT]:  'ArrowLeft',
    [BTN.RIGHT]: 'ArrowRight',
    [BTN.A]:     'KeyX',
    [BTN.B]:     'KeyC',
    [BTN.Z]:     'Space',
    [BTN.START]: 'Enter',
};

// Physical keys we *capture* from the local player, mapped onto bits. Aliases
// let people use WASD or the sm64js defaults interchangeably.
export const CODE_TO_BITS = {
    ArrowUp: BTN.UP,   KeyW: BTN.UP,
    ArrowDown: BTN.DOWN, KeyS: BTN.DOWN,
    ArrowLeft: BTN.LEFT, KeyA: BTN.LEFT,
    ArrowRight: BTN.RIGHT, KeyD: BTN.RIGHT,
    KeyX: BTN.A, KeyJ: BTN.A,
    KeyC: BTN.B, KeyK: BTN.B,
    Space: BTN.Z, KeyV: BTN.Z, ShiftLeft: BTN.Z,
    Enter: BTN.START, KeyM: BTN.START,
};

// ── Game modes (all are input-arbitration variants on ONE shared session) ──
export const MODES = [
    {
        id: 'coop', label: 'Co-op Pad', icon: '🤝',
        desc: 'The controller is chopped up: one person walks, one jumps, one does the tech, one holds the menu. You cannot win alone.',
        opts: { rotate: 30 },   // seconds per rotation; 0 = never
    },
    {
        id: 'democracy', label: 'Democracy', icon: '🗳️',
        desc: 'Every input is voted on for a short window. Majority rules, split votes do nothing.',
        opts: { window: 400 },
    },
    {
        id: 'anarchy', label: 'Anarchy', icon: '🌀',
        desc: 'Each window, one random player owns the whole pad. Chaos, and occasionally genius.',
        opts: { window: 350 },
    },
    {
        id: 'potato', label: 'Hot Potato', icon: '🥔',
        desc: 'One pad holder. Everyone else heckles: press A together to storm the pad.',
        opts: { hold: 25, storm: 0.5 },  // seconds per turn · share of the heckling crowd that must be mashing
    },
    {
        id: 'mash', label: 'Mash (union)', icon: '🎊',
        desc: 'All inputs are simply OR-ed together. Responsive, loud, and Mario goes where the crowd pushes.',
        opts: {},
    },
    {
        id: 'solo', label: 'Solo (host)', icon: '👑',
        desc: 'Only the host plays. Everyone else watches the host\'s screen and chats.',
        opts: {},
    },
];

export const modeById = (id) => MODES.find((m) => m.id === id) || MODES[0];

// ── Message types ──────────────────────────────────────────────────────
export const MSG = {
    // client → relay
    HELLO:  'hello',   // {t,ver,room,id,name,av,plat,ready,watch,sid?}
    LEAVE:  'leave',   // {t}
    IN:     'in',      // {t,s,f}            local controller state
    READY:  'ready',   // {t,ready:bool}     engine loaded (used for host election)
    STATE:  'state',   // {t,s:{mode,opts}}  host → relay → everyone
    PAD:    'pad',     // {t,holder,until}   host → everyone (hot-potato)
    CHAT:   'chat',    // {t,m}
    VOTE:   'vote',    // {t,kind,value}     start a vote
    PING:   'ping',    // {t,c}              RTT probe
    WATCH:  'watch',   // {t,on:bool}        ask host for a video feed
    FRAME:  'frame',   // binary, host → watchers

    // relay → client
    WELCOME: 'welcome', // {t,ver,room,you,sid,host,players,state,votes}
    ROSTER:  'roster',  // {t,host,players,state}
    INPUT:   'input',   // {t,from,s,f}        (delivered to the host only)
    CHATX:   'chat',
    VOTE_NEW: 'vote_new',
    VOTE_END: 'vote_end',
    ERR:     'err',     // {t,code,msg}
    PONG:    'pong',     // {t,c,ts}
    ROOM_FULL: 'err',
};

export const ERR = {
    VERSION: 'version',
    FULL:    'room_full',
    NOHOST:  'no_host',
    NOTHOST: 'not_host',
    SLOW:    'rate_limited',
    BAD:     'bad_message',
    OVERLONG: 'too_long',
};

// ── Video frame header ─────────────────────────────────────────────────
export const FRAME_MAGIC = 0x534d3646; // 'SM6F'

export function encodeFrame(index, hostTs, jpegBytes) {
    const out = new Uint8Array(12 + jpegBytes.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, FRAME_MAGIC);
    v.setUint32(4, index >>> 0);
    v.setUint32(8, hostTs >>> 0);
    out.set(jpegBytes, 12);
    return out;
}

export function decodeFrame(buf) {
    if (buf.byteLength < 12) return null;
    const v = new DataView(buf);
    if (v.getUint32(0) !== FRAME_MAGIC) return null;
    return {
        index: v.getUint32(4),
        ts: v.getUint32(8),
        // Zero-copy view over the socket buffer: Blob/createImageBitmap accept a
        // TypedArray, and copying 20 KB per frame is pure waste.
        jpeg: new Uint8Array(buf, 12),
    };
}

// ── Small shared helpers ───────────────────────────────────────────────
/** Merge a list of masks with OR. */
export const union = (masks) => masks.reduce((a, b) => a | b, 0);

/**
 * Majority rule over a set of masks. Each *exclusive* choice (opposite
 * directions) needs > half of the voters to agree, otherwise nobody moves —
 * that is what makes Democracy feel like a vote instead of noise.
 */
export function majority(masks, voterCount) {
    if (!masks.length) return 0;
    const need = Math.floor((voterCount || masks.length) / 2) + 1;
    const count = (bit) => masks.filter((m) => m & bit).length;
    let out = 0;
    for (const axis of [['UP', 'DOWN'], ['LEFT', 'RIGHT']]) {
        const hi = BTN[axis[0]], lo = BTN[axis[1]];
        const cHi = count(hi), cLo = count(lo);
        if (cHi >= need && cHi > cLo) out |= hi;
        else if (cLo >= need && cLo > cHi) out |= lo;
    }
    for (const b of ['A', 'B', 'Z', 'START']) if (count(BTN[b]) >= need) out |= BTN[b];
    return out;
}

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** Rooms are shared with Discord, so treat every string as hostile input. */
export function sanitizeName(s, fallback = 'Player') {
    const raw = String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f]/g, '').trim();
    if (!raw) return fallback;
    return raw.slice(0, 24);
}

export function roomSlug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}
