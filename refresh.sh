#!/usr/bin/env bash
#
# open-distance data refresh -- single-command ETL pipeline.
#
# Designed to be cron-able on macOS, idempotent across stages, and
# resumable on failure. Each subcommand is a stage of the pipeline:
#
#   refresh.sh setup                 ensure venv + deps + dirs
#   refresh.sh bootstrap             one-time CF resource provisioning
#                                    (R2 bucket, KV ns, 49 D1 shards)
#   refresh.sh fetch [STATES...]     download OSM PBFs + NAD + OA + TIGER
#   refresh.sh tiles [STATES...]     per-state L0 tile build (CSR binaries)
#   refresh.sh addresses [STATES...] NAD+OA+OSM merged CSV + TIGER segments CSV
#   refresh.sh upload-r2             push tiles to R2 (parallel)
#   refresh.sh load-d1 [STATES...]   push address shards to D1 (parallel HTTP).
#                                    Skips any state whose merged-addresses and
#                                    segments CSVs are byte-identical to the last
#                                    successful load (hash manifest at
#                                    data/v2/out/<version>/load_hashes.json), so
#                                    D1 write costs scale with what changed.
#                                    Pass --force to reload every state anyway:
#                                      refresh.sh load-d1 --force [STATES...]
#   refresh.sh oa-attribution        refresh data/v2/oa/attribution.json from
#                                    OpenAddresses' per-source manifests
#                                    (no GeoJSON downloads; ~2-3 min)
#   refresh.sh publish               write manifest to KV (atomic version)
#   refresh.sh all [STATES...]       all stages in order (default: every state)
#   refresh.sh quarterly [--yes]     THE recurring refresh: detect -> fetch what
#                                    changed -> build -> upload -> D1 delta ->
#                                    publish. Run on the 2nd of Mar/Jun/Sep/Dec.
#                                    Dry-run without --yes. See stage_quarterly.
#
# STATES are 2-letter USPS codes (CA, TX, NY). Default = all 48 + DC.
#
# Auth: looks for CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY in (in order):
#   $OD_API_ENV_FILE if set
#   ./.env at the repo root
#   the existing shell environment
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
  local envfile="${OD_API_ENV_FILE:-$ROOT/.env}"
  if [[ -f "$envfile" ]]; then
    # Accept either CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY (alias used by
    # some user shells); use whichever appears first.
    if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
      export CLOUDFLARE_API_TOKEN="$(grep -E '^CLOUDFLARE_API_(TOKEN|KEY)=' "$envfile" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    fi
    if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
      export CLOUDFLARE_ACCOUNT_ID="$(grep '^CLOUDFLARE_ACCOUNT_ID=' "$envfile" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    fi
    if [[ -z "${OD_API_HOSTNAME:-}" ]]; then
      export OD_API_HOSTNAME="$(grep '^OD_API_HOSTNAME=' "$envfile" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    fi
  fi
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN not set (set it directly or put it in $envfile)"
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || die "CLOUDFLARE_ACCOUNT_ID not set"
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
# preflight guards
# ---------------------------------------------------------------------------
# Refuse to rebuild into a version directory that the delta-refresh pipeline
# has already loaded into D1 (state/fingerprints.json lists it for some state).
assert_version_not_loaded() {
  local v="$1"
  local fp="$ROOT/state/fingerprints.json"
  [[ -f "$fp" ]] || return 0
  ensure_venv >/dev/null
  local loaded
  loaded=$(PYTHONPATH="$ROOT" "$VENV/bin/python3" -c \
    "import sys; from etl.legacy_guard import states_with_version; print(' '.join(states_with_version(sys.argv[1])))" "$v")
  if [[ -n "$loaded" ]]; then
    die "version $v is already loaded into D1 (states: $loaded); bump data/v2/version.txt"
  fi
}

