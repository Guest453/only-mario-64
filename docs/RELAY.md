# The relay

[`relay/server.js`](../relay/server.js) is the only backend this Activity needs:
a WebSocket room server with **no dependencies at all** — not even `ws`. The
framing is implemented in that file (the RFC 6455 subset a browser needs:
text/binary/continuation, ping/pong, client-to-server masking). That is
deliberate: the hardest part of shipping an Activity is convincing someone to run
a server, so the bar is "copy one file, `node` it".

```bash
node relay/server.js                      # ws://0.0.0.0:8790/ws?room=CODE
PORT=1234 HOST=127.0.0.1 node relay/server.js
QUIET=1 node relay/server.js               # no join/leave log
curl -s localhost:8790/status | head -20   # rooms, players, host, mode, votes
```

`GET /status` (also `/api/status`, `/relay/status`) is for **you** and for uptime
pings, not for the client: the browser just dials `/ws` and retries with backoff,
which is what you want inside an iframe where a preflight would only add a
second failure mode. `GET /` prints a one-screen explanation of the endpoint.

## Mounting it on the game's own server

`server.js` in this repo imports and mounts it on the same HTTP server, under
`/ws`, so `node server.js` alone gives you a complete two-tab test:

```bash
node server.js                    # http://localhost:3823 — static + /ws
NO_RELAY=1 node server.js         # static only (relay lives elsewhere)
```

`createRelay({ server })` is idempotent per HTTP server (it stamps
`server.__sm64Relay`), and the upgrade matcher accepts any path ending in `/ws` —
`/ws` direct, or `/relay/ws` as the Discord proxy hands it over after its own
prefix conventions. Bolting onto an existing app is therefore three lines:

```js
import http from 'node:http';
import express from 'express';
import { createRelay } from './relay/server.js';

const app = express(), server = http.createServer(app);
app.use(express.static('.'));
const relay = createRelay({ server });        // now ws://host/ws?room=…
server.listen(process.env.PORT || 8790);
```

Returns `{ server, attach, handleHttp, rooms, stats, close }` — `rooms` is the
live `Map` (handy for an admin page), `handleHttp(req, res)` returns false if the
route wasn't a relay route, so you can chain it into your own router.

## What it guarantees

