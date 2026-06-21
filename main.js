// ============================================================
// Super Mario 64 Web – AI Player  (v4 — Pollinations-exclusive)
//
// Built on top of the original "Super Mario 64 Web" by Tenslant on websim:
//   https://websim.com/@Tenslant/super-mario-64-web
// AI player layer by Endoxidev/MetaMysteries8.
//
// This build is Pollinations-exclusive: Pollinations handles all model/provider
// plumbing, so the AI just connects via OAuth and picks a vision model.
//  - Single-frame vision perception + nav-grid/compass overlay
//  - Pre-plan (mini-TAS) mode: AI scripts a multi-step move in one turn
//  - Turbo / rapid-fire loops, inference throttle, idle detection
//  - AI buddy coach, streamer mode, pollen energy bar
// ============================================================

// ────────────────────────────────────────────────────────────
// 1. CONSTANTS
// ────────────────────────────────────────────────────────────
const POLLINATIONS_AUTH_URL   = 'https://enter.pollinations.ai/authorize';
const POLLINATIONS_API_BASE   = 'https://gen.pollinations.ai';
const POLLINATIONS_MODELS_URL = 'https://gen.pollinations.ai/text/models';

// Publishable App Key (BYOP client_id). Safe to ship client-side. Passed as
// `client_id` on the authorize URL so the consent screen shows this app's name
// and author, attributes traffic for tier upgrades, and credits developer
// earnings on inference users spend. NOT used as a standalone API key.
const POLLINATIONS_APP_KEY    = 'pk_E5ujItrbHDDYv2ri';

const STORAGE_KEY        = 'pollinations_api_key';
const MODEL_STORAGE_KEY  = 'sm64_selected_model';
const CONTROLS_CACHE_KEY = 'sm64_controls_guide';
const DEFAULT_MODEL      = 'openai-large';

// Minimum ms between AI inference calls (prevents runaway spending)
const MIN_THINK_INTERVAL_MS = 5000;
// How many identical frames before we skip an inference call
const IDLE_FRAME_SKIP = 2;
// Max consecutive errors before backing off
const MAX_ERRORS_BEFORE_BACKOFF = 3;

// Rapid-fire mode: AI-requestable turbo loop
const RAPID_FIRE_INTERVAL_MS  = 1500;  // think every 1.5s
const RAPID_FIRE_MAX_TURNS    = 30;    // auto-exit after 30 turns (~45s)
const RAPID_FIRE_ACTION_MS    = 300;   // shorter action window


// ── SM64 Memory Reader (sm64-port DECOMP build, NOT an emulator) ─────
// This binary is the PC/decomp port compiled to wasm (found "sm64config",
// "sm64_save_file" in it). So gMarioState is a NATIVE little-endian C struct
// in the Emscripten heap at a build-specific address — the old N64 ROM
// addresses + big-endian swapping were completely wrong (hence all zeros).
//
// We locate the struct by scanning the heap for the well-known MarioState
// layout. These offsets are struct-relative and stable across decomp builds
// (wasm32 pointers are 4 bytes, same as N64, so the layout matches).
const MS_OFF = {
    ACTION:    0x0C,   // u32  current action id
    FACE_YAW:  0x2E,   // s16  faceAngle[1] (yaw)
    POS_X:     0x3C,   // f32
    POS_Y:     0x40,   // f32
    POS_Z:     0x44,   // f32
    FWD_VEL:   0x54,   // f32  horizontal speed
    COINS:     0xA8,   // s16
    STARS:     0xAA,   // s16
    LIVES:     0xAD,   // s8
    HEALTH:    0xAE,   // u16  high byte = wedge count (0x0880 = full)
    CAP_TIMER: 0xB6,   // u16
};

let _marioBase     = -1;     // byte offset of gMarioState in the heap
let _gameState     = null;   // last successfully read state
let _baseScanTries = 0;      // throttles re-scans when not yet found

// ⚠ Memory reading is DISABLED by default on this build.
// The MarioState struct offsets could not be verified against this specific
// wasm, and the scanner kept locking onto garbage — reporting Mario "in water"
// at impossible coords (0,0,26) on dry land — which actively MISLED the AI.
// Vision is the reliable source of truth, so we don't feed memory to the model.
// Advanced users can re-enable to experiment/calibrate from the console:
//     sm64Memory(true)
let MEMORY_ENABLED = (() => { try { return localStorage.getItem('sm64_memory_enabled') === '1'; } catch { return false; } })();
window.sm64Memory = (on) => {
    MEMORY_ENABLED = !!on;
    try { localStorage.setItem('sm64_memory_enabled', on ? '1' : '0'); } catch {}
    if (!on) { _marioBase = -1; _gameState = null; }
    console.log(`[SM64] memory reading ${on ? 'ENABLED (experimental)' : 'disabled'}`);
    return MEMORY_ENABLED;
};

function _looksLikeMario(b) {
    const f = Module.HEAPF32, U16 = Module.HEAPU16, I16 = Module.HEAP16, I8 = Module.HEAP8, U32 = Module.HEAPU32;
    if (!Module.HEAPU8 || b + 0xB8 > Module.HEAPU8.length) return false;

    // Health: high byte = wedge count, must be 1..8, full = 0x0880
    const health = U16[(b + MS_OFF.HEALTH) >> 1];
    const wedges = health >> 8;
    if (wedges < 1 || wedges > 8 || health < 0x0100 || health > 0x0880) return false;

    // Lives: Mario always has >= 1 while alive (starts at 4). Rejects the
    // false-positive that showed lives=0.
    const lives = I8[b + MS_OFF.LIVES];
    if (lives < 1 || lives > 99) return false;

    const stars = I16[(b + MS_OFF.STARS) >> 1];
    if (stars < 0 || stars > 120) return false;
    const coins = I16[(b + MS_OFF.COINS) >> 1];
    if (coins < 0 || coins > 999) return false;

    // Action must be a real decomp action id (carries group/flag bits, never tiny)
    const action = U32[(b + MS_OFF.ACTION) >> 2];
    if (action < 0x00000040 || action > 0xFFFFFFFF) return false;

    // Position: finite, in-bounds, and NOT all-zero (Mario is never at exact
    // origin in a level — this was the giveaway for the bad base).
    const x = f[(b + MS_OFF.POS_X) >> 2], y = f[(b + MS_OFF.POS_Y) >> 2], z = f[(b + MS_OFF.POS_Z) >> 2];
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return false;
    if (Math.abs(x) > 20000 || Math.abs(y) > 20000 || Math.abs(z) > 20000) return false;
    if (Math.abs(x) < 1 && Math.abs(z) < 1) return false;          // reject (0,_,0)

    // Forward speed must be a sane small float
    const v = f[(b + MS_OFF.FWD_VEL) >> 2];
    if (!Number.isFinite(v) || Math.abs(v) > 300) return false;

    return true;
}

function _findMarioBase() {
    const u8 = Module.HEAPU8;
    if (!u8) return -1;
    const end = Math.min(u8.length - 0xC0, 0x4000000); // scan up to 64 MB
    for (let b = 0x400; b < end; b += 4) {
        if (_looksLikeMario(b)) {
            console.log(`[SM64] Found MarioState @ 0x${b.toString(16)}`);
            return b;
        }
    }
    return -1;
}

// ACT_FLAG_* bits (sm64 decomp): STATIONARY 0x200, MOVING 0x400, AIR 0x800,
// SWIMMING 0x2000, METAL_WATER 0x4000, IDLE 0x400000.
function _actionInWater(a) { return !!(a & 0x00002000) || !!(a & 0x00004000); }
function _actionLabel(a) {
    if (!a) return 'idle';
    if (_actionInWater(a))   return 'swimming/in water';
    if (a & 0x00000800)      return 'airborne (jump/fall)';
    if (a & 0x00000400)      return 'moving';
    if (a & 0x00400000)      return 'idle';
    if (a & 0x00000200)      return 'standing';
    return 'action 0x' + (a >>> 0).toString(16);
}

function _yawToCompass(yaw) {
    const deg = ((yaw & 0xFFFF) / 65536) * 360;
    const dirs = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
    return dirs[Math.round(deg / 45) % 8];
}

function readGameState() {
    if (!MEMORY_ENABLED) return null;   // off by default — see note above
    if (!Module.HEAPU8) return null;
    if (_marioBase === -1 || !_looksLikeMario(_marioBase)) {
        // Re-scan occasionally (not every frame — a full scan is ~tens of ms)
        if (_baseScanTries++ % 6 === 0) _marioBase = _findMarioBase();
        if (_marioBase === -1) return null;
    }
    try {
        const f = Module.HEAPF32, U16 = Module.HEAPU16, I16 = Module.HEAP16, I8 = Module.HEAP8, U32 = Module.HEAPU32;
        const b = _marioBase;
        const action = U32[(b + MS_OFF.ACTION) >> 2];
        const health = U16[(b + MS_OFF.HEALTH) >> 1];
        const yaw    = I16[(b + MS_OFF.FACE_YAW) >> 1];
        const state = {
            x: Math.round(f[(b + MS_OFF.POS_X) >> 2]),
            y: Math.round(f[(b + MS_OFF.POS_Y) >> 2]),
            z: Math.round(f[(b + MS_OFF.POS_Z) >> 2]),
            speed: Math.round(f[(b + MS_OFF.FWD_VEL) >> 2] * 10) / 10,
            coins: I16[(b + MS_OFF.COINS) >> 1],
            stars: I16[(b + MS_OFF.STARS) >> 1],
            lives: I8[b + MS_OFF.LIVES],
            health: (health >> 8) & 0xFF,
            capTimer: U16[(b + MS_OFF.CAP_TIMER) >> 1],
            yaw,
            yawDeg: Math.round(((yaw & 0xFFFF) / 65536) * 360),
            facing: _yawToCompass(yaw),
            actionId: action,
            actionName: _actionLabel(action),
            inWater: _actionInWater(action),
            levelId: 0, area: 0, levelName: 'In game',
        };
        _gameState = state;
        updateMemoryHUD(state);
        return state;
    } catch (err) {
        console.warn('[SM64] read error:', err);
        return null;
    }
}

// Write Mario's position (+ optional yaw) back into RAM — used by the
// savestate / loadstate "teleport" tools.
function writeMarioPos(x, y, z, yaw) {
    if (_marioBase === -1) return false;
    try {
        const f = Module.HEAPF32, I16 = Module.HEAP16, b = _marioBase;
        f[(b + MS_OFF.POS_X) >> 2] = x;
        f[(b + MS_OFF.POS_Y) >> 2] = y;
        f[(b + MS_OFF.POS_Z) >> 2] = z;
        if (typeof yaw === 'number') I16[(b + MS_OFF.FACE_YAW) >> 1] = yaw;
        return true;
    } catch { return false; }
}

function gameStateToText(state) {
    if (!state) return '';
    const hp = '❤'.repeat(Math.max(0, state.health)) + '🖤'.repeat(Math.max(0, 8 - state.health));
    return [
        `LIVE GAME STATE (read from game memory):`,
        `  Pos: X=${state.x}, Y=${state.y}, Z=${state.z}`,
        `  Speed: ${state.speed} | Facing: ${state.facing} (${state.yawDeg}°) | Action: ${state.actionName}`,
        state.inWater ? `  ⚠ Mario is IN WATER — swim up/forward to reach land.` : '',
        `  Health: ${hp} (${state.health}/8) | Stars: ${state.stars} | Coins: ${state.coins} | Lives: ${state.lives}`,
        state.capTimer > 0 ? `  Cap timer: ${state.capTimer}` : '',
    ].filter(Boolean).join('\n');
}

function updateMemoryHUD(state) {
    const chip = document.getElementById('memory-hud-chip');
    if (chip && state) {
        chip.textContent = `⭐${state.stars} ❤${state.health}/8 🪙${state.coins} 🍄${state.lives} | ${state.levelName}`;
        chip.title = gameStateToText(state);
        chip.style.display = 'block';
    }
    // Feed the broadcast-style streamer overlay too (cheap, only paints when visible)
    if (typeof updateStreamerOverlay === 'function') updateStreamerOverlay(state);
}

// ────────────────────────────────────────────────────────────
// 2. TTS QUEUE  (single channel, no overlap)
// ────────────────────────────────────────────────────────────
//
// tts.speak(text)           — queue a message, plays after current one ends
// tts.interrupt(text)       — cancel everything and speak immediately
// tts.wait(ms).then(...)    — promise that resolves after ms (for deferred speech)
// tts.drain()               — clear the queue (but let current finish)
// tts.stop()                — cancel everything including current
//
const tts = (() => {
    let queue   = [];
    let playing = false;
    let current = null;

    function getVoice() {
        const voices = window.speechSynthesis?.getVoices() || [];
        return voices.find(v =>
            v.lang.startsWith('en') &&
            /female|woman|samantha|karen|victoria|zira|susan|google us english/i.test(v.name)
        ) || voices.find(v => v.lang.startsWith('en')) || null;
    }

    function playNext() {
        if (!window.speechSynthesis || playing || queue.length === 0) return;
        const text = queue.shift();
        playing = true;
        const utt = new SpeechSynthesisUtterance(text);
        utt.rate   = 1.05;
        utt.pitch  = 1.0;
        utt.volume = 0.92;
        const v = getVoice();
        if (v) utt.voice = v;
        utt.onend = utt.onerror = () => { playing = false; current = null; playNext(); };
        current = utt;
        window.speechSynthesis.speak(utt);
        updateTTSIndicator(true);
        utt.onend = () => {
            playing = false; current = null;
            updateTTSIndicator(queue.length > 0);
            playNext();
        };
    }

    function updateTTSIndicator(on) {
        const el = document.getElementById('tutorial-audio-indicator');
        if (el) el.classList.toggle('playing', on);
    }

    let silenced = false;

    return {
        speak(text) {
            if (!text || !window.speechSynthesis || silenced) return;
            queue.push(text);
            playNext();
        },
        interrupt(text) {
            if (!window.speechSynthesis) return;
            queue = text ? [text] : [];
            window.speechSynthesis.cancel();
            playing = false; current = null;
            if (text && !silenced) setTimeout(playNext, 80);
        },
        wait(ms) { return new Promise(r => setTimeout(r, ms)); },
        drain()  { queue = []; },
        stop()   { queue = []; window.speechSynthesis?.cancel(); playing = false; current = null; updateTTSIndicator(false); },
        silence(on) {
            silenced = on;
            if (on) { queue = []; window.speechSynthesis?.cancel(); playing = false; current = null; updateTTSIndicator(false); }
        },
        get isPlaying()  { return playing; },
        get isSilenced() { return silenced; },
    };
})();

// ────────────────────────────────────────────────────────────
// 3. PROVIDER (Pollinations-exclusive)
// ────────────────────────────────────────────────────────────

// This app is Pollinations-exclusive: Pollinations does the model/provider
// plumbing for us, so there is exactly ONE provider here.
const PROVIDERS = {
    pollinations: {
        id:    'pollinations',
        label: 'Pollinations AI',
        icon:  '🌸',
        hasVision: true,   // verified per-model at model-fetch time
        keyLabel: 'Pollinations Key (via OAuth)',
        keyPlaceholder: 'Connect via OAuth below',
        oauthOnly: true,
        modelsUrl: POLLINATIONS_MODELS_URL,
        buildRequest(messages, model, key, opts) {
            return {
                url: `${POLLINATIONS_API_BASE}/v1/chat/completions`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: { model, messages, max_tokens: opts.max_tokens || 800,
                    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.tool_choice || 'auto' } : {}),
                    ...(opts.json && !opts.tools ? { response_format: { type: 'json_object' } } : {}) },
            };
        },
    },
};

// Active provider state — always Pollinations.
let activeProvider = PROVIDERS.pollinations;
let providerKeys   = {};   // { pollinations: 'key-string' }
let pollinationsKey = null;

function getActiveKey() {
    return pollinationsKey;
}

async function callChatAPI(messages, opts = {}) {
    const key   = getActiveKey();
    if (!key) throw new Error('Not connected to Pollinations — please authorize.');
    const model = opts.model || getSelectedModel();
    const req   = activeProvider.buildRequest(messages, model, key, opts);

    const res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msg = err?.error?.message || err?.message || '';
        // ONLY a real 401 (bad/expired key) should disconnect you. A 403 is usually
        // a per-request block (rate limit, content filter, tier) — NOT a dead key,
        // so we keep you connected and just let the loop back off and retry. This
        // is the fix for "one API hiccup logs me out".
        if (res.status === 401) {
            clearStoredKey();
            pollinationsKey = null;
            document.getElementById('auth-overlay')?.classList.remove('hidden');
            throw new Error('401 Unauthorized — your Pollinations key expired. Please reconnect.');
        }
        if (res.status === 403) throw new Error(`403 (blocked this request — rate limit/tier/filter): ${msg || 'try again shortly'}`);
        if (res.status === 429) throw new Error('429 Rate limited — backing off, will retry.');
        if (res.status >= 500)  throw new Error(`Server error ${res.status} — temporary, will retry.`);
        throw new Error(msg || `HTTP ${res.status}`);
    }

    const data = await res.json();
    // Tool-calling callers need the full assistant message (tool_calls + content)
    if (opts.returnRaw) return data.choices?.[0]?.message || {};
    return data.choices?.[0]?.message?.content || '';
}

// ── Agentic tools (OpenAI/function-calling) ──────────────────
// The model can call these on demand. get_game_state reads live RAM; the
// others let it control the game, escape water, check if it's stuck/trapped,
// teleport-save spots, navigate by coordinates, and slow time down.
function _tool(name, description, properties = {}, required = []) {
    return { type: 'function', function: { name, description,
        parameters: { type: 'object', properties, required } } };
}
const AI_TOOLS = [
    _tool('get_game_state', 'Read live SM64 RAM: Mario pos (x,y,z), facing/compass, action, speed, health, stars, coins, lives. Use for exact numbers.'),
    _tool('set_game_speed', 'Change game speed. Use slow motion (e.g. 0.5) for precise platforming, faster for travel.',
        { speed: { type: 'number', description: '0.5 (slow-mo) to 3 (fast)' } }, ['speed']),
    _tool('de_water', 'EMERGENCY water-escape (rapid-fire toward shore). LOCKED until is_stuck or is_trapped confirms true.'),
    _tool('is_stuck', 'Fresh check of the last few frames: is Mario stuck (position/camera not changing)? Returns true/false. A true result UNLOCKS the escape tools (de_water/load_state/reset_game) and starts rapid-fire recovery.'),
    _tool('is_trapped', 'Analyze the last few frames: is Mario trapped with no way out? Returns true/false. A true result UNLOCKS the escape tools and starts rapid-fire recovery.'),
    _tool('look_around', 'Turn Mario in place to survey the surroundings (the camera follows him, revealing exits/paths you were facing away from).'),
    _tool('set_goal', 'Set a persistent short-term goal you will keep pursuing across turns.',
        { goal: { type: 'string', description: 'e.g. "enter the castle door"' } }, ['goal']),
    _tool('study_guide', 'Re-read the SM64 strategy guides and refresh your study notes (use if you are unsure how to progress).'),
    _tool('save_move', 'Save the action sequence you JUST performed under a name, so you can replay it later (e.g. a reliable "cross the bridge" or "climb the slope" maneuver).',
        { name: { type: 'string' } }, ['name']),
    _tool('play_move', 'Replay a previously saved movement sequence by name.',
        { name: { type: 'string' } }, ['name']),
    _tool('save_waypoint', 'Remember Mario\'s current position under a name, to navigate back to later.',
        { name: { type: 'string' } }, ['name']),
    _tool('waypoint_distance', 'Get distance and turn direction from Mario to a saved waypoint (uses real coordinates).',
        { name: { type: 'string' } }, ['name']),
    _tool('save_state', 'Save Mario\'s exact spot to a slot (a lightweight checkpoint you can teleport back to).',
        { slot: { type: 'string', description: 'slot name, e.g. "a"' } }, ['slot']),
    _tool('load_state', 'Teleport Mario back to a saved checkpoint slot. LOCKED until is_stuck or is_trapped confirms true.',
        { slot: { type: 'string' } }, ['slot']),
    _tool('reset_game', 'Last resort: restart to the intro (reloads, no progress saved). LOCKED until is_stuck or is_trapped confirms true.'),
];

// Tools that can ONLY work when memory reading is enabled (they read/write
// Mario's coordinates). Memory is OFF by default on this build, so we hide them
// from the model rather than advertising tools that always return an error.
const MEMORY_TOOLS = new Set(['get_game_state', 'save_waypoint', 'waypoint_distance', 'save_state', 'load_state']);
function getActiveTools() {
    return MEMORY_ENABLED ? AI_TOOLS : AI_TOOLS.filter(t => !MEMORY_TOOLS.has(t.function.name));
}

// Lightweight stores for the tools
let _waypoints  = {};
let _saveStates = {};
let _savedMoves = {};     // named action sequences the AI can replay
let _frameHistory = [];   // last few screenshots (data URLs) for is_stuck/is_trapped

// ── Anti-cheat gate ──────────────────────────────────────────
// The powerful "escape" tools (teleport / water-escape / reset) are LOCKED.
// They only unlock after is_stuck or is_trapped confirms Mario is stuck/trapped
// (returns true). That confirmation arms rapid-fire recovery; the cheats stay
// usable for the whole rapid-fire window plus 5 extra turns afterward.
const CHEAT_TOOLS = new Set(['load_state', 'de_water', 'reset_game']);
let _escapeArmed      = false;   // a stuck/trapped check came back true this episode
let _escapeExtraTurns = 0;       // unlocked turns remaining after rapid-fire ends

function escapeUnlocked() {
    return (_escapeArmed && _rapidFireActive) || _escapeExtraTurns > 0;
}
function armEscape(reason) {
    _escapeArmed = true;
    if (!_rapidFireActive) enterRapidFire();
    updateAIStatus(`🔓 Escape tools unlocked (${reason})`);
    if (typeof pushChatlog === 'function') pushChatlog(`<span class="cl-cmd">🔓 escape unlocked — ${_esc(reason)}</span>`, 'cl-tool');
}

// Execute a tool call and return a short text result (also shown in the chatlog)
async function executeTool(name, args = {}) {
    try {
        // Anti-cheat: escape tools require a confirmed stuck/trapped verdict first
        if (CHEAT_TOOLS.has(name) && !escapeUnlocked()) {
            return `🔒 "${name}" is LOCKED. First call is_stuck or is_trapped — if it returns true, escape tools unlock during the rapid-fire recovery (plus 5 turns after). Do not try to ${name} otherwise.`;
        }
        switch (name) {
            case 'get_game_state': {
                if (!MEMORY_ENABLED) return 'Live memory readout is unavailable/unreliable on this build — rely on what you SEE on the screen instead.';
                const st = readGameState();
                return st ? gameStateToText(st) : 'Game state not readable yet (still booting).';
            }
            case 'set_game_speed': {
                let s = parseFloat(args.speed);
                if (!Number.isFinite(s)) return 'Invalid speed.';
                s = Math.max(0.5, Math.min(3, s));
                _applyGameSpeed(s);
                return `Game speed set to ${s}×.`;
            }
            case 'de_water': {   // only reachable when escape is unlocked
                userInstruction = 'ESCAPE THE WATER NOW: swim toward the nearest shore/land and climb out at all costs, then continue. Press jump (X) while swimming to surface and move with the arrows toward dry ground.';
                if (!_rapidFireActive) enterRapidFire();
                return 'Water-escape engaged: rapid-fire on, focusing on reaching land.';
            }
            case 'is_stuck': {
                const v = await _frameVerdict('stuck',
                    'These are sequential SM64 frames (oldest→newest). Is Mario STUCK — i.e. his position/camera barely changed across them AND he is wedged against a wall/ledge/water with nowhere useful to walk? Consider whether there is standable ground he could actually move onto. Answer exactly "STUCK" or "MOVING", then one short reason.');
                if (v.positive) armEscape('stuck confirmed');
                return `is_stuck → ${v.positive} :: ${v.text}`;
            }
            case 'is_trapped': {
                const v = await _frameVerdict('trapped',
                    'These are sequential SM64 frames of Mario (oldest→newest). Look at the SURROUNDINGS: is there any visible standable land / path / ledge he can reach, or is he boxed in by water, lava, walls or a pit with no way out? Answer exactly "TRAPPED" or "EXIT: <direction + what to walk toward>", then one short reason.');
                if (v.positive) armEscape('trapped confirmed');
                return `is_trapped → ${v.positive} :: ${v.text}`;
            }
            case 'look_around': {
                // No keyboard camera in this build — turn Mario right in steps so
                // the camera swings around behind him and reveals the surroundings.
                for (let i = 0; i < 4 && aiPlayerActive; i++) { simulateKeyPress('ArrowRight', 200); await delay(220); }
                return 'Turned Mario to survey the surroundings (camera follows him).';
            }
            case 'set_goal': {
                const g = String(args.goal || '').slice(0, 200);
                if (!g) return 'No goal provided.';
                _aiGoal = g; _aiGoalAge = 0;   // feeds the persistent multi-turn plan
                return `Goal set — I'll keep pursuing: ${g}`;
            }
            case 'study_guide': {
                await runStudy({ silent: true });
                return `Studied the guide — ${aiNotes.length} strategy notes ready (now in my context).`;
            }
            case 'save_move': {
                if (!_lastActions) return 'No recent move to save yet — perform a sequence first.';
                _savedMoves[args.name || 'move'] = JSON.parse(JSON.stringify(_lastActions));
                return `Saved move "${args.name || 'move'}" (${_savedMoves[args.name || 'move'].length} steps).`;
            }
            case 'play_move': {
                const mv = _savedMoves[args.name];
                if (!mv) return `No saved move named "${args.name}". Saved: ${Object.keys(_savedMoves).join(', ') || 'none'}.`;
                await aiExecute({ actions: mv });
                return `Replayed move "${args.name}".`;
            }
            case 'save_waypoint': {
                const st = readGameState();
                if (!st) return 'Cannot read position right now.';
                _waypoints[args.name || 'wp'] = { x: st.x, y: st.y, z: st.z };
                return `Waypoint "${args.name || 'wp'}" saved at (${st.x},${st.y},${st.z}).`;
            }
            case 'waypoint_distance': {
                const wp = _waypoints[args.name];
                const st = readGameState();
                if (!wp) return `No waypoint named "${args.name}".`;
                if (!st) return 'Cannot read position right now.';
                const dx = wp.x - st.x, dz = wp.z - st.z;
                const dist = Math.round(Math.hypot(dx, dz));
                const targetYaw = Math.atan2(dx, dz) * 0x8000 / Math.PI;
                let diff = ((targetYaw - st.yaw + 32768) & 0xFFFF) - 32768;
                const turn = Math.abs(diff) < 4000 ? 'straight ahead'
                           : diff > 0 ? 'to your right' : 'to your left';
                return `Waypoint "${args.name}" is ${dist} units away, ${turn} (Δy ${wp.y - st.y}).`;
            }
            case 'save_state': {
                const st = readGameState();
                if (!st) return 'Cannot read position right now.';
                _saveStates[args.slot || 'a'] = { x: st.x, y: st.y, z: st.z, yaw: st.yaw };
                return `Checkpoint "${args.slot || 'a'}" saved.`;
            }
            case 'load_state': {
                const ss = _saveStates[args.slot];
                if (!ss) return `No checkpoint in slot "${args.slot}".`;
                const ok = writeMarioPos(ss.x, ss.y, ss.z, ss.yaw);
                return ok ? `Teleported back to checkpoint "${args.slot}".` : 'Teleport failed (memory not writable).';
            }
            case 'reset_game': {
                tts.interrupt('Resetting the game.');
                setTimeout(() => location.reload(), 600);
                return 'Resetting to the intro now…';
            }
            default: return `Unknown tool: ${name}`;
        }
    } catch (err) {
        return `Tool "${name}" error: ${err.message}`;
    }
}

// Sub-call: ask the SAME model about the last few frames and parse a boolean
// verdict. `kind` is 'stuck' or 'trapped'. Returns { positive, text }.
async function _frameVerdict(kind, question) {
    const frames = _frameHistory.slice(-5);
    if (!providerHasVision() || frames.length < 2) {
        // No vision (or not enough history) — judge from RAM motion instead
        const positive = _stuckCount >= 2;
        return { positive, text: positive
            ? `position barely changed for ${_stuckCount} turns (RAM)`
            : 'position is still changing (RAM)' };
    }
    try {
        const content = [{ type: 'text', text: question }];
        frames.forEach((f) => content.push({ type: 'image_url', image_url: { url: f } }));
        const ans = ((await callChatAPI(
            [{ role: 'system', content: 'You are a precise SM64 vision analyst. Be terse and decisive.' },
             { role: 'user', content }],
            { max_tokens: 50 })) || '').trim();
        recordUsage();
        const positive = kind === 'stuck'
            ? /stuck/i.test(ans) && !/moving|not\s+stuck/i.test(ans)
            : /trapped/i.test(ans) && !/exit|way\s*out/i.test(ans);
        return { positive, text: ans.slice(0, 140) || 'no clear answer' };
    } catch (err) {
        return { positive: false, text: `check failed: ${err.message}` };
    }
}

// Apply a game-speed change everywhere (slider, label, AI loop)
function _applyGameSpeed(s) {
    gameSpeed = s;
    const sl = document.getElementById('speed-slider'); if (sl) sl.value = s;
    const lb = document.getElementById('speed-label');  if (lb) lb.textContent = `${s}×`;
    if (aiInterval) { clearInterval(aiInterval); aiInterval = null; }
    if (aiPlayerActive && aiMode === 'auto' && !_rapidFireActive) scheduleAILoop();
}

// Per-model tool support (Pollinations models vary). null = unknown — we
// optimistically try tools once, then remember the result per model.
const _modelToolSupport = {};

function modelMaySupportTools(model) {
    const known = _modelToolSupport[model];
    return known !== false; // try when true or unknown
}