# Address build needs tens of GB of scratch (NAD slice + per-state CSVs).
assert_free_space() {
  local min_gb="${OD_MIN_FREE_GB:-60}"
  local free_kb free_gb
  free_kb=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')
  free_gb=$(( free_kb / 1024 / 1024 ))
  log "free space on $ROOT volume: ${free_gb} GB (min ${min_gb} GB)"
  if (( free_gb < min_gb )); then
    die "only ${free_gb} GB free (< ${min_gb} GB); free space or set OD_MIN_FREE_GB"
  fi
}

# ---------------------------------------------------------------------------
# state list resolution
# ---------------------------------------------------------------------------
all_states() {
  ensure_venv >/dev/null
  "$VENV/bin/python3" -c "from etl.states import STATES; print(' '.join(s.code for s in STATES))"
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
  if ! "$VENV/bin/python3" -c "import osmium, numpy, requests, aiohttp, fiona" >/dev/null 2>&1; then
    log "installing python deps"
    "$VENV/bin/python3" -m pip install --upgrade pip --quiet >/dev/null
    "$VENV/bin/python3" -m pip install --quiet osmium numpy requests aiohttp fiona
  fi
  command -v osmium >/dev/null 2>&1 || die "osmium CLI missing (brew install osmium-tool)"
  command -v wrangler >/dev/null 2>&1 || [[ -x "$ROOT/node_modules/.bin/wrangler" ]] || die "wrangler missing (npm install, or npm i -g wrangler)"
  log "setup OK"
}

stage_setup() { ensure_venv; }

stage_bootstrap() {
  ensure_venv; load_env
  log "bootstrap: provisioning CF resources (idempotent)"
  # R2 + legacy D1 + KV (skips if already exists)
  bash "$ROOT/scripts/provision.sh" 2>&1 | tee -a "$LOG_DIR/bootstrap.log" || true
  # Per-state D1 shards
  bash "$ROOT/scripts/provision_d1_shards.sh" 2>&1 | tee -a "$LOG_DIR/bootstrap.log"
  # Append shard bindings to wrangler.toml (skip if already present)
  if ! grep -q "GEOCODE_CA" "$ROOT/wrangler.toml"; then
    log "bootstrap: appending shard bindings to wrangler.toml"
    cat "$ROOT/data/v2/d1_bindings.toml" >> "$ROOT/wrangler.toml"
  fi
  log "bootstrap: done"
}

stage_fetch() {
  ensure_venv
  local states; states=$(resolve_states "$@")
  log "fetch: OSM PBFs ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.fetch_sources $states 2>&1 | tee -a "$LOG_DIR/fetch.log"
  log "fetch: NAD (national)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.fetch_nad 2>&1 | tee -a "$LOG_DIR/fetch.log"
  log "fetch: OpenAddresses (US, per-source)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.fetch_oa --states $states 2>&1 | tee -a "$LOG_DIR/fetch.log"
  log "fetch: TIGER edges-geodatabase (per state)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.fetch_tiger --vintage "${OD_TIGER_VINTAGE:-TGRGDB24}" $states 2>&1 | tee -a "$LOG_DIR/fetch.log"
}

stage_oa_attribution() {
  # Refresh the per-source OpenAddresses attribution manifest only -- no
  # GeoJSON downloads. ~2-3 min for ~2300 sources fetched concurrently from
  # OpenAddresses' GitHub source repo. Run after stage_fetch picks up new
  # sources, or standalone to refresh attribution text without re-downloading
  # the underlying address data. Output: data/v2/oa/attribution.json (uploaded
  # to KV by stage_publish under key "attribution:openaddresses", served by
  # the Worker at /attribution/openaddresses.json).
  ensure_venv
  log "oa-attribution: refreshing per-source OA manifest"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.fetch_oa --metadata-only 2>&1 \
    | tee -a "$LOG_DIR/oa-attribution.log"
}

stage_tiles() {
  ensure_venv
  local states; states=$(resolve_states "$@")
  local v; v=$(read_version)
  assert_version_not_loaded "$v"
  log "tiles ($v): $states"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.build_tiles --version "$v" $states 2>&1 | tee -a "$LOG_DIR/tiles.log"
}

