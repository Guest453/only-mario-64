// Access-unit splitting for the desktop agent's H.264 stream.
//
// This exists because of a real bug: the first splitter assumed one slice per
// picture and flushed on every VCL NAL. `-preset ultrafast` enables sliced
// threading, so x264 emitted several slices per frame and the measured output
// was exactly 2x the requested framerate (1798 frames per 30s at -framerate 30)
// with every chunk carrying half a picture.
//
//   node arena/test/annexb.test.js

'use strict';
const { AnnexBSplitter, OggOpusReader } = require('../desktop/agent.js');

const results = [];
const ok = (name, cond, detail = '') => results.push([cond, name, detail]);

const SC = [0, 0, 0, 1];
const nal = (type, ...rest) => Buffer.from([...SC, type, ...rest]);

// ── multi-slice pictures must group into ONE access unit each ───────────────
{
    const aus = [];
    const sp = new AnnexBSplitter((au, key) => aus.push({ len: au.length, key }));
    sp.push(Buffer.concat([nal(9, 0), nal(7, 1, 2), nal(8, 3), nal(5, 9, 9), nal(5, 8, 8)]));
    sp.push(Buffer.concat([nal(9, 0), nal(1, 7, 7), nal(1, 6, 6)]));
    sp.push(Buffer.concat([nal(9, 0), nal(1, 5, 5)]));

    ok('two multi-slice pictures produce two access units', aus.length === 2, JSON.stringify(aus));
    ok('the SPS/PPS/IDR picture is flagged as a keyframe', aus[0] && aus[0].key === true);
    ok('both IDR slices land in the SAME chunk',
        aus[0] && aus[0].len === 33, aus[0] && String(aus[0].len));
    ok('the non-IDR picture is a delta', aus[1] && aus[1].key === false);
    ok('both delta slices land in the same chunk',
        aus[1] && aus[1].len === 20, aus[1] && String(aus[1].len));
}

// ── NALs split across reads must survive reassembly ─────────────────────────
{
    const aus = [];
    const sp = new AnnexBSplitter((au, key) => aus.push({ len: au.length, key }));
    // NOTE the trailing NAL. A picture is flushed by the NEXT delimiter, and the
    // last NAL in the buffer is always held back as a possibly-incomplete tail.
    // So a stream ending ON a delimiter leaves that picture pending — end with a
    // slice if you want both pictures out.
    const stream = Buffer.concat([
        nal(9, 0), nal(5, 1, 2, 3),
        nal(9, 0), nal(1, 4, 5),
        nal(9, 0), nal(1, 6),
    ]);
    // one byte at a time — the worst case a socket can hand us
    for (const b of stream) sp.push(Buffer.from([b]));
    ok('a stream fed one byte at a time still splits correctly',
        aus.length === 2 && aus[0].key === true && aus[1].key === false, JSON.stringify(aus));
}

// ── a picture is only flushed once the NEXT delimiter arrives ───────────────
{
    const aus = [];
    const sp = new AnnexBSplitter((au, key) => aus.push({ len: au.length, key }));
    sp.push(Buffer.concat([nal(9, 0), nal(5, 1)]));
    ok('the final picture stays pending until the next delimiter (1 frame of latency)',
        aus.length === 0, JSON.stringify(aus));
    sp.push(Buffer.concat([nal(9, 0), nal(1, 2)]));
    ok('...and is emitted as soon as that delimiter lands', aus.length === 1, JSON.stringify(aus));
}

// ── Ogg: the two metadata packets must not reach the decoder ────────────────
{
    function oggPage(packets, seq) {
        const segs = [];
        const body = [];
        for (const p of packets) {
            let left = p.length;
            while (left >= 255) { segs.push(255); left -= 255; }
            segs.push(left);
            body.push(p);
        }
        const head = Buffer.alloc(27);
        head.write('OggS', 0, 'latin1');
        head[26] = segs.length;
        head.writeUInt32LE(seq, 18);
        return Buffer.concat([head, Buffer.from(segs), ...body]);
    }
    const got = [];
    const r = new OggOpusReader((p) => got.push(p.length));
    r.push(oggPage([Buffer.from('OpusHead-ish'), Buffer.from('OpusTags-ish')], 0));
    r.push(oggPage([Buffer.alloc(80, 7), Buffer.alloc(90, 8)], 1));
    ok('OpusHead and OpusTags are dropped, real packets pass',
        got.length === 2 && got[0] === 80 && got[1] === 90, JSON.stringify(got));
}

console.log('');
for (const [c, n, d] of results) console.log(`${c ? ' PASS' : ' FAIL'}  ${n}${c ? '' : '   <-- got: ' + d}`);
const failed = results.filter((r) => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
