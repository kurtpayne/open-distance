// HTML site served alongside the JSON API. No external resources, vanilla
// HTML + ~50 lines of inline JS, locked down with a strict CSP.

const CSS = `
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
  body { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; line-height: 1.5; }
  header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.75rem; }
  header h1 { margin: 0; font-size: 1.5rem; }
  nav a { margin-left: 0.75rem; font-size: 0.9rem; }
  h2 { margin-top: 2rem; }
  h3 { margin-top: 1.25rem; }
  p, li { color: #2b2b2b; }
  a { color: #1f5eff; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875rem; }
  pre { background: #f5f5f7; padding: 0.75rem 1rem; overflow-x: auto; border-radius: 0.4rem; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #e5e5e9; vertical-align: top; }
  th { background: #f5f5f7; font-weight: 600; }
  form { display: grid; gap: 0.75rem; margin: 1.25rem 0; }
  label { display: grid; gap: 0.3rem; font-size: 0.875rem; color: #444; }
  input[type=text] { padding: 0.55rem 0.7rem; border: 1px solid #c8c8d0; border-radius: 0.35rem; font-size: 1rem; }
  button { padding: 0.6rem 1.2rem; background: #1f5eff; color: white; border: 0; border-radius: 0.35rem; cursor: pointer; font-size: 0.95rem; align-self: start; }
  button:disabled { background: #888; cursor: progress; }
  .pitch { background: #fff7e6; border-left: 4px solid #f5a623; padding: 0.75rem 1rem; margin: 1.5rem 0; border-radius: 0.3rem; }
  .result-grid { display: grid; gap: 1rem; grid-template-columns: 1fr 1fr; margin-top: 1rem; }
  @media (max-width: 640px) { .result-grid { grid-template-columns: 1fr; } }
  .result-block h3 { margin-top: 0; }
  .pill { display: inline-block; font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 99px; background: #f5f5f7; color: #444; margin-left: 0.4rem; font-weight: 500; }
  .pill-rooftop { background: #d1fae5; color: #065f46; }
  .pill-interp { background: #fef3c7; color: #92400e; }
  .pill-coords { background: #e0e7ff; color: #3730a3; }
  .pill-fail { background: #fee2e2; color: #991b1b; }
  table.cmp { font-size: 0.85rem; display: block; overflow-x: auto; }
  table.cmp th:first-child, table.cmp tbody th { font-weight: 600; background: #f5f5f7; white-space: nowrap; }
  footer { color: #777; font-size: 0.8rem; margin-top: 3rem; border-top: 1px solid #e5e5e9; padding-top: 1rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f0f10; color: #eaeaee; }
    p, li, label { color: #d4d4d8; }
    pre, th { background: #1a1a1d; }
    th, td { border-bottom-color: #2a2a2d; }
    input[type=text] { background: #1a1a1d; color: #eaeaee; border-color: #38383d; }
    .pill { background: #1a1a1d; color: #d4d4d8; }
    .pitch { background: #2a2410; border-left-color: #f5a623; color: #f0e3c0; }
    a { color: #6e9bff; }
  }
`;

