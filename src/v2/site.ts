// HTML site served alongside the JSON API. No external resources, vanilla
// HTML + ~50 lines of inline JS, locked down with a strict CSP.

const CSS = `
  /* Design tokens. One accent, neutral grays, system fonts. */
  :root {
    color-scheme: light dark;
    --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --accent: #2952cc;
    --accent-hover: #1f3fa3;
    --accent-soft: #eef2ff;
    --bg: #ffffff;
    --bg-soft: #f7f7f9;
    --bg-code: #f4f5f7;
    --fg: #18181b;
    --fg-muted: #52525b;
    --fg-faint: #71717a;
    --border: #e5e7eb;
    --border-strong: #d4d4d8;
    --pitch-bg: #fffbeb;
    --pitch-bd: #f5a623;
    --pitch-fg: #503a10;
    --radius: 0.5rem;
    --radius-sm: 0.35rem;
    --shadow-sm: 0 1px 2px rgba(15, 15, 20, 0.04), 0 1px 1px rgba(15, 15, 20, 0.03);
  }
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: var(--font-sans);
    max-width: 76ch;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 4rem;
    line-height: 1.6;
    color: var(--fg);
    background: var(--bg);
    font-size: 16px;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  /* Header / nav. Calm, not loud. */
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
    padding-bottom: 1.25rem;
    margin-bottom: 2rem;
    border-bottom: 1px solid var(--border);
  }
  header h1 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  header h1 a { color: inherit; text-decoration: none; }
  header h1 a:hover { color: var(--accent); }
  nav { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  nav a {
    font-size: 0.875rem;
    color: var(--fg-muted);
    text-decoration: none;
    padding: 0.35rem 0.65rem;
    border-radius: var(--radius-sm);
    transition: background-color .15s, color .15s;
  }
  nav a:hover { color: var(--fg); background: var(--bg-soft); }

  /* Typographic scale. */
  h1, h2, h3, h4 { color: var(--fg); letter-spacing: -0.015em; line-height: 1.25; }
  h2 { margin: 3rem 0 0.75rem; font-size: 1.5rem; font-weight: 600; }
  h2:first-child { margin-top: 0; }
  h3 { margin: 2rem 0 0.5rem; font-size: 1.125rem; font-weight: 600; }
  h4 { margin: 1.5rem 0 0.5rem; font-size: 1rem; font-weight: 600; color: var(--fg-muted); }
  p { margin: 0.75rem 0; }
  ul, ol { padding-left: 1.25rem; margin: 0.75rem 0; }
  li { margin: 0.25rem 0; }
  p, li { color: var(--fg); }
  strong { font-weight: 600; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }

  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  a:hover { color: var(--accent-hover); }

  /* Code & pre. Tasteful, monospace, easy to read. */
  code, pre, kbd, samp { font-family: var(--font-mono); font-size: 0.875em; }
  :not(pre) > code {
    background: var(--bg-code);
    color: var(--fg);
    padding: 0.1em 0.35em;
    border-radius: 0.25rem;
    border: 1px solid var(--border);
    font-size: 0.85em;
  }
  pre {
    background: var(--bg-code);
    border: 1px solid var(--border);
    padding: 0.9rem 1rem;
    overflow-x: auto;
    border-radius: var(--radius);
    margin: 1rem 0;
    line-height: 1.5;
    font-size: 0.85rem;
  }
  pre code { background: none; padding: 0; border: 0; font-size: 1em; }

  /* Tables. Striped softly; not a wall of cells. */
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.925rem; }
  th, td { text-align: left; padding: 0.6rem 0.75rem; vertical-align: top; }
  thead th {
    font-weight: 600;
    color: var(--fg-muted);
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border-strong);
    background: transparent;
  }
  tbody tr { border-bottom: 1px solid var(--border); }
  tbody tr:last-child { border-bottom: 0; }
  tbody tr:nth-child(even) { background: var(--bg-soft); }
  tbody th {
    font-weight: 600;
    color: var(--fg);
    background: transparent;
  }

  /* Comparison table: sticky first column, horizontal scroll on small screens. */
  .cmp-wrap {
    margin: 1rem 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow-x: auto;
    background: var(--bg);
  }
  table.cmp { margin: 0; font-size: 0.875rem; min-width: 38rem; }
  table.cmp thead th { padding: 0.75rem; background: var(--bg-soft); }
  table.cmp tbody th {
    position: sticky;
    left: 0;
    background: var(--bg);
    font-weight: 600;
    white-space: nowrap;
    z-index: 1;
    box-shadow: 1px 0 0 var(--border);
  }
  table.cmp tbody tr:nth-child(even) th { background: var(--bg-soft); }
  table.cmp td { white-space: normal; }

  /* Hero pitch block. Warm but restrained. */
  .pitch {
    background: var(--pitch-bg);
    border: 1px solid #f5d97a;
    border-left: 4px solid var(--pitch-bd);
    padding: 1rem 1.25rem;
    margin: 0 0 2rem;
    border-radius: var(--radius);
    color: var(--pitch-fg);
  }
  .pitch p { margin: 0.5rem 0; color: inherit; }
  .pitch p:first-child { margin-top: 0; }
  .pitch p:last-child { margin-bottom: 0; }
  .pitch code {
    background: rgba(0,0,0,0.05);
    border-color: rgba(0,0,0,0.08);
    color: inherit;
  }

  /* Try-it form. Card-shaped, generous spacing. */
  .try-card {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
    padding: 1.25rem 1.25rem 1.5rem;
    margin: 1.5rem 0;
    box-shadow: var(--shadow-sm);
  }
  .try-card h2 { margin-top: 0; }
  form { display: grid; gap: 1rem; margin: 0; }
  label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.875rem;
    color: var(--fg-muted);
    font-weight: 500;
  }
  label small { color: var(--fg-faint); font-weight: 400; font-size: 0.8125rem; }
  input[type=text], select {
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font-size: 1rem;
    font-family: inherit;
    background: var(--bg);
    color: var(--fg);
    width: 100%;
    transition: border-color .15s, box-shadow .15s;
  }
  input[type=text]:focus, select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(41, 82, 204, 0.15);
  }
  button {
    padding: 0.6rem 1.25rem;
    background: var(--accent);
    color: white;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.9375rem;
    font-weight: 500;
    font-family: inherit;
    align-self: start;
    transition: background-color .15s;
  }
  button:hover:not(:disabled) { background: var(--accent-hover); }
  button:disabled { background: #a1a1aa; cursor: progress; }

  /* Result panel + side-by-side reference cards. */
  #out:not(:empty) {
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--border);
  }
  #out h3 { margin-top: 1rem; font-size: 1rem; }
  .result-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: 1fr 1fr;
    margin-top: 1.5rem;
  }
  @media (max-width: 640px) { .result-grid { grid-template-columns: 1fr; } }
  .result-block {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.1rem 1.1rem;
  }
  .result-block h3 { margin-top: 0; font-size: 0.9375rem; color: var(--fg-muted); }
  .result-block pre { margin: 0.5rem 0 0; max-height: 18rem; }
  .result-block p { font-size: 0.9rem; color: var(--fg-muted); }

  /* Pills (confidence indicators). */
  .pill {
    display: inline-block;
    font-size: 0.7rem;
    padding: 0.1rem 0.5rem;
    border-radius: 99px;
    background: var(--bg-soft);
    color: var(--fg-muted);
    margin-left: 0.4rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    vertical-align: 1px;
    border: 1px solid var(--border);
  }
  .pill-rooftop { background: #d1fae5; color: #065f46; border-color: #a7f3d0; }
  .pill-interp  { background: #fef3c7; color: #92400e; border-color: #fde68a; }
  .pill-coords  { background: #e0e7ff; color: #3730a3; border-color: #c7d2fe; }
  .pill-fail    { background: #fee2e2; color: #991b1b; border-color: #fecaca; }

  /* Footer. */
  footer {
    color: var(--fg-faint);
    font-size: 0.8125rem;
    line-height: 1.55;
    margin-top: 4rem;
    border-top: 1px solid var(--border);
    padding-top: 1.5rem;
  }
  footer p { margin: 0 0 0.75rem; color: inherit; }
  footer a { color: var(--fg-muted); }
  footer a:hover { color: var(--accent); }
  footer .yoke { margin-top: 1rem; display: inline-block; }
  footer .yoke img { display: block; }

  /* Dark mode. */
  @media (prefers-color-scheme: dark) {
    :root {
      --accent: #93b4ff;
      --accent-hover: #b3c8ff;
      --accent-soft: #1c2440;
      --bg: #0f0f12;
      --bg-soft: #18181c;
      --bg-code: #16161a;
      --fg: #ececf1;
      --fg-muted: #b4b4be;
      --fg-faint: #8a8a93;
      --border: #27272d;
      --border-strong: #3a3a42;
      --pitch-bg: #251e0e;
      --pitch-bd: #f5a623;
      --pitch-fg: #f0e3c0;
      --shadow-sm: 0 1px 2px rgba(0,0,0,0.4), 0 1px 1px rgba(0,0,0,0.3);
    }
    .pitch { border-color: #4a3a14; }
    .pitch code { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.08); }
    button { color: #0f0f12; }
    button:disabled { background: #52525b; color: #d4d4d8; }
    input[type=text]:focus, select:focus { box-shadow: 0 0 0 3px rgba(147, 180, 255, 0.2); }
    .pill-rooftop { background: #064e3b; color: #a7f3d0; border-color: #065f46; }
    .pill-interp  { background: #4a3209; color: #fde68a; border-color: #78350f; }
    .pill-coords  { background: #1e1b4b; color: #c7d2fe; border-color: #312e81; }
    .pill-fail    { background: #4c1414; color: #fecaca; border-color: #7f1d1d; }
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
  <h1><a href="/">open-distance</a></h1>
  <nav>
    <a href="/">Try it</a>
    <a href="/docs">API</a>
    <a href="/coverage">/coverage</a>
    <a href="/attribution">Attribution</a>
    <a href="/privacy">Privacy</a>
    <a href="https://github.com/kurtpayne/open-distance">GitHub</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <p>
    open-distance is an open-source serverless distance/duration API. Run it
    yourself for ~$5/month on Cloudflare; this hosted instance is free, no
    registration, no API key. Apache 2.0 licensed.
    Data: OpenStreetMap (ODbL), U.S. NAD &amp; TIGER (public domain),
    OpenAddresses (per-source attribution). See
    <a href="/attribution">attribution</a>
    (canonical: <a href="https://github.com/kurtpayne/open-distance/blob/main/NOTICE">NOTICE</a>).
  </p>
  <p>
    <strong>Provided as-is, no warranty.</strong> Built from public open data;
    no live traffic; coverage and accuracy vary. If your application is safety-
    or contract-critical (emergency dispatch, regulated SLAs, legal billing),
    use a commercial API like Google Maps Distance Matrix. See the
    <a href="https://github.com/kurtpayne/open-distance/blob/main/LICENSE">LICENSE</a>
    for the full warranty disclaimer.
  </p>
  <a class="yoke" href="https://yoke.lol/open-distance.com"><img src="https://yoke.lol/badge/open-distance.com.svg" alt="Yoke score for open-distance.com"></a>
</footer>
</body></html>`;
}

