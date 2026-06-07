// HTML site served alongside the JSON API. Self-contained per page (inline
// CSS + JS, vanilla, no build step). Two hi-fi public pages — homepage with a
// live calculator + terminal, and an API reference — plus three utility prose
// pages (privacy + attribution + coverage) sharing a simpler shell.

import { STATE_CODES } from "./state_parser";
import { PANEL_SNAPSHOT } from "./panel_data";

const SITE_DESCRIPTION =
  "Free open-source distance and duration matrix API for the continental US. " +
  "No API key, no registration, response-compatible with the legacy Distance " +
  "Matrix JSON shape. Fork and self-host for less than $10/month on Cloudflare.";

const SITE_KEYWORDS =
  "free maps api, free distance matrix api, distance matrix api, " +
  "open source distance api, free distance api, free geocoder, " +
  "free routing api, free driving distance api, " +
  "openstreetmap distance api, self-hosted maps api, " +
  "alternative to commercial maps api";

// JSON-LD machine description. Same payload on every page; agents and search
// engines pick it up without scraping the prose.
function jsonLd(): string {
  return JSON.stringify({
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
        "softwareVersion": "1.0",
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
        "license": "https://www.apache.org/licenses/LICENSE-2.0",
        "codeRepository": "https://github.com/kurtpayne/open-distance",
        "description": SITE_DESCRIPTION,
        "featureList": [
          "Distance matrix between addresses or coordinates",
          "Legacy Distance Matrix JSON wire format",
          "Per-endpoint geocode confidence indicator",
          "Cacheable responses, no key required",
          "Continental US coverage incl. cross-country highway overlay",
          "Free, open-source under Apache 2.0",
        ],
      },
    ],
  });
}

function headMeta(title: string, path: string): string {
  const canonical = `https://open-distance.com${path}`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${SITE_DESCRIPTION}">
<meta name="robots" content="index,follow">
<meta name="theme-color" content="#d8542b">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${SITE_DESCRIPTION}">
<meta property="og:url" content="${canonical}">
<meta property="og:site_name" content="open-distance">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${SITE_DESCRIPTION}">
<script type="application/ld+json">${jsonLd()}</script>
<link rel="preload" href="/fonts/space-grotesk.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/jetbrains-mono.woff2" as="font" type="font/woff2" crossorigin>`;
}

// Design tokens shared across all pages.
const TOKENS = `
@font-face{
  font-family:'Space Grotesk';
  font-style:normal;
  font-weight:100 900;
  font-display:swap;
  src:url('/fonts/space-grotesk.woff2') format('woff2');
}
@font-face{
  font-family:'JetBrains Mono';
  font-style:normal;
  font-weight:100 900;
  font-display:swap;
  src:url('/fonts/jetbrains-mono.woff2') format('woff2');
}
:root{
  --paper:#f3f0e8; --paper2:#eae4d6; --card:#fbf9f4; --raise:#fffefb;
  --ink:#15130d; --ink2:#5b564b; --ink3:#8b8576;
  --line:rgba(21,19,13,.14); --line2:rgba(21,19,13,.07);
  --accent:#d8542b; --accent2:#b1401f; --accent-soft:rgba(216,84,43,.10);
  --ok:#1e7a48; --ok-soft:rgba(30,122,72,.10);
  --term-bg:#1a1812; --term-fg:#ece6d8; --term-dim:#8b8473;
  --term-key:#f0b07a; --term-str:#b9d488; --term-num:#e7c279; --term-pun:#cfc9ba;
  --font-display:'Space Grotesk',sans-serif;
  --font-body:'Space Grotesk',sans-serif;
  --font-mono:'JetBrains Mono',monospace;
  --pad-sec:96px;
  --maxw:1160px;
}
*{box-sizing:border-box}[hidden]{display:none!important}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-body);
  font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:inherit;text-decoration:none}
.wrap{max-width:var(--maxw);margin:0 auto;padding:0 28px}
.mono{font-family:var(--font-mono)}
.eyebrow{font-family:var(--font-mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3);font-weight:500}
header.bar{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--paper) 86%,transparent);
  backdrop-filter:blur(10px);border-bottom:1px solid var(--line2)}
.bar-in{display:flex;align-items:center;justify-content:space-between;height:64px}
.brand{display:flex;align-items:center;gap:9px;white-space:nowrap;font-family:var(--font-mono);font-weight:600;font-size:16px;letter-spacing:-.01em;color:var(--ink)}
.brand .mk{width:22px;height:22px;border:2px solid var(--ink);border-radius:50%;display:grid;place-items:center;position:relative}
.brand .mk::before{content:"";width:2px;height:11px;background:var(--accent);transform:rotate(34deg);border-radius:2px}
.brand .mk::after{content:"";position:absolute;width:5px;height:5px;background:var(--ink);border-radius:50%}
nav.links{display:flex;align-items:center;gap:26px}
nav.links a{font-size:14.5px;color:var(--ink2);font-weight:500}
nav.links a:hover{color:var(--ink)}
nav.links a.on{color:var(--ink)}
.ghost-btn{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:600;
  border:1.5px solid var(--ink);border-radius:9px;padding:7px 13px;background:transparent;cursor:pointer;color:var(--ink)}
.ghost-btn:hover{background:var(--ink);color:var(--paper)}
`;

// Homepage-only CSS.
const HOME_CSS = TOKENS + `
.hero{padding:64px 0 28px}
.hero h1{font-family:var(--font-display);font-weight:600;font-size:clamp(38px,5.3vw,66px);
  line-height:1.02;letter-spacing:-.025em;margin:18px 0 0;max-width:14ch}
.hero h1 em{font-style:normal;color:var(--accent2)}
.hero .lede{font-size:clamp(17px,1.7vw,20px);color:var(--ink2);max-width:54ch;margin:20px 0 0;line-height:1.55}
.hero .lede b{color:var(--ink);font-weight:600}
.instrument{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.04fr);gap:18px;margin-top:38px;align-items:stretch}

.calc{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;display:flex;flex-direction:column;
  box-shadow:0 1px 0 var(--raise) inset, 0 14px 34px -28px rgba(21,19,13,.5)}
.calc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.seg{display:inline-flex;background:var(--paper2);border:1px solid var(--line);border-radius:8px;padding:2px}
.seg button{font-family:var(--font-mono);font-size:12px;font-weight:600;border:0;background:transparent;color:var(--ink2);
  padding:5px 11px;border-radius:6px;cursor:pointer}
.seg button.on{background:var(--raise);color:var(--ink);box-shadow:0 1px 2px rgba(21,19,13,.12)}
.fields{display:flex;flex-direction:column;gap:10px}
.field{display:flex;align-items:center;gap:11px;background:var(--raise);border:1px solid var(--line);border-radius:11px;padding:0 13px}
.field:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.pin{flex:none;width:13px;height:13px;border-radius:50%;border:2px solid var(--ink2)}
.pin.b{background:var(--accent);border-color:var(--accent)}
.field input{flex:1;border:0;background:transparent;outline:0;font-family:var(--font-body);font-size:15.5px;color:var(--ink);
  padding:14px 0;font-weight:500}
.field input::placeholder{color:var(--ink3)}
.leg{display:flex;justify-content:center;padding:3px 0}
.leg span{font-family:var(--font-mono);font-size:11px;color:var(--ink3)}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px}
.chip{font-family:var(--font-mono);font-size:11.5px;font-weight:500;color:var(--ink2);background:var(--paper2);
  border:1px solid var(--line);border-radius:100px;padding:4px 11px;cursor:pointer;white-space:nowrap}
.chip:hover{border-color:var(--ink2);color:var(--ink)}
.calc-btn{margin-top:15px;width:100%;border:0;background:var(--accent);color:#fff;font-family:var(--font-display);
  font-weight:600;font-size:16px;border-radius:11px;padding:14px;cursor:pointer;letter-spacing:.01em;
  box-shadow:0 10px 22px -12px var(--accent);transition:transform .08s,filter .15s}
.calc-btn:hover{filter:brightness(1.05)}
.calc-btn:active{transform:translateY(1px)}
.calc-btn[data-busy="1"]{filter:saturate(.5);pointer-events:none}

.readout{margin-top:18px;border-top:1px dashed var(--line);padding-top:16px;display:flex;align-items:flex-end;justify-content:space-between;gap:14px}
.ro-metric .ro-l{font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3)}
.ro-metric .ro-v{font-family:var(--font-mono);font-weight:500;font-size:clamp(34px,4.2vw,50px);line-height:1;letter-spacing:-.02em;margin-top:5px}
.ro-metric .ro-v small{font-size:.4em;color:var(--ink2);font-weight:500;letter-spacing:0;margin-left:3px}
.ro-badges{display:flex;flex-direction:column;gap:6px;align-items:flex-end}
.badge{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11px;font-weight:500;
  color:var(--ok);background:var(--ok-soft);border:1px solid color-mix(in srgb,var(--ok) 28%,transparent);border-radius:100px;padding:3px 9px}
.badge.dim{color:var(--ink3);background:var(--paper2);border-color:var(--line)}
.readout-err{margin-top:14px;font-family:var(--font-mono);font-size:13px;color:var(--accent2);background:var(--accent-soft);
  border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);border-radius:10px;padding:10px 13px}

#matrixView{margin-top:2px}
.mx-group{margin-bottom:13px}
.mx-label{display:flex;align-items:center;gap:8px;font-family:var(--font-mono);font-size:12px;color:var(--ink2);margin-bottom:8px;font-weight:500}
.mx-label .pin{width:11px;height:11px}
.mx-count{margin-left:auto;color:var(--ink3)}
.mx-list{display:flex;flex-direction:column;gap:7px}
.mx-row{display:flex;align-items:center;gap:6px;background:var(--raise);border:1px solid var(--line);border-radius:9px;padding:0 6px 0 11px}
.mx-row:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.mx-row input{flex:1;min-width:0;border:0;background:transparent;outline:0;font-family:var(--font-body);font-size:14px;color:var(--ink);padding:11px 0;font-weight:500}
.mx-row .rm{flex:none;width:24px;height:24px;border:0;background:transparent;color:var(--ink3);cursor:pointer;font-size:17px;line-height:1;border-radius:6px}
.mx-row .rm:hover{background:var(--paper2);color:var(--accent2)}
.mx-row .rm:disabled{opacity:.25;cursor:not-allowed}
.mx-add{margin-top:7px;font-family:var(--font-mono);font-size:12px;font-weight:500;color:var(--accent2);background:transparent;
  border:1px dashed var(--line);border-radius:8px;padding:8px 12px;cursor:pointer;width:100%}
.mx-add:hover{border-color:var(--accent2);background:var(--accent-soft)}
.mx-add:disabled{opacity:.4;cursor:not-allowed;color:var(--ink3)}
.mxgrid{margin-top:16px;border-top:1px dashed var(--line);padding-top:14px;overflow-x:auto}
.mxgrid table{border-collapse:collapse;width:100%;font-family:var(--font-mono)}
.mxgrid th,.mxgrid td{border:1px solid var(--line2);padding:7px 9px;text-align:center;white-space:nowrap}
.mxgrid th{background:var(--paper2);color:var(--ink3);font-weight:500;font-size:11px;letter-spacing:.02em}
.mxgrid th.corner{background:transparent;border-color:transparent}
.mxgrid th.rowh{text-align:left;color:var(--ink2)}
.mxgrid td .d{font-weight:500;color:var(--ink);font-size:14px}
.mxgrid td .t{color:var(--ink3);font-size:11px;display:block;margin-top:1px}
.mxgrid td.interp{background:var(--accent-soft)}
.mxgrid td.miss{color:var(--ink3);font-size:11px}
.mx-foot{display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-family:var(--font-mono);font-size:11px;color:var(--ink3)}

