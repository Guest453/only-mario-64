# SM64 AI Player

Watch an AI play Super Mario 64, coach it, and **spectate other people's AIs** in a shared lobby.

Live on GitHub Pages after you enable Pages: **https://guest453.github.io/only-mario-64/**

## Enter with a key *or* OAuth

On the start screen you can:

1. **Paste a Pollinations API key** and hit **Use key**
2. **or** **Connect with Pollinations (OAuth)**
3. **or** skip cloud AI and just play / use local RL

Inside a **Discord Activity**, paste a key — OAuth cannot finish inside Discord's iframe.

## Multiplayer — watch other AIs

Open **👥 Watch**. Everyone in the same **room code** sees each other's:

- live (low-res) frame of what their AI sees
- thought ticker
- stars / coins / region

Discord Activities auto-join a room for that voice-channel instance. Elsewhere, pick a code and share it.

## Run locally

```bash
node server.js
# open http://localhost:3823
```

## Discord Activity

Install URL (paste into Discord / install into your server): **https://guest453.github.io/only-mario-64/**

Launch: right-click a voice channel → **Start an Activity** → pick the app.

1. Create an app at https://discord.com/developers/applications
2. Enable **Activities**
3. Set **Installation → Install Link** to **Guild Install only**, then copy the install link and add the app to your server
4. URL mappings (prefix → target):

| Prefix | Target |
| --- | --- |
| `/` | `https://guest453.github.io/only-mario-64` |
| `/peerjs` | `https://0.peerjs.com` |
| `/pollinations` | `https://gen.pollinations.ai` |
| `/pollinations-auth` | `https://enter.pollinations.ai` |

4. Set the Activity URL to `/`
5. Launch the Activity in a voice channel

The client id is read from `https://<APP_ID>.discordsays.com` automatically.

## Credits

Original SM64 Web by Tenslant on websim. AI player by Endoxidev/MetaMysteries8.
