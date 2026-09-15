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
- Auth: none — public endpoint, rate-limited per IP (DurableObject-backed)
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
| Raw routing speed     | Best-in-class (CH) | Good (tiled) | Good (tiered: sub-ms Rust for small bbox, TS A* for medium, L1 highway overlay for long-haul) | Fast |
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
                    Per-query auto-dispatch; the x-od-router-impl response
                    header reports which engine answered.
```

## Endpoint contract

```
GET /maps/api/distancematrix/json
    ?origins=<A>|<B>|...           # each: "lat,lng" OR address string
    &destinations=<C>|<D>|...
    &units=imperial|metric          # default imperial
    &mode=driving                   # only driving supported
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

- No `key=` required. The public endpoint is rate-limited per IP
  (DurableObject-backed). It's a **hybrid**: a per-second request burst guard
  (default 5 req/sec) plus a per-day **element** budget (default 2,500
  elements/day per IP, where elements = origins × destinations). Self-hosters
  can change limits via env vars or disable rate limiting entirely. On top of
  the per-IP tiers there is an account-wide global daily cap (default 25,000
  elements/day, `GLOBAL_ELEMENTS_PER_DAY`); once exhausted the API returns HTTP
  `503` with `Retry-After` (seconds until `00:00 UTC`) — contact
  hello@open-distance.com for higher or dedicated limits.
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
- Max 25 elements (origins × destinations) per request.
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

## Configuration

Every operator-tunable knob is a `[vars]` entry in `wrangler.toml` (also in
`wrangler.toml.template`), read from the Worker env at request time. **To
customize a self-hosted deployment, edit `wrangler.toml [vars]` — no code
changes needed.** Cloudflare delivers these as strings; the Worker parses them.

| Var                       | Default                  | Meaning |
|---------------------------|--------------------------|---------|
| `RL_PER_SEC`              | `5`                      | Per-IP requests per second (burst guard, charged 1/request); `0` disables this tier |
| `RL_ELEMENTS_PER_DAY`     | `2500`                   | Per-IP **elements** per day (elements = origins × destinations); `0` disables. Falls back to the legacy `RL_PER_DAY` if that key is set instead (for existing deployments) |
| `GLOBAL_ELEMENTS_PER_DAY` | `25000`                  | Account-wide **elements** per UTC day; `0` disables the cap. Falls back to the legacy `GLOBAL_DAILY_LIMIT` if set instead |
| `MAX_ELEMENTS`            | `25`                     | Max `origins × destinations` elements per request (floored at 1) |
| `CONTACT_EMAIL`           | `hello@open-distance.com`| Contact address shown in rejection messages + on the site; set to `""` to omit the contact call-to-action entirely |

> **Migration note:** the daily caps are now metered in **elements** (one
> origin→destination route solve), not raw requests. The per-second tier is
> still a request burst guard. The old `RL_PER_DAY` / `GLOBAL_DAILY_LIMIT` keys
> are still read as fallbacks so existing forks keep working, but you should
> switch to the element-named keys so the unit is unambiguous.

Setting both `RL_PER_SEC` and `RL_ELEMENTS_PER_DAY` to `0` yields an unlimited
per-IP deployment (e.g. a private fork inside a trusted network). The rendered
site (`/`, `/docs`) and the machine-readable `/llms.txt` reflect these values at
request time, so a fork shows its own limits and contact address rather than the
upstream defaults.

## Rate limits and response headers

