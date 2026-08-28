# Putting this on Discord, step by step

Two things have to exist: the **static site** (the Activity itself) and one
**WebSocket relay** (the only thing in this repo that needs a server). Discord
supplies identity, the room, invites and presence; it explicitly does *not*
supply a game-state transport, and its proxy blocks WebRTC — hence the relay.

---

## 1. Host the site

Any static host works. GitHub Pages: **Settings → Pages → Deploy from a branch →
`<branch>` / root**. `.nojekyll` is committed so nothing gets filtered; there is no
build step (no bundler, no npm install for the site itself).

Note the URL. Below, `<SITE>` = e.g. `https://guest453.github.io/only-mario-64`.

## 2. Run the relay somewhere public

It has to be reachable over **wss://** (Discord proxies TLS only). Free options:
Render (Node service, no Dockerfile needed), Railway, Fly.io, a VPS with caddy.
Details and a `render.yaml` in [docs/RELAY.md](./docs/RELAY.md).

```bash
node relay/server.js          # prints: ws://0.0.0.0:8790/ws?room=CODE
curl  localhost:8790/status   # sanity check: {"ok":true,...}
```

Below, `<RELAY-HOST>` = e.g. `sm64-relay.onrender.com` (**no scheme, no path**).

## 3. Create the app

<https://discord.com/developers/applications> → **New Application**.

1. **Activities → Settings**: enable Activities. Tick every
   **Supported Platform** you care about (Desktop, Web, iOS, Android) — an
   un-ticked platform silently does not show up in that client's activity shelf.
2. **Activities → URL Mappings**, in this order (Discord globs prefixes and
   **the catch-all `/` must be last** or it swallows the others):

   | Prefix | Target |
   | --- | --- |
   | `/relay` | `<RELAY-HOST>` |
   | `/` | `<SITE without scheme>` |

   That `/relay` mapping is what lets the iframe open its WebSocket: the client
   dials `wss://<app_id>.discordsays.com/relay/ws?room=…` and the proxy forwards
   it to `wss://<RELAY-HOST>/ws?room=…`. The relay accepts both `/ws` and
   `/relay/ws`.
3. **Activities → the activity URL** itself: `/`.
4. **Installation → Install Link**: **Guild Install** (user-install Activities
   can't be added to a server, and a guild install is what makes it appear in the
   server's *Start an Activity* picker). Copy the invite URL, add it to your server.
5. **OAuth2 → Redirects**: nothing needed. Only add one if you later turn on
   optional auth ([docs/ACTIVITY-AUTH.md](./docs/ACTIVITY-AUTH.md)).

## 4. Launch

Right-click a voice channel → **Start an Activity** → your app. Everyone already
in that voice channel sees an invite card, and anyone who joins later lands in
the **same instance** (`instance_id` is shared, which is how the room works).

While developing, your own app always appears in the **Developer Activity Shelf**
(the rocket button in the voice panel) without installing anything.

If it launches once and then refuses to reopen in the same channel: that is a
stuck instance — Discord sends `READY` once per instance, so launch it in a
*different* channel once, then come back.

## 5. What you should see

* the top-left chip reads `room <instance id>`, and the net chip goes `● live`.
  `○ solo` means the relay is unreachable — usually a missing/incorrect `/relay`
  mapping, or the relay host not answering over TLS.
* the roster lists everyone in the voice-channel instance with their **Discord
  names and avatars**. Players present in the Activity but not in the relay room
  are listed greyed-out.
* the first player whose engine finished loading becomes **👑 host**; the banner
  tells everyone who is hosting.
* everyone else's canvas shows the host's picture (streamed at low res/fps over
  the relay) and the mode decides whose keys count.

## 6. Client-side configuration

`src/discord.js` and `src/net.js` read these; all of them are optional.

| what | how |
| --- | --- |
| relay URL override | `?relay=wss://host/ws` in the launch URL, or `localStorage.sm64mp_relay`, or `window.SM64_RELAY_URL` |
| fake the Discord path locally | `?mock=1` — src/discord-mock.js answers `ready()`/participants/layout/voice with real-shaped payloads, so identity and the lobby can be developed with no portal at all (`window.__mock` drives it: `addParticipant()`, `speaking([id])`, `layout('PIP')`) |
| exercise `setActivity` without a token | `?presence=1` (normally gated on `dc.authed`, see docs/ACTIVITY-AUTH.md) |
| real handshake outside Discord | `?client_id=<app id>&frame_id=x&instance_id=y&platform=desktop` (that is what Discord injects; the SDK needs all of them) |
| turn the Discord layer off | `?discord=0` — handy for reproducing "works in a tab, broken in Discord" |
| room outside Discord | `?room=whatever` |

## 7. Known Discord-iframe quirks (already handled, don't re-break them)

* **No keyboard focus on load.** `installFocusGuard()` re-grabs it, but only
  within ~2 s of the user touching us, so we never steal the caret from Discord's
  own chat box.
* **The wasm eats keystrokes** meant for text inputs. Every game key is captured
  at window level before SDL sees it (`src/input.js`), and skipped entirely while
  the caret is in an input.
* **PIP / GRID tiles are tiny.** `ACTIVITY_LAYOUT_MODE_UPDATE` → CSS class →
  side panel collapses; there's also a viewport fallback because the event can
  arrive after first paint.
* **Audio needs a gesture.** First pointerdown resumes the SDL audio context.
* **CDN images only.** Names/avatars come from `cdn.discordapp.com` (allowed by
  the Activity CSP). Any *other* external asset needs its own URL mapping.
