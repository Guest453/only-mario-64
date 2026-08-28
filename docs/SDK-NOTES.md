# What the Discord Activities SDK actually gives you (and what it doesn't)

Notes written against **`@discord/embedded-app-sdk` v2.5.0** (the copy vendored in
[`lib/discord-embedded-sdk.js`](../lib/discord-embedded-sdk.js)) and
[the official reference](https://docs.discord.com/developers/developer-tools/embedded-app-sdk).
This is the answer to "how are we gonna do this" — including the parts where
Discord says no.

---

## 1. How an Activity is loaded at all

Discord launches Activities in a **sandboxed iframe** whose origin is
`https://<application_id>.discordsays.com`, with three query params:

| param | meaning |
| --- | --- |
| `frame_id` | this iframe (one per client) |
| `instance_id` | **this session, shared by everyone who joined it** |
| `platform` | `desktop` or `mobile` |

`new DiscordSDK(clientId)` **throws** if any of those are missing, which is why
`src/discord.js` sniffs the environment first and runs in "standalone mode"
outside Discord. The client id does not need to be configured in code: it is the
numeric subdomain, so the same static site works for any app id.

**Consequence for us:** `instance_id` *is* the room code. Everyone who opens the
Activity in the same voice channel gets the same value, and it is destroyed when
they all leave. No lobby database, no join codes, no expiring links.

## 2. Identity — no OAuth required

This is the bit that decides the whole design. Three separate sources, in
increasing order of effort:

1. **`await sdk.ready()`** resolves with `data.user = {id, username,
   discriminator, avatar?}` — the local player, **no scope required**.
2. **`sdk.commands.getInstanceConnectedParticipants()`** → `{participants:
   [User]}` where `User = {id, username, global_name, discriminator, avatar,
   avatar_decoration_data, bot, flags, premium_type}`. Everyone currently
   connected to *this instance*. **No scope required.**
3. **`sdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE', cb)`** pushes joins
   and leaves, so the roster is live rather than polled.

Avatars come from the Discord CDN, which the Activity CSP allows
(`cdn.discordapp.com`, `media.discordapp.net`):

```js
user.avatar
  ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=64`
  : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`
```

(Animated avatars are `a_`-prefixed hashes and must be served as `.gif`; users
with no avatar hash get the snowflake-derived default.)

Implemented in [`avatarUrl()`](../src/discord.js).

### So: no nickname field, no login screen, no API key

Names/avatars in the lobby come from `getInstanceConnectedParticipants()`. The
name you see is the name Discord has, and it is **not** sanitised by Discord —
so every render path in `src/ui.js` goes through `textContent`, never
`innerHTML`, and `sanitizeName()` strips control/zero-width characters and caps
length.

## 3. Optional: `authorize` → `authenticate`

`commands.authorize({scope:['identify','guilds','guilds.members.read','rpc.activities.write'],
response_type:'code', prompt:'none'})` pops Discord's consent sheet **inside the
client** (no redirect, no popup blocker) and returns **`{code}` only**. Trading
that code for an access token needs the app secret, i.e. a server — the flow in
[docs/ACTIVITY-AUTH.md](./ACTIVITY-AUTH.md). With a token you can then call

```js
const { access_token, user, scopes } = await sdk.commands.authenticate({ access_token });
```

`authenticate` returns the full user object *and* the granted scopes, which is
what unlocks:

| extra | needs |
| --- | --- |
| `setActivity()` rich presence ("Playing SM64 · Democracy · 5 in party") | `rpc.activities.write` |
| `getGuild()` / `getChannel()` / `getChannelPermissions()` | `guilds` |
| `CURRENT_USER_UPDATE`, `CURRENT_GUILD_MEMBER_UPDATE` (guild nick + guild avatar) | `identify`, `guilds.members.read` |
| `VOICE_STATE_UPDATE`, `SPEAKING_START/STOP` (who is talking → lit up in the roster) | `rpc.voice.read` |
| `getRelationships()` (friends list) | `relationships.read` — Social SDK review, not worth it here |

This repo treats all of that as an **upgrade**: `TOKEN_ENDPOINT` in
`src/discord.js` is empty by default and everything degrades silently. A
GitHub-Pages-only deployment therefore has zero server and still has names,
avatars, roster, invites and layout events.

## 4. Invites and sharing

| call | what it does | scope |
| --- | --- | --- |
| `openInviteDialog()` | native modal: send an invite to a channel / friend / copy link. Errors in DM contexts and without `CREATE_INSTANT_INVITE`, so check `getChannelPermissions()` first if you want a nice message | none |
| `inviteUserEmbedded({user_id, content})` | DM one specific user an invite card for this activity | none (v2.x) |
| `shareLink({message, custom_id})` | modal to share a deep link, with a `custom_id` you can read back off the launch URL | none |
| `openExternalLink({url})` | the *only* way out of the iframe — Discord shows a "trust this domain?" sheet | none |

The Invite button calls `openInviteDialog()`; outside Discord it degrades to
copying `?room=<instance_id>` to the clipboard, which is also how you test with
two browser tabs.

## 5. Layout, mobile, and being a good iframe citizen

* `ACTIVITY_LAYOUT_MODE_UPDATE` → `layout_mode`: `FOCUSED 0`, `PIP 1`, `GRID 2`.
  A game canvas can always shrink, but the chrome cannot; `src/discord.js` maps
  it to `html.layout-pip / .layout-grid` and `styles.css` collapses the side
  panel and shrinks the bar. There is also a viewport-size fallback, because the
  event does not always fire before first paint.
* `setConfig({use_interactive_pip:true})` — lets players keep pressing keys while
  the activity is a corner tile. Worth it here: spectating from PIP is a real
  use case when someone else is hosting.
* `setOrientationLockState(...)` — mobile only; we unlock everything so a phone
  can be turned sideways for a 4:3 game.
* `ORIENTATION_UPDATE`, `THERMAL_STATE_UPDATE` — mobile. Thermal is the hook for
  "drop the spectator frame rate before the phone throttles the wasm".
* `captureLog({level, message})` — forwards into Discord's logs, so a player
  reporting a bug can produce something readable. We wire `window.onerror` to it.
* `getPlatformBehaviors()` — `iosKeyboardResizesView`, i.e. why the chat box
  behaves differently on iPhone.
* **Keyboard focus**: the iframe does not own focus when it opens, and Discord
  stops routing keystrokes when it steals focus mid-session. `installFocusGuard()`
  re-grabs focus *only* within ~2 s of the user interacting with us, so we never
  yank the caret out of Discord's own chat. This was learned the hard way in the
  previous version of this repo.

## 6. What Discord explicitly does **not** do

> "All network traffic is routed through the Discord Proxy … Under the hood we
> utilize Cloudflare Workers, which brings some restrictions: WebTransport —
> currently only websockets supported. **WebRTC — not supported.**"
> — [Activity Proxy Considerations](https://docs.discord.com/developers/activities/development-guides/networking)

Which means, for a multiplayer game:

* ❌ No `RTCPeerConnection`, no data channels, no `getUserMedia`/`captureStream`
  WebRTC transport. PeerJS, Colyseus-over-WebRTC, WebRTC-direct mesh: all dead in
  the sandbox. (They still work in a plain browser tab, which is why a lot of
  tutorials mislead people here.)
* ❌ No UDP, no QUIC, no WebTransport.
* ❌ No game-state relay: the SDK has no "send to other participants" command.
  `getInstanceConnectedParticipants` is presence only.
* ❌ No authoritative truth: *"Do not trust data coming from the Discord client …
  assume any data coming from the Discord client could be falsified."* So the
  relay must never treat a claimed `id` as proof of anything. It is used for
  display and for stable host ordering, not for authorisation.
* ✅ HTTP, and **WebSockets** through `https://<app_id>.discordsays.com/<mapped-prefix>/...`.

That single ✅ is why this repo has [`relay/server.js`](../relay/server.js): a
~500-line WebSocket room server. Everything multiplayer in this Activity —
input fan-in, roster, votes, chat, and the low-res frame stream — rides on it,
routed through a `/relay` URL mapping.

Also worth knowing: **all traffic is same-origin-ish**. If the relay is mounted on
the same host that serves the site (which `server.js` does by default), the client
just opens `wss://<host>/ws` — no CORS, no absolute URLs, and inside Discord the
proxy hands it to the mapped target.

## 7. Monetization / misc we deliberately skipped

`getSkus`, `getEntitlements`, `startPurchase` (activities are monetizable now),
`initiateImageUpload` + `openShareMomentDialog` (share a highlight clip to a
channel — needs the ephemeral attachment endpoint), `QUEST_*`, `selectEmoji`
(emoji-picker-driven input, fun for chat), `SELECT_TEXT_CHANNEL` /
`SELECT_VOICE_CHANNEL` (channel pickers — not needed since the activity is
already bound to a voice channel), and the Activity Instance REST API
(`GET /applications/<app_id>/activity-instances/<instance_id>`, needs a bot
token) for server-side "is this instance real" checks.

The only one I'd add next is `openShareMomentDialog` for a "share that star"
button: capture a frame, upload via the attachments endpoint, share it.
