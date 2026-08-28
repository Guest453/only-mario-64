# Why the game works the way it does

The interesting constraint here is not "make a multiplayer Mario". It is: *you get
one unmodifiable emulator binary, a sandbox with no WebRTC, and an identity system
that is excellent at telling you who is in a room.* What follows is what those
three facts add up to.

## The engine gives you exactly one hook

[`sm64.wasm`](../sm64.wasm) is the PC decompilation build: Emscripten + SDL2,
input read from a keyboard-state array, no save API, no entity API, **no JS
surface at all**. Concretely, from inside a page you can do two things: feed it
key events, and read its canvas. That's the whole door. (The only real state
handle is `localStorage.sm64_save_file`, the eeprom blob — and writing to it
mid-frame is how you corrupt someone's file, so we don't.)

Everything in `src/` is therefore built from those two affordances:

* **in** → `src/input.js` swallows real keys at the capture phase and *re-injects*
  a synthesized keyboard state that reflects the arbitrated mask. This is why
  arbitration can be a pure function (`src/modes.js`) that the tests run with no
  DOM at all.
* **out** → `src/stream.js` grabs the canvas, JPEGs it at 480×360, and pushes it
  over the relay to the people who are watching.

## One Mario, N players

Rebuilding the engine to render 4 Marios (the sm64ex / `network.c` approach) is
out of scope: no toolchain here, a 16 MB binary, and 4 concurrent players need
4 independent input loops plus per-object networking.

So "multiplayer" in this repo means **one shared pad**, and the design question
becomes: what makes a *group* pressing one controller fun instead of frustrating?
Four answers, all in [`src/modes.js`](../src/modes.js), all unit-tested:

| mode | rule | why it's fun |
| --- | --- | --- |
| 🤝 Co-op Pad | the pad is cut into 4 groups — 🕹️ stick / 🅰️ A / 🅱️ B+Z / ⏸️ Start — one player each, auto-rotating every 30 s | forced communication; the only mode where 4 people play *simultaneously* without cancelling each other |
| 🗳️ Democracy | a 400 ms ballot window, strict majority per axis, ties press nothing | short enough to feel live; excluding ties is the classic twitch-plays lesson (two players otherwise means permanent diagonal jitter) |
| 🌀 Anarchy | a 350 ms window in which one random player owns the entire pad | same chaos, but someone is in control, so the moment is legible |
| 🥔 Hot Potato | 25 s turns; hecklers build A-mashing pressure (0→1000 in ~1.2 s), and above 620 a *storm* steals the pad if at least half the crowd is mashing | a real game loop with tension; the 6 s lockout after a steal stops ping-pong, and two mashing players are always required so one griefer can't flip the session |
| 🎊 Mash | everything OR-ed | 30 fps arguments, and somehow it works |
| 👑 Solo | host plays, others watch + chat | the "just let me in the door" fallback |

Two rules kept these honest:

1. **A shared input must be *held*, not repeated.** Input is sent on change plus
   a keepalive every ≤250 ms, so a dropped packet cannot leave Mario running into
   a wall forever.
2. **Opposing directions cancel.** `majority()` returns nothing for a tie. In
   MASH, `union()` keeps both — and the engine's own diagonal handling makes that
   survivable. This asymmetry is deliberate: MASH should be loud, Democracy should
   be legible.

## Spectating: a picture, not a second camera

Viewers see the host's actual canvas at ~8–14 fps, adaptive:

* the host skips encoding entirely above 512 KB of `bufferedAmount`;
* per-viewer frames are dropped rather than queued (a stale Mario is worse than a
  missing one);
* quality tiers (`auto/high/low/off`) are one button, because a phone on hotel wifi
  needs an escape hatch.

No WebRTC means no `captureStream` → `RTCPeerConnection`. If Discord ever proxies
WebRTC, `FrameStream` swaps transports and everything else survives — that is the
one place the design is allowed to change.

## Roles, and who is allowed to break things

* The **host** runs the session: their engine is the truth, their save file is the
  save file, their `state` publishes the mode.
* Anyone can **call a vote** (`vote → 8 s → strict majority`) including for a mode
  change; the relay applies the result so late joiners inherit it. A non-host
  clicking a mode chip gets a vote, not an error.
* Anyone can **ask to be un-hosted**: `promote` is host-only, so the room needs
  the current host to hand over or their disconnect — no takeover races.
* Everyone can **detach** to their own copy, which is also the answer to "is this
  pointless if I want to play properly?" — no.

The asymmetry that follows and is *not* hidden in the UI: handing the session to
someone else hands them the **save**, because the eeprom lives in their
`localStorage`. In Discord that's a friend in a voice channel; the roster row says
so in the tooltip.

## Trust: what a player can forge

A player can forge their display name, avatar URL, platform, chat text, and input
masks. They cannot forge the roster (it comes from `getInstanceConnectedParticipants`
via Discord's own bridge, and only renders as names/avatars), and they cannot make
anyone else's Mario move except by sending inputs the host has agreed to arbitrate.

So: no scores, no leaderboard, no achievements, nothing persistent, no moderation
power, no third-party claims about who did what. Everything the relay knows is
"this socket says it is X" — documented in [docs/PROTOCOL.md](./PROTOCOL.md), and
the place to fix it (signed bearer via `TOKEN_ENDPOINT`) is
[docs/ACTIVITY-AUTH.md](./ACTIVITY-AUTH.md).

## Numbers worth knowing

| | |
| --- | --- |
| payload | 16-bit mask + 32-bit frame counter, sent on change (≤250 ms keepalive) — ~100 B |
| uplink per host, 8 viewers | 0.05–0.25 Mbps per viewer of JPEG; the host pays for all of them |
| engine | 30 fps internal; the arbitration loop caps at ~60 Hz but only runs when a room is live |
| cold boot | 16 MB wasm, `decodeFrame`'s zero-copy view exists because copying it 10×/s/viewer is measurable |

## What would actually make this better

1. **A patched engine with a second player object** → real co-presence, then the
   modes become *levels* (race, tag, hide the key) instead of pad politics.
2. **Rollback on the mask** — the host applies inputs at frame granularity today;
   Democracy windows already hide the jitter, but 1-frame rollback in
   `Arbitrator.step` would make MASH feel tighter.
3. **Voice-driven democracy** (speech-to-text isn't it; but `SPEAKING_*` is — mute
   a player's window by muting them in Discord).
4. **ROM-aware save hand-off**: copy the eeprom blob through the relay so "make
   host" keeps the *session's* save. Tempting, and it needs care, because the blob
   is the one thing in this app a player can't verify.
