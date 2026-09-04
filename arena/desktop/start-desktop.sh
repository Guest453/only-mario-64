#!/usr/bin/env bash
# XFCE desktop mode.
#
# This is the OPPOSITE of the game modes on purpose: a real desktop with a menu,
# a file manager, a terminal and Steam. Everything the lockdown removes, put
# back, because that is the point of the mode.
#
# Two things keep it from being a foot-gun:
#  - it runs in the same throwaway container as everything else, on a volume you
#    can wipe; nothing here is anyone's real machine
#  - the arena's watchdog is still running outside this session, so if the crowd
#    kills X or the game, the container restarts and comes back
set -u

export DISPLAY="${DISPLAY:-:99}"
# guest has no access to arena's private pulse runtime dir, so use the shared
# socket the entrypoint published. Without this the desktop is silent.
export PULSE_SERVER="unix:/tmp/pulse-arena.socket"

# A visible, permanent reminder that this is a broadcast. Anyone typing a real
# password into Steam here is typing it in front of everyone watching.
if command -v xmessage >/dev/null 2>&1; then
  xmessage -geometry +10+10 -timeout 20 \
    "THIS SCREEN IS PUBLIC — everyone in the Discord activity can see it. Never type a real password. Make a throwaway account." &
fi
xsetroot -solid '#1d2330' 2>/dev/null || true

# XFCE needs a D-BUS SESSION BUS. Without one the panel exits immediately with
#   "Name org.xfce.Panel lost on the message dbus, exiting"
# and xfdesktop dies on
#   "xfce_desktop_new: assertion 'channel && property_prefix' failed"
# which is why desktop mode showed an empty screen: the processes started and
# then quietly gave up. dbus-run-session creates the bus and runs the session
# inside it.
#
# Clean up anything left from a previous attempt first — xfce4-panel refuses to
# start when it sees a stale instance ("There is already a running instance").
pkill -u "$(id -u)" -x xfce4-panel 2>/dev/null || true
pkill -u "$(id -u)" -x xfdesktop 2>/dev/null || true
sleep 1

if command -v dbus-run-session >/dev/null 2>&1; then
  exec dbus-run-session -- sh -c 'xfdesktop --disable-wm-check & exec xfce4-panel --disable-wm-check'
else
  # Older images ship dbus-launch instead of dbus-run-session.
  eval "$(dbus-launch --sh-syntax)"
  xfdesktop --disable-wm-check &
  exec xfce4-panel --disable-wm-check
fi
