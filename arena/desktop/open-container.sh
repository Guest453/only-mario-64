#!/bin/sh
# Show a self-hosted container as the SHARED arena screen. $1 is a file holding
# the FULL url (hostname + path) so each container can differ. The file is
# rewritten by the sync timer, so a new tunnel URL needs no restart.
URLFILE="${1:-/data/container-url.txt}"
URL="$(cat "$URLFILE" 2>/dev/null)"
[ -z "$URL" ] && { echo "no container URL configured in $URLFILE" >&2; exit 1; }
exec chromium --kiosk --app="$URL" \
  --user-data-dir=/data/chromium-container \
  --no-first-run --no-default-browser-check --no-sandbox --disable-dev-shm-usage \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --autoplay-policy=no-user-gesture-required \
  --disable-background-timer-throttling --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding --overscroll-history-navigation=0 \
  --window-size=854,480 --window-position=0,0
