# Changelog

## Unreleased

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