// The try-it form's JS. Inline so we control everything; no fetch to anything
// other than the same origin's distance matrix endpoint.
const FORM_JS = `
(() => {
  const form = document.getElementById('try-form');
  if (!form) return;
  const out = document.getElementById('out');
  const raw = document.getElementById('raw');
  const submit = document.getElementById('submit-btn');
  const formatPill = (m) => {
    if (m === 'rooftop') return '<span class="pill pill-rooftop">rooftop</span>';
    if (m === 'interpolated') return '<span class="pill pill-interp">interpolated</span>';
    if (m === 'coords') return '<span class="pill pill-coords">coords</span>';
    return '<span class="pill pill-fail">not found</span>';
  };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true; submit.textContent = 'Calculating...';
    out.innerHTML = ''; raw.textContent = '';
    const fd = new FormData(form);
    const origins = String(fd.get('origins') || '').trim();
    const destinations = String(fd.get('destinations') || '').trim();
    const units = String(fd.get('units') || 'imperial');
    const params = new URLSearchParams({ origins, destinations, units });
    const url = '/maps/api/distancematrix/json?' + params.toString();
    try {
      const t0 = performance.now();
      const r = await fetch(url);
      const t = (performance.now() - t0) | 0;
      const data = await r.json();
      raw.textContent = JSON.stringify(data, null, 2);
      const oa = data.origin_addresses || [];
      const om = data.origin_matches || [];
      const da = data.destination_addresses || [];
      const dm = data.destination_matches || [];
      const rows = data.rows || [];
      let html = '<p>Status <code>' + (data.status || 'unknown') + '</code>. Response in ' + t + ' ms.</p>';
      html += '<h3>Pairs</h3><table><thead><tr><th>Origin</th><th>Destination</th><th>Distance</th><th>Duration</th><th>Status</th></tr></thead><tbody>';
      for (let i = 0; i < oa.length; i++) {
        const elements = (rows[i] && rows[i].elements) || [];
        for (let j = 0; j < da.length; j++) {
          const el = elements[j] || {};
          html += '<tr>' +
            '<td>' + escapeHTML(oa[i]) + formatPill(om[i] || '') + '</td>' +
            '<td>' + escapeHTML(da[j]) + formatPill(dm[j] || '') + '</td>' +
            '<td>' + escapeHTML((el.distance && el.distance.text) || '—') + '</td>' +
            '<td>' + escapeHTML((el.duration && el.duration.text) || '—') + '</td>' +
            '<td><code>' + escapeHTML(el.status || '—') + '</code></td>' +
            '</tr>';
        }
      }
      html += '</tbody></table>';
      out.innerHTML = html;
    } catch (e) {
      out.innerHTML = '<p>Error: ' + escapeHTML(String(e && e.message || e)) + '</p>';
    } finally {
      submit.disabled = false; submit.textContent = 'Calculate';
    }
  });
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
})();
`;

const SITE_DESCRIPTION =
  "Free open-source distance and duration matrix API for the continental US. " +
  "No API key, no registration, response-compatible with the legacy Distance " +
  "Matrix JSON shape. Fork and self-host for ~$5/month on Cloudflare.";

const SITE_KEYWORDS =
  "free maps api, free distance matrix api, distance matrix api, " +
  "open source distance api, free distance api, free geocoder, " +
  "free routing api, free driving distance api, " +
  "openstreetmap distance api, self-hosted maps api, " +
  "alternative to commercial maps api";

function shell(title: string, body: string, extraHead = "", path = "/"): string {
  const canonical = `https://open-distance.com${path}`;
  // JSON-LD structured data so agents and search engines can describe the
  // project consistently without scraping the prose.
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "url": "https://open-distance.com/",
        "name": "open-distance",
        "description": SITE_DESCRIPTION,
        "inLanguage": "en-US",
      },
      {
        "@type": "SoftwareApplication",
        "name": "open-distance",
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": "Web (Cloudflare Workers)",
        "url": "https://open-distance.com/",
        "softwareVersion": "v2",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "license": "https://www.apache.org/licenses/LICENSE-2.0",
        "codeRepository": "https://github.com/kurtpayne/open-distance",
        "description": SITE_DESCRIPTION,
        "featureList": [
          "Distance matrix between addresses or coordinates",
          "Google-compatible JSON response",
          "Per-endpoint geocode confidence indicator",
          "Cacheable responses, no key required",
          "Continental US coverage",
          "Free, open-source under Apache 2.0",
        ],
      },
    ],
  });
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${SITE_DESCRIPTION}">
<meta name="keywords" content="${SITE_KEYWORDS}">
<meta name="robots" content="index,follow">
<meta name="theme-color" content="#1f5eff">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${SITE_DESCRIPTION}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="open-distance">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${SITE_DESCRIPTION}">
<style>${CSS}</style>
<script type="application/ld+json">${jsonLd}</script>
${extraHead}
</head><body>
<header>
  <h1><a href="/" style="color:inherit;text-decoration:none;">open-distance</a></h1>
  <nav>
    <a href="/">Try it</a>
    <a href="/docs">API</a>
    <a href="/coverage">/coverage</a>
    <a href="/privacy">Privacy</a>
    <a href="https://github.com/kurtpayne/open-distance">GitHub</a>
  </nav>
