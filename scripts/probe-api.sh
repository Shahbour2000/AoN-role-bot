#!/usr/bin/env bash
# Captures REAL response shapes from the Age of Nations API into ./api-samples/.
# Run from a machine with normal internet access. Read-only GET requests, ~8 calls (limit is 60/min/IP).
# Usage: ./scripts/probe-api.sh <playerUsername> <countryId>
set -euo pipefail
BASE="${AON_API_BASE:-https://app.ageofnations.world/api/v1}"
USERNAME="${1:?player username}"; COUNTRY="${2:?country id, see /countries}"
OUT="api-samples"; mkdir -p "$OUT"
get() { # name path
  echo "GET $2"; curl -sS -D "$OUT/$1.headers" --max-time 20 "$BASE$2" -o "$OUT/$1.json" -w "  -> HTTP %{http_code}\n"; sleep 1.2
}
get game "/game"
get countries "/countries"
get player_by_name "/players/by-name/$USERNAME"
ID=$(python3 -c "import json;d=json.load(open('$OUT/player_by_name.json'));print(d.get('id') or d.get('_id') or d.get('player',{}).get('id',''))" 2>/dev/null || true)
echo "resolved player id: ${ID:-<not found: open $OUT/player_by_name.json and pass the id manually>}"
[ -n "$ID" ] && get player_stats "/players/$ID/stats" && get player_profile "/players/$ID"
get gov_members "/countries/$COUNTRY/government/members"
get gov "/countries/$COUNTRY/government"
get parties "/countries/$COUNTRY/parties"
get units "/countries/$COUNTRY/units"
get alliances "/alliances"
echo "Done. Review $OUT/*.json (contains only public game data) and share them back."
