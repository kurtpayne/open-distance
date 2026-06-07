# Design: raw-bytes tile cache for the WASM router

**Status**: proposed, not yet implemented
**Owner**: TBD
**Touches**: `src/v2/tiles.ts`, `src/v2/distancematrix.ts`

## Problem

The Rust → WASM router (added in Phase 4) executes A* in sub-millisecond time,
but its end-to-end latency on the hosted deployment is currently *worse* than
the TypeScript router because of how it fetches tiles:

- TS `oneToMany` lazy-loads tiles as A* expansion reaches them, **and** every
  loaded tile lives in the existing decoded-tile LRU (`cache: Map<number, Tile>`
  in `tiles.ts`). Subsequent requests touching the same tile hit warm cache.
- WASM `tryWasmSinglePair` (in `distancematrix.ts`) computes a tile corridor
  upfront (bbox + 1-tile buffer, capped at 16 tiles) and fetches **all of them**
  via `getTileBytes()`, which deliberately bypasses the decoded LRU.

The WASM path needs raw bytes (it copies them into WASM linear memory and
decodes there with `TileView::decode`), but the TS LRU only holds decoded
`Tile` objects (typed-array views + a few scalars). There is no shared cache
between the two routers, so every WASM request re-fetches its full corridor
from R2 even when those exact tile bytes were already pulled minutes ago.

Result from the benchmark: WASM A* `run_ms = 0`, but `fetch_ms = 288–644 ms`
because every request is a cold corridor fetch. TS A* takes 100–500 ms on its
inner loop but typically pays 0–100 ms of fetch on a warm isolate.

## Goals

1. Add a second LRU that holds raw bytes (`Uint8Array`) alongside the existing
   decoded-tile LRU.
2. Both routers (TS and WASM) populate and hit the bytes LRU.
3. WASM router latency drops to match TS on warm requests; the sub-millisecond
   A* win shows up end-to-end.
4. Total memory budget for tile caches stays under the same ~48 MB the
   decoded-tile LRU uses today (so the isolate budget doesn't regress).

## Non-goals

- Sharing the bytes cache across Worker instances (KV would help, but
  R2 itself is fast enough that an inter-isolate cache isn't worth the
  complexity).
- Persistence — caches are isolate-scoped, lost when the isolate recycles.

## Proposed shape

### `src/v2/tiles.ts`

Add a second LRU keyed by the same `packTileId(tx, ty)`:

```ts
const BYTES_CACHE_BYTE_BUDGET = 32 * 1024 * 1024;  // 32 MB
let bytesCache: Map<number, Uint8Array> = new Map();
let bytesCacheBytes = 0;

function bytesLruTouch(packed: number, bytes: Uint8Array): void {
  bytesCache.delete(packed);
  bytesCache.set(packed, bytes);
  bytesCacheBytes += bytes.byteLength;
  while (bytesCacheBytes > BYTES_CACHE_BYTE_BUDGET && bytesCache.size > 1) {
    const oldest = bytesCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    const b = bytesCache.get(oldest);
    if (!b) break;
    bytesCache.delete(oldest);
    bytesCacheBytes -= b.byteLength;
  }
}
```

Both fetchers route through it:

```ts
export async function getTileBytes(
  bucket: R2Bucket, version: string, tx: number, ty: number,
): Promise<Uint8Array | null> {
  const packed = packTileId(tx, ty);
  const hit = bytesCache.get(packed);
  if (hit) {
    bytesCache.delete(packed); bytesCache.set(packed, hit);  // touch
    return hit;
  }
  const obj = await bucket.get(tileKey(version, tx, ty));
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  bytesLruTouch(packed, bytes);
  return bytes;
}
```

Inside the existing `getTile()` (the decoded fetcher), populate the bytes LRU
on first decode so the TS path warms the WASM cache too:

```ts
const buf = await obj.arrayBuffer();
const bytes = new Uint8Array(buf);
bytesLruTouch(packed, bytes);  // <-- new
const tile = decode(buf);
lruTouch(packed, tile);
```

### Memory budgeting

Today's decoded-tile LRU is 48 MB. The proposed bytes LRU is 32 MB. Worst case
total tile cache footprint: 80 MB.

Per-tile size: 700 KB avg. 32 MB / 700 KB = ~45 tiles cached as bytes; 48 MB
/ 700 KB = ~68 tiles cached as decoded. A typical isolate touches 10–30 tiles
per minute on the current traffic pattern, so the bytes LRU should mostly hit
on the WASM path.

When the L1 overlay is loaded (~110 MB), the isolate is already over budget
regardless. The bytes LRU and the L1 binary should not both be cached at peak;
either we accept that L1 evicts the bytes LRU as JS GCs, or we add a flag
that shrinks the bytes LRU to 0 when L1 is in memory. Recommend deferring
that interaction until L1 in Rust ships (it owns its own memory).

### Eviction policy

LRU by insertion-order (same as the existing decoded-tile LRU). No need for
a separate priority queue — `Map`'s insertion order doubles as recency since
`delete + set` re-inserts at the tail.

### Concurrency / in-flight dedup

The existing `pending: Map<number, Promise<Tile>>` in `tiles.ts` dedups
concurrent decoded fetches. The bytes fetcher needs the same:

```ts
let bytesPending: Map<number, Promise<Uint8Array | null>> = new Map();
```

Implementation lifts the lookup-and-set pattern from `getTile()`.

## What changes in the WASM router path

Nothing in `distancematrix.ts` -- `tryWasmSinglePair` already calls
`getTileBytes` for each corridor tile. The change is transparent: those calls
start hitting cache for warm tiles instead of re-fetching from R2.

## Expected outcome

For routes the isolate has seen recently:
- WASM `fetch_ms`: 288–644 ms → < 20 ms (memcpy from JS heap into WASM linear memory)
- WASM end-to-end: 0.9–9.3 s → 0.1–0.5 s
- Beats TS on routes where WASM A* is faster than TS A* (i.e. most of them)

For cold isolates: no change vs today (still full corridor fetch on first hit).

## Open questions

1. **Bytes LRU budget**: 32 MB feels right but worth measuring after
   integration. If WASM router becomes the default and isolate budget gets
   tight, we may want to shrink decoded LRU instead (the bytes LRU is the
   more universally-useful cache once Rust handles all routing).
2. **Decode-once-store-twice**: if the bytes LRU is canonical, we could drop
   the decoded LRU entirely and have the TS path re-decode from bytes on
   each query. Saves memory but adds CPU. Probably not worth it until the
   Rust router is fully owning the routing path.
3. **Stream uploads**: today `getTileBytes` does a single `arrayBuffer()`
   read of the R2 object. For huge tiles this is fine (tiles are < 1 MB).
   No streaming needed.

## Out of scope

- L1 overlay caching (it has its own module-global `cached` in `overlay.ts`)
- Geocode / leg cache (already KV-backed)
- Cross-isolate cache via Cloudflare KV
