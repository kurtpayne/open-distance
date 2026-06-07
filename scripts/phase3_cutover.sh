#!/usr/bin/env bash
# Phase 3 cutover: deploy `open-distance` Worker pointing at od-* resources,
# CF reassigns custom domains automatically. Then nuke the old hhapi Worker.
#
# Reckless mode: no prompts, no backups, no verification gates. The user
# asserted there are no live users; old resources are deleted in the
# follow-up cleanup script.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. scripts/cf_env.sh

[[ -f wrangler.new.toml ]] || { echo "ERROR: wrangler.new.toml missing" >&2; exit 1; }

# Promote new config in place.
mv wrangler.new.toml wrangler.toml

echo "[cutover] deploying open-distance Worker..."
wrangler deploy 2>&1 | tail -15
echo

echo "[cutover] probing https://open-distance.com/healthz..."
sleep 5
for i in 1 2 3 4 5 6; do
  RESP=$(curl -sS --max-time 10 https://open-distance.com/healthz 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    echo "  ok: $RESP"; break
  fi
  echo "  attempt $i: $RESP"; sleep 5
done

echo
echo "[cutover] quick sanity (SF intra-metro distance matrix)..."
curl -sS --max-time 15 "https://open-distance.com/maps/api/distancematrix/json?origins=37.7749,-122.4194&destinations=37.7849,-122.4094" | head -c 400
echo
echo

echo "[cutover] deleting old hhapi Worker..."
wrangler delete --name hhapi 2>&1 | tail -5 || true

echo "[cutover] done. Now run scripts/phase3_cleanup_old_resources.sh to delete old R2/D1/KV."