Hybrid per-IP rate limits on the hosted deployment — a request burst guard plus
an element cost budget (elements = origins × destinations, the
[same definition Google uses](https://developers.google.com/maps/documentation/distance-matrix/usage-and-billing)):

| Window         | Limit             | Env var                 |
|----------------|-------------------|-------------------------|
| Second (burst) | 5 requests        | `RL_PER_SEC`            |
| Day            | 2,500 elements    | `RL_ELEMENTS_PER_DAY`   |

A single `1×1` request charges 1 element to the daily budget; a `5×5` matrix
charges 25. The per-second tier always charges 1 regardless of matrix size.

**There is no paid tier.** The hosted instance is a free shared resource for
casual use. If you need higher limits, self-host on your own Cloudflare
account and tune the env vars above. Set either to `0` to disable that tier;
set both to `0` for an unlimited deployment (e.g. private fork inside a
trusted network).

Every API response — both `200` success and `429` rate-limited — carries
headers so callers can self-throttle without an extra probe:

| Header                            | Meaning                                          |
|-----------------------------------|--------------------------------------------------|
| `X-RateLimit-Limit-Second`        | Configured per-second request limit              |
| `X-RateLimit-Remaining-Second`    | Requests left in the current 1-s window          |
| `X-RateLimit-Reset-Second`        | Seconds until that window rolls (always 1)       |
| `X-RateLimit-Limit-Day`           | Configured per-day **element** budget            |
| `X-RateLimit-Remaining-Day`       | **Elements** left in the current UTC-day budget  |
| `X-RateLimit-Reset-Day`           | Seconds until the day bucket rolls               |
| `RateLimit-Limit`                 | [IETF draft][rl-draft]: tightest tier's limit    |
| `RateLimit-Remaining`             | Remaining of the tightest tier                   |
| `RateLimit-Reset`                 | Seconds until the tightest tier resets           |

[rl-draft]: https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/

The `-Day` values are **element** budgets (elements = origins × destinations),
not request counts; the `-Second` values are request counts. When a tier
overflows, the API returns HTTP `429` with `"status":"OVER_QUERY_LIMIT"`, a
`Retry-After` header, and `X-RateLimit-Tier = sec | day` indicating which
bucket overflowed.

### Global daily cap

On top of the per-IP tiers there is an account-wide hard cap on total
admitted **elements** per UTC day (default **25,000 elements/day**, env var
`GLOBAL_ELEMENTS_PER_DAY`; set to `0` to disable). Metering by elements (one
origin→destination route solve) makes the cap track actual serving cost so the
hosted instance stays inside Cloudflare's free tier. Only requests that pass
the per-IP check count toward the global budget. When the cap is hit the API
returns HTTP `503` with `"status":"OVER_QUERY_LIMIT"`, a `Retry-After` header
(seconds until the next `00:00 UTC` reset), and `Cache-Control: no-store`. Need
higher or dedicated limits? Contact hello@open-distance.com for custom
solutions.

## Populating data from a clean clone

Everything is driven by `./refresh.sh` (see `refresh.sh help`). The `data/`
directory is `.gitignore`-d — nothing in the repo, populated on demand by
the script.

Preconditions (one-time on the machine):

```
brew install osmium-tool
npm install
# Cloudflare auth: copy .env.example to .env and fill in the values,
#                  export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID directly,
#                  or `source scripts/cf_env_infisical.sh` (Infisical machine identity in ~/.env)
# No API key required -- the public endpoint is rate-limited per IP.
```

Then, **for the first load only**:

```
cp .env.example .env             # then edit .env with your CF token, account, hostname
./refresh.sh bootstrap            # one-time: R2 bucket, KV ns, 49 D1 shards
scripts/materialize_wrangler.sh   # substitutes IDs into wrangler.toml from the template
./refresh.sh all                  # everything: fetch → build → upload → load → publish
```

The first `./refresh.sh all` is long — several hours of downloads (~50 GB
of source data) plus several hours of build CPU.
You can also restrict to a single state for development: `./refresh.sh all CA`.

`refresh.sh load-d1` runs the **legacy loaders** (`etl.load_d1_parallel`,
`etl.load_d1_segments`), which `DROP` and recreate each shard's schema. They
are the cold-start path for a brand-new fork. Once a shard is recorded in
`state/fingerprints.json` (written by the delta pipeline below) they refuse
to touch it unless `--i-know-this-drops-a-live-shard` is passed; every later
load is a row-level delta (next section).

Individual stages (resumable, idempotent):

| Stage | What it does |
|---|---|
| `setup`     | Create Python venv, install osmium/numpy/requests/aiohttp/fiona |
| `bootstrap` | Provision CF resources, append shard bindings |
| `fetch`     | OSM PBFs (Geofabrik per-state) + NAD national ZIP + OA per-source + TIGER per-state edges geodatabase |
| `tiles`     | Build per-tile CSR road-graph binaries from OSM |
| `addresses` | NAD → `.nad.csv`, OA → `.oa.csv`, OSM → `.osm.csv`, merge → `.csv`, plus TIGER segments → `segments/<STATE>.csv` |
| `upload-r2` | Push tile binaries to R2 (parallel xargs; failures auto-retried) |
| `load-d1`   | **First load only.** DROP + bulk-load merged address CSVs + TIGER segments into the D1 shards (parallel HTTP, 971/7429/7500 backoff). Refuses any shard listed in `state/fingerprints.json` |
| `publish`   | Write manifest JSON to KV under `manifest:active` |

Per-stage state can be restricted: `./refresh.sh tiles CA NY TX` or
`./refresh.sh load-d1 IL OH`.

Stage guards: `tiles`, `addresses` and `all` refuse to rebuild a version
(`data/v2/version.txt`) that `state/fingerprints.json` says is already loaded
into D1 — bump the version first. `addresses` also checks free disk before
slicing the ~8 GB NAD archive (`OD_MIN_FREE_GB`, default 60).

### Quarterly refresh (delta load)

NAD changes nationally every release, so skipping whole unchanged states
saves nothing for addresses, and a full reload writes ~510M D1 rows (~$460,
see Costs). The refresh is therefore a **row-level delta** applied by
`etl.sync_d1`, which never `DROP`s a live shard. The diff is computed against
a local **mirror** of what D1 actually holds, not against last quarter's CSVs
(the first load reassigned ids under AUTOINCREMENT). Long-form runbook —
source decisions, credentials, resume/rollback, the metering probes:
[docs/refresh-quarterly.md](docs/refresh-quarterly.md).

**Detect (automatic, weekly).** `.github/workflows/refresh.yml` runs
`python3 -m etl.check_upstream` against `state/upstream-snapshot.json`
(NAD Socrata `blobId`, TIGER vintage + per-state size, OA per-source job ids,
Geofabrik md5s — no bulk downloads) and opens or comments on a
"Quarterly refresh" issue when something changed. The load stays manual.

**Load (manual, from the maintainer's Mac).** From the repo root with the
venv active. D1 billing renews on the 1st; start national runs on the 2nd.

```bash
source scripts/cf_env_infisical.sh                   # CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (forks: .env)
echo 2026-09 > data/v2/version.txt                   # new version (stage guards refuse an already-loaded one)

# 1. fetch only what changed (refresh.sh fetch does not pass these flags)
python3 -m etl.fetch_nad                              # national ZIP; move the old archive aside first
python3 -m etl.fetch_oa --changed-only                # only sources whose OA job/size changed
python3 -m etl.fetch_tiger --vintage TGRGDB26         # only if reloading segments this quarter
                                                      # OSM: frozen unless tiles are rebuilt

# 2. build per-state CSVs (no tiles/overlay/upload-r2 unless OSM changed)
./refresh.sh addresses

# 3. mirror every shard once (rows read only, ~$0.26 nationally; resumable)
python3 -m etl.export_d1_mirror                       # [--kind addresses|segments|both] [--states ..] [--fresh]
python3 -m etl.seed_fingerprints --version 2026-06    # once: record what legacy-loaded shards hold

# 4. plan: diff CSVs vs mirror, run the gates, forecast rows written
python3 -m etl.sync_d1 --version 2026-09 --dry-run   # [--states DC WY] [--only addresses|segments|both]

# 5. apply: smallest shard first, resumable per-state checkpoints
python3 -m etl.sync_d1 --version 2026-09 --yes --max-rows 48000000

# 6. after the last delete: bump GEO_VERSION in wrangler.toml(.template), commit, deploy via GitHub
```

What `sync_d1` does per shard and table: takes a Time Travel bookmark
(`wrangler d1 time-travel info`, 30-day rollback window), installs the FTS5
delete/update triggers, `INSERT OR IGNORE`s the new rows with **explicit ids**
(a per-quarter block of `2^40 × quarter_index`, all `< 2^53`), then `DELETE`s
vanished ids by primary key, verifies the row count against
`mirror − deletes + inserts`, and only then updates the mirror and
`state/fingerprints.json`. Every statement is idempotent, so a lost response
is re-sent and a crashed run resumes from `data/v2/state/checkpoints/`.

Gates (not overridable by `--yes`):

| Gate | Refuses when |
|---|---|
| key-correctness | fewer than 95% of the previous version's CSV keys are found in the mirror (the diff key is wrong; expected 1.0) |
| churn | `(inserts + deletes) / mirror rows ≥ 50%` for a state — a rebuild is cheaper — unless `--allow-rebuild ST` |
| budget | forecast total `> --max-rows`; during apply, actual rows written `> --max-rows` or `> 1.5×` forecast so far |
| ids | the new id block does not exceed every id already in the shard |

`--dry-run` prints the per-state plan (mirror rows, ins, del, churn, key
ratio, sub-metre jitter share, forecast) and the estimated dollars above a
fresh 50M allowance; nothing is written. `--only` defaults to `addresses` —
pass `--only both` to include segments.

## Costs

**Total cost of ownership — expensive once, then cheap for years:**

| Phase | Cost | Covers |
|---|---|---|
| **Setup** (one-time) | **~$460–500** | The full continental-US data load into D1 (write-heavy — this is the nasty part). The June 2026 load cost about $500. |
| **Maintenance** | **~$0 in D1 writes** for a typical quarter | A row-level delta at a few percent churn fits inside the 50M rows/month D1 includes; a TIGER segments reload (~68M rows) is the exception and is a separate billing-cycle decision. |
| **Hosting** | **~$5/month** | Serving up to **~750k–1M queries/month**, inside Cloudflare's free tier. |

So a fork is ~$500 up front, then **~$5/mo** to run the entire lower-48 for a long horizon. The hosted instance is capped at **25,000 elements/day (~750k/month)** via `GLOBAL_ELEMENTS_PER_DAY` — that ceiling is what keeps it inside the free tier. Because the cap is now metered in **elements** (one origin→destination route solve) rather than raw requests, it bounds the actual unit of serving work, so the ~$5/mo guarantee is exact regardless of matrix sizes. Raising it to ~1M elements/month stays ~$5/mo; past that it's roughly **+$5 per additional 1M elements/month** (lift the billing alert to match). The detail behind these numbers:

**Serving is cheap; (re)loading data is not.** Day-to-day request serving runs
**< $10/month** at low-to-moderate traffic — D1 reads (~25 B/mo) and KV reads
(~1 M/day) sit inside Cloudflare's included tiers, R2/KV storage is a few dollars,
and the per-IP rate limiter now runs on a Durable Object (~$0.15/M requests)
instead of KV. The real cost is **D1 row _writes_** during a data load.
Measured on a scratch D1 database (2026-09-14, `etl.d1_probes`):

| Operation | Rows billed |
|---|---|
| Insert one address | **2** (1 table row + 1 FTS5 virtual-table update; FTS5 shadow-table rows are not metered) |
| Delete one address through the FTS delete trigger | 2 |
| Insert one segment | 2 (table + index) |
| Replay an identical `INSERT OR IGNORE` with explicit ids | 0 |
| `DROP TABLE` | 0 |
| Read | rows read, ~$0.001/M (25 B/mo included) |

| Action | Approx. cost | Why |
|---|---|---|
| **Full continental-US load** (`refresh.sh all`) | **~$460 (one-time)** | ~221 M addresses × 2 + ~34 M segments × 2 ≈ 510 M rows written at **$1 / million** after the 50 M/mo included. |
| **Quarterly delta** (`etl.sync_d1`) | **~$0** at a few percent churn | `(inserts + deletes) × 2` rows; forecast by `--dry-run`, hard-capped by `--max-rows`. |
| Mirror export (`etl.export_d1_mirror`) | ~$0.26 | ~255 M rows read, nothing written. |
| TIGER segments reload (all states) | ~68 M rows | Exceeds one month's included rows on its own — schedule it in its own billing cycle. |
| Serving | **< $10 / month** | Reads are within free tiers; rate limiting is on a Durable Object, not KV. |

**Implications:**
- A _full_ reload is a several-hundred-dollar event. **Do not refresh on a
  blind cron.** The weekly detector only opens an issue; the delta loader
  forecasts before it writes and refuses past `--max-rows`.
- Set a **Cloudflare billing alert** — the only hard backstop against a surprise
  overage from a reload or traffic spike.
- Per-IP rate limits (`src/ratelimit.ts`, hybrid: 5 requests/sec burst +
  2,500 elements/day, env-tunable) bound per-client usage but not _global_
  spend; pair with the alert.
- An account-wide global daily cap (`src/global_limiter_do.ts`, default
  25,000 admitted elements/day, env var `GLOBAL_ELEMENTS_PER_DAY`)
  hard-guarantees total serving stays in the free tier (~$5/mo) by returning
  `503` once the element budget for the UTC day is exhausted.

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
  The key is `geo4:<GEO_VERSION>:<sha1>`; `GEO_VERSION` (wrangler `[vars]`,
  falls back to `DATA_VERSION`) is bumped after a D1 address refresh so the
  geocode cache can be invalidated without touching R2 tile paths.

## Layout

```
src/
  index.ts               top-level Worker dispatch
  distancematrix.ts      legacy-shape DM handler + tryWasmMatrix (Rust path)
  geocode.ts             per-state D1 sharded geocoder + TIGER fallback
  interpolate.ts         TIGER segment lookup + linear interpolation
  normalize.ts           address normalizer
  ratelimit.ts           per-IP rate-limit types + pure logic (GDPR-clean: hashed IP)
  ratelimiter_do.ts      RateLimiter DurableObject (in-memory counters; ~100x cheaper than KV)
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
  load_d1_parallel.py       legacy DROP+reload D1 loader (addresses) -- first load only
  load_d1_segments.py       legacy DROP+reload D1 loader (segments) -- first load only
  legacy_guard.py           refuses the legacy loaders on shards listed in state/fingerprints.json
  export_d1_mirror.py       read every D1 shard back into data/v2/state/mirror (keys + ids)
  seed_fingerprints.py      seed state/fingerprints.json from the mirror (once, after the first load)
  sync_d1.py                quarterly row-level delta loader (plan/gates/apply/verify)
  rowkey.py                 shared row filters + 64-bit content keys for the diff
  d1_http.py                D1 REST client (rate limit, retries, rows-written ledger)
  d1_probes.py              metering probes against a scratch D1 db -> state/calibration.json
  check_upstream.py         weekly no-download upstream change detector
  publish_manifest.sh       write manifest + OA attribution to KV

scripts/
  provision.sh              R2 + legacy D1 + KV (one-time bootstrap)
  provision_d1_shards.sh    49 per-state D1 shards (one-time bootstrap)
  materialize_wrangler.sh   substitute account/resource IDs into wrangler.toml
  acceptance_us.sh          continental-US acceptance probe set
  build_wasm_router.sh      cargo build for the Rust crate
  benchmark_panel.py        multi-provider 44-route accuracy + latency benchmark
  cf_env_infisical.sh       source it: Cloudflare token + account id from Infisical into the shell

refresh.sh                  master ETL pipeline (setup → fetch → build → upload → load → publish)
wrangler.toml               Worker config + 49 per-state D1 bindings
wrangler.toml.template      fork-friendly template (substitute via materialize_wrangler.sh)
state/                      committed refresh state: upstream-snapshot.json, calibration.json, fingerprints.json
.github/workflows/refresh.yml  weekly upstream change detector (opens an issue; never loads)
```

The `data/` directory is gitignored and populated on demand by `refresh.sh`.
