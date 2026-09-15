# Changelog

## Unreleased

- **`refresh.sh quarterly` — the one-command refresh.** Run once per quarter
  on the 2nd of March, June, September and December (the day after Cloudflare
  billing renews); roads, TIGER segments and addresses share that single run.
  Without `--yes` it detects upstream changes, fetches only what moved (NAD,
  changed OpenAddresses sources, a new TIGER vintage, fresh OSM extracts),
  builds the version and prints the `etl.sync_d1` dry-run plan; with `--yes`
  it uploads tiles + overlay to R2, applies the D1 delta (`--only both`, cap
  `--max-rows`, default 48M), bumps `GEO_VERSION` (and `DATA_VERSION` when
  roads were rebuilt), publishes the KV manifest, updates the upstream
  snapshot and commits + pushes. Flags: `--version`, `--skip-roads`,
  `--plan-only`, `-- <sync_d1 args>` (e.g. `--allow-rebuild ST`,
  `--allow-shrink ST`). `sync_d1` falls back to cached CSV keys when a
  previous version's CSV has been deleted.
- **Centroid-only queries now return `NOT_FOUND`.** A query without a house
  number (`Austin, TX`, `78701`, `Main St, Austin, TX`) used to full-text match
  whichever address shared its tokens and come back as a confident `rooftop`
  point. The geocoder now requires a leading house number, as the contract
  always said; site demos and doc examples use real street addresses.
- **Mid-length routes go to the L1 overlay.** Pairs above 500 km (was 1,000;
  `L0_MAX_KM` var) skip the tiled A*, and the tiled search has an 8 s deadline
  so it hands off instead of exceeding the Worker CPU limit (Boston→DC,
  Detroit→DC). `data_version` now reports the address build; new additive
  `roads_version` reports the tile build.
- **Delta data refresh (no more DROP+reload).** Quarterly refreshes now apply a
  row-level delta per shard with `etl.sync_d1`: read every shard back into a
  local mirror once (`etl.export_d1_mirror`, rows read only), diff the new CSVs
  against that mirror, `INSERT OR IGNORE` new rows with explicit ids (per-quarter
  id block, all < 2^53) and `DELETE` vanished rows by id through new FTS5
  delete/update triggers. Resumable checkpoints, Time Travel bookmark per shard,
  mirror-based count verification, and hard gates (key-correctness, 50% churn,
  `--max-rows`). Measured on a scratch D1 database: 2 rows written per address
  insert or delete, FTS5 shadow rows not metered, identical-statement replays
  free, `DROP TABLE` free, multi-statement requests atomic. A full reload is
  ~510M rows (~$460); a typical delta fits inside the 50M/month included rows.
- **Legacy loaders guarded.** `etl.load_d1_parallel` / `etl.load_d1_segments`
  refuse to run against any shard listed in `state/fingerprints.json` unless
  `--i-know-this-drops-a-live-shard` is passed; `refresh.sh` refuses to rebuild
  into an already-loaded version and checks free disk before `addresses`.
- **`GEO_VERSION`** (new `[vars]` key) versions only the KV geocode cache key so
  an address refresh can invalidate cached lookups without re-uploading tiles;
  falls back to `DATA_VERSION`. Geocoder tie-break: equal-rank rows prefer
  `rooftop`, then lowest id.
- **Upstream change detector.** `etl.check_upstream` + weekly
  `.github/workflows/refresh.yml` compare NAD blobId, TIGER vintage/sizes,
  OpenAddresses job ids and Geofabrik md5s against `state/upstream-snapshot.json`
  and open an issue on change. The load step stays manual.
- **Pipeline repairs.** `refresh.sh addresses` passes `--states` correctly;
  NAD inner file auto-detected (`--inner auto`) and release metadata recorded;
  `fetch_tiger --vintage TGRGDB24|25|26`; `fetch_oa --changed-only` (and the
  public output URL, since the batch API dropped `s3`); `publish_manifest.sh`
  reads the real KV namespace id and no longer swallows errors; segment loader
  retries D1 error 7500. Cloudflare credentials can be pulled from Infisical via
  `scripts/cf_env_infisical.sh`.

