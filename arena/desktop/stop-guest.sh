#!/usr/bin/env bash
# Terminate every process owned by `guest` (the desktop-mode session).
#
# The launcher runs as `arena` and CANNOT signal guest's processes — that uid
# boundary is the whole point of the privilege split, but it also means arena
# cannot clean up after desktop mode. This script is the one narrow exception,
# allowed by a single NOPASSWD sudoers rule and nothing else.
set -u
pkill -u guest 2>/dev/null || true
sleep 2
pkill -9 -u guest 2>/dev/null || true
exit 0
