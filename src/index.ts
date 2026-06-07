import {
  Env as BaseEnv,
  handleDistanceMatrix,
  healthCheck,
  handleCoverage,
} from "./distancematrix";
import { renderIndex, renderDocs, renderPrivacy, renderAttribution, htmlHeaders } from "./site";
import { checkRateLimit, rateLimitHeaders, rateLimitResponse, readLimitsFromEnv } from "./ratelimit";

export { L1Router } from "./l1_router";

type Env = BaseEnv & {
  L1_ROUTER: DurableObjectNamespace;
};

// CORS: this is a free public API, so any origin can read it. Adding the
// permissive headers on every response lets browser-side JS on third-party
// sites call the endpoint without a proxy. OPTIONS preflight is handled
// before dispatch so any custom client headers won't get blocked.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "x-od-router-impl, x-od-router-settled, x-od-router-tiles, x-ratelimit-limit-second, x-ratelimit-remaining-second, x-ratelimit-remaining-hour, x-ratelimit-remaining-day, x-ratelimit-tier, retry-after",
  "vary": "Origin",
};

function withCors(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // OPTIONS preflight short-circuit: respond before dispatch since the
    // browser won't send the real request until this returns OK.
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
          "access-control-allow-headers": "Accept, Content-Type",
          "access-control-max-age": "86400",
        },
      });
    }
    return withCors(await dispatch(req, env));
  },
};

async function dispatch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // -- API endpoints --------------------------------------------------------
    // /healthz* and /coverage answer to GET + HEAD. Uptime probes commonly
    // use HEAD; Workers strips the body for us.
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { "allow": "GET, HEAD, POST, OPTIONS" } });
    }
    if (url.pathname === "/healthz") return healthCheck(env);
    if (url.pathname === "/healthz/api") {
      // End-to-end probe: runs a real Distance Matrix query (SF intra-metro,
      // ~1 mi) through the same handler real callers hit. Verifies geocode +
      // snap + route + response shape. 200 with timing + result on success,
      // 503 with the failure reason on any error. Skip rate-limit gate -- we
      // call handleDistanceMatrix directly so monitoring services aren't gated by the
      // public per-IP cap.
      const probeUrl = new URL("https://open-distance.com/maps/api/distancematrix/json?origins=37.7749,-122.4194&destinations=37.7849,-122.4094&units=imperial");
      const t0 = Date.now();
      try {
        const resp = await handleDistanceMatrix(probeUrl, env);
        const totalMs = Date.now() - t0;
        const body = await resp.json() as { status?: string; rows?: { elements?: { status?: string; distance?: { value?: number }; duration?: { value?: number } }[] }[] };
        const el = body.rows?.[0]?.elements?.[0];
        const ok = body.status === "OK" && el?.status === "OK" && typeof el.distance?.value === "number" && el.distance.value > 0;
        return new Response(JSON.stringify({
          status: ok ? "ok" : "error",
          version: env.DATA_VERSION,
          probe: { origins: ["37.7749,-122.4194"], destinations: ["37.7849,-122.4094"], expected: "intra-SF ~1 mi" },
          result: ok ? { distance_m: el?.distance?.value, duration_s: el?.duration?.value } : { matrix_status: body.status, element_status: el?.status ?? null },
          total_ms: totalMs,
        }), {
          status: ok ? 200 : 503,
          headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" },
        });
      } catch (e) {
        return new Response(JSON.stringify({
          status: "error",
          version: env.DATA_VERSION,
          error: (e as Error).message,
          total_ms: Date.now() - t0,
        }), {
          status: 503,
          headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" },
        });
      }
    }
    if (url.pathname === "/healthz/l1") {
      // L1 DurableObject probe: tries a real cross-country route through the
      // DO. First request triggers L1 binary load + reverse CSR build (~3-10 s).
      // Subsequent requests reuse the in-memory state. Use ?o=lat,lon&d=lat,lon
      // to pick a route or default to NYC -> LA.
      const o = (url.searchParams.get("o") || "40.7128,-74.0060").split(",").map(Number);
      const d = (url.searchParams.get("d") || "34.0522,-118.2437").split(",").map(Number);
      if (o.length !== 2 || d.length !== 2 || o.some(Number.isNaN) || d.some(Number.isNaN)) {
        return new Response(JSON.stringify({ ok: false, reason: "usage: /healthz/l1?o=lat,lon&d=lat,lon" }),
          { status: 400, headers: { "content-type": "application/json" } });
      }
      try {
        const id = env.L1_ROUTER.idFromName("global");
        const stub = env.L1_ROUTER.get(id);
        const t0 = Date.now();
        const resp = await stub.fetch("https://l1/route", {
          method: "POST",
          body: JSON.stringify({ srcLat: o[0], srcLon: o[1], dstLat: d[0], dstLon: d[1] }),
        });
        const body = await resp.json() as Record<string, unknown>;
        const totalMs = Date.now() - t0;
        return new Response(JSON.stringify({ ...body, total_ms: totalMs }), {
          status: 200,
          headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 503,
          headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" },
        });
      }
    }
    if (url.pathname === "/coverage") return handleCoverage(env, req);
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
      const resp = await handleDistanceMatrix(url, env);
      // Mirror the rate-limit state back to the caller on every successful
      // response so they can self-throttle without a probe round-trip.
      const headers = new Headers(resp.headers);
      for (const [k, v] of Object.entries(rateLimitHeaders(rl.tiers))) {
        headers.set(k, v);
      }
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    }

    // -- HTML site -----------------------------------------------------------
    // Allow HEAD too -- uptime monitors + crawlers expect HEAD on /, /docs,
    // etc. to return the same status as GET. Workers strips the body for HEAD
    // automatically, so we can return the GET-shaped Response unchanged.
    if (req.method === "GET" || req.method === "HEAD") {
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
A wire-compatible alternative to commercial distance-matrix APIs for applications
that need distance + duration but don't need live traffic, POIs, or
rendered maps.

- Apache 2.0 source: https://github.com/kurtpayne/open-distance
- Hosted free at https://open-distance.com (no API key, no registration)
- Self-host for less than $10/month on Cloudflare

## Endpoints

- GET /maps/api/distancematrix/json       -- legacy Distance Matrix JSON wire format
- GET /coverage                           -- version, sources w/ license URLs
- GET /healthz                            -- liveness probe
- GET /                                   -- landing + try-it form
- GET /docs                               -- API documentation
- GET /attribution                        -- consolidated attribution (HTML)
- GET /attribution/openaddresses.json     -- per-source OA attribution manifest
- GET /privacy                            -- privacy policy

## Goals

- Free: no key, no registration, no payment
- On a multi-provider sample, distance estimates sit within ~1% of the
  panel median across most route categories; free-flow time differs more
  from traffic-aware providers (a known trade-off)
- Open: Apache 2.0 code, ODbL/public-domain data, fork-and-deploy

## Non-goals

- Rendered map tiles, slippy-map widgets, POIs, turn-by-turn route geometry,
  live traffic, or international coverage. Continental US lower 48 + DC only.

## Distance Matrix request

GET /maps/api/distancematrix/json?origins=A|B&destinations=C|D&units=imperial

Origins and destinations are either addresses ("700 Bair Island Rd, Redwood
City CA 94063") or "lat,lng" pairs. Multiple separated by "|".

## Response

Byte-compatible with the legacy Distance Matrix JSON wire format, plus
two extra arrays exposing per-endpoint geocode confidence:

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
}
