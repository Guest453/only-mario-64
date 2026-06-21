// build-tas-index.mjs — one-off build step.
//
// Walks knowledge/tas/ for .m64 files, parses ONLY their headers (via the shared
// header-only parser — never the inputs), and writes:
//   • knowledge/tas/index.json    — full metadata index (machine-readable)
//   • knowledge/tas-knowledge.md  — a categorized digest fed to the AI as
//                                   speedrun reference knowledge (not inputs).
//
// Run from the project root:  node knowledge/build-tas-index.mjs
//
// This keeps the web app light: it loads the small digest/JSON, never the 8 MB
// of binaries, and there is no way to replay inputs (we only read headers).

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parseM64Header } from './m64-parser.js';

const here    = dirname(fileURLToPath(import.meta.url));
const tasDir  = join(here, 'tas');

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (/\.m64$/i.test(name)) out.push(p);
    }
    return out;
}

// Derive a friendly category/level from the relative path inside tas/
function classify(relPath) {
    const parts = relPath.split(sep);
    const top = parts[0] || '';
    if (/^120/i.test(top)) return { category: '120 Star', level: '120 Star (full game)' };
    if (/^Full Game/i.test(top)) return { category: 'Full Game', level: parts[1] || 'Full Game' };
    if (/^Individual Levels/i.test(top)) {
        // Individual Levels/SM64/<Level>/<Star>/...
        const level = parts[2] || 'Individual Level';
        const star  = parts[3] || '';
        return { category: 'Individual Level', level, star };
    }
    return { category: top || 'Misc', level: parts[1] || top };
}

const files = walk(tasDir).sort();
const index = [];

for (const abs of files) {
    const rel = relative(tasDir, abs).split(sep).join('/');
    try {
        const buf = readFileSync(abs);
        const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const meta = parseM64Header(ab);
        index.push({ path: rel, ...classify(relative(tasDir, abs)), ...meta });
    } catch (e) {
        console.warn(`skip ${rel}: ${e.message}`);
    }
}

writeFileSync(join(tasDir, 'index.json'), JSON.stringify(index, null, 1));
console.log(`Wrote index.json (${index.length} runs).`);

// ── Build the human-readable digest the AI reads ──────────────────────
const fmtDur = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;

const byCat = {};
for (const r of index) (byCat[r.category] ||= []).push(r);

let md = `# SM64 TAS Archive — knowledge digest (reference, NOT inputs)\n\n`;
md += `Distilled from ${index.length} tool-assisted speedrun files in the community\n`;
md += `archive (https://github.com/TimeTravelPenguin/SM64TASArchive). These are\n`;
md += `**reference facts** about optimal routes and times — use them to understand\n`;
md += `what's possible and which objectives are quick. You must still PLAY from what\n`;
md += `you see; never replay inputs, never use glitch/OOB routes.\n`;

// Full-game + 120 summaries
for (const cat of ['Full Game', '120 Star']) {
    const runs = byCat[cat]; if (!runs) continue;
    md += `\n## ${cat}\n`;
    for (const r of runs.slice(0, 20)) {
        md += `- ${r.level}: ~${fmtDur(r.durationSec)} — "${r.title}" by ${r.author}\n`;
    }
}

// Individual levels grouped by level, fastest first
const ils = byCat['Individual Level'] || [];
if (ils.length) {
    const byLevel = {};
    for (const r of ils) (byLevel[r.level] ||= []).push(r);
    md += `\n## Individual-level best times (how fast each star CAN go)\n`;
    for (const level of Object.keys(byLevel).sort()) {
        const best = byLevel[level].sort((a, b) => a.durationSec - b.durationSec)[0];
        md += `- ${level}: fastest archived ~${fmtDur(best.durationSec)} (${byLevel[level].length} run(s))\n`;
    }
}

md += `\n## Takeaways for play\n`;
md += `- Even full 70/120-star runs are long; you only need a few early stars to progress.\n`;
md += `- Most individual stars are reachable in well under a minute by going straight to\n`;
md += `  the objective — so pick the obvious target and head right for it.\n`;
md += `- Speed comes from sustained running and clean lines, not fancy tricks.\n`;

writeFileSync(join(here, 'tas-knowledge.md'), md);
console.log(`Wrote tas-knowledge.md (${md.length} chars).`);