| | |
| --- | --- |
| room key | `?room=` (or `instance_id`), lowercased, `[a-z0-9_-]`, ≤40 chars, empty ⇒ `lobby` |
| capacity | 8 players per room; the 9th gets `{"t":"err","code":"room_full","max":8}` then a closed socket |
| host | first **engine-ready** player by join order; `pin` from `promote` wins while present; re-elected on every leave/ready change |
| input routing | `in` from anyone → `input` to the host only, never broadcast |
| state | `state` accepted from the host only; stored per room; replayed in `welcome` so joiners agree immediately |
| votes | 8 s, strict majority of connected (non-`left`) players, applied by the **relay** for `mode` |
| video | binary frames accepted from the host only, copied byte-for-byte to `watching` members, never decoded |
| backpressure | video is dropped, never queued (`writableNeedDrain` ⇒ skip + `drops++`); JSON is small enough to queue |
| chat | control chars stripped, 240 chars, 3 per 10 s, then `rate_limited` |
| flood | 60 text messages/s per connection, silently discarded beyond that; 2 MiB max assembled frame |
| liveness | ping every 25 s; a socket silent for 80 s is destroyed |
| cleanup | the room Map entry goes away with its last player (so a long-lived process doesn't accrete dead lobbies) |

What it does **not** do: authenticate, persist, ban, scale past one process, or
trust any client-supplied field. `id`/`name` are display data. That's enough for
a party game and it is stated in [docs/PROTOCOL.md](./PROTOCOL.md) rather than
buried.

## The cheapest option: a VPS whose edge already does TLS (exe.dev & friends)

**Question we get constantly: does the relay need a raw TCP port?** No. It is an
HTTP server that answers a WebSocket upgrade on the same port — `wss://` from the
browser, `http://` on the box. You never expose TCP, never open a second port, and
Discord's proxy (which only speaks HTTPS/WSS to your origin) is happy. exe.dev is
the nicest version of this because its edge terminates TLS for you and forwards
**one** port on the VM, and its docs say WebSockets/long-lived connections are
supported through that proxy.

```bash
ssh exe.dev new sm64relay
ssh sm64relay.exe.xyz
  git clone -b arena/01a04a00-only-mario-64 https://github.com/Guest453/only-mario-64.git
  cd only-mario-64
  HOST=0.0.0.0 PORT=8000 node server.js      # site + relay on one port, zero installs
```

Then the two things that actually bite:

```bash
ssh exe.dev share port sm64relay 8000        # tell the edge which port to forward
ssh exe.dev share set-public sm64relay       # ← REQUIRED
```

`set-public` matters because exe.dev VMs are **private by default**: anyone not on
your share list hitting `sm64relay.exe.xyz` gets redirected to exe.dev's login.
Discord's proxy is "anyone", so without this the Activity shows `○ solo` forever
and there is no error to read. If you would rather keep the whole box private, give
the relay its own public hostname instead of the shared one.

Verify *from somewhere that is not logged in* (phone, incognito on another
network) — both of these must work before touching the portal:

```bash
curl -s https://sm64relay.exe.xyz/status | head -3          # {"ok":true,...}
curl -is -o /dev/null -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -H 'Sec-WebSocket-Version: 13' \
  https://sm64relay.exe.xyz/ws?room=probe | head -1         # HTTP/1.1 101 Switching Protocols
```

Portal → Activities → URL Mappings: `/relay` → `sm64relay.exe.xyz` (no scheme, no
path). Whether the edge forwards `/relay/ws` or `/ws` does not matter — the relay
matches any path ending in `/ws`, and `test/proxy-edge.test.mjs` runs the whole app
through a prefix-stripping proxy to prove both shapes work.

Keep it alive across restarts (exe.dev restarts idle VMs):

```bash
sudo tee /etc/systemd/system/sm64relay.service > /dev/null <<'UNIT'
[Unit]
Description=SM64 multiplayer relay
After=network-online.target
[Service]
WorkingDirectory=/home/exe/only-mario-64
Environment=HOST=0.0.0.0
Environment=PORT=8000
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now sm64relay
```

Two notes: (1) `node server.js` serves the game too, so you can point the `/`
mapping at the same host and skip GitHub Pages/surge entirely — one origin, one
process; (2) the room key is the Discord instance id, which is unguessable-ish but
not secret. The relay has rate limits and an 8-player cap, no auth. Don't put
anything on this host that you'd mind the internet poking.

## TLS, which you do need

Discord's proxy only forwards to `https://`/`wss://` origins. Terminate TLS in
front of the relay and put that public host in the portal mapping; the relay
itself stays plain HTTP.

<details>
<summary><b>Caddy</b> — automatic certificates, four lines</summary>

```
sm64relay.example.com {
    reverse_proxy 127.0.0.1:8790
}
```
</details>

<details>
<summary><b>nginx</b></summary>

```nginx
location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;    # must exceed the 25s ping interval
    proxy_send_timeout 120s;
    proxy_buffering off;        # frames are latency-sensitive
}
```
</details>

Free/cheap hosts that work: Render (see `render.yaml` in this repo), Railway,
Fly.io, any VPS. Static-only hosts (GitHub Pages, Cloudflare Pages, Vercel
static) cannot run this half — that is the single operational cost of the design,
and the reason the client degrades to a solo copy instead of failing when the
relay is unreachable.

Free instances sleep when idle: the first player into a room sees `↻ retry` for
~30 s while the container wakes, then `● live`. The backoff retries and connects
on its own; if even that annoys you, cron a `curl /status` every 5 minutes.

## Testing

```bash
node --test --test-force-exit "test/relay.test.mjs"   # 8 integration tests, real sockets
npm test                                              # + arbitration + two DOM e2e files
```

They drive it through the raw-socket client in `test/ws-client.mjs`, so the suite
needs nothing installed and exercises real RFC 6455 framing rather than a mock.
