# hhapi

Serverless distance/duration API on Cloudflare's edge, response-compatible with
Google's legacy Distance Matrix API.

- Hostname: `https://hhapi.propspress.com`
- Auth: `key=` query param (Google-style)
- Coverage v1: San Francisco Bay Area
- Endpoint: `GET /maps/api/distancematrix/json`

## Documented deviations from Google

- `key=` is validated against our own secret, not a Google API key.
- Numbers come from our routed graph (no live traffic), so they differ from
  Google's results.
- Response omits `fare`, `duration_in_traffic`, `geocoded_waypoints`,
  `copyrights`, `warnings`.
- `place_id:` inputs return `NOT_FOUND`.
- v1 only supports `mode=driving` (any other mode is treated as driving).
- Max 100 elements (origins × destinations) per request.

## Layout

```
src/    Worker TypeScript
etl/    Python ETL: OSM graph + addresses
scripts/  provision/deploy/acceptance
```

See the spec doc (`milepost-routing-api-spec.md`) for the architecture rationale.

This repo is private. Secrets live in Worker secrets (`API_KEY`), never in the
repo.
