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
  "Free open-source distance and duration matrix API for the continental US — " +
  "an alternative to Google Maps Distance Matrix. No API key, no registration, " +
  "Google-compatible JSON response, fork and self-host for ~$5/month on Cloudflare.";

const SITE_KEYWORDS =
  "free maps api, alternative to google maps, distance matrix api, " +
  "open source distance api, free distance api, free geocoder, " +
  "google maps alternative, free routing api, free driving distance api, " +
  "openstreetmap distance api, self-hosted maps api";

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
        "codeRepository": "https://github.com/kurtpayne/hhapi",
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
    <a href="https://github.com/kurtpayne/hhapi">GitHub</a>
  </nav>
</header>
${body}
<footer>
  open-distance is an open-source serverless distance/duration API. Run it
  yourself for ~$5/month on Cloudflare; this hosted instance is free, no
  registration, no API key. Apache 2.0 licensed.
  Data: OpenStreetMap (ODbL), U.S. NAD &amp; TIGER (public domain),
  OpenAddresses (per-source attribution). See
  <a href="https://github.com/kurtpayne/hhapi/blob/main/NOTICE.md">NOTICE</a>.
</footer>
</body></html>`;
}

export function renderIndex(): string {
  const body = `
<p class="pitch">
  <strong>Use open-distance as your first layer.</strong> Try our distance
  matrix first, cache the result. If the per-endpoint confidence
  (<code>rooftop</code> / <code>interpolated</code>) is good enough for your
  use case, you're done — and you didn't pay anyone. If you need traffic-aware
  routing or a low-confidence endpoint, fall back to Google.
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
<p>Google's Distance Matrix is $5 per 1,000 calls with a no-caching clause.
   For applications like commute comparison, route screening, or any
   distance-based heuristic, that's pure rent. open-distance gives you the
   same wire format from open data, free, with no key. Cache the response
   yourself — there's no clause stopping you — and fall back to Google only
   for the ~10–20% of queries where you actually need the premium answer.</p>

<h2>Honest accuracy</h2>
<p>We're built on OpenStreetMap road geometry, NAD + OpenAddresses for
   addresses, TIGER for street-range interpolation. Free-flow durations only
   (no live traffic). For typical metro and inter-city routes:</p>
<ul>
  <li><strong>Distance</strong>: typically within 1–3% of Google for the same
      origin/destination pair</li>
  <li><strong>Time</strong>: 5–15% off in off-peak hours (no live traffic);
      can drift higher in rush-hour scenarios where Google sees congestion
      and we don't</li>
  <li><strong>Geocode confidence</strong>: rooftop (NAD / OpenAddresses) is
      indistinguishable from a commercial geocoder; interpolated (OSM /
      TIGER) is typically within ~30–100 m of the actual building</li>
</ul>

<h2>What this is, and what it isn't</h2>
<h3>Goals</h3>
<ul>
  <li><strong>Free.</strong> No API key, no registration, no payment, no
      contact required. Hosted free at open-distance.com; self-host for ~$5/mo
      on Cloudflare.</li>
  <li><strong>80% as good</strong> as Google for the distance + duration use
      case. Same wire format, comparable accuracy on free-flow time, same or
      better accuracy on distance. Confidence indicator lets you gate the
      remaining 20% to a paid fallback.</li>
  <li><strong>Open.</strong> Apache 2.0 source, ODbL/public-domain data, the
      whole stack is auditable. You can run it yourself and we can't take it
      back.</li>
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
   <code>/coverage</code> endpoint sends <code>max-age=86400</code>. There is
   no clause that stops you from caching results in your own backend for as
   long as you like.</p>

<h3>Deviations from Google's legacy Distance Matrix</h3>
<ul>
  <li>No <code>fare</code>, <code>duration_in_traffic</code>, <code>geocoded_waypoints</code>, <code>copyrights</code>, or <code>warnings</code> fields.</li>
  <li><code>place_id:</code> inputs return <code>NOT_FOUND</code>.</li>
  <li>Only <code>mode=driving</code> is supported.</li>
  <li><code>match</code> arrays added (Google ignores unknown fields, so old clients are unaffected).</li>
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
   the entire continental US. Source: <a href="https://github.com/kurtpayne/hhapi">github.com/kurtpayne/hhapi</a>.
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
   <a href="https://github.com/kurtpayne/hhapi/blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a>.</p>

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
      "img-src 'self' data:; " +
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
