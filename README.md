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
                    9.2 GB across ~13,650 tiles for US-48

   Cloudflare D1  ─ 49 per-state shards (hhapi-geo-<state>)
                    address rows (NAD + OpenAddresses + OSM), FTS5 indexed

   Cloudflare KV  ─ manifest, leg cache, geocode cache

   Worker (TS)    ─ snap → tiled bidirectional Dijkstra → leg cache → JSON
```

## Documented deviations from Google

- `key=` is validated against our own secret, not a Google API key.
- Numbers come from our routed graph (no live traffic), so they differ from
  Google's results.
- Response omits `fare`, `duration_in_traffic`, `geocoded_waypoints`,
  `copyrights`, `warnings`.
- `place_id:` inputs return `NOT_FOUND`.
- Only supports `mode=driving` (any other mode is treated as driving).
- Max 100 elements (origins × destinations) per request.
- Addresses whose geocode tier is only `centroid` (ZIP/city centroid, often
  miles off) return `NOT_FOUND` instead of a confidently-wrong distance.

## Populating data from a clean clone

Everything below is driven by `./refresh.sh` (see `refresh.sh help`). The
`data/` directory is `.gitignore`-d — nothing in the repo, populated on demand
by the script.

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
| `setup` | Create Python venv, install osmium/numpy/requests/aiohttp |
| `bootstrap` | Provision CF resources, append shard bindings, set `API_KEY` secret |
| `fetch` | OSM PBFs (Geofabrik per-state) + NAD national ZIP + OA per-source |
| `tiles` | Build per-tile CSR binaries from OSM (each tile is 0.25° lat/lon) |
| `addresses` | NAD → `.nad.csv`, OA → `.oa.csv`, OSM → `.osm.csv`, merge → `.csv` |
| `upload-r2` | Push tile binaries to R2 (parallel) |
| `load-d1` | Push merged per-state CSVs to D1 shards (parallel HTTP) |
| `publish` | Write manifest JSON to KV under `manifest:active` |

Per-stage state can be restricted: `./refresh.sh tiles CA NY TX` or
`./refresh.sh load-d1 IL OH`.

## Address sources (in merge precedence order)

1. **NAD** — US DOT National Address Database (public domain). Federal rooftop
   points. Uneven state coverage (MS has 3 rows; CA mostly Orange County). Tier
   `rooftop`.
2. **OpenAddresses** — `batch.openaddresses.io`, per-county / per-source.
   ~140M US points. Per-source attribution required if redistributing the data
   (operating an API on top of it is fine). Tier `rooftop`.
3. **OSM `addr:*` nodes** — falls back to OSM addr-tagged points from
   Geofabrik. Tier `interpolated`.
4. Centroid (ZIP / city only) — *never returned*; the geocoder rejects to
   `NOT_FOUND` rather than confidently guess.

## Layout

```
src/
  index.ts            top-level routing
  auth.ts             key= validation
  format.ts           "5.4 mi" / "11 mins" helpers
  geocode.ts (v1)     legacy single-DB FTS5 lookup
  graph.ts (v1)       legacy monolithic CSR graph
  v2/
    state_parser.ts   parse state from query (USPS / name / ZIP-prefix)
    geocode.ts        sharded geocoder (per-state D1)
    tiles.ts          tile binary loader + LRU + R2 fetch
    router.ts         tiled lazy-fetch one-to-many Dijkstra
    distancematrix.ts Google-shaped handler
etl/
  v2/
    states.py            US-48 + DC catalog
    config.py            tile grid + paths + sources
    fetch_sources.py     OSM PBF downloads
    fetch_nad.py         NAD national ZIP download
    fetch_oa.py          OpenAddresses per-source downloads
    build_tiles.py       OSM → per-tile CSR binaries
    build_nad_addresses.py    NAD CSV → per-state .nad.csv
    build_oa_addresses.py     OA GeoJSON.gz → per-state .oa.csv
    build_addresses.py        OSM PBF → per-state .osm.csv
    merge_addresses.py        NAD + OA + OSM → per-state .csv
    upload_tiles_parallel.sh  parallel R2 upload (xargs -P 16)
    load_d1_parallel.py       parallel D1 HTTP API loader
    publish_manifest.sh       write manifest to KV
scripts/
  provision.sh              R2 + legacy D1 + KV (one-time)
  provision_d1_shards.sh    49 per-state D1 shards (one-time)
  acceptance.sh             v1 acceptance (Bay Area)
  acceptance_us.sh          US-wide acceptance (cross-region routes)
refresh.sh                  master pipeline
wrangler.toml               Worker config + bindings
```

This repo is private. Secrets live in Worker secrets (`API_KEY`), never in the
repo. The `data/` directory is gitignored and populated on demand by
`refresh.sh`.