// Run one chat turn that may use the get_game_state tool.
// Falls back transparently to a plain call if the provider/model rejects tools.
async function callChatWithTools(messages, opts = {}) {
    const model = opts.model || getSelectedModel();
    if (!modelMaySupportTools(model)) {
        return await callChatAPI(messages, opts);
    }

    try {
        const convo = [...messages];
        let rounds = 0;
        const MAX_ROUNDS = 2;           // cap tool rounds so it can't spam /get_game_state
        let toolCallBudget = 4;         // hard cap on total tool calls per turn
        while (rounds++ <= MAX_ROUNDS) {
            // On the final allowed round, drop tools so the model MUST answer
            const allowTools = rounds <= MAX_ROUNDS && toolCallBudget > 0;
            const msg = await callChatAPI(convo, {
                ...opts, returnRaw: true,
                ...(allowTools ? { tools: getActiveTools(), tool_choice: 'auto' } : {}),
            });
            _modelToolSupport[model] = true; // it accepted the tools field

            const calls = (allowTools && msg.tool_calls) ? msg.tool_calls : [];
            if (!calls.length) return msg.content || '';

            convo.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
            for (const call of calls) {
                if (toolCallBudget-- <= 0) {
                    convo.push({ role: 'tool', tool_call_id: call.id, content: 'Tool budget exhausted for this turn — answer now.' });
                    continue;
                }
                let args = {};
                try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
                const name   = call.function?.name || 'tool';
                const result = await executeTool(name, args);
                logToolCall(name, args, result.length > 70 ? result.slice(0, 70) + '…' : result);
                convo.push({ role: 'tool', tool_call_id: call.id, content: result });
            }
        }
        // Exhausted tool rounds — final plain pass with no tools
        return await callChatAPI(convo, opts);
    } catch (err) {
        // Most likely the model/provider doesn't accept tools — remember & retry plainly
        if (/tool|function|unsupported|invalid|400/i.test(err.message || '')) {
            _modelToolSupport[model] = false;
            console.warn(`[Tools] ${model} rejected tools — falling back to injection:`, err.message);
            return await callChatAPI(messages, opts);
        }
        throw err;
    }
}


// The model dropdown only ever lists Pollinations VISION models (image input),
// so the connected model can always see the screen.
function providerHasVision() { return true; }

// ────────────────────────────────────────────────────────────
// 4. AUTH (Pollinations OAuth)
// ────────────────────────────────────────────────────────────
const getStoredKey   = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const storeKey       = k  => { try { localStorage.setItem(STORAGE_KEY, k); } catch {} };
const clearStoredKey = () => { try { localStorage.removeItem(STORAGE_KEY); } catch {} };

function buildAuthUrl() {
    // client_id = our publishable App Key, so the consent screen shows the app
    // name + author and inference users spend credits developer earnings to us.
    const params = new URLSearchParams({
        redirect_uri: location.href.split('#')[0],
        client_id:    POLLINATIONS_APP_KEY,
        // usage scope → lets us read balance + per-request cost for the energy bar
        scope:        'usage',
    });
    return `${POLLINATIONS_AUTH_URL}?${params}`;
}

function grabKeyFromHash() {
    const hash   = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const key    = params.get('api_key');
    if (key) history.replaceState(null, '', location.pathname + location.search);
    return key || null;
}

function initAuth() {
    const overlay    = document.getElementById('auth-overlay');
    const authBtn    = document.getElementById('auth-btn');
    const authStatus = document.getElementById('auth-status');

    const hashKey = grabKeyFromHash();
    if (hashKey) {
        storeKey(hashKey);
        pollinationsKey = hashKey;
        providerKeys.pollinations = hashKey;
        authStatus.textContent = '✅ Authorized! Loading game…';
        overlay.classList.add('hidden');
        document.getElementById('disconnect-btn').style.display = '';
        tts.interrupt('Connected! Your Pollinations account is linked. The game is ready.');
        return;
    }

    const stored = getStoredKey();
    if (stored) {
        pollinationsKey = stored;
        providerKeys.pollinations = stored;
        overlay.classList.add('hidden');
        document.getElementById('disconnect-btn').style.display = '';
        return;
    }

    overlay.classList.remove('hidden');
    tts.speak('Welcome to SM64 AI Player! Connect your Pollinations account to get started.');

    authBtn.addEventListener('click', () => {
        authStatus.textContent = '🔄 Redirecting to Pollinations…';
        authBtn.disabled = true;
        setTimeout(() => { window.location.href = buildAuthUrl(); }, 300);
    });

    document.getElementById('auth-tutorial-btn').addEventListener('click', () => openTutorial());
}

// ────────────────────────────────────────────────────────────
// 5. CANVAS / GAME SETUP + CORE SWITCHING
// ────────────────────────────────────────────────────────────
let _activeCore = 'original'; // 'original' | 'emulatorjs'
const _originalCanvas = document.getElementById('canvas');
const _emulatorjsContainer = document.getElementById('emulatorjs-container');

function getGameCanvas() {
    if (_activeCore === 'emulatorjs') {
        return _emulatorjsContainer.querySelector('canvas') || _emulatorjsContainer;
    }
    return _originalCanvas;
}

_originalCanvas.style.touchAction = 'none';
_originalCanvas.addEventListener('mousedown', () => _originalCanvas.focus());

Object.assign(window.Module, {
    canvas: _originalCanvas,
    locateFile: (path) => (path.endsWith('.wasm') ? './sm64.wasm' : path),
});

_originalCanvas.focus();

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { e.stopPropagation(); return; }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'Enter') getGameCanvas().focus();
}, { passive: false });

document.addEventListener('click', () => {
    try { if (Module?.SDL2?.audioContext?.state === 'suspended') Module.SDL2.audioContext.resume(); } catch {}
});

// ── EmulatorJS + BPS patcher integration ────────────────────
function switchToEmulatorJS(romBlob) {
    stopAIPlayer();
    updateAIStatus('📦 Storing patched ROM — reloading into emulator-only mode…');
    window._storeRomForEmu(romBlob).then(function() {
        sessionStorage.setItem('sm64_emu_mode', '1');
        location.reload();
    }).catch(function(err) {
        updateAIStatus('❌ Failed to store ROM: ' + err.message);
    });
}

// Patch UI wiring
(function setupPatchUI() {
    const modal = document.getElementById('patch-modal');
    const btn = document.getElementById('patch-rom-btn');
    const closeBtn = document.getElementById('patch-close-btn');
    const applyBtn = document.getElementById('patch-apply-btn');
    const romInput = document.getElementById('patch-rom-input');
    const bpsInput = document.getElementById('patch-bps-input');
    const status = document.getElementById('patch-status');
    if (!modal || !btn) return;
    btn.addEventListener('click', () => { modal.style.display = 'flex'; status.textContent = ''; });
    closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.querySelector('#patch-modal-backdrop').addEventListener('click', () => { modal.style.display = 'none'; });
    applyBtn.addEventListener('click', async () => {
        status.style.color = '#ff6b6b';
        const romFile = romInput.files[0];
        const patchFile = bpsInput.files[0];
        if (!romFile) { status.textContent = 'Select a base ROM first.'; return; }
        try {
            status.style.color = 'var(--text)';
            status.textContent = 'Reading ROM…';
            const romArray = new Uint8Array(await romFile.arrayBuffer());
            const romBin = new BinFile(romArray);
            romBin.fileName = romFile.name;
            let patchedBin = romBin;
            if (patchFile) {
                status.textContent = 'Applying patch…';
                const patchArray = new Uint8Array(await patchFile.arrayBuffer());
                const patchBin = new BinFile(patchArray);
                patchBin.fileName = patchFile.name;
                const patch = RomPatcher.parsePatchFile(patchBin);
                if (!patch) { status.textContent = 'Unknown or unsupported patch format.'; return; }
                patchedBin = RomPatcher.applyPatch(romBin, patch, { requireValidation: false, outputSuffix: false });
            }
            const patchedBlob = new Blob([patchedBin._u8array], { type: 'application/octet-stream' });
            status.textContent = 'Loading into emulator…';
            modal.style.display = 'none';
            switchToEmulatorJS(patchedBlob);
        } catch (err) {
            console.error(err);
            status.style.color = '#ff6b6b';
            status.textContent = 'Error: ' + err.message;
        }
    });
})();

// ────────────────────────────────────────────────────────────
// 6. LIVE MODEL FETCHING (Pollinations)
// ────────────────────────────────────────────────────────────
let allVisionModels = [];
let showPaidModels  = false;

async function fetchVisionModels() {
    const select     = document.getElementById('model-select');
    const statusSpan = document.getElementById('model-status');

    select.innerHTML = '<option value="">Loading…</option>';
    select.disabled  = true;

    try {
        const res  = await fetch(POLLINATIONS_MODELS_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        allVisionModels = data.filter(m =>
            Array.isArray(m.input_modalities) && m.input_modalities.includes('image')
        );
        populateModelDropdown();
    } catch (err) {
        console.error('Failed to fetch models:', err);
        allVisionModels = [{ name: DEFAULT_MODEL, title: 'GPT-5.4 (fallback)', paid_only: false }];
        populateModelDropdown();
        if (statusSpan) statusSpan.textContent = '⚠ offline';
    }
}


function populateModelDropdown() {
    const select     = document.getElementById('model-select');
    const statusSpan = document.getElementById('model-status');
    if (!select) return;


    const visible   = showPaidModels ? allVisionModels : allVisionModels.filter(m => !m.paid_only);
    const savedModel = localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL;
    const savedOK    = visible.some(m => m.name === savedModel);

    select.innerHTML = '';
    const free = visible.filter(m => !m.paid_only);
    const paid = visible.filter(m =>  m.paid_only);

    function addGroup(label, models) {
        if (!models.length) return;
        const grp = document.createElement('optgroup');
        grp.label = label;
        for (const m of models) {
            const opt = document.createElement('option');
            opt.value = m.name;
            opt.textContent = m.title || m.name;
            if (m.paid_only) opt.classList.add('paid-model');
            if (m.name === (savedOK ? savedModel : DEFAULT_MODEL)) opt.selected = true;
            grp.appendChild(opt);
        }
        select.appendChild(grp);
    }

    addGroup('Free Models', free);
    if (showPaidModels) addGroup('Paid Models 💰', paid);

    select.disabled = false;
    const freeCount = allVisionModels.filter(m => !m.paid_only).length;
    const paidCount = allVisionModels.filter(m =>  m.paid_only).length;
    if (statusSpan) statusSpan.textContent = showPaidModels
        ? `${free.length + paid.length} models`
        : `${freeCount} free · ${paidCount} paid hidden`;
}

function getSelectedModel() {
    const sel = document.getElementById('model-select');
    const val = sel?.value;
    if (val && val !== 'Loading models…' && val !== 'Loading…') return val;
    return activeProvider?.defaultModel || DEFAULT_MODEL;
}

document.getElementById('model-select').addEventListener('change', (e) => {
    try { localStorage.setItem(MODEL_STORAGE_KEY, e.target.value); } catch {}
});

document.getElementById('show-paid-toggle').addEventListener('change', (e) => {
    showPaidModels = e.target.checked;
    populateModelDropdown();
});

// ────────────────────────────────────────────────────────────
// 7. PROVIDER SETTINGS PANEL  (Pollinations-only)
// ────────────────────────────────────────────────────────────
function buildProviderPanel() {
    const panel = document.getElementById('provider-panel');
    if (!panel) return;
    panel.innerHTML = '';

    // This app is Pollinations-exclusive — Pollinations handles every model + API.
    const intro = document.createElement('p');
    intro.className = 'provider-bridge-note';
    intro.innerHTML = '🌸 <strong>Powered by Pollinations AI.</strong> Pick any vision model from the model dropdown in the top bar — no other API keys needed.';
    panel.appendChild(intro);

    // Connection status row
    const connRow = document.createElement('div');
    connRow.className = 'provider-row';
    const connLabel = document.createElement('label');
    connLabel.className = 'provider-label';
    connLabel.textContent = 'Pollinations account';
    const connStatus = document.createElement('span');
    connStatus.className = 'provider-local-status';
    connStatus.textContent = pollinationsKey ? '✅ Connected' : '⬜ Not connected';
    connRow.appendChild(connLabel);
    connRow.appendChild(connStatus);
    panel.appendChild(connRow);

    // Vision source row — direct canvas grab vs screen-share
    const visRow = document.createElement('div');
    visRow.className = 'provider-row';
    const visLabel = document.createElement('label');
    visLabel.className = 'provider-label';
    visLabel.textContent = 'AI vision source';
    const visSel = document.createElement('select');
    visSel.className = 'provider-select';
    visSel.innerHTML = `
        <option value="canvas">🎯 Game canvas (no popup, recommended)</option>
        <option value="screen">🖥️ Screen share (window/tab)</option>`;
    visSel.value = _visionSource;
    visSel.addEventListener('change', () => setVisionSource(visSel.value));
    visRow.appendChild(visLabel);
    visRow.appendChild(visSel);
    panel.appendChild(visRow);

    // Command format — JSON (smart models) vs Simple text (weaker models)
    const fmtRow = document.createElement('div');
    fmtRow.className = 'provider-row';
    const fmtLabel = document.createElement('label');
    fmtLabel.className = 'provider-label';
    fmtLabel.textContent = 'AI reply format';
    const fmtSel = document.createElement('select');
    fmtSel.className = 'provider-select';
    fmtSel.innerHTML = `
        <option value="json">🧩 JSON (smart models, default)</option>
        <option value="simple">📝 Simple text (best for weaker models)</option>`;
    fmtSel.value = _cmdFormat;
    fmtSel.addEventListener('change', () => setCmdFormat(fmtSel.value));
    fmtRow.appendChild(fmtLabel);
    fmtRow.appendChild(fmtSel);
    panel.appendChild(fmtRow);

    // ── Parent + Child learner (recommended) ──
    const expHead = document.createElement('div');
    expHead.className = 'provider-bridge-note';
    expHead.innerHTML = '🧠 <strong>Parent &amp; Child learner (recommended, on by default).</strong> The text model is the <em>parent</em> — it knows Super Mario 64 but fumbles the loose controls. Beside it runs a tiny from-scratch reinforcement learner — the <em>child</em> — born with ZERO game knowledge, learning only by watching which inputs actually move Mario (rewarded for progress, punished for getting stuck or killed). The parent grades the child and sets a TRUST level; as the child grows up, the parent hands it the controller more often. Also adds a rough depth read.';
    panel.appendChild(expHead);

    const abRow = document.createElement('label');
    abRow.className = 'provider-row'; abRow.style.cursor = 'pointer';
    abRow.innerHTML = `<span class="provider-label">Enable parent + child learner</span>`;
    const abChk = document.createElement('input');
    abChk.type = 'checkbox'; abChk.checked = _adaptiveBrain;
    abChk.addEventListener('change', () => setAdaptiveBrain(abChk.checked));
    abRow.appendChild(abChk); panel.appendChild(abRow);

    const biasRow = document.createElement('div');
    biasRow.className = 'provider-row';
    const biasLabel = document.createElement('label');
    biasLabel.className = 'provider-label'; biasLabel.textContent = 'Learning bias';
    const biasSel = document.createElement('select');
    biasSel.className = 'provider-select';
    biasSel.innerHTML = `
        <option value="improve">📈 Improve (amplify what works)</option>
        <option value="chaos">🎲 Chaos (amplify the jank, for streams)</option>`;
    biasSel.value = _brainBias;
    biasSel.addEventListener('change', () => setBrainBias(biasSel.value));
    biasRow.appendChild(biasLabel); biasRow.appendChild(biasSel);
    panel.appendChild(biasRow);

    // Let the child take the controller when the parent trusts it enough.
    const assistRow = document.createElement('label');
    assistRow.className = 'provider-row'; assistRow.style.cursor = 'pointer';
    assistRow.innerHTML = `<span class="provider-label">🧒 Let the child take steps<br><small>Once the parent trusts it, the child plays moves it has learned — more often as trust grows</small></span>`;
    const assistChk = document.createElement('input');
    assistChk.type = 'checkbox'; assistChk.checked = _brainAssistControl;
    assistChk.addEventListener('change', () => setBrainAssist(assistChk.checked));
    assistRow.appendChild(assistChk); panel.appendChild(assistRow);

    // Elder mode — the child learns from the human's manual play.
    const elderRow = document.createElement('label');
    elderRow.className = 'provider-row'; elderRow.style.cursor = 'pointer';
    elderRow.innerHTML = `<span class="provider-label">🧓 Learn from my play (elder)<br><small>While the AI is on but you grab the controls, the child watches and learns from you — play a level by hand to teach it</small></span>`;
    const elderChk = document.createElement('input');
    elderChk.type = 'checkbox'; elderChk.checked = _elderLearn;
    elderChk.addEventListener('change', () => setElderLearn(elderChk.checked));
    elderRow.appendChild(elderChk); panel.appendChild(elderRow);

    // AI grading (off by default) — in Player-Teach, also have the LLM grade you.
    const gradeRow = document.createElement('label');
    gradeRow.className = 'provider-row'; gradeRow.style.cursor = 'pointer';
    gradeRow.innerHTML = `<span class="provider-label">👨‍🏫 AI grades my play (Player-Teach)<br><small>Off: it just watches & imitates you. On: the LLM also grades each move (costs calls; can be noisy)</small></span>`;
    const gradeChk = document.createElement('input');
    gradeChk.type = 'checkbox'; gradeChk.checked = _aiGrading;
    gradeChk.addEventListener('change', () => setAiGrading(gradeChk.checked));
    gradeRow.appendChild(gradeChk); panel.appendChild(gradeRow);

    // Real-time RL control — continuous raw controller vs timed presses.
    const rtRow = document.createElement('label');
    rtRow.className = 'provider-row'; rtRow.style.cursor = 'pointer';
    rtRow.innerHTML = `<span class="provider-label">🎮 Real-time RL control<br><small>RL Play holds keys continuously like a real pad (can run + jump/dive together) instead of one timed press at a time</small></span>`;
    const rtChk = document.createElement('input');
    rtChk.type = 'checkbox'; rtChk.checked = _rlRealtime;
    rtChk.addEventListener('change', () => setRlRealtime(rtChk.checked));
    rtRow.appendChild(rtChk); panel.appendChild(rtRow);

    // Persistent model (experimental) — save the trained RL across reloads.
    const persRow = document.createElement('label');
    persRow.className = 'provider-row'; persRow.style.cursor = 'pointer';
    persRow.innerHTML = `<span class="provider-label">💾 Persistent RL model (experimental)<br><small>Off: learns only this session. On: saves the trained model in your browser across reloads — it's a real model, so you can export/share it</small></span>`;
    const persChk = document.createElement('input');
    persChk.type = 'checkbox'; persChk.checked = _rlPersist;
    persChk.addEventListener('change', () => setRlPersist(persChk.checked));
    persRow.appendChild(persChk); panel.appendChild(persRow);

    // Export / import the trained model
    const ioRow = document.createElement('div'); ioRow.className = 'provider-row'; ioRow.style.gap = '8px';
    const expBtn = document.createElement('button');
    expBtn.className = 'provider-save-btn'; expBtn.style.flex = '1'; expBtn.textContent = '⬇ Export model';
    expBtn.addEventListener('click', exportRlModel);
    const impBtn = document.createElement('button');
    impBtn.className = 'provider-save-btn'; impBtn.style.flex = '1'; impBtn.textContent = '⬆ Import model';
    const impFile = document.createElement('input'); impFile.type = 'file'; impFile.accept = 'application/json'; impFile.style.display = 'none';
    impFile.addEventListener('change', (e) => { if (e.target.files[0]) importRlModel(e.target.files[0]); });
    impBtn.addEventListener('click', () => impFile.click());
    ioRow.appendChild(expBtn); ioRow.appendChild(impBtn); ioRow.appendChild(impFile);
    panel.appendChild(ioRow);

    const clearQ = document.createElement('button');
    clearQ.className = 'provider-save-btn'; clearQ.style.background = '#3a2030';
    clearQ.textContent = '🧹 Reset what it has learned';
    clearQ.addEventListener('click', () => { clearQTable(); clearQ.textContent = '✓ Learning reset'; setTimeout(() => clearQ.textContent = '🧹 Reset what it has learned', 1500); });
    panel.appendChild(clearQ);

    // Connect / reconnect button
    const connectBtn = document.createElement('button');
    connectBtn.className = 'provider-save-btn';
    connectBtn.textContent = pollinationsKey ? '🔄 Reconnect Pollinations' : '🔗 Connect Pollinations';
    connectBtn.addEventListener('click', () => {
        closeProviderPanel();
        document.getElementById('auth-overlay')?.classList.remove('hidden');
    });
    panel.appendChild(connectBtn);
}

function openProviderPanel() {
    buildProviderPanel();
    document.getElementById('provider-modal').classList.add('open');
    document.getElementById('provider-backdrop').classList.add('open');
}
window.openProviderPanel = openProviderPanel;

function closeProviderPanel() {
    document.getElementById('provider-modal').classList.remove('open');
    document.getElementById('provider-backdrop').classList.remove('open');
}

document.getElementById('provider-btn')?.addEventListener('click', openProviderPanel);
document.getElementById('provider-backdrop')?.addEventListener('click', closeProviderPanel);
document.getElementById('close-provider-btn')?.addEventListener('click', closeProviderPanel);

function setCmdFormat(fmt) {
    _cmdFormat = (fmt === 'simple') ? 'simple' : 'json';
    try { localStorage.setItem('sm64_cmd_format', _cmdFormat); } catch {}
    updateAIStatus(`📝 AI reply format: ${_cmdFormat === 'simple' ? 'Simple text' : 'JSON'}`);
}
window.sm64CmdFormat = setCmdFormat;   // console helper too

// Pollinations-only: nothing extra to restore (auth handled by initAuth).
function restoreProviderState() {}

// ────────────────────────────────────────────────────────────
// 8. CONTROLS GUIDE  (one AI call, cached in localStorage)
// ────────────────────────────────────────────────────────────
const CONTROLS_STATIC = [
    { key: '↑ / ↓',     action: 'Move forward / backward' },
    { key: '← / →',     action: 'Turn left / right' },
    { key: 'X',         action: 'A — Jump / skip dialog' },
    { key: 'C',         action: 'B — Dive / punch / grab / read' },
    { key: 'Space',     action: 'Z — Crouch / ground-pound' },
    { key: 'Enter',     action: 'Start — Pause / confirm menu' },
    { key: '↑ then X',  action: 'Run then jump (cross gaps, paintings)' },
    { key: '↑+Space+X',  action: 'Long jump (big leap)' },
];

let controlsGuide = null;

function renderControlsGuide(data) {
    const panel = document.getElementById('controls-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'controls-title';
    title.textContent = '🎮 Controls';
    panel.appendChild(title);

    const rows = data || CONTROLS_STATIC;
    for (const row of rows) {
        const item = document.createElement('div');
        item.className = 'controls-item';
        item.innerHTML = `<kbd>${row.key}</kbd><span>${row.action}</span>`;
        panel.appendChild(item);
    }

    if (!data) {
        const note = document.createElement('div');
        note.className = 'controls-note';
        note.textContent = 'Connect account for AI-enhanced guide';
        panel.appendChild(note);
    }
}

async function fetchAIControlsGuide() {
    // Use cached version if available
    try {
        const cached = localStorage.getItem(CONTROLS_CACHE_KEY);
        if (cached) {
            controlsGuide = JSON.parse(cached);
            renderControlsGuide(controlsGuide);
            return;
        }
    } catch {}

    if (!getActiveKey()) { renderControlsGuide(null); return; }

    try {
        const raw = await callChatAPI([
            {
                role: 'system',
                content: `You are a Super Mario 64 expert. Generate a concise keyboard controls reference for the web version.
The controls are: Arrow keys = move, X = jump/skip dialog, Space = crouch, C = dive/punch/grab, Enter = pause/skip dialog.
Also include: long jump (run + crouch + jump), triple jump, wall kick, backflip, side somersault.

Respond with ONLY valid JSON array (no markdown fences):
[{"key": "display string", "action": "what it does"}, ...]

Keep it to 12-16 entries. Make action descriptions helpful for new players.`,
            },
            { role: 'user', content: 'Generate the controls guide.' },
        ], { max_tokens: 500 });

        const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed) && parsed.length > 0) {
            controlsGuide = parsed;
            try { localStorage.setItem(CONTROLS_CACHE_KEY, JSON.stringify(parsed)); } catch {}
            renderControlsGuide(controlsGuide);
        }
    } catch (err) {
        console.warn('Controls guide AI call failed:', err);
        renderControlsGuide(null);
    }
}

document.getElementById('controls-toggle-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('controls-panel');
    if (!panel) return;
    const open = panel.classList.toggle('open');
    if (open && !controlsGuide) fetchAIControlsGuide();
});

// ────────────────────────────────────────────────────────────
// 9. TUTORIAL (Web Speech API via tts queue)
// ────────────────────────────────────────────────────────────
const TUTORIAL_STEPS = [
    {
        icon: '🍄', title: 'Welcome to SM64 AI Player',
        body: 'Watch an AI play Super Mario 64 in real time, get coached by your AI buddy, and give live instructions — all powered by Pollinations AI.',
        narration: 'Welcome to SM64 AI Player! Watch an AI play Super Mario 64 in real time, get coached by your AI buddy, and give live instructions.',
    },
    {
        icon: '🔑', title: 'Step 1 — Connect Your Account',
        body: 'Click the green Connect button to link your Pollinations account via OAuth, then pick any vision model from the model dropdown. No other API keys needed.',
        narration: 'Connect your Pollinations account with the green button, then pick a vision model from the dropdown.',
    },
    {
        icon: '🎮', title: 'Step 2 — Play It Yourself',
        body: 'The game loads automatically once connected. Use arrow keys to move, X to jump, Space to crouch, C to dive or punch, and Enter to skip dialog. Open the Controls guide for the full reference.',
        narration: 'Use arrow keys to move, X to jump, Space to crouch, C to dive or punch, and Enter to skip dialog. Open the Controls guide for the full reference.',
    },
    {
        icon: '🤖', title: 'Step 3 — Pick a mode & Start',
        body: 'Choose a mode in the dropdown (AI Play, RL Play, Player Teach, or AI Teach), then click Start. Share your screen when prompted so it can see the game. It analyzes each frame, decides what to do, and plays — narrating its thoughts out loud.',
        narration: 'Pick a mode from the dropdown, then click Start. Share your screen so it can see the game. It will analyze each frame and play, narrating its thoughts out loud.',
    },
    {
        icon: '💬', title: 'Step 4 — Give the AI Instructions',
        body: 'While the AI plays, type a message at the bottom and press Send. Try: "go find a star" or "jump into the painting". The AI factors your instruction into its next move.',
        narration: 'While the AI plays, type instructions at the bottom and press Send. Try: go find a star, or jump into the painting.',
    },
    {
        icon: '🧡', title: 'Step 5 — AI Buddy Coach',
        body: 'The Buddy Coach watches your gameplay and gives tips every 15 seconds. Click Buddy, share your screen, and it will coach you with encouragement and strategy advice.',
        narration: 'The Buddy Coach watches your gameplay and gives tips every 15 seconds. Click Buddy, share your screen, and it will coach you.',
    },
    {
        icon: '📚', title: 'Step 6 — Study & Memory',
        body: 'Click Study to have the AI read the SM64 guide and generate strategy notes. Click Memory to review those notes and any mistakes the AI has logged.',
        narration: 'Click Study to have the AI read the SM64 guide and generate strategy notes. Click Memory to review them.',
    },
    {
        icon: '🏆', title: "You're All Set!",
        body: "That's everything! Reopen this tutorial anytime with the ❓ button. Connect your account and have fun!",
        narration: "That's everything! Reopen this tutorial anytime with the help button. Connect your account and have fun!",
    },
];

let tutorialStep = 0;

function openTutorial(startStep = 0) {
    tutorialStep = startStep;
    document.getElementById('tutorial-modal').classList.add('open');
    document.getElementById('tutorial-backdrop').classList.add('open');
    renderTutorialStep();
}

function closeTutorial() {
    document.getElementById('tutorial-modal').classList.remove('open');
    document.getElementById('tutorial-backdrop').classList.remove('open');
    tts.stop();
}

function renderTutorialStep() {
    const step = TUTORIAL_STEPS[tutorialStep];
    document.getElementById('tutorial-progress').textContent = `Step ${tutorialStep + 1} of ${TUTORIAL_STEPS.length}`;
    document.getElementById('tutorial-icon').textContent  = step.icon;
    document.getElementById('tutorial-title').textContent = step.title;
    document.getElementById('tutorial-body').textContent  = step.body;

    const prevBtn = document.getElementById('tutorial-prev-btn');
    const nextBtn = document.getElementById('tutorial-next-btn');
    prevBtn.style.visibility = tutorialStep === 0 ? 'hidden' : 'visible';
    nextBtn.textContent = tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Done ✓' : 'Next →';

    if (step.narration) tts.interrupt(step.narration);
}

document.getElementById('tutorial-next-btn').addEventListener('click', () => {
    if (tutorialStep < TUTORIAL_STEPS.length - 1) { tutorialStep++; renderTutorialStep(); }
    else closeTutorial();
});
document.getElementById('tutorial-prev-btn').addEventListener('click', () => {
    if (tutorialStep > 0) { tutorialStep--; renderTutorialStep(); }
});
document.getElementById('tutorial-close-btn').addEventListener('click', closeTutorial);
document.getElementById('tutorial-backdrop').addEventListener('click', closeTutorial);
document.getElementById('help-btn').addEventListener('click', () => openTutorial(0));

// ────────────────────────────────────────────────────────────
// 10. DISCONNECT
// ────────────────────────────────────────────────────────────
document.getElementById('disconnect-btn').addEventListener('click', () => {
    if (!confirm('Disconnect your Pollinations account from this browser?')) return;
    clearStoredKey();
    pollinationsKey = null;
    delete providerKeys.pollinations;
    stopAIPlayer();
    stopBuddy();
    document.getElementById('disconnect-btn').style.display = 'none';
    document.getElementById('auth-overlay').classList.remove('hidden');
    tts.interrupt('Disconnected. Connect your Pollinations account to continue.');
});

// ────────────────────────────────────────────────────────────
// 11. TRAINING DATA (cached)
// ────────────────────────────────────────────────────────────
let _trainingCache = null;
async function loadTrainingData() {
    if (_trainingCache) return _trainingCache;
    let t1 = '', t2 = '', strategy = '', tasKnow = '';
    try { t1 = await (await fetch('./quick-fox-085gw.txt')).text(); } catch {}
    try { t2 = await (await fetch('./brisk-spark-08poq.txt')).text(); } catch {}
    // Speedrun/TAS-informed STRATEGY reference (human-readable knowledge, not inputs)
    try { strategy = await (await fetch('./knowledge/sm64-speedrun-strategy.md')).text(); } catch {}
    // Pre-built digest of the TAS archive (routes/times distilled from .m64 HEADERS
    // only — no input data, can't be replayed). Generated by build-tas-index.mjs.
    try { tasKnow = await (await fetch('./knowledge/tas-knowledge.md')).text(); } catch {}
    _trainingCache = { t1, t2, strategy, tasKnow };
    return _trainingCache;
}

// ────────────────────────────────────────────────────────────
// 12. SCREEN CAPTURE (single persistent video element)
// ────────────────────────────────────────────────────────────
let _captureVideo = null;
let _captureCanvas = null;
let _captureCtx = null;
let _lastFrameHash = null;
let _identicalFrameCount = 0;

