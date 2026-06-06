// Worker-side TIGER address interpolation fallback.
//
// Used when the addresses table misses. Parses "<num> <street>, <city>, <st> [zip]"
// from the query, looks up a matching segment by (street_normalized, hn range),
// and interpolates lat/lon along the segment.

import { GeocodeHit } from "./geocode";


const SUFFIX_ABBR: Record<string, string> = {
  street: "st", avenue: "ave", boulevard: "blvd", road: "rd", drive: "dr",
  lane: "ln", court: "ct", place: "pl", terrace: "ter", trail: "trl",
  parkway: "pkwy", highway: "hwy", circle: "cir", square: "sq", way: "way",
  alley: "aly", plaza: "plz",
  str: "st", ave: "ave", blvd: "blvd", rd: "rd", dr: "dr", ln: "ln", ct: "ct",
  pl: "pl", ter: "ter", trl: "trl", pkwy: "pkwy", hwy: "hwy", cir: "cir",
  sq: "sq", aly: "aly", plz: "plz",
};
const DIR_ABBR: Record<string, string> = {
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};

function abbrToken(t: string): string {
  const u = t.toLowerCase().replace(/[.,]/g, "");
  if (!u) return "";
  return SUFFIX_ABBR[u] ?? DIR_ABBR[u] ?? u;
}

function normalizeStreet(s: string): string {
  return s.split(/\s+/).map(abbrToken).filter(Boolean).join(" ");
}

export interface ParsedAddress {
  number: number;
  street: string;       // normalized
  zip: string | null;
  raw_street: string;
}

const PARSE_RE = /^\s*(\d+)\b\s+([^,]+?)(?:,|\s+\d{5}|$)/;
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;

export function parseHouseAndStreet(query: string): ParsedAddress | null {
  const m = query.match(PARSE_RE);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (!Number.isFinite(num) || num <= 0) return null;
  const rawStreet = m[2].trim();
  if (!rawStreet) return null;
  const street = normalizeStreet(rawStreet);
  if (!street) return null;
  const zm = query.match(ZIP_RE);
  return {
    number: num,
    street,
    raw_street: rawStreet,
    zip: zm ? zm[1] : null,
  };
}

interface SegRow {
  street_normalized: string;
  zip: string | null;
  from_hn: number;
  to_hn: number;
  side: string | null;
  from_lat: number;
  from_lon: number;
  to_lat: number;
  to_lon: number;
}

export async function interpolateFromSegments(
  db: D1Database,
  query: string,
): Promise<GeocodeHit | null> {
  const parsed = parseHouseAndStreet(query);
  if (!parsed) return null;

  // Find candidate segments: street name match + house number in range.
  // Prefer zip match if available.
  let row: SegRow | null = null;
  try {
    if (parsed.zip) {
      row = await db
        .prepare(
          "SELECT street_normalized, zip, from_hn, to_hn, side, " +
          "from_lat, from_lon, to_lat, to_lon FROM segments " +
          "WHERE street_normalized = ? AND zip = ? " +
          "AND ? BETWEEN from_hn AND to_hn LIMIT 1"
        )
        .bind(parsed.street, parsed.zip, parsed.number)
        .first<SegRow>();
    }
    if (!row) {
      row = await db
        .prepare(
          "SELECT street_normalized, zip, from_hn, to_hn, side, " +
          "from_lat, from_lon, to_lat, to_lon FROM segments " +
          "WHERE street_normalized = ? AND ? BETWEEN from_hn AND to_hn LIMIT 1"
        )
        .bind(parsed.street, parsed.number)
        .first<SegRow>();
    }
  } catch {
    return null;
  }
  if (!row) return null;

  const span = row.to_hn - row.from_hn;
  const t = span > 0 ? (parsed.number - row.from_hn) / span : 0.5;
  const lat = row.from_lat + t * (row.to_lat - row.from_lat);
  const lon = row.from_lon + t * (row.to_lon - row.from_lon);

  return {
    status: "OK",
    lat, lon,
    normalized: `${parsed.number} ${parsed.street}` + (row.zip ? `, ${row.zip}` : ""),
    state: "",
    match: "interpolated",
  };
}
