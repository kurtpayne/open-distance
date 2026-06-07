// Parse a US state from an address query.
// Order of attempts:
//   1) " <STATE>" or ", <STATE>" two-letter code at the end (most common).
//   2) Full state name word.
//   3) ZIP code -> state lookup by 3-digit prefix.
// Returns the 2-letter USPS code or null.

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", washington_dc: "DC",
  florida: "FL", georgia: "GA", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN",
  texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

/** Canonical 49-entry list of supported state codes (lower 48 + DC). The
 *  single source of truth for any caller that needs to iterate states.
 *  Deduped because STATE_NAMES has multiple aliases for DC. */
export const STATE_CODES: string[] = [...new Set(Object.values(STATE_NAMES))].sort();
const VALID_CODES = new Set(STATE_CODES);

// ZIP-3 -> state. Compact embedded table.
// Source: USPS sectional center facility ranges (public, well-known).
const ZIP3: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  const add = (lo: number, hi: number, st: string) => {
    for (let i = lo; i <= hi; i++) m[String(i).padStart(3, "0")] = st;
  };
  add(10, 27, "MA"); add(28, 29, "RI"); add(30, 33, "NH"); add(34, 34, "ME");
  add(35, 38, "NH"); add(39, 49, "ME"); add(50, 52, "VT"); add(53, 53, "VT");
  add(54, 59, "VT"); add(60, 69, "CT"); add(70, 89, "NJ");
  add(100, 149, "NY"); add(150, 196, "PA"); add(197, 199, "DE");
  add(200, 205, "DC"); add(206, 219, "MD"); add(220, 246, "VA");
  add(247, 268, "WV"); add(270, 289, "NC"); add(290, 299, "SC");
  add(300, 319, "GA"); add(320, 349, "FL"); add(350, 369, "AL");
  add(370, 385, "TN"); add(386, 397, "MS"); add(398, 399, "GA");
  add(400, 427, "KY"); add(430, 459, "OH"); add(460, 479, "IN");
  add(480, 499, "MI"); add(500, 528, "IA"); add(530, 549, "WI");
  add(550, 567, "MN"); add(570, 577, "SD"); add(580, 588, "ND");
  add(590, 599, "MT"); add(600, 629, "IL"); add(630, 658, "MO");
  add(660, 679, "KS"); add(680, 693, "NE"); add(700, 714, "LA");
  add(716, 729, "AR"); add(730, 749, "OK"); add(750, 799, "TX");
  add(800, 816, "CO"); add(820, 831, "WY"); add(832, 838, "ID");
  add(840, 847, "UT"); add(850, 865, "AZ"); add(870, 884, "NM");
  add(889, 898, "NV"); add(900, 961, "CA");
  add(970, 979, "OR"); add(980, 994, "WA");
  return m;
})();

const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;

export function parseState(query: string): string | null {
  const q = query.trim();
  if (!q) return null;

  // 1) Trailing 2-letter state code.
  // Look for state code that appears before a ZIP or at end. Walk from right.
  const upper = q.toUpperCase();
  const matches = [...upper.matchAll(/(?:^|[\s,])([A-Z]{2})(?=[\s,]|\d|$)/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const code = matches[i][1];
    if (VALID_CODES.has(code)) return code;
  }

  // 2) Full state name word (case-insensitive).
  const lower = q.toLowerCase();
  for (const name of Object.keys(STATE_NAMES)) {
    if (lower.includes(name)) return STATE_NAMES[name];
  }

  // 3) ZIP prefix.
  const zm = q.match(ZIP_RE);
  if (zm) {
    const prefix = zm[1].slice(0, 3);
    const st = ZIP3[prefix];
    if (st) return st;
  }

  return null;
}
