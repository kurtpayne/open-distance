// Shared parsing for Distance Matrix origins/destinations + element counting.
//
// Kept in its own dependency-free module so BOTH the request handler
// (distancematrix.ts) and the rate limiter (index.ts) use the exact same
// pipe-split semantics: there's one definition of "how many elements does this
// request charge", so the budget charged up front matches what gets served.

// Split a pipe-delimited origins/destinations value the way the Distance Matrix
// handler does: trim each segment and drop empties (so "A||B", trailing pipes,
// and all-whitespace inputs behave consistently).
export function splitMulti(v: string | null): string[] {
  if (!v) return [];
  return v.split("|").map(s => s.trim()).filter(Boolean);
}

// Count the elements (origins × destinations) a Distance Matrix request would
// charge. The rate limiter calls this up front (before charging the per-IP daily
// + global element budgets) so the charge matches what handleDistanceMatrix will
// serve. Returns 0 when either side is missing/malformed -- the caller then
// skips the element charge (still applies the per-second burst) and lets
// handleDistanceMatrix return INVALID_REQUEST. Note: this counts raw inputs and
// does NOT apply the MAX_ELEMENTS cap; the caller rejects oversize requests
// before charging.
export function countElements(url: URL): number {
  const origins = splitMulti(url.searchParams.get("origins"));
  const destinations = splitMulti(url.searchParams.get("destinations"));
  return origins.length * destinations.length;
}
