import {
  Env as V2Env,
  handleDistanceMatrix as v2Handle,
  healthCheck as v2Health,
  handleCoverage as v2Coverage,
} from "./v2/distancematrix";
import { renderIndex, renderDocs, renderPrivacy, htmlHeaders } from "./v2/site";

type Env = V2Env;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // -- API endpoints --------------------------------------------------------
    if (url.pathname === "/healthz") return v2Health(env);
    if (url.pathname === "/coverage") return v2Coverage(env);
    if (url.pathname === "/maps/api/distancematrix/json") {
      // No auth required. CF Rate Limiting rules handle abuse on the canonical
      // open-distance.com deployment; forks can re-introduce a key check in
      // `auth.ts` and gate behind it here if they want a private API.
      return v2Handle(url, env);
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
      // Agent + SEO discoverability files.
      if (url.pathname === "/robots.txt") {
        return new Response(
          "User-agent: *\nAllow: /\nSitemap: https://open-distance.com/sitemap.xml\n",
          { headers: { "content-type": "text/plain; charset=UTF-8", "cache-control": "public, max-age=86400" } },
        );
      }
      if (url.pathname === "/sitemap.xml") {
        const urls = ["/", "/docs", "/coverage", "/privacy"];
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

- Apache 2.0 source: https://github.com/kurtpayne/hhapi
- Hosted free at https://open-distance.com (no API key, no registration)
- Self-host for ~$5/month on Cloudflare

## Endpoints

- GET /maps/api/distancematrix/json  -- Google-shape Distance Matrix JSON
- GET /coverage                       -- version, sources, supported match values
- GET /healthz                        -- liveness probe
- GET /                               -- landing + try-it form
- GET /docs                           -- API documentation
- GET /privacy                        -- privacy policy

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

## Data sources and attribution

- OpenStreetMap road geometry (ODbL)
- US DOT National Address Database (public domain)
- OpenAddresses per-county/city authority points (per-source attribution)
- US Census TIGER 2024 (public domain) for street-range interpolation
`;
        return new Response(body, {
          headers: { "content-type": "text/markdown; charset=UTF-8", "cache-control": "public, max-age=86400" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