.term{background:var(--term-bg);border-radius:16px;border:1px solid rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 18px 40px -26px rgba(0,0,0,.7)}
.term-head{display:flex;align-items:center;gap:8px;padding:13px 15px;border-bottom:1px solid rgba(255,255,255,.07)}
.term-head .tl{display:flex;gap:7px}
.term-head .tl i{width:11px;height:11px;border-radius:50%;display:block;opacity:.9}
.tl i:nth-child(1){background:#f0584f}.tl i:nth-child(2){background:#f5be4f}.tl i:nth-child(3){background:#62c554}
.term-title{font-family:var(--font-mono);font-size:12px;color:var(--term-dim);margin-left:4px}
.term-copy{margin-left:auto;font-family:var(--font-mono);font-size:11px;color:var(--term-dim);background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:4px 9px;cursor:pointer}
.term-copy:hover{color:var(--term-fg);background:rgba(255,255,255,.12)}
.term-body{font-family:var(--font-mono);font-size:13px;line-height:1.75;color:var(--term-fg);padding:16px 18px;overflow:auto;flex:1;white-space:pre-wrap;word-break:break-word}
.term-body .pun{color:var(--term-pun)}.term-body .key{color:var(--term-key)}.term-body .str{color:var(--term-str)}
.term-body .num{color:var(--term-num)}.term-body .cmt{color:var(--term-dim)}.term-body .pr{color:var(--accent)}
.cursor{display:inline-block;width:8px;height:15px;background:var(--term-fg);vertical-align:-2px;animation:blink 1.1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion: reduce){.cursor{animation:none}}

.trust{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-top:30px;padding:16px 0;border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)}
.tg{display:inline-flex;align-items:center;gap:7px;font-family:var(--font-mono);font-size:12.5px;color:var(--ink2)}
.tg b{color:var(--ink);font-weight:600}
.tg .tick{color:var(--ok);font-weight:700}
.trust .sep{width:1px;height:16px;background:var(--line);margin:0 2px}

section.band{padding:var(--pad-sec) 0}
.sec-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:40px;flex-wrap:wrap}
.sec-head h2{font-family:var(--font-display);font-weight:600;font-size:clamp(28px,3.4vw,42px);letter-spacing:-.02em;margin:10px 0 0;line-height:1.05;max-width:18ch}
.sec-head p{color:var(--ink2);max-width:46ch;margin:0}

.truth{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.truth-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px}
.truth-card h3{font-family:var(--font-display);font-size:20px;font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:9px}
.truth-card .sub{font-size:14px;color:var(--ink3);margin:0 0 18px}
.tlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:13px}
.tlist li{display:flex;gap:11px;align-items:flex-start;font-size:16px}
.tlist .gi{flex:none;width:21px;height:21px;border-radius:6px;display:grid;place-items:center;font-family:var(--font-mono);font-size:13px;font-weight:700;margin-top:1px}
.tlist.yes .gi{background:var(--ok-soft);color:var(--ok)}
.tlist.no .gi{background:var(--paper2);color:var(--ink3)}
.tlist li b{font-weight:600}
.tlist li span{color:var(--ink2);font-size:14px}
.pinline{margin-top:22px;text-align:center;font-family:var(--font-mono);font-size:14px;color:var(--ink2);
  border:1px dashed var(--line);border-radius:12px;padding:14px}
.pinline b{color:var(--ink);background:linear-gradient(transparent 62%,var(--accent-soft) 62%);padding:0 3px}

.qs{display:grid;grid-template-columns:1.1fr 1fr;gap:36px;align-items:start}
.steps{display:flex;flex-direction:column;gap:22px}
.step{display:flex;gap:16px}
.step .num{flex:none;width:30px;height:30px;border-radius:9px;background:var(--ink);color:var(--paper);
  font-family:var(--font-mono);font-weight:700;font-size:14px;display:grid;place-items:center}
.step h4{margin:3px 0 4px;font-size:18px;font-weight:600;font-family:var(--font-display)}
.step p{margin:0;color:var(--ink2);font-size:15px}
.step code{font-family:var(--font-mono);font-size:13.5px;background:var(--paper2);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.codecard{background:var(--term-bg);border-radius:16px;overflow:hidden;border:1px solid rgba(0,0,0,.3);box-shadow:0 18px 40px -28px rgba(0,0,0,.6)}
.codecard .tabs{display:flex;gap:4px;padding:11px 13px 0}
.codecard .tabs button{font-family:var(--font-mono);font-size:12px;color:var(--term-dim);background:transparent;border:0;
  padding:7px 12px;border-radius:8px 8px 0 0;cursor:pointer}
.codecard .tabs button.on{color:var(--term-fg);background:rgba(255,255,255,.06)}
.codecard pre{margin:0;font-family:var(--font-mono);font-size:13px;line-height:1.7;color:var(--term-fg);padding:16px 18px;overflow:auto;white-space:pre}
.codecard pre .pun{color:var(--term-pun)}.codecard pre .key{color:var(--term-key)}.codecard pre .str{color:var(--term-str)}.codecard pre .cmt{color:var(--term-dim)}.codecard pre .num{color:var(--term-num)}

.faq-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:26px}
.faq-tabs button{font-family:var(--font-mono);font-size:13px;font-weight:500;color:var(--ink2);background:var(--card);
  border:1px solid var(--line);border-radius:100px;padding:8px 16px;cursor:pointer;white-space:nowrap}
.faq-tabs button.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.qa{display:flex;flex-direction:column;border-top:1px solid var(--line)}
.qa details{border-bottom:1px solid var(--line)}
.qa summary{list-style:none;cursor:pointer;padding:20px 4px;display:flex;align-items:center;justify-content:space-between;gap:18px;
  font-family:var(--font-display);font-weight:500;font-size:18px}
.qa summary::-webkit-details-marker{display:none}
.qa summary .pl{flex:none;width:22px;height:22px;position:relative}
.qa summary .pl::before,.qa summary .pl::after{content:"";position:absolute;background:var(--accent2);border-radius:2px;transition:.2s}
.qa summary .pl::before{top:10px;left:3px;width:16px;height:2px}
.qa summary .pl::after{top:3px;left:10px;width:2px;height:16px}
.qa details[open] summary .pl::after{transform:rotate(90deg);opacity:0}
.qa .ans{padding:0 4px 22px;color:var(--ink2);font-size:16px;max-width:74ch;line-height:1.6}
.qa .ans code{font-family:var(--font-mono);font-size:13.5px;background:var(--paper2);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.qa .ans a{color:var(--accent2);border-bottom:1px solid var(--accent-soft)}

.cmp{margin-top:30px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card)}
.cmp-row{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;align-items:center}
.cmp-row>div{padding:14px 16px;font-size:14px}
.cmp-row:not(:last-child){border-bottom:1px solid var(--line2)}
.cmp-head{background:var(--paper2)}
.cmp-head>div{font-family:var(--font-mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink3)}
.cmp-row .nm{font-weight:600;font-family:var(--font-display)}
.cmp-row.me{background:var(--accent-soft)}
.cmp-row.me .nm{color:var(--accent2)}

footer{border-top:1px solid var(--line);padding:54px 0 40px;margin-top:40px}
.foot-top{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:30px}
.foot-brand p{color:var(--ink2);font-size:14px;max-width:34ch;margin:14px 0 0}
.foot-col h5{font-family:var(--font-mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);margin:0 0 14px;font-weight:500}
.foot-col a{display:block;color:var(--ink2);font-size:14.5px;margin-bottom:10px}
.foot-col a:hover{color:var(--ink)}
.foot-bottom{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px;margin-top:46px;padding-top:22px;border-top:1px solid var(--line2)}
.foot-bottom .mono{font-size:12.5px;color:var(--ink3)}
.disclaimer{font-family:var(--font-mono);font-size:12px;color:var(--ink3);background:var(--paper2);border:1px solid var(--line);
  border-radius:10px;padding:11px 14px;max-width:52ch;line-height:1.5;margin-top:18px}