async function captureScreen(stream) {
    if (!stream) return null;
    try {
        if (!_captureVideo) {
            _captureVideo = document.createElement('video');
            _captureVideo.muted = true;
            _captureVideo.playsInline = true;
        }
        if (_captureVideo.srcObject !== stream) {
            _captureVideo.srcObject = stream;
            await _captureVideo.play();
            await new Promise(resolve => {
                if (_captureVideo.readyState >= 2) { resolve(); return; }
                _captureVideo.onloadedmetadata = resolve;
            });
        }
        // Force a *freshly presented* frame so the model never reasons about a
        // stale image (the bug where it thinks it's still at the castle entrance).
        // requestVideoFrameCallback fires only when a new frame is composited.
        if (typeof _captureVideo.requestVideoFrameCallback === 'function') {
            await new Promise((resolve) => {
                let settled = false;
                const done = () => { if (!settled) { settled = true; resolve(); } };
                try { _captureVideo.requestVideoFrameCallback(done); } catch { done(); return; }
                setTimeout(done, 200); // safety: never hang if no new frame arrives
            });
        }

        const w = _captureVideo.videoWidth  || 640;
        const h = _captureVideo.videoHeight || 480;
        const targetW = Math.min(w, 1280);
        const targetH = Math.round(h * (targetW / w));

        // Reuse canvas to avoid GC pressure
        if (!_captureCanvas) {
            _captureCanvas = document.createElement('canvas');
            _captureCtx = _captureCanvas.getContext('2d', { alpha: false });
        }
        _captureCanvas.width  = targetW;
        _captureCanvas.height = targetH;
        _captureCtx.drawImage(_captureVideo, 0, 0, targetW, targetH);
        return _captureCanvas.toDataURL('image/jpeg', 0.72);
    } catch (err) {
        console.error('Screen capture error:', err);
        return null;
    }
}

// Load a data URL / URL into an Image element
function _loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

// Objective motion estimate between two frames (0 = identical … 1 = totally
// different), from a downscaled grayscale pixel diff. This gives the AI a
// truthful "did I actually move?" signal WITHOUT relying on the unreliable
// memory reader — the key to making stuck-detection work on vision alone.
let _diffCanvas = null, _diffCtx = null;
async function _frameDiffScore(urlA, urlB) {
    try {
        const [a, b] = await Promise.all([_loadImage(urlA), _loadImage(urlB)]);
        const w = 48, h = 36;
        if (!_diffCanvas) {
            _diffCanvas = document.createElement('canvas');
            _diffCtx = _diffCanvas.getContext('2d', { willReadFrequently: true });
        }
        _diffCanvas.width = w; _diffCanvas.height = h;
        _diffCtx.drawImage(a, 0, 0, w, h);
        const da = _diffCtx.getImageData(0, 0, w, h).data;
        _diffCtx.drawImage(b, 0, 0, w, h);
        const db = _diffCtx.getImageData(0, 0, w, h).data;
        let sum = 0;
        for (let i = 0; i < da.length; i += 4) {
            const ga = (da[i] + da[i + 1] + da[i + 2]) / 3;
            const gb = (db[i] + db[i + 1] + db[i + 2]) / 3;
            sum += Math.abs(ga - gb);
        }
        const meanDiff = sum / (da.length / 4);   // avg gray-level change (0..255)
        return Math.min(1, meanDiff / 64);         // ~25% gray shift ⇒ "lots changed"
    } catch { return null; }
}

// Shared offscreen canvas for frame annotation (nav grid + compass overlay).
let _composeCanvas = null, _composeCtx = null;
// Draw a faint 3×3 navigation grid + camera-relative compass over a frame.
// Vision models localize poorly ("is the door left or ahead?"); explicit anchors
// let the AI say "target is in the TOP-RIGHT cell → turn right, then forward".
function _drawNavGrid(ctx, x, y, w, h) {
    ctx.save();
    // Grid lines
    ctx.strokeStyle = 'rgba(120,220,255,0.30)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
        const gx = x + (w * i) / 3, gy = y + (h * i) / 3;
        ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke();
    }
    // Cell labels (so the model can name where the target is)
    const cells = [['TL', 'T', 'TR'], ['L', 'C', 'R'], ['BL', 'B', 'BR']];
    ctx.font = `bold ${Math.max(10, Math.round(h / 30))}px sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(120,220,255,0.55)';
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        ctx.fillText(cells[r][c], x + (w * c) / 3 + 4, y + (h * r) / 3 + 3);
    }
    // Camera-relative compass: which arrow key moves Mario which way on screen
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(11, Math.round(h / 26))}px sans-serif`;
    const tag = (txt, cx, cy) => {
        const pad = 4, tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(cx - tw / 2 - pad, cy - 10, tw + pad * 2, 20);
        ctx.fillStyle = 'rgba(255,235,120,0.95)';
        ctx.fillText(txt, cx, cy);
    };
    tag('▲ ArrowUp (forward)', x + w / 2, y + 14);
    tag('▼ Down (back)',       x + w / 2, y + h - 14);
    tag('◀ Left',              x + 60,    y + h / 2);
    tag('Right ▶',             x + w - 60, y + h / 2);
    ctx.restore();
}

// Annotate the current frame with the nav grid + compass. This is the ONLY image
// the AI is shown each turn (single-frame perception).
async function annotateCurrentFrame(curUrl) {
    const img = await _loadImage(curUrl);
    const w = img.width || 640, h = img.height || 480;
    if (!_composeCanvas) {
        _composeCanvas = document.createElement('canvas');
        _composeCtx    = _composeCanvas.getContext('2d', { alpha: false });
    }
    _composeCanvas.width = w; _composeCanvas.height = h;
    const ctx = _composeCtx;
    ctx.drawImage(img, 0, 0, w, h);
    _drawNavGrid(ctx, 0, 0, w, h);
    return _composeCanvas.toDataURL('image/jpeg', 0.74);
}

// (Removed: composeComparisonImage / composeFrameStrip — the previous-frame
// comparison view was dropped in favour of single-frame perception. Motion is
// now conveyed to the model as an objective VISUAL CHANGE % in text instead.)

// ── Vision source: capture the game canvas directly (no screen-share popup) ──
// 'canvas' = MediaStream straight off the game <canvas> (default, zero prompts).
// 'screen' = legacy getDisplayMedia screen-share (fallback / multi-window setups).
let _visionSource = (() => { try { return localStorage.getItem('sm64_vision_source') || 'canvas'; } catch { return 'canvas'; } })();
let _canvasStream = null;

function setVisionSource(src) {
    _visionSource = src;
    try { localStorage.setItem('sm64_vision_source', src); } catch {}
}

function getCanvasStream(fps = 5) {
    if (_canvasStream && _canvasStream.active) return _canvasStream;
    try {
        const c = getGameCanvas();
        if (!c || typeof c.captureStream !== 'function') return null;
        _canvasStream = c.captureStream(fps);
        return _canvasStream;
    } catch (err) {
        console.warn('[Vision] canvas.captureStream failed:', err);
        return null;
    }
}

// Acquire a stream for the AI/buddy to "see". Prefers the direct canvas grab so
// the connected model can see the game with no screen-share prompt; falls back
// to screen-share only if canvas capture is unavailable or explicitly chosen.
async function acquireVisionStream(fps = 5) {
    if (_visionSource === 'canvas') {
        const s = getCanvasStream(fps);
        if (s) return s;
        console.warn('[Vision] canvas capture unavailable — falling back to screen share');
    }
    return await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: fps, max: fps * 2 } }, audio: false,
    });
}

// Quick perceptual hash of a data URL — sample every 1KB for robust change detection
function quickHash(dataUrl) {
    if (!dataUrl) return '';
    const step = Math.max(1, Math.floor(dataUrl.length / 16));
    let hash = '';
    for (let i = 0; i < 16; i++) {
        hash += dataUrl.charCodeAt(i * step).toString(36);
    }
    return hash;
}

function isFrameIdentical(dataUrl) {
    const h = quickHash(dataUrl);
    if (h === _lastFrameHash) {
        _identicalFrameCount++;
        return _identicalFrameCount >= IDLE_FRAME_SKIP;
    }
    _lastFrameHash = h;
    _identicalFrameCount = 0;
    return false;
}

// Same idea as isFrameIdentical, but keyed on RAM state — used by memory-only play
let _lastStateHash = null;
let _identicalStateCount = 0;
function isStateIdentical(stateHash) {
    if (stateHash === _lastStateHash) {
        _identicalStateCount++;
        return _identicalStateCount >= IDLE_FRAME_SKIP;
    }
    _lastStateHash = stateHash;
    _identicalStateCount = 0;
    return false;
}

// ────────────────────────────────────────────────────────────
// 13. AI PLAYER STATE & THROTTLING
// ────────────────────────────────────────────────────────────
let aiPlayerActive   = false;
let aiStream         = null;
let aiInterval       = null;
let aiMode           = 'auto';
let aiManualState    = 'idle';
let aiPlannedActions = null;
let aiMemory         = [];
let aiNotes          = [];
let userInstruction  = '';
let gameSpeed        = 1;
let playerMovementDetected = false;

// Throttle / back-off state
let _lastThinkTime   = 0;
let _consecutiveErrors = 0;
let _isThinking      = false;   // prevent concurrent calls

// Temporal context — lets the AI sense motion between decisions
let _prevScreenshot  = null;    // data URL from the previous think
let _prevGameState   = null;    // RAM state from the previous think
let _stuckCount      = 0;       // consecutive near-zero-movement decisions
let _sceneCutCount   = 0;       // consecutive whole-screen changes (demo/cutscene tell)
let _demoConfidence  = 0;       // 0-3: how sure we are this is a demo (requires multiple signals)
let _lastDemoTime    = 0;       // timestamp of last demo warning (prevents spam)
let _lastBootstrapTime = 0;     // timestamp of last auto-start bootstrap (prevents loops)
let _aiGoal          = '';      // persistent multi-turn plan (navigation continuity)
let _aiGoalAge       = 0;       // turns the current goal has been pursued

// Scene history — track what screens we've seen recently to detect loops
let _sceneHistory    = [];      // last N {region, scene, time} entries
const SCENE_HISTORY_MAX = 8;

// Goal persistence — don't let the AI abandon goals too easily
let _goalAbandonCount = 0;      // how many times we've switched goals recently

// ── ACTION QUEUE — schedule inputs with delays between them ──
let _actionQueue     = [];      // [{keys, ms, wait, delayBefore, description}]
let _queueRunning    = false;   // prevent overlapping queue runs

// ── BRAINMAP: the AI's running sense of WHERE it is and WHAT it's done ──
// Persists across turns and is replayed into every prompt so the model stops
// forgetting it already entered the castle / which area it's in.
let _region   = 'unknown';      // outside-castle | castle-foyer | in-level:<name> | unknown
let _regionAge = 0;             // turns spent in the current region
let _camera2d  = false;         // true when AI detects a front-facing / 2D camera angle
let _progressLog = [];          // milestones achieved, newest last ("entered castle", …)
let _checklist = [];            // [{ text, done }] short-term to-do the AI manages
let _brainmapEvents = [];       // visual timeline: [{ t, kind, text }]
let _persistBrainmap = (() => { try { return localStorage.getItem('sm64_persist_brainmap') === '1'; } catch { return false; } })();

function _resetBrainmap() {
    _sceneCutCount = 0;
    // When persistence is ON we KEEP the accumulated map across AI restarts/reloads.
    if (_persistBrainmap) { updateBrainmapViz?.(); return; }
    _region = 'unknown'; _regionAge = 0; _camera2d = false; _progressLog = []; _checklist = []; _brainmapEvents = [];
    updateBrainmapViz?.();
}
function _bmEvent(kind, text) {
    _brainmapEvents.push({ t: Date.now(), kind, text });
    while (_brainmapEvents.length > 60) _brainmapEvents.shift();
}
function saveBrainmap() {
    if (!_persistBrainmap) return;
    try {
        localStorage.setItem('sm64_brainmap', JSON.stringify({
            region: _region, regionAge: _regionAge, progressLog: _progressLog,
            checklist: _checklist, events: _brainmapEvents.slice(-60),
        }));
    } catch {}
}
function loadBrainmap() {
    try {
        const raw = localStorage.getItem('sm64_brainmap');
        if (!raw) return;
        const b = JSON.parse(raw);
        _region = b.region || 'unknown'; _regionAge = b.regionAge || 0;
        _progressLog = Array.isArray(b.progressLog) ? b.progressLog : [];
        _checklist = Array.isArray(b.checklist) ? b.checklist : [];
        _brainmapEvents = Array.isArray(b.events) ? b.events : [];
    } catch {}
}
function setPersistBrainmap(on) {
    _persistBrainmap = !!on;
    try { localStorage.setItem('sm64_persist_brainmap', _persistBrainmap ? '1' : '0'); } catch {}
    if (_persistBrainmap) saveBrainmap(); else { try { localStorage.removeItem('sm64_brainmap'); } catch {} }
}
function clearBrainmap() {
    _region = 'unknown'; _regionAge = 0; _progressLog = []; _checklist = []; _brainmapEvents = [];
    try { localStorage.removeItem('sm64_brainmap'); } catch {}
    updateBrainmapViz();
}

// ── ADAPTIVE BRAIN (experimental) ─────────────────────────────────────
// A genuinely tiny, from-scratch, in-browser reinforcement learner — NO model
// download. It's a contextual bandit / Q-table: it watches (coarse situation →
// action category → did it help) and learns, over the session, which moves tend
// to work where. Each turn it whispers a learned hint to the AI ("forward keeps
// failing here, turning works"). 'improve' bias amplifies what works; 'chaos'
// bias leans into what fails (for fun streams). Off by default — experimental.
let _adaptiveBrain = (() => { try { const v = localStorage.getItem('sm64_adaptive'); return v == null ? true : v === '1'; } catch { return true; } })();
let _brainBias     = (() => { try { return localStorage.getItem('sm64_brain_bias') || 'improve'; } catch { return 'improve'; } })();
// AI grading is OFF by default: in Player-Teach the parent just WATCHES your play
// (heuristic + imitation). Turn it on to ALSO have the LLM grade your moves.
let _aiGrading = (() => { try { return localStorage.getItem('sm64_ai_grading') === '1'; } catch { return false; } })();
function setAiGrading(on) { _aiGrading = !!on; try { localStorage.setItem('sm64_ai_grading', _aiGrading ? '1' : '0'); } catch {} }
// Real-time RL control: hold keys continuously across ticks like a real controller,
// instead of one-shot timed presses. ON by default for RL Play.
let _rlRealtime = (() => { try { const v = localStorage.getItem('sm64_rl_realtime'); return v == null ? true : v === '1'; } catch { return true; } })();
function setRlRealtime(on) { _rlRealtime = !!on; try { localStorage.setItem('sm64_rl_realtime', _rlRealtime ? '1' : '0'); } catch {} }
let _qTable = {};            // stateKey -> { actionCat: { n, mean } }
// PERSISTENCE (experimental, OFF by default): a persisted Q-table is a real saved
// "model" in your browser. When off, learning lives only for the session. When on,
// it survives reloads and can be exported/imported to share a trained child.
let _rlPersist = (() => { try { return localStorage.getItem('sm64_rl_persist') === '1'; } catch { return false; } })();
// Debounced persistence: RL Play updates the model a few times a second, so we
// coalesce writes (≤1 flush / 800ms) instead of stringifying the whole table on
// every step. Flushed on page hide so nothing is lost.
const _lsPending = {}; let _lsTimer = null;
function _lsFlush() { _lsTimer = null; for (const k in _lsPending) { try { localStorage.setItem(k, _lsPending[k]); } catch {} delete _lsPending[k]; } }
function _lsSet(k, v) { if (!_rlPersist) return; _lsPending[k] = v; if (!_lsTimer) _lsTimer = setTimeout(_lsFlush, 800); }
window.addEventListener('beforeunload', _lsFlush);
document.addEventListener('visibilitychange', () => { if (document.hidden) _lsFlush(); });
let _pendingLearn = null;    // { stateKey, actionCat } awaiting its reward
let _prevProgressLen = 0;    // to detect a milestone earned by the last action
let _lastReward = null;          // RL score handed to the previous action (HUD + LLM feedback)
let _lastBrainActionCat = null;  // previous turn's action category (repeat-failure detection)
let _eligTrace = [];             // recent (stateKey, cat) for multi-step credit (chains)
let _lastOpenSide = null;        // 'L' | 'C' | 'R' — depth read of where the path is open
// BEHAVIORAL CLONING — what YOU tend to do per state, so the RL can imitate your play.
let _humanPolicy = (() => { try { return JSON.parse(localStorage.getItem('sm64_human_policy')) || {}; } catch { return {}; } })();
function _saveHumanPolicy() { _lsSet('sm64_human_policy', JSON.stringify(_humanPolicy)); }
function _humanPolicyAdd(stateKey, cat) {
    const s = _humanPolicy[stateKey] || (_humanPolicy[stateKey] = {});
    s[cat] = (s[cat] || 0) + 1; _saveHumanPolicy();
}
function _humanPref(stateKey, cat) {
    let s = _humanPolicy[stateKey];
    if (!s) {   // generalize across regions by the stuck|vis context
        const suffix = stateKey.slice(stateKey.indexOf('|')); const agg = {};
        for (const [k, v] of Object.entries(_humanPolicy)) if (k.endsWith(suffix)) for (const [a, n] of Object.entries(v)) agg[a] = (agg[a] || 0) + n;
        s = agg;
    }
    const tot = Object.values(s).reduce((a, b) => a + b, 0);
    return tot ? (s[cat] || 0) / tot : 0;
}

