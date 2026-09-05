// ─────────────────────────────────────────────────────────────────────────────
// DESKTOP AGENT — the container's half of the arena, for the X11 build.
//
// Replaces the headless-Chromium host page. Same job, different mechanism:
//
//   capture   ffmpeg x11grab -> H.264 Annex-B -> access units -> relay chunks
//   audio     ffmpeg pulse monitor -> Opus in Ogg -> raw packets -> relay
//   input     merged keys from the relay -> real X key events via xdotool
//
// The wire protocol is byte-identical to the wasm host, so the relay and every
// viewer's decoder are untouched. That is the whole point of doing it this way:
// swapping the game engine should not reach the client.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { spawn } = require('child_process');
const WebSocket = require('ws');

const RELAY   = process.env.ARENA_RELAY || 'ws://127.0.0.1:8090/host';
const TOKEN   = process.env.ARENA_HOST_TOKEN || '';
const W       = Number(process.env.ARENA_W || 854);
const H       = Number(process.env.ARENA_H || 480);
const FPS     = Number(process.env.ARENA_FPS || 30);
const BITRATE = Number(process.env.ARENA_BITRATE || 2_000_000);
const DISPLAY = process.env.DISPLAY || ':99';
// The X screen can be bigger than the stream. Games draw at desktop size; the
// encoder scales down, so a game wanting 1280x720 does not cost 2.25x bitrate.
const SCREEN_W = Number(process.env.ARENA_SCREEN_W || W);
const SCREEN_H = Number(process.env.ARENA_SCREEN_H || H);

const KIND = { VCONF: 1, VKEY: 2, VDELTA: 3, ACONF: 4, ACHUNK: 5 };

let ws = null;
let wsReady = false;

function log(...a) { console.log('[agent]', ...a); }

function frame(kind, timestamp, payload) {
    const out = Buffer.allocUnsafe(9 + payload.length);
    out[0] = kind;
    out.writeDoubleLE(timestamp, 1);
    payload.copy(out, 9);
    return out;
}

function sendMedia(kind, ts, payload) {
    if (!wsReady) return;
    // Drop rather than queue: a stale frame is worse than a missing one, and the
    // relay asks for a fresh keyframe whenever a viewer needs one.
    if (ws.bufferedAmount > 4 * 1024 * 1024) return;
    try { ws.send(frame(kind, ts, payload)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO — Annex-B access-unit splitter, delimited by AUD.
//
// The first version assumed "one slice per frame", so it flushed an access unit
// on every VCL NAL. That is wrong for -preset ultrafast, which turns on sliced
// threading and emits SEVERAL slices per picture: the measured output was
// exactly 2x the requested framerate (1798 frames per 30s at -framerate 30),
// and every chunk was half a frame.
//
// So ffmpeg is asked for access unit delimiters (x264 aud=1) and we split on
// those instead. A NAL of type 9 opens a new picture, which groups any number
// of slices correctly and needs no assumptions about the encoder's threading.
// ─────────────────────────────────────────────────────────────────────────────
function nalType(nal) { return nal.length ? (nal[0] & 0x1f) : 0; }

class AnnexBSplitter {
    constructor(onAccessUnit) {
        this.buf = Buffer.alloc(0);
        this.pending = [];
        this.hasIDR = false;
        this.hasVCL = false;
        this.onAccessUnit = onAccessUnit;
    }

    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        let start = this.findStart(0);
        if (start < 0) return;
        let next;
        while ((next = this.findStart(start.end)) !== -1 && next !== null) {
            this.emitNal(this.buf.subarray(start.end, next.idx));
            start = next;
        }
        // Keep the tail (an incomplete NAL) for the next read.
        this.buf = this.buf.subarray(start.idx);
    }

    // Returns {idx, end} for the next start code at or after `from`.
    findStart(from) {
        for (let i = from; i + 3 < this.buf.length; i++) {
            if (this.buf[i] === 0 && this.buf[i + 1] === 0) {
                if (this.buf[i + 2] === 1) return { idx: i, end: i + 3 };
                if (this.buf[i + 2] === 0 && this.buf[i + 3] === 1) return { idx: i, end: i + 4 };
            }
        }
        return -1;
    }

    emitNal(nal) {
        if (!nal.length) return;
        const t = nalType(nal);

        // An AUD opens a new picture: flush whatever we had accumulated.
        if (t === 9 && this.hasVCL) this.flush();

        // Re-prepend the start code: the decoder wants Annex-B, not bare NALs.
        this.pending.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]));
        if (t === 5) this.hasIDR = true;
        if (t === 1 || t === 5) this.hasVCL = true;
    }

    flush() {
        if (!this.pending.length) return;
        const au = Buffer.concat(this.pending);
        const key = this.hasIDR;
        this.pending = [];
        this.hasIDR = false;
        this.hasVCL = false;
        this.onAccessUnit(au, key);
    }
}

