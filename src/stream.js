// ============================================================
// src/stream.js — the "everyone sees the same screen" layer.
//
// Discord's Activity proxy explicitly does not carry WebRTC, so no
// RTCPeerConnection/RTP captureStream heroics. What it does carry is WebSockets,
// and a 2D game at 8–12 fps in ~420×315 JPEG is ~150–350 kbit/s — plenty for a
// shared view of Mario, and cheap enough that the relay can fan it out to
// several spectators at once.
//
// Two roles:
//   FrameStream (host)   : engine canvas → downscale → JPEG → relay.
//   FramePlayer (viewer) : relay bytes → ImageBitmap → its own canvas.
//
// The host also *throttles itself*: no watchers ⇒ the loop stops, so being the
// host of an empty room costs nothing extra.
// ============================================================

const MIN_W = 240, MAX_W = 720;

export class FrameStream {
    constructor({ source, send, viewers = () => 0, quality = 0.5, width = 480, fps = 10 } = {}) {
        this.source = source;                 // the wasm canvas
        this.send = send;                     // (jpegBytes, index, ts) => void
        this.viewers = viewers;
        this.width = width;
        this.quality = quality;
        this.fps = fps;
        this.out = document.createElement('canvas');
        this.ctx = this.out.getContext('2d', { alpha: false });
        this.running = false;
        this.index = 0;
        this.stats = { frames: 0, bytes: 0, kbps: 0, skipped: 0, t0: 0, tLast: 0, bytesWin: 0 };
        this._busy = false;
    }

    /** @returns {boolean} whether capturing actually started. */
    start() {
        if (this.running) return true;
        if (!this.ctx) {
            console.warn('[stream] no 2d context on the capture canvas — spectating is disabled');
            return false;
        }
        this.running = true;
        this.stats.t0 = this.stats.tLast = performance.now();
        this._tick();
        return true;
    }

    stop() {
        this.running = false;
        clearTimeout(this._t);
    }

    /**
     * Self-tuning: if the socket is backing up, shed resolution before frames,
     * then both. A chunkier picture that keeps up beats a crisp one 2 s behind.
     */
    tune(bufferedAmount = 0) {
        const congestion = bufferedAmount > 256 * 1024;
        if (congestion) {
            this.stats.congested = (this.stats.congested || 0) + 1;
            if (this.width > MIN_W) this.width = Math.max(MIN_W, Math.round(this.width * 0.85));
            else if (this.fps > 5) this.fps = Math.max(5, this.fps - 1);
            else this.quality = Math.max(0.3, this.quality - 0.05);
        } else if (this.stats.congested > 4) {
            this.stats.congested = 0;
            if (this.quality < 0.55) this.quality = Math.min(0.55, this.quality + 0.03);
            else if (this.width < MAX_W) this.width = Math.min(MAX_W, Math.round(this.width * 1.06));
        }
    }

    async _tick() {
        if (!this.running) return;
        // jsdom, a canvas under memory pressure, or a browser that refuses a
        // second 2d context: no picture is a fine answer, an exception per frame
        // is not.
        if (!this.ctx) return;
        const n = this.viewers();
        if (n <= 0 || document.hidden) {                 // nobody watching ⇒ idle
            this._t = setTimeout(() => this._tick(), 500);
            return;
        }
        const src = this.source;
        if (src && src.width > 2) {
            const w = Math.min(this.width, src.width);
            const h = Math.max(1, Math.round((src.height / src.width) * w));
            if (this.out.width !== w || this.out.height !== h) {
                this.out.width = w; this.out.height = h;
                this.ctx.imageSmoothingEnabled = true;
                this.ctx.imageSmoothingQuality = 'medium';
            }
            try { this.ctx.drawImage(src, 0, 0, w, h); } catch {}
            if (!this._busy) {
                this._busy = true;
                const bytes = await this._encode();
                this._busy = false;
                if (bytes) {
                    const ok = this.send(bytes, ++this.index, Date.now() & 0x7fffffff);
                    if (ok) {
                        this.stats.frames++; this.stats.bytes += bytes.byteLength; this.stats.bytesWin += bytes.byteLength;
                    } else this.stats.skipped++;
                }
            } else this.stats.skipped++;
        }
        const elapsed = performance.now() - this.stats.tLast;
        if (elapsed > 1000) {
            this.stats.kbps = Math.round((this.stats.bytesWin / 1024) * 8);
            this.stats.bytesWin = 0;
            this.stats.tLast = performance.now();
        }
        this._t = setTimeout(() => this._tick(), Math.max(40, 1000 / this.fps));
    }

    _encode() {
        return new Promise((resolve) => {
            try {
                if (this.out.convertToBlob) {            // OffscreenCanvas fast path
                    this.out.convertToBlob({ type: 'image/jpeg', quality: this.quality })
                        .then((b) => b.arrayBuffer()).then((ab) => resolve(new Uint8Array(ab)))
                        .catch(() => resolve(null));
                    return;
                }
                this.out.toBlob((blob) => {
                    if (!blob) return resolve(null);
                    blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(() => resolve(null));
                }, 'image/jpeg', this.quality);
            } catch { resolve(null); }
        });
    }
}

export class FramePlayer {
    constructor(target) {
        this.target = target;
        this.ctx = target.getContext('2d', { alpha: false });
        this.pending = null;
        this.busy = false;
        this.stats = { frames: 0, dropped: 0, last: 0, latency: 0, w: 0, h: 0 };
    }

    /** Called for every relay binary frame. Keeps at most one decode in flight. */
    push(frame) {
        if (!frame || !this.ctx) return;
        if (this.busy) { this.stats.dropped++; }
        this.pending = frame;
        if (!this.busy) this._drain();
    }

    async _drain() {
        if (!this.pending) { this.busy = false; return; }
        const f = this.pending;
        this.pending = this.busy = false;
        const c = this.target;
        const w = c.clientWidth || c.width || 480;
        const h = c.clientHeight || c.height || 360;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        try {
            let bmp;
            if (typeof createImageBitmap === 'function') {
                bmp = await createImageBitmap(new Blob([f.jpeg], { type: 'image/jpeg' }));
            } else {
                bmp = await new Promise((res) => {
                    const img = new Image();
                    const url = URL.createObjectURL(new Blob([f.jpeg], { type: 'image/jpeg' }));
                    img.onload = () => { URL.revokeObjectURL(url); res(img); };
                    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
                    img.src = url;
                });
            }
            if (bmp) {
                this.ctx.imageSmoothingEnabled = true;
                this.ctx.imageSmoothingQuality = 'high';
                this.ctx.drawImage(bmp, 0, 0, c.width, c.height);
                bmp.close?.();
                this.stats.frames++;
                this.stats.last = f.index;
                this.stats.w = bmp.width || this.stats.w;
                this.stats.h = bmp.height || this.stats.h;
                // The header ts is u32 ms (epoch wrapped at 2^31 ms ≈ every 24.8
                // days), so measure the delta in wrapped space, not against raw
                // Date.now() — otherwise the readout is nonsense by construction.
                const d = ((Date.now() & 0x7fffffff) - f.ts + 0x80000000) % 0x80000000;
                this.stats.latency = d;
            }
        } catch {}
        // Paint as fast as we can decode, but never ahead of the feed: pending
        // frames are coalesced into the newest one inside push().
        if (this.pending) { this._drain(); } else { this.busy = false; }
    }

    clear() {
        this.pending = null;
        try { this.ctx.fillStyle = '#05070c'; this.ctx.fillRect(0, 0, this.target.width, this.target.height); } catch {}
    }
}
