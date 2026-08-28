// npm run check — `node --check` every module we ship, so a stray typo in
// src/*.js fails loudly here instead of as a blank iframe inside Discord
// (where the console is one click away from nowhere).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'lib', 'sm64.js', 'main-88506ecba93827d8445a.js']);

function* walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else if (/\.(js|mjs)$/.test(e.name)) yield full;
    }
}

let bad = 0;
const files = [...walk(ROOT)];
for (const f of files) {
    try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
        console.log(`  ok   ${path.relative(ROOT, f)}`);
    } catch (err) {
        bad++;
        console.error(`  FAIL ${path.relative(ROOT, f)}\n${err.stderr?.toString() || err.message}`);
    }
}
console.log(`\n${files.length - bad}/${files.length} files parse.`);
process.exit(bad ? 1 : 0);
