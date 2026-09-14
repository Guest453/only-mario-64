#!/bin/bash
# arena node agent — detects this box's own hardware + games and registers it
# with the arena every run. Name/desc/games come FROM THE MACHINE; the arena
# never hardcodes them. Runs from a systemd timer; expired heartbeats drop the
# node from the arena's list automatically.
set -u
ARENA="https://sm64.cesustheteapot.dpdns.org"
SECRET_FILE="$HOME/.arena-node-secret"
[ -s "$SECRET_FILE" ] || exit 0
SECRET=$(cat "$SECRET_FILE")

ID=$(hostname | tr -cd 'a-zA-Z0-9_-')
CPU=$(lscpu 2>/dev/null | awk -F': +' '/Model name/{print $2; exit}')
CPU=${CPU:-unknown-cpu}
CORES=$(nproc 2>/dev/null || echo '?')
RAM_GB=$(awk '/MemTotal/{printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo '?')

# games this box actually offers: retroarch cores x roms present
GAMES=""
ROMDIRS="/home/cesustt/roms $HOME/roms"
declare -A SEEN
for d in $ROMDIRS; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    [ -e "$f" ] || continue
    base=$(basename "$f"); ext="${base##*.}"
    case "$ext" in
      gba) sys="GBA";; gb|gbc) sys="Game Boy";; sfc|smc) sys="SNES";;
      nes) sys="NES";; md|gen|smd) sys="Genesis";; cue|chd|pbp) sys="PSX";;
      pce) sys="PC Engine";; nds) sys="NDS";; *) continue;;
    esac
    key="$base"
    [ -n "${SEEN[$key]:-}" ] && continue
    SEEN[$key]=1
    name=$(echo "$base" | sed -E 's/\.[^.]+$//; s/\([Uu][Ss][Aa]?[^)]*\)//g; s/\[[^]]*\]//g; s/  +/ /g; s/^ +| +$//g')
    GAMES="$GAMES{\"name\":\"$name\",\"system\":\"$sys\"},"
  done
done
EXTRA=""
command -v openitg >/dev/null 2>&1 && EXTRA="$EXTRA{\"name\":\"OpenITG\",\"system\":\"Dance pad\"},"
[ -n "$EXTRA" ] && GAMES="$GAMES$EXTRA"
GAMES="${GAMES%,}"

DESC="$CPU · ${CORES} cores · ${RAM_GB}GB · $(ls /usr/lib/libretro/*.so 2>/dev/null | wc -l) cores installed"

PAYLOAD=$(python3 - "$SECRET" "$ID" "$DESC" "$GAMES" <<'PYEOF'
import json,sys
secret,id,desc,games=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
try: g=json.loads("["+games+"]") if games else []
except Exception: g=[]
print(json.dumps({"secret":secret,"id":id,
  "name":id,"system":"self-hosted",
  "desc":desc,"games":g,
  "vnc":{"port":5901}}))
PYEOF
)
curl -sS -m 20 -X POST "$ARENA/api/node/register" -H 'Content-Type: application/json' -d "$PAYLOAD" >/dev/null 2>&1 || exit 1
echo "registered $(hostname) at $(date -u +%H:%M)"
