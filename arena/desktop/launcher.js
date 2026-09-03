// ─────────────────────────────────────────────────────────────────────────────
// LAUNCHER — starts and stops the game the crowd voted for.
//
// There is deliberately no on-screen launcher. The image has nothing installed
// that could draw one, and putting a menu on the X display would hand the crowd
// a menu to escape through. The game picker lives in the WEB client instead;
// the display shows a flat colour while nothing is running.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const REGISTRY = path.join(__dirname, 'games.json');
const ROM_DIR = process.env.ROM_DIR || '/roms';
const CORE_DIR = process.env.CORE_DIR || '/usr/lib/libretro';
const RA_CONFIG = process.env.RA_CONFIG || '/etc/arena-retroarch.cfg';

let registry = { games: [], layouts: {} };
try {
    registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
} catch (err) {
    console.warn('[launcher] could not read games.json:', err.message);
}

// Only games whose ROM is actually present. A registry entry pointing at a file
// nobody uploaded would otherwise show up in the picker, collect votes, and then
// fail to launch — which looks like the vote is broken rather than the ROM
// being missing.
function availableGames() {
    return registry.games.filter((g) => {
        if (g.exec) return true;                       // native/Steam entries
        if (!g.rom || !g.core) return false;
        const rom = path.join(ROM_DIR, g.rom);
        const core = path.join(CORE_DIR, `${g.core}_libretro.so`);
        return fs.existsSync(rom) && fs.existsSync(core);
    });
}

let child = null;
let currentId = null;

function idleScreen() {
    // A flat colour, not a desktop. There is nothing here to click.
    execFile('xsetroot', ['-solid', '#0b0d14'], () => {});
}

function stop(cb) {
    const proc = child;
    child = null;
    currentId = null;
    if (!proc) { idleScreen(); if (cb) cb(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; idleScreen(); if (cb) cb(); };
    proc.once('exit', finish);
    try { proc.kill('SIGTERM'); } catch {}
    // RetroArch occasionally ignores SIGTERM while it is saving; do not let a
    // stuck process block the next vote forever.
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(); }, 4000);
}

function launch(id, cb) {
    const game = availableGames().find((g) => g.id === id);
    if (!game) { if (cb) cb(new Error('unknown or unavailable game: ' + id)); return; }

    stop(() => {
        const args = game.exec
            ? game.execArgs || []
            : ['--config', RA_CONFIG,
               '-L', path.join(CORE_DIR, `${game.core}_libretro.so`),
               path.join(ROM_DIR, game.rom),
               '-f'];
        let bin = game.exec || 'retroarch';
        let spawnArgs = args;
        // A registry entry may ask to run as another user. Desktop mode does,
        // so the crowd's terminal cannot reach the capture agent's processes.
        // The sudoers rule permits exactly this one command, nothing else.
        if (game.user) {
            spawnArgs = ['-u', game.user, '--', bin, ...args];
            bin = 'sudo';
        }
        console.log('[launcher] launching', game.id, '->', bin, spawnArgs.join(' '));

        child = spawn(bin, spawnArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
        currentId = game.id;

        child.stderr.on('data', (d) => {
            const s = String(d).trim();
            if (s) console.log('[launcher]', game.id + ':', s.slice(0, 200));
        });
        child.on('exit', (code) => {
            console.log('[launcher]', game.id, 'exited', code);
            if (currentId === game.id) { child = null; currentId = null; idleScreen(); }
        });

        // Force it fullscreen and above everything, in case the program did not
        // do it itself. Retried because the window does not exist immediately.
        let tries = 0;
        const pin = setInterval(() => {
            if (++tries > 20 || currentId !== game.id) { clearInterval(pin); return; }
            execFile('wmctrl', ['-r', ':ACTIVE:', '-b', 'add,fullscreen,above'], () => {});
        }, 500);

        if (cb) cb(null, game);
    });
}

module.exports = { availableGames, launch, stop, idleScreen, layouts: () => registry.layouts, current: () => currentId };
