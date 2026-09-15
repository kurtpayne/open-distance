// Address-string normalizer. Same tokens that the ingest pipeline applies,
// so FTS5 queries line up with stored row tokens. Pure function with no
// dependencies -- unit-testable in isolation.

/** Street suffix -> USPS abbreviation. Single source of truth; re-used by ./interpolate. */
export const SUFFIX_ABBR: Record<string, string> = {
  street: "st", avenue: "ave", boulevard: "blvd", road: "rd", drive: "dr",
  lane: "ln", court: "ct", place: "pl", terrace: "ter", trail: "trl",
  parkway: "pkwy", highway: "hwy", circle: "cir", square: "sq", way: "way",
  alley: "aly", plaza: "plz",
  str: "st", ave: "ave", blvd: "blvd", rd: "rd", dr: "dr", ln: "ln", ct: "ct",
  pl: "pl", ter: "ter", trl: "trl", pkwy: "pkwy", hwy: "hwy", cir: "cir",
  sq: "sq", aly: "aly", plz: "plz",
};

/** Cardinal direction -> USPS abbreviation; re-used by ./interpolate. */
export const DIR_ABBR: Record<string, string> = {
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};

export function normalizeQuery(q: string): string {
  // Lowercase, strip non-alphanumeric (incl. commas), collapse whitespace,
  // then per-token abbreviate street suffixes and directionals so stored
  // FTS5 tokens match.
  const cleaned = q
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map(t => SUFFIX_ABBR[t] ?? DIR_ABBR[t] ?? t)
    .filter(Boolean)
    .join(" ");
}


// A geocodable address query must carry a house number: the first token (or
// the one right after a leading unit like "apt 3"/"ste 100" is not needed --
// the house number leads in every source we index). Without it a query such
// as "austin tx" or "78701" would MATCH any row containing those tokens
// (e.g. "11001 austin ln, austin, tx 78758") and return a confidently wrong
// point. City-, ZIP- or street-only inputs are centroid-tier and the contract
// says those return NOT_FOUND.
const HOUSE_NUMBER_RE = /^\d+[a-z]?(?:-\d+[a-z]?)?$/;
export function hasHouseNumber(normalized: string): boolean {
  const first = normalized.split(" ")[0] ?? "";
  if (!HOUSE_NUMBER_RE.test(first)) return false;
  // A lone 5-digit token is a ZIP, not a house number ("78701", "78701 tx").
  const rest = normalized.slice(first.length).trim();
  if (/^\d{5}$/.test(first) && rest.split(" ").every(t => !t || t.length <= 2 || /^\d+$/.test(t))) return false;
  return rest.length > 0;
}