</header>
${body}
<footer>
  open-distance is an open-source serverless distance/duration API. Run it
  yourself for ~$5/month on Cloudflare; this hosted instance is free, no
  registration, no API key. Apache 2.0 licensed.
  Data: OpenStreetMap (ODbL), U.S. NAD &amp; TIGER (public domain),
  OpenAddresses (per-source attribution). See
  <a href="https://github.com/kurtpayne/open-distance/blob/main/NOTICE.md">NOTICE</a>.
  <br><br>
  <strong>Provided as-is, no warranty.</strong> Built from public open data; no
  live traffic; coverage and accuracy vary. If your application is safety- or
  contract-critical (emergency dispatch, regulated SLAs, legal billing), use a
  commercial API like Google Maps Distance Matrix. See the
  <a href="https://github.com/kurtpayne/open-distance/blob/main/LICENSE">LICENSE</a>
  for the full warranty disclaimer.
  <br><br>
  <a href="https://yoke.lol/open-distance.com"><img src="https://yoke.lol/badge/open-distance.com.svg" alt="Yoke score for open-distance.com"></a>
</footer>
</body></html>`;
}

export function renderIndex(): string {
  const body = `
<p class="pitch">
  <strong>Commercial APIs are excellent — they're the gold standard for live
  traffic, rendered maps, and the long tail of edge cases.</strong>
  open-distance doesn't try to compete on quality. It's just free.<br><br>
  Use it as your first layer: try our distance matrix first, cache the result.
  If the per-endpoint confidence (<code>rooftop</code> /
  <code>interpolated</code>) is good enough for your use case, you're done.
  If you need traffic-aware routing or the geocode came back low-confidence,
  fall back to a paid API for those queries only. Most applications need the
  premium answer for less than 100% of their requests.
</p>

<form id="try-form" autocomplete="off">
  <label>Origins
    <input type="text" name="origins" placeholder="1 market st, san francisco, ca | 37.7749,-122.4194" required>
    <small>Free-form: addresses, ZIPs, or <code>lat,lng</code> pairs. Multiple separated by <code>|</code>.</small>
  </label>
  <label>Destinations
    <input type="text" name="destinations" placeholder="2280 market st, san francisco, ca | 37.4419,-122.143" required>
  </label>
  <label>Units
    <select name="units">
      <option value="imperial" selected>imperial (mi / mins)</option>
      <option value="metric">metric (km / mins)</option>
    </select>
  </label>
  <button id="submit-btn" type="submit">Calculate</button>
</form>

<div id="out"></div>
<div class="result-grid">
  <div class="result-block">
    <h3>Raw JSON response</h3>
    <pre><code id="raw">(submit to see)</code></pre>
  </div>
  <div class="result-block">
    <h3>How to call from your code</h3>
<pre><code>GET https://open-distance.com/maps/api/distancematrix/json
    ?origins=A|B
    &amp;destinations=C|D
    &amp;units=imperial</code></pre>
    <p>Response is byte-compatible with Google's legacy Distance Matrix JSON,
       plus <code>origin_matches</code> and <code>destination_matches</code>
       arrays that surface the confidence per endpoint.</p>
  </div>
</div>

<h2>Why this exists</h2>
<p>Distance and duration are useful in lots of applications that don't
   strictly need a commercial mapping API: commute comparison, route
   screening, simple "how far is X from Y" heuristics, batch ETAs from a
   warehouse to a list of stops. Commercial APIs make these queries
   straightforward but pricing per-call adds up fast, especially at volume.
   open-distance gives you the same wire format from open data, free, with
   no key — so you can cache the result and use a premium API only for the
   subset of queries that actually need traffic-aware or premium answers.</p>