export function renderIndex(): string {
  const body = `
<div class="pitch">
  <p><strong>Commercial APIs are excellent — they're the gold standard for live
  traffic, rendered maps, and the long tail of edge cases.</strong>
  open-distance doesn't try to compete on quality. It's just free.</p>
  <p>Use it as your first layer: try our distance matrix first, cache the result.
  If the per-endpoint confidence (<code>rooftop</code> /
  <code>interpolated</code>) is good enough for your use case, you're done.
  If you need traffic-aware routing or the geocode came back low-confidence,
  fall back to a paid API for those queries only. Most applications need the
  premium answer for less than 100% of their requests.</p>
</div>

<section class="try-card" aria-labelledby="try-it">
  <h2 id="try-it">Try it</h2>
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
</section>

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
   (no live traffic).</p>

<p>Measured against Google Distance Matrix on a 44-route sample spanning
   short urban, suburban commute, inter-city, long-haul, rural, and
   cross-state edges (see <a href="https://github.com/kurtpayne/open-distance/blob/main/scripts/benchmark_vs_google.py">scripts/benchmark_vs_google.py</a>
   for the exact route list):</p>
<table>
<thead>
  <tr><th>Category</th><th>Routes</th><th>Distance Δ (median)</th><th>Distance Δ (p90)</th><th>Time Δ (median)</th><th>Time Δ (p90)</th></tr>
</thead>
<tbody>
  <tr><td>Inter-city</td><td>4</td><td><strong>1.2 %</strong></td><td>1.9 %</td><td><strong>3.0 %</strong></td><td>5.0 %</td></tr>
  <tr><td>Long-haul</td><td>8</td><td><strong>0.7 %</strong></td><td>9.0 %</td><td><strong>2.0 %</strong></td><td>13.8 %</td></tr>
  <tr><td>Rural</td><td>5</td><td><strong>0.5 %</strong></td><td>3.6 %</td><td>7.0 %</td><td>24.8 %</td></tr>
  <tr><td>Commute</td><td>8</td><td>5.1 %</td><td>58.0 %</td><td>29.7 %</td><td>52.9 %</td></tr>
  <tr><td>Cross-state</td><td>6</td><td>10.4 %</td><td>13.1 %</td><td>29.5 %</td><td>60.6 %</td></tr>
  <tr><td>Traffic-prone</td><td>6</td><td>11.0 %</td><td>39.7 %</td><td>35.7 %</td><td>63.4 %</td></tr>
  <tr><td>Short urban</td><td>4</td><td>25.1 %</td><td>41.1 %</td><td>70.9 %</td><td>80.8 %</td></tr>
</tbody>
</table>

<p><strong>How to read this</strong>: distance is the road-network shortest
   path; time is free-flow. The commercial reference includes a traffic
   model we don't, so the time gap on commute / traffic / cross-state
   categories is expected and honest. Distance numbers are within ~1 % on
   inter-city, long, and rural routes; gap on short-urban traffic-modeled
   routes is largely about which one-way the router prefers.</p>
<p><strong>What we know is broken right now</strong>: 3 cross-country routes
   (NYC↔LA, Seattle↔Miami, Boston↔Houston) return <code>ZERO_RESULTS</code>
   because the highway overlay that handles >~1500 mi paths is in a memory
   rework. The other 41 of 44 sample routes return real answers.</p>
<ul>
  <li><strong>Geocode confidence</strong>: rooftop (NAD / OpenAddresses) is
      comparable to a commercial geocoder; interpolated (OSM / TIGER) is
      typically within ~30–100 m of the actual building.</li>
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
<div class="cmp-wrap">
<table class="cmp">
  <thead>
    <tr><th scope="col"></th><th scope="col">OSRM</th><th scope="col">Valhalla</th><th scope="col">open-distance</th><th scope="col">Google / commercial</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">Deploy model</th><td>Self-host server (VM)</td><td>Self-host server (VM)</td><td>Cloudflare Worker (edge)</td><td>SaaS</td></tr>
    <tr><th scope="row">Cost (US-48)</th><td>~$50–200/mo VM</td><td>~$50–200/mo VM</td><td>~$5–10/mo Cloudflare</td><td>Per-call ($)</td></tr>
    <tr><th scope="row">Cold start</th><td>Minutes (load graph)</td><td>Seconds (tile lazy-load)</td><td>~30 ms isolate</td><td>n/a</td></tr>
    <tr><th scope="row">Raw routing speed</th><td>Best-in-class (CH)</td><td>Good (tiled)</td><td>Good; slower cross-country before L1 overlay</td><td>Fast</td></tr>
    <tr><th scope="row">Route geometry</th><td>Yes</td><td>Yes</td><td>No (scalar distance + duration)</td><td>Yes</td></tr>
    <tr><th scope="row">Turn-by-turn</th><td>Yes</td><td>Yes</td><td>No</td><td>Yes</td></tr>
    <tr><th scope="row">Live traffic</th><td>No</td><td>Plugin</td><td>No</td><td>Yes</td></tr>
    <tr><th scope="row">Geocoder</th><td>BYO (Nominatim)</td><td>BYO</td><td>Built-in (NAD + OA + OSM + TIGER)</td><td>Built-in</td></tr>
    <tr><th scope="row">API shape</th><td>OSRM JSON</td><td>Valhalla JSON</td><td>Google Distance Matrix JSON</td><td>(varies)</td></tr>
    <tr><th scope="row">License</th><td>BSD-2</td><td>MIT</td><td>Apache 2.0</td><td>Proprietary</td></tr>
  </tbody>
</table>
</div>
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
<thead><tr><th scope="col">Value</th><th scope="col">Means</th><th scope="col">Typical accuracy</th></tr></thead>
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
<thead><tr><th scope="col">Header</th><th scope="col">What it means</th></tr></thead>
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
  <li>No <code>fare</code>, <code>duration_in_traffic</code>, <code>geocoded_waypoints</code>, or <code>warnings</code> fields. <code>copyrights</code> IS populated (ODbL §4.3 Produced Work notice + pointer to <a href="/attribution">/attribution</a>).</li>
  <li><code>place_id:</code> inputs return <code>NOT_FOUND</code>.</li>
  <li>Only <code>mode=driving</code> is supported.</li>
  <li><code>match</code> arrays added (the legacy schema ignores unknown fields, so existing clients are unaffected).</li>
  <li>Centroid-quality geocodes return <code>NOT_FOUND</code> rather than confidently-wrong distances.</li>
</ul>

<h2>Other endpoints</h2>
<table>
<thead><tr><th scope="col">Path</th><th scope="col">What it returns</th></tr></thead>
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

export function renderAttribution(): string {
  const body = `
<h2>Attribution</h2>
<p>open-distance is computed from third-party open data. The notices below
   must travel with any work derived from those sources (per their licenses).
   The canonical text is in the
   <a href="https://github.com/kurtpayne/open-distance/blob/main/NOTICE">NOTICE</a>
   file in the repository; the same content is reproduced here so it's
   reachable without leaving the deployed site.</p>

<h3>Road network — OpenStreetMap (ODbL 1.0)</h3>
<p>Source: <a href="https://download.geofabrik.de/">Geofabrik</a> per-state PBF
   extracts. Licensed under the
   <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License, version 1.0</a>.</p>
<p>The road graph tile binaries served from R2 (<code>tiles/&lt;version&gt;/&lt;tx&gt;_&lt;ty&gt;.bin</code>)
   are a Derivative Database of OpenStreetMap. Per ODbL §4.3, every Produced
   Work computed from that Database — including every API response from
   open-distance — must carry the following notice:</p>
<blockquote>
  © OpenStreetMap contributors. Map data available under the
  <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL) v1.0</a>.
