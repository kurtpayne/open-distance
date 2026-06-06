// Address-string normalizer. Same tokens that the ingest pipeline applies,
// so FTS5 queries line up with stored row tokens. Pure function with no
// dependencies -- unit-testable in isolation.

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