let videoFrames = 0;
function startVideo() {
    const args = [
        '-loglevel', 'error',
        '-f', 'x11grab', '-draw_mouse', '0',
        '-framerate', String(FPS), '-video_size', `${SCREEN_W}x${SCREEN_H}`, '-i', DISPLAY,
        '-an',
        '-c:v', 'libx264',
        // zerolatency + ultrafast is the only thing that fits a software encoder
        // alongside a software-rendered game on 2 shared vCPUs.
        '-preset', 'ultrafast', '-tune', 'zerolatency',
        // aud=1 makes x264 emit access unit delimiters, which is the only
        // unambiguous frame boundary once sliced threading is in play.
        '-x264-params', 'aud=1',
        '-profile:v', 'baseline', '-level', '3.1',
        // Downscale desktop -> stream. fast_bilinear is the cheapest filter that
        // still looks right, and this runs alongside a software-rendered game.
        ...(SCREEN_W !== W || SCREEN_H !== H
            ? ['-vf', `scale=${W}:${H}:flags=fast_bilinear`] : []),
        '-pix_fmt', 'yuv420p',
        '-g', String(FPS * 2),          // keyframe every 2s, matching the wasm host
        '-b:v', String(BITRATE), '-maxrate', String(BITRATE), '-bufsize', String(BITRATE),
        '-f', 'h264', 'pipe:1',
    ];
    log('video:', 'x264 baseline', `desktop ${SCREEN_W}x${SCREEN_H} -> stream ${W}x${H}@${FPS}`, `${(BITRATE / 1000) | 0}kbps`);
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let ts = 0;
    const step = 1_000_000 / FPS;   // microseconds per frame
    const splitter = new AnnexBSplitter((au, key) => {
        videoFrames++;
        sendMedia(key ? KIND.VKEY : KIND.VDELTA, ts, au);
        ts += step;
    });

    ff.stdout.on('data', (d) => splitter.push(d));
    ff.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log('ffmpeg/v:', s.slice(0, 200)); });
    ff.on('exit', (code) => { log('ffmpeg/v exited', code, '— restarting in 2s'); setTimeout(startVideo, 2000); });
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO — Opus packets pulled out of an Ogg stream.
//
// WebCodecs wants raw Opus packets, and ffmpeg's only sane Opus output is Ogg,
// so we unwrap the pages here. The first two packets are OpusHead/OpusTags
// metadata and are dropped — the decoder is configured from known values.
// ─────────────────────────────────────────────────────────────────────────────
class OggOpusReader {
    constructor(onPacket) {
        this.buf = Buffer.alloc(0);
        this.partial = [];
        this.packetIndex = 0;
        this.onPacket = onPacket;
    }

    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        for (;;) {
            if (this.buf.length < 27) return;
            if (this.buf.subarray(0, 4).toString('latin1') !== 'OggS') {
                const at = this.buf.indexOf('OggS', 1, 'latin1');
                if (at < 0) { this.buf = Buffer.alloc(0); return; }
                this.buf = this.buf.subarray(at);
                continue;
            }
            const segCount = this.buf[26];
            const headerLen = 27 + segCount;
            if (this.buf.length < headerLen) return;
            const table = this.buf.subarray(27, headerLen);
            const bodyLen = table.reduce((a, b) => a + b, 0);
            if (this.buf.length < headerLen + bodyLen) return;

            let off = headerLen;
            for (const segLen of table) {
                this.partial.push(this.buf.subarray(off, off + segLen));
                off += segLen;
                if (segLen < 255) {                 // packet complete
                    const packet = Buffer.concat(this.partial);
                    this.partial = [];
                    if (this.packetIndex++ >= 2 && packet.length) this.onPacket(packet);
                }
            }
            this.buf = this.buf.subarray(headerLen + bodyLen);
        }
    }
}

