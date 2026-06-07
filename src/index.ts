import {
  Env as V2Env,
  handleDistanceMatrix as v2Handle,
  healthCheck as v2Health,
  handleCoverage as v2Coverage,
} from "./v2/distancematrix";
import { renderIndex, renderDocs, renderPrivacy, renderAttribution, htmlHeaders } from "./v2/site";
import { checkRateLimit, rateLimitHeaders, rateLimitResponse, readLimitsFromEnv } from "./v2/ratelimit";

type Env = V2Env;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // -- API endpoints --------------------------------------------------------
    if (url.pathname === "/healthz") return v2Health(env);
    if (url.pathname === "/healthz/wasm") {
      // Exercises the Rust-compiled WASM router end-to-end on a synthetic
      // 3-node tile (0 -> 1 -> 2, 100 m / 10 s per edge). Returns the timings
      // and the result so a deploy can be verified without touching the
      // production routing path. See rust-router/src/lib.rs.
      const { loadWasmRouter, astarIntraTile, isLoaded } =
        await import("./v2/wasm_router");
      const wasmMod = (await import("../rust-router/target/wasm32-unknown-unknown/release/od_router.wasm")).default;
      const t0 = Date.now();
      if (!isLoaded()) await loadWasmRouter(wasmMod);
      const tLoad = Date.now() - t0;
      const buf = synthSmallTile();
      const t1 = Date.now();
      const r = astarIntraTile(buf, 0, 2, 1000);
      const tRun = Date.now() - t1;
      return new Response(JSON.stringify({
        ok: r.ok,
        time_s: r.timeS,
        len_m: r.lenM,
        settled: r.settledCount,
        load_ms: tLoad,
        run_ms: tRun,
        impl: "wasm",
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/healthz/wasm/route") {
      // Real end-to-end probe for the Rust multi-tile A*. Pass two lat,lon
      // pairs as ?o=... &d=... ; we snap each to a tile node, fetch a
      // bbox of tiles around both endpoints (capped to keep memory sane),
      // and run the WASM multi-tile A*.
      const o = (url.searchParams.get("o") || "").split(",").map(Number);
      const d = (url.searchParams.get("d") || "").split(",").map(Number);
      if (o.length !== 2 || d.length !== 2 || o.some(Number.isNaN) || d.some(Number.isNaN)) {
        return new Response(JSON.stringify({ ok: false, reason: "usage: /healthz/wasm/route?o=lat,lon&d=lat,lon" }),
          { status: 400, headers: { "content-type": "application/json" } });
      }
      const { snapK, packTileId, getTileBytes } = await import("./v2/tiles");
      const { loadWasmRouter, astarMultiTile, isLoaded } = await import("./v2/wasm_router");
      const wasmMod = (await import("../rust-router/target/wasm32-unknown-unknown/release/od_router.wasm")).default;

      const tLoad0 = Date.now();
      if (!isLoaded()) await loadWasmRouter(wasmMod);
      const tLoadMs = Date.now() - tLoad0;

      // Snap each endpoint to its best tile node.
      const tSnap0 = Date.now();
      const oSnaps = await snapK(env.GRAPH, env.DATA_VERSION, o[0], o[1], 1);
      const dSnaps = await snapK(env.GRAPH, env.DATA_VERSION, d[0], d[1], 1);
      const tSnapMs = Date.now() - tSnap0;
      if (oSnaps.length === 0 || dSnaps.length === 0) {
        return new Response(JSON.stringify({ ok: false, reason: "snap failed", o_snaps: oSnaps.length, d_snaps: dSnaps.length, load_ms: tLoadMs, snap_ms: tSnapMs }),
          { headers: { "content-type": "application/json" } });
      }
      const src = oSnaps[0]; const dst = dSnaps[0];

      // Tile corridor: bbox over the two snap tiles + a 1-tile buffer in
      // each direction. Capped at 16 tiles to keep WASM memory bounded.
      const txMin = Math.min(src.tx, dst.tx) - 1;
      const txMax = Math.max(src.tx, dst.tx) + 1;
      const tyMin = Math.min(src.ty, dst.ty) - 1;
      const tyMax = Math.max(src.ty, dst.ty) + 1;
      const tileCount = (txMax - txMin + 1) * (tyMax - tyMin + 1);
      if (tileCount > 16) {
        return new Response(JSON.stringify({ ok: false, reason: "route too long for wasm mvp (corridor > 16 tiles)", tile_count: tileCount }),
          { headers: { "content-type": "application/json" } });
      }

      // Fetch tile bytes in parallel.
      const tFetch0 = Date.now();
      const tiles: { tileId: number; bytes: Uint8Array }[] = [];
      await Promise.all(
        Array.from({ length: tileCount }, (_, i) => {
          const tx = txMin + (i % (txMax - txMin + 1));
          const ty = tyMin + Math.floor(i / (txMax - txMin + 1));
          return getTileBytes(env.GRAPH, env.DATA_VERSION, tx, ty).then(bytes => {
            if (bytes) tiles.push({ tileId: packTileId(tx, ty), bytes });
          });
        }),
      );
      const tFetchMs = Date.now() - tFetch0;

      const srcId = packTileId(src.tx, src.ty);
      const dstId = packTileId(dst.tx, dst.ty);
      const tRun0 = Date.now();
      const r = astarMultiTile(tiles, srcId, src.dense, dstId, dst.dense, 200_000);
      const tRunMs = Date.now() - tRun0;

      return new Response(JSON.stringify({
        ok: r.ok,
        time_s: r.timeS,
        len_m: r.lenM,
        settled: r.settledCount,
        tile_count: tiles.length,
        load_ms: tLoadMs,
        snap_ms: tSnapMs,
        fetch_ms: tFetchMs,
        run_ms: tRunMs,
        impl: "wasm-multi-tile",
      }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/coverage") return v2Coverage(env);
    if (url.pathname === "/maps/api/distancematrix/json") {
      // KV-backed per-IP rate limiter. Default 25/sec, 500/hour, 10k/day per
      // IP. Self-hosters can tune via RL_PER_SEC / RL_PER_HOUR / RL_PER_DAY
      // env vars, or set any to 0 to disable that tier. Set all three to 0
      // for an unlimited deployment (private fork inside a trusted network,
      // for example).
      const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
      const envR = env as unknown as Record<string, unknown>;
      const limits = readLimitsFromEnv(envR);
      // RL_SALT can be set as a Worker secret for production. Rotating it
      // severs cross-day linkability of bucket counters. If unset, defaults
      // to a build-time constant -- still privacy-preserving because the
      // hash is only stored next to a small counter, with a short TTL.
      const salt = String(envR.RL_SALT ?? "od-default-salt-rotate-me");
      const rl = await checkRateLimit(env.CACHE, ip, limits, salt);
      if (!rl.ok) return rateLimitResponse(rl, limits);
      const resp = await v2Handle(url, env);
      // Mirror the rate-limit state back to the caller on every successful
      // response so they can self-throttle without a probe round-trip.
      const headers = new Headers(resp.headers);
      for (const [k, v] of Object.entries(rateLimitHeaders(rl.tiers))) {
        headers.set(k, v);
      }
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    }

    // -- HTML site -----------------------------------------------------------
    if (req.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/try") {
        return new Response(renderIndex(), { headers: htmlHeaders() });
      }
      if (url.pathname === "/docs") {
        return new Response(renderDocs(), { headers: htmlHeaders() });
      }
      if (url.pathname === "/privacy") {
        return new Response(renderPrivacy(), { headers: htmlHeaders() });
      }
      if (url.pathname === "/attribution") {
        return new Response(renderAttribution(), { headers: htmlHeaders() });
      }
      if (url.pathname === "/attribution/openaddresses.json") {
        // Per-source OpenAddresses attribution manifest. Written to KV at
        // ETL time (etl/v2/fetch_oa.py persists it; publish_manifest.sh
        // uploads it). Returns an empty manifest with {sources: []} when
        // the data hasn't been published yet.
        const j = await env.CACHE.get("attribution:openaddresses", "text");
        const body = j ?? '{"generated_at":null,"sources":[],"note":"per-source manifest not yet published; rerun the OA fetch + publish stages to populate"}';
        return new Response(body, {
          headers: {
            "content-type": "application/json; charset=UTF-8",
            "cache-control": "public, max-age=3600",
          },
        });
      }
      // Agent + SEO discoverability files.
      if (url.pathname === "/robots.txt") {
        return new Response(
          "User-agent: *\nAllow: /\nSitemap: https://open-distance.com/sitemap.xml\n",
          { headers: { "content-type": "text/plain; charset=UTF-8", "cache-control": "public, max-age=86400" } },
        );
      }
      if (url.pathname === "/sitemap.xml") {
        const urls = ["/", "/docs", "/coverage", "/attribution", "/privacy"];
        const body =
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          urls.map(u => `<url><loc>https://open-distance.com${u}</loc><changefreq>weekly</changefreq></url>`).join("") +
          "</urlset>";
        return new Response(body, {
          headers: { "content-type": "application/xml; charset=UTF-8", "cache-control": "public, max-age=86400" },
        });
      }
      if (url.pathname === "/llms.txt") {
        // https://llmstxt.org -- give LLM crawlers a clean markdown
        // description of the project + endpoints they can quote.
        const body = `# open-distance

Free, open-source distance/duration matrix API for the continental US.
An alternative to Google Maps Distance Matrix for applications that need
distance + duration but don't need live traffic, POIs, or rendered maps.

- Apache 2.0 source: https://github.com/kurtpayne/open-distance
- Hosted free at https://open-distance.com (no API key, no registration)
- Self-host for ~$5/month on Cloudflare

## Endpoints

- GET /maps/api/distancematrix/json       -- Google-shape Distance Matrix JSON
- GET /coverage                           -- version, sources w/ license URLs
- GET /healthz                            -- liveness probe
- GET /                                   -- landing + try-it form
- GET /docs                               -- API documentation
- GET /attribution                        -- consolidated attribution (HTML)
- GET /attribution/openaddresses.json     -- per-source OA attribution manifest
- GET /privacy                            -- privacy policy

## Goals

- Free: no key, no registration, no payment
- ~80% as accurate as Google for distance/duration (~95% on distance, ~85% on free-flow time)
- Open: Apache 2.0 code, ODbL/public-domain data, fork-and-deploy

## Non-goals

- Rendered map tiles, slippy-map widgets, POIs, turn-by-turn route geometry,
  live traffic, or international coverage. Continental US lower 48 + DC only.

## Distance Matrix request

GET /maps/api/distancematrix/json?origins=A|B&destinations=C|D&units=imperial

Origins and destinations are either addresses ("700 Bair Island Rd, Redwood
City CA 94063") or "lat,lng" pairs. Multiple separated by "|".

## Response

Byte-compatible with Google's legacy Distance Matrix JSON, plus two extra
arrays exposing per-endpoint geocode confidence:

- origin_matches[]      one of: rooftop, interpolated, coords, "" (geocode failed)
- destination_matches[] same

rooftop      = exact mapped point (NAD or OpenAddresses dataset)
interpolated = OSM addr-tagged node, or TIGER segment interpolation (~30-100m)
coords       = caller supplied "lat,lng" directly
"" (empty)   = geocode failed; raw input echoed

## Rate limits

Per-IP, KV-backed. There is no paid tier.

- 25 requests per second
- 500 requests per hour
- 10,000 requests per day

Every response carries headers: X-RateLimit-Limit-Second / -Hour / -Day,
X-RateLimit-Remaining-Second / -Hour / -Day, X-RateLimit-Reset-Second /
-Hour / -Day, plus the IETF draft RateLimit-Limit / -Remaining / -Reset
reflecting the tightest currently-binding tier.

Over the limit returns HTTP 429 with status=OVER_QUERY_LIMIT and a
Retry-After header. If you need higher limits, fork and self-host on
your own Cloudflare account; limits are env-var configurable.

## Warranty

Provided as-is with no warranty (Apache 2.0). Built from public open
data; no live traffic; coverage and accuracy vary. For safety- or
contract-critical applications use a commercial Distance Matrix API.

## Data sources and attribution

- OpenStreetMap road geometry (ODbL 1.0): https://opendatacommons.org/licenses/odbl/1-0/
- US DOT National Address Database (public domain, 17 USC 105)
- OpenAddresses per-county/city authority points (per-source attribution -- enumerated at /attribution/openaddresses.json)
- US Census TIGER 2024 (public domain) for street-range interpolation

Every Distance Matrix JSON response includes a "copyrights" field reproducing
the ODbL Sec 4.3 Produced Work notice and pointing back to /attribution.
The /coverage endpoint includes license URLs per source.
`;
        return new Response(body, {
          headers: { "content-type": "text/markdown; charset=UTF-8", "cache-control": "public, max-age=86400" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// Build the synthetic tile from rust-router/src/lib.rs's host test:
// 3 nodes (0 -> 1 -> 2), edges 0->1 (100 m / 10 s) and 1->2 (200 m / 20 s).
// Matches the format produced by etl/v2/_tile_io.py / decoded by src/v2/tiles.ts.
function synthSmallTile(): Uint8Array {
  const buf = new ArrayBuffer(32 + 3 * 4 * 2 + (3 + 1) * 4 + 2 * 4 * 3 + (1 + 1) * 4 + 3 * 4);
  const dv = new DataView(buf);
  let p = 0;
  dv.setUint32(p, 0x30544848, true); p += 4;   // MAGIC
  dv.setUint32(p, 1, true); p += 4;             // fmt_ver
  dv.setInt32(p, 0, true); p += 4;              // tx
  dv.setInt32(p, 0, true); p += 4;              // ty
  dv.setUint32(p, 3, true); p += 4;             // n_local
  dv.setUint32(p, 0, true); p += 4;             // n_extern
  dv.setUint32(p, 2, true); p += 4;             // m_edges
  dv.setUint16(p, 1, true); p += 2;             // grid_n_lon
  dv.setUint16(p, 1, true); p += 2;             // grid_n_lat
  for (const v of [37.0, 37.0, 37.0]) { dv.setFloat32(p, v, true); p += 4; }
  for (const v of [-122.0, -121.999, -121.998]) { dv.setFloat32(p, v, true); p += 4; }
  for (const v of [0, 1, 2, 2]) { dv.setUint32(p, v, true); p += 4; }
  for (const v of [1, 2]) { dv.setUint32(p, v, true); p += 4; }
  for (const v of [10.0, 20.0]) { dv.setFloat32(p, v, true); p += 4; }
  for (const v of [100.0, 200.0]) { dv.setFloat32(p, v, true); p += 4; }
  for (const v of [0, 3]) { dv.setUint32(p, v, true); p += 4; }
  for (const v of [0, 1, 2]) { dv.setUint32(p, v, true); p += 4; }
  return new Uint8Array(buf);
}
