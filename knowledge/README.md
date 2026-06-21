# SM64 AI — Speedrun / TAS Knowledge

This folder gives the AI player **strategic knowledge** drawn from the SM64
speedrunning and TAS community — so it understands routes, movement tech, and
level goals — **without ever replaying recorded inputs**.

## Why not just replay TAS files?

The community archive at
<https://github.com/TimeTravelPenguin/SM64TASArchive> stores runs as **`.m64`
files** (Mupen64 movie format). An `.m64` is a *frame-perfect, per-frame log of
N64 controller states* (button bitfield + analog stick X/Y) for the original
ROM running in an emulator at 60 fps.

This app is **not** that. It's the **decomp PC port compiled to WebAssembly**,
driven by synthetic keyboard `keydown`/`keyup` events with real-time hold
durations. It is **not frame-synced** to anything. So:

1. **It wouldn't work.** TAS inputs are accurate to a single 1/60s frame and to
   sub-degree analog values. Feed them to our loose keyboard control and Mario
   desyncs within a fraction of a second — you'd get flailing, not a run.
2. **It would be cheating.** Replaying a recording isn't the AI *playing*; it's
   the AI pressing "play" on someone else's solved run. The whole point is to
   watch a model reason its way through the game.

## What we use instead (the no-cheat policy)

- **`sm64-speedrun-strategy.md`** — a curated, human-readable strategy guide
  (routes, movement tech, level objectives, common mistakes). Fed to the model
  as *reference knowledge*, the way a human reads a guide. No input scripts.
- **`tas-knowledge.md`** — an auto-generated digest of the archive: optimal
  route names, authors, and times per category/level, distilled **from the
  `.m64` HEADERS only**. This is what the AI actually reads about the archive.
- **`tas/`** — the relocated `.m64` files (~8 MB, 103 runs) kept for provenance.
  **The web app never fetches these** — only the small generated digest.
- **`tas/index.json`** — full machine-readable metadata index (also generated).
- **`m64-parser.js`** — reads only the fixed 0x400-byte **header** (title,
  author, rerecords, frame/VI count, ROM). It **never touches the input stream**,
  so there is no way to replay a run.
- **`build-tas-index.mjs`** — the one-off build step that ties it together.

In short: the model gets to **learn from** speedruns, not **copy** them.

## Updating the archive

1. Add/replace `.m64` files under `knowledge/tas/` (any subfolder layout).
2. Regenerate the digest + index:

   ```sh
   node knowledge/build-tas-index.mjs
   ```

3. Commit the updated `tas-knowledge.md` and `tas/index.json`.

The raw input data is never read at runtime, converted to our key format, or
executed — only header metadata is ever parsed.
