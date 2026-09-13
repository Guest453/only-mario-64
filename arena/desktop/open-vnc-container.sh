#!/bin/sh
# Show a VNC container as the SHARED arena screen with a NATIVE viewer.
# Target comes from /data/vnc-target.txt (the arena's X display is INSIDE this
# container, so a relay on the gateway bridges the host's ssh tunnel in here).
# No browser, no noVNC, no exposed URL.
# No window manager runs on the game display, so -FullScreen can't be honoured —
# pin the geometry to the display size instead.
TARGET="$(cat /data/vnc-target.txt 2>/dev/null)"
[ -z "$TARGET" ] && { echo "no VNC target configured" >&2; exit 1; }
exec xtigervncviewer -Shared -AcceptClipboard=1 -SendClipboard=1 \
  -geometry "$(cat /data/vnc-geometry.txt 2>/dev/null || echo 1280x720+0+0)" \
  "$TARGET"
