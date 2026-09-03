// ─────────────────────────────────────────────────────────────────────────────
// Continuous audio playback from a ring buffer.
//
// The first implementation scheduled one AudioBufferSourceNode per decoded Opus
// packet and chained them by timestamp. At 20ms per packet that is 50 separate
// nodes a second, each with its own start boundary, and the result chopped
// constantly: every boundary is a potential click, floating-point drift
// accumulates across them, and any network jitter pushed the write head behind
// the clock so the re-anchor logic jumped forward and tore a hole in the sound.
//
// A ring buffer fixes the class of problem rather than the symptom. The worklet
// pulls whatever is available every render quantum, so playback is ONE
// continuous stream and packet boundaries stop existing as far as the audio
// graph is concerned.
//
// No SharedArrayBuffer: that needs COOP/COEP, and those headers break the
// Discord activity iframe. Samples arrive by postMessage instead.
// ─────────────────────────────────────────────────────────────────────────────

class ArenaPlayer extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.channels = opts.channels || 2;
        // Ring sized in samples per channel. 2s is far more than we ever hold;
        // it exists so a burst cannot wrap and corrupt what has not played yet.
        this.size = Math.max(4096, Math.floor((opts.ringSeconds || 2) * sampleRate));
        this.ring = [];
        for (let c = 0; c < this.channels; c++) this.ring.push(new Float32Array(this.size));
        this.writeIdx = 0;
        this.readIdx = 0;
        this.available = 0;

        // Wait for this much before starting, then keep roughly this much in
        // hand. Too small and every jitter spike underruns; too large and the
        // game feels laggy.
        this.targetFill = Math.floor((opts.targetMs || 120) / 1000 * sampleRate);
        this.maxFill = Math.floor((opts.maxMs || 400) / 1000 * sampleRate);
        this.priming = true;
        this.underruns = 0;

        this.port.onmessage = (e) => {
            const d = e.data;
            if (d && d.type === 'samples') this.write(d.channels);
            else if (d && d.type === 'reset') this.reset();
        };
    }

    reset() {
        this.writeIdx = this.readIdx = this.available = 0;
        this.priming = true;
    }

    write(chans) {
        const n = chans[0] ? chans[0].length : 0;
        if (!n) return;

        // Running long means we are drifting behind live and the lag only grows.
        // Drop the OLDEST audio rather than the newest: skipping forward costs
        // one glitch, while playing an ever-growing backlog is permanent lag.
        if (this.available + n > this.maxFill) {
            const drop = Math.min(this.available, this.available + n - this.targetFill);
            this.readIdx = (this.readIdx + drop) % this.size;
            this.available -= drop;
        }

        for (let c = 0; c < this.channels; c++) {
            const src = chans[Math.min(c, chans.length - 1)];
            const dst = this.ring[c];
            let w = this.writeIdx;
            for (let i = 0; i < n; i++) {
                dst[w] = src[i];
                w = w + 1 === this.size ? 0 : w + 1;
            }
        }
        this.writeIdx = (this.writeIdx + n) % this.size;
        this.available += n;
        if (this.priming && this.available >= this.targetFill) this.priming = false;
    }

    process(_inputs, outputs) {
        const out = outputs[0];
        const n = out[0].length;

        // While priming (or after an underrun) output silence rather than
        // whatever stale samples happen to be in the ring.
        if (this.priming || this.available < n) {
            for (let c = 0; c < out.length; c++) out[c].fill(0);
            if (!this.priming) { this.underruns++; this.priming = true; }
            return true;
        }

        for (let c = 0; c < out.length; c++) {
            const src = this.ring[Math.min(c, this.channels - 1)];
            const dst = out[c];
            let r = this.readIdx;
            for (let i = 0; i < n; i++) {
                dst[i] = src[r];
                r = r + 1 === this.size ? 0 : r + 1;
            }
        }
        this.readIdx = (this.readIdx + n) % this.size;
        this.available -= n;
        return true;
    }
}

registerProcessor('arena-player', ArenaPlayer);
