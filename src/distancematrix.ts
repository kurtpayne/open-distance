import { geocode, GeocodeResult } from "./geocode";
import { getGraph, snap, oneToMany, Graph } from "./graph";
import { formatDistance, formatDuration, Units } from "./format";

export interface Env {
  GRAPH: R2Bucket;
  GEOCODE: D1Database;
  CACHE: KVNamespace;
  DATA_VERSION: string;
  API_KEY: string;
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

async function geocodeAll(
  qs: string[],
  env: Env,
): Promise<{ results: GeocodeResult[]; nodes: (number | null)[]; graph: Graph }> {
  const graph = await getGraph(env.GRAPH, env.DATA_VERSION);
  // Run geocodes in parallel.
  const results = await Promise.all(qs.map(q => geocode(q, env)));
  const nodes: (number | null)[] = results.map(r => {
    if (r.status !== "OK") return null;
    const s = snap(graph, r.lat, r.lon);
    return s ? s.node : null;
  });
  return { results, nodes, graph };
}

function legCacheKey(version: string, src: number, dst: number): string {
  return `leg:${version}:${src}:${dst}:driving`;
}

async function loadLegCacheBatch(
  env: Env,
  src: number,
  dsts: number[],
): Promise<Map<number, { timeS: number; lenM: number }>> {
  const out = new Map<number, { timeS: number; lenM: number }>();
  await Promise.all(dsts.map(async d => {
    const v = await env.CACHE.get(legCacheKey(env.DATA_VERSION, src, d), "json") as { t: number; l: number } | null;
    if (v) out.set(d, { timeS: v.t, lenM: v.l });
  }));
  return out;
}

async function writeLegCacheBatch(
  env: Env,
  src: number,
  legs: Map<number, { timeS: number; lenM: number }>,
): Promise<void> {
  await Promise.all([...legs.entries()].map(([d, v]) =>
    env.CACHE.put(
      legCacheKey(env.DATA_VERSION, src, d),
      JSON.stringify({ t: v.timeS, l: v.lenM }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ),
  ));
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

  const og = await geocodeAll(origins, env);
  const dg = await geocodeAll(destinations, env);

  const originAddresses = og.results.map((r, i) => r.status === "OK" ? r.normalized : origins[i]);
  const destinationAddresses = dg.results.map((r, i) => r.status === "OK" ? r.normalized : destinations[i]);

  const rows: { elements: Element[] }[] = [];

  const allDestNodes: number[] = dg.nodes.filter((n): n is number => n !== null);
  const uniqueDestNodes = [...new Set(allDestNodes)];

  for (let i = 0; i < origins.length; i++) {
    const elements: Element[] = [];
    const oNode = og.nodes[i];

    if (oNode === null || og.results[i].status !== "OK") {
      for (let j = 0; j < destinations.length; j++) {
        elements.push({ status: "NOT_FOUND" });
      }
      rows.push({ elements });
      continue;
    }

    // Check leg cache; compute misses with a single Dijkstra.
    const cached = await loadLegCacheBatch(env, oNode, uniqueDestNodes);
    const missing = uniqueDestNodes.filter(d => !cached.has(d));
    let computed: Map<number, { timeS: number; lenM: number }> = new Map();
    if (missing.length > 0) {
      computed = oneToMany(og.graph, oNode, missing);
      await writeLegCacheBatch(env, oNode, computed);
    }

    for (let j = 0; j < destinations.length; j++) {
      const dNode = dg.nodes[j];
      if (dNode === null || dg.results[j].status !== "OK") {
        elements.push({ status: "NOT_FOUND" });
        continue;
      }
      const leg = cached.get(dNode) ?? computed.get(dNode);
      if (!leg) {
        elements.push({ status: "ZERO_RESULTS" });
        continue;
      }
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