function _brainState() {
    const region = /in-level/.test(_region) ? 'level' : (_region || 'unknown');
    const stuck = _stuckCount >= 2 ? 'stuck' : _stuckCount >= 1 ? 'slow' : 'moving';
    const vis = _lastVisualPct == null ? 'na' : _lastVisualPct < 8 ? 'none' : _lastVisualPct < 25 ? 'low' : 'high';
    return `${region}|${stuck}|${vis}`;
}
// Classify a set of physical key CODES into one action category. Shared by the
// AI's planned moves AND the human elder's live inputs (WASD mapped to arrows),
// so demonstrations and the model's own moves land in the same buckets.
function _categorizeCodes(codes) {
    const alias = { KeyW: 'ArrowUp', KeyS: 'ArrowDown', KeyA: 'ArrowLeft', KeyD: 'ArrowRight', KeyZ: 'Space' };
    const c = codes.map(x => alias[x] || x);
    const has = k => c.includes(k);
    if (has('ArrowUp') && has('KeyX')) return 'jump-forward';
    if (has('ArrowUp') && has('ArrowLeft'))  return 'forward-left';
    if (has('ArrowUp') && has('ArrowRight')) return 'forward-right';
    if (has('ArrowDown')) return 'backward';
    if (has('ArrowUp')) return 'forward';
    if (has('ArrowLeft') || has('ArrowRight')) return 'turn';
    if (has('KeyX')) return 'jump';
    if (has('KeyC')) return 'action';
    if (has('Space')) return 'crouch';
    return null;
}
// Multi-step COMBOS the RL can learn to deliberately chain (it discovered
// ground_pound by accident — now it's a first-class action it can choose).
const _RL_COMBOS = ['run_jump', 'long_jump', 'ground_pound', 'wall_kick', 'triple_jump', 'dive', 'backflip'];
const _RL_PRIMS  = ['forward', 'backward', 'turn', 'forward-left', 'forward-right', 'jump-forward', 'jump', 'action', 'crouch', 'wait'];
const _RL_ACTIONS = [..._RL_PRIMS, ..._RL_COMBOS];
function _actionCat(actions) {
    // A combo macro is its OWN category, so the RL/LLM learns the whole chain as a unit.
    const mname = _macroName((actions || [])[0]);
    if (mname && _RL_COMBOS.includes(mname)) return mname;
    const g = _expandGroups(actions || [])[0];
    let keys = Array.isArray(g) ? g : (g && (g.keys || g.actions)) || (typeof g === 'string' ? [g] : []);
    keys = Array.isArray(keys) ? keys : [keys];
    if (keys.some(k => k === '_wait' || k === 'wait' || k === 'observe')) return 'wait';
    keys = keys.filter(k => keyMap[k]);
    return _categorizeCodes(keys.map(k => keyMap[k])) || 'other';
}
function _qUpdate(stateKey, actionCat, reward) {
    const s = _qTable[stateKey] || (_qTable[stateKey] = {});
    const a = s[actionCat] || (s[actionCat] = { n: 0, mean: 0 });
    a.n++; a.mean += (reward - a.mean) / a.n;
    _lsSet('sm64_qtable', JSON.stringify(_qTable));
}
// Reward (or PUNISH) the PREVIOUS action using the outcome we can now measure.
// This is the core of the RL loop: did the last move help, do nothing, or hurt?
function _brainLearn() {
    if (!_adaptiveBrain || !_pendingLearn) return;
    const p = _pendingLearn;
    let r = 0;
    // Real, visible travel is good — UNLESS the WHOLE screen flipped, which is
    // almost always a DEATH / level-exit / demo cut rather than progress. A "wait"
    // legitimately produces little screen change, so it isn't punished for that.
    if (_lastVisualPct != null) {
        if (_sceneCutCount >= 1)         r -= 0.4;                   // uncaused scene cut ≈ death
        else if (p.actionCat === 'wait') r += 0.05;                 // patience is mildly fine
        else                             r += Math.min(0.6, _lastVisualPct / 100); // genuine travel
    }
    if (_stuckCount >= 2 && p.actionCat !== 'wait') {
        r -= 0.5;                                                    // wedged = bad
        if (p.actionCat === _lastBrainActionCat) r -= 0.3;          // repeating the SAME failing move = worse
    }
    if (_progressLog.length > _prevProgressLen) r += 0.9;           // a milestone = the jackpot
    // AI-TEACH BONUS: when the parent is deliberately demonstrating, boost
    // the teaching signal so the child learns faster from clean examples.
    if (_playMode === 'ai-teach' && r > 0) r += 0.2;
    r = Math.max(-1.2, Math.min(1.5, r));
    _qUpdate(p.stateKey, p.actionCat, r);
    // ELIGIBILITY TRACE — credit the few PRIOR actions with a decayed share of a
    // SIGNIFICANT outcome, so the RL learns multi-step CHAINS (the actions that set
    // up a good result, e.g. jump→crouch, gain value too). Only for big outcomes so
    // routine little rewards don't smear.
    if (Math.abs(r) >= 0.3) {
        let decay = 0.5;
        for (let i = _eligTrace.length - 1; i >= 0 && i >= _eligTrace.length - 3; i--) {
            _qUpdate(_eligTrace[i].stateKey, _eligTrace[i].cat, r * decay);
            decay *= 0.5;
        }
    }
    _eligTrace.push({ stateKey: p.stateKey, cat: p.actionCat });
    while (_eligTrace.length > 4) _eligTrace.shift();
    _lastReward = r;
    _lastBrainActionCat = p.actionCat;
    // The child grows up by proving itself. When IT took the step, its result
    // moves trust the most; even while just watching, consistent good/bad calls
    // nudge trust a little. This is the "parent grading the child" feedback.
    if (p.wasOverride) {
        if (r >= 0.25)      _trainStats.overrideGood = (_trainStats.overrideGood || 0) + 1;
        else if (r <= -0.25) _trainStats.overrideBad  = (_trainStats.overrideBad  || 0) + 1;
        _setChildTrust(_childTrust + (r >= 0.25 ? 0.04 : r <= -0.25 ? -0.05 : 0));
    } else {
        _setChildTrust(_childTrust + (r >= 0.4 ? 0.01 : r <= -0.4 ? -0.01 : 0));
    }
    _pendingLearn = null;
    _prevProgressLen = _progressLog.length;
    _trainStats.turns++;          // one more scored experience banked
    _saveTrainStats();
}
function _brainHint(stateKey) {
    if (!_adaptiveBrain) return '';
    const s = _qTable[stateKey];
    if (!s) return '';
    const entries = Object.entries(s).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].mean - a[1].mean);
    if (!entries.length) return '';
    const best = entries[0], worst = entries[entries.length - 1];
    if (_brainBias === 'chaos') {
        return `\n\n📊 ADAPTIVE BRAIN (CHAOS mode — embrace the jank): here, "${worst[0]}" has been failing; lean into chaotic/unconventional moves for the stream.`;
    }
    let h = `\n\n📊 YOUR APPRENTICE (a from-scratch learner with NO game knowledge — it only watches your inputs and what they do to Mario) reports: in situations like this, "${best[0]}" has worked best so far (avg ${best[1].mean.toFixed(2)} over ${best[1].n} tries). You know the game — weigh its observation.`;
    if (entries.length > 1 && worst[1].mean < 0) {
        h += ` It has watched "${worst[0]}" FAIL here repeatedly (avg ${worst[1].mean.toFixed(2)}) — probably avoid it.`;
    }
    // Exploration: if nothing tried here is actually working, nudge toward an
    // untried category (this is how it discovers e.g. "wait" beats "jump" on a lift).
    if (best[1].mean < 0.1) {
        const tried = new Set(entries.map(e => e[0]));
        const cand = ['forward', 'backward', 'turn', 'jump-forward', 'wait'].filter(c => !tried.has(c));
        if (cand.length) h += ` It hasn't seen anything work here yet — maybe try something it hasn't, like "${cand[0]}".`;
    }
    return h;
}
function setAdaptiveBrain(on) {
    _adaptiveBrain = !!on;
    try { localStorage.setItem('sm64_adaptive', _adaptiveBrain ? '1' : '0'); } catch {}
}
function setBrainBias(b) {
    _brainBias = (b === 'chaos') ? 'chaos' : 'improve';
    try { localStorage.setItem('sm64_brain_bias', _brainBias); } catch {}
}
// On boot, load the saved model ONLY if persistence is enabled; otherwise start
// fresh (session-only learning) and don't let stale storage leak in.
function loadQTable() {
    if (!_rlPersist) {   // session-only: start fresh, ignore any stale storage
        _qTable = {}; _humanPolicy = {}; _childTrust = 0.15;
        _trainStats = { episodes: 0, turns: 0, overrides: 0, overrideGood: 0, overrideBad: 0, taught: 0, graded: 0, rated: 0, bestRegionRank: 0 };
        return;
    }
    try { _qTable = JSON.parse(localStorage.getItem('sm64_qtable')) || {}; } catch { _qTable = {}; }
    try { _humanPolicy = JSON.parse(localStorage.getItem('sm64_human_policy')) || {}; } catch { _humanPolicy = {}; }
}
function clearQTable() {
    _qTable = {}; _humanPolicy = {}; _eligTrace = [];
    ['sm64_qtable', 'sm64_human_policy'].forEach(k => { try { localStorage.removeItem(k); } catch {} });
    _trainStats = { episodes: 0, turns: 0, overrides: 0, overrideGood: 0, overrideBad: 0, taught: 0, graded: 0, rated: 0, bestRegionRank: 0 }; _saveTrainStats();
    if (typeof _setChildTrust === 'function') _setChildTrust(0.15);   // back to a fresh, untrusted child
}
function setRlPersist(on) {
    _rlPersist = !!on;
    try { localStorage.setItem('sm64_rl_persist', _rlPersist ? '1' : '0'); } catch {}
    if (_rlPersist) {   // turning it ON: snapshot the current in-memory model so it survives reloads
        _lsSet('sm64_qtable', JSON.stringify(_qTable));
        _lsSet('sm64_human_policy', JSON.stringify(_humanPolicy));
        _lsSet('sm64_trainstats', JSON.stringify(_trainStats));
        _lsSet('sm64_child_trust', String(_childTrust));
    } else {            // OFF: drop the stored model so it doesn't linger
        ['sm64_qtable', 'sm64_human_policy', 'sm64_trainstats', 'sm64_child_trust'].forEach(k => { try { localStorage.removeItem(k); } catch {} });
    }
}
// Export the trained "model" to a JSON file others can import.
function exportRlModel() {
    const blob = new Blob([JSON.stringify({ v: 1, qTable: _qTable, humanPolicy: _humanPolicy, trust: _childTrust, stats: _trainStats }, null, 0)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `sm64-rl-model-${Date.now()}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importRlModel(file) {
    const r = new FileReader();
    r.onload = () => {
        try {
            const m = JSON.parse(r.result);
            _qTable = m.qTable || {}; _humanPolicy = m.humanPolicy || {};
            if (Number.isFinite(m.trust)) _childTrust = m.trust;
            if (m.stats) _trainStats = Object.assign(_trainStats, m.stats);
            if (_rlPersist) { _lsSet('sm64_qtable', JSON.stringify(_qTable)); _lsSet('sm64_human_policy', JSON.stringify(_humanPolicy)); }
            updateAIStatus(`📥 Imported model — ${Object.keys(_qTable).length} states`); updateDebugHUD();
        } catch (e) { updateAIStatus('⚠ Bad model file'); }
    };
    r.readAsText(file);
}
window.sm64Brain = (on) => setAdaptiveBrain(on);
window.sm64Export = exportRlModel;

// ── SELF-TRAINING STATS — the child (RL) growing up across sessions ──────
// Cumulative across reloads (the whole point: it accumulates experience).
let _trainStats = (() => { try { return JSON.parse(localStorage.getItem('sm64_trainstats')) || {}; } catch { return {}; } })();
_trainStats.episodes ??= 0; _trainStats.turns ??= 0; _trainStats.overrides ??= 0; _trainStats.bestRegionRank ??= 0;
function _saveTrainStats() { _lsSet('sm64_trainstats', JSON.stringify(_trainStats)); }
const _REGION_RANK = { unknown: 0, title: 0, demo: 0, 'outside-castle': 1, 'castle-foyer': 2 };
function _regionRank(r) { return /in-level/.test(r || '') ? 3 : (_REGION_RANK[r] ?? 0); }

// ── APPRENTICE STEP-IN — the child (RL) assists the parent (LLM) ──────────
// Roles: the PARENT (text LLM) knows the game but fumbles the loose controls; the
// CHILD (RL) started empty and has learned, purely by watching inputs→results,
// which moves actually work mechanically. The child DEFERS to the knowledgeable
// parent — it only steps in when the parent is visibly STUCK and the child has
// SOLID evidence (≥2 samples each) that the parent's pick keeps failing here while
// another move works. Early on (no experience) it never fires. Toggleable.
let _brainAssistControl = (() => { try { const v = localStorage.getItem('sm64_brain_assist'); return v == null ? true : v === '1'; } catch { return true; } })();
function setBrainAssist(on) { _brainAssistControl = !!on; try { localStorage.setItem('sm64_brain_assist', _brainAssistControl ? '1' : '0'); } catch {} }
window.sm64BrainAssist = (on) => setBrainAssist(on);

// TRUST (0..1) — how grown-up the parent considers the child. The parent (LLM)
// sets it via child_trust, and it auto-drifts with the child's measured results.
// Trust is the dial that decides how OFTEN the child gets to take the controller.
let _childTrust = (() => { try { const v = parseFloat(localStorage.getItem('sm64_child_trust')); return Number.isFinite(v) ? v : 0.15; } catch { return 0.15; } })();
function _saveChildTrust() { _lsSet('sm64_child_trust', String(_childTrust)); }
function _setChildTrust(t) { _childTrust = Math.max(0, Math.min(1, t)); _saveChildTrust(); }
window.sm64Trust = (t) => { if (t != null) _setChildTrust(t > 1 ? t / 100 : t); return _childTrust; };

// ── ELDER MODE — learn from the HUMAN'S manual play (demonstration) ───────
// The human is the elder. When YOU take the controls, the child WATCHES: it banks
// what your inputs do to Mario as positive demonstrations, the way a kid learns by
// watching a grown-up actually play. Show it a level by hand and it grows up
// faster, then the parent can lean on it. Needs the AI player ON (for the vision
// stream) but paused because you're driving. Gated by _elderLearn.
let _elderLearn = (() => { try { const v = localStorage.getItem('sm64_elder_learn'); return v == null ? true : v === '1'; } catch { return true; } })();
function setElderLearn(on) { _elderLearn = !!on; try { localStorage.setItem('sm64_elder_learn', _elderLearn ? '1' : '0'); } catch {} }
let _elderLoop = null, _elderPrevFrame = null, _lastTaughtCat = null;
// Grading window: we accumulate the moves you make over a few seconds, then the
// parent LLM grades the WINDOW (anchor frame → now). This is robust to tappy play —
// it no longer needs you to be holding a key at the exact throttle tick.
let _gradeAnchor = null, _gradeCats = [], _gradeInputs = '';
let _gradeBusy = false;
function _modeOf(arr) {
    const c = {}; let best = arr[0], bestN = 0;
    for (const a of arr) { c[a] = (c[a] || 0) + 1; if (c[a] > bestN) { bestN = c[a]; best = a; } }
    return best;
}
function startElderWatch() {
    if (_elderLoop) return;
    _gradeAnchor = null; _gradeCats = []; _gradeInputs = ''; _lastGradeTime = 0;
    _elderLoop = setInterval(async () => {
        // Only learns from your play in Player-Teach mode (and never during a show-off).
        if (!_adaptiveBrain || !_elderLearn || !aiPlayerActive || _playMode !== 'player-teach' || _showoffRunning) {
            _elderPrevFrame = null; return;
        }
        const ss = await captureScreen(aiStream).catch(() => null);
        if (!ss) return;
        const cat = playerMovementDetected ? _categorizeCodes([...playerInputs]) : null;

        if (cat) {
            // Fast heuristic teaching signal each tick you move (movement = positive demo).
            if (_elderPrevFrame) {
                const vm = await _frameDiffScore(_elderPrevFrame, ss);
                if (vm != null) {
                    _qUpdate(_brainState(), cat, Math.max(0.12, Math.min(0.8, vm * 1.2)));
                    _trainStats.taught = (_trainStats.taught || 0) + 1; _saveTrainStats();
                    _setChildTrust(_childTrust + 0.004);
                    _lastTaughtCat = cat;
                }
            }
            _humanPolicyAdd(_brainState(), cat);   // behavioral cloning: learn what YOU do here
            // Accumulate this move into the current grading window.
            _gradeCats.push(cat);
            _gradeInputs = _inputsToText([...playerInputs]);
            if (!_gradeAnchor) _gradeAnchor = _elderPrevFrame || ss;
        }
        _elderPrevFrame = ss;

        // OPT-IN LLM grading (off by default — it just watches otherwise). On cadence,
        // if you've moved this window, the parent grades the dominant move (anchor → now).
        if (_aiGrading && !_gradeBusy && _gradeAnchor && _gradeAnchor !== ss && _gradeCats.length && Date.now() - _lastGradeTime > 3500) {
            _lastGradeTime = Date.now();
            const domCat = _modeOf(_gradeCats);
            const anchor = _gradeAnchor, after = ss, inputs = _gradeInputs || domCat;
            _gradeAnchor = ss; _gradeCats = []; _gradeInputs = '';
            _gradeBusy = true;
            updateAIStatus('👨‍🏫 parent is grading your play…');
            _gradeHumanMove(anchor, after, domCat, _brainState(), inputs).finally(() => { _gradeBusy = false; });
        }
        updateDebugHUD();
    }, 700);
}
function stopElderWatch() {
    if (_elderLoop) { clearInterval(_elderLoop); _elderLoop = null; }
    _elderPrevFrame = null; _gradeAnchor = null; _gradeCats = []; _gradeBusy = false;
}
// Power-user: hand-grade the human's most recent demonstrated move from the console.
window.sm64Teach = (reward = 0.6) => { if (_lastTaughtCat) _qUpdate(_brainState(), _lastTaughtCat, Math.max(-1, Math.min(1.5, reward))); return _lastTaughtCat; };
let _lastGradeTime = 0;

// ── PLAY MODES ────────────────────────────────────────────────────────────
//   ai           — the parent LLM plays (the child may step in when trusted)
//   rl           — the child (RL) plays entirely on its own, NO LLM (free)
//   player-teach — YOU play; the parent LLM auto-grades YOUR moves so the child
//                  learns what you do right/wrong. (Manual rating is NOT for your
//                  play — it's for when the RL shows off, below.)
//   ai-teach     — the parent LLM plays and teaches the child; it never takes over
//                  (clean demonstration signal).
let _playMode = (() => { try { return localStorage.getItem('sm64_play_mode') || 'ai'; } catch { return 'ai'; } })();
function _playModeLabel(m) {
    return { ai: '🤖 AI Play', rl: '🧒 RL Play', 'player-teach': '🧓 Player Teach', 'ai-teach': '👨‍🏫 AI Teach' }[m] || '🤖 AI Play';
}
function setPlayMode(m) {
    if (!['ai', 'rl', 'player-teach', 'ai-teach'].includes(m)) m = 'ai';
    _playMode = m;
    try { localStorage.setItem('sm64_play_mode', m); } catch {}
    const sel = document.getElementById('play-mode'); if (sel) sel.value = m;
    if (!aiPlayerActive) { const b = document.getElementById('ai-player-btn'); if (b) b.textContent = '▶ Start'; }
    updateAIStatus(`Mode: ${_playModeLabel(m)} — press the play button to start`);
}
window.sm64Mode = (m) => { if (m) setPlayMode(m); return _playMode; };

// ── RL SOLO CONTROL — the child plays with no LLM, off its learned Q-table ──
// State generalizes across regions (it borrows stats from same stuck|vis context),
// so a child taught in one spot can act in another. Epsilon-greedy exploration.
function _aggregateBySuffix(suffix) {
    const agg = {};
    for (const [k, acts] of Object.entries(_qTable)) {
        if (!k.endsWith(suffix)) continue;
        for (const [a, v] of Object.entries(acts)) {
            const g = agg[a] || (agg[a] = { n: 0, mean: 0 });
            const tot = g.n + v.n; g.mean = (g.mean * g.n + v.mean * v.n) / (tot || 1); g.n = tot;
        }
    }
    return agg;
}
function _rlPickAction(stateKey) {
    let s = _qTable[stateKey];
    if (!s || Object.keys(s).length < 2) {
        const agg = _aggregateBySuffix(stateKey.slice(stateKey.indexOf('|')));
        if (Object.keys(agg).length) s = agg;
    }
    s = s || {};
    const total = Object.values(s).reduce((a, b) => a + (b.n || 0), 0) || 1;
    // Exploration shrinks as the child grows up (more trusted → exploit more).
    const eps = Math.max(0.06, 0.28 - _childTrust * 0.15);
    if (Math.random() < eps) {
        // Bias random exploration toward what YOU demonstrated here, else something untried.
        const human = _humanPolicy[stateKey] ? Object.keys(_humanPolicy[stateKey]) : [];
        const untried = _RL_ACTIONS.filter(a => !(s[a] && s[a].n));
        const pool = (human.length && Math.random() < 0.5) ? human
                   : (untried.length ? untried : _RL_ACTIONS);
        return pool[Math.floor(Math.random() * pool.length)];
    }
    // UCB value + behavioral-cloning prior, across ALL actions (primitives + combos).
    let best = 'forward', bestSc = -1e9;
    for (const a of _RL_ACTIONS) {
        const v = s[a]; const mean = v ? v.mean : 0; const n = v ? v.n : 0;
        const ucb  = 0.5 * Math.sqrt(Math.log(total + 1) / (n + 1));   // try under-sampled actions
        const imit = 0.6 * _humanPref(stateKey, a);                    // imitate how YOU play here
        const sc = mean + ucb + imit + (n === 0 ? 0.05 : 0);
        if (sc > bestSc) { bestSc = sc; best = a; }
    }
    return best;
}
async function rlThinkAndAct() {
    if (!aiPlayerActive || _busyCycle || _showoffRunning) return;
    _busyCycle = true;
    try {
        const ss = await captureScreen(aiStream).catch(() => null);
        if (!ss) return;
        if (_prevScreenshot) {
            const vm = await _frameDiffScore(_prevScreenshot, ss);
            if (vm != null) { _lastVisualPct = Math.round(vm * 100); if (vm < 0.05) _stuckCount++; else _stuckCount = 0; }
        }
        await _depthAnalyze(ss);               // refresh _lastOpenSide so it steers toward openings
        _brainLearn();                         // reward the previous RL move
        const stateKey = _brainState();
        const cat = _rlPickAction(stateKey);
        _pendingLearn = { stateKey, actionCat: cat, wasOverride: false };
        _pushShowoff(stateKey, cat);
        _prevScreenshot = ss;
        updateAIStatus(`🧒 RL plays on its own: ${cat}  ·  ${stateKey}`);
        await aiExecute({ actions: _catToAction(cat, true) || [{ keys: ['ArrowUp'], hold_ms: 520 }] });
        updateDebugHUD();
    } finally { _busyCycle = false; }
}
function scheduleRLLoop() {
    if (aiInterval) { clearInterval(aiInterval); aiInterval = null; }
    if (_rlRealtime) { startRealtimeRL(); return; }   // continuous raw-controller mode
    // Discrete fallback — fast cadence, _busyCycle paces it to the action length.
    const cycle = Math.max(120, 300 / gameSpeed);
    aiInterval = setInterval(() => { if (aiPlayerActive && !_busyCycle && !_showoffRunning) rlThinkAndAct(); }, cycle);
}

// ── REAL-TIME RL CONTROL — raw controller, not timed one-shot presses ────────
// The RL HOLDS keys across ticks (true keydown held, keyup only when the choice
// changes), so Mario runs continuously and the model can layer a jump/dive on top
// of held movement — exactly like a human on the pad. Combos (ground_pound,
// wall-kick…) emerge naturally from the per-tick stream + eligibility credit.
let _rtLoop = null, _rtPrevFrame = null, _rlHeld = new Set();
function _rlKeyEv(type, code) {
    const o = { code, key: code, bubbles: true, cancelable: true };
    getGameCanvas().dispatchEvent(new KeyboardEvent(type, o));
    document.dispatchEvent(new KeyboardEvent(type, o));
}
function _rlSetHeld(desiredCodes) {
    const desired = new Set(desiredCodes);
    for (const code of _rlHeld) if (!desired.has(code)) { _rlKeyEv('keyup', code); _rlHeld.delete(code); }
    for (const code of desired) if (!_rlHeld.has(code)) { _rlKeyEv('keydown', code); _rlHeld.add(code); }
}
function _rlReleaseAll() { for (const code of _rlHeld) _rlKeyEv('keyup', code); _rlHeld.clear(); }
// Map an action category to the SET of key codes to hold this tick.
function _catToHeld(cat) {
    const turnKey = _lastOpenSide === 'L' ? 'ArrowLeft' : _lastOpenSide === 'R' ? 'ArrowRight'
                  : ((_turnFlip = !_turnFlip), _turnFlip ? 'ArrowLeft' : 'ArrowRight');
    switch (cat) {
        case 'forward':       return ['ArrowUp'];
        case 'backward':      return ['ArrowDown'];
        case 'turn':          return [turnKey];
        case 'forward-left':  return ['ArrowUp', 'ArrowLeft'];
        case 'forward-right': return ['ArrowUp', 'ArrowRight'];
        case 'jump-forward':  return ['ArrowUp', 'KeyX'];
        case 'jump':          return ['KeyX'];
        case 'action':        return ['ArrowUp', 'KeyC'];   // dive/grab needs forward motion
        case 'crouch':        return ['Space'];
        case 'wait':          return [];
        case 'run_jump':      return ['ArrowUp', 'KeyX'];
        case 'long_jump':     return ['ArrowUp', 'Space', 'KeyX'];
        case 'ground_pound':  return ['Space'];             // Z in air = pound
        case 'wall_kick':     return ['ArrowUp', 'KeyX'];
        case 'triple_jump':   return ['ArrowUp', 'KeyX'];
        case 'dive':          return ['ArrowUp', 'KeyC'];
        case 'backflip':      return ['ArrowDown', 'KeyX'];
        default:              return ['ArrowUp'];
    }
}
function startRealtimeRL() {
    if (_rtLoop) return;
    _rlHeld = new Set(); _rtPrevFrame = null;
    let busy = false;
    _rtLoop = setInterval(async () => {
        if (!aiPlayerActive || _playMode !== 'rl' || _showoffRunning || busy) return;
        busy = true;
        try {
            const ss = await captureScreen(aiStream).catch(() => null);
            if (!ss) return;
            if (_rtPrevFrame) {
                const vm = await _frameDiffScore(_rtPrevFrame, ss);
                if (vm != null) { _lastVisualPct = Math.round(vm * 100); if (vm < 0.04) _stuckCount++; else _stuckCount = 0; }
            }
            await _depthAnalyze(ss);
            _brainLearn();                          // reward the action held last tick
            const stateKey = _brainState();
            const cat = _rlPickAction(stateKey);
            _pendingLearn = { stateKey, actionCat: cat, wasOverride: false };
            _pushShowoff(stateKey, cat);
            _rtPrevFrame = ss;
            _rlSetHeld(_catToHeld(cat));            // HOLD this combo (continuous control)
            updateAIStatus(`🧒 RL (real-time): holding ${cat}  ·  ${stateKey}`);
            updateDebugHUD();
        } finally { busy = false; }
    }, Math.max(150, 230 / gameSpeed));
}
function stopRealtimeRL() { if (_rtLoop) { clearInterval(_rtLoop); _rtLoop = null; } _rlReleaseAll(); _rtPrevFrame = null; }

// ── RL SHOW-OFF — the child takes temporary full control to demonstrate, then
// YOU manually rate that run (👍/👎). This is the ONLY place manual rating
// applies — it rates the RL, not your teaching.
let _showoffRunning = false;
let _showoffBuffer = [];   // [{stateKey, cat}] from the current show-off
function _pushShowoff(stateKey, cat) { _showoffBuffer.push({ stateKey, cat }); while (_showoffBuffer.length > 14) _showoffBuffer.shift(); }
function _rateShowoff(reward) {
    const r = Math.max(-1, Math.min(1.5, reward));
    // LIVE rating: the most recent moves get the strongest credit (you're reacting to
    // what JUST happened), decaying back through the last few.
    const buf = _showoffBuffer; let w = 1, applied = 0;
    for (let i = buf.length - 1; i >= 0 && i >= buf.length - 6; i--) { _qUpdate(buf[i].stateKey, buf[i].cat, r * w); w *= 0.7; applied++; }
    _trainStats.rated = (_trainStats.rated || 0) + 1; _saveTrainStats();
    _setChildTrust(_childTrust + (r >= 0.25 ? 0.05 : r <= -0.25 ? -0.06 : 0));
    if (typeof pushChatlog === 'function')
        pushChatlog(`<span class="cl-cmd">${r >= 0 ? '👍' : '👎'} ${_playMode === 'rl' ? 'live rating' : 'rated run'} ${r.toFixed(1)} — credited last ${applied} move(s)</span>`, 'cl-tool');
    _showoffBuffer = [];   // fresh window after each rating
    updateDebugHUD();
}
async function rlShowoff(steps = 5) {
    if (_showoffRunning || !aiPlayerActive) return;
    _showoffRunning = true; _showoffBuffer = [];
    _showElderBanner(false); _showRatingWidget(false);
    updateAIStatus('🎬 RL is showing off — watch, then rate it 👍/👎');
    for (let i = 0; i < steps && aiPlayerActive; i++) {
        const ss = await captureScreen(aiStream).catch(() => null);
        if (ss) {
            if (_prevScreenshot) { const vm = await _frameDiffScore(_prevScreenshot, ss); if (vm != null) { _lastVisualPct = Math.round(vm * 100); if (vm < 0.05) _stuckCount++; else _stuckCount = 0; } }
            _prevScreenshot = ss;
        }
        _brainLearn();
        const stateKey = _brainState(); const cat = _rlPickAction(stateKey);
        _pendingLearn = { stateKey, actionCat: cat, wasOverride: false }; _pushShowoff(stateKey, cat);
        await aiExecute({ actions: _catToAction(cat, true) || [{ keys: ['ArrowUp'], hold_ms: 520 }] });
        updateDebugHUD();
    }
    _showoffRunning = false;
    _showRatingWidget(true);                       // ask YOU to rate the RL's run
    if (_playMode === 'player-teach') { /* banner returns after rating */ }
}
window.sm64Showoff = (n) => rlShowoff(n || 5);

// Floating manual-rating widget (👍 / 👎 / skip) — created lazily, no HTML needed.
function _ensureRatingWidget() {
    let w = document.getElementById('rl-rating');
    if (!w) {
        w = document.createElement('div'); w.id = 'rl-rating';
        w.style.cssText = 'position:fixed;bottom:84px;left:50%;transform:translateX(-50%);z-index:9999;display:none;gap:8px;align-items:center;background:#161b26;border:1px solid #2a3344;padding:8px 12px;border-radius:24px;box-shadow:0 4px 16px rgba(0,0,0,.5);font:600 13px system-ui;color:#e6e9ef';
        w.innerHTML = `<span id="rl-rate-label">Rate the RL's run:</span>
            <button id="rl-rate-up"   style="cursor:pointer;border:0;background:#19c37d;color:#042;border-radius:14px;padding:5px 11px;font-weight:700">👍 Good</button>
            <button id="rl-rate-down" style="cursor:pointer;border:0;background:#e3556e;color:#fff;border-radius:14px;padding:5px 11px;font-weight:700">👎 Bad</button>
            <button id="rl-rate-skip" style="cursor:pointer;border:0;background:#333a4a;color:#aab;border-radius:14px;padding:5px 9px">skip</button>`;
        document.body.appendChild(w);
        w.querySelector('#rl-rate-up').onclick   = () => { _rateShowoff(0.85);  _afterRate(); };
        w.querySelector('#rl-rate-down').onclick = () => { _rateShowoff(-0.7);  _afterRate(); };
        w.querySelector('#rl-rate-skip').onclick = () => { _showoffBuffer = []; _afterRate(); };
    }
    return w;
}
function _afterRate() { _showRatingWidget(_playMode === 'rl'); if (_playMode === 'player-teach') _showElderBanner(true); }
function _showRatingWidget(on) {
    const w = _ensureRatingWidget();
    const lbl = w.querySelector('#rl-rate-label');
    if (lbl) lbl.textContent = _playMode === 'rl' ? '🔴 Live feedback — is it doing better/worse?' : "Rate the RL's run:";
    w.style.display = on ? 'flex' : 'none';
}

// Player-Teach banner (with a "let RL show off" button), created lazily.
function _showElderBanner(on) {
    let b = document.getElementById('elder-banner');
    if (on) {
        if (!b) {
            b = document.createElement('div'); b.id = 'elder-banner';
            b.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9998;background:#15303a;color:#cfe;border:1px solid #4fd1e0;padding:6px 14px;border-radius:20px;font:600 13px system-ui;box-shadow:0 2px 12px rgba(0,0,0,.4)';
            document.body.appendChild(b);
        }
        b.innerHTML = '🧓 Player-Teach: <b>play the game</b> — the child watches & learns from you. <button id="elder-showoff" style="margin-left:8px;cursor:pointer;border:0;background:#4fd1e0;color:#042;border-radius:12px;padding:3px 9px;font-weight:700">🎬 Let RL show off</button>';
        b.style.display = 'block';
        const sb = b.querySelector('#elder-showoff'); if (sb) sb.onclick = () => rlShowoff(5);
    } else if (b) { b.style.display = 'none'; }
}

// Render the literal keys the human held into friendly text, so the grader sees
// exactly what inputs I did — not just the move category.
function _inputsToText(codes) {
    const m = { ArrowUp: '↑ forward', ArrowDown: '↓ backward', ArrowLeft: '← left', ArrowRight: '→ right',
        KeyW: '↑ forward', KeyS: '↓ backward', KeyA: '← left', KeyD: '→ right',
        KeyX: 'X (jump/A)', KeyC: 'C (dive·punch/B)', Space: 'Z (crouch·ground-pound)', KeyZ: 'Z', Enter: 'Start' };
    return codes.map(c => m[c] || c).join(' + ') || '(nothing)';
}
// The parent LLM grades a single move from BEFORE→AFTER frames + the EXACT inputs I
// pressed. Controls are spelled out so the parent understands what the move did.
async function _llmGradeMove(before, after, cat, inputStr, ctx) {
    const sys = `You grade ONE move in Super Mario 64 to train a learner. CONTROLS: ↑=FORWARD, ↓=BACKWARD, ←/→=turn, X=jump(A), C=dive/punch/grab(B), Z/Space=crouch/ground-pound.
${ctx ? 'CONTEXT: ' + ctx + '\n' : ''}You see a BEFORE frame then an AFTER frame. The player pressed [${inputStr}] (type "${cat}").
Grade the RESULT — compare AFTER to BEFORE — for PROGRESS toward the objective, and be GENEROUS:
- GOOD (+0.3..+1.0): reached new ground, moved toward a door/painting/star/platform/exit, climbed, gained height, or lined up a needed jump. A jump over a gap or a move that LOOKS risky mid-air is still GOOD if AFTER shows it advanced or is on track. Getting CLOSER to success is always GOOD.
- BAD (−0.3..−1.0): ONLY for a clear mistake VISIBLE IN AFTER — rammed a wall and stopped, fell into a pit/lava/water by mistake, clearly went backward away from the goal, or is stuck/looping.
- ~0 if little changed or ambiguous.
Do NOT punish a move for looking risky/mid-action — judge only the outcome in AFTER. Reply EXACTLY one line: "GRADE: <number -1.0..1.0>, <≤6 word reason>".`;
    const content = [
        { type: 'text', text: `BEFORE then AFTER. Pressed [${inputStr}] (${cat}). Grade the PROGRESS in AFTER.` },
        { type: 'image_url', image_url: { url: before } },
        { type: 'image_url', image_url: { url: after } },
    ];
    const ans = ((await callChatAPI([{ role: 'system', content: sys }, { role: 'user', content }], { max_tokens: 40 })) || '').trim();
    recordUsage();
    const m = ans.match(/-?\d*\.?\d+/);
    if (!m) return null;
    const g = parseFloat(m[0]);
    return Number.isFinite(g) ? Math.max(-1, Math.min(1.2, g)) : null;
}
async function _gradeHumanMove(before, after, cat, stateKey, inputStr) {
    try {
        const ctx = `Mario is in: ${_region}.${_aiGoal ? ' Apparent goal: ' + _aiGoal + '.' : ''}`;
        const g = await _llmGradeMove(before, after, cat, inputStr, ctx);
        if (g != null) {
            _qUpdate(stateKey, cat, g);
            _trainStats.graded = (_trainStats.graded || 0) + 1; _saveTrainStats();
            if (typeof pushChatlog === 'function')
                pushChatlog(`<span class="cl-cmd">👨‍🏫 parent graded your "${_esc(cat)}" [${_esc(inputStr)}]: ${g.toFixed(2)} (${g >= 0.2 ? 'good 👍' : g <= -0.2 ? 'bad 👎' : 'meh'})</span>`, 'cl-tool');
            updateAIStatus(`👨‍🏫 graded your "${cat}": ${g.toFixed(2)} ${g >= 0.2 ? 'good' : g <= -0.2 ? 'bad' : 'meh'}`);
            updateDebugHUD();
        } else if (typeof pushChatlog === 'function') {
            pushChatlog(`<span class="cl-cmd">⚠ parent couldn't grade that move (no clear verdict) — will retry next window</span>`, 'cl-tool');
        }
    } catch (err) {
        updateAIStatus(`⚠ grading failed: ${err.message}`);
        if (typeof pushChatlog === 'function')
            pushChatlog(`<span class="cl-cmd">⚠ grading call failed: ${_esc(err.message || 'error')}</span>`, 'cl-tool');
    }
}

let _turnFlip = false;   // alternate override turn direction so it can't spin one way forever
// Map a learned action CATEGORY back to one concrete, sane move group. `fast` uses
// short, reactive holds for RL solo play (the child plays at a quick, human-like
// cadence since it's local + free); normal holds are for the LLM-paced override.
function _catToAction(cat, fast = false) {
    const fwd = fast ? 520 : 1500, turn = fast ? 240 : 400, back = fast ? 420 : 700;
    switch (cat) {
        case 'forward':      return [{ keys: ['ArrowUp'], hold_ms: fwd }];
        case 'forward-left': return [{ keys: ['ArrowUp', 'ArrowLeft'], hold_ms: fwd }];
        case 'forward-right':return [{ keys: ['ArrowUp', 'ArrowRight'], hold_ms: fwd }];
        case 'backward':     return [{ keys: ['ArrowDown'], hold_ms: back }];
        case 'turn': {
            // Turn toward the side depth says is OPEN; else alternate so it can't spin.
            const k = _lastOpenSide === 'L' ? 'ArrowLeft' : _lastOpenSide === 'R' ? 'ArrowRight'
                    : ((_turnFlip = !_turnFlip), _turnFlip ? 'ArrowLeft' : 'ArrowRight');
            return [{ keys: [k], hold_ms: turn }];
        }
        case 'jump-forward': return fast ? [{ keys: ['ArrowUp', 'jump'], hold_ms: 300 }] : ['run_jump'];
        case 'jump':         return [{ keys: ['jump'], hold_ms: 220 }];
        case 'action':       return [{ keys: ['action'], hold_ms: 220 }];
        case 'crouch':       return [{ keys: ['crouch'], hold_ms: 260 }];
        case 'wait':         return [{ keys: ['_wait'], hold_ms: fast ? 350 : 700 }];
        default:             return _MACROS[cat] ? [cat] : null;   // a learned COMBO runs as one chain
    }
}
// Decide whether the brain should take over this step. Returns {cat, from, actions} or null.
function _brainOverride(response, stateKey) {
    if (!_adaptiveBrain || !_brainAssistControl) return null;
    if (_playMode === 'ai-teach') return null;   // AI-Teach = clean demonstration, child never takes over.
    // In this mode the parent is DELIBERATELY teaching — it should narrate
    // its reasoning and the child gets bonus rewards for good moves.
    const s = _qTable[stateKey];
    if (!s) return null;
    const ranked = Object.entries(s).filter(([, v]) => v.n >= 2).sort((a, b) => b[1].mean - a[1].mean);
    if (ranked.length < 2) return null;
    const llmCat = _actionCat(response.actions);
    const cur = s[llmCat];
    if (_brainBias === 'chaos') {
        // Chaos: let the child grab the controller toward the jankiest move, sometimes.
        const worst = ranked[ranked.length - 1];
        if (worst[0] !== llmCat && worst[1].mean < -0.1 && Math.random() < 0.5) {
            const act = _catToAction(worst[0]);
            if (act) return { cat: worst[0], from: llmCat, actions: act };
        }
        return null;
    }
    // TRUST scales how eager the child is — the whole "hand it down more as it
    // grows up" mechanic lives here.
    const t = _childTrust;
    const best = ranked[0];
    // Until it's reasonably trusted (≥50%), the child only helps when the parent
    // is visibly STUCK. Past that, it may also act proactively.
    if (t < 0.5 && _stuckCount < 1) return null;
    const badThresh  = -0.2 + t * 0.15;   // more trust → readier to call the parent's pick "bad"
    const goodThresh =  0.3 - t * 0.2;    // more trust → the child's best needn't be as proven
    const llmBad   = cur && cur.n >= 2 && cur.mean < badThresh;
    const eligible = (llmBad && best[0] !== llmCat && best[1].mean > goodThresh);
    // High trust: step in proactively when the child is VERY confident, even if the
    // parent's pick wasn't clearly wrong.
    const proactive = t >= 0.7 && best[0] !== llmCat && best[1].mean > 0.6;
    if (eligible || proactive) {
        // Hand-down PROBABILITY rises with trust: ~25% of eligible moments when
        // barely trusted, up to 100% once the child has grown up. This is the
        // "let it take the controller more often" dial.
        if (Math.random() > 0.25 + 0.75 * t) return null;
        const act = _catToAction(best[0]);
        if (act) return { cat: best[0], from: llmCat, actions: act };
    }
    return null;
}

