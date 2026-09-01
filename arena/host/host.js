// ─────────────────────────────────────────────────────────────────────────────
// ARENA HOST — the single authoritative Super Mario 64.
//
// This file runs in a headless Chromium inside the container, and nowhere else.
// It is the only place sm64.wasm executes. Its job is three things:
//
//   1. boot the game
//   2. take a merged controller state off the relay and press those keys
//   3. encode the canvas + game audio and push them to the relay
//
// Viewers never run this. They get pixels.
// ─────────────────────────────────────────────────────────────────────────────

const params   = new URLSearchParams(location.search);
const RELAY    = params.get('relay') || 'ws://127.0.0.1:8090/host';
const TOKEN    = params.get('token') || '';
const FPS      = Number(params.get('fps') || 30);
const BITRATE  = Number(params.get('bitrate') || 1_800_000);
const RENDER_W = Number(params.get('w') || 320);
const RENDER_H = Number(params.get('h') || 240);

// ─────────────────────────────────────────────────────────────────────────────
// PIN THE VIEWPORT — this must run before sm64.js.
//
// The wasm imports exactly four sizing thunks from JS (sm64.js:1808-1811):
//
//     function() { return screen.width;        }
//     function() { return screen.height;       }
//     function() { return window.innerWidth;   }
//     function() { return window.innerHeight;  }
//
// Headless Chromium reports a 1920x1080 SCREEN regardless of --window-size, so
// the game sized itself to 1080p and rendered it through SwiftShader on a box
// with no GPU: 2-3 fps, and past H.264 level 3.1's ~720p ceiling, so the encoder
// silently fell back to VP8 as well.
//
// A first attempt pinned only the window pair and changed nothing — the game
// reads the SCREEN pair. All four are pinned now, which is the complete set of
// questions the binary can ask about display size.
//
// Fighting the resize afterwards cannot work: by the time a frame reaches us it
// has already been rendered at full cost. 320x240 is the N64's real output
// resolution, so this is not a downgrade — it is the correct size, and viewers
// upscale it with image-rendering: pixelated.
// ─────────────────────────────────────────────────────────────────────────────
function pin(obj, prop, value) {
    try {
        Object.defineProperty(obj, prop, { get: () => value, configurable: true });
    } catch (err) {
        console.warn(`[host] could not pin ${prop}`, err);
    }
}
pin(window, 'innerWidth', RENDER_W);
pin(window, 'innerHeight', RENDER_H);
pin(window.screen, 'width', RENDER_W);
pin(window.screen, 'height', RENDER_H);
pin(window.screen, 'availWidth', RENDER_W);
pin(window.screen, 'availHeight', RENDER_H);

const KIND = { VCONF: 1, VKEY: 2, VDELTA: 3, ACONF: 4, ACHUNK: 5 };

let ws = null;
let wsReady = false;
let wantKeyframe = true;
let videoEncoder = null;
let audioEncoder = null;
let sentVideoConfig = false;
let sentAudioConfig = false;

function log(...a) {
    console.log('[host]', ...a);
    if (wsReady) try { ws.send(JSON.stringify({ t: 'log', text: a.join(' ') })); } catch {}
}

// ── Framing: [kind:u8][timestamp:f64][payload] ───────────────────────────────
function frame(kind, timestamp, payload) {
    const out = new Uint8Array(9 + payload.byteLength);
    out[0] = kind;
    new DataView(out.buffer).setFloat64(1, timestamp, true);
    out.set(new Uint8Array(payload), 9);
    return out;
}

