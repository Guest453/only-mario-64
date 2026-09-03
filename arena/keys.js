// Single source of truth for which key codes exist on the wire.
//
// The relay validates against this and the desktop agent maps from it. Keeping
// them in one file is deliberate: when the two lists drifted apart in an earlier
// design, the server happily forwarded keys the agent then silently dropped, and
// the symptom was "some buttons just don't work" with nothing in any log.

'use strict';

// The wasm SM64 build: seven buttons, nothing else reachable.
const SM64_KEYS = [
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyX',    // A — jump
    'KeyC',    // B — dive / punch
    'Space',   // Z — crouch / ground pound
    'Enter',   // Start
];

// The desktop build: everything a keyboard has, minus what the lockdown removes.
const FULL_KEYS = [];
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') FULL_KEYS.push('Key' + c);
for (let d = 0; d <= 9; d++) FULL_KEYS.push('Digit' + d);
for (let f = 1; f <= 12; f++) FULL_KEYS.push('F' + f);
for (let n = 0; n <= 9; n++) FULL_KEYS.push('Numpad' + n);
FULL_KEYS.push(
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Space', 'Enter', 'Tab', 'Backspace', 'Escape', 'CapsLock',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
    'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash',
    'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide',
    'NumpadDecimal', 'NumpadEnter',
);

// Never accepted, in either mode. Super is a desktop-level escape and the
// context-menu key is a launcher by another name.
const NEVER = ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'ContextMenu'];

module.exports = {
    SM64_KEYS,
    FULL_KEYS: FULL_KEYS.filter((k) => !NEVER.includes(k)),
    NEVER,
};
