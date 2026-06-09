import {
  Env as BaseEnv,
  handleDistanceMatrix,
  healthCheck,
  handleCoverage,
} from "./distancematrix";
import { countElements } from "./elements";
import { renderIndex, renderDocs, renderPrivacy, renderAttribution, htmlHeaders } from "./site";
import {
  rateLimitHeaders,
  rateLimitResponse,
  readLimitsFromEnv,
  hashIp,
  RateLimitResult,
} from "./ratelimit";
import { GlobalLimitResult, readGlobalLimitFromEnv } from "./global_limiter_do";
import { readContactEmail, contactCta, resolveSiteConfig, readMaxElements } from "./config";

export { L1Router } from "./l1_router";
export { RateLimiter } from "./ratelimiter_do";
export { GlobalLimiter } from "./global_limiter_do";

type Env = BaseEnv & {
  L1_ROUTER: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  GLOBAL_LIMITER: DurableObjectNamespace;
};

// CORS: this is a free public API, so any origin can read it. Adding the
// permissive headers on every response lets browser-side JS on third-party
// sites call the endpoint without a proxy. OPTIONS preflight is handled
// before dispatch so any custom client headers won't get blocked.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "x-od-router-impl, x-od-router-settled, x-od-router-tiles, x-ratelimit-limit-second, x-ratelimit-remaining-second, x-ratelimit-remaining-day, x-ratelimit-tier, retry-after",
  "vary": "Origin",
};

