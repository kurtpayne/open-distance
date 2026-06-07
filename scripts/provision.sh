#!/usr/bin/env bash
# Provision R2 bucket, D1 database, KV namespace for open-distance.
# Idempotent: prints existing ids if resources already exist.
set -euo pipefail

cd "$(dirname "$0")/.."

# Auth via env (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID must be exported)
: "${CLOUDFLARE_API_TOKEN:?Need CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Need CLOUDFLARE_ACCOUNT_ID}"

R2_BUCKET="od-graph"
D1_NAME="od-geocode"
KV_NAME="OD_API_CACHE"

echo "[provision] R2 bucket: $R2_BUCKET"
wrangler r2 bucket list 2>/dev/null | grep -q "^$R2_BUCKET\$" \
  || wrangler r2 bucket create "$R2_BUCKET"

echo "[provision] D1: $D1_NAME"
D1_JSON=$(wrangler d1 list --json 2>/dev/null || echo "[]")
D1_ID=$(python3 -c "import sys,json; arr=json.load(sys.stdin); [print(d.get('uuid') or d.get('id')) for d in arr if d.get('name')=='$D1_NAME']" <<<"$D1_JSON" | head -1)
if [[ -z "$D1_ID" ]]; then
  CREATE_OUT=$(wrangler d1 create "$D1_NAME" 2>&1)
  echo "$CREATE_OUT"
  D1_ID=$(echo "$CREATE_OUT" | grep -oE '"database_id"[^,]*' | grep -oE '[a-f0-9-]{36}' | head -1)
  if [[ -z "$D1_ID" ]]; then
    D1_ID=$(echo "$CREATE_OUT" | grep -oE 'database_id = "[a-f0-9-]+"' | grep -oE '[a-f0-9-]{36}')
  fi
fi
echo "  D1_ID=$D1_ID"

echo "[provision] KV: $KV_NAME"
KV_JSON=$(wrangler kv namespace list 2>/dev/null || echo "[]")
KV_ID=$(python3 -c "import sys,json; arr=json.load(sys.stdin); [print(k['id']) for k in arr if k.get('title')=='$KV_NAME']" <<<"$KV_JSON" | head -1)
if [[ -z "$KV_ID" ]]; then
  CREATE_OUT=$(wrangler kv namespace create "$KV_NAME" 2>&1)
  echo "$CREATE_OUT"
  KV_ID=$(echo "$CREATE_OUT" | grep -oE 'id = "[a-f0-9]+"' | grep -oE '[a-f0-9]{32}')
fi
echo "  KV_ID=$KV_ID"

# Patch wrangler.toml.
python3 - "$D1_ID" "$KV_ID" <<'PY'
import re, sys, pathlib
d1_id, kv_id = sys.argv[1], sys.argv[2]
p = pathlib.Path("wrangler.toml")
text = p.read_text()
text = re.sub(r'(\[\[d1_databases\]\][\s\S]*?database_id = ")[^"]+(")', r'\g<1>' + d1_id + r'\g<2>', text)
text = re.sub(r'(\[\[kv_namespaces\]\][\s\S]*?id = ")[^"]+(")', r'\g<1>' + kv_id + r'\g<2>', text)
p.write_text(text)
print("wrangler.toml updated.")
PY

echo "[provision] done."
