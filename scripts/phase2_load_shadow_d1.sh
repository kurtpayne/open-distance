#!/usr/bin/env bash
# Phase 2 D1 loader: load local v2 CSVs into the new od-geo-* shards (shadow).
#
# Requires:
#   - scripts/provision_d1_shards.sh has already run -> data/v2/d1_bindings.toml
#   - scripts/cf_env.sh sources CF creds
#
# This DOES NOT touch the live hhapi-geo-* shards. Production keeps serving.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. scripts/cf_env.sh

BINDINGS="$ROOT/data/v2/d1_bindings.toml"
VERSION="${VERSION:-2026-06}"

if [[ ! -f "$BINDINGS" ]]; then
  echo "ERROR: $BINDINGS missing -- run scripts/provision_d1_shards.sh first" >&2
  exit 1
fi
N_BIND=$(grep -c "^\[\[d1_databases\]\]" "$BINDINGS")
if [[ "$N_BIND" -lt 49 ]]; then
  echo "ERROR: $BINDINGS has $N_BIND bindings; need 49. Provision still running?" >&2
  exit 1
fi

VENV="$ROOT/.venv"
[[ -x "$VENV/bin/python3" ]] || { echo "ERROR: venv missing -- ./refresh.sh setup" >&2; exit 1; }

echo "[phase2-load] addresses -> 49 od-geo-* shards (~80M rows, ~2h)"
PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.load_d1_parallel \
  --version "$VERSION" --bindings "$BINDINGS" 2>&1 \
  | tee -a "$ROOT/data/v2/logs/phase2-load-addr.log"

echo "[phase2-load] segments -> 49 od-geo-* shards (~33M rows)"
PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.load_d1_segments \
  --version "$VERSION" --bindings "$BINDINGS" 2>&1 \
  | tee -a "$ROOT/data/v2/logs/phase2-load-segs.log"

echo "[phase2-load] done."
