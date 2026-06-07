#!/usr/bin/env bash
# Phase 3 cleanup: delete the old hhapi-* CF resources after the cutover.
#
# Reckless mode -- nukes:
#   - R2 bucket hhapi-graph (~9.3 GB tiles + 110 MB overlay; ALL OBJECTS GONE)
#   - 49 D1 dbs hhapi-geo-<state> (~80M address rows + 33M segment rows GONE)
#   - 1 D1 db hhapi-geocode (legacy v1; usually empty)
#   - 1 KV namespace HHAPI_CACHE (rate-limit counters + manifest GONE)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. scripts/cf_env.sh

echo "[cleanup] === R2 bucket hhapi-graph ==="
# Wrangler can't bulk-delete; use the CF API to list + DELETE each object,
# then drop the bucket.
delete_r2_bucket() {
  local bucket="$1"
  local cursor=""
  local total=0
  while :; do
    local url="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects?per_page=1000"
    [[ -n "$cursor" ]] && url="${url}&cursor=${cursor}"
    local resp
    resp=$(curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "$url")
    local keys
    keys=$(echo "$resp" | python3 -c "import sys, json; d=json.load(sys.stdin); print('\n'.join(k['key'] for k in (d.get('result') or [])))")
    if [[ -z "$keys" ]]; then break; fi
    local n
    n=$(echo "$keys" | wc -l | tr -d ' ')
    total=$((total + n))
    echo "  deleting $n objects (total so far: $total)..."
    # Delete in parallel batches.
    echo "$keys" | xargs -P 16 -I{} curl -sS -X DELETE \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${bucket}/objects/{}" \
      -o /dev/null
    cursor=$(echo "$resp" | python3 -c "import sys, json; print(json.load(sys.stdin).get('result_info', {}).get('cursor') or '')")
    [[ -z "$cursor" ]] && break
  done
  echo "  deleted $total objects total. now dropping bucket..."
  wrangler r2 bucket delete "$bucket" 2>&1 | tail -3
}
delete_r2_bucket hhapi-graph

echo
echo "[cleanup] === D1 dbs hhapi-geo-* + hhapi-geocode ==="
D1_LIST=$(wrangler d1 list --json 2>/dev/null)
echo "$D1_LIST" | python3 -c "
import sys, json
arr = json.load(sys.stdin)
hhapi_dbs = [d for d in arr if d.get('name', '').startswith('hhapi-')]
print(f'  found {len(hhapi_dbs)} hhapi-* dbs to delete')
for d in hhapi_dbs:
    print(d['name'])
" | tail -n +2 | while read -r dbname; do
  [[ -z "$dbname" ]] && continue
  echo "  deleting D1 $dbname..."
  echo "y" | wrangler d1 delete "$dbname" 2>&1 | tail -2 || echo "    (failed)"
done

echo
echo "[cleanup] === KV namespace HHAPI_CACHE ==="
OLD_KV_ID="f36df580b639463b85b337a0b2e9ab20"
wrangler kv namespace delete --namespace-id "$OLD_KV_ID" 2>&1 | tail -3 || echo "  (failed)"

echo
echo "[cleanup] done. Old hhapi-* resources removed."