function startAudio() {
    const args = [
        '-loglevel', 'error',
        '-f', 'pulse', '-i', 'arena.monitor',
        // Carried over from the vnc-activity box: without wallclock timestamps and
        // async resampling the pulse monitor yields non-monotonic DTS and the
        // stream is undecodable.
        '-use_wallclock_as_timestamps', '1', '-af', 'aresample=async=1',
        '-c:a', 'libopus', '-b:a', '96000', '-ar', '48000', '-ac', '2',
        '-frame_duration', '20',
        // THE reason audio arrived in ~1s bursts with silence between them.
        //
        // ffmpeg's Ogg muxer defaults to page_duration = 1000000us: it batches a
        // whole SECOND of Opus packets into one page before flushing. Live audio
        // then reaches the client as one big burst per second, so the ring buffer
        // plays what it got, underruns, sits silent waiting for the next page,
        // refills, plays — an on/off cycle at roughly 1Hz.
        //
        // 20000us = one page per 20ms frame, and flush_packets stops libavformat
        // holding anything back on its own.
        '-page_duration', '20000',
        '-flush_packets', '1',
        '-f', 'ogg', 'pipe:1',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let ts = 0;
    const reader = new OggOpusReader((packet) => {
        sendMedia(KIND.ACHUNK, ts, packet);
        ts += 20_000;   // 20ms frames
    });
    ff.stdout.on('data', (d) => reader.push(d));
    ff.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log('ffmpeg/a:', s.slice(0, 160)); });
    ff.on('exit', (code) => { log('ffmpeg/a exited', code, '— restarting in 3s'); setTimeout(startAudio, 3000); });
}

module.exports = { AnnexBSplitter, OggOpusReader };

// ── Relay link ───────────────────────────────────────────────────────────────
const { applyInput, applyMouse, releaseAll } = require('./input.js');
const launcher = require('./launcher.js');

function reportGames() {
    if (!wsReady) return;
    // Only games whose ROM and core actually exist. Advertising one that cannot
    // launch would let it collect votes and then fail, which reads as "the vote
    // is broken" rather than "that ROM isn't uploaded".
    const list = launcher.availableGames().map((g) => ({
        id: g.id, name: g.name, system: g.system, layout: g.layout,
    }));
    ws.send(JSON.stringify({ t: 'games', list, current: launcher.current() }));
}

function connect() {
    ws = new WebSocket(RELAY + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''));
    ws.on('open', () => {
        wsReady = true;
        log('relay connected');
        // No `description`: Annex-B streams carry their SPS/PPS inline, and the
        // viewer's VideoDecoder takes that when description is absent.
        ws.send(JSON.stringify({ t: 'vconfig', config: { codec: 'avc1.42001f', codedWidth: W, codedHeight: H } }));
        ws.send(JSON.stringify({ t: 'aconfig', config: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } }));
        reportGames();
    });
    ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.t === 'input') applyInput(Array.isArray(msg.keys) ? msg.keys : [], msg.adminKeys);
        else if (msg.t === 'mouse') applyMouse(msg);
        else if (msg.t === 'launch') {
            // Release everything first: a key still held from the previous game
            // would arrive in the new one as a stuck input nobody can clear.
            releaseAll();
            launcher.launch(msg.id, (err) => {
                if (err) log('launch failed:', err.message);
                if (wsReady) ws.send(JSON.stringify({ t: 'current', id: launcher.current() }));
            });
        }
        else if (msg.t === 'stop') {
            releaseAll();
            launcher.stop(() => {
                if (wsReady) ws.send(JSON.stringify({ t: 'current', id: null }));
            });
        }
        else if (msg.t === 'reload') { log('relay asked for a reload'); process.exit(1); }
        // 'keyframe' is a no-op: x264 is already on a fixed 2s GOP, and forcing
        // one out of a running ffmpeg would mean restarting the encoder.
    });
    ws.on('close', () => {
        wsReady = false;
        releaseAll();   // never leave a key stuck down across a reconnect
        setTimeout(connect, 1000);
    });
    ws.on('error', () => {});
}

if (require.main === module) {
    launcher.idleScreen();
    connect();
    startVideo();
    startAudio();
    setInterval(() => {
        log(`${videoFrames} frames in the last 30s (${(videoFrames / 30).toFixed(1)} fps)`);
        videoFrames = 0;
    }, 30000);
}
