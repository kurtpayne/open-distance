// Tiled Distance Matrix handler. Same wire format as v1; routing internals are tiled.

import { geocode, GeocodeResult } from "./geocode";
import { snapK, getTile, SnapResult } from "./tiles";
import { oneToMany, NodeRef, DestGroup } from "./router";
import { formatDistance, formatDuration, Units } from "../format";

// Number of snap candidates to keep per endpoint. Lets the router fall back to
// the next-nearest node when the first one is on an isolated graph fragment
// (e.g. a private campus road).
const SNAP_K = 5;

export interface Env {
  GRAPH: R2Bucket;
  CACHE: KVNamespace;
  DATA_VERSION: string;
  API_KEY: string;
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
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
  const destGroups: DestGroup[] = dR.map((r, j) => ({
    id: `d${j}`,
    candidates: r.snaps.map(s => ({ tx: s.tx, ty: s.ty, dense: s.dense })),
  }));
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

    // Build the set of dest groups that still need routing.
    const needRouting: DestGroup[] = [];
    for (let j = 0; j < destinations.length; j++) {
      const t1 = destTop1[j];
      if (!t1) continue;
      if (cached.has(nodeIdStr(t1))) continue;
      if (destGroups[j].candidates.length === 0) continue;
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

    for (let j = 0; j < destinations.length; j++) {
      const t1 = destTop1[j];
      if (!t1 || dR[j].geocode.status !== "OK") {
        elements.push({ status: "NOT_FOUND" });
        continue;
      }
      const cachedLeg = cached.get(nodeIdStr(t1));
      const computedLeg = computed.get(`d${j}`);
      const leg = cachedLeg ?? computedLeg;
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

  return jsonResponse({
    destination_addresses: destinationAddresses,
    destination_matches: destinationMatches,
    origin_addresses: originAddresses,
    origin_matches: originMatches,
    rows,
    status: "OK",
  });
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
