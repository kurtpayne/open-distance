[![CI](https://github.com/kurtpayne/open-distance/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kurtpayne/open-distance/actions/workflows/ci.yml)
[![Deploy](https://github.com/kurtpayne/open-distance/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/kurtpayne/open-distance/actions/workflows/deploy.yml)
[![Acceptance](https://github.com/kurtpayne/open-distance/actions/workflows/acceptance.yml/badge.svg?branch=main)](https://github.com/kurtpayne/open-distance/actions/workflows/acceptance.yml)
[![Better Stack Badge](https://uptime.betterstack.com/status-badges/v2/monitor/2ofwd.svg)](https://uptime.betterstack.com/?utm_source=status_badge)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

# open-distance

A serverless distance/duration API on Cloudflare's edge, response-compatible
with the legacy Distance Matrix JSON wire format. Built as a cheap,
fork-and-deploy alternative to commercial mapping APIs — runs for
**less than $10/month** on Cloudflare for the entire continental US.

Live at **https://open-distance.com**.

[License: Apache 2.0](LICENSE) · [Data attribution: NOTICE](NOTICE) ·
[Contributing](CONTRIBUTING.md)

- Hostname: `https://open-distance.com`
- Auth: none — public endpoint, rate-limited per IP (KV-backed)
- Coverage: continental US (lower 48 + DC)
- Endpoints:
  - `GET /maps/api/distancematrix/json` — the main API (legacy Distance Matrix JSON shape)
  - `GET /healthz` — liveness + sentinel-tile probe
  - `GET /coverage` — version, sources, supported `match` values, deviations

> **Provided as-is, no warranty.** Built from public open data; no live
> traffic; coverage and accuracy vary. If your application is safety- or
> contract-critical (emergency dispatch, regulated SLAs, legal billing), use
> a commercial API. The Apache 2.0 [LICENSE](LICENSE) disclaims all warranties
> — express and implied. The hosted instance at open-distance.com is a free
> shared resource and can change, slow down, or go offline without notice.

## How this compares to OSRM, Valhalla, and commercial APIs

`open-distance` is not a routing engine — it's a distance-matrix endpoint
built on Cloudflare's edge (no server to run). OSRM and Valhalla are mature
routing engines with much broader feature sets; if you need route geometry,
turn-by-turn, isochrones, or live traffic, use one of them.

|                       | [OSRM](https://project-osrm.org/) | [Valhalla](https://valhalla.github.io/valhalla/) | open-distance | Commercial |
|-----------------------|------|----------|---------------|------------|
| Deploy model          | Self-host server (VM) | Self-host server (VM) | Cloudflare Worker (edge) | SaaS |
| Cost (continental US) | Self-host hardware | Self-host hardware | **<$10/mo Cloudflare** (storage + low traffic) | Per-call ($) |
| Cold start            | Minutes (load graph) | Seconds (tile lazy-load) | ~30 ms isolate | n/a |
| Raw routing speed     | Best-in-class (CH) | Good (tiled) | Good (sub-ms Rust inner loop; L1 highway overlay for long-haul) | Fast |
| Route geometry        | Yes | Yes | **No** (scalar distance + duration) | Yes |
| Turn-by-turn          | Yes | Yes | No | Yes |
| Live traffic          | No  | Plugin | No | Yes |
| Geocoder included     | BYO (Nominatim) | BYO | **Yes** (NAD + OpenAddresses + OSM + TIGER) | Yes |
| API wire format       | OSRM JSON | Valhalla JSON | **Distance Matrix JSON** (legacy shape) | (varies) |
| License               | BSD-2 | MIT | Apache 2.0 | Proprietary |

Valhalla's tiled hierarchical architecture is the closest analog to the design
that runs here. The differences are scope (we only do distance/duration
matrices) and operations (Worker isolates instead of dedicated servers). The
"first layer" pattern works equally well with any of these as the fallback:
hit `open-distance` first, cache the answer, escalate to a premium engine
only for queries that actually need its premium features.

## Architecture

```
   Cloudflare R2  ─ tiles/<version>/<tx>_<ty>.bin    (0.25° L0 graph tiles)
                    ~9 GB across ~13,650 tiles for US-48

   Cloudflare D1  ─ 49 per-state shards (od-geo-<state>)
                    address rows (NAD + OpenAddresses + OSM, FTS5 indexed)
                    plus TIGER street segments for interpolation fallback

   Cloudflare KV  ─ manifest, leg cache, geocode cache

   Worker         ─ geocode → multi-candidate snap → tiled Dijkstra → JSON.
                    Two routers: Rust → WASM (rust-router/, ~56 KB) for
                    short-bbox lat/lng queries where its sub-ms inner loop
                    dominates; TypeScript weighted A* for everything else.
                    Per-query dispatch; ?router=wasm or ?router=ts overrides.
```

## Endpoint contract

```
GET /maps/api/distancematrix/json
    ?origins=<A>|<B>|...           # each: "lat,lng" OR address string
    &destinations=<C>|<D>|...
    &units=imperial|metric          # default imperial
    &mode=driving                   # only driving supported
    &router=wasm|ts                 # optional; override the auto-dispatch
                                    # (default: per-query, see /docs)
```

Response is byte-compatible with the legacy Distance Matrix JSON wire
format, plus two extra arrays surfacing geocode confidence:

```json
{
  "origin_addresses":      ["…canonical or raw input strings…"],
  "origin_matches":        ["rooftop" | "interpolated" | "coords" | ""],
  "destination_addresses": ["…"],
  "destination_matches":   ["rooftop" | "interpolated" | "coords" | ""],
  "rows": [
    { "elements": [
      { "status": "OK" | "NOT_FOUND" | "ZERO_RESULTS",
        "distance": { "text": "5.4 mi", "value": 8690 },
        "duration": { "text": "11 mins", "value": 660 } }
    ] }
  ],
  "status": "OK" | "INVALID_REQUEST" | "MAX_ELEMENTS_EXCEEDED" | "REQUEST_DENIED"
}
```

`*_matches` values:

| Value          | Meaning                                                            |
|----------------|---------------------------------------------------------------------|
| `rooftop`      | exact mapped point — NAD or OpenAddresses rooftop dataset           |
| `interpolated` | estimated point — OSM `addr:*` node or TIGER segment interpolation (likely off by ~30–100 m) |
| `coords`       | caller supplied `lat,lng` directly; no geocode performed            |
| `""`           | geocode failed; address shows as raw input                          |

## Documented deviations from the legacy API

- No `key=` required. The public endpoint is rate-limited per IP (KV-backed,
  default 25/sec, 500/hour, 10k/day). Self-hosters can change limits via env
  vars or disable rate limiting entirely.
- Numbers come from our routed graph (no live traffic), so they differ from
  any traffic-aware provider.
- Response omits `fare`, `duration_in_traffic`, `geocoded_waypoints`,
  `warnings`. The `copyrights` field IS populated (with the ODbL §4.3
  Produced Work notice + a pointer to `/attribution`) so that attribution
  travels with every response.
- Response adds `origin_matches` / `destination_matches`, `copyrights`,
  and `data_version` (`"YYYY-MM"` of the upstream data build, refreshed
  quarterly). All additive — old clients ignore unknown fields.
- `place_id:` inputs return `NOT_FOUND`.
- Only supports `mode=driving` (any other mode is treated as driving).
- Max 100 elements (origins × destinations) per request.
- Addresses whose geocode tier is only `centroid` (ZIP/city centroid, often
  miles off) return `NOT_FOUND` instead of a confidently-wrong distance.
- Cross-region routes (SF↔LA, NYC↔Boston, Atlanta↔Miami) work via weighted A*
  (k=1.5 heuristic over haversine / 30 m/s). Cross-country routes (NYC↔LA,
  Seattle↔Miami, Boston↔Houston) route through a national highway overlay
  (an `L1Router` DurableObject) for sub-second warm responses.
- Fully-successful Distance Matrix responses send
  `Cache-Control: public, max-age=3600` — identical queries are absorbed by
  Cloudflare's edge cache. Responses with any `NOT_FOUND` / `ZERO_RESULTS`
  element are returned with `Cache-Control: no-store` so a subsequent data
  refresh can deliver the recovery cleanly.

## Rate limits and response headers

Per-IP rate limits on the hosted deployment:

| Window  | Limit  | Env var       |
|---------|--------|---------------|
| Second  | 25     | `RL_PER_SEC`  |
| Hour    | 500    | `RL_PER_HOUR` |
| Day     | 10,000 | `RL_PER_DAY`  |

**There is no paid tier.** The hosted instance is a free shared resource for
casual use. If you need higher limits, self-host on your own Cloudflare
account and tune the env vars above. Set any of them to `0` to disable that
tier; set all three to `0` for an unlimited deployment (e.g. private fork
inside a trusted network).

Every API response — both `200` success and `429` rate-limited — carries
headers so callers can self-throttle without an extra probe:

| Header                            | Meaning                                    |
|-----------------------------------|--------------------------------------------|
| `X-RateLimit-Limit-Second`        | Configured per-second limit                |
| `X-RateLimit-Remaining-Second`    | Requests left in the current 1-s window    |
| `X-RateLimit-Reset-Second`        | Seconds until that window rolls (always 1) |
| `X-RateLimit-Limit-Hour`          | Configured per-hour limit                  |
| `X-RateLimit-Remaining-Hour`      | Requests left in the current hour bucket   |
| `X-RateLimit-Reset-Hour`          | Seconds until the hour bucket rolls        |
| `X-RateLimit-Limit-Day`           | Configured per-day limit                   |
| `X-RateLimit-Remaining-Day`       | Requests left in the current day bucket    |
| `X-RateLimit-Reset-Day`           | Seconds until the day bucket rolls         |
| `RateLimit-Limit`                 | [IETF draft][rl-draft]: tightest tier's limit |
| `RateLimit-Remaining`             | Remaining of the tightest tier             |
| `RateLimit-Reset`                 | Seconds until the tightest tier resets     |

[rl-draft]: https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/

When a tier overflows, the API returns HTTP `429` with
`"status":"OVER_QUERY_LIMIT"`, a `Retry-After` header, and
`X-RateLimit-Tier = sec | hour | day` indicating which bucket overflowed.

## Populating data from a clean clone

Everything is driven by `./refresh.sh` (see `refresh.sh help`). The `data/`
directory is `.gitignore`-d — nothing in the repo, populated on demand by
the script.

Preconditions (one-time on the machine):

```
brew install osmium-tool
npm install
# Cloudflare auth: copy .env.example to .env and fill in the values,
#                  or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID directly
# No API key required -- the public endpoint is rate-limited per IP.
```

Then:

```
cp .env.example .env             # then edit .env with your CF token, account, hostname
./refresh.sh bootstrap            # one-time: R2 bucket, KV ns, 49 D1 shards
scripts/materialize_wrangler.sh   # substitutes IDs into wrangler.toml from the template
./refresh.sh all                  # everything: fetch → build → upload → load → publish
```

The first `./refresh.sh all` is long — several hours of downloads (~50 GB
of source data) plus several hours of build CPU. Subsequent refreshes are
similar; monthly is a reasonable cadence to pick up address updates from
upstream sources.
You can also restrict to a single state for development: `./refresh.sh all CA`.

Individual stages (resumable, idempotent):

| Stage | What it does |
|---|---|
| `setup`     | Create Python venv, install osmium/numpy/requests/aiohttp/fiona |
| `bootstrap` | Provision CF resources, append shard bindings |
| `fetch`     | OSM PBFs (Geofabrik per-state) + NAD national ZIP + OA per-source + TIGER per-state edges geodatabase |
| `tiles`     | Build per-tile CSR road-graph binaries from OSM |
| `addresses` | NAD → `.nad.csv`, OA → `.oa.csv`, OSM → `.osm.csv`, merge → `.csv`, plus TIGER segments → `segments/<STATE>.csv` |
| `upload-r2` | Push tile binaries to R2 (parallel xargs; failures auto-retried) |
| `load-d1`   | Push merged address CSVs + TIGER segments to D1 shards (parallel HTTP, with 971/7429 backoff) |
| `publish`   | Write manifest JSON to KV under `manifest:active` |

Per-stage state can be restricted: `./refresh.sh tiles CA NY TX` or
`./refresh.sh load-d1 IL OH`.

## Address + street data sources

Stored in the per-state shard's `addresses` table (FTS5 indexed via AFTER
INSERT trigger so the index builds incrementally — full `rebuild` would blow
past D1's per-query CPU cap on big states).

| Source | Tier | Volume | Notes |
|---|---|---|---|
| **NAD** (US DOT National Address Database) | `rooftop` | ~80M | Public domain. Uneven state coverage (MS = 3 rows; FL = 42k). |
| **OpenAddresses** (`batch.openaddresses.io`) | `rooftop` | ~171M | Per-county/city authority points. Per-source attribution required if redistributing the data itself; operating an API on top is fine. |
| **OSM `addr:*` nodes** | `interpolated` | ~10M | Geofabrik per-state PBFs. |
| **Centroid** (ZIP / city only) | — | — | Never returned; the geocoder rejects to `NOT_FOUND`. |

Merge precedence in `etl/merge_addresses.py`: NAD > OA > OSM, deduped by
`(normalized, ~10 m geographic bucket)`.

In addition, the per-state shard has a `segments` table from **Census TIGER
2024 per-state edges-geodatabase** (`tlgdb_2024_a_<fips>_<lc>_edges.gdb.zip`).
The `All_Lines` layer has TLID + FULLNAME + LFROMADD/LTOADD + RFROMADD/RTOADD
+ ZIPL/ZIPR + segment geometry pre-joined. When the addresses table misses,
the Worker parses `<num> <street>` from the query and interpolates a position
along the matching segment by house-number range. Returned as `interpolated`.

## Worker internals

- `src/state_parser.ts`: parse state code from query (USPS 2-letter / state name / ZIP-3 prefix lookup).
- `src/geocode.ts`: sharded D1 lookup → falls back to TIGER segment interpolation when addresses miss.
- `src/interpolate.ts`: TIGER segment query + linear interpolation.
- `src/tiles.ts`: tile binary loader + isolate-global LRU + R2 fetch.
  Snap returns top-K nearest road nodes with ≥200 m separation so the next
  candidate can save the request when the first is on an isolated graph
  fragment (private campus roads like `1 Hacker Way`).
- `src/router.ts`: tiled one-to-many **weighted A\*** over destination
  *groups* (any candidate of each destination satisfies that destination).
  Heap key `f = g + 1.5 × (haversine_to_nearest_unsatisfied_dest / 30 m/s)`.
  Slightly inadmissible — paths may be up to ~50% non-optimal in theory,
  empirically within minutes-level accuracy for cross-region. Settles at 2M
  nodes max → `ZERO_RESULTS` if cap hit.
- `src/distancematrix.ts`: top-level handler. Leg cache in KV under
  `leg2:` (src node → top-1 dest node → time+meters).
- Geocode cache prefix `geo4:` in KV — bumped historically when normalizer
  semantics changed. NOT_FOUND results are intentionally not cached.

## Layout

```
src/
  index.ts               top-level Worker dispatch
  distancematrix.ts      legacy-shape DM handler + tryWasmMatrix (Rust path)
  geocode.ts             per-state D1 sharded geocoder + TIGER fallback
  interpolate.ts         TIGER segment lookup + linear interpolation
  normalize.ts           address normalizer
  ratelimit.ts           KV-backed per-IP rate limiter (GDPR-clean: hashed IP)
  router.ts              tiled lazy-fetch one-to-many Dijkstra (TS fallback)
  site.ts                landing / docs / privacy / attribution HTML
  state_parser.ts        parse state code from query
  tiles.ts               tile binary loader + decoded LRU + bytes LRU + R2 fetch
  format.ts              "5.4 mi" / "11 mins" helpers
  wasm_router.ts         TS adapter for the Rust router

rust-router/             Rust crate compiled to WASM
  src/lib.rs             TileView decode, multi-tile A*, one-to-many Dijkstra
  target/.../*.wasm      compiled artifact, committed (CI has no Rust toolchain)
  Cargo.toml

etl/
  states.py                 US-48 + DC catalog
  config.py                 tile grid + paths + sources
  fetch_*.py                source downloads (OSM PBF / NAD / OA / TIGER)
  build_tiles.py            OSM → per-tile CSR binaries
  build_*_addresses.py      NAD / OA / OSM → per-state .csv
  merge_addresses.py        NAD + OA + OSM → per-state .csv
  build_tiger_segments.py   TIGER GDB → per-state segments.csv
  build_overlay.py          OSM → L1 highway overlay binary
  upload_tiles_parallel.sh  parallel R2 upload with fail-log + retry
  load_d1_parallel.py       parallel D1 HTTP API loader (addresses)
  load_d1_segments.py       parallel D1 loader (segments)
  publish_manifest.sh       write manifest + OA attribution to KV

scripts/
  provision.sh              R2 + legacy D1 + KV (one-time bootstrap)
  provision_d1_shards.sh    49 per-state D1 shards (one-time bootstrap)
  materialize_wrangler.sh   substitute account/resource IDs into wrangler.toml
  acceptance_us.sh          continental-US acceptance probe set
  build_wasm_router.sh      cargo build for the Rust crate
  benchmark_panel.py        multi-provider 44-route accuracy + latency benchmark

refresh.sh                  master ETL pipeline (setup → fetch → build → upload → load → publish)
wrangler.toml               Worker config + 49 per-state D1 bindings
wrangler.toml.template      fork-friendly template (substitute via materialize_wrangler.sh)
```

The `data/` directory is gitignored and populated on demand by `refresh.sh`.
