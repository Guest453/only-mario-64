# Mario Arena — one global Super Mario 64

Everyone who opens the Discord Activity, in **any** server, is pressing buttons on
the **same** Mario, in the same world, on the same save file. There is no room
code and no per-guild instance: one game, forever.

## How it works

```
  viewer ──ws /ws──►┌──────────────┐──ws /host──► headless Chromium
  viewer ──ws /ws──►│  arena relay │              (sm64.wasm + WebCodecs)
  viewer ◄──h264/opus chunks───────┘◄─────────────  encodes + takes input
```

- **`arena/server.js`** — the relay. One global session: merges every viewer's
  held buttons into a single controller, fans video/audio out, runs mode votes,
  does the Discord OAuth token exchange.
- **`arena/host/`** — the one browser in the world that runs the game. Boots
  `sm64.wasm`, encodes the canvas with WebCodecs, and replays the merged
  controller as synthetic `KeyboardEvent`s.
- **`arena/public/`** — what players download. Decodes video, sends buttons.
  **No wasm, no emulator** — a viewer never downloads the 16 MB binary.

### Why the game runs on the server

A shared Mario needs one authoritative state and one save file. Running the wasm
per-viewer and syncing inputs would demand frame-perfect determinism across every
browser, and any drift silently forks the world. Rendering once and shipping
pixels cannot desync.

### Why not VNC

VNC re-encodes a generic desktop framebuffer with a codec designed for text. Here
the host page hands over already-encoded H.264 straight out of WebCodecs and the
viewer decodes it with a real `VideoDecoder`. No X server, no framebuffer
diffing, no websockify.

## Control modes

| Mode | Rule |
| --- | --- |
| **ANARCHY** (default) | Any button held by anyone is held. Chaos, but one person alone can still play. |
| **DEMOCRACY** | Every 400 ms, a button needs a strict majority (`floor(n/2)+1`) of the people actually pressing something. |

Switching modes opens a **vote** everyone sees and answers — it is not a click by
whoever got there first. It passes early on a majority of all connected viewers,
or at the 20 s deadline on simple yes > no.

## The save file

The game's save lives in emscripten **IDBFS**, which is IndexedDB inside the
container's Chromium profile. `docker-compose.yml` mounts that profile as the
`arena-profile` volume. **That volume is every star anyone has ever collected.**
It is the only stateful thing here; losing it resets the world.

## Deploy

```bash
cp arena/.env.example arena/.env      # fill in the Discord secret
docker compose -f arena/docker-compose.yml up -d --build
```

The relay binds `127.0.0.1:8090` on the host. Put nginx in front using
`arena/deploy/nginx-arena.conf`. **`proxy_buffering off` is not optional** — a
buffered WebSocket carrying video is exactly what made the VNC activity on this
box feel "super slow".

Render size is `ARENA_W` / `ARENA_H` (default 480x270). Raise it only if you have
frames to spare; see the frame-budget note below.

## Discord setup

The Activity uses a **root URL mapping** (`/` → this origin), so the iframe is
served from `<app_id>.discordsays.com` and every request, WebSocket upgrades
included, is proxied same-origin. Do **not** add a `/.proxy` prefix to the socket
URL — that is only for additional mappings.

Names and avatars come from real OAuth: `authorize` → `POST /api/token`
(server-side exchange, the secret never reaches a browser) → `authenticate`.

> Avatars load from `cdn.discordapp.com`. If Discord's CSP blocks that, the
> client silently falls back to coloured initials — add a `/cdn` URL mapping to
> get real pictures.

## Things that cost hours, written down

**The canvas resize.** `SDL_CreateWindow` sets the canvas to 1920x1080 at
startup, from SDL's own display bounds. It does **not** read `screen.*` or
`window.innerWidth` — pinning those changes nothing. Rendering 1080p through
SwiftShader on a GPU-less box costs 1-2 fps.

Clamping the canvas alone is **not** enough: the buffer shrinks but `glViewport`
stays at SDL's size, so the game draws a 1080p projection into a small buffer and
you see the top-left corner. `viewport` and `scissor` must be scaled by the same
ratio, and the height derived from SDL's aspect — SDL picks 16:9, and forcing 4:3
squashes the picture.

Load `host.html?debugresize=1` to print a stack trace for every canvas resize.
That tracer is how the call site was found; three guesses before it were all
wrong.

**Frame budget.** 480x270 gives ~29 fps on an i5-6400. The cost is fill rate, so
it scales roughly with pixel count — doubling the width roughly quarters the
frame rate.

**Binding.** The relay must bind `0.0.0.0` *inside* the container. On
`127.0.0.1` the port looks bound on the host and answers nothing, because that is
the container's own loopback. Isolation comes from the publish side.

**Caching.** The app shell is served `no-cache`. With a TTL, every deploy leaves
players on the previous build until it expires, and inside Discord there is no
obvious way to hard reload.

## Tests

```bash
node arena/test/protocol.test.js
```

Covers host auth, the input allowlist, anarchy union, democracy majority, the
vote state machine, and identity. Each run spawns its **own** relay on its own
port — the arena is deliberately one global session that keeps mode and vote
cooldown for the life of the process, so a shared relay makes consecutive runs
contaminate each other (this suite once scored 16/16, then 10/16, then 8/16 on
identical code).
