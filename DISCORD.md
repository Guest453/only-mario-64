# Discord Activity setup

This app is a static site. Host it on **GitHub Pages**, then point Discord at that URL.

## 1. GitHub Pages

Repo Settings → Pages → Source: **Deploy from a branch** → `main` / `/` (root).

After a push to `main`, the site is:

**`https://guest453.github.io/only-mario-64/`**

> This is the **install URL** — the thing you paste into Discord to install the Activity. A friend who doesn't have this repo can't just open that URL, though: the Activity lives inside a Discord voice channel, so they have to be invited through Discord itself.

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

## 3. Install type — use GUILD INSTALL (this app is a game, not a user tool)

**Installation → Install Link**: set the install type to **Guild Install** only (uncheck **User Install**).

- With *user install*, Discord treats the Activity as a personal app; you can't add it to a server, and friends can't find it.
- With **Guild Install**, the invite looks like a bot invite and the Activity shows up in the server's **Activity / "Start Activity"** picker (right-click the voice channel → **Start an Activity**).

Install the app into your server via **Installation → Install Link → Copy** (the `https://discord.com/oauth2/authorize?...` URL), pick your server, authorize.

## 4. Launch

Enable **Embedded App SDK** / Activities, set Supported Platforms (desktop + web), then start the Activity from a voice channel:

**Right-click a voice channel → Start an Activity → pick "SM64 AI Player".** Anyone in that voice channel can join.

Players paste a Pollinations API key on the gate screen. OAuth is offered too, but Discord iframes block the redirect — the key field is the supported path in Discord.

## 5. Lobby

The Activity `instance_id` becomes the room code (`dc…`). Everyone in that voice-channel Activity sees everyone else's AI feed.

## 6. Known quirk: typing in text boxes

Inside Discord, keyboard focus in the activity iframe is fragile and the game engine can swallow keystrokes. The app handles both:

- an **always-on key guard** keeps every keystroke typed in a text box away from the game engine (so it can't cancel them), and
- a **focus bootstrap** grabs keyboard focus for the iframe on load and whenever Discord's client steals it mid-interaction.

If a box still won't take your typing: click the box (or any button) once so the activity has focus, then type. On desktop Discord, clicking inside the activity always re-focuses it.
