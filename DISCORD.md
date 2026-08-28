# Discord Activity setup

This app is a static site. Host it on **GitHub Pages**, then point Discord at that URL.

## 1. GitHub Pages

Repo Settings → Pages → Source: **GitHub Actions**.

After a push to `main`, the site is:

`https://guest453.github.io/only-mario-64/`

## 2. Discord application

https://discord.com/developers/applications → New Application

- **OAuth2 → Redirects**: not required for the Activity itself
- **Activities → URL Mappings**:

```
/                     https://guest453.github.io/only-mario-64
/.proxy/pollinations  https://gen.pollinations.ai
/.proxy/auth          https://enter.pollinations.ai
```

Default mapping `/` is enough for the game, WASM, CSS, and vendored PeerJS/Discord SDK.

Pollinations chat calls go **directly** to `https://gen.pollinations.ai` from the browser. If Discord blocks that, add a mapping and change `POLLINATIONS_API_BASE` in `main.js` to the proxied path (`/.proxy/pollinations`).

## 3. Launch

Enable **Embedded App SDK** / Activities, set Supported Platforms (desktop + web), then start the Activity from a voice channel.

Players paste a Pollinations API key on the gate screen. OAuth is offered too, but Discord iframes block the redirect — the key field is the supported path in Discord.

## 4. Lobby

The Activity `instance_id` becomes the room code (`dc…`). Everyone in that voice-channel Activity sees everyone else's AI feed.