function withCors(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

// 503 returned when the account-wide global daily cap is hit. Mirrors the
// Distance Matrix shape of rateLimitResponse (empty rows/addresses) so existing
// clients parse it, but uses HTTP 503 + Retry-After (seconds to UTC midnight).
// `cta` is the contact call-to-action sentence (built via contactCta in
// src/config.ts) appended to the message. Pass "" to omit it -- the caller reads
// CONTACT_EMAIL from env so the contact address is config, not code.
function globalLimitResponse(gl: GlobalLimitResult, cta = ""): Response {
  const body = {
    status: "OVER_QUERY_LIMIT",
    error_message:
      `Service is at its daily element cap (${gl.limit} elements/day, ` +
      `elements = origins × destinations). ` +
      `It resets at 00:00 UTC.` +
      (cta ? ` Need higher or dedicated limits?${cta}` : ""),
    rows: [],
    origin_addresses: [],
    destination_addresses: [],
  };
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "retry-after": String(gl.resetIn),
      "cache-control": "no-store",
    },
  });
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
      // Hybrid DurableObject-backed rate limiting. The per-second tier is a
      // request burst guard (5/sec default, charged 1 per request); the per-IP
      // daily tier and the account-wide global cap are ELEMENT budgets (2,500
      // and 25,000 elements/day; elements = origins × destinations) charged the
      // request's element count. Self-hosters tune via RL_PER_SEC /
      // RL_ELEMENTS_PER_DAY / GLOBAL_ELEMENTS_PER_DAY (each falls back to its
      // legacy key; 0 disables that tier/cap). One DO instance per IP holds the
      // per-IP counters; one shared DO holds the global counter -- ~100x cheaper
      // than the old KV path.
      const envR = env as unknown as Record<string, unknown>;
      const limits = readLimitsFromEnv(envR);
      // Contact CTA appended to rejection messages. Sourced from CONTACT_EMAIL
      // (default hello@open-distance.com); "" suppresses the CTA for a forker.
      const cta = contactCta(readContactEmail(envR));

      // Count the elements this request would charge, using the same pipe-split
      // semantics handleDistanceMatrix applies. Malformed/missing params -> 0
      // (we skip the element charge but still apply the per-second burst, then
      // let handleDistanceMatrix return INVALID_REQUEST).
      const elements = countElements(url);

      // Reject oversize requests BEFORE charging any budget. A request over the
      // per-request element cap never touches the per-IP daily or global budget.
      // Reject before charging any budget, but return HTTP 200 with the
      // legacy MAX_ELEMENTS_EXCEEDED status in the body — same as
      // handleDistanceMatrix and the legacy Distance Matrix wire format
      // (query-level errors ride in the JSON status, not the HTTP status).
      // Charged to nobody.
      const maxElements = readMaxElements(envR);
      if (elements > maxElements) {
        return new Response(JSON.stringify({
          status: "MAX_ELEMENTS_EXCEEDED",
          error_message: `Max ${maxElements} elements (origins × destinations) per request.${cta}`,
          rows: [], origin_addresses: [], destination_addresses: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" },
        });
      }

      const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
      // RL_SALT can be set as a Worker secret for production. Rotating it
      // severs linkability of the per-IP DO names. If unset, defaults to a
      // build-time constant -- still privacy-preserving because the raw IP is
      // never stored, only its salted hash (used as the DO instance name).
      const salt = String(envR.RL_SALT ?? "od-default-salt-rotate-me");
      // Per-IP check (per-second burst charges 1, per-day budget charges
      // `elements`). Fail OPEN: a limiter error must never take the API down.
      // Any throw (DO unavailable, bad response) leaves `rl` null and we skip
      // the gate.
      let rl: RateLimitResult | null = null;
      try {
        const id = env.RATE_LIMITER.idFromName(await hashIp(salt, ip));
        const stub = env.RATE_LIMITER.get(id);
        const resp = await stub.fetch("https://rl/check", {
          method: "POST",
          body: JSON.stringify({ elements }),
        });
        rl = (await resp.json()) as RateLimitResult;
      } catch {
        rl = null;
      }
      if (rl && !rl.ok) return rateLimitResponse(rl, limits, cta);

      // Account-wide hard daily ELEMENT cap. Checked AFTER the per-IP gate passes
      // so a single abuser is bounced with 429 and never burns the global budget
      // -- only per-IP-admitted requests count toward the global cap. One shared
      // DO instance (idFromName("global")) holds the per-UTC-day element counter
      // in memory; trips at GLOBAL_ELEMENTS_PER_DAY (default 25k elements, 0
      // disables). Fail OPEN: any throw leaves `gl` null and we let the request
      // through -- a limiter fault must never take the API down.
      let gl: GlobalLimitResult | null = null;
      try {
        const gid = env.GLOBAL_LIMITER.idFromName("global");
        const gstub = env.GLOBAL_LIMITER.get(gid);
        const gresp = await gstub.fetch("https://gl/check", {
          method: "POST",
          body: JSON.stringify({ elements }),
        });
        gl = (await gresp.json()) as GlobalLimitResult;
      } catch {
        gl = null;
      }
      if (gl && !gl.ok) return globalLimitResponse(gl, cta);

      const resp = await handleDistanceMatrix(url, env);
      // Mirror the rate-limit state back to the caller on every successful
      // response so they can self-throttle without a probe round-trip. When the
      // limiter failed open (rl === null) there are no counters to report, so
      // the X-RateLimit-* headers are simply omitted for that request.
      const headers = new Headers(resp.headers);
      if (rl) {
        for (const [k, v] of Object.entries(rateLimitHeaders(rl.tiers))) {
          headers.set(k, v);
        }
      }
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    }

    // -- HTML site -----------------------------------------------------------
    // Allow HEAD too -- uptime monitors + crawlers expect HEAD on /, /docs,
    // etc. to return the same status as GET. Workers strips the body for HEAD
    // automatically, so we can return the GET-shaped Response unchanged.
    if (req.method === "GET" || req.method === "HEAD") {
      // Resolve every operator-tunable knob from env once so the rendered site
      // reflects this deployment's own limits + contact address (not the
      // maintainer's defaults). A forker changes config, not code.
      const siteEnv = env as unknown as Record<string, unknown>;
      const siteCfg = resolveSiteConfig(
        siteEnv,
        readLimitsFromEnv(siteEnv),
        readGlobalLimitFromEnv(siteEnv),
      );
      if (url.pathname === "/" || url.pathname === "/try") {
        return new Response(renderIndex(siteCfg), { headers: htmlHeaders() });
      }
      if (url.pathname === "/docs") {
        return new Response(renderDocs(siteCfg), { headers: htmlHeaders() });
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

Per-IP, DurableObject-backed. There is no paid tier. The daily budget is metered
in ELEMENTS (elements = origins × destinations), not requests, so the cap tracks
serving cost; the per-second tier is a request burst guard.

- ${siteCfg.perSec.toLocaleString("en-US")} requests per second (burst)
- ${siteCfg.perDay.toLocaleString("en-US")} elements per day per IP

${siteCfg.globalDaily > 0
  ? `On top of the per-IP tiers, an account-wide cap of ${siteCfg.globalDaily.toLocaleString("en-US")} elements/day
(resets at 00:00 UTC) bounds total serving cost. When it's hit the API
returns HTTP 503 + Retry-After (not 429).`
  : `There is no account-wide daily cap on this deployment.`}${siteCfg.contactEmail
  ? ` Need higher or dedicated limits?
Email ${siteCfg.contactEmail} for custom solutions.`
  : ""}

Every response carries headers: X-RateLimit-Limit-Second / -Day,
X-RateLimit-Remaining-Second / -Day, X-RateLimit-Reset-Second / -Day
(the -Day values are element budgets), plus the IETF draft RateLimit-Limit /
-Remaining / -Reset reflecting the tightest currently-binding tier.

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