function sendMedia(kind, timestamp, chunkBytes) {
    if (!wsReady) return;
    // If the socket is backing up, drop rather than queue — a stale frame is
    // worse than a missing one, and the relay re-keyframes on demand anyway.
    if (ws.bufferedAmount > 4 * 1024 * 1024) return;
    try { ws.send(frame(kind, timestamp, chunkBytes)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// INPUT — merged controller from the relay, replayed as real key events.
//
// The wasm is the SM64 decomp port built with SDL2, which registers its keyboard
// handler at the window level. Synthetic KeyboardEvents (isTrusted === false)
// reach it exactly like real ones — this is the same injection path the repo's
// AI player already used, so it is known-good.
//
// We hold keys across ticks instead of tapping them: Mario has to be able to RUN,
// and a tap-per-tick would make him stutter in place.
// ─────────────────────────────────────────────────────────────────────────────
const held = new Set();

function keyEvent(type, code) {
    const init = { code, key: code, bubbles: true, cancelable: true };
    const canvas = document.getElementById('canvas');
    if (canvas) canvas.dispatchEvent(new KeyboardEvent(type, init));
    document.dispatchEvent(new KeyboardEvent(type, init));
    window.dispatchEvent(new KeyboardEvent(type, init));
}

function applyInput(keys) {
    const desired = new Set(keys);
    for (const code of [...held]) {
        if (!desired.has(code)) { keyEvent('keyup', code); held.delete(code); }
    }
    for (const code of desired) {
        if (!held.has(code)) { keyEvent('keydown', code); held.add(code); }
    }
}

function releaseAll() {
    for (const code of held) keyEvent('keyup', code);
    held.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO CAPTURE
//
// Emscripten's SDL2 backend builds its graph and connects it to
// `audioContext.destination`. In a headless container there are no speakers, so
// instead of chasing the graph we shadow `destination` on the instance with a
// MediaStreamAudioDestinationNode. The game connects to it none the wiser, and
// we get a real MediaStream to encode. This must be installed BEFORE sm64.js
// constructs its context, which is why it runs at the top of this module.
// ─────────────────────────────────────────────────────────────────────────────
let capturedAudioStream = null;

(function patchAudioContext() {
    const Native = window.AudioContext || window.webkitAudioContext;
    if (!Native) return;
    class ArenaAudioContext extends Native {
        constructor(...args) {
            super(...args);
            let sink = null;
            try {
                sink = this.createMediaStreamDestination();
                capturedAudioStream = sink.stream;
            } catch (err) { console.warn('[host] audio capture unavailable', err); }
            if (sink) {
                Object.defineProperty(this, 'destination', {
                    get: () => sink,
                    configurable: true,
                });
            }
        }
    }
    window.AudioContext = ArenaAudioContext;
    window.webkitAudioContext = ArenaAudioContext;
})();

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO ENCODE
//
// Frames come from canvas.captureStream() rather than `new VideoFrame(canvas)`:
// the game renders through WebGL without preserveDrawingBuffer, so reading the
// element directly races the compositor and yields blank frames. captureStream
// is the supported way to get a stable frame off a live WebGL canvas.
// ─────────────────────────────────────────────────────────────────────────────
const CODEC_CANDIDATES = [
    // H.264 baseline first: every Discord client decodes it, often in hardware.
    { codec: 'avc1.42001f', avc: { format: 'annexb' } },
    { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
    // VP8/VP9 are the guaranteed-software fallbacks if this Chromium build
    // shipped without an H.264 encoder.
    { codec: 'vp8' },
    { codec: 'vp09.00.10.08' },
];

async function pickVideoCodec(width, height) {
    for (const cand of CODEC_CANDIDATES) {
        const config = {
            ...cand,
            width, height,
            bitrate: BITRATE,
            framerate: FPS,
            latencyMode: 'realtime',
        };
        try {
            const support = await VideoEncoder.isConfigSupported(config);
            if (support && support.supported) return config;
        } catch {}
    }
    return null;
}

async function startVideo(canvas) {
    const width  = canvas.width  || 640;
    const height = canvas.height || 480;
    const config = await pickVideoCodec(width, height);
    if (!config) { log('FATAL: no supported video encoder config'); return; }
    log(`video: ${config.codec} ${width}x${height}@${FPS} ${(BITRATE / 1000) | 0}kbps`);

    videoEncoder = new VideoEncoder({
        output: (chunk, metadata) => {
            if (!sentVideoConfig && metadata && metadata.decoderConfig) {
                const dc = metadata.decoderConfig;
                const desc = dc.description
                    ? btoa(String.fromCharCode(...new Uint8Array(
                        dc.description.buffer || dc.description)))
                    : null;
                sentVideoConfig = true;
                ws.send(JSON.stringify({
                    t: 'vconfig',
                    config: {
                        codec: dc.codec,
                        codedWidth: dc.codedWidth || width,
                        codedHeight: dc.codedHeight || height,
                        description: desc,
                    },
                }));
            }
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            sendMedia(chunk.type === 'key' ? KIND.VKEY : KIND.VDELTA, chunk.timestamp, bytes);
        },
        error: (err) => log('video encoder error:', err.message),
    });
    videoEncoder.configure(config);

    const stream = canvas.captureStream(FPS);
    const track = stream.getVideoTracks()[0];
    if (!track) { log('FATAL: canvas produced no video track'); return; }
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();

    let n = 0;
    for (;;) {
        const { value: videoFrame, done } = await reader.read();
        if (done) break;
        if (!videoEncoder || videoEncoder.state !== 'configured') { videoFrame.close(); continue; }
        // Never let the encoder fall behind the game; drop instead of buffering.
        if (videoEncoder.encodeQueueSize > 2) { videoFrame.close(); continue; }
        // The game can change resolution after we configured the encoder. Feeding
        // mismatched frames produces garbage, so rebuild the pipeline instead.
        if (videoFrame.displayWidth !== config.width || videoFrame.displayHeight !== config.height) {
            log(`canvas resized to ${videoFrame.displayWidth}x${videoFrame.displayHeight} — reconfiguring`);
            videoFrame.close();
            try { reader.cancel(); } catch {}
            try { videoEncoder.close(); } catch {}
            videoEncoder = null;
            sentVideoConfig = false;
            startVideo(canvas);
            return;
        }
        const key = wantKeyframe || (n++ % (FPS * 2) === 0);
        wantKeyframe = false;
        try { videoEncoder.encode(videoFrame, { keyFrame: key }); } catch (err) { log('encode failed', err.message); }
        videoFrame.close();
    }
}

async function startAudio() {
    // SDL2 does not build its AudioContext at startup — it waits until the game
    // actually plays a sound, which is well after onRuntimeInitialized. Checking
    // once meant we always lost the race and every session ran silent. Poll for
    // it instead, then start encoding whenever it shows up.
    for (let i = 0; i < 600 && !capturedAudioStream; i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    if (!capturedAudioStream) { log('no audio stream after 60s — running silent'); return; }
    log('audio stream captured');
    const track = capturedAudioStream.getAudioTracks()[0];
    if (!track) { log('no audio track — running silent'); return; }

    audioEncoder = new AudioEncoder({
        output: (chunk, metadata) => {
            if (!sentAudioConfig && metadata && metadata.decoderConfig) {
                const dc = metadata.decoderConfig;
                const desc = dc.description
                    ? btoa(String.fromCharCode(...new Uint8Array(
                        dc.description.buffer || dc.description)))
                    : null;
                sentAudioConfig = true;
                ws.send(JSON.stringify({
                    t: 'aconfig',
                    config: {
                        codec: dc.codec,
                        sampleRate: dc.sampleRate,
                        numberOfChannels: dc.numberOfChannels,
                        description: desc,
                    },
                }));
            }
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            sendMedia(KIND.ACHUNK, chunk.timestamp, bytes);
        },
        error: (err) => log('audio encoder error:', err.message),
    });

    const settings = track.getSettings ? track.getSettings() : {};
    audioEncoder.configure({
        codec: 'opus',
        sampleRate: settings.sampleRate || 48000,
        numberOfChannels: settings.channelCount || 2,
        bitrate: 96_000,
    });

    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    for (;;) {
        const { value: audioData, done } = await reader.read();
        if (done) break;
        if (!audioEncoder || audioEncoder.state !== 'configured') { audioData.close(); continue; }
        if (audioEncoder.encodeQueueSize > 8) { audioData.close(); continue; }
        try { audioEncoder.encode(audioData); } catch {}
        audioData.close();
    }
}

// ── Relay link ───────────────────────────────────────────────────────────────
function connect() {
    const url = RELAY + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        wsReady = true;
        log('relay connected');
        // A fresh relay has no cached config; resend on every reconnect.
        sentVideoConfig = false;
        sentAudioConfig = false;
        wantKeyframe = true;
    };
    ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'input') applyInput(Array.isArray(msg.keys) ? msg.keys : []);
        else if (msg.t === 'keyframe') wantKeyframe = true;
    };
    ws.onclose = () => {
        wsReady = false;
        releaseAll();   // don't leave Mario sprinting into a wall forever
        setTimeout(connect, 1000);
    };
    ws.onerror = () => {};
}

// ── Boot ─────────────────────────────────────────────────────────────────────
window.__arenaStart = async function arenaStart() {
    const canvas = document.getElementById('canvas');
    connect();
    // Wait for a size the GAME chose, not the placeholder.
    //
    // The first version waited for `width > 1`, which an untouched 300x150
    // canvas satisfies instantly — so the encoder got configured against a
    // blank placeholder before the wasm ever set its viewport, and every viewer
    // received a squashed 300x150 stream. Wait for a plausible game resolution
    // instead, and settle for whatever we have if the game never resizes.
    const MIN_W = Math.min(256, RENDER_W), MIN_H = Math.min(192, RENDER_H);
    for (let i = 0; i < 600 && !(canvas.width >= MIN_W && canvas.height >= MIN_H); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    log(`canvas ready ${canvas.width}x${canvas.height}`);
    try { if (Module.SDL2 && Module.SDL2.audioContext) await Module.SDL2.audioContext.resume(); } catch {}
    startVideo(canvas);
    startAudio();
};
