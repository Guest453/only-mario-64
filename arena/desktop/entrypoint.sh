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
# A null sink gives us something to record even with no sound hardware. Lesson
# carried over from the vnc-activity box: keep PULSE_RUNTIME_PATH in the user's
# own home, never a root-created /tmp path, or the session user gets locked out
# of its own socket.
export PULSE_RUNTIME_PATH=/data/pulse
mkdir -p "$PULSE_RUNTIME_PATH"
pulseaudio --start --exit-idle-time=-1 --disallow-exit >/dev/null 2>&1 || true
pactl load-module module-null-sink sink_name=arena sink_properties=device.description=arena >/dev/null 2>&1 || true
pactl set-default-sink arena >/dev/null 2>&1 || true

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