// ── DEPTH / STRUCTURE READ (lightweight heuristic, NOT a neural net) ──
// Splits the frame into L/C/R thirds and estimates, per side, brightness + edge
// activity to roughly tell "open path that recedes" vs "near solid wall". It's a
// cheap hint, deliberately conservative — only speaks when a side is clearly
// different. Honest about being a heuristic.
let _depthCanvas = null, _depthCtx = null;
// Returns { best, worst, flat } column indices (0=L,1=C,2=R) or null. Also caches
// the open side into _lastOpenSide so the RL can steer toward it.
async function _depthAnalyze(url) {
    try {
        const img = await _loadImage(url);
        const w = 60, h = 45;
        if (!_depthCanvas) { _depthCanvas = document.createElement('canvas'); _depthCtx = _depthCanvas.getContext('2d', { willReadFrequently: true }); }
        _depthCanvas.width = w; _depthCanvas.height = h;
        _depthCtx.drawImage(img, 0, 0, w, h);
        const d = _depthCtx.getImageData(0, 0, w, h).data;
        const third = w / 3;
        const cols = [{ b: 0, e: 0, n: 0 }, { b: 0, e: 0, n: 0 }, { b: 0, e: 0, n: 0 }];
        const gray = (x, y) => { const i = (y * w + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const c = Math.min(2, Math.floor(x / third)), g = gray(x, y);
            cols[c].b += g; cols[c].n++;
            if (x > 0) cols[c].e += Math.abs(g - gray(x - 1, y));
        }
        const score = cols.map(c => ({ bright: c.b / c.n, edge: c.e / c.n }));
        const open = score.map(s => (s.edge * 1.2) - (s.bright / 255) * 40);
        const best = open.indexOf(Math.max(...open)), worst = open.indexOf(Math.min(...open));
        _lastOpenSide = best === worst ? null : ['L', 'C', 'R'][best];
        if (best === worst) return null;
        return { best, worst, flat: score[worst].edge < 6 && score[worst].bright > 150 };
    } catch { return null; }
}
async function _depthRead(url) {
    const a = await _depthAnalyze(url);
    if (!a) return '';
    const labels = ['LEFT', 'CENTER', 'RIGHT'];
    return `🔍 DEPTH READ (rough heuristic): the ${labels[a.best]} looks most open/passable; the ${labels[a.worst]} looks ${a.flat ? 'like a near WALL' : 'more blocked'}. Trust your eyes first, use this as a tiebreaker.`;
}


// ── DEBUG HUD: live readout of what the AI is thinking/doing ──
let _debugHUD = (() => { try { return localStorage.getItem('sm64_debug_hud') === '1'; } catch { return false; } })();
let _lastVisualPct = null;   // most recent objective visual-change %
function updateDebugHUD() {
    const el = document.getElementById('debug-hud');
    if (!el) return;
    if (!_debugHUD) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const flags = [_preplanMode && 'preplan', _turboMode && 'turbo', _rapidFireActive && 'rapid', _agentOnly && 'agent-only', _adaptiveBrain && 'brain'].filter(Boolean).join(' ') || '—';
    const _rankName = ['title', 'outside', 'foyer', 'in-level'][_trainStats.bestRegionRank] || 'title';
    const _og = _trainStats.overrideGood || 0, _ob = _trainStats.overrideBad || 0;
    const brainLine = _adaptiveBrain
        ? `<div>child: ${Object.keys(_qTable).length} states · lastR: ${_lastReward == null ? '—' : _lastReward.toFixed(2)} (${_brainBias})</div>` +
          `<div>trust: ${Math.round(_childTrust * 100)}% · steps ✓${_og}/✗${_ob} · best:${_rankName}</div>` +
          `<div>mode: ${_playMode} · taught:${_trainStats.taught || 0} · graded:${_trainStats.graded || 0} · rated:${_trainStats.rated || 0}</div>` +
          `<div>trained: ${_trainStats.episodes}ep · ${_trainStats.turns}turns</div>`
        : '';
    el.innerHTML =
        `<b>🐞 SM64-AI debug</b>` +
        `<div>region: <b>${_esc(_region)}</b> (${_regionAge}t)</div>` +
        `<div>last: ${_esc(_lastActionSummary || '—')}</div>` +
        `<div>visualΔ: ${_lastVisualPct == null ? '—' : _lastVisualPct + '%'} · stuck:${_stuckCount} · cut:${_sceneCutCount}</div>` +
        `<div>fmt: ${_cmdFormat}</div>` +
        `<div>mode: ${flags}</div>` +
        brainLine +
        `<div>done: ${_esc(_progressLog.slice(-3).join(' → ') || '—')}</div>`;
}
function toggleDebugHUD(on) {
    _debugHUD = (on == null) ? !_debugHUD : !!on;
    try { localStorage.setItem('sm64_debug_hud', _debugHUD ? '1' : '0'); } catch {}
    document.getElementById('debug-btn')?.classList.toggle('active', _debugHUD);
    updateDebugHUD();
}
window.sm64Debug = toggleDebugHUD;
document.getElementById('debug-btn')?.addEventListener('click', () => toggleDebugHUD());

// ── BRAINMAP VISUALIZER (in-UI panel + experimental pop-out window) ──
function _bmNode(id, label, icon) {
    const active = _region === id || (id === 'in-level' && /in-level/.test(_region));
    return `<div class="bm-node${active ? ' active' : ''}">${icon}<span>${label}</span></div>`;
}
function renderBrainmapHTML() {
    const map = `<div class="bm-map">${_bmNode('title', 'Title', '🎬')}<span class="bm-arrow">→</span>${_bmNode('outside-castle', 'Outside', '🌳')}<span class="bm-arrow">→</span>${_bmNode('castle-foyer', 'Foyer', '🏰')}<span class="bm-arrow">→</span>${_bmNode('in-level', 'In Level', '🎨')}</div>`;
    const cur = `<div class="bm-cur">📍 <b>${_esc(_region)}</b> <small>(${_regionAge} turns here)</small></div>`;
    const calib = `<div class="bm-meta">🎯 ${_esc(_aiGoal || 'no goal yet')}</div>`;
    const checklist = _checklist.length
        ? `<div class="bm-h">Checklist</div>` + _checklist.map(c => `<div class="bm-check">${c.done ? '✅' : '⬜'} ${_esc(c.text || c)}</div>`).join('')
        : '';
    const events = `<div class="bm-h">Timeline — watch it build ↓ (newest first)</div>` +
        (_brainmapEvents.length
            ? _brainmapEvents.slice(-40).reverse().map(e => {
                const ic = e.kind === 'region' ? '📍' : e.kind === 'done' ? '⭐' : e.kind === 'event' ? '⚡' : '•';
                const ago = Math.max(0, Math.round((Date.now() - e.t) / 1000));
                return `<div class="bm-evt"><span class="bm-ic">${ic}</span> ${_esc(e.text)} <span class="bm-ago">${ago}s</span></div>`;
            }).join('')
            : '<div class="bm-evt">— nothing yet —</div>');
    return `<div class="bm-wrap">${map}${cur}${calib}${checklist}${events}</div>`;
}
let _bmPopup = null;
function updateBrainmapViz() {
    const html = renderBrainmapHTML();
    const body = document.getElementById('brainmap-body');
    if (body) body.innerHTML = html;
    if (_bmPopup && !_bmPopup.closed) {
        try { const r = _bmPopup.document.getElementById('bm-root'); if (r) r.innerHTML = html; } catch {}
    }
}
const _BM_POPUP_CSS = `body{margin:0;font-family:system-ui,sans-serif;background:#10131a;color:#e6e9ef;padding:12px}
.bm-map{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:10px}
.bm-node{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11px;padding:6px 8px;border-radius:8px;background:#1b2230;border:1px solid #2a3344;opacity:.5}
.bm-node.active{opacity:1;border-color:#4fd1e0;box-shadow:0 0 10px rgba(79,209,224,.5);background:#15303a}
.bm-node span{font-size:18px}.bm-arrow{color:#46506a}
.bm-cur{font-size:14px;margin:6px 0}.bm-meta{font-size:11px;color:#9aa6bd;margin-bottom:8px}
.bm-h{font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:#7a86a0;margin:10px 0 4px}
.bm-check,.bm-evt{font-size:12px;padding:3px 6px;border-left:2px solid #2a3344;margin:2px 0}
.bm-evt{color:#cfd6e4}.bm-ic{margin-right:3px}.bm-ago{color:#5a647c;font-size:10px;float:right}`;
function openBrainmapPopup() {
    _bmPopup = window.open('', 'sm64brainmap', 'width=380,height=600');
    if (!_bmPopup) { updateAIStatus('⚠ Pop-out blocked — allow popups for this site'); return; }
    _bmPopup.document.title = 'SM64 AI — Brainmap';
    _bmPopup.document.body.innerHTML = `<style>${_BM_POPUP_CSS}</style><h3 style="margin:0 0 8px;font-size:14px">🗺️ Brainmap (live)</h3><div id="bm-root"></div>`;
    updateBrainmapViz();
}
function toggleBrainmapPanel() {
    const p = document.getElementById('brainmap-panel');
    if (!p) return;
    const show = p.style.display !== 'block';
    p.style.display = show ? 'block' : 'none';
    document.getElementById('brainmap-btn')?.classList.toggle('active', show);
    if (show) updateBrainmapViz();
}
document.getElementById('brainmap-btn')?.addEventListener('click', toggleBrainmapPanel);
document.getElementById('brainmap-popout-btn')?.addEventListener('click', openBrainmapPopup);
document.getElementById('brainmap-clear-btn')?.addEventListener('click', clearBrainmap);
document.getElementById('brainmap-persist-toggle')?.addEventListener('change', (e) => setPersistBrainmap(e.target.checked));

// Command format the model must reply in. 'json' (structured) or 'simple' (a
// plain line format that weak models handle far more reliably). We always try
// the other as a fallback, so a malformed reply still usually works.
let _cmdFormat = (() => { try { return localStorage.getItem('sm64_cmd_format') || 'json'; } catch { return 'json'; } })();

// Rapid-fire mode state
let _rapidFireActive = false;
let _rapidFireTurns  = 0;
let _rapidFireInterval = null;

// ── Consistent Rapid Fire / TURBO (user-forced; the AI cannot disable it) ──
// Runs the think→act loop as fast as the model can answer. Burns pollen FAST.
let _turboMode = (() => { try { return localStorage.getItem('sm64_turbo') === '1'; } catch { return false; } })();
let _turboCfg  = (() => { try { return JSON.parse(localStorage.getItem('sm64_turbo_cfg')) || {}; } catch { return {}; } })();
if (typeof _turboCfg.multi    === 'undefined') _turboCfg.multi    = false; // 1 action/think, re-think constantly
if (typeof _turboCfg.advanced === 'undefined') _turboCfg.advanced = false; // max overdrive (no skips/floors)
if (typeof _turboCfg.live     === 'undefined') _turboCfg.live     = false; // constant frame updates (live view)
let _turboLoop = null;
let _liveLoop  = null;

// ── PRE-PLAN MODE (mini-TAS) ──────────────────────────────────────────
// Instead of one small move per turn, the AI studies the frame and writes a
// COMPLETE multi-step script (a mini-TAS) executed in a single turn. Either the
// AI opts in (response.preplan === true) or the user forces it every turn.
//   _preplanMode : user-forced on/off
//   _preplanCap  : max steps per script (0 = unlimited)
let _preplanMode = (() => { try { return localStorage.getItem('sm64_preplan') === '1'; } catch { return false; } })();
let _preplanCap  = (() => { try { const v = parseInt(localStorage.getItem('sm64_preplan_cap'), 10); return Number.isFinite(v) ? v : 20; } catch { return 20; } })();
function savePreplanState() {
    try {
        localStorage.setItem('sm64_preplan', _preplanMode ? '1' : '0');
        localStorage.setItem('sm64_preplan_cap', String(_preplanCap));
    } catch {}
}

// Constant frame updates: continuously capture the live game so the AI's view
// is always current, and the "what the AI sees" panel shows live gameplay
// (not just the frozen request frame).
let _liveFrame = null;   // freshest screenshot, refreshed in the background
function startLiveLoop() {
    if (_liveLoop) return;
    _liveLoop = setInterval(async () => {
        if (!(_turboMode && _turboCfg.live && aiPlayerActive && aiStream)) return;
        const ss = await captureScreen(aiStream);
        if (!ss) return;
        _liveFrame = ss;
        if (_streamerMode) {
            const img = document.getElementById('so-vision-img');
            const ph  = document.getElementById('so-vision-ph');
            if (img) { img.src = ss; img.style.display = 'block'; if (ph) ph.style.display = 'none'; }
        }
    }, 350);
}
function stopLiveLoop() { if (_liveLoop) { clearInterval(_liveLoop); _liveLoop = null; } _liveFrame = null; }

function saveTurboState() {
    try {
        localStorage.setItem('sm64_turbo', _turboMode ? '1' : '0');
        localStorage.setItem('sm64_turbo_cfg', JSON.stringify(_turboCfg));
    } catch {}
}

function startTurboLoop() {
    if (_turboLoop) return;
    const floor = _turboCfg.advanced ? 60 : 200;   // Advanced = absolute max rate
    _turboLoop = setInterval(() => {
        if (!aiPlayerActive || !_turboMode || _isThinking || _rapidFireActive) return;
        aiThinkAndAct();
    }, floor);
}
function stopTurboLoop() { if (_turboLoop) { clearInterval(_turboLoop); _turboLoop = null; } }

function setTurboMode(on) {
    _turboMode = !!on;
    saveTurboState();
    updateTurboUI();
    if (_turboMode) {
        if (aiPlayerActive) { if (aiInterval) { clearInterval(aiInterval); aiInterval = null; } startTurboLoop(); }
        if (_turboCfg.live) startLiveLoop();
        tts.interrupt('Consistent rapid fire on. I will play as fast as I can — this burns pollen quickly.');
    } else {
        stopTurboLoop();
        stopLiveLoop();
        if (aiPlayerActive && aiMode === 'auto' && !_rapidFireActive) scheduleAILoop();
        tts.interrupt('Consistent rapid fire off.');
    }
}

function updateTurboUI() {
    const b = document.getElementById('turbo-btn');
    if (b) b.classList.toggle('active', _turboMode);
    const sb = document.getElementById('so-turbo-btn');
    if (sb) { sb.classList.toggle('active', _turboMode); sb.textContent = _turboMode ? '⚡ Turbo ON' : '⚡ Turbo'; }
}

const aiBtn    = document.getElementById('ai-player-btn');
const aiStatus = document.getElementById('ai-status');

// VERIFIED controls for THIS build (match the original working project):
//   Arrows = analog stick · KeyX = A (jump) · KeyC = B (punch/dive/grab) ·
//   Space = Z (crouch / ground-pound / long-jump) · Enter = Start (pause/confirm).
// There is NO keyboard camera control in this build — Mario must TURN (Left/Right)
// to re-orient; the camera follows him. (Don't invent camera keys; they're no-ops.)
const keyMap = {
    ArrowUp:    'ArrowUp',
    ArrowDown:  'ArrowDown',
    ArrowLeft:  'ArrowLeft',
    ArrowRight: 'ArrowRight',
    jump:       'KeyX',   // A button
    crouch:     'Space',  // Z button (crouch / ground-pound / long-jump)
    action:     'KeyC',   // B button (punch / dive / grab / read sign)
    start:      'Enter',  // Start (pause / confirm menus)
    // Aliases so weak models that emit natural words still resolve to a real key:
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    back: 'ArrowDown', backward: 'ArrowDown', forward: 'ArrowUp',
    a: 'KeyX', b: 'KeyC', x: 'KeyX', c: 'KeyC',
    jump_key: 'KeyX', dive: 'KeyC', punch: 'KeyC',
    z: 'Space', groundpound: 'Space', duck: 'Space',
};

let playerInputs = new Set();
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { e.stopPropagation(); return; }
    const movementKeys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD','Space','KeyX','KeyC'];
    if (movementKeys.includes(e.code)) { playerInputs.add(e.code); playerMovementDetected = true; }
});
document.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { e.stopPropagation(); return; }
    playerInputs.delete(e.code);
    if (playerInputs.size === 0) playerMovementDetected = false;
});

// ── AGENT-ONLY MODE ──────────────────────────────────────────────────
// When ON: the human cannot control Mario — real keypresses are blocked from
// reaching the game, so ONLY the AI's synthetic inputs move the player. This
// also frees the keyboard so you can actually TYPE instructions (the game grabs
// keys like arrows / X / C / Space at the window level otherwise).
//
// How it works: the SM64 wasm registers its keyboard handler on `window`. This
// module runs BEFORE the wasm finishes loading, so a window CAPTURE listener
// added here fires first and can stop trusted (real) keys before the game sees
// them. The AI's keys are dispatched via KeyboardEvent (isTrusted === false), so
// they pass straight through.
let _agentOnly = (() => { try { return localStorage.getItem('sm64_agent_only') === '1'; } catch { return false; } })();

// Game-relevant keys to withhold from Mario when agent-only is on (plain presses
// only — modified combos are app/browser shortcuts and pass through).
const _GAME_GUARD_CODES = new Set([
    'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
    'KeyW','KeyA','KeyS','KeyD','KeyX','KeyC','KeyZ','Space','Enter',
]);
function _isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
function _agentKeyGuard(e) {
    if (!_agentOnly || !e.isTrusted) return;   // AI's synthetic keys pass through
    // Typing in ANY form field: stop the key reaching the game, but DON'T
    // preventDefault — that lets native text editing (chars/Backspace/caret) work.
    // stopPropagation doesn't cancel the default action.
    if (_isEditable(e.target) || _isEditable(document.activeElement)) {
        e.stopImmediatePropagation();
        const instr = document.getElementById('ai-instruction');
        if (e.type === 'keydown' && e.key === 'Enter' && (e.target === instr || document.activeElement === instr)) {
            e.preventDefault();
            document.getElementById('send-instruction')?.click();
        }
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;  // app shortcuts pass
    if (_GAME_GUARD_CODES.has(e.code)) { e.stopImmediatePropagation(); e.preventDefault(); }
}
['keydown', 'keyup', 'keypress'].forEach(t => window.addEventListener(t, _agentKeyGuard, true));

function updateAgentOnlyUI() {
    document.getElementById('app')?.classList.toggle('agent-only', _agentOnly);
    const b  = document.getElementById('agent-only-btn');
    const sb = document.getElementById('so-agent-btn');
    if (b)  b.classList.toggle('active', _agentOnly);
    if (sb) { sb.classList.toggle('active', _agentOnly); sb.textContent = _agentOnly ? '🤖 Agent-Only ✓' : '🤖 Agent-Only'; }
}
function setAgentOnly(on) {
    _agentOnly = !!on;
    try { localStorage.setItem('sm64_agent_only', _agentOnly ? '1' : '0'); } catch {}
    if (_agentOnly) { playerInputs.clear(); playerMovementDetected = false; }
    updateAgentOnlyUI();
    updateAIStatus(_agentOnly
        ? '🤖 Agent-Only ON — manual control disabled, type to instruct the AI'
        : '🎮 Agent-Only off — you can play manually again');
}
document.getElementById('agent-only-btn')?.addEventListener('click', () => setAgentOnly(!_agentOnly));
document.getElementById('so-agent-btn')?.addEventListener('click', () => setAgentOnly(!_agentOnly));
updateAgentOnlyUI();

// Speed control
const speedSlider = document.getElementById('speed-slider');
const speedLabel  = document.getElementById('speed-label');
speedSlider.addEventListener('input', (e) => {
    gameSpeed = parseFloat(e.target.value);
    speedLabel.textContent = `${gameSpeed}×`;
    if (aiInterval) { clearInterval(aiInterval); aiInterval = null; }
    if (aiPlayerActive && aiMode === 'auto') scheduleAILoop();
});

// Mute
const muteBtn = document.getElementById('mute-btn');
let isMuted = false;
muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    muteBtn.textContent = isMuted ? '🔇' : '🔊';
    try {
        if (Module?.SDL2?.audioContext) {
            isMuted ? Module.SDL2.audioContext.suspend() : Module.SDL2.audioContext.resume();
        }
    } catch {}
});

// Instruction input
const instructionInput   = document.getElementById('ai-instruction');
const sendInstructionBtn = document.getElementById('send-instruction');
sendInstructionBtn.addEventListener('click', () => {
    const val = instructionInput.value.trim();
    if (val) {
        userInstruction = val;
        updateAIStatus(`📝 Instruction: "${userInstruction}"`);
        instructionInput.value = '';
        tts.speak(`Got it. I'll ${val}.`);
    }
});
// Keep keystrokes typed in the box OUT of the game. The SM64 wasm (SDL) listens
// for keydown on document, so without stopping propagation here, typing arrows /
// X / C / Space would move Mario instead of (or as well as) entering text. Adding
// listeners on the input itself (target phase) halts the event before it bubbles.
['keydown', 'keyup', 'keypress'].forEach(evt => {
    instructionInput.addEventListener(evt, (e) => {
        e.stopPropagation();
        if (evt === 'keydown' && e.key === 'Enter') { e.preventDefault(); sendInstructionBtn.click(); }
    });
});
instructionInput.addEventListener('focus', (e) => e.stopPropagation());
instructionInput.addEventListener('blur',  (e) => e.stopPropagation());

// ────────────────────────────────────────────────────────────
// 14. HELPERS
// ────────────────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

function simulateKeyPress(key, duration = 100) {
    const opts = { code: key, key, bubbles: true, cancelable: true };
    getGameCanvas().dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    setTimeout(() => {
        getGameCanvas().dispatchEvent(new KeyboardEvent('keyup', opts));
        document.dispatchEvent(new KeyboardEvent('keyup', opts));
    }, Math.max(50, duration));
}

function updateAIStatus(message) {
    aiStatus.style.display = 'block';
    aiStatus.textContent   = message;
}

// Render small visible badges for AI-detected state so the user can verify
// the region / camera2d / outside-castle logic is working.
function updateAIStateBadges() {
    const wrap = document.getElementById('ai-state-badges');
    if (!wrap) return;

    const locBadge = document.getElementById('badge-location');
    const camBadge = document.getElementById('badge-camera2d');

    if (_region && _region !== 'unknown') {
        locBadge.textContent = `📍 ${_region.replace(/-/g, ' ')}`;
        locBadge.classList.add('active');
    } else {
        locBadge.classList.remove('active');
    }

    camBadge.classList.toggle('active', _camera2d);

    const any = (_region && _region !== 'unknown') || _camera2d;
    wrap.style.display = any ? 'flex' : 'none';
}

