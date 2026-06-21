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
const POLLINATIONS_APP_KEY    = 'pk_JBemDN4TzwP8Ls2v';

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
        if (res.status === 401 || res.status === 403) {
            clearStoredKey();
            pollinationsKey = null;
            document.getElementById('auth-overlay').classList.remove('hidden');
            throw new Error(`Auth failed (${res.status}) — please reconnect Pollinations`);
        }
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${res.status}`);
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
    _tool('look_around', 'Rotate the camera to survey the surroundings (helps you see exits/paths you may be facing away from).'),
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
                for (let i = 0; i < 4 && aiPlayerActive; i++) { simulateKeyPress('KeyZ', 120); await delay(160); }
                return 'Rotated the camera to survey the surroundings.';
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
// 5. CANVAS / GAME SETUP
// ────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
canvas.style.touchAction = 'none';
canvas.addEventListener('mousedown', () => canvas.focus());

Object.assign(window.Module, {
    canvas,
    locateFile: (path) => (path.endsWith('.wasm') ? './sm64.wasm' : path),
});

canvas.focus();

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') { e.stopPropagation(); return; }
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'Enter') canvas.focus();
}, { passive: false });

document.addEventListener('click', () => {
    try { if (Module?.SDL2?.audioContext?.state === 'suspended') Module.SDL2.audioContext.resume(); } catch {}
});

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

// Pollinations-only: nothing extra to restore (auth handled by initAuth).
function restoreProviderState() {}

// ────────────────────────────────────────────────────────────
// 8. CONTROLS GUIDE  (one AI call, cached in localStorage)
// ────────────────────────────────────────────────────────────
const CONTROLS_STATIC = [
    { key: '↑ ↓ ← →',  action: 'Move Mario' },
    { key: 'X',         action: 'Jump / Skip dialog' },
    { key: 'Space',     action: 'Crouch / Duck' },
    { key: 'C',         action: 'Dive / Punch / Grab' },
    { key: 'Enter',     action: 'Pause / Skip dialog' },
    { key: 'Z',         action: 'Camera left' },
    { key: 'X + ↑',    action: 'Long jump (run first)' },
    { key: 'X + X',    action: 'Double / Triple jump' },
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
        icon: '🤖', title: 'Step 3 — AI Player',
        body: 'Click AI Play to let the AI take over. Share your screen when prompted so the AI can see the game. It analyzes each frame, decides what to do, and plays — narrating its thoughts out loud.',
        narration: 'Click AI Play to let the AI take over. Share your screen so the AI can see the game. It will analyze each frame and play, narrating its thoughts out loud.',
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
    tag('▲ ArrowUp (fwd / toward cam)', x + w / 2, y + 14);
    tag('▼ Down (back / away)',          x + w / 2, y + h - 14);
    tag('◀ Left',                        x + 60,    y + h / 2);
    tag('Right ▶',                       x + w - 60, y + h / 2);
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
        if (typeof canvas.captureStream !== 'function') return null;
        _canvasStream = canvas.captureStream(fps);
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
let _aiGoal          = '';      // persistent multi-turn plan (navigation continuity)
let _aiGoalAge       = 0;       // turns the current goal has been pursued
let _camera2d        = false;   // true when AI detects a front-facing / 2D camera angle
let _outsideCastle   = false;   // true when AI detects it is outside the castle (longer travel holds needed)
let _location        = 'unknown'; // AI-detected location: castle_outside | castle_inside | bob_omb_battlefield | other

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

const keyMap = {
    ArrowUp:    'ArrowUp',
    ArrowDown:  'ArrowDown',
    ArrowLeft:  'ArrowLeft',
    ArrowRight: 'ArrowRight',
    jump:       'KeyX',
    crouch:     'Space',
    action:     'KeyC',
    start:      'Enter',
    cameraLeft: 'KeyZ',   // rotate camera (helps look around / re-orient)
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
    canvas.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    setTimeout(() => {
        canvas.dispatchEvent(new KeyboardEvent('keyup', opts));
        document.dispatchEvent(new KeyboardEvent('keyup', opts));
    }, Math.max(50, duration));
}

function updateAIStatus(message) {
    aiStatus.style.display = 'block';
    aiStatus.textContent   = message;
}

// Render small visible badges for AI-detected state so the user can verify
// the camera2d / outside-castle / location logic is working.
function updateAIStateBadges() {
    const wrap = document.getElementById('ai-state-badges');
    if (!wrap) return;

    const locBadge = document.getElementById('badge-location');
    const camBadge = document.getElementById('badge-camera2d');
    const outBadge = document.getElementById('badge-outside');

    if (_location && _location !== 'unknown') {
        locBadge.textContent = `📍 ${_location.replace(/_/g, ' ')}`;
        locBadge.classList.add('active');
    } else {
        locBadge.classList.remove('active');
    }

    camBadge.classList.toggle('active', _camera2d);
    outBadge.classList.toggle('active', _outsideCastle);

    const any = (_location && _location !== 'unknown') || _camera2d || _outsideCastle;
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
        // Advanced turbo (max overdrive) never skips — it always re-thinks.
        const skipIdentical = !(_turboMode && _turboCfg.advanced);
        if (skipIdentical && isFrameIdentical(screenshot)) {
            updateAIStatus('💤 Screen unchanged — skipping inference');
            _isThinking = false;
            return null;
        }
        _frameHistory.push(screenshot);            // keep recent frames for is_stuck/is_trapped
        if (_frameHistory.length > 6) _frameHistory.shift();

        const { t1, t2, strategy, tasKnow } = await loadTrainingData();

        const memStateCtx = gameState
            ? `\n\n${gameStateToText(gameState)}\n  (If the screen is a TITLE/FILE-SELECT/DEMO, these numbers are from a background demo — ignore them and follow the SCREEN guidance.)`
            : '';

        // Movement since the previous decision — gives the model a sense of motion,
        // and catches the "stuck repeating the same wrong move" failure mode.
        let motionCtx = '';
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
            // Huge instantaneous jumps usually mean a warp, painting entry, OR an
            // attract-mode DEMO cutting between scenes (a menu is playing demos).
            if (dist > 4000) motionCtx += `\n📍 Mario's position jumped ${dist} units suddenly — you likely warped, entered a painting, OR this is a title-screen DEMO cutting scenes. Re-check the SCREEN type before acting.`;
        } else if (_prevScreenshot && screenshot && _prevScreenshot !== screenshot) {
            // No reliable memory — derive an OBJECTIVE motion signal from the pixels
            // so stuck-detection and "did my move work?" still function on vision alone.
            const vm = await _frameDiffScore(_prevScreenshot, screenshot);
            if (vm != null) {
                const pct = Math.round(vm * 100);
                if (vm < 0.05) _stuckCount++; else _stuckCount = 0;
                motionCtx = `\n\nVISUAL CHANGE since your last action: ${pct}% (objective screen-pixel difference). Under ~8% means you BARELY MOVED — you probably faced a wall or pressed the wrong key, so change direction. A large value means the view changed a lot.`;
                if (_stuckCount >= 2) {
                    motionCtx += `\n⚠ STUCK — the screen has barely changed for ${_stuckCount} turns, so your last move is NOT working. Do something DIFFERENT: turn to face a new direction (Left/Right), back up, jump over the obstacle, or pick another path. Do NOT repeat the previous action.`;
                }
            }
        }

        const memOn = gameState != null;   // false when memory reading is disabled

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
        const planCtx = _aiGoal
            ? `\n\nYOUR CURRENT PLAN (you set this ${_aiGoalAge} turn(s) ago — KEEP pursuing it unless the screen clearly shows it's done, impossible, or wrong): ${_aiGoal}`
            : '';
        const lastActCtx = _lastActionSummary
            ? `\n\nYOUR LAST ACTION was: ${_lastActionSummary}. Use the movement/visual-change feedback below to judge if it worked — if it barely moved you, do something DIFFERENT this turn.`
            : '';
        const cameraCtx = _camera2d
            ? '\n\nCAMERA PERSPECTIVE: The previous frame was detected as a 2D/front-facing or side-view camera. In this mode LEFT/RIGHT move Mario across the screen (hold them like forward travel); UP/DOWN move him toward/away from the camera and are usually NOT the way to progress.'
            : '';
        const outsideCtx = _outsideCastle
            ? '\n\nLOCATION: You are OUTSIDE THE CASTLE (grounds/bridge/front lawn). Distances to the doors and bridge are LARGE — you MUST use long travel holds (2000–4000ms) or you will inch forward forever. Do not stop until you reach the doors.'
            : '';
        const locationCtx = _location && _location !== 'unknown'
            ? `\n\nYOUR DETECTED LOCATION (verify against the CURRENT frame): ${_location}. If this does not match what you see, correct it in the "location" field. Important: if you were just at castle_outside and you do not CLEARLY see a painting-jump / warp transition in the recent frames, you are still at castle_outside — do not hallucinate bob_omb_battlefield.`
            : '';
        // Pre-plan (mini-TAS): the AI writes a full multi-step script this turn.
        const capTxt = _preplanCap > 0 ? `up to ${_preplanCap}` : 'as many as you need';
        const preplanCtx = _preplanMode
            ? `\n\n🧠 PRE-PLAN MODE IS ON. Do NOT make one tiny move. STUDY this frame, then write a COMPLETE step-by-step SCRIPT in "actions" (${capTxt} groups) that makes real, visible progress toward your goal — e.g. turn to face the door, run to it, climb the stairs, open it. Think like a speedrun route: each group is one timed key-hold, executed in order. The whole script runs this turn (it auto-stops if the scene changes unexpectedly), so plan a sane chunk you're confident about. Set "preplan": true.`
            : `\n\n🧠 OPTIONAL PRE-PLAN: if you can clearly see a multi-step path (e.g. a straight run to a visible door), you MAY set "preplan": true and put the FULL multi-step SCRIPT in "actions" (${capTxt} groups) to cover more ground in one turn. Otherwise keep it short.`;
        const memoryCtx   = aiMemory.length > 0
            ? `\n\nPAST MISTAKES TO AVOID:\n${aiMemory.slice(-5).map((m, i) => `${i + 1}. ${m}`).join('\n')}`
            : '';
        const notesCtx    = aiNotes.length > 0
            ? `\n\nYOUR PRE-GAME STUDY NOTES:\n${aiNotes.join('\n')}`
            : '';
        const instrCtx    = userInstruction
            ? `\n\nUSER INSTRUCTION (follow this): ${userInstruction}`
            : '';
        const trainingCtx = (t1 || t2)
            ? `\n\nTRAINING DATA:\n=== SET 1 ===\n${t1.slice(0, 3500)}\n\n=== SET 2 ===\n${t2.slice(0, 3500)}`
            : '';
        // Speedrun-informed strategy reference. Explicitly framed as KNOWLEDGE to
        // reason with, NOT a script to replay — so it can't be used to cheat.
        const strategyCtx = strategy
            ? `\n\nSPEEDRUN STRATEGY REFERENCE (knowledge to guide your decisions — NOT inputs to copy; play legitimately from what you SEE):\n${strategy.slice(0, 4000)}`
            : '';
        const tasMetaCtx = tasKnow
            ? `\n\nTAS ARCHIVE KNOWLEDGE (reference facts on optimal routes/times — NOT inputs to copy; you must still play from what you see):\n${tasKnow.slice(0, 2500)}`
            : '';

        const systemPrompt = `You are an AI playing Super Mario 64. Decide what actions to take.
${perceptionNote}

${hierarchyNote}

FIRST, IDENTIFY THE SCREEN — this is critical:
- TITLE SCREEN ("Press Start", the big rotating Mario face/logo): press start (Enter) to begin.
- FILE SELECT (a menu of Mario-head save files A/B/C/D, or Peach/coins icons): press jump (X) to pick a file and enter the game.
- ATTRACT-MODE DEMO (gameplay is happening but YOU aren't moving Mario — the camera pans cinematically, scenes change on their own, often shows random levels/Bowser): you are NOT in control and the live stats are from the demo, NOT real. Press start (Enter) to exit the demo back to the menu.
- DIALOG BOX (a white text box / sign / character speaking): press jump (X) to advance/close it.
- ACTUAL GAMEPLAY (you can see Mario respond to your inputs on the castle grounds or in a level): now you actually play.
If you are NOT clearly in ACTUAL GAMEPLAY, do not platform — just do the one correct button above to progress toward gameplay. Ignore "in water"/stuck logic on menus and demos.

GAME OBJECTIVE (once you control Mario):
1. Start outside the castle — head to the entrance bridge and go inside
2. Advance/skip any dialog box by pressing jump (X) — NOT start
3. Once inside, do NOT run back out — proceed forward
4. Find the first door (no star requirement) and enter it
5. Jump into the painting to start the first level
6. Collect stars to progress

OUTSIDE THE CASTLE — longer inputs required:
- The first area (castle grounds, bridge, front lawn) is BIG. To reach the castle doors you must hold movement keys for 2000–4000ms per travel group. Short taps will barely move you and you will never arrive.
- If you can see open grass, the bridge, the moat, or the castle doors are far away, set "outside_castle": true in your response and commit to long forward runs.
- Once you are inside the castle (foyer, hallways, rooms), set "outside_castle": false and return to normal hold lengths.

LOCATION — do not hallucinate. Use the CURRENT frame only:
- castle_outside: you are on the front lawn/bridge looking at the castle building. Key signs: castle walls/doors in front, moat, open sky, no paintings on walls, no Chain Chomp, no cannons, no mountain with flag.
- castle_inside: hallways, carpet, paintings on the walls, wooden doors, no sky.
- bob_omb_battlefield: ONLY after jumping into a painting. Signs: open field, trees, cannons, Chain Chomp, mountain with flag, NO castle entrance building.
- If you just started/loaded the game, you MUST be castle_outside. You cannot be in bob_omb_battlefield without entering the castle and jumping into a painting first.
- Set "location" to exactly one of: castle_outside, castle_inside, bob_omb_battlefield, other.

CONTROLS — how Mario ACTUALLY works (read carefully, you keep getting these wrong):
- ArrowUp/Down/Left/Right move Mario RELATIVE TO THE CAMERA. Up = away from the camera (the way Mario's back faces). Left/Right STEER and turn him.
- You MUST hold a direction long enough to travel. A quick tap barely moves him. To cross open ground, hold ArrowUp for 1–3 SECONDS (set "hold_ms": 1500+). This single thing matters most.
- To head toward something that is NOT straight ahead, TURN FIRST: hold ArrowLeft or ArrowRight (or rotate the camera with cameraLeft/Z), THEN hold ArrowUp. The target is often to your SIDE, not dead ahead.
- jump (X) = jump; it ALSO advances/closes dialog boxes. (Long jump = run forward, then crouch+jump.)
- crouch (Space) = duck / crawl / set up a long jump.  action (C) = dive / punch / grab / read a sign.
- start (Enter) = title/demo CONFIRM only. During real gameplay it just PAUSES — do NOT press it while playing. Use jump (X) for dialog.

2D / FRONT-FACING / SIDE-VIEW CAMERA (critical):
- Sometimes the camera shows Mario's face (he is looking at you) or locks into a side-scrolling / 2D-like angle.
- In that mode the world is FLATTENED: ArrowLeft and ArrowRight move Mario across the screen and are your MAIN way to travel. ArrowUp/Down move him toward/away from the camera (into/out of the screen), which is usually NOT the path forward.
- When you see this, set "camera2d": true in your response and navigate horizontally — do NOT "turn then go forward".
- In 2D mode hold ArrowLeft/ArrowRight for 1200–2500ms to travel, just like you hold ArrowUp in normal mode.

WATER — you keep failing this:
- You do NOT "jump out" of water. Jumping does nothing useful in water.
- To SWIM: hold a direction toward the nearest shore/shallow edge AND tap jump (X) repeatedly — each tap is a swim stroke that pushes you forward and UP. Keep stroking toward dry land.
- If Mario is clearly ON LAND, he is NOT in water — just walk. Only swim if you actually SEE water around him.

NAVIGATION:
- The castle entrance is the pair of big wooden DOORS set into the castle wall, across the bridge — not every archway/tunnel. Pick the visible target, face it, then hold forward toward it.
- The route is rarely a straight line — expect to move diagonally, sideways, and around obstacles.
- If you barely moved last turn you are probably facing a wall or the wrong way — TURN (Left/Right) or rotate the camera; do NOT keep mashing forward.

UNDERSTAND BEFORE YOU ACT (do this every turn, in your head, then fill the JSON):
1. SCENE: what screen is this? (title / file_select / demo / dialog / gameplay)
2. LOCATE MARIO: where is he in the frame, and which way is he facing?
3. LOCATE TARGET: what is the next thing to reach (door, bridge, painting, edge, star)? Name the GRID CELL it's in (TL/T/TR/L/C/R/BL/B/BR) using the compass overlay.
4. TURN MATH: if the target is in a LEFT cell, you must turn Left first; RIGHT cell → turn Right; T/C → it's roughly ahead, go forward. Never hold forward toward a target that is off to the side without turning first.
5. DID MY LAST MOVE WORK? check the VISUAL CHANGE % and movement feedback below. If it's low, you faced a wall or pressed the wrong key — change direction, do NOT repeat.
Commit to a PLAN (your "goal") that spans several turns instead of re-deciding from scratch every frame. Only abandon it when the screen proves it's wrong.

CHAINING ACTIONS:
- "actions" is a SEQUENCE of groups done one after another. Keys INSIDE one group happen SIMULTANEOUSLY (e.g. ["ArrowUp","jump"] = hold forward while jumping).
- Give each group a "hold_ms": FORWARD travel long (1200–2500ms); a TURN to re-aim short (250–500ms — a long turn just spins you in a circle); a jump or dialog-skip short (150–350ms).
- A good navigation turn is almost always two groups: TURN briefly to face the target, THEN hold forward toward it — e.g. [{"keys":["ArrowLeft"],"hold_ms":350},{"keys":["ArrowUp"],"hold_ms":1800}].

RULES:
- ⛔ Never press start during gameplay (it pauses).
- You see ONE current frame each turn. Act on what is in THIS frame; judge whether you moved from the VISUAL CHANGE % and movement feedback (text), not from any remembered image.
- Escape tools (de_water, load_state, reset_game) stay LOCKED until is_stuck/is_trapped returns true.
- ${memOn
    ? 'You may use tools (get_game_state, set_game_speed for tricky jumps, save_move/play_move for reusable sequences) when helpful, but don\'t call tools every turn.'
    : 'There is no reliable game memory — judge everything from the image. You may use set_game_speed, is_stuck/is_trapped, or save_move/play_move when helpful, but don\'t call tools every turn.'}
${movementCtx}${planCtx}${lastActCtx}${cameraCtx}${outsideCtx}${locationCtx}${preplanCtx}${memStateCtx}${motionCtx}${memoryCtx}${notesCtx}${instrCtx}${strategyCtx}${tasMetaCtx}${trainingCtx}

Respond with ONLY valid JSON (no markdown fences):
{
  "scene": "gameplay | title | file_select | demo | dialog",
  "target": "what I'm heading to + its grid cell, e.g. 'castle doors in TR cell'",
  "goal": "my multi-turn plan, e.g. 'cross the bridge and enter the castle doors'",
  "actions": [ {"keys":["ArrowLeft"], "hold_ms": 400}, {"keys":["ArrowUp"], "hold_ms": 1800}, {"keys":["ArrowUp","jump"], "hold_ms": 300} ],
  "thought": "scene, where Mario is, target cell, location evidence (e.g. castle doors vs cannons), which way I must turn, did last move work",
  "speech": "short streamer commentary (max 15 words) — omit if rapid_fire is true",
  "mistake": "error noticed or null",
  "notes": ["optional NEW insight worth remembering — omit or [] if none"],
  "camera2d": false,
  "outside_castle": false,
  "location": "castle_outside | castle_inside | bob_omb_battlefield | other",
  "preplan": false,
  "rapid_fire": false
}

Each group is {"keys":[...simultaneous...], "hold_ms": N}; plain arrays like ["ArrowUp"] also work with a default hold. Hold guide: FORWARD travel 1200–2500ms (go far); a TURN to re-aim (Left/Right alone) 250–500ms (short, or you spin in circles); jumps/dialog 150–350ms. In 2D/front-facing camera mode, treat ArrowLeft/ArrowRight as FORWARD travel (1200–2500ms), not turns. OUTSIDE THE CASTLE (grounds/bridge) use even longer forward travel: 2000–4000ms. ${_preplanMode ? `In PRE-PLAN mode give a full ${capTxt}-group script.` : 'Normally 1–5 groups (more only if you set preplan:true).'}
Valid keys: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, jump, start, crouch, action, cameraLeft`;

        // Single-frame perception: the AI acts on ONE current frame, annotated
        // with a nav grid + compass. (The previous-frame comparison was removed —
        // it confused the model into acting on the old frame; an objective motion
        // % is fed in TEXT instead, which is clearer and cheaper.)
        let visionImg = screenshot;
        const promptText = 'This is the CURRENT live frame, overlaid with a faint 3×3 navigation grid (cells TL/T/TR · L/C/R · BL/B/BR) and a camera-relative compass marking which arrow key moves Mario which way on screen. First identify the LOCATION (castle_outside / castle_inside / bob_omb_battlefield / other) and camera mode (normal vs 2D/front-facing/side-view). If it is 2D, set camera2d:true. If you are on the castle grounds/bridge, set outside_castle:true and use long travel holds. Then name the grid cell your target is in and choose your actions.';
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
        ], { json: true, max_tokens: maxTokens });

        const clean    = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const response = JSON.parse(clean);

        // Update camera-perspective, location, and outside-castle state from the model's own observation.
        if (typeof response.camera2d === 'boolean') {
            if (response.camera2d && !_camera2d) updateAIStatus('🎥 2D camera detected — switching to left/right movement');
            _camera2d = response.camera2d;
        }
        if (typeof response.outside_castle === 'boolean') {
            if (response.outside_castle && !_outsideCastle) updateAIStatus('🏰 Outside castle — using long travel inputs');
            _outsideCastle = response.outside_castle;
        }
        if (response.location && typeof response.location === 'string') {
            const validLocs = ['castle_outside', 'castle_inside', 'bob_omb_battlefield', 'other'];
            const loc = response.location.trim().toLowerCase().replace(/\s+/g, '_');
            if (validLocs.includes(loc)) {
                if (_location !== loc) {
                    _location = loc;
                    updateAIStatus(`📍 Location detected: ${_location.replace(/_/g, ' ')}`);
                }
            }
        }
        // Keep outside_castle in sync with location so long-inputs stay active reliably.
        if (_location === 'castle_outside') _outsideCastle = true;
        else if (_location === 'castle_inside' || _location === 'bob_omb_battlefield') _outsideCastle = false;
        updateAIStateBadges();

        // Persist the multi-turn plan for navigation continuity. Keep pursuing the
        // same goal across turns; only reset the age-counter when it genuinely changes.
        const newGoal = (response.goal || '').trim();
        if (newGoal) {
            if (newGoal !== _aiGoal) { _aiGoal = newGoal; _aiGoalAge = 0; }
            else _aiGoalAge++;
        } else if (_aiGoal) {
            _aiGoalAge++;   // model didn't restate it — assume it's still in effect
        }

        const thoughtLine = response.target
            ? `🎯 ${response.target} — ${response.thought || ''}`
            : `💭 ${response.thought}`;
        updateAIStatus(thoughtLine);
        logReasoning(response.thought, response.speech);   // feed the streamer thought-stream
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
function _normalizeGroup(g, fast, camera2d = false, outsideCastle = false) {
    let keys = [], ms = null;
    if (Array.isArray(g)) keys = g;
    else if (g && typeof g === 'object') { keys = g.keys || g.actions || []; ms = g.hold_ms ?? g.ms ?? g.duration ?? null; }
    else if (typeof g === 'string') keys = [g];
    keys = (Array.isArray(keys) ? keys : [keys]).filter(k => keyMap[k]);
    // Smarter movement defaults when the model omits hold_ms:
    //  • FORWARD/back travel → long hold so Mario actually covers ground (the #1
    //    reason the original travelled further than brief taps).
    //  • TURN-ONLY (Left/Right, no Up/Down) → short tap so he re-aims without
    //    spinning past the target.
    //  • jumps / dialog / actions → brief press.
    //  • In 2D/front-facing camera mode, Left/Right ARE the travel directions,
    //    so they get long holds just like forward in normal mode.
    //  • Outside the castle (big open grounds) requires even longer travel holds.
    const hasVertical = keys.includes('ArrowUp') || keys.includes('ArrowDown');
    const hasLeftRight = keys.includes('ArrowLeft') || keys.includes('ArrowRight');
    const is2DTravel = camera2d && hasLeftRight && !hasVertical;
    const isTurnOnly = !hasVertical && !is2DTravel && hasLeftRight;
    const isTravel = hasVertical || is2DTravel;
    if (ms == null) {
        if (isTravel)        ms = outsideCastle ? (fast ? 1200 : 2200) : (fast ? 750 : 1400);
        else if (isTurnOnly) ms = fast ? 240 : 380;
        else                 ms = fast ? 150 : 240;
    }
    // Clamp: turns get a tighter ceiling so the AI can't accidentally spin in circles.
    // Outside-castle travel gets a higher ceiling so the AI can actually cover the distance.
    const travelMax = outsideCastle ? (fast ? 2200 : 4000) : (fast ? 1800 : 4000);
    const maxMs = isTurnOnly ? (fast ? 700 : 900) : travelMax;
    ms = Math.max(80, Math.min(maxMs, ms));
    return { keys, ms: ms / gameSpeed };
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

async function aiExecute(response) {
    if (!response?.actions?.length) return;
    let groups = response.actions;
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
    // Scene-change watchdog: in pre-plan (outside turbo) we snapshot between steps
    // and bail out if the view changes drastically (fell, warped, entered water).
    const watch = preplan && !_turboMode;
    let watchFrame = watch ? await captureScreen(aiStream).catch(() => null) : null;

    for (let i = 0; i < groups.length; i++) {
        if (!aiPlayerActive) break;
        if (preplan && playerMovementDetected) { updateAIStatus('✋ Pre-plan aborted — you took control'); break; }
        const { keys, ms } = _normalizeGroup(groups[i], fast, _camera2d, _outsideCastle);
        if (!keys.length) continue;
        // Hold all keys in the group simultaneously for the (sustained) duration
        for (const action of keys) {
            const keyCode = keyMap[action];
            if (keyCode) simulateKeyPress(keyCode, Math.max(70, ms * 0.92));
        }
        updateAIStatus(`${preplan ? '🧠' : '🎮'} [${i + 1}/${groups.length}] ${keys.join(' + ')} (${Math.round(ms)}ms)`);
        await delay(ms);

        if (watch && i < groups.length - 1) {
            const nowFrame = await captureScreen(aiStream).catch(() => null);
            if (nowFrame && watchFrame) {
                const d = await _frameDiffScore(watchFrame, nowFrame);
                if (d != null && d > 0.6) { updateAIStatus('🛑 Big change mid-plan — re-planning'); break; }
            }
            if (nowFrame) watchFrame = nowFrame;
        }
    }
    updateAIStatus('✅ Done');
}

let _busyCycle = false;   // prevents a new think starting while still executing
async function aiThinkAndAct() {
    if (!aiPlayerActive || _busyCycle) return;
    _busyCycle = true;
    try {
        const resp = await aiThink();
        if (resp && aiPlayerActive) await aiExecute(resp);
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
    // Pollinations vision model sees the game canvas directly.
    const key = getActiveKey();
    if (!key) {
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
        _aiGoal         = '';
        _aiGoalAge      = 0;
        _camera2d       = false;
        _outsideCastle    = false;
        _location         = 'unknown';
        _lastActions    = null;
        _lastActionSummary = '';
        _frameHistory   = [];
        _escapeArmed      = false;
        _escapeExtraTurns = 0;
        updateAIStateBadges();
        clearChatlog();
        aiStream.getVideoTracks()[0].addEventListener('ended', stopAIPlayer);

        // Auto-study the guide before playing (once), in the background
        if (aiNotes.length === 0 && getActiveKey()) {
            updateAIStatus('📚 Studying the guide before playing…');
            runStudy({ silent: true }).catch(() => {});
        }

        if (aiMode === 'auto') {
            aiBtn.textContent = '⏹ Stop AI';
            aiBtn.classList.add('active');
            updateAIStatus(_turboMode ? '⚡ Turbo AI — going as fast as possible' : '🤖 AI Player Active');
            tts.speak(_turboMode ? 'Turbo AI active. Going as fast as I can.' : 'AI player activated. Analyzing the screen now.');
            scheduleAILoop();   // routes to turbo loop if turbo is on
            if (_turboMode && _turboCfg.live) startLiveLoop();
            aiThinkAndAct();
        } else {
            aiManualState = 'idle';
            aiBtn.textContent = '🧠 Think';
            aiBtn.classList.add('active');
            updateAIStatus('🤖 Manual Mode — press to think');
        }

    } else {
        aiMode === 'manual' ? handleManualModeClick() : stopAIPlayer();
    }
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
    if (_captureVideo) { _captureVideo.srcObject = null; }
    // Free frame buffers so a long session doesn't pile up base64 strings
    _frameHistory = [];
    _prevScreenshot = null;
    _aiGoal           = '';
    _aiGoalAge        = 0;
    _lastActions      = null;
    _lastActionSummary = '';
    _escapeArmed      = false;
    _escapeExtraTurns = 0;
    _camera2d         = false;
    _outsideCastle    = false;
    _location         = 'unknown';
    aiManualState    = 'idle';
    aiPlannedActions = null;
    aiBtn.textContent = '🤖 AI Play';
    aiBtn.classList.remove('active');
    aiBtn.disabled    = false;
    aiStatus.style.display = 'none';
    updateAIStateBadges();
    tts.speak('AI player stopped.');
}

aiBtn.addEventListener('click', toggleAIPlayer);
document.getElementById('rf-exit-btn')?.addEventListener('click', exitRapidFire);

aiBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (aiPlayerActive) stopAIPlayer();
    aiMode = aiMode === 'auto' ? 'manual' : 'auto';
    const label = aiMode === 'auto' ? 'Auto' : 'Manual';
    aiBtn.textContent = `🤖 AI Play (${label})`;
    tts.interrupt(`Switched to ${label} mode.`);
    setTimeout(() => { if (!aiPlayerActive) aiBtn.textContent = '🤖 AI Play'; }, 2500);
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
    if (aiB) { aiB.classList.toggle('active', aiPlayerActive); aiB.textContent = aiPlayerActive ? '⏹ Stop AI' : '🤖 AI Play'; }
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
