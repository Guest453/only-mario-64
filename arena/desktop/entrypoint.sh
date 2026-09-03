#!/usr/bin/env bash
# Desktop arena boot: X -> audio -> window manager -> capture/input agent.
set -euo pipefail

: "${ARENA_HOST_TOKEN:?ARENA_HOST_TOKEN must be set}"
W="${ARENA_W:-854}"
H="${ARENA_H:-480}"
FPS="${ARENA_FPS:-30}"
DISPLAY_NUM="${DISPLAY:-:99}"
export DISPLAY="$DISPLAY_NUM"

echo "[desktop] starting X on $DISPLAY at ${W}x${H}"
Xvfb "$DISPLAY" -screen 0 "${W}x${H}x24" -nolisten tcp -dpi 96 &
XVFB_PID=$!

# Wait for the server to actually accept connections instead of sleeping blind.
for i in $(seq 1 100); do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.1
done
xdpyinfo >/dev/null 2>&1 || { echo "[desktop] FATAL: X never came up"; exit 1; }

# No blanking, no screensaver, no power management. A blanked screen would look
# exactly like a crashed stream to every viewer, and the watchdog would restart
# a perfectly healthy session.
xset s off -dpms s noblank || true

echo "[desktop] starting pulseaudio"
# A null sink gives us something to record even with no sound hardware.
#
# This block used to end every line with ">/dev/null 2>&1 || true", so when
# pulse failed to start nothing said so — the symptom that reached users was
# "no audio AND the game runs at turbo speed", because RetroArch paces emulation
# against its audio output and had nothing to pace against. Errors are loud now.
export PULSE_RUNTIME_PATH=/data/pulse
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/data/home/.run}"
mkdir -p "$PULSE_RUNTIME_PATH" "$XDG_RUNTIME_DIR"
chmod 700 "$PULSE_RUNTIME_PATH" "$XDG_RUNTIME_DIR" 2>/dev/null || true

# NOT -D. Daemonising closes stderr, which collides with --log-target=stderr and
# the fork handshake fails in a container: the only symptom was "Daemon startup
# failed" with no reason. Run in the foreground as a background job instead —
# verified by hand: identical flags minus -D and pulse starts, creates its sink
# and stays up.
pulseaudio --exit-idle-time=-1 --disallow-exit --disable-shm     --log-target=newfile:/data/pulse.log &
PULSE_PID=$!

# Wait for the daemon to actually answer before loading anything into it.
PULSE_OK=0
for i in $(seq 1 40); do
  if pactl info >/dev/null 2>&1; then PULSE_OK=1; break; fi
  sleep 0.25
done

if [ "$PULSE_OK" = "1" ]; then
  pactl load-module module-null-sink sink_name=arena sink_properties=device.description=arena >/dev/null 2>&1 || true
  pactl set-default-sink arena >/dev/null 2>&1 || true
  if pactl list short sources 2>/dev/null | grep -q "arena.monitor"; then
    echo "[desktop] audio ready: arena.monitor"
  else
    echo "[desktop] WARNING: pulse is up but arena.monitor is missing — expect silence"
  fi
else
  # Not fatal: video still works. But say so, loudly, instead of pretending.
  echo "[desktop] WARNING: pulseaudio did NOT start — there will be no sound."
  echo "[desktop] RetroArch is capped by fastforward_ratio so the game still runs at 1x."
  echo "[desktop] pulse log follows:"
  tail -20 /data/pulse.log 2>/dev/null | sed 's/^/[pulse] /' || true
fi

echo "[desktop] starting window manager"
# xfwm4 alone: the XFCE window manager without the panel, desktop menu, app
# finder, terminal or file manager. There is no menu to open because there is no
# panel installed, and nothing to launch because nothing else is in the image.
xfwm4 --daemon --compositor=off >/dev/null 2>&1 || true

# Runtime half of the lockdown. The build-time half is that these programs do
# not exist in the image at all.
xfconf-query -c xfce4-keyboard-shortcuts -p /xfwm4/custom -rR >/dev/null 2>&1 || true

echo "[desktop] starting relay"
# Same relay as the wasm build, with the key allowlist widened to a full
# keyboard. Viewers and the auth gate are untouched.
ARENA_FULL_KEYBOARD=1 node /app/arena/server.js &
RELAY_PID=$!
for i in $(seq 1 50); do
  node -e "require('net').connect(${ARENA_PORT:-8090},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && break
  sleep 0.2
done

echo "[desktop] launching agent"
exec node /app/arena/desktop/agent.js