// ────────────────────────────────────────────────────────────
// 15. AI THINK  (with throttle + frame-skip)
// ────────────────────────────────────────────────────────────
async function aiThink() {
    if (_isThinking) return null;

    // Throttle: enforce minimum interval (bypassed in turbo / rapid-fire)
    const now = Date.now();
    const fastMode = _turboMode || _rapidFireActive;
    const minInterval = MIN_THINK_INTERVAL_MS * (1 + _consecutiveErrors * 0.5);
    if (!fastMode && now - _lastThinkTime < minInterval) {
        updateAIStatus(`⏳ Cooling down (${Math.ceil((minInterval - (now - _lastThinkTime)) / 1000)}s)…`);
        return null;
    }

    // Pause AI if player is actively providing input
    if (playerMovementDetected) {
        updateAIStatus('⏸ Player is playing — AI paused');
        return null;
    }

    _isThinking = true;
    _lastThinkTime = now;
    updateAIStatus('🤔 Thinking…');

    try {
        // Live game state from WASM memory (null when memory reading is disabled).
        const gameState = readGameState();

        // Pollinations vision model — always capture the screen.
        // In live mode the background loop is the single capturer — reuse its
        // freshest frame (always current) instead of double-capturing.
        let screenshot = (_turboMode && _turboCfg.live && _liveFrame)
            ? _liveFrame
            : await captureScreen(aiStream);
        if (!screenshot) { updateAIStatus('❌ Failed to capture game view'); _isThinking = false; return null; }
        // Skip if the frame is identical to recent ones (nothing changed).
        // Advanced turbo AND Multi-request both RE-REQUEST on purpose, so they must
        // NOT skip "identical" frames. That idle-skip is exactly why multi-request
        // mode appeared to stall: it executes one tiny move, the frame barely
        // changes, and the very next think got skipped → no new request fired.
        const skipIdentical = !(_turboMode && (_turboCfg.advanced || _turboCfg.multi));
        if (skipIdentical && isFrameIdentical(screenshot)) {
            updateAIStatus('💤 Screen unchanged — skipping inference');
            _isThinking = false;
            return null;
        }
        _frameHistory.push(screenshot);            // keep recent frames for is_stuck/is_trapped
        if (_frameHistory.length > 6) _frameHistory.shift();

        const memStateCtx = gameState
            ? `\n\n${gameStateToText(gameState)}\n  (If the screen is a TITLE/FILE-SELECT/DEMO, these numbers are from a background demo — ignore them and follow the SCREEN guidance.)`
            : '';

        // Movement since the previous decision — gives the model a sense of motion,
        // and catches the "stuck repeating the same wrong move" failure mode.
        let motionCtx = '';
        // Compute a single visual-diff score once for both memory and vision paths.
        let visualDiff = null;
        if (_prevScreenshot && screenshot && _prevScreenshot !== screenshot) {
            visualDiff = await _frameDiffScore(_prevScreenshot, screenshot);
            if (visualDiff != null) _lastVisualPct = Math.round(visualDiff * 100);
        }

        if (_prevGameState && gameState) {
            const dx = gameState.x - _prevGameState.x;
            const dy = gameState.y - _prevGameState.y;
            const dz = gameState.z - _prevGameState.z;
            const dist = Math.round(Math.hypot(dx, dz));
            if (dist + Math.abs(dy) < 8) _stuckCount++; else _stuckCount = 0;
            motionCtx = `\n\nMOVEMENT SINCE LAST DECISION: Δx=${dx}, Δy=${dy}, Δz=${dz} (moved ${dist} units horizontally).`;
            if (_stuckCount >= 2) {
                motionCtx += `\n⚠ YOU APPEAR STUCK — your position has barely changed for ${_stuckCount} turns, so your last move is NOT working. Do something DIFFERENT: turn to face a new direction, back up, jump over the obstacle, or pick another path. Do not repeat the previous action.`;
            }
            if (_prevGameState.stars < gameState.stars) motionCtx += `\n🌟 You just collected a STAR — nice! Keep progressing.`;
            // Huge instantaneous jumps usually mean a warp, painting entry, or a
            // respawn — keep this warning neutral and do NOT auto-label it a demo.
            if (dist > 4000) motionCtx += `\n📍 Mario's position jumped ${dist} units suddenly — you likely warped, entered a painting, or respawned. Re-check the SCREEN type, but do NOT assume demo unless you also see demo tells.`;
        }

        // Scene-cut / demo detector. We run this whenever we have a previous frame,
        // regardless of whether memory is enabled. Normal gameplay (fast camera
        // turns, falling, enemies, warps) can flip large parts of the screen, so we
        // require multiple drastic cuts in a short window AND that Mario is barely
        // moving before we call it a demo.
        if (visualDiff != null) {
            const vm = visualDiff;
            const pct = Math.round(vm * 100);
            const memoryMoved = gameState && _prevGameState && Math.hypot(gameState.x - _prevGameState.x, gameState.z - _prevGameState.z) > 2000;

            // Vision-only stuck detection when memory readout is unavailable.
            if (!(_prevGameState && gameState)) {
                if (vm < 0.05) _stuckCount++; else _stuckCount = 0;
                motionCtx = `\n\nVISUAL CHANGE since your last action: ${pct}% (objective screen-pixel difference). Under ~8% means you BARELY MOVED — you probably faced a wall or pressed the wrong key, so change direction. A large value means the view changed a lot.`;
                if (_stuckCount >= 2) {
                    motionCtx += `\n⚠ STUCK — the screen has barely changed for ${_stuckCount} turns, so your last move is NOT working. Do something DIFFERENT: turn to face a new direction (Left/Right), back up, jump over the obstacle, or pick another path. Do NOT repeat the previous action.`;
                }
            }

            const SCENE_CUT_THRESHOLD = 0.72;   // whole-screen change
            const SCENE_CUT_RESET     = 0.35;   // hysteresis so brief flickers don't reset count
            if (vm > SCENE_CUT_THRESHOLD && !memoryMoved) {
                _sceneCutCount++;
                const timeSinceLast = Date.now() - _lastDemoTime;
                // Need 3 rapid cuts, or 2 cuts while we are stuck/not moving
                if (_sceneCutCount >= 3 || (_sceneCutCount >= 2 && _stuckCount >= 2 && timeSinceLast < 15000)) {
                    _demoConfidence = Math.min(3, _demoConfidence + 1);
                }
                if (_demoConfidence >= 3 || _sceneCutCount >= 3) {
                    _lastDemoTime = Date.now();
                    motionCtx += `\n🎬 DEMO CONFIRMED (${_sceneCutCount} scene cuts, confidence ${_demoConfidence}/3). You are watching an ATTRACT-MODE DEMO, not playing. The game is showing pre-recorded gameplay. DO NOT try to platform or navigate. Press start (Enter) ONCE to exit the demo, then press start AGAIN on the title screen to actually begin the game.`;
                } else if (_sceneCutCount >= 2) {
                    motionCtx += `\n🎬 The scene changed drastically again (${pct}%). If you did NOT just warp/enter a door, this is likely a demo — wait one more frame or press start (Enter) if you also see demo tells.`;
                } else {
                    motionCtx += `\n🎬 Big scene change (${pct}%). This may be a warp, door, painting, or demo. Wait one more frame before calling it a demo.`;
                }
            } else if (memoryMoved) {
                motionCtx += `\n📍 Screen changed a lot because of a warp/painting/respawn (moved ${Math.round(Math.hypot(gameState.x - _prevGameState.x, gameState.z - _prevGameState.z))} units). This is gameplay, NOT a demo.`;
                _sceneCutCount = 0;
            } else if (vm < SCENE_CUT_RESET) {
                _sceneCutCount = 0;
                // Decay demo confidence slowly once scenes stop cutting
                if (Date.now() - _lastDemoTime > 12000) {
                    _demoConfidence = Math.max(0, _demoConfidence - 1);
                }
            }
        }

        const memOn = gameState != null;   // false when memory reading is disabled

        // ── Apprentice (parent LLM + child RL): score last action, learn, hint, trust ──
        let _curStateKey = '', brainCtx = '', depthCtx = '', rewardCtx = '', trustCtx = '';
        if (_adaptiveBrain) {
            _brainLearn();                       // score the previous action's outcome
            _curStateKey = _brainState();
            brainCtx = _brainHint(_curStateKey);
            if (_lastReward != null) {
                const verdict = _lastReward >= 0.25 ? 'REWARDED ✅ (that helped)'
                              : _lastReward <= -0.25 ? 'PUNISHED ❌ (that did NOT work)'
                              : 'neutral (little effect)';
                rewardCtx = `\n\n🎓 OUTCOME of your LAST move (this is also how the apprentice scored it): ${verdict} — ${_lastReward.toFixed(2)}.` +
                    (_lastReward <= -0.25 ? ' Choose a DIFFERENT category of move this turn — do not repeat the last one.' : '');
            }
            // You decide how much to trust the child. As it proves it can play, raise
            // child_trust so it takes the controller more often; lower it if it flails.
            const tp = Math.round(_childTrust * 100);
            const og = _trainStats.overrideGood || 0, ob = _trainStats.overrideBad || 0, tg = _trainStats.taught || 0;
            trustCtx = `\n\n🤝 APPRENTICE TRUST: ${tp}%. The child (an empty-brained learner that only watches inputs→results) has taken ${og + ob} step(s) for you so far — ${og} helped, ${ob} backfired${tg ? `; it has also watched a human play ${tg} move(s)` : ''}. Set "child_trust" (0-100) to grade it: RAISE it as it proves reliable so it plays more, LOWER it if it's flailing. At low trust it only acts when you're stuck.`;
            if (screenshot) depthCtx = await _depthRead(screenshot);
        }

        const perceptionNote = memOn
            ? 'Analyze the screenshot together with the LIVE GAME STATE below.'
            : 'Analyze the screenshot. NOTE: there is NO live memory readout on this build — rely entirely on what you SEE in the image.';

        const hierarchyNote = memOn
            ? `HOW TO DECIDE — strictly in this order:
1) VISUALS FIRST — trust what you SEE in the CURRENT frame; your eyes rarely lie. Figure out the screen type and what is actually around Mario right now.
2) MEMORY SECOND — use the live game-state numbers to confirm/refine what you see. If the picture and the numbers DISAGREE, trust your EYES.
3) ANTI-STUCK TOOLS THIRD — only when BOTH visuals and numbers are ambiguous, call is_stuck / is_trapped for a second opinion.`
            : `HOW TO DECIDE:
1) VISUALS FIRST — your EYES are the only source of truth here (no live memory). Identify the screen type and what is actually around Mario in the CURRENT frame, and act on that.
2) ANTI-STUCK TOOLS — if you genuinely can't tell whether you're moving or you look stuck/softlocked, call is_stuck / is_trapped before doing anything drastic.`;

        const movementCtx = '\n\nNOTE: The player is idle (no input detected).';
        // BRAINMAP — replay the AI's running sense of place + progress so it stops
        // forgetting it already went inside, which level it's in, etc.
        const regionLabel = {
            'outside-castle': 'OUTSIDE the castle (open sky, grass, moat/bridge, castle exterior)',
            'castle-foyer':   'INSIDE the castle foyer (enclosed room, paintings on walls, stairs — do NOT walk back out the front door)',
        }[_region] || _region;
        const brainmapCtx =
            `\n\n🗺️ BRAINMAP (your memory — trust it, update it):\n` +
            `- WHERE YOU ARE: ${regionLabel} (for ${_regionAge} turn(s)).\n` +
            (_progressLog.length ? `- DONE SO FAR: ${_progressLog.slice(-8).join(' → ')}.\n` : '') +
            (_checklist.length ? `- CHECKLIST: ${_checklist.map(c => `${c.done ? '✅' : '⬜'} ${c.text || c}`).join(' | ')}.\n` : '') +
            `- Update "region" every turn from what you SEE. If you just walked through the castle's front doors, your region is now "castle-foyer" — you are INSIDE; do not turn around and leave.`;
        const cameraCtx = _camera2d
            ? '\n\nCAMERA PERSPECTIVE: The previous frame was detected as a 2D/front-facing or side-view camera. In this mode LEFT/RIGHT move Mario across the screen (hold them like forward travel); UP/DOWN move him toward/away from the camera and are usually NOT the way to progress. Do NOT "turn then go forward" in 2D mode.'
            : '';
        // Calibration grounding (measured: what "forward" actually did on screen)
        const planCtx = _aiGoal
            ? `\n\nYOUR CURRENT PLAN (you set this ${_aiGoalAge} turn(s) ago — KEEP pursuing it unless the screen clearly shows it's done, impossible, or wrong): ${_aiGoal}`
            : '';
        const lastActCtx = _lastActionSummary
            ? `\n\nYOUR LAST ACTION was: ${_lastActionSummary}. Use the movement/visual-change feedback below to judge if it worked — if it barely moved you, do something DIFFERENT this turn.`
            : '';
        // Pre-plan (mini-TAS): the AI writes a full multi-step script this turn.
        const capTxt = _preplanCap > 0 ? `up to ${_preplanCap}` : 'as many as you need';
        const preplanCtx = _preplanMode
            ? `\n\n🧠 PRE-PLAN MODE IS ON. Do NOT make one tiny move. STUDY this frame, then write a COMPLETE step-by-step SCRIPT in "actions" (${capTxt} groups) that makes real, visible progress toward your goal — e.g. turn to face the door, run to it, climb the stairs, open it. Think like a speedrun route: each group is one timed key-hold, executed in order. The whole script runs this turn (it auto-stops if the scene changes unexpectedly), so plan a sane chunk you're confident about. Set "preplan": true.`
            : `\n\n🧠 OPTIONAL PRE-PLAN: if you can clearly see a multi-step path (e.g. a straight run to a visible door), you MAY set "preplan": true and put the FULL multi-step SCRIPT in "actions" (${capTxt} groups) to cover more ground in one turn. Otherwise keep it short.`;
        const memoryCtx   = aiMemory.length > 0
            ? `\n\nPAST MISTAKES TO AVOID:\n${aiMemory.slice(-5).map((m, i) => `${i + 1}. ${m}`).join('\n')}`
            : '';
        // AI-TEACH MODE: the parent is deliberately demonstrating for the child.
        // It should narrate WHY it chose each move so the child learns strategy.
        const teachCtx = _playMode === 'ai-teach'
            ? `\n\n👨‍🏫 AI-TEACH MODE: You are demonstrating for a child learner. After every action, briefly explain WHY you chose it in "thought" — what you saw, what you aimed for, and what you expect to happen. The child learns from your reasoning, not just your inputs. Be explicit: "I turned left because the door is in the L cell" or "I long-jumped because there's a gap ahead". This is a TEACHING session — show your work.`
            : '';
        const notesCtx    = aiNotes.length > 0
            ? `\n\nYOUR PRE-GAME STUDY NOTES:\n${aiNotes.join('\n')}`
            : '';
        const instrCtx    = userInstruction
            ? `\n\nUSER INSTRUCTION (follow this): ${userInstruction}`
            : '';
        // NOTE: the heavy speedrun/TAS/training guides are NO LONGER dumped into
        // every gameplay turn (that bloated context + cost). They're distilled
        // once by Study into aiNotes (fed via notesCtx) and used there instead.

        const systemPrompt = `You are an AI playing Super Mario 64. Decide what actions to take.
${perceptionNote}

${hierarchyNote}

FIRST, IDENTIFY THE SCREEN — this is critical:
- TITLE SCREEN ("Press Start", the big rotating Mario face/logo): press start (Enter) to begin.
- FILE SELECT (a menu of Mario-head save files A/B/C/D, or Peach/coins icons): press jump (X) to pick a file and enter the game.
- ATTRACT-MODE DEMO — the game plays ITSELF when left idle on the title. DEMO TELLS: (a) Mario moves/jumps/fights on his OWN without you pressing anything; (b) the camera pans cinematically by itself; (c) the scene CUTS between different levels (a 🎬 note below flags this ONLY when confidence is high); (d) you often see "PRESS START", the © Nintendo logo, or a level you never chose. If ANY of these, you are NOT in control.
- DEMO PROTOCOL: When you see 🎬 DEMO CONFIRMED, your ONLY action is: press start (Enter) to exit. Do NOT run, jump, swim, or do ANYTHING else. Just press start. Then on the title screen, press start AGAIN to actually begin. Treat demos like a video playing on a screen — your inputs do nothing until you break out of it.
- DIALOG BOX (a white text box / sign / character speaking): press jump (X) to advance/close it.
- ACTUAL GAMEPLAY: you are in control ONLY if your inputs visibly move Mario the way you intended AND the scene is NOT cutting around on its own. Confirm control before you trust it.
TEST FOR CONTROL: do NOT call normal gameplay a demo just because the camera turned fast, Mario fell, or you warped into a level. Only treat it as a demo/menu if you see actual demo tells above. If you are genuinely unsure, press start (Enter) once — but if gameplay resumes, you were NOT in a demo.
At session start you are almost always on the TITLE or a DEMO, not in gameplay — get to FILE SELECT → gameplay first.

WHERE AM I? — figure this out EVERY turn and put it in "region". You keep mixing these up:
- OUTSIDE-CASTLE: you can see OPEN SKY, green grass, the moat/water, the stone BRIDGE, and the castle's exterior walls/towers ahead. NO paintings on walls, NO Chain Chomp, NO cannons, NO mountain with a flag. Goal here: cross to the big front DOORS and go in. (Grass alone does NOT mean "near the entrance" — lots of places have grass.)
- CASTLE-FOYER: you are INDOORS — an enclosed room, NO sky, stone/checkered floor, PAINTINGS hanging on the walls, staircases, warm indoor lighting. If you see this you ALREADY WENT INSIDE — do NOT walk back out the front door behind you. Goal: reach a painting and jump in.
- IN-LEVEL: you're inside a course with its own theme. Bob-omb Battlefield = open field with cannons, Chain Chomp, mountain with flag, NO castle entrance building. You can ONLY reach a level by going inside the castle and jumping into a painting — if you have not done that, you are NOT in-level.
- ANTI-HALLUCINATION RULE: If you just started/loaded the game, you MUST be outside-castle. You cannot be in Bob-omb Battlefield without first entering the castle and jumping into the painting. If you see the castle building, bridge, or moat, you are outside-castle, NOT in-level.
Use the BRAINMAP below: if it says you're castle-foyer, you're INSIDE even if part of the room looks open — don't go back outside.

GAME OBJECTIVE (once you control Mario):
1. OUTSIDE: head across the bridge to the big front DOORS and walk into them → you are now INSIDE (set region = castle-foyer).
2. Advance/skip any dialog box by pressing jump (X) — NOT start.
3. INSIDE the foyer: do NOT run back out. Walk up to a PAINTING on the wall and jump INTO it (use the enter_painting move).
4. IN a level: go for the obvious star objective.
5. Collect stars to progress.

FIRST-TIME SETUP (you MUST do this at the start of every session):
You almost always begin on the TITLE SCREEN or in an ATTRACT DEMO — NOT in gameplay. Follow this EXACT sequence:
1. If you see "PRESS START" or Mario's face rotating: press start (Enter) once.
2. If a DEMO is playing (Mario moves on his own, scene cuts): press start (Enter) to exit it, THEN press start again on the title.
3. FILE SELECT screen appears (Mario head icons A/B/C/D): press jump (X) to pick File A.
4. You are now OUTSIDE the castle (open sky, grass, bridge). Set region = outside-castle.
5. Cross the bridge to the big wooden DOORS and walk through them (hold ArrowUp).
6. You are now INSIDE the castle foyer (indoors, paintings, no sky). Set region = castle-foyer.
7. Face the painting of the mountain with a face (Bob-omb Battlefield — usually on the right wall). Walk up to it and jump in (use enter_painting).
8. You are now IN A LEVEL. Set region = in-level:bob-omb-battlefield.
9. Look for the star objective (usually up/forward) and head toward it.
DO NOT skip steps. Do NOT try to run around before entering the castle. Do NOT jump into a painting before going through the front doors.

KING BOB-OMB (Big Bob-omb on the Summit) — when you reach the top of Bob-omb Battlefield:
- The giant crowned Bob-omb is the FIRST BOSS. Do NOT run straight into his front — he will grab and throw Mario.
- Strategy: get close, then LOOP/CIRCLE around him (hold ArrowLeft or ArrowRight, with a little ArrowUp) until you are BEHIND his back, then immediately press action (B/C) to GRAB him fast. Toss him on the ground; repeat 3 times.
- Do NOT throw him off the mountain — he'll jump back up and reset the fight.
- Use the macro "king_bobomb" to execute: approach → circle left → grab.

CONTROLS — the COMPLETE, exact control set. There are ONLY these. LEARN them:
- ArrowUp = move FORWARD (the way Mario's back faces / away from camera).
- ArrowDown = move BACKWARD — the literal OPPOSITE of ArrowUp. If forward is blocked or you overshot, press ArrowDown to back straight up. ⭐ YOU CONSTANTLY FORGET ArrowDown EXISTS. It is just as valid as forward. USE IT to un-stick yourself.
- ArrowLeft / ArrowRight = turn/steer that way (the camera follows Mario).
- DIAGONALS: hold TWO arrows together for diagonal movement — ["ArrowUp","ArrowLeft"] = forward-left, ["ArrowUp","ArrowRight"] = forward-right. Use this to line up precisely without a full separate turn.
- Hold long enough to travel: a tap barely moves him; cross open ground = hold ~1500ms+.

- jump (X) = the A button — jump; also advances dialog boxes.
- action (C) = the B button — punch / kick / DIVE (while running) / grab / read a sign.
- crouch (Space) = the Z button — crouch on the ground; IN THE AIR it does a GROUND POUND (slam straight down to hit switches, break boxes, or land precisely).
- start (Enter) = Start — title/menu confirm and PAUSE only. NEVER press it during gameplay.

KEY MOVES (keys in ONE group are pressed together / simultaneously):
- Jump across a gap or INTO a painting: ["ArrowUp","jump"] while moving (or macro "run_jump" / "enter_painting").
- Long jump (big horizontal leap): run, then ["ArrowUp","crouch","jump"] together (macro "long_jump").
- Ground pound onto a target: jump, then crouch in the air (macro "ground_pound").
- Wall kick to climb a corner: jump into the wall, then jump again off it (macro "wall_kick").
- Back up / turn around when stuck: ArrowDown (macro "back_up" / "turn_around").
Example actions: ["run_jump"]  or  [{"keys":["ArrowLeft"],"hold_ms":350},{"keys":["ArrowUp"],"hold_ms":1600},"enter_painting"]

WATER — you get this BACKWARDS, so read carefully:
- Underwater the up/down controls are INVERTED: hold ArrowDOWN to angle UPWARD toward the surface; hold ArrowUp to dive DEEPER. Tap jump (X) repeatedly = swim strokes that push you the way you're aimed.
- To GET OUT of water: hold ArrowDown (to aim UP) + tap jump repeatedly to rise to the surface, then swim toward the nearest shore and up onto land.
- If Mario is clearly ON DRY LAND he is NOT swimming — just walk normally.

2D / FRONT-FACING / SIDE-VIEW CAMERA (critical):
- Sometimes the camera shows Mario's face (he is looking at you) or locks into a side-scrolling / 2D-like angle.
- In that mode the world is FLATTENED: ArrowLeft and ArrowRight move Mario across the screen and are your MAIN way to travel. ArrowUp/Down move him toward/away from the camera (into/out of the screen), which is usually NOT the path forward.
- When you see this, set "camera2d": true in your response and navigate horizontally — do NOT "turn then go forward".
- In 2D mode hold ArrowLeft/ArrowRight for 1200–2500ms to travel, just like you hold ArrowUp in normal mode.

DELAYED / SEQUENCED ACTIONS:
- The AI can now execute actions with DELAYS between them. This is crucial for: waiting for moving platforms, timing jumps after a run-up, or adding breathing room between complex moves.
- In JSON format: add "delay_before_ms": N to any action group. Example: [{"keys":["ArrowUp"],"hold_ms":2000},{"keys":["jump"],"hold_ms":250,"delay_before_ms":500}] — runs forward 2s, waits 0.5s, then jumps.
- In simple format: append "delay <ms>" after any action. Example: DO: up 2000 | jump delay 500 | up 1500
- Use delays deliberately when timing matters — don't just spam actions back-to-back.

READING THE SCREEN — depth & obstacles (you are bad at this; slow down and look):
- WALL vs PATH: a WALL is a solid surface that fills the view and STOPS you (you stop moving, the view freezes). A TUNNEL / DOORWAY / PATH is a DARKER opening or gap that RECEDES into the distance — you can pass THROUGH it. Unsure? Nudge forward briefly: if the view keeps changing it's a path; if it freezes it's a wall — then back up (ArrowDown) and go around.
- DOORS vs PAINTINGS: a DOOR is a flat panel at FLOOR level you WALK through. A PAINTING is a framed picture on a wall that you JUMP INTO to enter a level. They are NOT the same — never try to jump into a door or walk into a painting.
- DEPTH cues: things LOWER/LARGER on screen are CLOSER; HIGHER/SMALLER are FARTHER. An edge with empty space or sky beyond it is a DROP — don't walk off unless you mean to.
- MOVING PLATFORMS (lifts, elevators, rotating bridges) are your #1 nemesis — most deaths happen here. Do NOT chase them and do NOT jump at a gap hoping it arrives. PROTOCOL: stand at the edge and use the "wait" / "observe" move to watch ONE full cycle; only when the platform is RIGHT NEXT TO you (adjacent, basically touching) do you step or short-hop on; ride it; then step off the instant the far side lines up. Patience beats reflexes here — "wait" is a real, valid move, use it.

NAVIGATION & UN-STICKING:
- The castle ENTRANCE is the pair of big wooden DOORS in the front wall across the bridge — not every arch/tunnel. Face it, hold forward into it.
- The route is rarely straight — expect to move diagonally and around things.
- WEDGED in a corner / box / against a wall (barely moved 2+ turns)? Do NOT keep pushing forward. Recovery in order: (1) press ArrowDown to BACK OUT, (2) turn 90° (hold Left or Right ~500ms), (3) go forward a new way. Backing up is the #1 escape — use it before anything drastic.

UNDERSTAND BEFORE YOU ACT (do this every turn, in your head, then fill the JSON):
1. SCENE: what screen is this? (title / file_select / demo / dialog / gameplay)
2. LOCATE MARIO: where is he in the frame, and which way is he facing?
3. LOCATE TARGET: what is the next thing to reach (door, bridge, painting, edge, star)? Name the GRID CELL it's in (TL/T/TR/L/C/R/BL/B/BR) using the compass overlay.
4. TURN MATH: if the target is in a LEFT cell, you must turn Left first; RIGHT cell → turn Right; T/C → it's roughly ahead, go forward. Never hold forward toward a target that is off to the side without turning first.
5. DID MY LAST MOVE WORK? check the VISUAL CHANGE % and movement feedback below. If it's low, you faced a wall or pressed the wrong key — change direction, do NOT repeat.
Commit to a PLAN (your "goal") that spans several turns instead of re-deciding from scratch every frame. Only abandon it when the screen proves it's wrong.

CHAINING ACTIONS:
- "actions" is a SEQUENCE of groups done one after another. Keys INSIDE one group happen SIMULTANEOUSLY (e.g. ["ArrowUp","jump"] = hold forward while jumping).
- Give each group a "hold_ms": FORWARD travel long (1200–5000ms — use LONGER holds for open ground, the ai can handle up to 8s); a TURN to re-aim short (250–500ms — a long turn just spins you in a circle); a jump or dialog-skip short (150–350ms).
- You can add "delay_before_ms" to ANY action group to insert a pause BEFORE that action executes. Use this to: wait for a moving platform to arrive, pause after a jump before the next move, or add breathing room between actions. Example: [{"keys":["ArrowUp"],"hold_ms":2000},{"keys":["jump"],"hold_ms":250,"delay_before_ms":500}] — runs forward 2s, waits 0.5s, then jumps.
- A good navigation turn is almost always two groups: TURN briefly to face the target, THEN hold forward toward it — e.g. [{"keys":["ArrowLeft"],"hold_ms":350},{"keys":["ArrowUp"],"hold_ms":1800}].
- For long straight runs (bridge, open field), use a SINGLE long forward hold (3000–5000ms) instead of multiple short ones — the ai will queue it and execute it fully.

RULES:
- ⛔ Never press start during gameplay (it pauses).
- You see ONE current frame each turn. Act on what is in THIS frame; judge whether you moved from the VISUAL CHANGE % and movement feedback (text), not from any remembered image.
- Escape tools (de_water, load_state, reset_game) stay LOCKED until is_stuck/is_trapped returns true.
- ${memOn
    ? 'You may use tools (get_game_state, set_game_speed for tricky jumps, save_move/play_move for reusable sequences) when helpful, but don\'t call tools every turn.'
    : 'There is no reliable game memory — judge everything from the image. You may use set_game_speed, is_stuck/is_trapped, or save_move/play_move when helpful, but don\'t call tools every turn.'}
${brainmapCtx}${cameraCtx}${brainCtx}${trustCtx}${rewardCtx}${depthCtx}${movementCtx}${planCtx}${lastActCtx}${preplanCtx}${memStateCtx}${motionCtx}${memoryCtx}${notesCtx}${instrCtx}${teachCtx}

${_cmdFormat === 'simple'
? `Reply in this SIMPLE LINE FORMAT (one field per line, NO JSON, NO markdown):
REGION: outside-castle | castle-foyer | in-level:<name> | unknown
SCENE: gameplay | title | file_select | demo | dialog
TARGET: what you're heading to + its grid cell
GOAL: your multi-turn plan
DO: step | step | step          (each step is "keys hold_ms" or a macro; keys joined by +)
SAY: short commentary (optional)
TRUST: 0-100 (optional — how much you trust the RL apprentice to take steps for you)
DONE: a milestone you just completed (optional, e.g. "entered castle")
Example:
REGION: castle-foyer
SCENE: gameplay
TARGET: Bob-omb painting (T cell)
GOAL: jump into the first painting
DO: left 350 | up 1500 | enter_painting
SAY: heading into my first level!`
: `Respond with ONLY valid JSON (no markdown fences):
{
  "region": "outside-castle | castle-foyer | in-level:<name> | unknown",
  "scene": "gameplay | title | file_select | demo | dialog",
  "target": "what I'm heading to + its grid cell, e.g. 'castle doors in TR cell'",
  "goal": "my multi-turn plan, e.g. 'cross the bridge and enter the castle doors'",
  "actions": [ {"keys":["ArrowLeft"], "hold_ms": 400}, {"keys":["ArrowUp"], "hold_ms": 1800}, "enter_painting" ],
  "thought": "where I am (region), target cell, which way I must turn, did last move work",
  "speech": "short streamer commentary (max 15 words) — omit if rapid_fire",
  "done": "a milestone I just completed, or null (e.g. 'entered castle')",
  "mistake": "error noticed or null",
  "notes": ["optional NEW insight — omit or [] if none"],
  "camera2d": false,
  "child_trust": "0-100, optional — how much you trust the RL apprentice to take steps for you; RAISE as it proves it can play, LOWER if it flails",
  "preplan": false,
  "rapid_fire": false
}`}

A "step"/group is {"keys":[...simultaneous...], "hold_ms": N} OR a macro word ("run_jump","enter_painting","long_jump","dive","triple_jump","ground_pound","wall_kick","back_up","turn_around","swim_up","backflip","wait","observe","king_bobomb"). The "wait"/"observe" macro presses NOTHING — use it to hold still and watch a moving platform/lift before committing. Hold guide: FORWARD/BACKWARD 1200–2500ms; TURN 250–500ms (short!); jump/dialog 150–350ms. In 2D/front-facing camera mode, treat ArrowLeft/ArrowRight as FORWARD travel (1200–2500ms), not turns. ${_preplanMode ? `PRE-PLAN: give a full ${capTxt}-step script.` : 'Normally 1–5 steps (more only if preplan:true).'}
Valid keys (THESE ARE THE ONLY ONES — there is no camera key): ArrowUp(forward), ArrowDown(BACKWARD — opposite of forward, USE IT), ArrowLeft(turn left), ArrowRight(turn right), jump(=A), action(=B: dive/punch/grab), crouch(=Z: ground-pound in air / long-jump), start(pause/confirm only). Combine arrows for diagonals.`;

        // Single-frame perception: the AI acts on ONE current frame, annotated
        // with a nav grid + compass. (The previous-frame comparison was removed —
        // it confused the model into acting on the old frame; an objective motion
        // % is fed in TEXT instead, which is clearer and cheaper.)
        let visionImg = screenshot;
        const promptText = 'This is the CURRENT live frame, overlaid with a faint 3×3 navigation grid (cells TL/T/TR · L/C/R · BL/B/BR) and a camera-relative compass marking which arrow key moves Mario which way on screen. First identify the region (outside-castle / castle-foyer / in-level:<name>) and camera mode (normal vs 2D/front-facing/side-view). If it is 2D, set camera2d:true and use ArrowLeft/ArrowRight as your main travel directions. Then name the grid cell your target is in and choose your actions.';
        try {
            visionImg = await annotateCurrentFrame(screenshot);
        } catch (e) {
            visionImg = screenshot;   // annotate failed — use the raw current frame
        }
        setAIVisionFrame(visionImg);   // mirror exactly what the AI sees into streamer mode
        const userMessage = {
            role: 'user',
            content: [
                { type: 'text', text: promptText },
                { type: 'image_url', image_url: { url: visionImg } },
            ],
        };

        // Pre-plan scripts can be long — give the model room for the whole sequence.
        const maxTokens = _preplanMode
            ? Math.min(2000, 500 + (_preplanCap > 0 ? _preplanCap : 40) * 25)
            : 400;
        const rawContent = await callChatWithTools([
            { role: 'system', content: systemPrompt },
            userMessage,
        ], { json: _cmdFormat !== 'simple', max_tokens: maxTokens });

        const response = parseAIResponse(rawContent);

        // 🤝 PARENT SETS THE CHILD'S TRUST. The parent (LLM) grades the apprentice
        // and decides how much to trust it (child_trust 0-100). Trust controls how
        // often the child is allowed to take a step. Blended (EMA) so it's steady.
        if (_adaptiveBrain && response) {
            const ct = response.child_trust ?? response.trust ?? response.trust_child;
            if (ct != null && ct !== '') {
                let v = (typeof ct === 'string') ? parseFloat(ct) : ct;
                if (Number.isFinite(v)) { if (v > 1) v /= 100; _setChildTrust(_childTrust * 0.7 + Math.max(0, Math.min(1, v)) * 0.3); }
                else if (/up|rais|more|promote|trust/i.test(String(ct))) _setChildTrust(_childTrust + 0.08);
                else if (/down|low|less|distrust|demote/i.test(String(ct))) _setChildTrust(_childTrust - 0.08);
            }
        }

        // The child (RL) steps in — but only as far as the parent TRUSTS it. Early
        // on (low trust) it only helps when the parent is stuck; as trust grows the
        // parent hands the controller down more and more often. It always defers to
        // the knowledgeable parent unless it has genuinely learned better here.
        if (_adaptiveBrain && response?.actions?.length) {
            const ov = _brainOverride(response, _curStateKey || _brainState());
            if (ov) {
                response.actions = ov.actions;
                response._override = ov;
                _trainStats.overrides++; _saveTrainStats();
                if (typeof pushChatlog === 'function')
                    pushChatlog(`<span class="cl-cmd">🧒 apprentice takes a step (trust ${Math.round(_childTrust * 100)}%) — parent's "${_esc(ov.from)}" keeps failing here; child has learned "${_esc(ov.cat)}" works</span>`, 'cl-tool');
            }
        }

        // Adaptive brain: remember (state, action) so we can reward it next turn.
        // (Uses the FINAL actions — if the child overrode, we credit what actually ran,
        // and flag it so trust can react to the child's OWN track record when playing.)
        if (_adaptiveBrain && response?.actions?.length) {
            _pendingLearn = { stateKey: _curStateKey || _brainState(), actionCat: _actionCat(response.actions), wasOverride: !!response._override };
        }

        // Persist the multi-turn plan for navigation continuity. Keep pursuing the
        // same goal across turns; only reset the age-counter when it genuinely changes.
        const newGoal = (response.goal || '').trim();
        if (newGoal) {
            if (newGoal !== _aiGoal) { _aiGoal = newGoal; _aiGoalAge = 0; }
            else _aiGoalAge++;
        } else if (_aiGoal) {
            _aiGoalAge++;   // model didn't restate it — assume it's still in effect
        }

        // ── Scene history tracking ──
        const sceneEntry = { region: (response.region || '').trim().toLowerCase(), scene: (response.scene || '').trim().toLowerCase(), time: Date.now() };
        _sceneHistory.push(sceneEntry);
        while (_sceneHistory.length > SCENE_HISTORY_MAX) _sceneHistory.shift();

        // ── Brainmap updates: where am I, what have I accomplished ──
        const GAMEPLAY_REGION = /outside-castle|castle-foyer|in-level/;
        const newRegion = (response.region || '').trim().toLowerCase();
        if (newRegion && newRegion !== 'unknown') {
            if (newRegion !== _region) {
                // Region CHANGED. If we were in a level and the scene also just cut
                // hard, that's most likely a DEATH or level-exit (the death screen
                // flashes by too fast to catch) — log the inference so the model
                // re-orients instead of acting on stale assumptions.
                if (/in-level/.test(_region) && _sceneCutCount >= 1 && !GAMEPLAY_REGION.test(newRegion)) {
                    _progressLog.push(`left ${_region} (died or exited?) — re-assessing`);
                    _bmEvent('event', `left ${_region} — died/exited?`);
                }
                _region = newRegion; _regionAge = 0;
                _progressLog.push(`entered ${newRegion}`);
                _bmEvent('region', `entered ${newRegion}`);
                // Self-training: record the furthest the child has ever gotten.
                if (_regionRank(newRegion) > _trainStats.bestRegionRank) {
                    _trainStats.bestRegionRank = _regionRank(newRegion); _saveTrainStats();
                }
            } else _regionAge++;
        } else _regionAge++;

        // ── Goal persistence: don't let the AI abandon goals too easily ──
        if (newGoal) {
            if (newGoal !== _aiGoal) {
                _goalAbandonCount++;
                // If the AI keeps flip-flopping goals, force it to stick to one
                if (_goalAbandonCount >= 3) {
                    updateAIStatus('⚠️ Goal flip-flopping detected — forcing persistence');
                    _goalAbandonCount = 0;
                }
            } else {
                _goalAbandonCount = Math.max(0, _goalAbandonCount - 1);
            }
        }
        // Milestones the model reports completing this turn
        const done = response.done || response.progress;
        if (done && typeof done === 'string' && done.trim()) {
            const d = done.trim();
            if (!_progressLog.includes(d)) { _progressLog.push(d); _bmEvent('done', d); }
        }
        if (Array.isArray(response.done)) for (const d of response.done) {
            if (d && !_progressLog.includes(d)) { _progressLog.push(String(d)); _bmEvent('done', String(d)); }
        }
        while (_progressLog.length > 12) _progressLog.shift();

        // ── Camera-perspective updates: 2D / front-facing / side-view ──
        if (typeof response.camera2d === 'boolean') {
            if (response.camera2d && !_camera2d) updateAIStatus('🎥 2D camera detected — switching to left/right movement');
            _camera2d = response.camera2d;
        }
        updateAIStateBadges();
        // Optional checklist the model maintains
        if (Array.isArray(response.checklist)) _checklist = response.checklist.slice(0, 8);
        saveBrainmap();        // persist if enabled
        updateBrainmapViz();   // refresh the live visualizer

        const thoughtLine = response.target
            ? `🎯 ${response.target} — ${response.thought || ''}`
            : `💭 ${response.thought}`;
        updateAIStatus(thoughtLine);
        logReasoning(response.thought, response.speech);   // feed the streamer thought-stream
        // AI-TEACH: push teaching reasoning to the chatlog so the user sees what the child learns
        if (_playMode === 'ai-teach' && response.thought) {
            pushChatlog(`<span class="cl-cmd">👨‍🏫 Teaching: ${_esc(response.thought)}</span>`, 'cl-tool');
        }
        _consecutiveErrors = 0;
        recordUsage();   // sample pollen spend for the energy bar / usage log

        // Remember this turn so the next one can sense movement/direction.
        _prevScreenshot = screenshot;       // null in memory-only mode (fine)
        _prevGameState  = gameState;

        // Burn down the post-rapid-fire escape-unlock window (one per normal turn)
        if (!_rapidFireActive && _escapeExtraTurns > 0) _escapeExtraTurns--;

        if (response.mistake && response.mistake !== 'null' && response.mistake !== null) {
            aiMemory.push(response.mistake);
            if (aiMemory.length > 20) aiMemory.shift();
        }

        // Live study notes the AI jots down mid-play (deduped, capped)
        if (Array.isArray(response.notes)) {
            for (const note of response.notes) {
                const n = (note || '').trim();
                if (n && n.length > 4 && !aiNotes.includes(n)) aiNotes.push(n);
            }
            while (aiNotes.length > 30) aiNotes.shift();
        }

        // Handle rapid-fire mode toggle — ignored while the user forces turbo
        if (!_turboMode) {
            if (response.rapid_fire === true && !_rapidFireActive) {
                enterRapidFire();
            } else if (response.rapid_fire === false && _rapidFireActive) {
                exitRapidFire();
            }
        }

        // AI speech: skip in rapid-fire mode, otherwise queue without overlap
        if (response.speech && !_rapidFireActive) {
            if (tts.isPlaying) {
                tts.drain();   // clear queue but let current finish
                tts.speak(response.speech);
            } else {
                tts.speak(response.speech);
            }
        }

        _isThinking = false;
        return response;

    } catch (err) {
        console.error('AI think error:', err);
        _consecutiveErrors++;
        updateAIStatus(`❌ ${err.message}`);
        if (_consecutiveErrors >= MAX_ERRORS_BEFORE_BACKOFF) {
            updateAIStatus(`⚠ ${_consecutiveErrors} errors — backing off`);
            tts.speak('Having trouble thinking. Backing off for a bit.');
        }
        _isThinking = false;
        return null;
    }
}

