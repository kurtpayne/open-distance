// Tiled Distance Matrix handler. Same wire format as v1; routing internals are tiled.

import { geocode, GeocodeResult } from "./geocode";
import { snap, getTile } from "./tiles";
import { oneToMany, NodeRef } from "./router";
import { formatDistance, formatDuration, Units } from "../format";

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
  snap: { tx: number; ty: number; dense: number; distM: number } | null;
}

async function resolveAll(
  qs: string[],
  env: Env,
): Promise<ResolvedEndpoint[]> {
  return Promise.all(qs.map(async q => {
    const g = await geocode(q, env);
    if (g.status !== "OK") return { geocode: g, snap: null };
    const s = await snap(env.GRAPH, env.DATA_VERSION, g.lat, g.lon);
    return { geocode: g, snap: s };
  }));
}

function legCacheKey(version: string, src: NodeRef, dst: NodeRef): string {
  return `leg:${version}:${src.tx},${src.ty},${src.dense}:${dst.tx},${dst.ty},${dst.dense}:driving`;
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

  const rows: { elements: Element[] }[] = [];

  // Pre-warm: snap may have already fetched origin tiles. Build a destination NodeRef list.
  const destNodes: (NodeRef | null)[] = dR.map(r => r.snap ? { tx: r.snap.tx, ty: r.snap.ty, dense: r.snap.dense } : null);
  const uniqueDestNodes: NodeRef[] = [];
  const uniqueDestKeys = new Set<string>();
  for (const n of destNodes) {
    if (!n) continue;
    const k = nodeIdStr(n);
    if (uniqueDestKeys.has(k)) continue;
    uniqueDestKeys.add(k);
    uniqueDestNodes.push(n);
  }

  for (let i = 0; i < origins.length; i++) {
    const elements: Element[] = [];
    const oSnap = oR[i].snap;
    if (oR[i].geocode.status !== "OK" || !oSnap) {
      for (let j = 0; j < destinations.length; j++) elements.push({ status: "NOT_FOUND" });
      rows.push({ elements });
      continue;
    }
    const srcNode: NodeRef = { tx: oSnap.tx, ty: oSnap.ty, dense: oSnap.dense };

    const cached = await loadLegCacheBatch(env, srcNode, uniqueDestNodes);
    const missing = uniqueDestNodes.filter(n => !cached.has(nodeIdStr(n)));
    let computed: Map<string, { timeS: number; lenM: number }> = new Map();
    if (missing.length > 0) {
      computed = await oneToMany(env.GRAPH, env.DATA_VERSION, srcNode, missing);
      const dstByKey = new Map<string, NodeRef>();
      for (const n of missing) dstByKey.set(nodeIdStr(n), n);
      await writeLegCacheBatch(env, srcNode, computed, dstByKey);
    }

    for (let j = 0; j < destinations.length; j++) {
      const dn = destNodes[j];
      if (!dn || dR[j].geocode.status !== "OK") {
        elements.push({ status: "NOT_FOUND" });
        continue;
      }
      const k = nodeIdStr(dn);
      const leg = cached.get(k) ?? computed.get(k);
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
    origin_addresses: originAddresses,
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
