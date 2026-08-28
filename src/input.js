// ============================================================
// src/input.js — one controller abstraction, two directions.
//
//   LOCAL  → we capture keyboard / touch / gamepad into a 16-bit mask, and (in
//            multiplayer) swallow the real key events so they cannot bypass the
//            arbitration. The captured mask goes to the relay as an `in` message.
//   REMOTE → the host turns an *arbitrated* mask back into synthetic key events
//            aimed at the wasm's SDL2 handler. That is the whole multiplayer
//            trick: SM64 decomp-on-wasm has no netcode and exposes no engine
//            hooks, but it does read a keyboard, so we give it a phantom one.
//
// Ordering note that makes the swallow work: our capture listeners are attached
// while this module runs, i.e. before Emscripten finishes instantiating the wasm
// and registers its own window-level key handlers. Same target ⇒ registration
// order decides, so we win. Synthetic events are re-dispatched afterwards and
// are `isTrusted:false`, which is how we avoid swallowing our own injection.
// ============================================================

import { BTN, CODE_TO_BITS, KEY_FOR_BIT, STICK_BITS } from './protocol.js';

const GAME_CODES = new Set(Object.keys(CODE_TO_BITS));
const isTypingTarget = (el) => !!el && (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
);

export class LocalController {
    /**
     * @param {(bits:number)=>void} onBits  called whenever the local mask changes
     * @param {()=>boolean} swallow         true ⇒ real keys must NOT reach the game
     */
    constructor({ onBits, swallow = () => false, onActivity = null } = {}) {
        this.onBits = onBits || (() => {});
        this.swallow = swallow;
        this.onActivity = onActivity;
        this.codes = new Set();      // physical codes currently down
        this.bits = 0;
        this.padBits = 0;            // gamepad, polled per frame
        this.touchBits = 0;          // on-screen pad (mobile Discord)
        this.enabled = true;         // false ⇒ pass keys straight through to the game
        this._padPrev = 0;

        const cap = (type) => (e) => {
            if (!this.enabled) return;                 // solo/local: let the wasm see keys
            if (!e.isTrusted) return;                  // our own injected events: ignore
            if (isTypingTarget(e.target)) return;      // chat box keeps the keyboard
            if (!GAME_CODES.has(e.code)) return;
            e.preventDefault();
            e.stopImmediatePropagation?.();
            e.stopPropagation?.();
            if (this.swallow()) {
                // Multiplayer: the key is *ours* to sample; the engine only ever
                // sees the arbitrated result the host injects.
                if (type === 'down') this.codes.add(e.code); else this.codes.delete(e.code);
                this._emit();
            } else {
                // Free-roam mode: sample and also forward to the engine ourselves so
                // the "swallow" is invisible to the player.
                if (type === 'down') this.codes.add(e.code); else this.codes.delete(e.code);
                this._emit();
                inject(e.type === 'keydown' ? 'keydown' : 'keyup', e.code);
            }
        };
        this._down = cap('down');
        this._up = cap('up');
        addEventListener('keydown', this._down, { capture: true, passive: false });
        addEventListener('keyup', this._up, { capture: true, passive: false });
        // Losing focus mid-jump otherwise leaves a key stuck down forever.
        addEventListener('blur', () => this.releaseAll());
        addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
        if (navigator.getGamepads) requestAnimationFrame(() => this._pollPad());
    }

    _emit() {
        let b = 0;
        for (const c of this.codes) b |= CODE_TO_BITS[c] || 0;
        b |= this.padBits | this.touchBits;
        if (b !== this.bits) {
            this.bits = b;
            this.onBits(b);
        }
        this.onActivity?.(b);
    }

    _pollPad() {
        let b = 0;
        const pads = navigator.getGamepads?.() || [];
        for (const gp of pads) {
            if (!gp) continue;
            const ax = gp.axes || [], bt = gp.buttons || [];
            const held = (i) => !!bt[i]?.pressed || (bt[i]?.value || 0) > 0.5;
            const dz = 0.35;
            if ((ax[1] ?? 0) < -dz || held(12)) b |= BTN.UP;
            if ((ax[1] ?? 0) > dz || held(13)) b |= BTN.DOWN;
            if ((ax[0] ?? 0) < -dz || held(14)) b |= BTN.LEFT;
            if ((ax[0] ?? 0) > dz || held(15)) b |= BTN.RIGHT;
            if (held(0)) b |= BTN.A;                                       // Xbox A / PS ✕ = jump
            if (held(2) || held(3)) b |= BTN.B;                            // X / Y = punch, dive, grab
            if (held(1) || (bt[6]?.value || 0) > 0.5 || (bt[7]?.value || 0) > 0.5) b |= BTN.Z; // B / triggers = Z
            if (held(9)) b |= BTN.START;
            break;                                          // first pad only
        }
        this.padBits = b;
        if (b !== this._padPrev) { this._padPrev = b; this._emit(); }
        requestAnimationFrame(() => this._pollPad());
    }

    releaseAll() { this.codes.clear(); this.padBits = 0; this.touchBits = 0; this._emit(); }
    destroy() {
        removeEventListener('keydown', this._down, { capture: true });
        removeEventListener('keyup', this._up, { capture: true });
    }
}

// ── phantom keyboard ───────────────────────────────────────────────────
let held = new Set();

function eventTargets() {
    const out = [];
    const c = document.getElementById('canvas');
    if (c) out.push(c);
    out.push(document);
    if (out[0] !== window) out.push(window);
    return out;
}

/**
 * Send one raw key transition at the engine. We dispatch on the canvas AND
 * document/window because which one SDL2 ended up hooking depends on how this
 * particular emscripten build was linked.
 */
export function inject(type, code) {
    const o = { code, key: code, bubbles: true, cancelable: true };
    for (const t of eventTargets()) {
        try { t.dispatchEvent(new KeyboardEvent(type, o)); } catch {}
    }
}

/** Apply a whole controller mask, diffing so each key gets exactly one edge. */
export function applyMask(mask) {
    const want = [];
    for (const [bit, key] of Object.entries(KEY_FOR_BIT)) {
        if (mask & Number(bit)) want.push(key);
    }
    for (const code of [...held]) if (!want.includes(code)) { inject('keyup', code); held.delete(code); }
    for (const code of want) if (!held.has(code)) { inject('keydown', code); held.add(code); }
    return held.size;
}

export function releaseAllInjected() {
    for (const code of held) inject('keyup', code);
    held.clear();
}

/** Convenience: does a mask contain any stick direction? (for heckle detection) */
export const hasStick = (m) => !!(m & STICK_BITS);

// ── touch controls (Discord on Android/iOS has no keyboard) ────────────
// The elements are declared in index.html; this only wires pointers → bits, so
// the same arbitration path serves mobile.
export function attachTouch(controller, root = document) {
    const els = [...root.querySelectorAll('[data-btn]')];
    if (!els.length) return () => {};
    const touchBits = new Set();
    const sync = () => {
        let b = 0;
        for (const k of touchBits) b |= BTN[k] || 0;
        controller.touchBits = b;
        controller._emit();      // same pipeline as keyboard/gamepad
    };
    const bind = (el) => {
        const key = el.dataset.btn.toUpperCase();
        const down = (e) => { e.preventDefault(); touchBits.add(key); el.classList.add('on'); sync(); };
        const up = (e) => { e.preventDefault(); touchBits.delete(key); el.classList.remove('on'); sync(); };
        el.addEventListener('pointerdown', down);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
        el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    els.forEach(bind);
    return () => els.forEach((el) => el.classList.remove('on'));
}
