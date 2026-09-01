#!/usr/bin/env bash
# Boot order matters: relay first (the host page connects to it on load), then
# the internal static server, then the one Chromium that is the game.
set -euo pipefail

: "${ARENA_HOST_TOKEN:?ARENA_HOST_TOKEN must be set}"
ARENA_PORT="${ARENA_PORT:-8090}"
HOST_STATIC_PORT="${HOST_STATIC_PORT:-8091}"
FPS="${ARENA_FPS:-30}"
BITRATE="${ARENA_BITRATE:-1800000}"
PROFILE_DIR="${ARENA_PROFILE_DIR:-/data/profile}"

mkdir -p "$PROFILE_DIR"

node /app/arena/server.js &
RELAY_PID=$!
node /app/arena/host/serve-host.js &
STATIC_PID=$!

# Wait for both to actually accept connections rather than sleeping and hoping.
for i in $(seq 1 50); do
  if node -e "require('net').connect($ARENA_PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null \
  && node -e "require('net').connect($HOST_STATIC_PORT,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

HOST_URL="http://127.0.0.1:${HOST_STATIC_PORT}/host.html?relay=ws://127.0.0.1:${ARENA_PORT}/host&token=${ARENA_HOST_TOKEN}&fps=${FPS}&bitrate=${BITRATE}"

# Chromium flags, and why each one is here:
#   --headless=new             no X server, no Xvfb, no framebuffer grab
#   --use-angle=swiftshader    this VM has no /dev/dri; WebGL must be software.
#                              (--disable-gpu is deliberately NOT set: it would
#                              take WebGL with it and the game would not render)
#   --autoplay-policy=...      nothing can click in a headless tab, and without
#                              this the AudioContext never leaves 'suspended'
#   --disable-*-backgrounding  a throttled renderer drops the game to ~1fps
#   --user-data-dir            IndexedDB lives here, which means THE SAVE FILE
#                              lives here, which is why it is a mounted volume
exec chromium \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --use-gl=angle \
  --use-angle=swiftshader \
  --enable-unsafe-swiftshader \
  --autoplay-policy=no-user-gesture-required \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --hide-scrollbars \
  --window-size=640,480 \
  --user-data-dir="$PROFILE_DIR" \
  --enable-logging=stderr --v=0 \
  "$HOST_URL"
