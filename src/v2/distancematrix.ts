// Tiled Distance Matrix handler. Same wire format as v1; routing internals are tiled.

import { geocode, GeocodeResult } from "./geocode";
import { snapK, getTile, SnapResult } from "./tiles";
import { oneToMany, NodeRef, DestGroup } from "./router";
import { getOverlay, snapL1, bidirAStar } from "./overlay";
import { formatDistance, formatDuration, Units } from "../format";

// Number of snap candidates to keep per endpoint. Lets the router fall back to
// the next-nearest node when the first one is on an isolated graph fragment
// (e.g. a private campus road).
const SNAP_K = 5;

// Above this straight-line distance, use the L1 highway overlay instead of
// the tiled L0 graph. Tuned to: long enough that L0 weighted-A* still works
// reliably under it, short enough that we don't miss anything truly local.
// Straight-line distance above which we try the L1 overlay instead of L0.
// Set high (~1500 mi) because the L1 overlay's forward A* sometimes returns
// ZERO_RESULTS on mid-range corridors where L0 reliably finds a path. Only
// true cross-country (~NYC<->LA scale) actually needs L1. The earlier 200 mi
// threshold caused mid-range regressions after we dropped the reverse CSR.
const L1_DISPATCH_M = 2_400_000;  // ~1500 mi