</blockquote>
<p>open-distance does not publish the Derivative Database itself — only the
   Produced Works (scalar distance/duration responses) generated from it. The
   unmodified upstream OSM extracts remain available at Geofabrik under their
   original ODbL terms; no separate offer of the source data is made by this
   project.</p>
<p>Operators of forks that publish the tile binaries directly inherit the
   ODbL §4.4(b) share-alike obligation: the published Derivative Database
   must itself be available under ODbL.</p>

<h3>Addresses — NAD (US DOT, public domain)</h3>
<p>National Address Database, U.S. Department of Transportation. Public
   domain under 17 U.S.C. § 105 (work of the federal government). No
   attribution is legally required. We acknowledge it anyway:</p>
<blockquote>Address data provided by the U.S. DOT National Address Database.</blockquote>

<h3>Addresses — OpenAddresses (per-source)</h3>
<p>Per-source per-county and per-city authorities aggregated at
   <a href="https://batch.openaddresses.io/">batch.openaddresses.io</a>. Each
   source carries its own license; the per-source attribution is enumerated
   machine-readably at
   <a href="/attribution/openaddresses.json"><code>/attribution/openaddresses.json</code></a>.
   A blanket attribution line:</p>
<blockquote>
  Address data from <a href="https://openaddresses.io/">OpenAddresses</a>, used
  under the per-source terms documented in the OA manifest.