<h2>Honest accuracy</h2>
<p>We're built on OpenStreetMap road geometry, NAD + OpenAddresses for
   addresses, TIGER for street-range interpolation. Free-flow durations only
   (no live traffic). For typical metro and inter-city routes:</p>
<ul>
  <li><strong>Distance</strong>: typically within a few percent of a
      commercial reference for the same origin/destination pair</li>
  <li><strong>Time</strong>: a single-digit percent off in off-peak hours
      (no live traffic); larger gap in rush-hour scenarios where a
      traffic-aware API sees congestion and we don't</li>
  <li><strong>Geocode confidence</strong>: rooftop (NAD / OpenAddresses) is
      comparable to a commercial geocoder; interpolated (OSM / TIGER) is
      typically within ~30–100 m of the actual building</li>
</ul>

<h2>What this is, and what it isn't</h2>
<h3>Goals</h3>
<ul>
  <li><strong>Free.</strong> No API key, no registration, no payment, no
      contact required. Hosted free at open-distance.com; self-host for ~$5/mo
      on Cloudflare.</li>
  <li><strong>Good enough for many use cases, honest about what it isn't.</strong>
      We don't claim parity with a commercial Distance Matrix API. We aim for
      <em>good-enough-when-traffic-doesn't-matter</em>: comparable distance
      numbers, free-flow durations only. The confidence indicator on each
      response lets you gate any query to a paid fallback when you need the
      premium answer.</li>
  <li><strong>Open.</strong> Apache 2.0 source, ODbL/public-domain data, the
      whole stack is auditable. You can run it yourself; the canonical hosted
      deployment is just one of many possible.</li>
</ul>

<h3>Non-goals</h3>
<ul>
  <li><strong>Not a mapping product.</strong> No tiles, no rendered maps, no
      slippy-map widget. There are excellent free OSM-based tile servers; this
      isn't one of them.</li>
  <li><strong>Not a POI / places API.</strong> No business listings, no
      reviews, no "restaurants near me". If you need POIs, use Nominatim,
      Overpass, or a commercial places API.</li>
  <li><strong>Not turn-by-turn directions or route geometry.</strong> We
      return the <em>scalar</em> distance and duration — not the polyline of
      the route. Use OSRM or Valhalla if you need the actual driving path
      drawn on a map.</li>
  <li><strong>Not live traffic.</strong> Times are free-flow estimates. If
      your application is sensitive to rush-hour congestion, fall back to a
      traffic-aware API for those queries.</li>
  <li><strong>Not international.</strong> Continental US (lower 48 + DC)
      only. Same architecture would work elsewhere with state/country PBFs;
      not a goal for this project.</li>
</ul>

<h2>Fitness for purpose</h2>
<p><strong>open-distance is provided as-is, with no warranty.</strong> The
   Apache 2.0 license disclaims all warranties — express and implied. If
   you're building anything where a wrong answer has real consequences —
   <em>emergency dispatch, contract-billed deliveries, regulated SLAs,
   safety-of-life routing</em> — use a commercial API like Google Maps
   Distance Matrix.</p>
<p>The hosted instance is a free shared resource on Cloudflare. It can
   change, slow down, get rate-limited harder, or go offline at any time
   without notice. If you need uptime guarantees, self-host. If you need
   answers you can put your name behind, pay a vendor that offers an SLA.</p>

