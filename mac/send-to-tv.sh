#!/bin/bash
# Send files from the Mac into the TV's Downloads folder (TV Downloads TizenBrew module).
# Usage: send-to-tv.sh FILE...        (also used by the Finder "Send to TV" Quick Action)
# The TV address is auto-detected: tv-dl.local, then the IP in ~/.config/send-to-tv (TV_IP=...), on ports 80 and 8090.
set -u
CONF="$HOME/.config/send-to-tv"
[ -f "$CONF" ] && . "$CONF"
LOG="$HOME/Library/Logs/send-to-tv.log"

notify() { osascript -e "display notification \"$(printf '%s' "$2" | sed 's/"/\\"/g')\" with title \"$1\"" >/dev/null 2>&1; }
say() { echo "$*"; echo "$(date '+%F %T') $*" >> "$LOG"; }
urlenc() {
  # percent-encode every byte (handles Tamil/emoji/spaces correctly)
  printf '%s' "$1" | xxd -p | tr -d '\n' | sed 's/../%&/g'
}

find_tv() {
  local candidates="${TV_URL:-} http://tv-dl.local http://tv-dl.local:8090"
  [ -n "${TV_IP:-}" ] && candidates="$candidates http://$TV_IP http://$TV_IP:8090"
  for u in $candidates; do
    if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$u/api/links")" = "200" ]; then echo "$u"; return 0; fi
  done
  return 1
}

[ $# -eq 0 ] && { echo "usage: $0 FILE..."; exit 1; }
BASE=$(find_tv) || { say "TV not reachable (is TV Downloads open in TizenBrew?)"; notify "Send to TV" "TV not reachable. Open TV Downloads on the TV and try again."; exit 1; }

ok=0; fail=0
for f in "$@"; do
  name=$(basename "$f")
  if [ ! -f "$f" ]; then say "skip (not a file): $f"; fail=$((fail+1)); continue; fi
  size=$(stat -f %z "$f")
  if [ "$size" -gt 4294967295 ]; then say "warning: $name is over 4 GB; the TV refuses it on FAT32 drives"; fi
  notify "Sending to TV" "$name ($(( size / 1048576 )) MB)"
  say "sending $name → $BASE"
  progress=(-s); [ -t 1 ] && progress=(--progress-bar)
  resp=$(mktemp)
  code=$(curl "${progress[@]}" -T "$f" "$BASE/api/upload?name=$(urlenc "$name")" -o "$resp" -w '%{http_code}')
  if [ "$code" = "200" ]; then
    saved=$(sed -n 's/.*"file":"\([^"]*\)".*/\1/p' "$resp")
    say "done: $name → Downloads/$saved"; ok=$((ok+1))
    notify "Sent to TV ✓" "$saved"
  else
    err=$(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' "$resp"); err=${err:-HTTP $code}
    say "failed: $name — $err"; fail=$((fail+1))
    notify "Send to TV failed" "$name: $err"
  fi
  rm -f "$resp"
done
[ $((ok+fail)) -gt 1 ] && notify "Send to TV" "$ok sent, $fail failed"
[ $fail -eq 0 ]