</blockquote>

<h3>Addresses (supplementary) — OpenStreetMap <code>addr:*</code> nodes</h3>
<p>Same ODbL 1.0 terms as the road network attribution above. The same
   Produced Work notice applies.</p>

<h3>Street segments — TIGER/Line 2024 (US Census, public domain)</h3>
<p>TIGER/Line 2024 release, U.S. Census Bureau. Public domain. No
   attribution required. We acknowledge it anyway:</p>
<blockquote>Street segment data from the U.S. Census Bureau TIGER/Line 2024.</blockquote>

<h3>Code dependencies</h3>
<p>All runtime and dev dependencies are MIT, ISC, Apache-2.0, BSD, or
   similarly permissive. The only copyleft component in the dependency tree
   is LGPL-3.0-or-later on <code>sharp-libvips</code> native binaries, which
   are wrangler dev-only and never shipped to Cloudflare or to end-users.
   See
   <a href="https://github.com/kurtpayne/open-distance/blob/main/package-lock.json">package-lock.json</a>
   for the full SPDX inventory.</p>

<h3>How attribution travels with API responses</h3>
<p>Every Distance Matrix JSON response carries a <code>copyrights</code>
   field reproducing the required short-form notice. The
   <a href="/coverage">/coverage</a> endpoint includes per-source license URLs
   and a pointer back to this page. The Yoke score badge in the footer is
   the only external image surface; everything else is served same-origin.</p>
`;
  return shell("open-distance — attribution", body);
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
