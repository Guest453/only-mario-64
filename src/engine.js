// ============================================================
// src/engine.js — glue around the vendored SM64 wasm build.
//
// The engine itself is sm64.js + sm64.wasm (Super Mario 64 decompilation, PC
// port, Emscripten). It boots by reading a global `Module` object, which
// index.html configures before loading sm64.js. All that is left to care about:
//   • know when the runtime is up — that is our "ready" signal for host election,
//   • mute/unmute the SDL audio context (Discord also needs a gesture first),
//   • stay honest when the wasm is missing or blocked, instead of hanging.
//
// Sizing note, because it broke a previous build: the canvas backing store is
// owned by SDL/Emscripten. Resizing `canvas.width` from the outside clears the
// surface without moving the GL viewport, which yields a black or half-drawn
// frame. So the layout is done with CSS only and the engine keeps its own res.
// ============================================================

let ready = false;

export function engineReady() { return ready; }

/** Resolves true once the wasm runtime is initialised, false on timeout. */
export function whenEngine(timeoutMs = 60000) {
    if (ready) return Promise.resolve(true);
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done || !window.__SM64_READY) return;
            done = true;
            clearInterval(poll);
            clearTimeout(timer);
            removeEventListener('sm64:ready', finish);
            ready = true;
            resolve(true);
        };
        const poll = setInterval(finish, 400);
        const timer = setTimeout(() => { if (done) return; done = true; clearInterval(poll); resolve(false); }, timeoutMs);
        addEventListener('sm64:ready', finish, { once: true });
    });
}

export function setMuted(muted) {
    try {
        const ctx = window.Module?.SDL2?.audioContext;
        if (!ctx) return false;
        if (muted) ctx.suspend?.(); else ctx.resume?.();
        return true;
    } catch { return false; }
}

/** Browsers (and Discord's iframe) only let audio start after a user gesture. */
export function resumeAudio() {
    try {
        const ctx = window.Module?.SDL2?.audioContext;
        if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch {}
}

/** Internal render size, for the diagnostics panel. */
export function engineSize() {
    const c = document.getElementById('canvas');
    return c ? { w: c.width, h: c.height } : { w: 0, h: 0 };
}