// ────────────────────────────────────────────────────────────
// 16. AI EXECUTE
// ────────────────────────────────────────────────────────────
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

// Normalize an action group into { keys:[...], ms } so the AI can chain
// simultaneous keys AND control how LONG each is held. Sustained holds are the
// single biggest reason the original version travelled further — brief taps
// barely move Mario, so movement defaults to a long hold.
function _normalizeGroup(g, fast, camera2d = false) {
    let keys = [], ms = null;
    if (Array.isArray(g)) keys = g;
    else if (g && typeof g === 'object') { keys = g.keys || g.actions || []; ms = g.hold_ms ?? g.ms ?? g.duration ?? null; }
    else if (typeof g === 'string') keys = [g];
    const rawKeys = Array.isArray(keys) ? keys : [keys];
    // A WAIT/OBSERVE/DELAY group presses nothing — it just holds still for ms so the AI
    // can watch a moving platform's cycle or insert a deliberate pause between moves.
    // Delay is a REAL action: it schedules a gap before the NEXT action executes.
    if (rawKeys.some(k => k === '_wait' || k === 'wait' || k === 'observe' || k === 'delay')) {
        const wms = (ms == null ? 700 : ms);
        return { keys: [], ms: Math.max(200, Math.min(5000, wms)) / gameSpeed, wait: true };
    }
    keys = rawKeys.filter(k => keyMap[k]);
    // Resolve to physical key CODES so aliases ("up", "forward") classify correctly.
    const codes = keys.map(k => keyMap[k]);
    // Smarter movement defaults when the model omits hold_ms:
    //  • FORWARD/back travel → long hold so Mario actually covers ground.
    //  • TURN-ONLY (Left/Right, no Up/Down) → short tap so he re-aims without
    //    spinning past the target.   • jumps / actions → brief press.
    //  • In 2D/front-facing camera mode, Left/Right ARE the travel directions,
    //    so they get long holds just like forward in normal mode.
    const hasVertical = codes.includes('ArrowUp') || codes.includes('ArrowDown');
    const hasLeftRight = codes.includes('ArrowLeft') || codes.includes('ArrowRight');
    const is2DTravel = camera2d && hasLeftRight && !hasVertical;
    const isTurnOnly = !hasVertical && !is2DTravel && hasLeftRight;
    if (ms == null) {
        if (hasVertical || is2DTravel) ms = fast ? 750 : 1400;
        else if (isTurnOnly)           ms = fast ? 240 : 380;
        else                           ms = fast ? 150 : 240;
    }
    // Clamp: turns get a tighter ceiling so the AI can't accidentally spin in circles.
    // Forward/back travel gets a generous ceiling — the AI needs time to cross open ground.
    const maxMs = isTurnOnly ? (fast ? 700 : 900) : (fast ? 1800 : 8000);
    ms = Math.max(80, Math.min(maxMs, ms));
    return { keys, ms: ms / gameSpeed, wait: false };
}

let _lastActions = null;        // last sequence executed (for save_move/play_move)
let _lastActionSummary = '';    // human-readable form of it, fed back to the model

// Render an action sequence as "ArrowLeft 400ms → ArrowUp 1800ms" for the prompt
function _summarizeActions(groups) {
    return (groups || []).map(g => {
        let keys = Array.isArray(g) ? g : (g && (g.keys || g.actions)) || (typeof g === 'string' ? [g] : []);
        keys = (Array.isArray(keys) ? keys : [keys]).filter(k => keyMap[k]);
        if (!keys.length) return null;
        const ms = (g && typeof g === 'object' && !Array.isArray(g)) ? (g.hold_ms ?? g.ms ?? g.duration) : null;
        return ms ? `${keys.join('+')} ${ms}ms` : keys.join('+');
    }).filter(Boolean).join(' → ');
}

// Is this turn a pre-plan (mini-TAS) run? Either the user forces it, or the AI
// opted in by returning preplan:true.
function _isPreplan(response) {
    return _preplanMode || response?.preplan === true;
}

// ── MACRO MOVES ───────────────────────────────────────────────────────
// Named composite moves so the model can emit ONE token (e.g. "run_jump")
// instead of hand-building multi-key arrays it usually gets wrong. Each expands
// into a sequence of simultaneous-key groups (this is also where "simultaneous
// controls" really matter — e.g. a long jump is Up+crouch+jump at once).
const _MACROS = {
    // Run a solid distance FIRST (so there's real speed), then jump at the end.
    run_jump:       [{ keys: ['ArrowUp'], hold_ms: 900 }, { keys: ['ArrowUp', 'jump'], hold_ms: 320 }],
    long_jump:      [{ keys: ['ArrowUp'], hold_ms: 750 }, { keys: ['ArrowUp', 'crouch', 'jump'], hold_ms: 340 }],
    dive:           [{ keys: ['ArrowUp'], hold_ms: 550 }, { keys: ['ArrowUp', 'action'], hold_ms: 320 }],
    // Run well into the painting, then jump into it.
    enter_painting: [{ keys: ['ArrowUp'], hold_ms: 1000 }, { keys: ['ArrowUp', 'jump'], hold_ms: 360 }],
    jump_forward:   [{ keys: ['ArrowUp', 'jump'], hold_ms: 340 }],
    triple_jump:    [{ keys: ['ArrowUp', 'jump'], hold_ms: 280 }, { keys: ['ArrowUp', 'jump'], hold_ms: 280 }, { keys: ['ArrowUp', 'jump'], hold_ms: 360 }],
    backflip:       [{ keys: ['crouch'], hold_ms: 130 }, { keys: ['jump'], hold_ms: 280 }],
    // Ground pound: jump up, then crouch (Z) in the air to slam straight down.
    ground_pound:   [{ keys: ['jump'], hold_ms: 260 }, { keys: ['crouch'], hold_ms: 320 }],
    // Wall kick: jump toward a wall, then jump again off it to gain height.
    wall_kick:      [{ keys: ['ArrowUp', 'jump'], hold_ms: 260 }, { keys: ['jump'], hold_ms: 280 }],
    turn_around:    [{ keys: ['ArrowDown'], hold_ms: 500 }],
    back_up:        [{ keys: ['ArrowDown'], hold_ms: 700 }],
    // Patience primitive — hold STILL and watch (no keys pressed). Essential vs
    // moving platforms/lifts/rotating bridges: wait for one to line up next to you
    // instead of chasing it or mis-timing a jump. The RL brain rewards this when
    // chasing keeps failing.
    wait:           [{ keys: ['_wait'], hold_ms: 700 }],
    observe:        [{ keys: ['_wait'], hold_ms: 950 }],
    // Surface in water: hold DOWN (aims Mario UP) and stroke with jump.
    swim_up:        [{ keys: ['ArrowDown', 'jump'], hold_ms: 220 }, { keys: ['ArrowDown', 'jump'], hold_ms: 220 }, { keys: ['ArrowDown', 'jump'], hold_ms: 220 }],
    // SMART RECOVERY: when the ai is stuck, auto-run this sequence
    recover:        [{ keys: ['ArrowDown'], hold_ms: 600 }, { keys: ['ArrowLeft'], hold_ms: 400 }, { keys: ['ArrowUp'], hold_ms: 1200 }],
    // KING BOB-OMB: approach, loop around behind him, then grab fast.
    king_bobomb:    [{ keys: ['ArrowUp'], hold_ms: 350 }, { keys: ['ArrowLeft'], hold_ms: 700 }, { keys: ['ArrowUp', 'action'], hold_ms: 300 }],
    // START GAME: full bootstrap from title screen to first level
    start_game:     [{ keys: ['start'], hold_ms: 200 }, { keys: ['_wait'], hold_ms: 800 }, { keys: ['start'], hold_ms: 200 }, { keys: ['_wait'], hold_ms: 800 }, { keys: ['jump'], hold_ms: 200 }, { keys: ['_wait'], hold_ms: 1200 }, { keys: ['ArrowUp'], hold_ms: 2500 }, { keys: ['ArrowUp'], hold_ms: 1500 }, { keys: ['enter_painting'], hold_ms: 1400 }],
};
function _macroName(g) {
    let s = null;
    if (typeof g === 'string') s = g;
    else if (g && typeof g === 'object' && g.move) s = g.move;
    return s ? String(s).toLowerCase().trim().replace(/[\s-]+/g, '_') : null;
}
// Replace any macro entries with their expanded group sequences.
function _expandGroups(groups) {
    const out = [];
    for (const g of (groups || [])) {
        const m = _macroName(g);
        if (m && _MACROS[m]) out.push(..._MACROS[m].map(x => ({ ...x })));
        else out.push(g);
    }
    return out;
}

// ── COMMAND PARSING (JSON  +  simple-text fallback) ──────────────────
// Weak models routinely produce broken JSON. The "simple" format is line-based
// and far easier for them. We parse whichever, and cross-fall-back on failure.
//
// SIMPLE format example:
//   REGION: castle-foyer
//   TARGET: bob painting (T cell)
//   GOAL: jump into the first painting
//   DO: up 1500 | left 350 | enter_painting
//   SAY: heading into the painting!
//   DONE: entered the castle
function _parseStep(tok) {
    // "up+jump 300" → {keys:['ArrowUp','jump'], hold_ms:300};  "run_jump" → macro string
    // "up 2000 delay 500" → {keys:['ArrowUp'], hold_ms:2000, delay_before_ms:500}
    tok = tok.trim();
    if (!tok) return null;
    // Check for delay syntax: "action 1500 delay 300" or "action delay 300"
    const delayMatch = tok.match(/^(.*?)\s+(?:delay|wait|pause)\s+(\d{2,5})\s*$/i);
    const delayBefore = delayMatch ? parseInt(delayMatch[2], 10) : null;
    const tokWithoutDelay = delayMatch ? delayMatch[1].trim() : tok;
    
    const m = tokWithoutDelay.match(/^(.*?)(?:\s+(\d{2,5}))?$/);
    const keysPart = (m?.[1] || tokWithoutDelay).trim();
    const ms = m?.[2] ? parseInt(m[2], 10) : null;
    const lower = keysPart.toLowerCase().replace(/[\s-]+/g, '_');
    if (_MACROS[lower]) {
        const macro = _MACROS[lower];
        // If it's just a macro name with no delay, return the name
        if (!delayBefore) return lower;
        // If there's a delay, expand the macro and add delay to first step
        return macro.map((step, i) => i === 0 ? { ...step, delay_before_ms: delayBefore } : { ...step });
    }
    const keys = keysPart.split(/[+&]/).map(k => k.trim()).filter(k => keyMap[k] || keyMap[k.toLowerCase()]);
    if (!keys.length) return null;
    const norm = keys.map(k => (keyMap[k] ? k : k.toLowerCase()));
    const result = ms ? { keys: norm, hold_ms: ms } : { keys: norm };
    if (delayBefore) result.delay_before_ms = delayBefore;
    return result;
}
function parseSimpleCommands(text) {
    const out = { actions: [] };
    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.trim();
        const mm = line.match(/^([A-Za-z_]+)\s*[:=]\s*(.*)$/);
        if (!mm) continue;
        const key = mm[1].toUpperCase(); const val = mm[2].trim();
        if (key === 'DO' || key === 'ACTIONS' || key === 'MOVE' || key === 'MOVES') {
            out.actions = val.split('|').map(_parseStep).filter(Boolean);
        } else if (key === 'REGION') out.region = val;
        else if (key === 'TARGET') out.target = val;
        else if (key === 'GOAL') out.goal = val;
        else if (key === 'SAY' || key === 'SPEECH') out.speech = val;
        else if (key === 'THOUGHT' || key === 'THINK') out.thought = val;
        else if (key === 'DONE' || key === 'PROGRESS') out.done = val;
        else if (key === 'PREPLAN') out.preplan = /true|yes|1/i.test(val);
        else if (key === 'TRUST') out.child_trust = parseFloat(val);
        else if (key === 'SCENE') out.scene = val;
    }
    if (!out.thought) out.thought = out.target || 'acting';
    return out;
}
// Unified parse: prefer the requested format, fall back to the other.
function parseAIResponse(raw) {
    const clean = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const tryJson = () => { const r = JSON.parse(clean); if (!r || typeof r !== 'object') throw 0; return r; };
    const trySimple = () => { const r = parseSimpleCommands(clean); if (!r.actions?.length && !r.scene && !r.region) throw 0; return r; };
    const order = _cmdFormat === 'simple' ? [trySimple, tryJson] : [tryJson, trySimple];
    for (const fn of order) { try { return fn(); } catch {} }
    // Last resort: pull a JSON object substring if the model wrapped it in prose
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    throw new Error('Could not parse model reply');
}

async function aiExecute(response) {
    if (!response?.actions?.length) return;
    let groups = _expandGroups(response.actions);   // turn macros into key-groups
    const preplan = _isPreplan(response);

    if (preplan) {
        // Mini-TAS: run the whole scripted sequence this turn (capped unless the
        // user chose unlimited). Auto-aborts on player input / dramatic change.
        if (_preplanCap > 0) groups = groups.slice(0, _preplanCap);
    } else if (_turboMode && _turboCfg.multi) {
        // Turbo "multi-request gameplay": execute only the FIRST group, then
        // re-think immediately so the AI can correct itself mid-sequence.
        groups = groups.slice(0, 1);
    }

    _lastActions = response.actions;
    _lastActionSummary = _summarizeActions(groups);
    updateAIStatus(preplan
        ? `🧠 Pre-plan: running ${groups.length}-step script…`
        : `🎮 Executing ${groups.length} action group${groups.length > 1 ? 's' : ''}…`);

    const fast = _turboMode || _rapidFireActive;

    // ── AUTO-RECOVERY: if the AI is stuck, override with a smart recovery sequence ──
    // This happens BEFORE executing the AI's chosen actions, so we can save it from itself.
    if (_stuckCount >= 3 && !preplan) {
        updateAIStatus('🔄 Auto-recovery: AI is stuck — running recovery sequence');
        const recoverGroups = _expandGroups(['recover']);
        for (const rg of recoverGroups) {
            const { keys, ms, wait } = _normalizeGroup(rg, fast, _camera2d);
            if (!wait && !keys.length) continue;
            for (const action of keys) {
                const keyCode = keyMap[action];
                if (keyCode) simulateKeyPress(keyCode, Math.max(70, ms * 0.92));
            }
            await delay(ms);
        }
        _stuckCount = 0;   // reset after recovery attempt
        updateAIStatus('✅ Recovery done — resuming normal play');
        // Don't also run the AI's original (probably wrong) actions
        return;
    }

    // ── AUTO-START-GAME: detect title/demo screen and run the full bootstrap ──
    // This helps the AI get past the title screen reliably without hallucinating.
    // We are VERY conservative: a single false "demo" classification during gameplay
    // would press Start and pause/ruin the run, so require near-unanimous evidence.
    const GAMEPLAY_REGION = /outside-castle|castle-foyer|in-level/;
    const recent = _sceneHistory.slice(-5);
    const allTitleOrDemo = recent.length >= 4 && recent.every(s => s.scene === 'title' || s.scene === 'demo' || s.scene === 'file_select');
    const noRecentGameplay = !_sceneHistory.some(s => GAMEPLAY_REGION.test(s.region) && Date.now() - s.time < 12000);
    if (allTitleOrDemo && noRecentGameplay && !preplan && Date.now() - _lastBootstrapTime > 10000) {
        _lastBootstrapTime = Date.now();
        updateAIStatus('🎮 Auto-start: detected title/demo — running full bootstrap');
        const startGroups = _expandGroups(['start_game']);
        for (const sg of startGroups) {
            const { keys, ms, wait } = _normalizeGroup(sg, fast, _camera2d);
            if (!wait && !keys.length) continue;
            for (const action of keys) {
                const keyCode = keyMap[action];
                if (keyCode) simulateKeyPress(keyCode, Math.max(70, ms * 0.92));
            }
            await delay(ms);
        }
        updateAIStatus('✅ Bootstrap done — should be in gameplay now');
        return;
    }

    // Scene-change watchdog: in pre-plan (outside turbo) we snapshot between steps
    // and bail out if the view changes drastically (fell, warped, entered water).
    const watch = preplan && !_turboMode;
    let watchFrame = watch ? await captureScreen(aiStream).catch(() => null) : null;

    // Build the action queue with optional delays between steps
    for (let i = 0; i < groups.length; i++) {
        if (!aiPlayerActive) break;
        if (preplan && playerMovementDetected) { updateAIStatus('✋ Pre-plan aborted — you took control'); break; }
        
        const g = groups[i];
        // Support delay_before_ms on individual action groups
        const delayBefore = (g && typeof g === 'object' && !Array.isArray(g)) ? (g.delay_before_ms || 0) : 0;
        const { keys, ms, wait } = _normalizeGroup(g, fast, _camera2d);
        if (!wait && !keys.length) continue;
        
        // Enqueue this action with its delay
        _actionQueue.push({ keys, ms, wait, delayBefore, description: wait ? 'wait' : keys.join('+') });
    }
    
    // Execute the queue with proper delays between actions
    await _runActionQueue(fast, watch, watchFrame);
}

// ── ACTION QUEUE RUNNER — execute queued actions with delays between them ──
async function _runActionQueue(fast, watch, initialWatchFrame) {
    if (_queueRunning) return;   // don't overlap
    _queueRunning = true;
    let watchFrame = initialWatchFrame;
    
    try {
        while (_actionQueue.length > 0 && aiPlayerActive) {
            const action = _actionQueue.shift();
            
            // Wait for the delay_before_ms if specified
            if (action.delayBefore > 0) {
                updateAIStatus(`⏳ Waiting ${Math.round(action.delayBefore)}ms before next action…`);
                await delay(action.delayBefore / gameSpeed);
            }
            
            if (!aiPlayerActive) break;
            
            // Execute the action
            if (!action.wait) {
                for (const key of action.keys) {
                    const keyCode = keyMap[key];
                    if (keyCode) simulateKeyPress(keyCode, Math.max(70, action.ms * 0.92));
                }
            }
            updateAIStatus(`${action.wait ? '⏳' : '🎮'} ${action.description} (${Math.round(action.ms)}ms)`);
            await delay(action.ms);
            
            // Watchdog between steps
            if (watch && _actionQueue.length > 0) {
                const nowFrame = await captureScreen(aiStream).catch(() => null);
                if (nowFrame && watchFrame) {
                    const d = await _frameDiffScore(watchFrame, nowFrame);
                    if (d != null && d > 0.6) { 
                        updateAIStatus('🛑 Big change mid-plan — clearing remaining queue');
                        _actionQueue = [];   // clear remaining actions
                        break; 
                    }
                }
                if (nowFrame) watchFrame = nowFrame;
            }
        }
    } finally {
        _queueRunning = false;
        updateAIStatus('✅ Done');
    }
}

let _busyCycle = false;   // prevents a new think starting while still executing
async function aiThinkAndAct() {
    if (!aiPlayerActive || _busyCycle) return;
    _busyCycle = true;
    try {
        const resp = await aiThink();
        if (resp && aiPlayerActive) await aiExecute(resp);
        updateDebugHUD();   // refresh the debug panel after each decision
    } finally {
        _busyCycle = false;
    }
}

// ── Rapid-fire mode ─────────────────────────────────────────────────
function enterRapidFire() {
    if (_rapidFireActive) return;
    _rapidFireActive = true;
    _rapidFireTurns  = 0;
    tts.silence(true);  // kill TTS immediately

    // Clear normal loop, start fast loop
    if (aiInterval) { clearInterval(aiInterval); aiInterval = null; }
    if (_rapidFireInterval) { clearInterval(_rapidFireInterval); }

    // Show indicator
    const ind = document.getElementById('rapid-fire-indicator');
    if (ind) ind.classList.add('active');
    updateAIStatus('⚡ RAPID FIRE — locked in');

    _rapidFireInterval = setInterval(async () => {
        if (!aiPlayerActive || !_rapidFireActive || _isThinking) return;
        _rapidFireTurns++;
        if (_rapidFireTurns >= RAPID_FIRE_MAX_TURNS) {
            exitRapidFire();
            return;
        }
        const ind2 = document.getElementById('rapid-fire-indicator');
        if (ind2) ind2.querySelector('.rf-turns').textContent = `${_rapidFireTurns}/${RAPID_FIRE_MAX_TURNS}`;
        await aiThinkAndAct();
    }, RAPID_FIRE_INTERVAL_MS);
}

function exitRapidFire() {
    if (!_rapidFireActive) return;
    _rapidFireActive = false;
    _rapidFireTurns  = 0;
    tts.silence(false); // re-enable TTS

    if (_rapidFireInterval) { clearInterval(_rapidFireInterval); _rapidFireInterval = null; }

    // If this rapid-fire was an escape recovery, keep cheats unlocked 5 more turns
    if (_escapeArmed) { _escapeExtraTurns = 5; _escapeArmed = false; }

    // Hide indicator
    const ind = document.getElementById('rapid-fire-indicator');
    if (ind) ind.classList.remove('active');

    // Resume normal loop if AI player is still active
    if (aiPlayerActive && aiMode === 'auto') scheduleAILoop();
    tts.speak('Rapid fire mode ended. Back to normal pace.');
    updateAIStatus('✅ Rapid fire ended — resuming normal loop');
}

function scheduleAILoop() {
    if (_turboMode) { startTurboLoop(); return; }   // turbo replaces the normal loop
    const cycle = Math.max(MIN_THINK_INTERVAL_MS, 8000 / gameSpeed);
    aiInterval  = setInterval(async () => {
        if (!aiPlayerActive || _isThinking || _rapidFireActive) return;
        await aiThinkAndAct();
    }, cycle);
}

// ────────────────────────────────────────────────────────────
// 17. TOGGLE AI PLAYER
// ────────────────────────────────────────────────────────────
async function toggleAIPlayer() {
    if (!aiPlayerActive) {
        // Source of truth for the mode is the dropdown's CURRENT value at press time
        // (don't rely only on the change event having fired).
        const _modeSel = document.getElementById('play-mode');
        if (_modeSel && ['ai', 'rl', 'player-teach', 'ai-teach'].includes(_modeSel.value)) {
            _playMode = _modeSel.value;
            try { localStorage.setItem('sm64_play_mode', _playMode); } catch {}
        }
    }

    // Every mode EXCEPT pure RL Play needs the Pollinations LLM (parent/grading).
    if (_playMode !== 'rl' && !getActiveKey()) {
        document.getElementById('auth-overlay').classList.remove('hidden');
        return;
    }

    if (!aiPlayerActive) {
        try {
            aiStream = await acquireVisionStream(5);
            if (!aiStream) throw new Error('no stream');
        } catch {
            tts.interrupt(_visionSource === 'screen'
                ? 'Screen sharing was denied. Please try again and select the window showing the game.'
                : 'Could not capture the game canvas. Try switching the vision source to screen-share in API settings.');
            return;
        }

        aiPlayerActive = true;
        _consecutiveErrors = 0;
        _lastFrameHash = null;
        _identicalFrameCount = 0;
        _lastStateHash = null;
        _identicalStateCount = 0;
        _prevScreenshot = null;
        _prevGameState  = null;
        _stuckCount     = 0;
        _demoConfidence = 0;
        _sceneCutCount  = 0;
        _lastBootstrapTime = 0;
        _sceneHistory   = [];
        _goalAbandonCount = 0;
        _aiGoal         = '';
        _aiGoalAge      = 0;
        _lastActions    = null;
        _lastActionSummary = '';
        _pendingLearn   = null;     // fresh RL episode — no stale reward/feedback
        _lastReward     = null;
        _lastBrainActionCat = null;
        _eligTrace      = [];
        if (_adaptiveBrain) { _trainStats.episodes++; _saveTrainStats(); }
        startElderWatch();          // child watches when YOU (the elder) take over
        _resetBrainmap();
        updateAIStateBadges();
        _frameHistory   = [];
        _escapeArmed      = false;
        _escapeExtraTurns = 0;
        clearChatlog();
        aiStream.getVideoTracks()[0].addEventListener('ended', stopAIPlayer);

        // Auto-study the guide before playing (once), in the background. RL Play uses
        // no LLM, so it skips this.
        if (_playMode !== 'rl' && aiNotes.length === 0 && getActiveKey()) {
            updateAIStatus('📚 Studying the guide before playing…');
            runStudy({ silent: true }).catch(() => {});
        }

        _startSelectedMode();

    } else {
        (_playMode === 'ai' && aiMode === 'manual') ? handleManualModeClick() : stopAIPlayer();
    }
}

// Route the play button to whatever mode is selected.
function _startSelectedMode() {
    aiBtn.classList.add('active');
    aiBtn.textContent = '⏹ Stop';
    if (_playMode === 'rl') {
        if (!_adaptiveBrain) setAdaptiveBrain(true);   // RL Play IS the learner — it must be on to learn
        updateAIStatus('🧒 RL Player — the child plays on its own (no LLM: free, fast, reactive)');
        tts.speak('R L player active. The child is playing on its own.');
        _showRatingWidget(true);                 // rate its run any time
        updateDebugHUD(); scheduleRLLoop(); rlThinkAndAct();
        return;
    }
    if (_playMode === 'player-teach') {
        // These two are REQUIRED for teaching to work, so force them on:
        // Agent-Only would block your keyboard; the learner must be enabled to grade.
        if (_agentOnly) setAgentOnly(false);
        if (!_adaptiveBrain) setAdaptiveBrain(true);
        if (!_elderLearn) setElderLearn(true);
        updateAIStatus('🧓 Player-Teach — YOU play; the child watches & learns from you. (Enable AI grading in settings to also have the LLM grade you.) Click the game!');
        tts.speak('Player teach mode. You play. The child will watch and learn from you.');
        _showElderBanner(true);
        updateDebugHUD();
        return;                                  // no LLM play loop — elder watch + grading do the work
    }
    // 'ai' or 'ai-teach' → the parent LLM plays
    if (_playMode === 'ai' && aiMode === 'manual') {
        aiManualState = 'idle';
        aiBtn.textContent = '🧠 Think';
        updateAIStatus('🤖 Manual Mode — press to think');
        return;
    }
    const teach = _playMode === 'ai-teach';
    updateAIStatus(teach ? '👨‍🏫 AI-Teach — the parent plays and trains the child (no takeovers)'
                         : (_turboMode ? '⚡ Turbo AI — going as fast as possible' : '🤖 AI Player Active'));
    tts.speak(teach ? 'A I teach mode. I will play and teach the child.'
                    : (_turboMode ? 'Turbo A I active.' : 'A I player activated.'));
    scheduleAILoop();
    if (_turboMode && _turboCfg.live) startLiveLoop();
    updateDebugHUD();
    aiThinkAndAct();
}

async function handleManualModeClick() {
    if (aiManualState === 'idle') {
        aiManualState = 'thinking';
        aiBtn.textContent = '⏳ Thinking…';
        aiBtn.disabled    = true;
        aiPlannedActions  = await aiThink();
        if (aiPlannedActions) {
            aiManualState = 'ready';
            aiBtn.textContent = '▶ Execute';
            aiBtn.disabled    = false;
            updateAIStatus('✅ Plan ready — press to execute');
        } else {
            aiManualState = 'idle';
            aiBtn.textContent = '🧠 Think';
            aiBtn.disabled    = false;
        }
    } else if (aiManualState === 'ready') {
        aiManualState = 'executing';
        aiBtn.textContent = '⏹ Stop';
        await aiExecute(aiPlannedActions);
        aiManualState = 'idle';
        aiBtn.textContent = '🧠 Think';
        updateAIStatus('💤 Idle — press to think again');
    } else if (aiManualState === 'executing') {
        stopAIPlayer();
    }
}

function stopAIPlayer() {
    aiPlayerActive = false;
    _isThinking    = false;

    // Clean up rapid-fire mode
    if (_rapidFireActive) {
        _rapidFireActive = false;
        _rapidFireTurns  = 0;
        if (_rapidFireInterval) { clearInterval(_rapidFireInterval); _rapidFireInterval = null; }
        const ind = document.getElementById('rapid-fire-indicator');
        if (ind) ind.classList.remove('active');
        tts.silence(false);
    }

    if (aiStream)      { aiStream.getTracks().forEach(t => t.stop()); aiStream = null; }
    if (aiInterval)    { clearInterval(aiInterval); aiInterval = null; }
    stopTurboLoop();
    stopLiveLoop();
    stopElderWatch();
    stopRealtimeRL();
    _showoffRunning = false; _showoffBuffer = [];
    _showElderBanner(false); _showRatingWidget(false);
    if (_captureVideo) { _captureVideo.srcObject = null; }
    // Free frame buffers so a long session doesn't pile up base64 strings
    _frameHistory = [];
    _prevScreenshot = null;
    _aiGoal           = '';
    _aiGoalAge        = 0;
    _lastActions      = null;
    _lastActionSummary = '';
    _actionQueue      = [];     // clear any pending actions
    _queueRunning     = false;
    _sceneHistory     = [];     // clear scene history
    _goalAbandonCount = 0;
    _resetBrainmap();
    _escapeArmed      = false;
    _escapeExtraTurns = 0;
    aiManualState    = 'idle';
    aiPlannedActions = null;
    aiBtn.textContent = '▶ Start';
    aiBtn.classList.remove('active');
    aiBtn.disabled    = false;
    aiStatus.style.display = 'none';
    updateAIStateBadges();
    tts.speak('AI player stopped.');
}

aiBtn.addEventListener('click', toggleAIPlayer);
document.getElementById('play-mode')?.addEventListener('change', (e) => { if (aiPlayerActive) stopAIPlayer(); setPlayMode(e.target.value); });
setPlayMode(_playMode);   // sync the selector + button label to the saved mode
document.getElementById('rf-exit-btn')?.addEventListener('click', exitRapidFire);

aiBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (aiPlayerActive) stopAIPlayer();
    aiMode = aiMode === 'auto' ? 'manual' : 'auto';
    const label = aiMode === 'auto' ? 'Auto' : 'Manual';
    aiBtn.textContent = `▶ Start (${label})`;
    tts.interrupt(`Switched to ${label} mode. Applies to AI Play.`);
    setTimeout(() => { if (!aiPlayerActive) aiBtn.textContent = '▶ Start'; }, 2500);
});