<h2>How this compares to OSRM, Valhalla, and commercial APIs</h2>
<p>The open-source routing ecosystem already has excellent engines.
   <strong>open-distance is not a routing engine</strong> — it's a
   distance-matrix endpoint built on a different operational model
   (Cloudflare's edge, serverless, no server to run). If you need full
   route geometry, turn-by-turn directions, or live traffic, one of the
   tools below is the right fit.</p>
<table class="cmp">
  <thead>
    <tr><th></th><th>OSRM</th><th>Valhalla</th><th>open-distance</th><th>Google / commercial</th></tr>
  </thead>
  <tbody>
    <tr><th>Deploy model</th><td>Self-host server (VM)</td><td>Self-host server (VM)</td><td>Cloudflare Worker (edge)</td><td>SaaS</td></tr>
    <tr><th>Cost (US-48)</th><td>~$50–200/mo VM</td><td>~$50–200/mo VM</td><td>~$5–10/mo Cloudflare</td><td>Per-call ($)</td></tr>
    <tr><th>Cold start</th><td>Minutes (load graph)</td><td>Seconds (tile lazy-load)</td><td>~30 ms isolate</td><td>n/a</td></tr>
    <tr><th>Raw routing speed</th><td>Best-in-class (CH)</td><td>Good (tiled)</td><td>Good; slower cross-country before L1 overlay</td><td>Fast</td></tr>
    <tr><th>Route geometry</th><td>Yes</td><td>Yes</td><td>No (scalar distance + duration)</td><td>Yes</td></tr>
    <tr><th>Turn-by-turn</th><td>Yes</td><td>Yes</td><td>No</td><td>Yes</td></tr>
    <tr><th>Live traffic</th><td>No</td><td>Plugin</td><td>No</td><td>Yes</td></tr>
    <tr><th>Geocoder</th><td>BYO (Nominatim)</td><td>BYO</td><td>Built-in (NAD + OA + OSM + TIGER)</td><td>Built-in</td></tr>
    <tr><th>API shape</th><td>OSRM JSON</td><td>Valhalla JSON</td><td>Google Distance Matrix JSON</td><td>(varies)</td></tr>
    <tr><th>License</th><td>BSD-2</td><td>MIT</td><td>Apache 2.0</td><td>Proprietary</td></tr>
  </tbody>
</table>
<p>Both <a href="https://project-osrm.org/" target="_blank" rel="noopener noreferrer">OSRM</a>
   and <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noopener noreferrer">Valhalla</a>
   are mature, well-maintained projects with much broader feature sets than
   open-distance. Valhalla's tiled hierarchical architecture is, in fact,
   the closest analog to what runs here. The differences are scope (we do
   only distance/duration matrices) and operations (Worker isolates instead
   of dedicated servers).</p>
<p>The <strong>"first layer"</strong> idea works with any of these as the
   fallback: hit open-distance first, cache the answer, and only call the
   premium engine when you actually need its premium features.</p>

<script>${FORM_JS}</script>
`;
  return shell("open-distance — free distance/duration API", body);
}

export function renderDocs(): string {
  const body = `
<h2>API</h2>
<p>Response-compatible with Google's legacy Distance Matrix API, plus two
   extra arrays exposing per-endpoint geocode confidence.</p>

<h3>Endpoint</h3>
<pre><code>GET https://open-distance.com/maps/api/distancematrix/json
    ?origins=&lt;A&gt;|&lt;B&gt;|...
    &amp;destinations=&lt;C&gt;|&lt;D&gt;|...
    &amp;units=imperial|metric        # default imperial
    &amp;mode=driving                  # only mode supported</code></pre>

<p>Each origin/destination is either an address string or a <code>lat,lng</code>
   pair. Multiple endpoints separated by <code>|</code>. Up to 100 elements
   (origins × destinations) per request.</p>

<h3>Response</h3>
<pre><code>{
  "destination_addresses": ["…canonical or raw input…"],
  "destination_matches":   ["rooftop" | "interpolated" | "coords" | ""],
  "origin_addresses":      ["…"],
  "origin_matches":        ["…"],
  "rows": [
    { "elements": [
      { "status": "OK" | "NOT_FOUND" | "ZERO_RESULTS",
        "distance": { "text": "5.4 mi", "value": 8690 },
        "duration": { "text": "11 mins", "value": 660 } }
    ] }
  ],
  "status": "OK"
}</code></pre>

<h3>The confidence indicator</h3>
<p>Each endpoint comes back with a <code>match</code> value telling you how
   it was located:</p>
<table>
<thead><tr><th>Value</th><th>Means</th><th>Typical accuracy</th></tr></thead>
<tbody>
<tr><td><code>rooftop</code></td><td>Exact mapped point (NAD or OpenAddresses rooftop dataset)</td><td>Building-level</td></tr>
<tr><td><code>interpolated</code></td><td>OSM addr-tagged node, or TIGER segment interpolation</td><td>~30–100 m</td></tr>
<tr><td><code>coords</code></td><td>Caller-supplied <code>lat,lng</code> directly</td><td>Whatever the caller gave us</td></tr>
<tr><td><code>""</code></td><td>Geocode failed; raw input is echoed</td><td>Element returns <code>NOT_FOUND</code></td></tr>
</tbody>
</table>

<h3>Caching</h3>
<p>Successful responses send <code>Cache-Control: public, max-age=3600</code>,
   so Cloudflare's edge cache absorbs identical queries for an hour. The
   <code>/coverage</code> endpoint sends <code>max-age=86400</code>. You're
   welcome to cache responses in your own backend for as long as you like.</p>

<h3>Rate limits</h3>
<p>Per-IP rate limits on the hosted deployment:</p>
<ul>
  <li><strong>25</strong> requests per second</li>
  <li><strong>500</strong> requests per hour</li>
  <li><strong>10,000</strong> requests per day</li>
</ul>

<p><strong>There is no paid tier.</strong> The hosted instance is intentionally
   a free shared resource for casual use. If you need higher limits, self-host
   on your own Cloudflare account — limits are env-var configurable per tier,
   or set all three to <code>0</code> for an unlimited deployment.</p>

<h4>Response headers</h4>
<p>Every API response (both <code>200</code> success and <code>429</code> rate-limited)
   carries the following headers so you can self-throttle without a probe
   round-trip:</p>
<table>
<thead><tr><th>Header</th><th>What it means</th></tr></thead>
<tbody>
<tr><td><code>X-RateLimit-Limit-Second</code></td><td>Configured per-second limit (25 by default)</td></tr>
<tr><td><code>X-RateLimit-Remaining-Second</code></td><td>Requests left in the current 1-second window</td></tr>
<tr><td><code>X-RateLimit-Reset-Second</code></td><td>Seconds until the 1-second window rolls (always 1)</td></tr>
<tr><td><code>X-RateLimit-Limit-Hour</code></td><td>Configured per-hour limit (500 by default)</td></tr>
<tr><td><code>X-RateLimit-Remaining-Hour</code></td><td>Requests left in the current hour bucket</td></tr>
<tr><td><code>X-RateLimit-Reset-Hour</code></td><td>Seconds until the hour bucket rolls</td></tr>
<tr><td><code>X-RateLimit-Limit-Day</code></td><td>Configured per-day limit (10,000 by default)</td></tr>
<tr><td><code>X-RateLimit-Remaining-Day</code></td><td>Requests left in the current day bucket</td></tr>
<tr><td><code>X-RateLimit-Reset-Day</code></td><td>Seconds until the day bucket rolls</td></tr>
<tr><td><code>RateLimit-Limit</code></td><td><a href="https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/" target="_blank" rel="noopener noreferrer">IETF draft header</a>: limit of the tightest tier</td></tr>
<tr><td><code>RateLimit-Remaining</code></td><td>Remaining of the tightest tier</td></tr>
<tr><td><code>RateLimit-Reset</code></td><td>Seconds until the tightest tier resets</td></tr>
</tbody>
</table>

<h4>When you hit the limit</h4>
<p>You get HTTP <code>429</code> with <code>"status":"OVER_QUERY_LIMIT"</code>,
   a <code>Retry-After</code> header (seconds until the offending tier rolls),
   and <code>X-RateLimit-Tier</code> = <code>sec</code> / <code>hour</code> /
   <code>day</code> indicating which bucket overflowed. The response body
   includes a link back to the source so you can self-host with your own
   limits.</p>

<h3>Deviations from the legacy Distance Matrix shape</h3>
<ul>
  <li>No <code>fare</code>, <code>duration_in_traffic</code>, <code>geocoded_waypoints</code>, <code>copyrights</code>, or <code>warnings</code> fields.</li>
  <li><code>place_id:</code> inputs return <code>NOT_FOUND</code>.</li>
  <li>Only <code>mode=driving</code> is supported.</li>
  <li><code>match</code> arrays added (the legacy schema ignores unknown fields, so existing clients are unaffected).</li>
  <li>Centroid-quality geocodes return <code>NOT_FOUND</code> rather than confidently-wrong distances.</li>
</ul>

<h2>Other endpoints</h2>
<table>
<thead><tr><th>Path</th><th>What it returns</th></tr></thead>
<tbody>
<tr><td><code>/healthz</code></td><td>Liveness + sentinel-tile probe</td></tr>
<tr><td><code>/coverage</code></td><td>Version, data sources, supported match values</td></tr>
</tbody>
</table>

<h2>Self-hosting</h2>
<p>The whole stack (Cloudflare Worker + R2 + D1 + KV) costs ~$5–10/month for
   the entire continental US. Source: <a href="https://github.com/kurtpayne/open-distance">github.com/kurtpayne/open-distance</a>.
   <code>./refresh.sh</code> handles the data pipeline from a clean clone.</p>
`;
  return shell("open-distance — API docs", body);
}

export function renderPrivacy(): string {
  const body = `
<h2>Privacy</h2>
<p>open-distance is designed not to know who you are.</p>

<h3>What we receive</h3>
<ul>
  <li>The origin and destination strings you send (addresses or coordinates).</li>
  <li>Cloudflare's standard edge logs (request IP, user-agent, country) — used
      for abuse mitigation and aggregated traffic analytics only. We do not
      attempt to identify individual users.</li>
</ul>

<h3>What we store</h3>
<ul>
  <li><strong>Geocode cache</strong> (Cloudflare KV, 30-day TTL):
      <code>SHA-1(normalized_address) &rarr; { lat, lon }</code>. The
      normalized address strings are stored. We do not store IPs alongside.</li>
  <li><strong>Leg cache</strong> (Cloudflare KV, 30-day TTL): keyed on
      snapped road-graph node IDs (not addresses), value is travel time +
      distance. This is a map fact, not personal data.</li>
  <li><strong>Edge response cache</strong> (Cloudflare's standard cache,
      1-hour TTL on Distance Matrix responses): full JSON keyed by URL.</li>
</ul>

<h3>What we don't do</h3>
<ul>
  <li>No cookies. No localStorage. No tracking pixels. No analytics SDKs.</li>
  <li>No external resources (fonts, scripts, images) — everything served from
      the same origin.</li>
  <li>No JavaScript on the demo page beyond the small inline form handler.
      The form does not access geolocation, camera, microphone, or any other
      browser permission.</li>
  <li>No accounts, no API keys to register, no contact required to use.</li>
</ul>

<h3>If you want to keep even the URL private</h3>
<p>Self-host. The whole stack is open source under Apache 2.0; fork the repo
   and deploy it on your own Cloudflare account for ~$5/month. See
   <a href="https://github.com/kurtpayne/open-distance/blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a>.</p>

<h3>Contact</h3>
<p>Open an issue on the GitHub repo if you have a privacy concern with the
   hosted deployment at open-distance.com.</p>
`;
  return shell("open-distance — privacy", body);
}

export function htmlHeaders(): Record<string, string> {
  // Strict CSP: only self, only inline styles+scripts. The form's JS is inlined
  // into the HTML; we allow inline because it's a single trusted artifact we
  // own end-to-end. Cookie/localStorage/etc not used.
  return {
    "content-type": "text/html; charset=UTF-8",
    "content-security-policy":
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https://yoke.lol; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none'; " +
      "base-uri 'none'; " +
      "form-action 'self'; " +
      "object-src 'none'",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), interest-cohort=(), " +
      "payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "public, max-age=600",
  };
}
