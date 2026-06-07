// Geographic helpers shared across the routing path (tile decoder, A*,
// L1 bidir, distance-matrix endpoint). The Rust router has its own copy
// in rust-router/src/lib.rs because crossing the WASM boundary for a
// 5-line hot helper isn't worth it; the formula must stay in lockstep.

const EARTH_RADIUS_M = 6_371_000;
const TO_RAD = Math.PI / 180;

/** Great-circle distance between two lat/lon points, in metres.
 *  Standard haversine, single-precision-safe inputs. */
export function haversineMeters(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const dLat = (lat2 - lat1) * TO_RAD;
  const dLon = (lon2 - lon1) * TO_RAD;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * TO_RAD) * Math.cos(lat2 * TO_RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