@media(max-width:900px){
  .instrument,.truth,.qs,.foot-top{grid-template-columns:1fr}
  .cmp-row{grid-template-columns:1.4fr .8fr .8fr .8fr}
  .foot-top{gap:34px}
}
@media(max-width:620px){
  nav.links a:not(.ghost-btn){display:none}
  .cmp-row{grid-template-columns:1.3fr .7fr .7fr .7fr}
  .cmp-row>div{padding:11px 10px;font-size:12.5px}
}
`;

// Homepage JS. Wired to the real API at /maps/api/distancematrix/json.
// SCENARIOS only carries input strings; results come from the live response.
const HOME_JS = `
(function(){
  'use strict';
  var $=function(s,r){return (r||document).querySelector(s)};
  var $$=function(s,r){return [].slice.call((r||document).querySelectorAll(s))};

  // Example chips carry input strings only — results come from the real API.
  var SCENARIOS={
    sf:{o:'Stanford, CA',d:'San Francisco, CA'},
    tx:{o:'Austin, TX',d:'Dallas, TX'},
    ny:{o:'Brooklyn, NY',d:'Newark, NJ'},
    fl:{o:'Miami, FL',d:'Orlando, FL'}
  };

  var state={
    units:'imperial', mode:'single',
    // cur: latest single result. Fields populated from the live response.
    cur:{o:'Austin, TX', d:'Dallas, TX',
         oa:'', da:'', mi:null, min:null, om:'', dm:'', err:null,
         distText:'', durText:''},
    mO:['Austin, TX','Houston, TX'],
    mD:['Dallas, TX','San Antonio, TX'],
    mMatrix:null
  };
  var KM=1.609344;

  function esc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
  function encQ(s){return encodeURIComponent(s).replace(/%20/g,'+').replace(/%2C/g,',')}
  function distText(mi){
    if (mi==null) return {v:'—',u:''};
    if (state.units==='metric'){return {v:(mi*KM).toFixed(1),u:'km'}}
    return {v:mi.toFixed(1),u:'mi'}
  }
  function durText(min){
    if (min==null) return '—';
    var h=Math.floor(min/60), m=min%60;
    return h ? (h+' hour'+(h>1?'s':'')+' '+m+' min') : (m+' mins');
  }

  // ---- render readout ----
  function renderReadout(){
    var c=state.cur;
    var ro=$('#readout'), err=$('#readoutErr');
    if (c.err){
      ro.hidden=true;
      err.hidden=false;
      err.textContent=c.err;
      return;
    }
    err.hidden=true; ro.hidden=false;
    var dt=distText(c.mi);
    $('#roDist').innerHTML = c.mi==null ? '—' : (dt.v+'<small>'+dt.u+'</small>');
    if (c.min==null){ $('#roTime').innerHTML='—'; }
    else {
      var h=Math.floor(c.min/60), m=c.min%60;
      $('#roTime').innerHTML = h ? (h+'<small>h</small> '+m+'<small>min</small>') : (m+'<small>min</small>');
    }
    var badge=function(lbl,m){
      var cls = (m==='rooftop' || m==='coords') ? '' : 'dim';
      return '<span class="badge '+cls+'">'+lbl+' · '+(m||'—')+'</span>';
    };
    $('#roBadges').innerHTML = badge('origin', c.om) + badge('dest', c.dm);
  }

  // ---- syntax-highlight a JSON value into our terminal classes ----
  function hlJSON(obj){
    var json = JSON.stringify(obj, null, 2);
    var escaped = json.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Highlight keys, string values, numbers, punctuation. Order matters.
    return escaped.replace(/("(?:[^"\\\\]|\\\\.)*")(\\s*:)/g,
        '<span class="key">$1</span>$2')
      .replace(/:(\\s*)("(?:[^"\\\\]|\\\\.)*")/g,
        ':$1<span class="str">$2</span>')
      .replace(/(\\s|,|\\[)(-?\\d+(?:\\.\\d+)?)(?=[,\\s\\]\\}])/g,
        '$1<span class="num">$2</span>')
      .replace(/([\\[\\]\\{\\},])/g, '<span class="pun">$1</span>');
  }

  // ---- terminal ----
  function curlSingle(){
    var c=state.cur;
    return 'curl "https://open-distance.com/maps/api/distancematrix/json?origins='+encQ(c.o)+'&destinations='+encQ(c.d)+'&units='+state.units+'"';
  }
  function curlMatrix(m){
    var oj = m.origins.map(function(x){return encQ(x.raw)}).join('|');
    var dj = m.dests.map(function(x){return encQ(x.raw)}).join('|');
    return 'curl "https://open-distance.com/maps/api/distancematrix/json?origins='+oj+'&destinations='+dj+'&units='+state.units+'"';
  }
  function termCurlSingleHTML(){
    var c=state.cur;
    return '<span class="cmt">$</span> <span class="pr">curl</span> <span class="str">"https://open-distance.com/maps/api/\\\\</span>\\n'+
           '<span class="str">  distancematrix/json\\\\</span>\\n'+
           '<span class="str">  ?origins='+esc(encQ(c.o))+'\\\\</span>\\n'+
           '<span class="str">  &destinations='+esc(encQ(c.d))+'\\\\</span>\\n'+
           '<span class="str">  &units='+state.units+'"</span>\\n';
  }
  function termCurlMatrixHTML(m){
    var oj = m.origins.map(function(x){return encQ(x.raw)}).join('|');
    var dj = m.dests.map(function(x){return encQ(x.raw)}).join('|');
    return '<span class="cmt">$</span> <span class="pr">curl</span> <span class="str">"https://open-distance.com/maps/api/\\\\</span>\\n'+
           '<span class="str">  distancematrix/json\\\\</span>\\n'+
           '<span class="str">  ?origins='+esc(oj)+'\\\\</span>\\n'+
           '<span class="str">  &destinations='+esc(dj)+'\\\\</span>\\n'+
           '<span class="str">  &units='+state.units+'"</span>\\n';
  }

  function renderTerminalLoading(label){
    var head = state.mode==='matrix' && state.mMatrix
      ? termCurlMatrixHTML(state.mMatrix)
      : termCurlSingleHTML();
    $('#termBody').innerHTML = head + '\\n<span class="cmt"># '+label+'</span><span class="cursor"></span>';
  }
  function renderTerminalResponse(json){
    var head = state.mode==='matrix' && state.mMatrix
      ? termCurlMatrixHTML(state.mMatrix)
      : termCurlSingleHTML();
    $('#termBody').innerHTML = head + '\\n' + hlJSON(json);
  }
  function renderTerminalError(msg){
    var head = state.mode==='matrix' && state.mMatrix
      ? termCurlMatrixHTML(state.mMatrix)
      : termCurlSingleHTML();
    $('#termBody').innerHTML = head + '\\n<span class="cmt"># error: '+esc(msg)+'</span>';
  }

  // ---- API calls ----
  function apiUrl(origins, dests){
    var p = new URLSearchParams({origins:origins, destinations:dests, units:state.units});
    return '/maps/api/distancematrix/json?' + p.toString();
  }
  async function fetchMatrix(origins, dests){
    var r = await fetch(apiUrl(origins, dests), {headers:{'accept':'application/json'}});
    var json = await r.json();
    return json;
  }

  // ---- calculate (single) ----
  var busy=false;
  async function calculate(){
    if (busy) return;
    var o = $('#origin').value.trim() || 'Austin, TX';
    var d = $('#dest').value.trim() || 'Dallas, TX';
    state.cur.o = o; state.cur.d = d;
    busy = true;
    var btn = $('#calcBtn'); btn.dataset.busy='1'; btn.textContent='Routing…';
    renderTerminalLoading('routing…');
    try {
      var json = await fetchMatrix(o, d);
      var rows = (json.rows || []);
      var el = (rows[0] && rows[0].elements && rows[0].elements[0]) || {};
      var oa = (json.origin_addresses || [])[0] || o;
      var da = (json.destination_addresses || [])[0] || d;
      var om = (json.origin_matches || [])[0] || '';
      var dm = (json.destination_matches || [])[0] || '';
      if (el.status !== 'OK') {
        state.cur = {o:o, d:d, oa:oa, da:da, om:om, dm:dm, mi:null, min:null,
                     err: 'No result · '+ (el.status || json.status || 'ERROR'),
                     distText:'', durText:''};
      } else {
        var meters = (el.distance && el.distance.value) || 0;
        var seconds = (el.duration && el.duration.value) || 0;
        state.cur = {o:o, d:d, oa:oa, da:da, om:om, dm:dm,
                     mi: meters/1609.344, min: Math.round(seconds/60),
                     err:null,
                     distText: (el.distance && el.distance.text) || '',
                     durText: (el.duration && el.duration.text) || ''};
      }
      renderReadout();
      renderTerminalResponse(json);
      renderCode();
    } catch (e) {
      state.cur.err = 'Network · ' + (e && e.message || e);
      state.cur.mi = null; state.cur.min = null;
      renderReadout();
      renderTerminalError(state.cur.err);
    } finally {
      btn.dataset.busy=''; btn.textContent='Calculate →';
      busy=false;
    }
  }

  // ---- matrix mode ----
  var MAX=5;
  function shortLabel(s){
    var t = (s.split(',')[0] || s).trim() || s.trim();
    return t.length>14 ? t.slice(0,13)+'\\u2026' : t;
  }
  function renderMatrixInputs(){
    var build = function(list, cls){
      return list.map(function(v,i){
        return '<div class="mx-row"><span class="pin'+(cls==='d'?' b':'')+'"></span>'+
          '<input data-side="'+cls+'" data-i="'+i+'" value="'+esc(v)+'" placeholder="address or lat,lng" autocomplete="off" spellcheck="false">'+
          '<button class="rm" data-side="'+cls+'" data-i="'+i+'" '+(list.length<=1?'disabled':'')+' title="remove">\\u00d7</button></div>';
      }).join('');
    };
    $('#oList').innerHTML = build(state.mO,'o');
    $('#dList').innerHTML = build(state.mD,'d');
    $('#oCount').textContent = state.mO.length+'/'+MAX;
    $('#dCount').textContent = state.mD.length+'/'+MAX;
    $('#oAdd').disabled = state.mO.length>=MAX;
    $('#dAdd').disabled = state.mD.length>=MAX;
  }
  function readMatrixInputs(){
    $$('#oList input').forEach(function(inp){state.mO[+inp.dataset.i]=inp.value});
    $$('#dList input').forEach(function(inp){state.mD[+inp.dataset.i]=inp.value});
  }
  function renderMatrixOut(m, lastJSON){
    var head = '<th class="corner"></th>' + m.dests.map(function(d){return '<th>'+esc(d.label)+'</th>'}).join('');
    var body = m.origins.map(function(o,i){
      var rowEls = (lastJSON && lastJSON.rows && lastJSON.rows[i] && lastJSON.rows[i].elements) || [];
      return '<tr><th class="rowh">'+esc(o.label)+'</th>' + m.dests.map(function(d,j){
        var el = rowEls[j] || {};
        var dm = (lastJSON && (lastJSON.destination_matches||[])[j]) || '';
        if (el.status !== 'OK'){
          return '<td class="miss">'+esc(el.status || '—')+'</td>';
        }
        var meters = (el.distance && el.distance.value) || 0;
        var seconds = (el.duration && el.duration.value) || 0;
        var dt = distText(meters/1609.344);
        var minutes = Math.round(seconds/60);
        var interp = dm==='interpolated' ? ' interp' : '';
        return '<td class="'+interp.trim()+'"><span class="d">'+dt.v+' '+dt.u+'</span><span class="t">'+durText(minutes)+'</span></td>';
      }).join('') + '</tr>';
    }).join('');
    var n = m.origins.length * m.dests.length;
    $('#matrixOut').innerHTML =
      '<div class="mxgrid"><table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div>' +
      '<div class="mx-foot"><span>'+m.origins.length+' \\u00d7 '+m.dests.length+' = '+n+' elements</span><span class="interp" style="padding:1px 7px;border-radius:4px;background:var(--accent-soft)">shaded = destination interpolated</span></div>';
  }
  var mbusy=false;
  async function calcMatrix(){
    if (mbusy) return;
    readMatrixInputs();
    mbusy=true;
    var btn=$('#calcBtn'); btn.dataset.busy='1'; btn.textContent='Routing\\u2026';
    var origins = state.mO.map(function(s){var v=s.trim()||'Origin';return {raw:v,label:shortLabel(v)}});
    var dests   = state.mD.map(function(s){var v=s.trim()||'Destination';return {raw:v,label:shortLabel(v)}});
    state.mMatrix = {origins:origins, dests:dests};
    renderTerminalLoading('routing '+(origins.length*dests.length)+' pairs\\u2026');
    try {
      var oq = origins.map(function(x){return x.raw}).join('|');
      var dq = dests.map(function(x){return x.raw}).join('|');
      var json = await fetchMatrix(oq, dq);
      renderMatrixOut(state.mMatrix, json);
      renderTerminalResponse(json);
      renderCode();
    } catch (e) {
      $('#matrixOut').innerHTML = '<div class="readout-err">Network · '+esc(e && e.message || e)+'</div>';
      renderTerminalError('Network · ' + (e && e.message || e));
    } finally {
      btn.dataset.busy=''; btn.textContent='Calculate \\u2192';
      mbusy=false;
    }
  }

  function setMode(m){
    if (state.mode===m) return;
    state.mode=m;
    $$('#mode button').forEach(function(x){x.classList.toggle('on', x.dataset.m===m)});
    var matrix = (m==='matrix');
    $('#singleView').hidden = matrix;
    $('#readout').hidden = matrix;
    $('#readoutErr').hidden = matrix || !state.cur.err;
    $('#matrixView').hidden = !matrix;
    $('#matrixOut').hidden = !matrix;
    if (matrix){
      renderMatrixInputs();
      if (!state.mMatrix){ calcMatrix(); }
    } else {
      renderReadout();
    }
    // Quickstart code snippet follows the calculator mode so single ↔ matrix
    // examples stay in sync with whatever the user is looking at above.
    renderCode();
  }

  // ---- wire ----
  $('#calcBtn').addEventListener('click', function(){
    if (state.mode==='matrix') calcMatrix(); else calculate();
  });
  $$('#examples .chip').forEach(function(ch){
    ch.addEventListener('click', function(){
      var sc = SCENARIOS[ch.dataset.k];
      $('#origin').value = sc.o;
      $('#dest').value = sc.d;
      calculate();
    });
  });
  $$('#mode button').forEach(function(b){
    b.addEventListener('click', function(){setMode(b.dataset.m)});
  });
  $('#oAdd').addEventListener('click', function(){
    if (state.mO.length<MAX){readMatrixInputs(); state.mO.push(''); renderMatrixInputs();}
  });
  $('#dAdd').addEventListener('click', function(){
    if (state.mD.length<MAX){readMatrixInputs(); state.mD.push(''); renderMatrixInputs();}
  });
  ['oList','dList'].forEach(function(id){
    $('#'+id).addEventListener('click', function(e){
      var rm = e.target.closest('.rm'); if (!rm) return;
      readMatrixInputs();
      var side = rm.dataset.side, i = +rm.dataset.i;
      var arr = side==='o' ? state.mO : state.mD;
      if (arr.length>1){arr.splice(i,1); renderMatrixInputs();}
    });
  });
  $$('#units button').forEach(function(b){
    b.addEventListener('click', function(){
      if (b.classList.contains('on')) return;
      $$('#units button').forEach(function(x){x.classList.remove('on')});
      b.classList.add('on');
      state.units = b.dataset.u;
      renderCode();
      if (state.mode==='matrix'){
        // Re-fetch with new units so server-formatted text is in the right unit
        if (state.mMatrix) calcMatrix();
      } else {
        calculate();
      }
    });
  });
  ['origin','dest'].forEach(function(id){
    $('#'+id).addEventListener('keydown', function(e){if (e.key==='Enter') calculate()});
  });
  $('#termCopy').addEventListener('click', function(){
    var text = state.mode==='matrix' && state.mMatrix ? curlMatrix(state.mMatrix) : curlSingle();
    copy(text, $('#termCopy'));
  });

  // ---- quickstart code tabs ----
  // The Quickstart code is a static 2x2 matrix example -- it's the canonical
  // "this is what an API call looks like" reference, independent of whatever
  // the calculator above happens to be doing. We pick a familiar Bay-Area
  // matrix so the wire format and the response shape are both obvious.
  function renderCode(){
    var tab = $('#codeTabs button.on').dataset.l;
    var base = 'https://open-distance.com/maps/api/distancematrix/json';
    var o = 'Austin, TX|Houston, TX';
    var d = 'Dallas, TX|San Antonio, TX';
    var html='';
    if (tab==='curl'){
      html = '<span class="cmt"># no key — just GET it</span>\\n'+
        '<span class="pr" style="color:var(--accent)">curl</span> <span class="str">"'+base+'\\\\\\n'+
        '  ?origins='+encQ(o)+'\\\\\\n'+
        '  &destinations='+encQ(d)+'\\\\\\n'+
        '  &units='+state.units+'"</span>';
    } else if (tab==='js'){
      html = '<span class="key">const</span> <span class="pun">p =</span> <span class="key">new</span> <span class="pun">URLSearchParams({</span>\\n'+
        '  <span class="str">origins</span><span class="pun">:</span> <span class="str">"'+esc(o)+'"</span><span class="pun">,</span>      <span class="cmt">// pipe-separated for matrix</span>\\n'+
        '  <span class="str">destinations</span><span class="pun">:</span> <span class="str">"'+esc(d)+'"</span><span class="pun">,</span>\\n'+
        '  <span class="str">units</span><span class="pun">:</span> <span class="str">"'+state.units+'"</span><span class="pun">,</span>\\n'+
        '<span class="pun">});</span>\\n'+
        '<span class="key">const</span> <span class="pun">r =</span> <span class="key">await</span> <span class="pun">fetch(</span><span class="str">\`'+base+'?\${p}\`</span><span class="pun">);</span>\\n'+
        '<span class="key">const</span> <span class="pun">{ rows } =</span> <span class="key">await</span> <span class="pun">r.json();</span>\\n'+
        '<span class="cmt">// rows[i].elements[j] = distance + duration for origin i to destination j</span>';
    } else {
      html = '<span class="key">import</span> <span class="pun">requests</span>\\n'+
        '<span class="pun">r = requests.get(</span>\\n'+
        '  <span class="str">"'+base+'"</span><span class="pun">,</span>\\n'+
        '  <span class="pun">params={</span><span class="str">"origins"</span><span class="pun">:</span> <span class="str">"'+esc(o)+'"</span><span class="pun">,</span>        <span class="cmt"># pipe-separated for matrix</span>\\n'+
        '          <span class="str">"destinations"</span><span class="pun">:</span> <span class="str">"'+esc(d)+'"</span><span class="pun">,</span>\\n'+
        '          <span class="str">"units"</span><span class="pun">:</span> <span class="str">"'+state.units+'"</span><span class="pun">})</span>\\n'+
        '<span class="pun">data = r.json()</span>\\n'+
        '<span class="cmt"># data["rows"][i]["elements"][j] = distance + duration, origin i to destination j</span>';
    }
    $('#codeBody').innerHTML = html;
  }
  $$('#codeTabs button').forEach(function(b){
    b.addEventListener('click', function(){
      $$('#codeTabs button').forEach(function(x){x.classList.remove('on')});
      b.classList.add('on');
      renderCode();
    });
  });

  // ---- FAQ ----
  var FAQ = {
    'Can do': [
      ['Do I really not need an API key?','Correct. The public endpoint takes no <code>key=</code> and has no signup. It is rate-limited per IP (25/sec, 500/hour, 10k/day). Forks that want private auth can re-add it.'],
      ['Can I drop it in where a commercial distance matrix was?','Mostly, yes. The JSON is byte-compatible with the legacy distance-matrix shape, so old clients keep parsing it. It adds a few fields (<code>*_matches</code>, <code>data_version</code>, <code>copyrights</code>) that old clients simply ignore.'],
      ['How big a matrix can I request?','Up to <code>100</code> elements — origins × destinations — in a single call.'],
      ['Do cross-country routes work?','Yes. NYC↔LA, Seattle↔Miami, Boston↔Houston — anything in the lower 48 + DC. Long-haul queries route through a national highway overlay.'],
      ['Can I host my own?','Yes — that\\u2019s the point. Fork it and deploy to your own edge account for less than $10/month for the whole continental US. Tune or disable the rate limits with env vars.']
    ],
    "Can't do": [
      ['Can I get a route line or polyline?','No. It returns scalar distance and duration only — no geometry is ever drawn. <b>It is a distance API, not a mapping product.</b> For geometry use OSRM, Valhalla, or a commercial API.'],
      ['Turn-by-turn directions?','No — it isn\\u2019t a navigation product.'],
      ['Walking, cycling, or transit?','Driving only. Any other <code>mode</code> is treated as driving.'],
      ['Anywhere outside the US?','Not yet. Coverage is the lower 48 + DC.']
    ],
    "What's missing": [
      ['Which legacy fields are omitted?','No <code>fare</code>, <code>duration_in_traffic</code>, or <code>geocoded_waypoints</code>. <code>place_id:</code> inputs return <code>NOT_FOUND</code>.'],
      ['Is there live traffic?','No. Numbers come from a static routed graph, so they differ from anything with real-time data.'],
      ['Is there a paid tier or dashboard?','No. It\\u2019s a free shared resource with no accounts. Need more headroom? Self-host.']
    ],
    'Competitors': [
      ['How does it compare to OSRM or Valhalla?','Those are full routing engines with geometry, turn-by-turn, and isochrones — you run a server for them. This does only distance + duration, on the edge, with no server to run. Different scope, much smaller bill.'],
      ['When should I NOT use this?','Anything safety- or contract-critical: emergency dispatch, regulated SLAs, legal billing. Use a commercial API there. This can slow down or go offline without notice.'],
      ['What\\u2019s the "first layer" idea?','Hit open-distance first and cache the answer; escalate to a premium engine only for the queries that actually need its premium features. Cheap by default, precise on demand.']
    ],
    'Accuracy': [
      ['How close to the commercial numbers is it?','Measured against a 7-provider panel (us + OSRM + Google + Mapbox + ORS + GraphHopper + TomTom) across 44 routes: distance estimates land within <b>~0.3-0.7%</b> of the panel median on rural, inter-city, and long-haul categories; ~4-5% under on cross-state and traffic-corridor routes (we don\\u2019t prefer toll roads the way some providers do). Free-flow time estimates spread much more (often 25-75% across providers) because the providers split into <em>traffic-aware</em> and <em>free-flow</em> camps. See <a href="/coverage">/coverage</a> for the full per-category and per-route panel.'],
      ['What do the match tiers mean?','<code>rooftop</code> = exact mapped point. <code>interpolated</code> = estimated along a street segment (likely off ~30–100 m). <code>coords</code> = you passed lat,lng directly. Empty = geocode failed.'],
      ['Why did I get NOT_FOUND for a real place?','If the best geocode is only a ZIP/city centroid (often miles off), it returns <code>NOT_FOUND</code> rather than a confidently-wrong distance.']
    ]
  };
  var TOPICS = Object.keys(FAQ);
  var topic = TOPICS[0];
  function renderFaq(){
    $('#faqTabs').innerHTML = TOPICS.map(function(t){
      return '<button class="'+(t===topic?'on':'')+'" data-t="'+t+'">'+t+'</button>';
    }).join('');
    $('#faqList').innerHTML = FAQ[topic].map(function(qa,i){
      return '<details'+(i===0?' open':'')+'><summary>'+qa[0]+'<span class="pl"></span></summary><div class="ans">'+qa[1]+'</div></details>';
    }).join('');
    $('#cmpWrap').innerHTML = topic==='Competitors' ? compareTable() : '';
    $$('#faqTabs button').forEach(function(b){
      b.addEventListener('click', function(){topic = b.dataset.t; renderFaq()});
    });
  }
  function compareTable(){
    var rows = [
      ['','Geometry','Live traffic','Key / server'],
      ['OSRM','Yes','No','Runs a server'],
      ['Valhalla','Yes','Plugin','Runs a server'],
      ['Commercial','Yes','Yes','Key + billing'],
      ['open-distance','None','None','Neither — public edge']
    ];
    return '<div class="cmp">' + rows.map(function(r,i){
      var me = r[0]==='open-distance';
      var cells = r.map(function(c,ci){
        if (ci===0) return '<div class="nm">'+(i===0 ? '' : (me?'\\u2605 ':'')+c)+'</div>';
        return '<div>'+c+'</div>';
      }).join('');
      return '<div class="cmp-row '+(i===0?'cmp-head':'')+' '+(me?'me':'')+'">'+cells+'</div>';
    }).join('') + '</div>';
  }

  function copy(text, btn){
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(function(){
      var old = btn.textContent;
      btn.textContent = 'Copied \\u2713';
      setTimeout(function(){btn.textContent = old}, 1300);
    }).catch(function(){});
  }

  // ---- init: prefill from default state, fetch first scenario live ----
  renderReadout();
  renderTerminalLoading('routing\\u2026');
  renderCode();
  renderFaq();
  // Live first calculation so the page demonstrates with real numbers.
  calculate();
})();
`;

// Docs-page CSS (separate; layout is two-pane with sticky TOC).
const DOCS_CSS = TOKENS + `
:root{--maxw:1200px}
body{font-size:16px}
code{font-family:var(--font-mono);font-size:.86em;background:var(--paper2);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.dochead{padding:54px 0 30px;border-bottom:1px solid var(--line2)}
.dochead h1{font-family:var(--font-display);font-weight:600;font-size:clamp(34px,4.6vw,52px);letter-spacing:-.025em;line-height:1.03;margin:14px 0 0}
.dochead p{color:var(--ink2);max-width:62ch;margin:16px 0 0;font-size:18px}
.pills{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
.pill{font-family:var(--font-mono);font-size:12.5px;color:var(--ink2);background:var(--card);border:1px solid var(--line);border-radius:100px;padding:6px 13px}
.pill b{color:var(--ink)}
.pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 30%,transparent);background:var(--ok-soft)}
.doclayout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:54px;padding:42px 0 80px;align-items:start}
.toc{position:sticky;top:88px}
.toc h5{font-family:var(--font-mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);margin:0 0 12px;font-weight:500}
.toc a{display:block;font-size:14px;color:var(--ink2);padding:6px 0;border-left:2px solid transparent;padding-left:12px;margin-left:-2px}
.toc a:hover{color:var(--ink)}
.toc a.on{color:var(--accent2);border-color:var(--accent);font-weight:600}
.content{min-width:0}
.content section{padding-bottom:48px;margin-bottom:48px;border-bottom:1px solid var(--line2)}
.content section:last-child{border-bottom:0}
.content h2{font-family:var(--font-display);font-weight:600;font-size:clamp(24px,3vw,32px);letter-spacing:-.02em;margin:0 0 6px;scroll-margin-top:84px}
.content h3{font-family:var(--font-display);font-weight:600;font-size:19px;margin:30px 0 10px}
.content p{color:var(--ink2);max-width:70ch;margin:0 0 14px}
.lead{font-size:17px}
.content a.lnk{color:var(--accent2);border-bottom:1px solid var(--accent-soft)}
.endpoint{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:8px 0 18px}
.method{font-family:var(--font-mono);font-weight:700;font-size:12px;letter-spacing:.06em;color:#fff;background:var(--ok);border-radius:6px;padding:4px 9px}
.endpoint .path{font-family:var(--font-mono);font-size:14.5px;color:var(--ink);word-break:break-all}
.code{position:relative;background:var(--term-bg);border-radius:12px;overflow:hidden;border:1px solid rgba(0,0,0,.3);margin:0 0 18px}
.code .cap{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.07);font-family:var(--font-mono);font-size:12px;color:var(--term-dim)}
.code .cap .cp{margin-left:auto;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:var(--term-dim);font-family:var(--font-mono);font-size:11px;padding:4px 9px;cursor:pointer}
.code .cap .cp:hover{color:var(--term-fg);background:rgba(255,255,255,.12)}
.code pre{margin:0;font-family:var(--font-mono);font-size:13px;line-height:1.75;color:var(--term-fg);padding:15px 16px;overflow:auto;white-space:pre}
.code .pun{color:var(--term-pun)}.code .key{color:var(--term-key)}.code .str{color:var(--term-str)}.code .num{color:var(--term-num)}.code .cmt{color:var(--term-dim)}.code .pr{color:var(--accent)}
.tbl{width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:12px;overflow:hidden;margin:6px 0 18px;font-size:14px}
.tbl th,.tbl td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line2);vertical-align:top}
.tbl thead th{background:var(--paper2);font-family:var(--font-mono);font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3);font-weight:500}
.tbl tr:last-child td{border-bottom:0}
.tbl td.k{font-family:var(--font-mono);color:var(--accent2);white-space:nowrap}
.tbl td.req{font-family:var(--font-mono);font-size:12px}
.tbl .muted{color:var(--ink3)}
.tbl td b{font-weight:600;color:var(--ink)}
.note{display:flex;gap:12px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;padding:14px 16px;margin:0 0 18px}
.note.warn{border-left-color:var(--accent)}
.note.ok{border-left-color:var(--ok)}
.note .ico{font-family:var(--font-mono);font-weight:700;color:var(--accent2)}
.note.ok .ico{color:var(--ok)}
.note p{margin:0;font-size:14px;color:var(--ink2)}
.note p b{color:var(--ink)}
.tierlist{list-style:none;margin:6px 0 18px;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tierlist li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.tierlist .t{font-family:var(--font-mono);font-size:13px;color:var(--accent2);font-weight:500}
.tierlist .d{display:block;color:var(--ink2);font-size:13.5px;margin-top:4px}
footer.docfoot{border-top:1px solid var(--line);padding:40px 0;margin-top:0}
.foot-in{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}
.foot-in .mono{font-size:12.5px;color:var(--ink3)}
.foot-in a{color:var(--ink2);font-size:14px}
.foot-in a:hover{color:var(--ink)}
@media(max-width:860px){
  .doclayout{grid-template-columns:1fr;gap:0}
  .toc{position:static;margin-bottom:28px;border:1px solid var(--line);border-radius:12px;padding:16px;background:var(--card)}
  .toc a{display:inline-block;border-left:0;padding:6px 10px}
  .tierlist{grid-template-columns:1fr}
}
@media(max-width:560px){nav.links a:not(.ghost-btn){display:none}}
`;

// Docs page JS — copy buttons + scroll-spy.
const DOCS_JS = `
(function(){
  'use strict';
  document.querySelectorAll('.code .cp').forEach(function(btn){
    btn.addEventListener('click', function(){
      var pre = btn.closest('.code').querySelector('pre');
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(pre.innerText).then(function(){
        var o = btn.textContent;
        btn.textContent = 'Copied \\u2713';
        setTimeout(function(){btn.textContent = o}, 1300);
      }).catch(function(){});
    });
  });
  var links = [].slice.call(document.querySelectorAll('#toc a'));
  var map = new Map(links.map(function(a){return [a.getAttribute('href').slice(1), a]}));
  var obs = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if (e.isIntersecting){
        links.forEach(function(l){l.classList.remove('on')});
        var hit = map.get(e.target.id);
        if (hit) hit.classList.add('on');
      }
    });
  }, {rootMargin:'-80px 0px -70% 0px'});
  document.querySelectorAll('.content section').forEach(function(s){obs.observe(s)});
})();
`;

// CSS for the lower-traffic prose pages (privacy + attribution + coverage).
// Borrowed docs-look but single-column.
const PROSE_CSS = TOKENS + `
:root{--maxw:920px}
body{font-size:16px}
.dochead{padding:54px 0 30px;border-bottom:1px solid var(--line2)}
.dochead h1{font-family:var(--font-display);font-weight:600;font-size:clamp(30px,4vw,46px);letter-spacing:-.025em;line-height:1.04;margin:14px 0 0}
.dochead p{color:var(--ink2);max-width:62ch;margin:16px 0 0;font-size:17px}
.prose{padding:36px 0 80px}
.prose h2{font-family:var(--font-display);font-weight:600;font-size:clamp(22px,2.8vw,28px);letter-spacing:-.02em;margin:34px 0 10px}
.prose h3{font-family:var(--font-display);font-weight:600;font-size:18px;margin:24px 0 8px}
.prose p,.prose ul,.prose ol{color:var(--ink2);max-width:72ch}
.prose ul,.prose ol{padding-left:1.3rem}
.prose li{margin:6px 0}
.prose blockquote{margin:14px 0;padding:12px 16px;background:var(--card);border-left:3px solid var(--accent);border-radius:0 10px 10px 0;color:var(--ink2);max-width:72ch}
.prose code{font-family:var(--font-mono);font-size:.86em;background:var(--paper2);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.prose a{color:var(--accent2);border-bottom:1px solid var(--accent-soft)}
.prose .cov-tbl{width:100%;border-collapse:collapse;font-size:13px;font-family:var(--font-mono);margin:14px 0 28px;border:1px solid var(--line);border-radius:10px;overflow:hidden;max-width:none}
.prose .cov-tbl th,.prose .cov-tbl td{padding:8px 10px;text-align:right;border-bottom:1px solid var(--line2);white-space:nowrap}
.prose .cov-tbl th{background:var(--paper2);color:var(--ink3);font-weight:500;font-size:11px;letter-spacing:.05em;text-transform:uppercase}
.prose .cov-tbl tr:last-child td{border-bottom:0}
.prose .cov-tbl td.cat,.prose .cov-tbl th:first-child{text-align:left}
.prose .cov-tbl td.cat{color:var(--ink);font-weight:600;font-family:var(--font-display)}
.prose .cov-tbl td.me{color:var(--accent2);font-weight:600;background:var(--accent-soft)}
.prose .cov-tbl td.dim{color:var(--ink3)}
.prose .cov-tbl .spread{color:var(--ink);font-weight:600}
.prose details.cov-routes{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.prose details.cov-routes summary{cursor:pointer;padding:12px 14px;font-family:var(--font-mono);font-size:12.5px;color:var(--ink2);font-weight:500}
.prose details.cov-routes summary:hover{color:var(--ink)}
.prose details.cov-routes[open] summary{border-bottom:1px solid var(--line2)}
.prose details.cov-routes .cov-tbl{margin:0;border:0;border-radius:0}
.prose .state-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 22px}
.prose .state-chips span{font-family:var(--font-mono);font-size:12px;font-weight:500;color:var(--ink2);background:var(--paper2);border:1px solid var(--line);border-radius:100px;padding:3px 9px}
footer.docfoot{border-top:1px solid var(--line);padding:40px 0}
.foot-in{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}
.foot-in .mono{font-size:12.5px;color:var(--ink3)}
.foot-in a{color:var(--ink2);font-size:14px}
.foot-in a:hover{color:var(--ink)}
@media(max-width:560px){nav.links a:not(.ghost-btn):not(.on){display:none}}
`;

// ---------------------------------------------------------------------------
// Page renderers
// ---------------------------------------------------------------------------

// Fonts self-hosted at /fonts/*.woff2 — see public/fonts/. @font-face decls live
// inside TOKENS so they ship with every page's <style> block.
const FONTS_LINK = ``;  // fonts self-hosted; preload tags are in headMeta()

const TOP_BAR_HOME = `
<header class="bar">
  <div class="wrap bar-in">
    <a class="brand" href="#top"><span class="mk"></span>open-distance</a>
    <nav class="links">
      <a href="#try">Try it</a>
      <a href="/docs">Docs</a>
      <a href="#faq">FAQ</a>
      <a class="ghost-btn" href="https://github.com/kurtpayne/open-distance" target="_blank" rel="noopener">★ Star on GitHub</a>
    </nav>
  </div>
</header>
`;

function topBarOther(activePath: string): string {
  const ds = activePath === "/docs" ? "on" : "";
  return `<header class="bar">
  <div class="wrap bar-in">
    <a class="brand" href="/"><span class="mk"></span>open-distance</a>
    <nav class="links">
      <a href="/#try">Try it</a>
      <a class="${ds}" href="/docs">Docs</a>
      <a href="/#faq">FAQ</a>
      <a class="ghost-btn" href="https://github.com/kurtpayne/open-distance" target="_blank" rel="noopener">★ Star on GitHub</a>
    </nav>
  </div>
</header>`;
}

const HOME_FOOTER = `
<footer>
  <div class="wrap">
    <div class="foot-top">
      <div class="foot-brand">
        <a class="brand" href="#top"><span class="mk"></span>open-distance</a>
        <p>A free distance-matrix API on the edge. A side project, shared — not a startup.</p>
        <div class="disclaimer">Provided as-is, no warranty. Built from public open data; no live traffic. Not for safety-critical or contract-critical use — use a commercial API for that.</div>
      </div>
      <div class="foot-col">
        <h5>Product</h5>
        <a href="#try">Try it</a><a href="/docs">Docs</a><a href="#faq">FAQ</a><a href="/docs#coverage">Coverage</a>
      </div>
      <div class="foot-col">
        <h5>Open source</h5>
        <a href="https://github.com/kurtpayne/open-distance" target="_blank" rel="noopener">GitHub ↗</a>
        <a href="https://github.com/kurtpayne/open-distance/blob/main/LICENSE" target="_blank" rel="noopener">License · Apache-2.0</a>
        <a href="/attribution">Data attribution</a>
        <a href="https://github.com/kurtpayne/open-distance#populating-data-from-a-clean-clone" target="_blank" rel="noopener">Self-host guide</a>
      </div>
      <div class="foot-col">
        <h5>Project</h5>
        <a href="https://github.com/kurtpayne/open-distance" target="_blank" rel="noopener">Source ↗</a>
        <a href="https://github.com/kurtpayne/open-distance/issues" target="_blank" rel="noopener">Report an issue</a>
        <a href="/privacy">Privacy</a>
        <span class="mono" style="font-size:12.5px;color:var(--ink3);display:block;margin-top:6px">data 2026-06</span>
      </div>
    </div>
    <div class="foot-bottom">
      <span class="mono">© 2026 open-distance · Apache-2.0</span>
      <span class="mono">under $10/mo to run · $0 to use</span>
    </div>
  </div>
</footer>
`;

const SHORT_FOOTER = `
<footer class="docfoot">
  <div class="wrap foot-in">
    <a class="brand" href="/"><span class="mk"></span>open-distance</a>
    <span class="mono">A free distance-matrix API · under $10/mo to run · $0 to use</span>
    <span style="display:flex;gap:18px">
      <a href="https://github.com/kurtpayne/open-distance" target="_blank" rel="noopener">GitHub ↗</a>
      <a href="https://github.com/kurtpayne/open-distance/blob/main/LICENSE" target="_blank" rel="noopener">Apache-2.0</a>
      <a href="/">Home</a>
    </span>
  </div>
</footer>
`;

export function renderIndex(): string {
  return `<!doctype html>
<html lang="en"><head>
${headMeta("Open Distance — free distance-matrix API", "/")}
${FONTS_LINK}
<style>${HOME_CSS}</style>
</head><body>
${TOP_BAR_HOME}
<main id="top">
  <section class="hero" id="try">
    <div class="wrap">
      <span class="eyebrow">Free · Open source · Continental US</span>
      <h1>Distances, without the <em>per-call bill.</em></h1>
      <p class="lede">A wire-compatible distance-matrix API on the edge. <b>Distances within ~1% of the panel median on most route categories</b> (up to ~5% off on toll-routed and dense urban). $0 per call, no key, no analytics. Type an origin and a destination, or copy the curl.</p>

      <div class="instrument">
        <div class="calc" id="calc">
          <div class="calc-head">
            <div class="seg" id="mode">
              <button class="on" data-m="single" type="button">Single</button>
              <button data-m="matrix" type="button">Matrix</button>
            </div>
            <div class="seg" id="units">
              <button class="on" data-u="imperial" type="button">miles</button>
              <button data-u="metric" type="button">km</button>
            </div>
          </div>

          <div id="singleView">
            <div class="fields">
              <label class="field"><span class="pin"></span><input id="origin" value="Austin, TX" autocomplete="off" spellcheck="false" aria-label="Origin"></label>
              <div class="leg"><span>↓ 1 origin → 1 destination &nbsp;·&nbsp; switch to <b style="color:var(--ink2)">Matrix</b> for up to 100 pairs in one call</span></div>
              <label class="field"><span class="pin b"></span><input id="dest" value="Dallas, TX" autocomplete="off" spellcheck="false" aria-label="Destination"></label>
            </div>
            <div class="chips" id="examples">
              <button class="chip" data-k="sf" type="button">Stanford → SF</button>
              <button class="chip" data-k="tx" type="button">Austin → Dallas</button>
              <button class="chip" data-k="ny" type="button">Brooklyn → Newark</button>
              <button class="chip" data-k="fl" type="button">Miami → Orlando</button>
            </div>
          </div>

          <div id="matrixView" hidden>
            <div class="mx-group">
              <div class="mx-label"><span class="pin"></span>Origins<span class="mx-count" id="oCount"></span></div>
              <div class="mx-list" id="oList"></div>
              <button class="mx-add" id="oAdd" type="button">＋ add origin</button>
            </div>
            <div class="mx-group">
              <div class="mx-label"><span class="pin b"></span>Destinations<span class="mx-count" id="dCount"></span></div>
              <div class="mx-list" id="dList"></div>
              <button class="mx-add" id="dAdd" type="button">＋ add destination</button>
            </div>
          </div>

          <button class="calc-btn" id="calcBtn" type="button">Calculate →</button>

          <div class="readout" id="readout">
            <div class="ro-metric"><div class="ro-l">Distance</div><div class="ro-v" id="roDist">—</div></div>
            <div class="ro-metric"><div class="ro-l">Drive time</div><div class="ro-v" id="roTime">—</div></div>
            <div class="ro-badges" id="roBadges"></div>
          </div>
          <div class="readout-err" id="readoutErr" hidden></div>
          <div id="matrixOut" hidden></div>
        </div>

        <div class="term">
          <div class="term-head">
            <span class="tl"><i></i><i></i><i></i></span>
            <span class="term-title">bash</span>
            <button class="term-copy" id="termCopy" type="button">Copy</button>
          </div>
          <div class="term-body" id="termBody"></div>
        </div>
      </div>

      <div class="trust">
        <span class="tg"><span class="tick">✓</span> No API key</span>
        <span class="tg"><span class="tick">✓</span> No analytics</span>
        <span class="tg"><span class="tick">✓</span> No ads</span>
        <span class="sep"></span>
        <span class="tg">Apache-2.0</span>
        <span class="tg"><b>~1%</b> distance vs major providers</span>
        <span class="tg">Up to <b>100</b> elements / call</span>
      </div>
    </div>
  </section>

  <section class="band">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <span class="eyebrow">No surprises</span>
          <h2>One honest job, done cheaply.</h2>
        </div>
        <p>It returns a number, not a map. Knowing exactly what you trade is the whole pitch.</p>
      </div>
      <div class="truth">
        <div class="truth-card">
          <h3><span style="color:var(--ok)">✓</span> What you get</h3>
          <p class="sub">The useful 90%, for free.</p>
          <ul class="tlist yes">
            <li><span class="gi">✓</span><span style="color:var(--ink)"><b>Driving distance + duration</b> between any two US points<br><span>Addresses or raw lat,lng — lower 48 + DC, including cross-country.</span></span></li>
            <li><span class="gi">✓</span><span style="color:var(--ink)"><b>A 100-pair matrix in one call</b><br><span>Up to 100 origin × destination elements.</span></span></li>
            <li><span class="gi">✓</span><span style="color:var(--ink)"><b>Wire-compatible JSON response</b><br><span>Same shape as the legacy Distance Matrix API; clients keep parsing.</span></span></li>
            <li><span class="gi">✓</span><span style="color:var(--ink)"><b>Self-host the whole thing</b><br><span>Fork it, deploy to your own edge, set your own limits.</span></span></li>
          </ul>
        </div>
        <div class="truth-card">
          <h3><span style="color:var(--ink3)">✗</span> What you give up</h3>
          <p class="sub">If you need these, use a routing engine.</p>
          <ul class="tlist no">
            <li><span class="gi">✗</span><span style="color:var(--ink)"><b>Route geometry / a polyline</b><br><span>No line is drawn — just the scalar numbers.</span></span></li>
            <li><span class="gi">✗</span><span style="color:var(--ink)"><b>Turn-by-turn directions</b><br><span>It isn’t a navigation product.</span></span></li>
            <li><span class="gi">✗</span><span style="color:var(--ink)"><b>Live / predicted traffic</b><br><span>Numbers come from a static routed graph.</span></span></li>
            <li><span class="gi">✗</span><span style="color:var(--ink)"><b>Walking, transit, or non-US</b><br><span>Driving only, continental US only — today.</span></span></li>
          </ul>
        </div>
      </div>
      <div class="pinline">It’s a <b>distance API</b>, not a mapping product. That’s a feature, not a limitation.</div>
    </div>
  </section>

  <section class="band" id="docs" style="background:var(--paper2);border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Quickstart</span>
          <h2>From nothing to first call in a minute.</h2>
        </div>
        <p>One endpoint. No key, no SDK, no signup. Swap your base URL and go. <a href="/docs" style="color:var(--accent2);border-bottom:1px solid var(--accent-soft);white-space:nowrap">Read the full docs →</a></p>
      </div>
      <div class="qs">
        <div class="steps">
          <div class="step"><span class="num">1</span><div><h4>Point at the endpoint</h4><p><code>GET /maps/api/distancematrix/json</code> — the only route you need.</p></div></div>
          <div class="step"><span class="num">2</span><div><h4>Single pair, or a matrix</h4><p>Pipe-separate <code>origins</code> and <code>destinations</code> to score <b>up to 100 elements</b> (N origins × M destinations) in one call. Single pair is just N=M=1.</p></div></div>
          <div class="step"><span class="num">3</span><div><h4>Read the standard JSON</h4><p>Same shape you already parse — <code>rows[i].elements[j]</code> = origin <em>i</em> to destination <em>j</em>. Plus additive <code>*_matches</code> confidence fields.</p></div></div>
          <div class="step"><span class="num">4</span><div><h4>Self-throttle on headers</h4><p>Every response carries <code>X-RateLimit-Remaining-*</code> so you can back off cleanly.</p></div></div>
        </div>
        <div class="codecard" id="codecard">
          <div class="tabs" id="codeTabs">
            <button class="on" data-l="curl" type="button">curl</button>
            <button data-l="js" type="button">javascript</button>
            <button data-l="py" type="button">python</button>
          </div>
          <pre id="codeBody"></pre>
        </div>
      </div>
    </div>
  </section>

  <section class="band" id="faq">
    <div class="wrap">
      <div class="sec-head">
        <div>
          <span class="eyebrow">Education, by topic</span>
          <h2>The questions, sorted by what you’re asking.</h2>
        </div>
        <p>No marketing answers. If something’s a bad fit, this page will tell you.</p>
      </div>
      <div class="faq-tabs" id="faqTabs"></div>
      <div class="qa" id="faqList"></div>
      <div id="cmpWrap"></div>
    </div>
  </section>
</main>

${HOME_FOOTER}

<script>${HOME_JS}</script>
</body></html>`;
}

export function renderDocs(): string {
  return `<!doctype html>
<html lang="en"><head>
${headMeta("Open Distance — API docs", "/docs")}
${FONTS_LINK}
<style>${DOCS_CSS}</style>
</head><body>
${topBarOther("/docs")}

<div class="wrap">
  <div class="dochead">
    <span class="eyebrow">API Reference</span>
    <h1>One endpoint. No key. Standard JSON.</h1>
    <p class="lead">Everything you need to call <code>open-distance</code> — the request, the response, the limits, and exactly how it differs from the legacy distance-matrix API it mirrors.</p>
    <div class="pills">
      <span class="pill ok">No API key required</span>
      <span class="pill"><b>Base</b> · open-distance.com</span>
      <span class="pill"><b>Coverage</b> · lower 48 + DC</span>
      <span class="pill"><b>Format</b> · Distance Matrix JSON</span>
    </div>
  </div>

  <div class="doclayout">
    <aside class="toc">
      <h5>On this page</h5>
      <nav id="toc">
        <a href="#overview">Overview</a>
        <a href="#endpoint">Endpoint</a>
        <a href="#parameters">Parameters</a>
        <a href="#response">Response shape</a>
        <a href="#matches">Match tiers</a>
        <a href="#status">Status codes</a>
        <a href="#limits">Rate limits</a>
        <a href="#deviations">Deviations</a>
        <a href="#coverage">Coverage</a>
        <a href="#selfhost">Self-hosting</a>
      </nav>
    </aside>

    <main class="content">
      <section id="overview">
        <h2>Overview</h2>
        <p class="lead">A serverless distance &amp; duration API on the edge, response-compatible with the legacy Distance Matrix JSON shape. It returns <b>scalar distance and duration</b> — no route geometry, no turn-by-turn, no live traffic.</p>
        <div class="note ok"><span class="ico">✓</span><p>The public endpoint takes <b>no <code>key=</code></b> and needs no signup. It’s rate-limited per IP. Forks that want private auth can re-introduce it in <code>src/auth.ts</code>.</p></div>
        <div class="note"><span class="ico">!</span><p>Provided as-is, no warranty — built from public open data, no live traffic. <b>Not for safety- or contract-critical use</b> (emergency dispatch, regulated SLAs, legal billing). Use a commercial API there.</p></div>
      </section>

      <section id="endpoint">
        <h2>Endpoint</h2>
        <p>A single GET request. Origins and destinations are pipe-separated; each item is a <code>lat,lng</code> pair or an address string.</p>
        <div class="endpoint"><span class="method">GET</span><span class="path">/maps/api/distancematrix/json</span></div>
        <div class="code">
          <div class="cap">request <button class="cp" type="button">Copy</button></div>
          <pre><span class="cmt"># no key — just GET it</span>
<span class="pr">curl</span> <span class="str">"https://open-distance.com/maps/api/distancematrix/json\\
  ?origins=Stanford,CA|Palo+Alto,CA\\
  &amp;destinations=San+Francisco,CA|Oakland,CA\\
  &amp;units=imperial"</span></pre>
        </div>
      </section>

      <section id="parameters">
        <h2>Parameters</h2>
        <table class="tbl">
          <thead><tr><th>Param</th><th>Required</th><th>Default</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td class="k">origins</td><td class="req">yes</td><td class="muted">—</td><td><code>A|B|…</code> — each a <b>lat,lng</b> pair or address string.</td></tr>
            <tr><td class="k">destinations</td><td class="req">yes</td><td class="muted">—</td><td><code>C|D|…</code> — same format as origins.</td></tr>
            <tr><td class="k">units</td><td class="req muted">no</td><td><code>imperial</code></td><td><code>imperial</code> or <code>metric</code>.</td></tr>
            <tr><td class="k">mode</td><td class="req muted">no</td><td><code>driving</code></td><td>Only <b>driving</b> is supported; other modes are treated as driving.</td></tr>
            <tr><td class="k">key</td><td class="req muted">no</td><td class="muted">—</td><td><b>Not required.</b> Public endpoint is rate-limited per IP.</td></tr>
          </tbody>
        </table>
        <div class="note"><span class="ico">!</span><p>Max <b>100 elements</b> (origins × destinations) per request, or you’ll get <code>MAX_ELEMENTS_EXCEEDED</code>. <code>place_id:</code> inputs return <code>NOT_FOUND</code>.</p></div>
      </section>

      <section id="response">
        <h2>Response shape</h2>
        <p>Byte-compatible with the legacy Distance Matrix JSON, plus a few additive fields (<code>*_matches</code>, <code>data_version</code>, <code>copyrights</code>) that old clients simply ignore.</p>
        <div class="code">
          <div class="cap">200 OK · application/json <button class="cp" type="button">Copy</button></div>
          <pre><span class="pun">{</span>
  <span class="key">"origin_addresses"</span><span class="pun">:</span>      <span class="str">["Stanford, CA, USA", "Palo Alto, CA, USA"]</span><span class="pun">,</span>
  <span class="key">"origin_matches"</span><span class="pun">:</span>        <span class="str">["rooftop", "rooftop"]</span><span class="pun">,</span>
  <span class="key">"destination_addresses"</span><span class="pun">:</span> <span class="str">["San Francisco, CA", "Oakland, CA"]</span><span class="pun">,</span>
  <span class="key">"destination_matches"</span><span class="pun">:</span>   <span class="str">["rooftop", "interpolated"]</span><span class="pun">,</span>
  <span class="key">"data_version"</span><span class="pun">:</span>          <span class="str">"2026-06"</span><span class="pun">,</span>
  <span class="key">"rows"</span><span class="pun">: [{</span> <span class="key">"elements"</span><span class="pun">: [{</span>
    <span class="key">"distance"</span><span class="pun">:</span> <span class="pun">{</span> <span class="key">"text"</span><span class="pun">:</span> <span class="str">"33.4 mi"</span><span class="pun">,</span> <span class="key">"value"</span><span class="pun">:</span> <span class="num">53752</span> <span class="pun">},</span>   <span class="cmt">// metres</span>
    <span class="key">"duration"</span><span class="pun">:</span> <span class="pun">{</span> <span class="key">"text"</span><span class="pun">:</span> <span class="str">"41 mins"</span><span class="pun">,</span> <span class="key">"value"</span><span class="pun">:</span> <span class="num">2460</span> <span class="pun">},</span>  <span class="cmt">// seconds</span>
    <span class="key">"status"</span><span class="pun">:</span> <span class="str">"OK"</span>
  <span class="pun">}]}],</span>
  <span class="key">"copyrights"</span><span class="pun">:</span> <span class="str">"… ODbL §4.3 produced-work notice …"</span><span class="pun">,</span>
  <span class="key">"status"</span><span class="pun">:</span> <span class="str">"OK"</span>
<span class="pun">}</span></pre>
        </div>
      </section>

      <section id="matches">
        <h2>Match tiers</h2>
        <p>Each origin and destination reports how confidently it was geocoded, in the <code>origin_matches</code> / <code>destination_matches</code> arrays.</p>
        <ul class="tierlist">
          <li><span class="t">rooftop</span><span class="d">Exact mapped point — authoritative rooftop dataset (NAD or OpenAddresses).</span></li>
          <li><span class="t">interpolated</span><span class="d">Estimated along a street segment (TIGER) — likely off ~30–100 m.</span></li>
          <li><span class="t">coords</span><span class="d">You passed <code>lat,lng</code> directly; no geocode performed.</span></li>
          <li><span class="t">"" (empty)</span><span class="d">Geocode failed; the address echoes your raw input.</span></li>
        </ul>
        <div class="note"><span class="ico">!</span><p>Addresses that only resolve to a ZIP/city <b>centroid</b> (often miles off) return <code>NOT_FOUND</code> rather than a confidently-wrong distance.</p></div>
      </section>

      <section id="status">
        <h2>Status codes</h2>
        <table class="tbl">
          <thead><tr><th>Top-level status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td class="k">OK</td><td>Request valid; see per-element statuses.</td></tr>
            <tr><td class="k">INVALID_REQUEST</td><td>Missing or malformed parameters.</td></tr>
            <tr><td class="k">MAX_ELEMENTS_EXCEEDED</td><td>origins × destinations &gt; 100.</td></tr>
            <tr><td class="k">OVER_QUERY_LIMIT</td><td>Rate limit hit — returned with HTTP <code>429</code>.</td></tr>
            <tr><td class="k">REQUEST_DENIED</td><td>Request refused.</td></tr>
          </tbody>
        </table>
        <h3>Per-element status</h3>
        <table class="tbl">
          <thead><tr><th>Element status</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td class="k">OK</td><td><code>distance</code> + <code>duration</code> returned.</td></tr>
            <tr><td class="k">NOT_FOUND</td><td>Origin or destination couldn’t be geocoded confidently.</td></tr>
            <tr><td class="k">ZERO_RESULTS</td><td>No route found between the snapped graph nodes.</td></tr>
          </tbody>
        </table>
      </section>

      <section id="limits">
        <h2>Rate limits</h2>
        <p>Per-IP on the hosted deployment. There is <b>no paid tier</b> — need more headroom? Self-host and tune the env vars (set any to <code>0</code> to disable that window).</p>
        <table class="tbl">
          <thead><tr><th>Window</th><th>Limit</th><th>Env var</th></tr></thead>
          <tbody>
            <tr><td>Second</td><td><b>25</b></td><td class="k">RL_PER_SEC</td></tr>
            <tr><td>Hour</td><td><b>500</b></td><td class="k">RL_PER_HOUR</td></tr>
            <tr><td>Day</td><td><b>10,000</b></td><td class="k">RL_PER_DAY</td></tr>
          </tbody>
        </table>
        <h3>Self-throttle headers</h3>
        <p>Every response — <code>200</code> and <code>429</code> alike — carries limit headers so you can back off without an extra probe.</p>
        <div class="code">
          <div class="cap">response headers <button class="cp" type="button">Copy</button></div>
          <pre><span class="key">X-RateLimit-Limit-Second</span><span class="pun">:</span>     <span class="num">25</span>
<span class="key">X-RateLimit-Remaining-Second</span><span class="pun">:</span> <span class="num">24</span>
<span class="key">X-RateLimit-Remaining-Hour</span><span class="pun">:</span>   <span class="num">498</span>
<span class="key">X-RateLimit-Remaining-Day</span><span class="pun">:</span>    <span class="num">9981</span>
<span class="cmt"># on 429:</span> <span class="key">Retry-After</span><span class="pun">,</span> <span class="key">X-RateLimit-Tier</span><span class="pun">:</span> <span class="str">sec | hour | day</span></pre>
        </div>
      </section>

      <section id="deviations">
        <h2>Deviations from the legacy API</h2>
        <p>It mirrors the legacy distance-matrix wire format, with intentional differences:</p>
        <table class="tbl">
          <thead><tr><th>Area</th><th>Difference</th></tr></thead>
          <tbody>
            <tr><td><b>Auth</b></td><td>No <code>key=</code>. Rate-limited per IP instead.</td></tr>
            <tr><td><b>Numbers</b></td><td>From a routed graph with no live traffic — they differ from traffic-aware providers.</td></tr>
            <tr><td><b>Omitted fields</b></td><td>No <code>fare</code>, <code>duration_in_traffic</code>, <code>geocoded_waypoints</code>, or <code>warnings</code>.</td></tr>
            <tr><td><b>Added fields</b></td><td><code>origin_matches</code>, <code>destination_matches</code>, <code>copyrights</code>, <code>data_version</code> — all additive.</td></tr>
            <tr><td><b>Modes</b></td><td>Driving only. <code>place_id:</code> inputs → <code>NOT_FOUND</code>.</td></tr>
            <tr><td><b>Caching</b></td><td>Successful responses send <code>Cache-Control: public, max-age=3600</code>.</td></tr>
          </tbody>
        </table>
      </section>

      <section id="coverage">
        <h2>Coverage</h2>
        <p>Continental US — the <b>lower 48 states + DC</b>. Short and medium routes go through a tiled local-road graph; long-haul routes (anything over ~620 mi straight-line) route through a national highway overlay layer that holds the country’s motorway network in a single binary. NYC→LA, Seattle→Miami, and Boston→Houston all return real answers.</p>
        <p>Live coverage, sources, and supported behaviours are reported by the <code>GET /coverage</code> endpoint.</p>
      </section>

      <section id="selfhost">
        <h2>Self-hosting</h2>
        <p>The whole thing is fork-and-deploy on your own edge account for <b>less than $10/month</b> for the entire continental US. The pipeline (fetch → build → upload → publish) is driven by one script.</p>
        <div class="note ok"><span class="ico">✓</span><p>Full setup, data sources, and the refresh pipeline live in the repo. <a class="lnk" href="https://github.com/kurtpayne/open-distance#populating-data-from-a-clean-clone" target="_blank" rel="noopener">Read the self-host guide →</a></p></div>
      </section>
    </main>
  </div>
</div>

${SHORT_FOOTER}

<script>${DOCS_JS}</script>
</body></html>`;
}

export function renderPrivacy(): string {
  return `<!doctype html>
<html lang="en"><head>
${headMeta("Open Distance — privacy", "/privacy")}
${FONTS_LINK}
<style>${PROSE_CSS}</style>
</head><body>
${topBarOther("/privacy")}
<div class="wrap">
  <div class="dochead">
    <span class="eyebrow">Policy</span>
    <h1>Privacy</h1>
    <p>open-distance is designed not to know who you are.</p>
  </div>
  <div class="prose">
    <h2>What we receive</h2>
    <ul>
      <li>The origin and destination strings you send (addresses or coordinates).</li>
      <li>Cloudflare’s standard edge logs (request IP, user-agent, country) — used for abuse mitigation and aggregated traffic analytics only. We do not attempt to identify individual users.</li>
    </ul>

    <h2>What we store</h2>
    <ul>
      <li><b>Geocode cache</b> (Cloudflare KV, 30-day TTL): <code>SHA-1(normalized_address) → { lat, lon }</code>. The normalized address strings are stored. We do not store IPs alongside.</li>
      <li><b>Leg cache</b> (Cloudflare KV, 30-day TTL): keyed on snapped road-graph node IDs (not addresses), value is travel time + distance. This is a map fact, not personal data.</li>
      <li><b>Edge response cache</b> (Cloudflare’s standard cache, 1-hour TTL on Distance Matrix responses): full JSON keyed by URL.</li>
    </ul>

    <h2>What we don’t do</h2>
    <ul>
      <li>No cookies. No localStorage. No tracking pixels. No analytics SDKs.</li>
      <li>No third-party scripts, fonts, or images. Every byte of every page comes from open-distance.com (or its CDN). No external CDN dependency, no third-party tracking pixels.</li>
      <li>No JavaScript that touches geolocation, camera, microphone, or any other permission.</li>
      <li>No accounts, no API keys to register, no contact required to use.</li>
    </ul>

    <h2>If you want to keep even the URL private</h2>
    <p>Self-host. The whole stack is open source under Apache 2.0; fork the repo and deploy it on your own Cloudflare account for less than $10/month. See <a href="https://github.com/kurtpayne/open-distance/blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a>.</p>

    <h2>Contact</h2>
    <p>Open an issue on the GitHub repo if you have a privacy concern with the hosted deployment at open-distance.com.</p>
  </div>
</div>
${SHORT_FOOTER}
</body></html>`;
}

export function renderAttribution(): string {
  return `<!doctype html>
<html lang="en"><head>
${headMeta("Open Distance — data attribution", "/attribution")}
${FONTS_LINK}
<style>${PROSE_CSS}</style>
</head><body>
${topBarOther("/attribution")}
<div class="wrap">
  <div class="dochead">
    <span class="eyebrow">License notices</span>
    <h1>Data attribution</h1>
    <p>open-distance is computed from third-party open data. The notices below must travel with any work derived from those sources (per their licenses). The canonical text lives in <a href="https://github.com/kurtpayne/open-distance/blob/main/NOTICE">NOTICE</a> in the repo; this page reproduces it so it’s reachable from the deployed site.</p>
  </div>
  <div class="prose">
    <h2>Road network — OpenStreetMap (ODbL 1.0)</h2>
    <p>Source: <a href="https://download.geofabrik.de/">Geofabrik</a> per-state PBF extracts. Licensed under the <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License, version 1.0</a>.</p>
    <p>The road graph tile binaries served from R2 (<code>tiles/&lt;version&gt;/&lt;tx&gt;_&lt;ty&gt;.bin</code>) are a Derivative Database of OpenStreetMap. Per ODbL §4.3, every Produced Work computed from that Database — including every API response from open-distance — must carry the following notice:</p>
    <blockquote>© OpenStreetMap contributors. Map data available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL) v1.0</a>.</blockquote>
    <p>open-distance does not publish the Derivative Database itself — only the Produced Works (scalar distance/duration responses) generated from it. The unmodified upstream OSM extracts remain available at Geofabrik under their original ODbL terms; no separate offer of the source data is made by this project.</p>
    <p>Operators of forks that publish the tile binaries directly inherit the ODbL §4.4(b) share-alike obligation: the published Derivative Database must itself be available under ODbL.</p>

    <h2>Addresses — NAD (US DOT, public domain)</h2>
    <p>National Address Database, U.S. Department of Transportation. Public domain under 17 U.S.C. § 105 (work of the federal government). No attribution is legally required. We acknowledge it anyway:</p>
    <blockquote>Address data provided by the U.S. DOT National Address Database.</blockquote>

    <h2>Addresses — OpenAddresses (per-source)</h2>
    <p>Per-source per-county and per-city authorities aggregated at <a href="https://batch.openaddresses.io/">batch.openaddresses.io</a>. Each source carries its own license; the per-source attribution is enumerated machine-readably at <a href="/attribution/openaddresses.json"><code>/attribution/openaddresses.json</code></a>. A blanket attribution line:</p>
    <blockquote>Address data from <a href="https://openaddresses.io/">OpenAddresses</a>, used under the per-source terms documented in the OA manifest.</blockquote>

    <h2>Addresses (supplementary) — OpenStreetMap <code>addr:*</code> nodes</h2>
    <p>Same ODbL 1.0 terms as the road network attribution above. The same Produced Work notice applies.</p>

    <h2>Street segments — TIGER/Line 2024 (US Census, public domain)</h2>
    <p>TIGER/Line 2024 release, U.S. Census Bureau. Public domain. No attribution required. We acknowledge it anyway:</p>
    <blockquote>Street segment data from the U.S. Census Bureau TIGER/Line 2024.</blockquote>

    <h2>Code dependencies</h2>
    <p>All runtime and dev dependencies are MIT, ISC, Apache-2.0, BSD, or similarly permissive. The only copyleft component in the dependency tree is LGPL-3.0-or-later on <code>sharp-libvips</code> native binaries, which are wrangler dev-only and never shipped to Cloudflare or to end-users. See <a href="https://github.com/kurtpayne/open-distance/blob/main/package-lock.json">package-lock.json</a> for the full SPDX inventory.</p>

    <h2>How attribution travels with API responses</h2>
    <p>Every Distance Matrix JSON response carries a <code>copyrights</code> field reproducing the required short-form notice. The <a href="/coverage">/coverage</a> endpoint includes per-source license URLs and a pointer back to this page.</p>
  </div>
