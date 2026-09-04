// ─────────────────────────────────────────────────────────────────────────────
// FULL-KEYBOARD INPUT — browser KeyboardEvent.code -> real X key events.
//
// The wasm build allowlisted seven keys because SM64 only has seven buttons.
// A desktop running arbitrary emulators needs the whole keyboard, so the model
// inverts: everything mappable is allowed EXCEPT the things that would let one
// person end the session for everyone.
//
// Keys are held, not tapped — press once on the leading edge, release when the
// merged set stops containing them — so movement is continuous.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const { execFile } = require('child_process');

// code -> X keysym name (xdotool's vocabulary).
const KEYSYM = {};
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') KEYSYM['Key' + c] = c.toLowerCase();
for (let d = 0; d <= 9; d++) KEYSYM['Digit' + d] = String(d);
for (let f = 1; f <= 12; f++) KEYSYM['F' + f] = 'F' + f;
for (let n = 0; n <= 9; n++) KEYSYM['Numpad' + n] = 'KP_' + n;

Object.assign(KEYSYM, {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Space: 'space', Enter: 'Return', Tab: 'Tab', Backspace: 'BackSpace',
    Escape: 'Escape', CapsLock: 'Caps_Lock',
    ShiftLeft: 'shift', ShiftRight: 'shift',
    ControlLeft: 'ctrl', ControlRight: 'ctrl',
    AltLeft: 'alt', AltRight: 'alt',
    Minus: 'minus', Equal: 'equal',
    BracketLeft: 'bracketleft', BracketRight: 'bracketright',
    Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe',
    Backquote: 'grave', Comma: 'comma', Period: 'period', Slash: 'slash',
    Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
    PageUp: 'Prior', PageDown: 'Next',
    NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract',
    NumpadMultiply: 'KP_Multiply', NumpadDivide: 'KP_Divide',
    NumpadDecimal: 'KP_Decimal', NumpadEnter: 'KP_Enter',
});

// Never mappable, at all. Super opens desktop-level behaviour and the context
// menu key is a launcher by another name.
const BLOCKED = new Set(['MetaLeft', 'MetaRight', 'ContextMenu', 'OSLeft', 'OSRight']);

// Combinations that end the session for everybody. The image has no terminal,
// file manager or browser to launch, so what is left to defend against is
// closing or escaping the window that IS the game.
function isDangerous(held, code) {
    const alt = held.has('AltLeft') || held.has('AltRight');
    const ctrl = held.has('ControlLeft') || held.has('ControlRight');
    if (alt && code === 'F4') return true;        // close window
    if (alt && code === 'Tab') return true;       // switch away from the game
    if (alt && code === 'Escape') return true;
    if (ctrl && alt && code === 'Delete') return true;
    if (ctrl && alt && code === 'Backspace') return true;  // zap the X server

    // Chromium is in the image for the SM64 wasm build. Kiosk/app mode already
    // hides the chrome, but these would still open tabs, windows, downloads or
    // devtools — i.e. turn the one allowed program back into a browser.
    if (ctrl && ['KeyT', 'KeyN', 'KeyW', 'KeyL', 'KeyH', 'KeyJ', 'KeyO', 'KeyP'].includes(code)) return true;
    if (code === 'F11' || code === 'F12') return true;   // fullscreen toggle / devtools
    return false;
}

const held = new Set();

function xdo(args) {
    if (!args.length) return;
    execFile('xdotool', args, (err) => {
        if (err) console.warn('[input] xdotool failed:', err.message);
    });
}

function applyInput(codes) {
    const desired = new Set();
    for (const c of codes) {
        if (!KEYSYM[c] || BLOCKED.has(c)) continue;
        if (isDangerous(desired, c) || isDangerous(held, c)) continue;
        desired.add(c);
    }

    const args = [];
    for (const c of [...held]) {
        if (!desired.has(c)) { args.push('keyup', KEYSYM[c]); held.delete(c); }
    }
    for (const c of desired) {
        if (!held.has(c)) { args.push('keydown', KEYSYM[c]); held.add(c); }
    }
    // One xdotool invocation per tick rather than one per key: at 30Hz the
    // process spawns would otherwise dominate the container's CPU.
    xdo(args);
}

// ── Pointer ─────────────────────────────────────────────────────────────────
// Desktop mode is unusable without a mouse, and emulator menus want one too.
// Coordinates arrive NORMALISED (0..1) so the client never needs to know the
// stream resolution, and a resolution change cannot desync the pointer.
const heldButtons = new Set();
let screenW = Number(process.env.ARENA_W || 854);
let screenH = Number(process.env.ARENA_H || 480);

function applyMouse(m) {
    const args = [];
    if (typeof m.x === 'number' && typeof m.y === 'number') {
        const x = Math.max(0, Math.min(screenW - 1, Math.round(m.x * screenW)));
        const y = Math.max(0, Math.min(screenH - 1, Math.round(m.y * screenH)));
        args.push('mousemove', String(x), String(y));
    }
    // Only buttons 1-3. No scroll-as-button spam, no exotic buttons.
    const want = new Set((Array.isArray(m.buttons) ? m.buttons : [])
        .filter((b) => b === 1 || b === 2 || b === 3));
    for (const b of [...heldButtons]) {
        if (!want.has(b)) { args.push('mouseup', String(b)); heldButtons.delete(b); }
    }
    for (const b of want) {
        if (!heldButtons.has(b)) { args.push('mousedown', String(b)); heldButtons.add(b); }
    }
    if (m.wheel === 'up') args.push('click', '4');
    else if (m.wheel === 'down') args.push('click', '5');
    xdo(args);
}

function releaseAll() {
    for (const b of heldButtons) xdo(['mouseup', String(b)]);
    heldButtons.clear();
    const args = [];
    for (const c of held) args.push('keyup', KEYSYM[c]);
    held.clear();
    xdo(args);
}

module.exports = { applyInput, applyMouse, releaseAll, KEYSYM, BLOCKED, isDangerous };
