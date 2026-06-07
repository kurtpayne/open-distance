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
