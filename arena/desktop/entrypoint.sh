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
# PULSE_RUNTIME_PATH must NOT live on the persistent volume.
#
# It used to be /data/pulse. /data is a docker volume, so the pid file and unix
# socket survived the container that made them: on the next start PulseAudio
# found a pid file naming a process that does not exist in this container,
# concluded another daemon owned the runtime dir, and exited. Symptom was
# "arena.monitor: No such process" in a restart loop and total silence — the
# exact same shape as the stale Chromium SingletonLock this container already
# had to be taught about.
#
# Runtime state belongs somewhere container-local, so /tmp: fresh every boot,
# and created by this user (a ROOT-created /tmp pulse dir is its own bug — it
# locks the session user out of its own socket).
export PULSE_RUNTIME_PATH=/tmp/pulse-arena
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/arena-run}"
mkdir -p "$PULSE_RUNTIME_PATH" "$XDG_RUNTIME_DIR"
chmod 700 "$PULSE_RUNTIME_PATH" "$XDG_RUNTIME_DIR" 2>/dev/null || true

# Belt and braces: if anything stale is somehow present, move it aside rather
# than let pulse refuse to start. Moved, not deleted.
for stale in pid native; do
  if [ -e "$PULSE_RUNTIME_PATH/$stale" ]; then
    mv -f "$PULSE_RUNTIME_PATH/$stale" "$PULSE_RUNTIME_PATH/.stale-$stale" 2>/dev/null \
      && echo "[desktop] moved stale pulse $stale aside"
  fi
done

# NOT -D. Daemonising closes stderr, which collides with --log-target=stderr and
# the fork handshake fails in a container: the only symptom was "Daemon startup
# failed" with no reason. Run in the foreground as a background job instead —
# verified by hand: identical flags minus -D and pulse starts, creates its sink
# and stays up.
pulseaudio --exit-idle-time=-1 --disallow-exit --disable-shm     --log-target=newfile:/tmp/pulse.log &
PULSE_PID=$!

# Wait for the daemon to actually answer before loading anything into it.
PULSE_OK=0
for i in $(seq 1 40); do
  if pactl info >/dev/null 2>&1; then PULSE_OK=1; break; fi
  sleep 0.25
done

if [ "$PULSE_OK" = "1" ]; then
  # Unload suspend-on-idle BEFORE creating the sink.
  #
  # This is the whole reason audio kept cutting out. PulseAudio suspends a sink
  # that has nothing playing, and a SUSPENDED sink's monitor stops producing
  # samples — so ffmpeg's capture goes dead every time the game is quiet, then
  # resumes, which lands as audio chopping in and out. The wasm build never had
  # this because its audio came from a WebCodecs encoder inside a page, not from
  # a Pulse monitor.
  #
  # The vnc-activity stack on this same box already had to learn this. I did not
  # carry it across.
  pactl unload-module module-suspend-on-idle >/dev/null 2>&1     && echo "[desktop] unloaded module-suspend-on-idle (keeps the monitor streaming)"     || echo "[desktop] note: module-suspend-on-idle was not loaded"

  # Pin the sink to 48kHz s16le. It defaults to 44100, which meant the game fed
  # it 48k, pulse resampled to 44.1k, and ffmpeg resampled back to 48k for Opus
  # — two conversions for no reason. Matching the whole chain removes both.
  pactl load-module module-null-sink sink_name=arena rate=48000 channels=2 format=s16le \
      sink_properties=device.description=arena >/dev/null 2>&1 || true
  pactl set-default-sink arena >/dev/null 2>&1 || true

  # NO module-loopback here.
  #
  # An earlier version loaded `module-loopback source=arena.monitor sink=arena`
  # to "hold the sink open". That feeds a sink's own monitor back INTO itself: a
  # feedback loop that re-mixes every sample every 1ms. It is what turned the
  # audio into spam and cut-offs. Unloading suspend-on-idle above already keeps
  # the monitor streaming, so nothing needs to hold the sink open.
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
  tail -20 /tmp/pulse.log 2>/dev/null | sed 's/^/[pulse] /' || true
fi

echo "[desktop] starting window manager"
# xfwm4 alone: the XFCE window manager without the panel, desktop menu, app
# finder, terminal or file manager. There is no menu to open because there is no
# panel installed, and nothing to launch because nothing else is in the image.
xfwm4 --daemon --compositor=off >/dev/null 2>&1 || true

# Runtime half of the lockdown. The build-time half is that these programs do
# not exist in the image at all.
xfconf-query -c xfce4-keyboard-shortcuts -p /xfwm4/custom -rR >/dev/null 2>&1 || true

# Desktop mode runs as `guest`, which needs to reach this X server and this
# PulseAudio. Scoped to that one local user — not `xhost +`, which would be
# every user in the container.
xhost +si:localuser:guest >/dev/null 2>&1 && echo "[desktop] X access granted to guest" || true
pactl load-module module-native-protocol-unix socket=/tmp/pulse-arena.socket auth-anonymous=1 >/dev/null 2>&1 \
  && chmod 666 /tmp/pulse-arena.socket 2>/dev/null \
  && echo "[desktop] audio socket shared with guest" || true

# Clear Chromium's stale profile lock, same story as pulse's pid file above.
#
# /data/chromium is a persistent volume, and Chromium writes SingletonLock there
# naming the host and pid that own the profile. After a restart the new container
# has a new hostname, so Chromium sees a lock owned by "another computer",
# refuses to start, and SM64 silently never launches:
#   "The profile appears to be in use by another Chromium process (208)
#    on another computer (9f69149da8bd)"
# This is the THIRD time this exact pattern has bitten this project — persistent
# volume, ephemeral lock. Moved aside, never deleted.
for lock in SingletonLock SingletonSocket SingletonCookie; do
  if [ -e "/data/chromium/$lock" ] || [ -L "/data/chromium/$lock" ]; then
    mv -f "/data/chromium/$lock" "/data/chromium/.stale-$lock" 2>/dev/null \
      && echo "[desktop] moved stale chromium $lock aside"
  fi
done

echo "[desktop] serving the sm64 wasm page on loopback"
node /app/arena/desktop/serve-game.js &

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
