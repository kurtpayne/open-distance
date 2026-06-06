# hhapi

Serverless distance/duration API on Cloudflare's edge, response-compatible with
Google's legacy Distance Matrix API.

- Hostname: `https://hhapi.propspress.com`
- Auth: `key=` query param (Google-style)
- Coverage: continental US (lower 48 + DC)
- Endpoint: `GET /maps/api/distancematrix/json`

## Architecture (v2, tiled)

```
   Cloudflare R2  ─ tiles/<version>/<tx>_<ty>.bin    (0.25° L0 graph tiles)
                    ~9 GB across ~13,650 tiles for US-48

   Cloudflare D1  ─ 49 per-state shards (hhapi-geo-<state>)
                    address rows (NAD + OpenAddresses + OSM, FTS5 indexed)
                    plus TIGER street segments for interpolation fallback

   Cloudflare KV  ─ manifest, leg cache, geocode cache

   Worker (TS)    ─ geocode → multi-candidate snap → tiled Dijkstra → JSON
```

## Endpoint contract

```
GET /maps/api/distancematrix/json
    ?origins=<A>|<B>|...           # each: "lat,lng" OR address string
    &destinations=<C>|<D>|...
    &units=imperial|metric          # default imperial
    &mode=driving                   # only driving supported
    &key=<API_KEY>                  # required; Google-style auth
```

Response is byte-compatible with Google's Distance Matrix JSON, plus two
extra arrays surfacing geocode confidence:

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

## Documented deviations from Google

- `key=` is validated against our own secret, not a Google API key.
- Numbers come from our routed graph (no live traffic), so they differ from
  Google's results.
- Response omits `fare`, `duration_in_traffic`, `geocoded_waypoints`,
  `copyrights`, `warnings`.
- Response adds `origin_matches` / `destination_matches` (additive — old
  Google clients ignore unknown fields).
- `place_id:` inputs return `NOT_FOUND`.
- Only supports `mode=driving` (any other mode is treated as driving).
- Max 100 elements (origins × destinations) per request.
- Addresses whose geocode tier is only `centroid` (ZIP/city centroid, often
  miles off) return `NOT_FOUND` instead of a confidently-wrong distance.
- Long cross-country routes (e.g. SF↔LA, NYC↔Boston) may return
  `ZERO_RESULTS` — plain Dijkstra hits a 2M-node settled cap. Commute-distance
  routes (<200 mi) work. A* / L1 highway overlay is the next perf step.

## Populating data from a clean clone

Everything is driven by `./refresh.sh` (see `refresh.sh help`). The `data/`
directory is `.gitignore`-d — nothing in the repo, populated on demand by
the script.

Preconditions (one-time on the machine):

```
brew install osmium-tool
npm install
# Cloudflare auth: token in ~/skillscan-family/.env as CLOUDFLARE_API_KEY,
#                  or export CLOUDFLARE_API_TOKEN
# Worker API key:  export HHAPI_API_KEY=hhapi_…
```

Then:

```
./refresh.sh bootstrap   # one-time: R2 bucket, KV ns, 49 D1 shards, secret
./refresh.sh all         # everything: fetch → build → upload → load → publish
```

Individual stages (resumable, idempotent):

| Stage | What it does |
|---|---|
| `setup`     | Create Python venv, install osmium/numpy/requests/aiohttp/fiona |
| `bootstrap` | Provision CF resources, append shard bindings, set `API_KEY` secret |
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

Merge precedence in `etl/v2/merge_addresses.py`: NAD > OA > OSM, deduped by
`(normalized, ~10 m geographic bucket)`.

In addition, the per-state shard has a `segments` table from **Census TIGER
2024 per-state edges-geodatabase** (`tlgdb_2024_a_<fips>_<lc>_edges.gdb.zip`).
The `All_Lines` layer has TLID + FULLNAME + LFROMADD/LTOADD + RFROMADD/RTOADD
+ ZIPL/ZIPR + segment geometry pre-joined. When the addresses table misses,
the Worker parses `<num> <street>` from the query and interpolates a position
along the matching segment by house-number range. Returned as `interpolated`.

## Worker internals

- `src/v2/state_parser.ts`: parse state code from query (USPS 2-letter / state name / ZIP-3 prefix lookup).
- `src/v2/geocode.ts`: sharded D1 lookup → falls back to TIGER segment interpolation when addresses miss.
- `src/v2/interpolate.ts`: TIGER segment query + linear interpolation.
- `src/v2/tiles.ts`: tile binary loader + isolate-global LRU + R2 fetch.
  Snap returns top-K nearest road nodes with ≥200 m separation so the next
  candidate can save the request when the first is on an isolated graph
  fragment (private campus roads like `1 Hacker Way`).
- `src/v2/router.ts`: tiled one-to-many Dijkstra over destination *groups*
  (any candidate of each destination satisfies that destination). Settles at
  2M nodes max, returns `ZERO_RESULTS` if cap hit.
- `src/v2/distancematrix.ts`: top-level handler. Leg cache in KV under
  `leg2:` (src node → top-1 dest node → time+meters).
- Geocode cache prefix `geo4:` in KV — bumped historically when normalizer
  semantics changed. NOT_FOUND results are intentionally not cached.

## Layout

```
src/
  index.ts            top-level routing
  auth.ts             key= validation
  format.ts           "5.4 mi" / "11 mins" helpers
  geocode.ts (v1)     legacy single-DB FTS5 lookup (kept for reference)
  graph.ts   (v1)     legacy monolithic CSR graph
  v2/
    state_parser.ts   parse state code from query
    geocode.ts        sharded geocoder (per-state D1) + TIGER fallback
    interpolate.ts    TIGER segment lookup + linear interpolation
    tiles.ts          tile binary loader + LRU + R2 fetch + multi-candidate snap
    router.ts         tiled lazy-fetch one-to-many Dijkstra (destination groups)
    distancematrix.ts Google-shaped handler
etl/v2/
  states.py                 US-48 + DC catalog
  config.py                 tile grid + paths + sources
  fetch_sources.py          OSM PBF downloads (Geofabrik per-state)
  fetch_nad.py              NAD national ZIP download (US DOT)
  fetch_oa.py               OpenAddresses per-source downloads
  fetch_tiger.py            TIGER per-state edges-geodatabase downloads
  build_tiles.py            OSM → per-tile CSR binaries
  build_nad_addresses.py    NAD CSV → per-state .nad.csv
  build_oa_addresses.py     OA GeoJSON.gz → per-state .oa.csv
  build_addresses.py        OSM addr-tagged nodes → per-state .osm.csv
  merge_addresses.py        NAD + OA + OSM → per-state .csv
  build_tiger_segments.py   TIGER GDB → per-state segments.csv (via fiona)
  upload_tiles_parallel.sh  parallel R2 upload (xargs -P, fail-log + retry)
  load_d1_parallel.py       parallel D1 HTTP API loader (addresses) with backoff
  load_d1_segments.py       parallel D1 loader (segments)
  publish_manifest.sh       write manifest to KV
scripts/
  provision.sh              R2 + legacy D1 + KV (one-time)
  provision_d1_shards.sh    49 per-state D1 shards (one-time)
  acceptance.sh             v1 acceptance (Bay Area)
  acceptance_us.sh          US-wide acceptance (cross-region + addresses)
refresh.sh                  master pipeline
wrangler.toml               Worker config + 50 D1 bindings + custom domain
```

This repo is private. Secrets live in Worker secrets (`API_KEY`), never in
the repo. The `data/` directory is gitignored and populated on demand by
`refresh.sh`.
