# Self-hosting a node for the arena

Any machine you own can appear in the arena's Containers tab and main menu.
The box describes ITSELF (CPU, RAM, cores installed, ROMs found) — the arena
never hardcodes anything. Heartbeats expire after 5 minutes, so a box that
goes offline disappears from the list on its own.

## What you need
- Linux box with SSH access for setup
- A VNC server showing what you want to share (x11vnc on a headless Xvfb is
  what this repo ships for; anything speaking RFB on localhost works)
- The node secret from the arena operator (`/data/node-secret` inside the
  arena container)

## Setup

1. Install the prerequisites (Arch example):

        sudo pacman -S --needed retroarch libretro-mgba libretro-snes9x \
            libretro-genesis-plus-gx libretro-nestopia libretro-gambatte \
            xorg-server-xvfb openbox x11vnc websockify novnc curl python

   (Debian: the same names minus `xorg-server-`, plus `libretro-*` variants.)

2. Put your ROMs in `~/roms` — the agent scans it by extension
   (gba/gb/gbc/sfc/smc/nes/md/gen/cue/chd/pbp/nds) and lists what it finds.

3. Save the node secret (ask the operator, never commit it):

        install -m 600 /dev/stdin ~/.arena-node-secret <<< "<NODE_SECRET>"

4. Install the agent (this repo, `arena/node/`):

        sudo install -m 755 arena-node-agent.sh /usr/local/bin/
        sudo install -m 644 arena-node-agent.service /etc/systemd/system/
        sudo install -m 644 arena-node-agent.timer  /etc/systemd/system/
        sudo systemctl daemon-reload && sudo systemctl enable --now arena-node-agent.timer

5. Share a desktop over VNC on localhost:5900 (headless example):

        Xvfb :1 -screen 0 1280x720x24 -nolisten tcp &
        openbox &   # or any WM
        x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -localhost -quiet &

   The agent advertises port 5901 by default — the arena reaches your box
   through an ssh reverse tunnel that lands on the arena host's loopback:

        ssh -N -R 5901:localhost:5900 <arena-user>@<arena-host>

   Keep that tunnel up (a systemd unit with Restart=always is the easy way).
   If your arena uses a different port, edit `vnc` in the agent script.

## How it shows up
- the arena lists you as `node:<your-hostname>` with YOUR name/description
- a viewer clicking JOIN gets a same-origin noVNC page with a server-minted
  token — their browser connects straight to your VNC through the relay
- no IPs, no wss URLs, no credentials are ever exposed to viewers
- stop the timer (or the box) and you drop off the list within 5 minutes

## Security notes
- the registration endpoint is secret-gated (timing-safe compare)
- the relay only dials targets on its allowlist (loopback by default) — it can
  never be used to reach arbitrary machines
- tokens are random, single-purpose and expire
