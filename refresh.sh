#!/usr/bin/env bash
#
# hhapi v2 refresh -- single-command data pipeline.
#
# Designed to be cron-able on macOS, idempotent across stages, and
# resumable on failure. Each subcommand is a stage of the pipeline:
#
#   refresh.sh setup                 ensure venv + deps + dirs
#   refresh.sh fetch [STATES...]     download OSM/NAD/TIGER sources
#   refresh.sh tiles [STATES...]     per-state L0 tile build
#   refresh.sh overlay               L1 highway overlay (US-wide)
#   refresh.sh addresses [STATES...] per-state NAD+TIGER -> CSV
#   refresh.sh upload-r2             push tiles + overlay to R2
#   refresh.sh load-d1 [STATES...]   push address shards to D1
#   refresh.sh publish               atomic version flip in KV manifest
#   refresh.sh all [STATES...]       all stages in order (default: every state)
#
# STATES are 2-letter USPS codes (CA, TX, NY). Default = all 48 + DC.
#
# Auth: reads CLOUDFLARE_API_KEY (token) from ~/skillscan-family/.env.
# Override location with HHAPI_ENV_FILE.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VENV="$ROOT/.venv"
DATA_V2="$ROOT/data/v2"
LOG_DIR="$DATA_V2/logs"
mkdir -p "$DATA_V2" "$LOG_DIR"

# ---------------------------------------------------------------------------
# logging
# ---------------------------------------------------------------------------
log()  { printf '[refresh %s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die()  { log "ERROR: $*"; exit 1; }

# ---------------------------------------------------------------------------
# env
# ---------------------------------------------------------------------------
load_env() {
  local envfile="${HHAPI_ENV_FILE:-$HOME/skillscan-family/.env}"
  if [[ -f "$envfile" ]]; then
    export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-$(grep '^CLOUDFLARE_API_KEY=' "$envfile" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
    export HHAPI_API_KEY="${HHAPI_API_KEY:-$(grep '^HHAPI_API_KEY=' "$envfile" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
  fi
  export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-b5cdaad4db136b796354280697e0ceb9}"
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN not set (looked in $envfile)"
}

# ---------------------------------------------------------------------------
# version handling
# ---------------------------------------------------------------------------
version_file() { echo "$DATA_V2/version.txt"; }
read_version() {
  local f="$(version_file)"
  if [[ -f "$f" ]]; then cat "$f"; else date -u +%Y-%m; fi
}
write_version() {
  printf '%s' "$1" > "$(version_file)"
}

# ---------------------------------------------------------------------------
# state list resolution
# ---------------------------------------------------------------------------
all_states() {
  ensure_venv >/dev/null
  "$VENV/bin/python3" -c "from etl.v2.states import STATES; print(' '.join(s.code for s in STATES))"
}
resolve_states() {
  if [[ $# -eq 0 ]]; then all_states; else echo "$*"; fi
}

# ---------------------------------------------------------------------------
# stages
# ---------------------------------------------------------------------------
ensure_venv() {
  if [[ ! -x "$VENV/bin/python3" ]]; then
    log "creating venv"
    python3 -m venv "$VENV"
  fi
  if ! "$VENV/bin/python3" -c "import osmium, numpy, requests, aiohttp" >/dev/null 2>&1; then
    log "installing python deps"
    "$VENV/bin/python3" -m pip install --upgrade pip --quiet >/dev/null
    "$VENV/bin/python3" -m pip install --quiet osmium numpy requests aiohttp
  fi
  command -v osmium >/dev/null 2>&1 || die "osmium CLI missing (brew install osmium-tool)"
  command -v wrangler >/dev/null 2>&1 || die "wrangler missing (npm i -g wrangler)"
  log "setup OK"
}

stage_setup() { ensure_venv; }

stage_fetch() {
  ensure_venv
  local states; states=$(resolve_states "$@")
  log "fetch: OSM PBFs ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.fetch_sources $states 2>&1 | tee -a "$LOG_DIR/fetch.log"
  log "fetch: NAD (national)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.fetch_nad 2>&1 | tee -a "$LOG_DIR/fetch.log"
  log "fetch: OpenAddresses (US, per-source)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.fetch_oa --states $states 2>&1 | tee -a "$LOG_DIR/fetch.log"
}

stage_tiles() {
  ensure_venv
  local states; states=$(resolve_states "$@")
  local v; v=$(read_version)
  log "tiles ($v): $states"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.build_tiles --version "$v" $states 2>&1 | tee -a "$LOG_DIR/tiles.log"
}

stage_overlay() {
  ensure_venv
  local v; v=$(read_version)
  log "overlay ($v)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.build_overlay --version "$v" 2>&1 | tee -a "$LOG_DIR/overlay.log"
}

stage_addresses() {
  ensure_venv
  local states; states=$(resolve_states "$@")
  local v; v=$(read_version)
  local nad_zip="$DATA_V2/nad/nad-txt.zip"
  if [[ ! -f "$nad_zip" ]]; then
    log "ERROR: NAD ZIP missing at $nad_zip. Run: refresh.sh fetch"
    return 1
  fi
  log "addresses ($v): NAD national slice -> per-state .nad.csv ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.build_nad_addresses \
    --version "$v" --zip "$nad_zip" $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
  log "addresses ($v): OA per-source -> per-state .oa.csv ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.build_oa_addresses \
    --version "$v" $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
  log "addresses ($v): OSM addr-tagged nodes -> per-state .osm.csv ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.build_addresses \
    --version "$v" $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
  log "addresses ($v): merge -> per-state .csv (NAD > OA > OSM)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.merge_addresses \
    --version "$v" $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
}

stage_upload_r2() {
  ensure_venv; load_env
  local v; v=$(read_version)
  log "upload-r2 ($v): parallel uploader"
  bash "$ROOT/etl/v2/upload_tiles_parallel.sh" "$v" 16 2>&1 | tee -a "$LOG_DIR/upload-r2.log"
}

stage_load_d1() {
  ensure_venv; load_env
  local states; states=$(resolve_states "$@")
  local v; v=$(read_version)
  log "load-d1 ($v): parallel HTTP loader, states=$states"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.v2.load_d1_parallel \
    --version "$v" $states 2>&1 | tee -a "$LOG_DIR/load-d1.log"
}

stage_publish() {
  load_env
  local v; v=$(read_version)
  log "publish ($v): bumping KV manifest"
  bash "$ROOT/etl/v2/publish_manifest.sh" "$v" 2>&1 | tee -a "$LOG_DIR/publish.log"
}

stage_all() {
  local states; states=$(resolve_states "$@")
  local v; v=$(date -u +%Y-%m)
  write_version "$v"
  log "==== refresh.sh all v=$v states=$states ===="
  stage_setup
  stage_fetch     $states
  stage_tiles     $states
  stage_overlay
  stage_addresses $states
  stage_upload_r2
  stage_load_d1   $states
  stage_publish
  log "==== refresh.sh all complete (v=$v) ===="
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------
cmd="${1:-help}"; shift || true
case "$cmd" in
  setup)      stage_setup ;;
  fetch)      stage_fetch "$@" ;;
  tiles)      stage_tiles "$@" ;;
  overlay)    stage_overlay ;;
  addresses)  stage_addresses "$@" ;;
  upload-r2)  stage_upload_r2 ;;
  load-d1)    stage_load_d1 "$@" ;;
  publish)    stage_publish ;;
  all)        stage_all "$@" ;;
  states)     all_states ;;
  help|-h|--help|"")
    sed -n '4,30p' "$0"
    ;;
  *) die "unknown command: $cmd (try: $0 help)" ;;
esac
