# 🍄 Super Mario 64 Multiplayer — Discord Activity

One SM64 engine. One Mario. **Everyone in the voice channel shares the
controller.**

It runs as a [Discord Activity](https://docs.discord.com/developers/activities/overview):
right-click a voice channel → *Start an Activity* → pick the app, and your whole
channel lands in the same session. Your name, avatar and the roster come from
Discord itself — no account, no login, no API key, no nickname field.

```
node server.js          # http://localhost:3823  (game + relay on one port)
```

Then open two tabs with the same room code and watch one Mario respond to both.

---

## The idea, honestly

The engine is [Super Mario 64 decompilation](./sm64.js)+[wasm](./sm64.wasm) — the PC
port compiled by Emscripten. It has **no netcode**, exposes **no engine hooks**, and
its save file describes one Mario. Discord's Activity sandbox additionally
**blocks WebRTC**. So there is no honest way to claim "your friends appear as
Marios inside Bob-omb Battlefield" on this build, and this repo does not pretend
otherwise (see [docs/GAME-DESIGN.md](./docs/GAME-DESIGN.md) for what a patched engine
would unlock).

What genuinely works with N people and one emulator is **sharing the pad**, so
that is the product:

| mode | rule |
| --- | --- |
| 🤝 **Co-op Pad** | the controller is cut in four — stick / A / B+Z / Start. One player each. You *must* talk to each other. |
| 🗳️ **Democracy** | every input is voted on in a short window. Majority rules, ties do nothing. |
| 🌀 **Anarchy** | each window, one random player owns the whole pad. |
| 🥔 **Hot Potato** | one holder, timer rotates; everyone else mashes A together to **storm** the pad. |
| 🎊 **Mash** | all inputs OR-ed together. Loud and surprisingly good at getting Mario *somewhere*. |
| 👑 **Solo** | the host plays, the rest watch the host's screen and chat. |

Everyone who is not hosting sees the **host's actual screen**, pushed as a
low-resolution, low-framerate JPEG stream over the same WebSocket as the inputs —
because that is the only video that survives the Activity sandbox. Non-hosts keep
their own copy of the game underneath and can detach to it at any time.

## What Discord provides (and how we use it)

| need | SDK primitive |
| --- | --- |
| who am I | `sdk.ready()` payload → `data.user` (`id`, `username`, `avatar`) — no scope |
| who is here | `getInstanceConnectedParticipants()` + `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE` — no scope |
| the room | `sdk.instanceId` — identical for the whole voice channel, destroyed on leave |
| invites | `openInviteDialog()`, `shareLink({message})`, `inviteUserEmbedded()` |
| window sizes | `ACTIVITY_LAYOUT_MODE_UPDATE` (FOCUSED / PIP / GRID) → chrome compacts |
| presence | `setActivity()` — needs a token, so optional |
| mobile | `setOrientationLockState()`, `ORIENTATION_UPDATE`, `THERMAL_STATE_UPDATE`, `getPlatformBehaviors()` |
| out of the iframe | `openExternalLink()` |

Full notes, including the parts of the SDK we deliberately skipped and the two
things Discord *refuses* to give you (WebRTC, trusted state), are in
[docs/SDK-NOTES.md](./docs/SDK-NOTES.md).

## Files

```
index.html              shell + engine boot (Module config, IDBFS save)
app.js                  orchestration: Discord → relay → arbitration → engine
src/discord.js          Embedded App SDK layer: identity, roster, invites, presence, layout
src/net.js              WebSocket relay client (star topology, RTT, reconnect)
src/modes.js            input arbitration per mode — pure, unit-tested
src/input.js            keyboard/touch/gamepad capture, key shielding, phantom keyboard
src/stream.js           host JPEG stream + viewer painter, adaptive
src/protocol.js         controller bits, key map, modes table, wire types
src/ui.js               DOM rendering (textContent only — Discord strings are untrusted)
relay/server.js         zero-dependency WebSocket room server (no `ws`, no npm install)
render.yaml             one-click deploy for that file
src/discord-mock.js     `?mock=1` stand-in client, so the Discord path runs in a plain tab
scripts/check.js        `npm run check` — node --check every module
sm64.js + sm64.wasm     the engine (vendored, unmodified)
docs/                   SDK notes, protocol, relay hosting, auth, design
test/                   21 tests: arbitration, relay over real sockets, two jsdom end-to-end runs
```

## Run it

```bash
node server.js                      # :3823 — serves the site AND the relay on /ws
node relay/server.js                # ...or the relay alone on :8790
npm test                            # relay + arbitration + jsdom end-to-end
npm run check                       # node --check every module
open "http://localhost:3823/?mock=1"   # fake Discord identity, no portal needed
```

Open `http://localhost:3823` twice, set both tabs to room `lobby`, pick
🎊 Mash, and both keyboards move the same Mario. Two browser tabs on one
machine is also the fastest way to feel the PIP/latency behaviour before touching
Discord.

## Put it in Discord

Short version (details, portal screenshots-in-words, and the URL-mapping order
gotcha in [DISCORD.md](./DISCORD.md)):

1. Host this folder as a static site (GitHub Pages works; `.nojekyll` is here).
2. Developer Portal → your app → **Activities** → enable it, add the
   `/` URL mapping to your host.
3. **URL mapping** `/relay` → your relay host (it must be a real host, e.g. a
   Render/Railway free instance — this is the only piece of infrastructure).
4. Set Activities URL to `/`, install the app as a **Guild Install**, launch it
   from a voice channel.

No relay reachable? The Activity still boots and plays as a solo game with a
presence-only lobby — that degradation is deliberate, not an accident.

## Controls

`↑↓←→`/`WASD` stick · `X` A (jump) · `C` B (punch/dive/grab) · `Space` Z (crouch/long-jump/pound) ·
`Enter` Start. Gamepads work (Xbox-style mapping) and are folded into the same
shared mask, so a player on a phone with a controller is a first-class player.
On touch devices the on-screen pad appears automatically.

## Credits

Engine: the SM64 decompilation (customsm64/sm64ex lineage) compiled to wasm, as
vendored by the original "Super Mario 64 Web" (Tenslant, websim). Multiplayer
layer, Activity integration and this UI: rewritten from scratch for this repo.
Nintendo owns Mario; this is a fan project. The ROM is baked into `sm64.wasm`, so
no files are asked of players, and the eeprom lives in `localStorage`
(`sm64_save_file`) — which is why handing the session to someone else hands them
*their* save too.