- **Element-metered rate limits (hybrid).** The cost-bounding daily caps are now
  metered in **elements** (elements = origins × destinations) instead of raw
  requests, so they track actual serving cost. The per-second tier is unchanged
  (a request burst guard, charged 1/request). Per-IP daily: **2,500
  elements/day** (was 1,000 requests/day), env var `RL_ELEMENTS_PER_DAY`
  (falls back to legacy `RL_PER_DAY`). Global daily: **25,000 elements/day**,
  env var `GLOBAL_ELEMENTS_PER_DAY` (falls back to legacy `GLOBAL_DAILY_LIMIT`).
  The per-hour tier (`RL_PER_HOUR`) is **removed**. A `5×5` request now charges
  25 to the daily + global element budgets and 1 to the per-second burst.
  `X-RateLimit-*-Day` header values + the `429`/`503` messages now report
  element budgets. Oversize requests (`> MAX_ELEMENTS`) are rejected before any
  budget is charged.
- **Matrix cap lowered to 25 elements** (5×5) per request (was 100); over the
  cap still returns `MAX_ELEMENTS_EXCEEDED`.
- **Account-wide global daily cap**: a single `GlobalLimiter` DurableObject
  enforces a hard per-UTC-day limit on admitted requests (default 25,000, env
  var `GLOBAL_DAILY_LIMIT`, `0` disables) to keep total serving inside the free
  tier. Checked after the per-IP gate; over the cap returns HTTP `503` with
  `Retry-After` (seconds to `00:00 UTC`) and `Cache-Control: no-store`.
  Fail-open on any limiter fault.
- **Custom-solutions CTA** added to the `429`, `503`, and
  `MAX_ELEMENTS_EXCEEDED` error messages (`hello@open-distance.com`).

## 1.0 — initial public release

First public version. Everything before this commit lived in a private
repo under the working name `hhapi`.

### What's in it

- **Distance Matrix endpoint** (`GET /maps/api/distancematrix/json`) that
  returns the legacy wire format byte-compatibly, plus a few additive
  fields (`origin_matches`, `destination_matches`, `data_version`,
  `copyrights`).
- **Continental US coverage** (lower 48 + DC), single-pair and matrix
  queries up to 100 elements per request.
- **Cross-country routing** via an L1 highway-overlay DurableObject
  (NYC↔LA, Seattle↔Miami, Boston↔Houston all work).
- **Per-IP rate limiting** (defaults: 25/sec, 500/hour, 10k/day) with
  `X-RateLimit-*` and IETF draft `RateLimit-*` headers.
- **Auto-routing** between a TypeScript tile-paged A* (default) and a
  Rust → WASM Dijkstra one-to-many (short coord-only matrices). Manual
  override via `?router=wasm` or `?router=ts`.
- **`/coverage`** with both JSON (machine consumers) and HTML (humans)
  via Accept-header content negotiation. The HTML view embeds the
  7-provider accuracy panel against our 44 calibration routes.
- **`/healthz`**, **`/docs`**, **`/privacy`**, **`/attribution`**, and
  **`/llms.txt`** for the obvious cases.

### Data

- Roads: OpenStreetMap (Geofabrik per-state PBFs), ODbL 1.0.
- Addresses: US DOT NAD (rooftop), OpenAddresses (rooftop, per-source
  attribution), OSM `addr:*` nodes (interpolated tier).
- Interpolation fallback: US Census TIGER/Line 2024 street segments.

### Operation

- Hosted at <https://open-distance.com>; runs for less than $10/month
  on Cloudflare for the maintainer's traffic profile (D1 storage
  dominates; expect that line to grow with query volume).
- Refresh pipeline (`./refresh.sh all`) is idempotent and resumable;
  typical cadence is quarterly to pick up upstream address updates.
- Source under Apache 2.0; see `LICENSE`. Data attribution travels with
  every response via the `copyrights` field.

### Known scope

- Driving only (no walking / cycling / transit).
- No live traffic (free-flow time estimates).
- No route geometry, no turn-by-turn (this is a distance/duration API,
  not a routing engine — use OSRM or Valhalla if you need those).
- Continental US only (no AK/HI, no international).

### Acknowledgments

Built on the shoulders of OpenStreetMap, the OpenAddresses contributors,
the US DOT NAD team, the US Census TIGER project, and the gazillion
small libraries listed in `package-lock.json`. The routing math is the
same well-known weighted A* + Dijkstra one-to-many that OSRM, Valhalla,
and friends use — this project's contribution is the operational shape
(edge isolates, tiled binaries, per-state shards) and the wire-format
compatibility.