stage_overlay() {
  ensure_venv
  local v; v=$(read_version)
  log "overlay ($v): building L1 highway binary"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.build_overlay --version "$v" 2>&1 | tee -a "$LOG_DIR/overlay.log"
  local bin="$DATA_V2/out/$v/l1-overlay.bin"
  if [[ ! -f "$bin" ]]; then
    log "ERROR: overlay binary missing at $bin"
    return 1
  fi
  log "overlay ($v): uploading $(du -h "$bin" | cut -f1) to R2 (od-graph/overlay/$v/l1.bin)"
  npx wrangler r2 object put "od-graph/overlay/$v/l1.bin" --file "$bin" --remote 2>&1 | tee -a "$LOG_DIR/overlay.log"
}

stage_addresses() {
  ensure_venv
  local states; states=$(resolve_states "$@")
  local v; v=$(read_version)
  assert_version_not_loaded "$v"
  assert_free_space
  # NAD ZIP: $OD_NAD_ZIP, else the canonical fetch target, else the newest
  # release-named archive (nad-txt-2026q1.zip etc.) already on disk.
  local nad_zip="${OD_NAD_ZIP:-$DATA_V2/nad/nad-txt.zip}"
  if [[ ! -f "$nad_zip" ]]; then
    local newest
    newest=$(ls -t "$DATA_V2"/nad/nad-txt*.zip 2>/dev/null | head -1 || true)
    if [[ -z "$newest" ]]; then
      log "ERROR: NAD ZIP missing at $nad_zip (and no data/v2/nad/nad-txt*.zip). Run: refresh.sh fetch"
      return 1
    fi
    log "NAD ZIP $nad_zip missing; falling back to $newest"
    nad_zip="$newest"
  fi
  log "addresses ($v): NAD national slice from $nad_zip -> per-state .nad.csv ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.build_nad_addresses \
    --version "$v" --zip "$nad_zip" --states $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
  log "addresses ($v): OA per-source -> per-state .oa.csv ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.build_oa_addresses \
    --version "$v" $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
  log "addresses ($v): OSM addr-tagged nodes -> per-state .osm.csv ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.build_addresses \
    --version "$v" $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
  log "addresses ($v): merge -> per-state .csv (NAD > OA > OSM)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.merge_addresses \
    --version "$v" $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
  log "addresses ($v): TIGER segments -> per-state segments.csv ($states)"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.build_tiger_segments \
    --version "$v" --vintage "${OD_TIGER_VINTAGE:-TGRGDB24}" $states 2>&1 | tee -a "$LOG_DIR/addresses.log"
}

stage_upload_r2() {
  ensure_venv; load_env
  local v; v=$(read_version)
  log "upload-r2 ($v): parallel uploader"
  bash "$ROOT/etl/upload_tiles_parallel.sh" "$v" 16 2>&1 | tee -a "$LOG_DIR/upload-r2.log"
}

stage_load_d1() {
  ensure_venv; load_env
  # Pull a leading/anywhere --force flag out of the args; the rest are states.
  # --force bypasses the per-state source-hash skip and reloads every state.
  local force=""
  local positional=()
  for arg in "$@"; do
    if [[ "$arg" == "--force" ]]; then
      force="--force"
    else
      positional+=("$arg")
    fi
  done
  local states; states=$(resolve_states ${positional[@]+"${positional[@]}"})
  local v; v=$(read_version)
  log "load-d1 ($v): addresses (parallel HTTP)${force:+ --force}, states=$states"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.load_d1_parallel \
    --version "$v" $force $states 2>&1 | tee -a "$LOG_DIR/load-d1.log"
  log "load-d1 ($v): TIGER segments${force:+ --force}, states=$states"
  PYTHONPATH="$ROOT" "$VENV/bin/python3" -m etl.load_d1_segments \
    --version "$v" $force $states 2>&1 | tee -a "$LOG_DIR/load-d1.log"
}

stage_publish() {
  load_env
  local v; v=$(read_version)
  log "publish ($v): bumping KV manifest"
  bash "$ROOT/etl/publish_manifest.sh" "$v" 2>&1 | tee -a "$LOG_DIR/publish.log"
}