</div>
${SHORT_FOOTER}
</body></html>`;
}

// ---------------------------------------------------------------------------
// /coverage — HTML rendering of the multi-provider accuracy panel, the state
// coverage list, and data sources. JSON shape served by handleCoverage in
// distancematrix.ts via content negotiation.
// ---------------------------------------------------------------------------

function deltaCell(v: number | null, isMe: boolean): string {
  if (v == null) return `<td class="dim">—</td>`;
  const sign = v > 0 ? "+" : "";
  const cls = isMe ? "me" : v === 0 ? "dim" : "";
  return `<td class="${cls}">${sign}${v.toFixed(1)}%</td>`;
}

function rowCell(v: number | null, unit: string): string {
  if (v == null) return `<td class="dim">—</td>`;
  return `<td>${v.toFixed(unit === "mi" ? 1 : 0)}</td>`;
}

function renderCoverageTables(): string {
  const { providers, distance, duration, distance_miles, duration_minutes, generated } = PANEL_SNAPSHOT;
  const head = (label: string) =>
    `<tr><th>${label}</th><th>Routes</th><th>Spread</th>` +
    providers.map(p => `<th>${p === "open-distance" ? "★ open-distance" : p}</th>`).join("") +
    `</tr>`;

  const catRow = (cat: string, s: { routes: number; spread: number; providers: Record<string, number | null> }) =>
    `<tr><td class="cat">${cat}</td><td>${s.routes}</td><td class="spread">${s.spread.toFixed(1)}%</td>` +
    providers.map(p => deltaCell(s.providers[p] ?? null, p === "open-distance")).join("") +
    `</tr>`;

  const distTbl = `<table class="cov-tbl"><thead>${head("Category (distance)")}</thead><tbody>` +
    Object.entries(distance).map(([c, s]) => catRow(c, s)).join("") + `</tbody></table>`;

  const durTbl = `<table class="cov-tbl"><thead>${head("Category (duration)")}</thead><tbody>` +
    Object.entries(duration).map(([c, s]) => catRow(c, s)).join("") + `</tbody></table>`;

  const routeRow = (r: { route: string; category: string; values: Record<string, number | null>; spread: number | null }, unit: string) =>
    `<tr><td class="cat" style="font-family:var(--font-mono);font-size:12px;font-weight:500">${r.route}</td>` +
    `<td class="dim" style="font-size:11px">${r.category}</td>` +
    providers.map(p => {
      const v = r.values[p] ?? null;
      const isMe = p === "open-distance";
      if (v == null) return `<td class="dim">—</td>`;
      return `<td${isMe ? ' class="me"' : ""}>${v.toFixed(unit === "mi" ? 1 : 0)}</td>`;
    }).join("") +
    `<td class="spread">${r.spread != null ? r.spread.toFixed(1) + "%" : "—"}</td></tr>`;

  const routeTbl = (label: string, rows: typeof distance_miles, unit: string) =>
    `<details class="cov-routes"><summary>Show all 44 routes — ${label}</summary>` +
    `<table class="cov-tbl"><thead><tr><th>Route</th><th>Cat</th>` +
    providers.map(p => `<th>${p === "open-distance" ? "★" : p.slice(0, 4)}</th>`).join("") +
    `<th>Spread</th></tr></thead><tbody>` +
    rows.map(r => routeRow(r, unit)).join("") +
    `</tbody></table></details>`;

  return `
    <p class="mono" style="color:var(--ink3);font-size:12.5px">Panel run: ${generated}  ·  44 routes  ·  ${providers.length} providers</p>

    <h2>Distance accuracy</h2>
    <p>Per-category spread (max − min, as % of median) across all ${providers.length} providers. The <code>★ open-distance</code> column is our median deviation from the panel median — values near 0% mean we converge with the rest of the field.</p>
    ${distTbl}
    ${routeTbl("distance, miles", distance_miles, "mi")}

    <h2>Duration accuracy</h2>
    <p>Same shape, for free-flow time. <b>Spreads here are much wider</b> because providers split into a <em>traffic-aware</em> camp (Mapbox, TomTom, sometimes Google) and a <em>free-flow</em> camp (us, OSRM, OpenRouteService, GraphHopper). Neither is "right" — the gap is the modeling difference, not the data quality.</p>
    ${durTbl}
    ${routeTbl("duration, minutes", duration_minutes, "min")}
  `;
}

export function renderCoverage(version: string): string {
  const states = STATE_CODES;
  const stateChips = `<div class="state-chips">${states.map(s => `<span>${s}</span>`).join("")}</div>`;

  return `<!doctype html>
