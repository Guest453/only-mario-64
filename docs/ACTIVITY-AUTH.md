# Optional: turning Discord auth on

You can skip this file. The Activity ships with `TOKEN_ENDPOINT = ''` and works
fully — names, avatars, roster, invites, layout, chat — because `sdk.ready()`
already hands back `{id, username, discriminator, avatar}` and
`getInstanceConnectedParticipants()` hands back everyone in the instance, **both
scope-free**.

Auth buys you three specific things, and each is already wired to react to it:

| you want | scope | what lights up |
| --- | --- | --- |
| "Playing SM64 · Democracy · 5 in party" in the member list | `rpc.activities.write` | `sdk.commands.setActivity()` — the whole `startPresence()` path (`?presence=1` lets you test the call shape against the mock SDK) |
| guild nickname + guild avatar, and `CURRENT_USER_UPDATE` pushes | `identify`, `guilds.members.read` | `dc.me` merges richer user objects; `displayName()` already prefers `nick` → `global_name` → `username` |
| 🎙 next to whoever is talking in the voice channel | `rpc.voice.read` | `subscribeVoice()` → `dc.speakers` → roster rows |
| verified identities at the relay | — | see the last section |

## Why there is no client-only version of this

`authorize()` inside an Activity returns **`{code}` and nothing else** (checked
against the v2.5.0 bundle's own schema). Trading that code at
`https://discord.com/api/oauth2/token` requires the **app secret**, and any
`fetch` you make from the iframe is a public secret. So a token always needs one
HTTP endpoint you control — a server, even if it is 30 lines on a free tier.

PKCE (`code_verifier`/`code_challenge`) would remove the secret, but Discord only
allows the PKCE-less-confidential-app flow for apps with the
`PUBLIC_OAUTH2_CLIENT` application flag, which is not self-serve. Assume you need
the secret endpoint.

## The endpoint

```js
// auth.js — run anywhere with TLS; set TOKEN_ENDPOINT = '/auth/token' in src/discord.js
import http from 'node:http';

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT = process.env.DISCORD_REDIRECT_URI;      // must match the portal exactly

http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/auth/token')) { res.writeHead(404).end(); return; }
    const { code } = await JSON.parse(await body(req));
    const r = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID, client_secret: SECRET,
            grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        }),
    });
    const tok = await r.json();
    // Only the access token crosses back into the iframe; the secret never does.
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: tok.access_token, scope: tok.scope }));
}).listen(process.env.PORT || 8791);
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (d) => s += d); req.on('end', () => r(s)); });
```

Portal note: that `redirect_uri` has to be listed under **OAuth2 → Redirects**,
byte-for-byte. The community-documented trick for local development is registering
`https://127.0.0.1:8791/callback`-style URLs and pointing the tunnel at them;
inside Discord the `authorize()` modal does not visibly use the redirect, but
Discord still validates the value you send matches a registered one.

Then, in this repo, flip one constant:

```js
// src/discord.js
export const TOKEN_ENDPOINT = '/auth/token';
```

`maybeAuthenticate()` does the rest: `authorize({scope, response_type:'code',
prompt:'none'})` → POST → `sdk.commands.authenticate({access_token})` →
`dc.authed = true`, `dc.scopes` populated, voice subscription enabled, presence
allowed. Every step is wrapped so a denial (user clicks "Cancel", guild lacks the
scope, the endpoint is down) just logs at debug level and the game continues in
the scope-free mode. `prompt: 'none'` is what makes it silent when consent was
already granted.

**Do not** put the access token in `localStorage`: it is a user-delegated OAuth
token in a *shared* Discord iframe. `dc.me`/`dc.scopes` live in memory only, which
is also why `initDiscord()` re-runs its handshake on every launch.

## Verifying players at the relay (the useful half)

The last row of the table above is the reason to bother. Design, in the shape the
code already leaves room for:

1. Browser obtains `access_token` as above.
2. Browser POSTs it to the relay's `POST /api/exchange`; the relay calls
   `GET https://discord.com/api/users/@me` **server-side**, confirms the `id`, and
   mints a short-lived HMAC ticket `{id, room, exp}`.
3. The WS upgrade carries `?tk=<ticket>` (a browser cannot set headers on a
   WebSocket), the relay verifies the HMAC and binds `player.id` to it instead of
   trusting the query string.
4. From then on the roster's `id` field is *proof*, which is what you would need
   for a leaderboard, a per-user mute, or "the host is the person who started the
   instance".

`Room.add()` in `relay/server.js` is the single place step 3 lands, and
`docs/PROTOCOL.md`'s "Trust" section is the contract you'd be amending. Discord's
own warning belongs in any implementation of this: *"assume any data coming from
the Discord client could be falsified."*

## What remains unverifiable even with all of the above

* **That a player is who they claim inside the game loop.** The relay sees sockets,
  not controllers; a verified Discord id still sends `{t:'in', s:0xffff}`.
* **Anything about the game state.** The wasm has no hooks, so there is no score,
  star count, or position to verify — see [GAME-DESIGN.md](./GAME-DESIGN.md#trust-what-a-player-can-forge).
  Do not build a competitive leaderboard on top of "the client said it collected a
  coin", because the client cannot tell you that at all.