// L1 dispatch is gated by an env-var feature flag so a half-built / oversized
// L1 binary in R2 can't OOM the isolate. Set L1_ENABLED=1 once the overlay
// binary is known to fit under the 128 MB Worker memory limit.
function l1Enabled(env: Env): boolean {
  return String((env as Record<string, unknown>).L1_ENABLED ?? "") === "1";
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface Env {
  GRAPH: R2Bucket;
  CACHE: KVNamespace;
  DATA_VERSION: string;
  API_KEY: string;
  // Rust-compiled WASM router. Bound via wrangler.toml [wasm_modules].
  // Optional: present when the Worker is built with the WASM module
  // packaged, absent on older deploys -- gate usage with `if (env.ROUTER_WASM)`.
  ROUTER_WASM?: WebAssembly.Module;
  // Per-state D1 shards: GEOCODE_CA, GEOCODE_NY, ...
  // Accessed dynamically by src/v2/geocode.ts via env[`GEOCODE_${state}`].
  [k: string]: unknown;
}

interface Element {
  status: "OK" | "NOT_FOUND" | "ZERO_RESULTS";
  distance?: { text: string; value: number };
  duration?: { text: string; value: number };
}

function splitMulti(v: string | null): string[] {
  if (!v) return [];
  return v.split("|").map(s => s.trim()).filter(Boolean);
}

function jsonResponse(body: unknown, status = 200, cacheControl?: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=UTF-8" };
  if (cacheControl) headers["cache-control"] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

interface ResolvedEndpoint {
  geocode: GeocodeResult;
  snaps: SnapResult[];   // up to SNAP_K nearest road nodes; empty if no snap
}

async function resolveAll(
  qs: string[],
  env: Env,
): Promise<ResolvedEndpoint[]> {
  return Promise.all(qs.map(async q => {
    const g = await geocode(q, env);
    if (g.status !== "OK") return { geocode: g, snaps: [] };
    const s = await snapK(env.GRAPH, env.DATA_VERSION, g.lat, g.lon, SNAP_K);
    return { geocode: g, snaps: s };
  }));
}

function legCacheKey(version: string, src: NodeRef, dst: NodeRef): string {
  // v2 prefix: invalidates legs from the pre-length-fix router.
  return `leg2:${version}:${src.tx},${src.ty},${src.dense}:${dst.tx},${dst.ty},${dst.dense}:driving`;
}

function nodeIdStr(n: NodeRef): string { return `${n.tx},${n.ty},${n.dense}`; }

async function loadLegCacheBatch(
  env: Env,
  src: NodeRef,
  dsts: NodeRef[],
): Promise<Map<string, { timeS: number; lenM: number }>> {
  const out = new Map<string, { timeS: number; lenM: number }>();
  await Promise.all(dsts.map(async d => {
    const v = await env.CACHE.get(legCacheKey(env.DATA_VERSION, src, d), "json") as { t: number; l: number } | null;
    if (v) out.set(nodeIdStr(d), { timeS: v.t, lenM: v.l });
  }));
  return out;
}

async function writeLegCacheBatch(
  env: Env,
  src: NodeRef,
  legs: Map<string, { timeS: number; lenM: number }>,
  dstByKey: Map<string, NodeRef>,
): Promise<void> {
  await Promise.all([...legs.entries()].map(([k, v]) => {
    const d = dstByKey.get(k);
    if (!d) return Promise.resolve();
    return env.CACHE.put(
      legCacheKey(env.DATA_VERSION, src, d),
      JSON.stringify({ t: v.timeS, l: v.lenM }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
  }));
}

async function tryWasmMatrix(
  url: URL, env: Env, originQ: string, destQs: string[],
): Promise<Response | null> {
  // Lazy imports keep cold-start budget on the default TS path.
  const { snapK, packTileId, getTileBytes } = await import("./tiles");
  const { loadWasmRouter, dijkstraOneToMany, isLoaded } = await import("./wasm_router");
  const wasmMod = (await import("../../rust-router/target/wasm32-unknown-unknown/release/od_router.wasm")).default;

  const oG = await geocode(originQ, env);
  if (oG.status !== "OK") return null;
  const oGeo = oG as { lat: number; lon: number; normalized: string; match: string };

  // Geocode every destination + snap them. A destination that fails geocode
  // gets a placeholder so the response shape stays aligned.
  const destResolved: Array<
    | { ok: true; q: string; normalized: string; match: string; lat: number; lon: number; snap: { tx: number; ty: number; dense: number } }
    | { ok: false; q: string; normalized: string; match: string }
  > = [];
  for (const dq of destQs) {
    const dG = await geocode(dq, env);
    if (dG.status !== "OK") {
      destResolved.push({ ok: false, q: dq, normalized: (dG as { normalized?: string }).normalized ?? dq, match: "" });
      continue;
    }
    const d = dG as { lat: number; lon: number; normalized: string; match: string };
    const snaps = await snapK(env.GRAPH, env.DATA_VERSION, d.lat, d.lon, 1);
    if (snaps.length === 0) {
      destResolved.push({ ok: false, q: dq, normalized: d.normalized, match: d.match });
      continue;
    }
    destResolved.push({ ok: true, q: dq, normalized: d.normalized, match: d.match,
                       lat: d.lat, lon: d.lon,
                       snap: { tx: snaps[0].tx, ty: snaps[0].ty, dense: snaps[0].dense } });
  }
  const oSnaps = await snapK(env.GRAPH, env.DATA_VERSION, oGeo.lat, oGeo.lon, 1);
  if (oSnaps.length === 0) return null;
  const oSnap = oSnaps[0];

  // Corridor = bbox across all routable endpoints + 1-tile buffer. Cap at 16.
  let txMin = oSnap.tx, txMax = oSnap.tx, tyMin = oSnap.ty, tyMax = oSnap.ty;
  let anyRoutable = false;
  for (const d of destResolved) {
    if (!d.ok) continue;
    anyRoutable = true;
    txMin = Math.min(txMin, d.snap.tx);
    txMax = Math.max(txMax, d.snap.tx);
    tyMin = Math.min(tyMin, d.snap.ty);
    tyMax = Math.max(tyMax, d.snap.ty);
  }
  if (!anyRoutable) return null;
  txMin -= 1; txMax += 1; tyMin -= 1; tyMax += 1;
  const tileCount = (txMax - txMin + 1) * (tyMax - tyMin + 1);
  if (tileCount > 16) return null;

  if (!isLoaded()) await loadWasmRouter(wasmMod);

  // Fetch corridor tiles in parallel (hits warm bytes LRU on repeat queries).
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

  // One-to-many Dijkstra: single traversal services every routable destination.
  const routableIdx: number[] = [];
  const dstsForRust: { tileId: number; dense: number }[] = [];
  for (let j = 0; j < destResolved.length; j++) {
    const d = destResolved[j];
    if (!d.ok) continue;
    routableIdx.push(j);
    dstsForRust.push({ tileId: packTileId(d.snap.tx, d.snap.ty), dense: d.snap.dense });
  }
  const out = dijkstraOneToMany(
    tiles, packTileId(oSnap.tx, oSnap.ty), oSnap.dense, dstsForRust, 500_000,
  );

  // Assemble the response. Match the shape of the default TS path.
  const unitsParam = (url.searchParams.get("units") || "imperial").toLowerCase();
  const units: Units = unitsParam === "metric" ? "metric" : "imperial";
  const destination_addresses = destResolved.map(d => d.normalized);
  const destination_matches = destResolved.map(d => d.match);

  const elements: Element[] = destResolved.map(() => ({ status: "NOT_FOUND" }));
  for (let k = 0; k < routableIdx.length; k++) {
    const j = routableIdx[k];
    const r = out.results[k];
    if (r.ok) {
      const meters = Math.round(r.lenM);
      const seconds = Math.round(r.timeS);
      elements[j] = {
        status: "OK",
        distance: { text: formatDistance(meters, units), value: meters },
        duration: { text: formatDuration(seconds), value: seconds },
      };
    } else {
      elements[j] = { status: "ZERO_RESULTS" };
    }
  }

  const body = {
    destination_addresses,
    destination_matches,
    origin_addresses: [oGeo.normalized],
    origin_matches: [oGeo.match],
    rows: [{ elements }],
    status: "OK",
    data_version: env.DATA_VERSION,
    copyrights:
      "Map data © OpenStreetMap contributors (ODbL 1.0). " +
      "Addresses: NAD (US DOT, public domain), OpenAddresses (per-source -- see /attribution/openaddresses.json), " +
      "OSM addr:* nodes (ODbL 1.0). Interpolation: US Census TIGER 2024 (public domain). " +
      "Full attribution: https://open-distance.com/attribution",
  };
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "public, max-age=3600, s-maxage=3600",
    "x-od-router-impl": destQs.length === 1 ? "wasm" : "wasm-one-to-many",
    "x-od-router-settled": String(out.settled),
    "x-od-router-tiles": String(tiles.length),
  };
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export async function handleDistanceMatrix(url: URL, env: Env): Promise<Response> {
  const origins = splitMulti(url.searchParams.get("origins"));
  const destinations = splitMulti(url.searchParams.get("destinations"));

  if (origins.length === 0 || destinations.length === 0) {
    return jsonResponse({
      status: "INVALID_REQUEST",
      error_message: "Missing origins or destinations",
      rows: [], origin_addresses: [], destination_addresses: [],
    });
  }
  if (origins.length * destinations.length > 100) {
    return jsonResponse({
      status: "MAX_ELEMENTS_EXCEEDED",
      error_message: "Max 100 elements (origins × destinations) per request.",
      rows: [], origin_addresses: [], destination_addresses: [],
    });
  }

  // Opt-in routing via the Rust-compiled WASM router. Supports the single-
  // pair case (1 origin x 1 destination) and the matrix case (any number
  // of destinations for a single origin) using the WASM one-to-many
  // Dijkstra. Multi-origin matrix queries still go through the TS path
  // (Rust handles one source at a time today). Adds x-od-router-impl on
  // the response when WASM actually served the query.
  if (url.searchParams.get("router") === "wasm" && origins.length === 1) {
    const r = await tryWasmMatrix(url, env, origins[0], destinations);
    if (r) return r;
    // else: corridor too large, snap failed, or one-to-many returned no
    // results -- fall through to the TS path for the same query.
  }

  const unitsParam = (url.searchParams.get("units") || "imperial").toLowerCase();
  const units: Units = unitsParam === "metric" ? "metric" : "imperial";

  const oR = await resolveAll(origins, env);
  const dR = await resolveAll(destinations, env);

  const originAddresses = oR.map((r, i) => r.geocode.status === "OK" ? (r.geocode as { normalized: string }).normalized : origins[i]);
  const destinationAddresses = dR.map((r, i) => r.geocode.status === "OK" ? (r.geocode as { normalized: string }).normalized : destinations[i]);
  // Per-endpoint confidence indicator. Mirrors the address arrays.
  //   rooftop      = exact mapped point (NAD / OA rooftop dataset)
  //   interpolated = OSM addr-tagged node, or TIGER segment interpolation -- could be off by ~30-100m
  //   coords       = caller passed "lat,lng" directly; no geocode performed
  //   "" (empty)   = geocode failed (the address shows as the raw input)
  const originMatches = oR.map(r => r.geocode.status === "OK" ? (r.geocode as { match: string }).match : "");
  const destinationMatches = dR.map(r => r.geocode.status === "OK" ? (r.geocode as { match: string }).match : "");

  const rows: { elements: Element[] }[] = [];

  // Each destination becomes a group keyed by its index. Group candidates are
  // the top-K snap results -- the router settles when it reaches any of them.
  // destLat/destLon come from the geocoded address (within ~200m of any snap
  // candidate); A* uses them as the heuristic target.
  const destGroups: DestGroup[] = dR.map((r, j) => {
    const g = r.geocode as { lat?: number; lon?: number };
    return {
      id: `d${j}`,
      candidates: r.snaps.map(s => ({ tx: s.tx, ty: s.ty, dense: s.dense })),
      destLat: g.lat ?? 0,
      destLon: g.lon ?? 0,
    };
  });
  // Leg-cache key uses just the top-1 candidate (the common case). If we have
  // to use a later candidate, that result still gets cached so future requests
  // for the same address skip the work.
  const destTop1: (NodeRef | null)[] = dR.map(r => r.snaps[0] ? { tx: r.snaps[0].tx, ty: r.snaps[0].ty, dense: r.snaps[0].dense } : null);

  for (let i = 0; i < origins.length; i++) {
    const elements: Element[] = [];
    const oSnaps = oR[i].snaps;
    if (oR[i].geocode.status !== "OK" || oSnaps.length === 0) {
      for (let j = 0; j < destinations.length; j++) elements.push({ status: "NOT_FOUND" });
      rows.push({ elements });
      continue;
    }
    const srcNode: NodeRef = { tx: oSnaps[0].tx, ty: oSnaps[0].ty, dense: oSnaps[0].dense };

    // Leg cache for the top-1-to-top-1 path. Only loads cached legs for
    // destinations where top-1 snap is non-null.
    const cacheableDests = destTop1.filter((n): n is NodeRef => n !== null);
    const cached = await loadLegCacheBatch(env, srcNode, cacheableDests);

    // Build the set of dest groups that still need routing. Skip L0 for
    // destinations whose straight-line distance is already past the L1
    // dispatch threshold -- they'll be served by the L1 overlay below, and
    // running L0 first just fills the tile LRU with tiles we'll then have
    // to evict to make room for L1 (the 110 MB overlay + a hot L0 LRU OOMs
    // the 128 MB isolate).
    const oGeoEarly = oR[i].geocode as { lat?: number; lon?: number };
    const needRouting: DestGroup[] = [];
    for (let j = 0; j < destinations.length; j++) {
      const t1 = destTop1[j];
      if (!t1) continue;
      if (cached.has(nodeIdStr(t1))) continue;
      if (destGroups[j].candidates.length === 0) continue;
      const dGeoEarly = dR[j].geocode as { lat?: number; lon?: number };
      if (l1Enabled(env)
          && oGeoEarly.lat !== undefined && dGeoEarly.lat !== undefined) {
        const straight = haversineMeters(oGeoEarly.lat!, oGeoEarly.lon!, dGeoEarly.lat!, dGeoEarly.lon!);
        if (straight >= L1_DISPATCH_M) continue;  // dispatch directly to L1 below
      }
      needRouting.push(destGroups[j]);
    }

    let computed: Map<string, { timeS: number; lenM: number }> = new Map();
    if (needRouting.length > 0) {
      computed = await oneToMany(env.GRAPH, env.DATA_VERSION, srcNode, needRouting);
      // Cache by top-1 for each routed destination (even if route used a later candidate).
      const legsToCache = new Map<string, { timeS: number; lenM: number }>();
      const dstByKey = new Map<string, NodeRef>();
      for (const g of needRouting) {
        const leg = computed.get(g.id);
        if (!leg) continue;
        // Find which destination index this group belongs to.
        const idx = parseInt(g.id.slice(1), 10);
        const t1 = destTop1[idx];
        if (!t1) continue;
        const k = nodeIdStr(t1);
        legsToCache.set(k, leg);
        dstByKey.set(k, t1);
      }
      await writeLegCacheBatch(env, srcNode, legsToCache, dstByKey);
    }

    // L1 fallback for long-distance pairs that the L0 router gave up on
    // (ZERO_RESULTS) or that exceed the dispatch threshold straight-line.
    const oGeo = oR[i].geocode as { lat?: number; lon?: number };
    const longLegs = new Map<number, { timeS: number; lenM: number } | null>();
    let needL1: number[] = [];
    for (let j = 0; j < destinations.length; j++) {
      const t1 = destTop1[j];
      if (!t1 || dR[j].geocode.status !== "OK") continue;
      const dGeo = dR[j].geocode as { lat?: number; lon?: number };
      if (oGeo.lat === undefined || dGeo.lat === undefined) continue;
      const straight = haversineMeters(oGeo.lat!, oGeo.lon!, dGeo.lat!, dGeo.lon!);
      const haveL0 = (cached.get(nodeIdStr(t1)) ?? computed.get(`d${j}`)) !== undefined;
      if (straight >= L1_DISPATCH_M || !haveL0) needL1.push(j);
    }
    if (needL1.length > 0 && l1Enabled(env)) {
      try {
        const overlay = await getOverlay(env.GRAPH, env.DATA_VERSION);
        for (const j of needL1) {
          const dGeo = dR[j].geocode as { lat?: number; lon?: number };
          if (oGeo.lat === undefined || dGeo.lat === undefined) { longLegs.set(j, null); continue; }
          const sSnap = snapL1(overlay, oGeo.lat!, oGeo.lon!);
          const tSnap = snapL1(overlay, dGeo.lat!, dGeo.lon!);
          if (!sSnap || !tSnap) { longLegs.set(j, null); continue; }
          const leg = bidirAStar(overlay, sSnap.node, tSnap.node);
          longLegs.set(j, leg);
        }
      } catch {
        // Overlay not available -- fall through; affected dests will return ZERO_RESULTS.
      }
    }

    for (let j = 0; j < destinations.length; j++) {
      const t1 = destTop1[j];
      if (!t1 || dR[j].geocode.status !== "OK") {
        elements.push({ status: "NOT_FOUND" });
        continue;
      }
      // Prefer L0 leg when present; otherwise fall back to L1.
      const l0Leg = cached.get(nodeIdStr(t1)) ?? computed.get(`d${j}`);
      const l1Leg = longLegs.get(j);
      const leg = l0Leg ?? l1Leg ?? null;
      if (!leg) { elements.push({ status: "ZERO_RESULTS" }); continue; }
      const meters = Math.round(leg.lenM);
      const seconds = Math.round(leg.timeS);
      elements.push({
        status: "OK",
        distance: { text: formatDistance(meters, units), value: meters },
        duration: { text: formatDuration(seconds), value: seconds },
      });
    }
    rows.push({ elements });
  }

  // Identical requests are cacheable on Cloudflare's edge for an hour --
  // huge win for the house-hunting loop that re-scores the same candidate
  // against the same destinations.
  return jsonResponse({
    destination_addresses: destinationAddresses,
    destination_matches: destinationMatches,
    origin_addresses: originAddresses,
    origin_matches: originMatches,
    rows,
    status: "OK",
    // YYYY-MM of the upstream data build that the underlying tiles +
    // address shards came from. Refreshed quarterly. See /coverage for
    // the per-source license URLs and the per-source OA manifest.
    data_version: env.DATA_VERSION,
    // ODbL §4.3 Produced Work notice. Travels with every response so that
    // downstream callers who just render the JSON also surface the
    // attribution required by OpenStreetMap. See /attribution for the
    // full per-source manifest.
    copyrights:
      "Map data © OpenStreetMap contributors (ODbL 1.0). " +
      "Addresses: NAD (US DOT, public domain), OpenAddresses (per-source -- see /attribution/openaddresses.json), " +
      "OSM addr:* nodes (ODbL 1.0). Interpolation: US Census TIGER 2024 (public domain). " +
      "Full attribution: https://open-distance.com/attribution",
  }, 200, "public, max-age=3600, s-maxage=3600");
}

export async function handleCoverage(env: Env): Promise<Response> {
  const states = [
    "AL","AZ","AR","CA","CO","CT","DE","DC","FL","GA","ID","IL","IN","IA","KS","KY",
    "LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC",
    "ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  ];
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "public, max-age=86400, s-maxage=86400",
  };
  return new Response(JSON.stringify({
    version: env.DATA_VERSION,
    coverage: "continental US (lower 48 + DC)",
    states,
    sources: {
      roads: {
        name: "OpenStreetMap",
        description: "Geofabrik per-state PBF extracts, built into 0.25 deg L0 road tiles",
        license: "ODbL 1.0",
        license_url: "https://opendatacommons.org/licenses/odbl/1-0/",
      },
      addresses: [
        {
          name: "NAD",
          description: "US DOT National Address Database (rooftop)",
          license: "public domain (17 USC § 105)",
          license_url: "https://nationaladdressdata.gov/",
        },
        {
          name: "OpenAddresses",
          description: "Per-county / per-city authority points (rooftop)",
          license: "per-source -- see attribution_endpoint",
          license_url: "https://openaddresses.io/",
        },
        {
          name: "OSM addr:* nodes",
          description: "OpenStreetMap address-tagged nodes (interpolated)",
          license: "ODbL 1.0",
          license_url: "https://opendatacommons.org/licenses/odbl/1-0/",
        },
      ],
      interpolation: {
        name: "TIGER/Line 2024",
        description: "US Census Bureau edges-geodatabase, per-state",
        license: "public domain (work of the federal government)",
        license_url: "https://www.census.gov/programs-surveys/geography.html",
      },
    },
    attribution_endpoint: "/attribution",
    openaddresses_per_source_manifest: "/attribution/openaddresses.json",
    confidence_indicator: {
      response_fields: ["origin_matches", "destination_matches"],
      values: {
        rooftop: "exact mapped point (NAD or OpenAddresses)",
        interpolated: "OSM addr-node or TIGER segment interpolation (~30-100m)",
        coords: "caller-supplied lat,lng directly",
        empty: "geocode failed; raw input echoed",
      },
    },
    deviations_from_google: [
      "key= is our own API key, not Google's",
      "no live traffic; free-flow time only",
      "place_id: inputs return NOT_FOUND",
      "long cross-country routes may return ZERO_RESULTS (commute distances work)",
      "centroid-quality geocodes return NOT_FOUND instead of approximate",
    ],
  }), { status: 200, headers });
}

// /healthz helper: confirm a sentinel tile is fetchable.
export async function healthCheck(env: Env): Promise<Response> {
  // For v2, healthz checks that the manifest object is reachable and at least one tile exists.
  try {
    // Probe tile 230_510 (SF area). For US-wide, this should be a known-good tile or the manifest.
    const tile = await getTile(env.GRAPH, env.DATA_VERSION, 230, 510);
    if (!tile) {
      return new Response(JSON.stringify({
        status: "warming",
        version: env.DATA_VERSION,
        error: "sentinel tile not found yet",
      }), { status: 503, headers: { "content-type": "application/json; charset=UTF-8" } });
    }
    return new Response(JSON.stringify({
      status: "ok",
      version: env.DATA_VERSION,
      mode: "tiled",
      sentinel_tile: `${tile.tx}_${tile.ty}`,
      sentinel_nodes: tile.nLocal,
    }), { headers: { "content-type": "application/json; charset=UTF-8" } });
  } catch (e) {
    return new Response(JSON.stringify({
      status: "error",
      version: env.DATA_VERSION,
      error: (e as Error).message,
    }), { status: 503, headers: { "content-type": "application/json; charset=UTF-8" } });
  }
}
