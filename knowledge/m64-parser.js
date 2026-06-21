// ─────────────────────────────────────────────────────────────────────────
// m64-parser.js — Mupen64 .m64 movie METADATA reader (header only).
//
// ⚠ ANTI-CHEAT BY DESIGN: this parser reads ONLY the fixed 0x400-byte header
// (title, author, rerecord count, frame/VI counts, ROM name). It deliberately
// NEVER touches the per-frame controller input stream that begins at offset
// 0x400, so there is no way for the app to replay a TAS. The metadata is used
// purely as human-readable *context* for the AI (e.g. "the 0-star record is
// ~5 minutes"), never as inputs.
//
// Mupen64 .m64 header layout (little-endian):
//   0x000 u32  signature  (0x1A34364D = "M64\x1A")
//   0x004 u32  version
//   0x008 u32  movie UID
//   0x00C u32  VI count (length in vertical interrupts ~ frames @ fps)
//   0x010 u32  rerecord count
//   0x014 u8   VIs per second (fps, usually 60)
//   0x015 u8   controller count
//   0x018 u32  input sample count (number of input frames)
//   0x0C4 32   ROM internal name (ASCII)
//   0x0E4 u32  ROM CRC32
//   0x0E8 u16  ROM country code
//   0x222 222  author info  (UTF-8)
//   0x300 256  movie description (UTF-8)
//   0x400 ...  CONTROLLER INPUT DATA  ← intentionally ignored
// ─────────────────────────────────────────────────────────────────────────

const M64_SIGNATURE = 0x1a34364d;
const INPUT_DATA_OFFSET = 0x400;

function _readAsciiZ(view, offset, length) {
    let s = '';
    for (let i = 0; i < length; i++) {
        const c = view.getUint8(offset + i);
        if (c === 0) break;
        if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    }
    return s.trim();
}

function _readUtf8Z(bytes, offset, length) {
    const slice = bytes.subarray(offset, offset + length);
    let end = slice.indexOf(0);
    if (end < 0) end = slice.length;
    try {
        return new TextDecoder('utf-8').decode(slice.subarray(0, end)).trim();
    } catch {
        return '';
    }
}

/**
 * Parse the header of a Mupen64 .m64 movie. Returns metadata only — never the
 * controller inputs. Throws if the buffer is not a valid .m64.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{title:string, author:string, romName:string, rerecords:number,
 *            frames:number, viCount:number, fps:number, controllers:number,
 *            durationSec:number}}
 */
export function parseM64Header(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < INPUT_DATA_OFFSET) {
        throw new Error('Not a valid .m64 (file shorter than the 0x400 header).');
    }
    const view  = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);

    if (view.getUint32(0x000, true) !== M64_SIGNATURE) {
        throw new Error('Bad .m64 signature.');
    }

    const viCount     = view.getUint32(0x00c, true);
    const rerecords   = view.getUint32(0x010, true);
    const fps         = view.getUint8(0x014) || 60;
    const controllers = view.getUint8(0x015);
    const frames      = view.getUint32(0x018, true);
    const romName     = _readAsciiZ(view, 0x0c4, 32);
    const author      = _readUtf8Z(bytes, 0x222, 222);
    const description = _readUtf8Z(bytes, 0x300, 256);
    // Duration: VI count / fps is the real run length, BUT some WIP movies store
    // a sentinel (0x7FFFFFFF) instead — fall back to the input frame count then.
    const viValid     = viCount > 0 && viCount < 0x7fffffff;
    const durFrames   = viValid ? viCount : frames;
    const durationSec = fps ? Math.round(durFrames / fps) : 0;

    return {
        title: description || '(untitled run)',
        author: author || '(unknown)',
        romName,
        rerecords,
        frames,
        viCount,
        fps,
        controllers,
        durationSec,
    };
}

/** One-line, human-readable summary used as AI reference context. */
export function summarizeM64(meta, fileName = '') {
    const mm = Math.floor(meta.durationSec / 60);
    const ss = String(meta.durationSec % 60).padStart(2, '0');
    const name = fileName ? `${fileName}: ` : '';
    return `${name}"${meta.title}" by ${meta.author} — ~${mm}m${ss}s, ` +
           `${meta.frames} input frames, ${meta.rerecords} rerecords (${meta.romName || 'SM64'}).`;
}

// The app does NOT read these binaries at runtime. The .m64 files in tas/ are
// parsed once at build time by build-tas-index.mjs (which imports the two
// functions above) to produce tas-knowledge.md + tas/index.json. The web app
// only loads those small generated files.