# ---------------------------------------------------------------------------
# quarterly: the one command for the recurring refresh.
#
#   refresh.sh quarterly [--yes] [--max-rows N] [--version YYYY-MM]
#                        [--skip-roads] [--plan-only] [-- <extra etl.sync_d1 args>]
#
# Cadence: the 2nd of March, June, September and December (the day after the
# Cloudflare billing cycle renews). Each run:
#   1. detect   etl.check_upstream vs state/upstream-snapshot.json (no downloads)
#   2. fetch    only what changed: NAD blob, changed OpenAddresses sources,
#               the newest TIGER vintage if it moved, fresh OSM extracts if
#               roads are being rebuilt
#   3. build    addresses (NAD > OA > OSM merge); TIGER segments only when the
#               vintage changed (else the previous version's are reused);
#               tiles + L1 overlay only when roads are being rebuilt
#   4. upload   tiles + overlay to R2 under the new version (roads only)
#   5. load     etl.sync_d1 delta into D1: dry-run always; writes with --yes
#   6. publish  GEO_VERSION := version (addresses); DATA_VERSION := version
#               only when roads were rebuilt; KV manifest; commit + push so
#               GitHub deploys. Snapshot updated last.
# Without --yes everything up to and including the D1 dry-run happens; nothing
# is written to Cloudflare and nothing is committed.
# ---------------------------------------------------------------------------
stage_quarterly() {
  ensure_venv
  local yes="" max_rows="48000000" v="" skip_roads="" plan_only=""
  local extra=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes) yes=1 ;;
      --max-rows) max_rows="$2"; shift ;;
      --version) v="$2"; shift ;;
      --skip-roads) skip_roads=1 ;;
      --plan-only) plan_only=1 ;;
      --) shift; extra=("$@"); break ;;
      *) die "quarterly: unknown arg $1" ;;
    esac
    shift
  done
  [[ -n "$v" ]] || v=$(date -u +%Y-%m)
  local py="$VENV/bin/python3"
  local snap="$ROOT/state/upstream-snapshot.json"
  local report="$LOG_DIR/upstream-$v.json"
  local prev
  prev=$("$py" -c "import json,sys; fp=json.load(open('$ROOT/state/fingerprints.json')); vs={s.get('addresses',{}).get('version') for s in fp.values()}; vs.discard(None); print(sorted(vs)[-1] if vs else '')" 2>/dev/null || true)
  [[ -n "$prev" ]] || die "quarterly: state/fingerprints.json has no loaded version (run etl.export_d1_mirror + etl.seed_fingerprints first)"
  [[ "$prev" != "$v" ]] || die "quarterly: version $v is already loaded (pass --version)"
  log "==== quarterly refresh: $prev -> $v ${yes:+(WRITES ENABLED)} ===="

  # 1. detect -----------------------------------------------------------------
  log "quarterly: detect upstream changes"
  set +e
  PYTHONPATH="$ROOT" "$py" -m etl.check_upstream --snapshot "$snap" --out "$report" 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  local rc=${PIPESTATUS[0]}
  set -e
  [[ $rc -eq 0 || $rc -eq 3 ]] || die "quarterly: check_upstream failed (rc=$rc)"
  local nad_changed tiger_changed tiger_vintage oa_changed osm_changed
  read -r nad_changed tiger_changed tiger_vintage oa_changed osm_changed < <("$py" - "$report" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
nad = r.get("nad", {}); tiger = r.get("tiger", {}); oa = r.get("oa", {}); osm = r.get("osm", {})
def yn(x): return "1" if x else "0"
tv = tiger.get("newest_vintage") or "TGRGDB24"
print(yn(nad.get("changed")), yn(tiger.get("changed") or tiger.get("changed_states")), tv,
      yn((oa.get("changed_sources") or 0) > 0), yn(osm.get("changed") or osm.get("changed_states")))
PY
)
  local roads=1; [[ -n "$skip_roads" ]] && roads=0
  log "quarterly: NAD changed=$nad_changed  TIGER changed=$tiger_changed (newest $tiger_vintage)  OA changed=$oa_changed  OSM changed=$osm_changed  roads=$roads"
  if [[ -n "$plan_only" ]]; then
    log "quarterly: --plan-only; would: fetch$( [[ $nad_changed == 1 ]] && echo ' NAD') OA-changed$( [[ $tiger_changed == 1 ]] && echo " TIGER($tiger_vintage)")$( [[ $roads == 1 ]] && echo ' OSM'); build addresses$( [[ $tiger_changed == 1 ]] && echo ' segments' || echo ' (segments reused)')$( [[ $roads == 1 ]] && echo ' tiles overlay'); load D1 delta; publish GEO_VERSION=$v$( [[ $roads == 1 ]] && echo " DATA_VERSION=$v")"
    return 0
  fi

  # 2. fetch ------------------------------------------------------------------
  load_env
  assert_version_not_loaded "$v"
  assert_free_space
  write_version "$v"
  local states; states=$(all_states)
  if [[ $nad_changed == 1 || ! -f "$DATA_V2/nad/nad-txt.zip" ]]; then
    log "quarterly: fetch NAD (new release)"
    rm -f "$DATA_V2/nad/nad-txt.zip"
    PYTHONPATH="$ROOT" "$py" -m etl.fetch_nad 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  fi
  log "quarterly: fetch changed OpenAddresses sources"
  PYTHONPATH="$ROOT" "$py" -m etl.fetch_oa --changed-only 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  if [[ $tiger_changed == 1 ]]; then
    log "quarterly: fetch TIGER $tiger_vintage"
    PYTHONPATH="$ROOT" "$py" -m etl.fetch_tiger --vintage "$tiger_vintage" 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  fi
  if [[ $roads == 1 ]]; then
    log "quarterly: fetch fresh OSM extracts (roads rebuild)"
    rm -f "$DATA_V2"/states/*/*.osm.pbf
    PYTHONPATH="$ROOT" "$py" -m etl.fetch_sources $states 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  elif ! ls "$DATA_V2"/states/*/*.osm.pbf >/dev/null 2>&1; then
    die "quarterly: --skip-roads but no OSM extracts on disk for the addresses build (OSM addr:* nodes); drop --skip-roads or restore data/v2/states"
  fi

  # 3. build ------------------------------------------------------------------
  log "quarterly: build addresses ($v)"
  local out="$DATA_V2/out/$v"; mkdir -p "$out/addresses"
  local nad_zip="$DATA_V2/nad/nad-txt.zip"
  PYTHONPATH="$ROOT" "$py" -m etl.build_nad_addresses --version "$v" --zip "$nad_zip" 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  PYTHONPATH="$ROOT" "$py" -m etl.build_oa_addresses --version "$v" 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  PYTHONPATH="$ROOT" "$py" -m etl.build_addresses --version "$v" $states 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  PYTHONPATH="$ROOT" "$py" -m etl.merge_addresses --version "$v" 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  if [[ $tiger_changed == 1 ]]; then
    log "quarterly: build TIGER segments ($tiger_vintage)"
    PYTHONPATH="$ROOT" "$py" -m etl.build_tiger_segments --version "$v" --vintage "$tiger_vintage" 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  else
    log "quarterly: TIGER unchanged; reusing $prev segments"
    [[ -e "$out/segments" ]] || ln -s "../$prev/segments" "$out/segments"
  fi
  if [[ $roads == 1 ]]; then
    log "quarterly: build tiles + overlay ($v)"
    PYTHONPATH="$ROOT" "$py" -m etl.build_tiles --version "$v" $states 2>&1 | tee -a "$LOG_DIR/quarterly.log"
    PYTHONPATH="$ROOT" "$py" -m etl.build_overlay --version "$v" 2>&1 | tee -a "$LOG_DIR/quarterly.log"
    [[ -f "$out/l1-overlay.bin" ]] || die "quarterly: overlay binary missing"
  fi

  # 4. upload (roads) ---------------------------------------------------------
  if [[ $roads == 1 ]]; then
    if [[ -n "$yes" ]]; then
      log "quarterly: upload tiles + overlay to R2 under $v"
      bash "$ROOT/etl/upload_tiles_parallel.sh" "$v" 16 2>&1 | tee -a "$LOG_DIR/quarterly.log"
      npx wrangler r2 object put "od-graph/overlay/$v/l1.bin" --file "$out/l1-overlay.bin" --remote 2>&1 | tee -a "$LOG_DIR/quarterly.log"
    else
      log "quarterly: (no --yes) skipping R2 upload of $(ls "$out/tiles" | wc -l | tr -d ' ') tiles + overlay"
    fi
  fi

  # 5. load (D1 delta) --------------------------------------------------------
  log "quarterly: D1 delta dry-run ($prev -> $v)"
  PYTHONPATH="$ROOT" "$py" -m etl.sync_d1 --version "$v" --only both --dry-run "${extra[@]}" 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  if [[ -z "$yes" ]]; then
    log "quarterly: dry-run complete. Re-run with --yes [--max-rows N] [-- --allow-rebuild ST ...] to write."
    return 0
  fi
  log "quarterly: D1 delta apply (cap $max_rows rows written)"
  PYTHONPATH="$ROOT" "$py" -m etl.sync_d1 --version "$v" --only both --yes --reuse-plans --max-rows "$max_rows" \
    --state-parallelism 6 --stmts-per-request 8 --rps 20 "${extra[@]}" 2>&1 | tee -a "$LOG_DIR/quarterly.log"

  # 6. publish ----------------------------------------------------------------
  log "quarterly: publish"
  local f
  for f in wrangler.toml wrangler.toml.template; do
    sed -i '' -E "s/^GEO_VERSION = \"[^\"]+\"/GEO_VERSION = \"$v\"/" "$ROOT/$f"
    [[ $roads == 1 ]] && sed -i '' -E "s/^DATA_VERSION = \"[^\"]+\"/DATA_VERSION = \"$v\"/" "$ROOT/$f"
  done
  bash "$ROOT/etl/publish_manifest.sh" "$v" 2>&1 | tee -a "$LOG_DIR/quarterly.log" || log "WARN: publish_manifest failed (continuing)"
  PYTHONPATH="$ROOT" "$py" -m etl.check_upstream --snapshot "$snap" --out "$report" --update-snapshot --quiet 2>&1 | tee -a "$LOG_DIR/quarterly.log" || true
  ( cd "$ROOT" && git add wrangler.toml wrangler.toml.template state/ \
    && git commit -q -m "Quarterly refresh $v: GEO_VERSION=$v$( [[ $roads == 1 ]] && echo ", DATA_VERSION=$v" ); fingerprints + upstream snapshot" \
    && git push -q origin HEAD ) 2>&1 | tee -a "$LOG_DIR/quarterly.log"
  log "==== quarterly refresh $v complete; GitHub deploys the version bump ===="
}

stage_all() {
  local states; states=$(resolve_states "$@")
  local v; v=$(date -u +%Y-%m)
  assert_version_not_loaded "$v"
  write_version "$v"
  log "==== refresh.sh all v=$v states=$states ===="
  stage_setup
  stage_fetch     $states
  stage_tiles     $states
  stage_addresses $states
  # L1 overlay only makes sense for the full national set; per-state runs
  # don't have enough coverage to produce a useful highway graph.
  if [[ $# -eq 0 ]]; then
    stage_overlay
  fi
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
  bootstrap)  stage_bootstrap ;;
  fetch)      stage_fetch "$@" ;;
  oa-attribution) stage_oa_attribution ;;
  tiles)      stage_tiles "$@" ;;
  overlay)    stage_overlay ;;
  addresses)  stage_addresses "$@" ;;
  upload-r2)  stage_upload_r2 ;;
  load-d1)    stage_load_d1 "$@" ;;
  publish)    stage_publish ;;
  all)        stage_all "$@" ;;
  quarterly)  stage_quarterly "$@" ;;
  states)     all_states ;;
  help|-h|--help|"")
    sed -n '4,34p' "$0"
    ;;
  *) die "unknown command: $cmd (try: $0 help)" ;;
esac
