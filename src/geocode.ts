export interface GeocodeHit {
  status: "OK";
  lat: number;
  lon: number;
  normalized: string;
  match: "coords" | "address";
}
export interface GeocodeMiss { status: "NOT_FOUND"; normalized: string }
export type GeocodeResult = GeocodeHit | GeocodeMiss;

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export function looksLikeCoords(q: string): boolean {
  return COORD_RE.test(q);
}

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
  // Wrap each token in double quotes so FTS treats them as literal phrases.
  return s
    .split(" ")
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, "")}"`)
    .join(" ");
}

export async function geocode(
  q: string,
  env: { GEOCODE: D1Database; CACHE: KVNamespace; DATA_VERSION: string },
): Promise<GeocodeResult> {
  const m = q.match(COORD_RE);
  if (m) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { status: "NOT_FOUND", normalized: q };
    }
    return { status: "OK", lat, lon, normalized: `${lat},${lon}`, match: "coords" };
  }

  const norm = normalizeQuery(q);
  if (!norm) return { status: "NOT_FOUND", normalized: q };

  const cacheKey = `geo:${env.DATA_VERSION}:${await sha1Hex(norm)}`;
  const hit = await env.CACHE.get(cacheKey, "json") as GeocodeResult | null;
  if (hit) return hit;

  let row: { lat: number; lon: number; normalized: string } | null = null;
  try {
    row = await env.GEOCODE
      .prepare(
        "SELECT a.lat AS lat, a.lon AS lon, a.normalized AS normalized FROM addr_fts " +
        "JOIN addresses a ON a.id = addr_fts.rowid " +
        "WHERE addr_fts MATCH ? ORDER BY rank LIMIT 1",
      )
      .bind(escapeFts(norm))
      .first<{ lat: number; lon: number; normalized: string }>();
  } catch {
    row = null;
  }

  const result: GeocodeResult = row
    ? { status: "OK", lat: row.lat, lon: row.lon, normalized: row.normalized, match: "address" }
    : { status: "NOT_FOUND", normalized: q };

  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 30 });
  return result;
}
