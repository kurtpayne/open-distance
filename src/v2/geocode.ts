// v2 sharded geocoder. One D1 database per state; dispatch by parsed state.
// Falls back to a parallel fan-out across all shards when the state can't be
// parsed -- rare in real US queries but kept for robustness.

import { parseState } from "./state_parser";

export interface GeocodeHit {
  status: "OK";
  lat: number;
  lon: number;
  normalized: string;
  state: string;
  match: "coords" | "rooftop" | "interpolated";
}
export interface GeocodeMiss { status: "NOT_FOUND"; normalized: string }
export type GeocodeResult = GeocodeHit | GeocodeMiss;

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9 ,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha1Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function escapeFts(s: string): string {
  return s.split(" ").filter(Boolean).map(t => `"${t.replace(/"/g, "")}"`).join(" ");
}

interface ShardEnv { [k: string]: unknown }

function shardFor(env: ShardEnv, state: string): D1Database | null {
  const db = env[`GEOCODE_${state}`];
  return db ? (db as D1Database) : null;
}

async function queryShard(db: D1Database, ftsQuery: string): Promise<
  { lat: number; lon: number; normalized: string; tier: string } | null
> {
  try {
    return await db
      .prepare(
        "SELECT a.lat AS lat, a.lon AS lon, a.normalized AS normalized, a.tier AS tier " +
        "FROM addr_fts JOIN addresses a ON a.id = addr_fts.rowid " +
        "WHERE addr_fts MATCH ? ORDER BY rank LIMIT 1",
      )
      .bind(ftsQuery)
      .first<{ lat: number; lon: number; normalized: string; tier: string }>();
  } catch {
    return null;
  }
}

export async function geocode(
  q: string,
  env: { CACHE: KVNamespace; DATA_VERSION: string } & ShardEnv,
): Promise<GeocodeResult> {
  const cm = q.match(COORD_RE);
  if (cm) {
    const lat = parseFloat(cm[1]);
    const lon = parseFloat(cm[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { status: "NOT_FOUND", normalized: q };
    }
    return {
      status: "OK", lat, lon,
      normalized: `${lat},${lon}`,
      state: "",
      match: "coords",
    };
  }

  const norm = normalizeQuery(q);
  if (!norm) return { status: "NOT_FOUND", normalized: q };

  const cacheKey = `geo:${env.DATA_VERSION}:${await sha1Hex(norm)}`;
  const hit = await env.CACHE.get(cacheKey, "json") as GeocodeResult | null;
  if (hit) return hit;

  const ftsQuery = escapeFts(norm);
  const state = parseState(q);

  let row: { lat: number; lon: number; normalized: string; tier: string } | null = null;
  if (state) {
    const db = shardFor(env, state);
    if (db) row = await queryShard(db, ftsQuery);
  } else {
    // Fan-out: query every available shard in parallel, pick first OK with
    // highest tier (rooftop > interpolated). This is rare in practice.
    const states = ["AL","AZ","AR","CA","CO","CT","DE","DC","FL","GA","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
    const results = await Promise.all(states.map(s => {
      const db = shardFor(env, s);
      return db ? queryShard(db, ftsQuery) : Promise.resolve(null);
    }));
    // Prefer rooftop; otherwise any non-null.
    row = results.find(r => r && r.tier === "rooftop")
      ?? results.find(r => r !== null)
      ?? null;
  }

  // Confidence threshold: only return rooftop or interpolated.
  if (!row || (row.tier !== "rooftop" && row.tier !== "interpolated")) {
    const miss: GeocodeMiss = { status: "NOT_FOUND", normalized: q };
    await env.CACHE.put(cacheKey, JSON.stringify(miss), { expirationTtl: 60 * 60 * 24 * 30 });
    return miss;
  }

  const result: GeocodeHit = {
    status: "OK",
    lat: row.lat, lon: row.lon,
    normalized: row.normalized,
    state: state ?? "",
    match: row.tier === "rooftop" ? "rooftop" : "interpolated",
  };
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 30 });
  return result;
}
