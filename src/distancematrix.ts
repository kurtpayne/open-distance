// Tiled Distance Matrix handler. Wire format is the legacy Distance Matrix
// JSON shape -- additive fields only, so existing clients keep working.

import { geocode, GeocodeResult } from "./geocode";
import { snapK, getTile, SnapResult } from "./tiles";
import { oneToMany, NodeRef, DestGroup } from "./router";
import { formatDistance, formatDuration, Units } from "./format";
import { haversineMeters } from "./geo";
import { STATE_CODES } from "./state_parser";

// Number of snap candidates to keep per endpoint. Lets the router fall back to
// the next-nearest node when the first one is on an isolated graph fragment
// (e.g. a private campus road).
const SNAP_K = 5;


export interface Env {
  GRAPH: R2Bucket;
  CACHE: KVNamespace;
  DATA_VERSION: string;
  // L1 highway overlay router. Optional: present when the Worker is built
  // with the DurableObject migration applied. Used as the cross-country
  // fallback when the tiled L0 router doesn't reach a destination.
  L1_ROUTER?: DurableObjectNamespace;
  // Per-state D1 shards: GEOCODE_CA, GEOCODE_NY, ...
  // Accessed dynamically by src/geocode.ts via env[`GEOCODE_${state}`].
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

// Cache only fully-successful responses. NOT_FOUND / ZERO_RESULTS mean either
// the geocoder couldn't place an endpoint or the router couldn't reach it; both
// of those answers can change as data improves (a shard reload, a new tile
// build), and a 1-hour cache would hide that recovery from clients.
function cachePolicyFor(rows: { elements: Element[] }[]): string {
  const allOk = rows.length > 0 && rows.every(r => r.elements.length > 0 && r.elements.every(e => e.status === "OK"));
  return allOk ? "public, max-age=3600, s-maxage=3600" : "no-store";
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
  // Versioned prefix lets us invalidate cached legs on router changes.
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

/**
 * Returns true if the origin AND every destination is a literal "lat,lng"
 * input AND the diagonal of their bounding box is small enough that the
 * Rust one-to-many Dijkstra (no heuristic) will settle inside the 500K-
 * node cap. We skip the auto-route for address queries (would require
 * geocoding to check bbox, which we'd then re-do downstream).
 *
 * Threshold (~3 km) is set conservatively so WASM never regresses on the
 * 44-route benchmark; matrices that fit get the sub-millisecond Rust
 * Dijkstra, anything larger goes through the TS A*.
 */
const WASM_AUTO_BBOX_M = 3_000;
const LATLNG_RE = /^-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?$/;
function parseLatLng(s: string): [number, number] | null {
  if (!LATLNG_RE.test(s)) return null;
  const [lat, lon] = s.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [lat, lon];
}
function wasmAutoOk(originQ: string, destQs: string[]): boolean {
  const oC = parseLatLng(originQ);
  if (!oC) return false;
  let latMin = oC[0], latMax = oC[0], lonMin = oC[1], lonMax = oC[1];
  for (const dq of destQs) {
    const dC = parseLatLng(dq);
    if (!dC) return false;
    latMin = Math.min(latMin, dC[0]); latMax = Math.max(latMax, dC[0]);
    lonMin = Math.min(lonMin, dC[1]); lonMax = Math.max(lonMax, dC[1]);
  }
  return haversineMeters(latMin, lonMin, latMax, lonMax) <= WASM_AUTO_BBOX_M;
}

async function tryWasmMatrix(
  url: URL, env: Env, originQ: string, destQs: string[],
): Promise<Response | null> {
  // Lazy imports keep cold-start budget on the default TS path.
  const { snapK, packTileId, getTileBytes } = await import("./tiles");
  const { loadWasmRouter, dijkstraOneToMany, isLoaded } = await import("./wasm_router");
  const wasmMod = (await import("../rust-router/target/wasm32-unknown-unknown/release/od_router.wasm")).default;

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

  // If the Rust Dijkstra didn't reach any routable destination, fall back
  // to the TS path instead of returning ZERO_RESULTS. (No heuristic means
  // it can hit the settled cap on dense urban graphs before reaching a
  // destination the TS A* would have found.)
  const wasmFailed = routableIdx.some((_, k) => !out.results[k].ok);
  if (wasmFailed) return null;

  const elements: Element[] = destResolved.map(() => ({ status: "NOT_FOUND" }));
  for (let k = 0; k < routableIdx.length; k++) {
    const j = routableIdx[k];
    const r = out.results[k];
    const meters = Math.round(r.lenM);
    const seconds = Math.round(r.timeS);
    elements[j] = {
      status: "OK",
      distance: { text: formatDistance(meters, units), value: meters },
      duration: { text: formatDuration(seconds), value: seconds },
    };
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
    "cache-control": cachePolicyFor(body.rows),
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

  // Routing: WASM (Rust) is used when the query is single-origin AND
  // ?router=wasm is set OR every endpoint is close to each other (a small
  // bounding box where the Rust one-to-many Dijkstra terminates fast).
  //
  // The Rust Dijkstra has no heuristic, so on dense urban graphs it can
  // settle 500K+ nodes before reaching a destination 5+ miles away. The
  // TS A* with weighted haversine doesn't have that issue. We pick a
  // straight-line bbox threshold conservative enough that WASM never
  // regresses on the 44-route benchmark; matrices that fit get a sub-
  // millisecond inner loop, larger ones go through the TS A*.
  //
  // Set ?router=wasm to force the WASM path; set ?router=ts to force TS.
  const routerParam = url.searchParams.get("router");
  if (origins.length === 1 && routerParam !== "ts"
      && (routerParam === "wasm" || wasmAutoOk(origins[0], destinations))) {
    const r = await tryWasmMatrix(url, env, origins[0], destinations);
    if (r) return r;
    // null = corridor too large, snap failed, or one-to-many returned no
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

    // Build the set of dest groups that still need routing. For obviously
    // cross-country pairs (>1000 km haversine), skip L0 and go straight to L1 --
    // the L0 router would burn the Worker's CPU budget on an unsolvable Dijkstra
    // before yielding to the L1 fallback.
    const oGeoEarly = oR[i].geocode as { lat?: number; lon?: number };
    const L0_MAX_KM = 1000;
    const needRouting: DestGroup[] = [];
    for (let j = 0; j < destinations.length; j++) {
      const t1 = destTop1[j];
      if (!t1) continue;
      if (cached.has(nodeIdStr(t1))) continue;
      if (destGroups[j].candidates.length === 0) continue;
      const dGeoEarly = dR[j].geocode as { lat?: number; lon?: number };
      if (oGeoEarly.lat !== undefined && dGeoEarly.lat !== undefined) {
        const dKm = haversineMeters(oGeoEarly.lat, oGeoEarly.lon!, dGeoEarly.lat, dGeoEarly.lon!) / 1000;
        if (dKm > L0_MAX_KM) continue;
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

    // For each destination still unrouted by L0 (cached + computed), try
    // the L1 DurableObject. The DO holds the highway overlay in memory
    // persistently; bidir A* terminates in 50-300 ms warm. We skip
    // destinations that the L0 router already solved.
    const oGeo = oR[i].geocode as { lat?: number; lon?: number };
    const l1Legs = new Map<number, { timeS: number; lenM: number } | null>();
    const needL1: number[] = [];
    for (let j = 0; j < destinations.length; j++) {
      const t1 = destTop1[j];
      if (!t1 || dR[j].geocode.status !== "OK") continue;
      if (cached.has(nodeIdStr(t1))) continue;
      if (computed.has(`d${j}`)) continue;
      needL1.push(j);
    }
    if (needL1.length > 0 && env.L1_ROUTER) {
      try {
        const id = env.L1_ROUTER.idFromName("global");
        const stub = env.L1_ROUTER.get(id);
        for (const j of needL1) {
          const dGeo = dR[j].geocode as { lat?: number; lon?: number };
          if (oGeo.lat === undefined || dGeo.lat === undefined) { l1Legs.set(j, null); continue; }
          try {
            const resp = await stub.fetch("https://l1/route", {
              method: "POST",
              body: JSON.stringify({ srcLat: oGeo.lat, srcLon: oGeo.lon, dstLat: dGeo.lat, dstLon: dGeo.lon }),
            });
            const body = await resp.json() as { ok: boolean; timeS?: number; lenM?: number };
            if (body.ok && typeof body.timeS === "number" && typeof body.lenM === "number") {
              l1Legs.set(j, { timeS: body.timeS, lenM: body.lenM });
            } else {
              l1Legs.set(j, null);
            }
          } catch {
            l1Legs.set(j, null);
          }
        }
      } catch {
        // L1 router not available; affected destinations return ZERO_RESULTS.
      }
    }

    for (let j = 0; j < destinations.length; j++) {
      const t1 = destTop1[j];
      if (!t1 || dR[j].geocode.status !== "OK") {
        elements.push({ status: "NOT_FOUND" });
        continue;
      }
      // Prefer the L0 leg when present; fall back to the L1 leg.
      const leg = cached.get(nodeIdStr(t1)) ?? computed.get(`d${j}`) ?? l1Legs.get(j);
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

  // Fully-OK responses are cacheable on Cloudflare's edge for an hour -- huge
  // win for callers that re-score the same candidate against the same
  // destinations. Anything with a NOT_FOUND/ZERO_RESULTS element falls under
  // no-store so that a later data refresh can serve the recovery cleanly.
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
  }, 200, cachePolicyFor(rows));
}

export async function handleCoverage(env: Env, req?: Request): Promise<Response> {
  const accept = req?.headers.get("accept") || "";
  const wantsHtml = accept.includes("text/html");
  if (wantsHtml) {
    const { renderCoverage } = await import("./site");
    return new Response(renderCoverage(env.DATA_VERSION), {
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "public, max-age=86400, s-maxage=86400" },
    });
  }
  const states = STATE_CODES;
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
    routing: {
      default: "auto",
      implementations: {
        wasm: "Rust-compiled WebAssembly. Multi-tile Dijkstra one-to-many with sub-ms inner loop. Auto-selected when origin + destinations are coords with a small bounding box; forceable via ?router=wasm.",
        ts: "TypeScript tile-paged weighted A*. Handles address inputs, longer distances, multi-origin matrices. Forceable via ?router=ts.",
      },
      response_header: "x-od-router-impl: 'wasm-one-to-many' | 'wasm' | (absent = TypeScript path)",
    },
    confidence_indicator: {
      response_fields: ["origin_matches", "destination_matches"],
      values: {
        rooftop: "exact mapped point (NAD or OpenAddresses)",
        interpolated: "OSM addr-node or TIGER segment interpolation (~30-100m)",
        coords: "caller-supplied lat,lng directly",
        empty: "geocode failed; raw input echoed",
      },
    },
    // How this endpoint differs from the legacy Distance Matrix semantics.
    // The wire format itself is byte-compatible; these are the behavioral
    // deviations a caller porting from a stricter implementation should know.
    deviations: [
      "no API key required; per-IP rate limit (see /docs for headers)",
      "no live traffic; free-flow time only",
      "place_id: inputs return NOT_FOUND",
      "centroid-quality geocodes return NOT_FOUND instead of approximate",
      "response includes additive fields: origin_matches, destination_matches, copyrights, data_version",
    ],
  }), { status: 200, headers });
}

// /healthz helper: confirm a sentinel tile is fetchable.
export async function healthCheck(env: Env): Promise<Response> {
  // /healthz probes the manifest object is reachable and at least one tile exists.
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