<html lang="en"><head>
${headMeta("Open Distance — coverage & accuracy", "/coverage")}
${FONTS_LINK}
<style>${PROSE_CSS}</style>
</head><body>
${topBarOther("/coverage")}
<div class="wrap">
  <div class="dochead">
    <span class="eyebrow">Coverage &amp; accuracy</span>
    <h1>How well does it work?</h1>
    <p>We measure against the panel below, not against any single provider, because no provider is ground truth. Every routing engine produces a different answer; we show the spread and where we sit in it.</p>
  </div>
  <div class="prose">
    ${renderCoverageTables()}

    <h2>States covered</h2>
    <p>Continental US — the lower 48 states plus DC. Same coverage for the road graph, the geocoder, and the L1 highway overlay.</p>
    ${stateChips}

    <h2>Data sources</h2>
    <p><b>Road graph</b> — <a href="https://download.geofabrik.de/">OpenStreetMap via Geofabrik</a> per-state PBF extracts. Licensed under <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL 1.0</a>. See <a href="/attribution">/attribution</a> for the ODbL §4.3 Produced Work notice that travels with every API response.</p>
    <p><b>Addresses</b> — US DOT <a href="https://nationaladdressdata.gov/">National Address Database</a> (rooftop), <a href="https://openaddresses.io/">OpenAddresses</a> per-source authority points (rooftop; <a href="/attribution/openaddresses.json">per-source manifest</a>), and OSM <code>addr:*</code> nodes (interpolated tier).</p>
    <p><b>Interpolation fallback</b> — <a href="https://www.census.gov/programs-surveys/geography.html">US Census TIGER/Line 2024</a> street segments. Public domain.</p>

    <h2>Data version</h2>
    <p>Currently serving <code>${version}</code>. Refreshed via <a href="https://github.com/kurtpayne/open-distance/blob/main/refresh.sh"><code>./refresh.sh all</code></a> on the maintainer's machine; typical cadence is quarterly.</p>

    <h2>JSON shape of this page</h2>
    <p>The same data is available as JSON: request <code>Accept: application/json</code> against this URL. The JSON includes per-source license URLs, the response-header contract for <code>x-od-router-impl</code>, and the documented deviations from the legacy Distance Matrix wire format. It does <b>not</b> include the panel snapshot — that lives only in this HTML view because the data is large and the JSON is a stable contract.</p>
  </div>
</div>
${SHORT_FOOTER}
</body></html>`;
}

export function htmlHeaders(): Record<string, string> {
  // CSP allows inline styles+scripts (we own both end-to-end). Fonts
  // (style + woff2). No other external resources.
  return {
    "content-type": "text/html; charset=UTF-8",
    "content-security-policy":
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; " +
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