// ────────────────────────────────────────────────────────────
// 18. AI BUDDY COACH
// ────────────────────────────────────────────────────────────
let buddyActive   = false;
let buddyInterval = null;
let buddyStream   = null;

const buddyBtn   = document.getElementById('ai-buddy-btn');
const buddyPanel = document.getElementById('buddy-panel');
const buddyText  = document.getElementById('buddy-text');

async function buddyAdvise() {
    if (!buddyActive) return;
    buddyText.textContent = '🤔 Analyzing…';

    const gameState = readGameState();
    const stateCtx  = gameState ? `\n\n${gameStateToText(gameState)}` : '';

    try {
        const sysPrompt = `You are an AI Buddy Coach for Super Mario 64. Give helpful, friendly advice in 2 sentences max.${stateCtx}
Respond with ONLY valid JSON (no markdown fences):
{"text": "advice", "speech": "conversational version (max 20 words)"}`;

        const streamToUse = aiStream || buddyStream;
        if (!streamToUse) { buddyText.textContent = '❌ No game view active!'; return; }
        const screenshot = await captureScreen(streamToUse);
        if (!screenshot) { buddyText.textContent = '❌ Could not capture game view'; return; }
        const base64Image = screenshot.replace(/^data:image\/(png|jpeg);base64,/, '');
        const mimeType    = screenshot.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
        const userMessage = {
            role: 'user',
            content: [
                { type: 'text', text: 'What advice do you have?' },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            ],
        };

        const rawContent = await callChatAPI([
            { role: 'system', content: sysPrompt },
            userMessage,
        ], { json: true, max_tokens: 200 });

        const clean  = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const advice = JSON.parse(clean);
        buddyText.textContent = `💬 ${advice.text}`;
        if (advice.speech) tts.speak(advice.speech);
        recordUsage();   // log buddy-coach pollen spend too

    } catch (err) {
        buddyText.textContent = `❌ ${err.message}`;
    }
}

async function toggleBuddy() {
    const key = getActiveKey();
    if (!key) {
        document.getElementById('auth-overlay').classList.remove('hidden');
        return;
    }

    if (!buddyActive) {
        if (!aiStream && !buddyStream) {
            try {
                buddyStream = await acquireVisionStream(3);
                if (!buddyStream) throw new Error('no stream');
                buddyStream.getVideoTracks()[0].addEventListener('ended', stopBuddy);
            } catch {
                tts.interrupt(_visionSource === 'screen'
                    ? 'Screen sharing was denied. Please try again.'
                    : 'Could not capture the game canvas.');
                return;
            }
        }

        buddyActive = true;
        buddyBtn.classList.add('active');
        buddyBtn.textContent = '⏹ Stop Buddy';
        buddyPanel.style.display = 'block';
        buddyText.textContent = "👋 Hey! I'm watching your gameplay!";
        buddyInterval = setInterval(buddyAdvise, 15000);
        setTimeout(buddyAdvise, 2000);

    } else {
        stopBuddy();
    }
}

function stopBuddy() {
    buddyActive = false;
    buddyBtn.classList.remove('active');
    buddyBtn.textContent = '🧡 Buddy';
    buddyPanel.style.display = 'none';
    if (buddyInterval) { clearInterval(buddyInterval); buddyInterval = null; }
    if (buddyStream && !aiPlayerActive) {
        buddyStream.getTracks().forEach(t => t.stop());
        buddyStream = null;
        if (_captureVideo) _captureVideo.srcObject = null;
    }
}

buddyBtn.addEventListener('click', toggleBuddy);

// ────────────────────────────────────────────────────────────
// 19. MEMORY VIEWER
// ────────────────────────────────────────────────────────────
document.getElementById('view-memory-btn').addEventListener('click', () => {
    const panel    = document.getElementById('memory-panel');
    const backdrop = document.getElementById('memory-backdrop');
    const content  = document.getElementById('memory-content');

    let text = '=== AI STUDY NOTES ===\n';
    text += aiNotes.length > 0
        ? aiNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')
        : 'No study notes yet. Click Study to generate them.';
    text += '\n\n=== MISTAKES & LEARNINGS ===\n';
    text += aiMemory.length > 0
        ? aiMemory.map((m, i) => `${i + 1}. ${m}`).join('\n')
        : 'No mistakes recorded yet.';

    content.textContent = text;
    panel.style.display = 'block';
    backdrop.classList.add('open');
});

document.getElementById('close-memory-btn').addEventListener('click', () => {
    document.getElementById('memory-panel').style.display = 'none';
    document.getElementById('memory-backdrop').classList.remove('open');
});
document.getElementById('memory-backdrop').addEventListener('click', () => {
    document.getElementById('memory-panel').style.display = 'none';
    document.getElementById('memory-backdrop').classList.remove('open');
});

// ────────────────────────────────────────────────────────────
// 20. PRE-GAME STUDY NOTES
// ────────────────────────────────────────────────────────────
let _studyInFlight = false;

// Generate strategy notes from the guides. Reusable by the button, the
// auto-study-on-start, and the AI's own study_guide tool.
async function runStudy({ silent = false, openMemory = false } = {}) {
    if (_studyInFlight) return aiNotes;
    if (!getActiveKey()) {
        if (!silent) document.getElementById('auth-overlay').classList.remove('hidden');
        return aiNotes;
    }
    _studyInFlight = true;
    const btn = document.getElementById('pregame-notes-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Studying…'; }
    if (!silent) tts.speak('Studying the SM64 guide. One moment.');

    try {
        const { t1, t2, strategy } = await loadTrainingData();
        const strategyBlock = strategy ? `\n\n=== SPEEDRUN STRATEGY (reference, not inputs) ===\n${strategy.slice(0, 5000)}` : '';
        const rawContent = await callChatAPI([
            { role: 'system', content: `Analyze these Super Mario 64 gameplay guides and speedrun strategy and extract 10-14 concise, actionable strategy notes for playing legitimately from what you see. Do NOT include input scripts or glitch/cheat routes.
Respond with ONLY valid JSON (no markdown fences):
{"notes": ["note1", "note2", ...]}` },
            { role: 'user', content: `Guides:\n\n=== GUIDE 1 ===\n${t1.slice(0, 4000)}\n\n=== GUIDE 2 ===\n${t2.slice(0, 4000)}${strategyBlock}` },
        ], { json: true, max_tokens: 700 });
        recordUsage();

        const clean  = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const result = JSON.parse(clean);
        if (Array.isArray(result.notes) && result.notes.length) aiNotes = result.notes;

        if (btn) {
            btn.textContent = `✓ ${aiNotes.length} Notes`;
            btn.style.background = '#2e7d32';
            setTimeout(() => { btn.disabled = false; btn.textContent = '📚 Study'; btn.style.background = ''; }, 3000);
        }
        if (!silent) tts.interrupt(`Done! ${aiNotes.length} strategy notes ready.`);
        if (openMemory) document.getElementById('view-memory-btn')?.click();
        return aiNotes;
    } catch (err) {
        console.error('Study notes error:', err);
        if (btn) {
            btn.textContent = '❌ Error'; btn.style.background = '#b71c1c';
            setTimeout(() => { btn.disabled = false; btn.textContent = '📚 Study'; btn.style.background = ''; }, 3000);
        }
        if (!silent) tts.interrupt('Study failed. Please try again.');
        return aiNotes;
    } finally {
        _studyInFlight = false;
    }
}

document.getElementById('pregame-notes-btn').addEventListener('click', () => runStudy({ openMemory: true }));

// ────────────────────────────────────────────────────────────
// 21. PERSISTENT SAVE (Emscripten IDBFS)
// ────────────────────────────────────────────────────────────
Module.preRun.push(function () {
    try {
        if (Module.FS && Module.IDBFS) {
            try { Module.FS.mkdir('/save'); } catch {}
            Module.FS.mount(Module.IDBFS, {}, '/save');
        }
    } catch (err) { console.error('preRun save error:', err); }
});

Module.onRuntimeInitialized = function () {
    try {
        if (Module.FS && Module.IDBFS) {
            Module.FS.syncfs(true, (err) => { if (err) console.warn('syncfs load error:', err); });

            window.saveNow = function (cb) {
                try { if (typeof Module.writeSave === 'function') Module.writeSave(); } catch {}
                Module.FS.syncfs(false, (err) => { if (typeof cb === 'function') cb(err); });
            };

            setInterval(() => window.saveNow(), 5000);
            window.addEventListener('beforeunload', () => { try { Module.FS.syncfs(false, () => {}); } catch {} });
            document.addEventListener('visibilitychange', () => { if (document.hidden) window.saveNow(); });
        }
    } catch (err) { console.error('save init error:', err); }

    // Lightweight 500ms poll: read memory (if enabled) + refresh streamer overlay
    setTimeout(() => {
        setInterval(() => {
            try { readGameState(); } catch {}
            try { if (_streamerMode) updateStreamerOverlay(_gameState); } catch {}
        }, 500);
    }, 3000);
};

// ────────────────────────────────────────────────────────────
// 21b. STREAMER MODE + BROADCAST OVERLAY
// ────────────────────────────────────────────────────────────
//
// Streamer mode hides all the app chrome and shows only:
//   • a clean broadcast-style stats overlay fed from game RAM
//   • a live view of what the AI actually sees (the side-by-side frame)
//   • a single text watermark ("Made by Endoxidev/MetaMysteries8") that
//     doubles as the exit button.
//
let _streamerMode  = (() => { try { return localStorage.getItem('sm64_streamer_mode') === '1'; } catch { return false; } })();
let _aiVisionFrame = null;  // last image the AI was actually shown

function setStreamerMode(on) {
    _streamerMode = on;
    document.getElementById('app')?.classList.toggle('streamer-mode', on);
    try { localStorage.setItem('sm64_streamer_mode', on ? '1' : '0'); } catch {}
    if (on) {
        updateStreamerOverlay(_gameState);   // handles null / memory-off too
        updateStreamerVision(_aiVisionFrame);
        updateStreamerControls();
    }
    // Always refresh energy bar + chatlog so they show/hide with the mode
    if (typeof updateEnergyUI === 'function') updateEnergyUI();
    if (typeof renderChatlog  === 'function') renderChatlog();
}
function toggleStreamerMode() { setStreamerMode(!_streamerMode); }

// Streamer-mode AI controls proxy the real HUD buttons so all logic/state is reused
function _proxyClick(targetId) {
    document.getElementById(targetId)?.click();
    setTimeout(updateStreamerControls, 60);  // reflect new state after the toggle settles
}
document.getElementById('so-ai-btn')?.addEventListener('click',     () => _proxyClick('ai-player-btn'));
document.getElementById('so-buddy-btn')?.addEventListener('click',  () => _proxyClick('ai-buddy-btn'));
document.getElementById('so-study-btn')?.addEventListener('click',  () => _proxyClick('pregame-notes-btn'));
document.getElementById('so-memory-btn')?.addEventListener('click', () => _proxyClick('view-memory-btn'));
document.getElementById('so-mute-btn')?.addEventListener('click',   () => _proxyClick('mute-btn'));

// Keep the streamer-mode control dock in sync with real AI/buddy/mute state
function updateStreamerControls() {
    const aiB = document.getElementById('so-ai-btn');
    if (aiB) { aiB.classList.toggle('active', aiPlayerActive); aiB.textContent = aiPlayerActive ? '⏹ Stop' : '▶ Start'; }
    const buB = document.getElementById('so-buddy-btn');
    if (buB) { buB.classList.toggle('active', buddyActive); buB.textContent = buddyActive ? '⏹ Stop' : '🧡 Buddy'; }
    const mB = document.getElementById('so-mute-btn');
    if (mB) mB.textContent = isMuted ? '🔇' : '🔊';
    const tB = document.getElementById('so-turbo-btn');
    if (tB) { tB.classList.toggle('active', _turboMode); tB.textContent = _turboMode ? '⚡ Turbo ON' : '⚡ Turbo'; }
}

function updateStreamerOverlay(state) {
    if (!_streamerMode) return;
    updateStreamerControls();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const badge = document.getElementById('so-ai-badge');
    if (badge) badge.textContent = aiPlayerActive ? '🤖 AI PLAYING' : (buddyActive ? '🧡 BUDDY COACH' : '🎮 MANUAL');

    // Memory disabled → the AI plays on vision only; don't show fake stats
    if (!MEMORY_ENABLED) {
        set('so-stars', '—'); set('so-coins', '—'); set('so-lives', '—');
        set('so-level', 'Vision-only'); set('so-action', 'memory off'); set('so-speed', '—');
        set('so-pos', 'position from sight');
        const hp0 = document.getElementById('so-health');
        if (hp0) hp0.innerHTML = '';
        return;
    }
    if (!state) return;
    set('so-stars',  state.stars);
    set('so-coins',  state.coins);
    set('so-lives',  state.lives);
    set('so-level',  state.levelName);
    set('so-action', state.actionName);
    set('so-speed',  `${state.speed}`);
    set('so-pos',    `X ${state.x}   Y ${state.y}   Z ${state.z}`);
    const hp = document.getElementById('so-health');
    if (hp) {
        hp.innerHTML = Array.from({ length: 8 }, (_, i) =>
            `<span class="so-wedge${i < state.health ? ' on' : ''}"></span>`).join('');
    }
}

// Mirror exactly what the AI "sees" into the streamer overlay
function setAIVisionFrame(dataUrl) {
    _aiVisionFrame = dataUrl;
    // In live mode the background loop drives the panel (shows continuous gameplay)
    if (_turboMode && _turboCfg.live && _streamerMode) return;
    updateStreamerVision(dataUrl);
}
function updateStreamerVision(dataUrl) {
    if (!_streamerMode) return;
    const img = document.getElementById('so-vision-img');
    const ph  = document.getElementById('so-vision-ph');
    if (!img) return;
    if (dataUrl) {
        img.src = dataUrl;
        img.style.display = 'block';
        if (ph) ph.style.display = 'none';
    } else {
        img.removeAttribute('src');
        img.style.display = 'none';
        if (ph) ph.style.display = 'flex';
    }
}

// The watermark IS the exit button
document.getElementById('streamer-watermark')?.addEventListener('click', () => setStreamerMode(false));
document.getElementById('streamer-toggle-btn')?.addEventListener('click', () => setStreamerMode(true));

// Hotkey: Shift+S toggles streamer mode (Shift avoids the game's movement keys)
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.shiftKey && e.code === 'KeyS') { e.preventDefault(); toggleStreamerMode(); }
});

// ── AI thought-stream chatlog ────────────────────────────────
// Left side = the AI's reasoning + spoken output. Right side = its tool calls,
// rendered like slash-commands fired at a Discord/Telegram bot.
let _chatlogItems = [];
function _esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
function pushChatlog(html, cls) {
    _chatlogItems.push({ html, cls });
    while (_chatlogItems.length > 10) _chatlogItems.shift();   // hard cap — never grows unbounded
    renderChatlog();
}
function renderChatlog() {
    const el   = document.getElementById('ai-chatlog');
    const body = document.getElementById('ai-chatlog-body');
    if (!el || !body) return;
    const show = _streamerMode && _chatlogItems.length > 0;
    el.style.display = show ? 'flex' : 'none';
    if (!show) return;
    body.innerHTML = _chatlogItems.map(it => `<div class="cl-item ${it.cls}">${it.html}</div>`).join('');
    body.scrollTop = body.scrollHeight;
}
function logReasoning(thought, speech) {
    if (thought) pushChatlog(_esc(thought), 'cl-reason');
    if (speech)  pushChatlog('🗣 ' + _esc(speech), 'cl-speech');
}
function logToolCall(name, args, result) {
    const argStr = args && Object.keys(args).length
        ? ' ' + Object.entries(args).map(([k, v]) => `${k}:${v}`).join(' ')
        : '';
    pushChatlog(`<span class="cl-cmd">/${_esc(name)}${_esc(argStr)}</span>`, 'cl-tool');
    if (result) pushChatlog(`<span class="cl-cmd-res">↳ ${_esc(result)}</span>`, 'cl-tool');
}
function clearChatlog() { _chatlogItems = []; renderChatlog(); }

// ────────────────────────────────────────────────────────────
// 21c. POLLEN BALANCE + AI ENERGY / USAGE TRACKING (Pollinations)
// ────────────────────────────────────────────────────────────
//
// Energy bar = how much "AI power" is left, based on pollen balance.
//   full  = balance at page load (auto) OR a user-set maximum
//   empty = 0 (auto) OR a user-set minimum
// Per-prompt cost is derived from the drop in balance between checks, and the
// last few costs are shown in a mini usage log on the streamer overlay.
//
let _pollenStart = null;   // balance when we first read it (auto "full")
let _pollenLast  = null;   // balance at the previous usage check
let _pollenNow   = null;   // most recent balance
let _usageLog    = [];     // recent per-prompt costs (pollen)
let _lastUsageCheck = 0;

// User-configurable energy bounds
let _energyCfg = (() => {
    try { return JSON.parse(localStorage.getItem('sm64_energy_cfg')) || {}; } catch { return {}; }
})();
if (typeof _energyCfg.auto === 'undefined') _energyCfg.auto = true;
if (typeof _energyCfg.min  === 'undefined') _energyCfg.min  = 0;
if (typeof _energyCfg.max  === 'undefined') _energyCfg.max  = null;
if (typeof _energyCfg.unit === 'undefined') _energyCfg.unit = 'usd'; // 'usd' | 'poll' | 'cu'

function saveEnergyCfg() {
    try { localStorage.setItem('sm64_energy_cfg', JSON.stringify(_energyCfg)); } catch {}
}

// Pollinations bills in pollen, and 1 pollen = $1.00 exactly, so we can show the
// same number as dollars. Compute Units are a friendlier label: 0.01 pollen =
// 1000 CU  →  1 pollen = 100,000 CU.
function fmtAmount(pollen) {
    const p = Math.max(0, pollen || 0);
    const unit = _energyCfg.unit || 'usd';
    if (unit === 'cu')   return `${Math.round(p * 100000).toLocaleString()} CU`;
    if (unit === 'poll') return `${p.toFixed(p < 0.01 ? 5 : 4)} 🌸`;
    return `$${p.toFixed(p < 0.01 ? 5 : 4)}`;   // usd (default)
}

async function fetchBalanceValue() {
    if (!pollinationsKey) return null;
    try {
        const res = await fetch(`${POLLINATIONS_API_BASE}/account/balance`, {
            headers: { 'Authorization': `Bearer ${pollinationsKey}` },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const bal  = data.balance ?? data.pollen ?? data.budget;
        const num  = typeof bal === 'number' ? bal : (bal != null ? parseFloat(bal) : null);
        return Number.isFinite(num) ? num : null;
    } catch { return null; }
}

async function refreshPollenBalance() {
    const chip = document.getElementById('pollen-chip');
    const bal  = await fetchBalanceValue();
    if (bal == null) { if (chip) chip.style.display = 'none'; return; }
    if (_pollenStart == null) { _pollenStart = bal; _pollenLast = bal; }
    _pollenNow = bal;
    if (chip) {
        chip.textContent = fmtAmount(bal);
        chip.style.display = '';
    }
    updateEnergyUI();
}

// Sample balance after an AI call and log the cost (debounced)
async function recordUsage(force = false) {
    if (!pollinationsKey) return;
    const now = Date.now();
    if (!force && now - _lastUsageCheck < 2000) return;
    _lastUsageCheck = now;
    const bal = await fetchBalanceValue();
    if (bal == null) return;
    if (_pollenStart == null) { _pollenStart = bal; _pollenLast = bal; }
    if (_pollenLast != null) {
        const cost = _pollenLast - bal;
        if (cost > 1e-7) {
            _usageLog.push(cost);
            if (_usageLog.length > 50) _usageLog.shift();   // keep total accurate, display only last 4
        }
    }
    _pollenLast = bal;
    _pollenNow  = bal;
    updateEnergyUI();
}

function energyBounds() {
    const max = (_energyCfg.auto || _energyCfg.max == null)
        ? (_pollenStart ?? _pollenNow ?? 0)
        : _energyCfg.max;
    const min = _energyCfg.min ?? 0;
    return { max, min };
}

function updateEnergyUI() {
    const wrap = document.getElementById('so-energy');
    if (!wrap) return;
    const isPoll = !!pollinationsKey;
    wrap.style.display = (_streamerMode && isPoll && _pollenNow != null) ? 'block' : 'none';
    if (!(_streamerMode && isPoll && _pollenNow != null)) return;

    const { max, min } = energyBounds();
    const span = Math.max(1e-9, max - min);
    const pct  = Math.max(0, Math.min(100, ((_pollenNow - min) / span) * 100));

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('so-energy-model', getSelectedModel());
    set('so-energy-total', fmtAmount(Math.max(0, (_pollenStart ?? _pollenNow) - _pollenNow)));
    set('so-energy-left',  fmtAmount(Math.max(0, _pollenNow - min)));

    const bar = document.getElementById('so-energy-bar');
    if (bar) {
        bar.style.width = pct + '%';
        // green → amber → red as it drains
        bar.style.background = pct > 50 ? 'linear-gradient(90deg,#43a047,#7cb342)'
                              : pct > 20 ? 'linear-gradient(90deg,#fb8c00,#fdd835)'
                                         : 'linear-gradient(90deg,#e53935,#ff7043)';
    }

    const log = document.getElementById('so-energy-log');
    if (log) {
        const last5 = _usageLog.slice(-5);   // never show more than the last 5 calls
        log.innerHTML = last5.length
            ? last5.map(c => `<div class="so-uselog-row">AI Used: ${fmtAmount(c)}</div>`).join('')
            : '<div class="so-uselog-row dim">No AI usage yet…</div>';
    }
}

// ── Energy config box (openable via HUD button, works outside streamer mode) ──
function openEnergyConfig() {
    const modal = document.getElementById('energy-modal');
    const back  = document.getElementById('energy-backdrop');
    document.getElementById('energy-auto').checked = !!_energyCfg.auto;
    document.getElementById('energy-max').value    = _energyCfg.max ?? (_pollenStart ?? '');
    document.getElementById('energy-min').value    = _energyCfg.min ?? 0;
    document.getElementById('energy-max').disabled = !!_energyCfg.auto;
    const unitSel = document.getElementById('energy-unit');
    if (unitSel) unitSel.value = _energyCfg.unit || 'usd';
    modal?.classList.add('open');
    back?.classList.add('open');
}
function closeEnergyConfig() {
    document.getElementById('energy-modal')?.classList.remove('open');
    document.getElementById('energy-backdrop')?.classList.remove('open');
}
document.getElementById('energy-config-btn')?.addEventListener('click', openEnergyConfig);
document.getElementById('so-energy-cfg-btn')?.addEventListener('click', openEnergyConfig); // reachable in streamer mode
document.getElementById('energy-backdrop')?.addEventListener('click', closeEnergyConfig);
document.getElementById('energy-close-btn')?.addEventListener('click', closeEnergyConfig);
document.getElementById('energy-auto')?.addEventListener('change', (e) => {
    document.getElementById('energy-max').disabled = e.target.checked;
});
document.getElementById('energy-save-btn')?.addEventListener('click', () => {
    _energyCfg.auto = document.getElementById('energy-auto').checked;
    _energyCfg.min  = parseFloat(document.getElementById('energy-min').value) || 0;
    const maxV      = parseFloat(document.getElementById('energy-max').value);
    _energyCfg.max  = Number.isFinite(maxV) ? maxV : null;
    _energyCfg.unit = document.getElementById('energy-unit')?.value || 'usd';
    saveEnergyCfg();
    refreshPollenBalance();   // re-render chip + energy in the new unit
    updateEnergyUI();
    closeEnergyConfig();
});
document.getElementById('energy-reset-btn')?.addEventListener('click', () => {
    // Re-baseline "full" to the current balance
    _pollenStart = _pollenNow;
    _pollenLast  = _pollenNow;
    _usageLog    = [];
    updateEnergyUI();
});

// ────────────────────────────────────────────────────────────
// 21d. TURBO (consistent rapid fire) MODAL + WARNING + MEM DEBUG
// ────────────────────────────────────────────────────────────
function _syncTurboSubs() {
    const on = document.getElementById('turbo-master')?.checked;
    ['turbo-multi', 'turbo-advanced', 'turbo-live'].forEach(id => {
        const e = document.getElementById(id); if (e) e.disabled = !on;
    });
}
function openTurboModal() {
    const m = id => document.getElementById(id);
    if (m('turbo-master'))   m('turbo-master').checked   = _turboMode;
    if (m('turbo-multi'))    m('turbo-multi').checked     = !!_turboCfg.multi;
    if (m('turbo-advanced')) m('turbo-advanced').checked  = !!_turboCfg.advanced;
    if (m('turbo-live'))     m('turbo-live').checked      = !!_turboCfg.live;
    _syncTurboSubs();
    m('turbo-modal')?.classList.add('open');
    m('turbo-backdrop')?.classList.add('open');
}
function closeTurboModal() {
    document.getElementById('turbo-modal')?.classList.remove('open');
    document.getElementById('turbo-backdrop')?.classList.remove('open');
}
document.getElementById('turbo-btn')?.addEventListener('click', openTurboModal);
document.getElementById('turbo-close-btn')?.addEventListener('click', closeTurboModal);
document.getElementById('turbo-backdrop')?.addEventListener('click', closeTurboModal);
document.getElementById('turbo-master')?.addEventListener('change', _syncTurboSubs);
document.getElementById('turbo-save-btn')?.addEventListener('click', () => {
    _turboCfg.multi    = document.getElementById('turbo-multi').checked;
    _turboCfg.advanced = document.getElementById('turbo-advanced').checked;
    _turboCfg.live     = document.getElementById('turbo-live').checked;
    setTurboMode(document.getElementById('turbo-master').checked);   // also saves + restarts loop
    if (_turboMode && _turboCfg.live && aiPlayerActive) startLiveLoop(); else stopLiveLoop();
    closeTurboModal();
});
// Quick toggle (streamer-mode dock)
document.getElementById('so-turbo-btn')?.addEventListener('click', () => setTurboMode(!_turboMode));

// ── Pre-plan (mini-TAS) modal + toggles ─────────────────────────────
function updatePreplanUI() {
    const on = _preplanMode;
    const b  = document.getElementById('preplan-btn');
    const sb = document.getElementById('so-preplan-btn');
    if (b)  b.classList.toggle('active', on);
    if (sb) { sb.classList.toggle('active', on); sb.textContent = on ? '🧠 Pre-Plan ✓' : '🧠 Pre-Plan'; }
}
function setPreplanMode(on) {
    _preplanMode = !!on;
    savePreplanState();
    updatePreplanUI();
    updateAIStatus(_preplanMode ? '🧠 Pre-plan ON — AI will script multi-step moves' : 'Pre-plan off');
}
function openPreplanModal() {
    const master = document.getElementById('preplan-master');
    const cap    = document.getElementById('preplan-cap');
    if (master) master.checked = _preplanMode;
    if (cap)    cap.value = String(_preplanCap);
    document.getElementById('preplan-modal')?.classList.add('open');
    document.getElementById('preplan-backdrop')?.classList.add('open');
}
function closePreplanModal() {
    document.getElementById('preplan-modal')?.classList.remove('open');
    document.getElementById('preplan-backdrop')?.classList.remove('open');
}
document.getElementById('preplan-btn')?.addEventListener('click', openPreplanModal);
document.getElementById('preplan-close-btn')?.addEventListener('click', closePreplanModal);
document.getElementById('preplan-backdrop')?.addEventListener('click', closePreplanModal);
document.getElementById('preplan-save-btn')?.addEventListener('click', () => {
    const cap = parseInt(document.getElementById('preplan-cap')?.value, 10);
    _preplanCap = Number.isFinite(cap) ? cap : 20;
    setPreplanMode(document.getElementById('preplan-master')?.checked);
    closePreplanModal();
});
document.getElementById('so-preplan-btn')?.addEventListener('click', () => setPreplanMode(!_preplanMode));
updatePreplanUI();

// Big honesty warning, shown on every page load
(function showSuckWarning() {
    const w = document.getElementById('suck-warning');
    if (!w) return;
    const hide = () => w.classList.add('hidden');
    document.getElementById('suck-warning-close')?.addEventListener('click', hide);
    setTimeout(hide, 9000);   // auto-dismiss
})();

// ── Light memory debugging ──────────────────────────────────
// Logs MarioState candidates so you can compare against the on-screen HUD and
// figure out the real struct base, then run sm64Memory(true) to trust it.
window.sm64MemDebug = (limit = 12) => {
    const u8 = Module?.HEAPU8;
    if (!u8) return 'heap not ready yet — start the game first';
    const f = Module.HEAPF32, U16 = Module.HEAPU16, I16 = Module.HEAP16, I8 = Module.HEAP8, U32 = Module.HEAPU32;
    const end = Math.min(u8.length - 0xC0, 0x4000000);
    let found = 0;
    console.log('[SM64 mem] scanning for MarioState candidates…');
    for (let b = 0x400; b < end && found < limit; b += 4) {
        if (_looksLikeMario(b)) {
            console.log(`#${found} @0x${b.toString(16)} pos(${f[(b+MS_OFF.POS_X)>>2]|0},${f[(b+MS_OFF.POS_Y)>>2]|0},${f[(b+MS_OFF.POS_Z)>>2]|0}) ` +
                `spd=${f[(b+MS_OFF.FWD_VEL)>>2].toFixed(1)} act=0x${U32[(b+MS_OFF.ACTION)>>2].toString(16)} ` +
                `stars=${I16[(b+MS_OFF.STARS)>>1]} coins=${I16[(b+MS_OFF.COINS)>>1]} lives=${I8[b+MS_OFF.LIVES]} hp=0x${U16[(b+MS_OFF.HEALTH)>>1].toString(16)}`);
            found++;
        }
    }
    return `${found} candidate(s) logged. Compare with the on-screen HUD (real stars/coins/lives); once one matches, run sm64Memory(true).`;
};

// ────────────────────────────────────────────────────────────
// 22. BOOT
// ────────────────────────────────────────────────────────────
restoreProviderState();
if (_persistBrainmap) loadBrainmap();   // restore the AI's map across reloads
loadQTable();                            // restore the adaptive brain's learning
const _bmPersistEl = document.getElementById('brainmap-persist-toggle');
if (_bmPersistEl) _bmPersistEl.checked = _persistBrainmap;
if (_debugHUD) document.getElementById('debug-btn')?.classList.add('active');
updateBrainmapViz();
fetchVisionModels();   // Pollinations vision-model list
initAuth();
renderControlsGuide(null);   // show static controls immediately
// Voices may not be loaded yet — wait for them then re-render tutorial if open
window.speechSynthesis?.addEventListener('voiceschanged', () => {});

// Reflect persisted turbo state on the buttons
updateTurboUI();

// Restore streamer mode if it was on last session
if (_streamerMode) setStreamerMode(true);

// Pollen balance chip — refresh now and every 60s
refreshPollenBalance();
setInterval(refreshPollenBalance, 60000);
