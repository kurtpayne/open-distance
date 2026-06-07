// TypeScript adapter for the Rust-compiled WASM router (rust-router/).
//
// FFI contract (must stay in lockstep with rust-router/src/lib.rs):
//   - od_alloc(size)            -> ptr
//   - od_free(ptr, size)
//   - od_astar_intra_tile(args_ptr, args_len, result_ptr) -> 1 on success
// args layout (LE):
//   u32 src, u32 dst, u32 settled_cap, u32 tile_len, [tile bytes...]
// result layout (LE, 12 bytes):
//   f32 time_s (NaN on failure), f32 len_m, u32 settled_count
//
// Instantiation: the Worker binds the .wasm as a `WebAssembly.Module` via
// wrangler's [wasm_modules] block (see wrangler.toml). We instantiate once
// per isolate (lazy on first call) and reuse the instance across requests.

interface WasmExports {
  memory: WebAssembly.Memory;
  od_alloc: (size: number) => number;
  od_free: (ptr: number, size: number) => void;
  od_astar_intra_tile: (argsPtr: number, argsLen: number, resultPtr: number) => number;
  od_astar_multi_tile: (argsPtr: number, argsLen: number, resultPtr: number) => number;
  od_dijkstra_one_to_many: (argsPtr: number, argsLen: number, resultPtr: number, resultLen: number) => number;
  od_l1_route: (argsPtr: number, argsLen: number, resultPtr: number) => number;
}

let instance: WasmExports | null = null;

export function isLoaded(): boolean { return instance !== null; }

export async function loadWasmRouter(mod: WebAssembly.Module): Promise<void> {
  if (instance) return;
  const wasm = await WebAssembly.instantiate(mod, {});
  instance = wasm.exports as unknown as WasmExports;
}

export interface IntraTileResult {
  timeS: number;
  lenM: number;
  settledCount: number;
  ok: boolean;
}

export interface MultiTileInput {
  tileId: number;        // packed u32: (tx << 16) | ty
  bytes: Uint8Array;
}

/**
 * Run weighted A* across a set of loaded tiles. The caller hands us a
 * packaged list of (tile_id, bytes); we lay them out for the WASM ABI as a
 * single arg buffer and invoke the cross-tile router. Returns NaN if the
 * destination tile isn't included, the src/dst dense ids are out of range,
 * or A* hits its settled cap before reaching the destination.
 */
export interface OneToManyResult {
  timeS: number;
  lenM: number;
  ok: boolean;
}

export interface L1RouteResult {
  ok: boolean;
  timeS: number;
  lenM: number;
  settledCount: number;
  srcNode: number;
  dstNode: number;
  srcSnapDistM: number;
  dstSnapDistM: number;
}

/**
 * Multi-tile Dijkstra ONE-TO-MANY. Single source, many destinations -- the
 * actual hot path for Distance Matrix queries. Returns one result per
 * destination, NaN if not reached within settled_cap. A single Dijkstra
 * traversal services every destination, much cheaper than running N separate
 * A* runs.
 */
export function dijkstraOneToMany(
  tiles: MultiTileInput[],
  srcTileId: number,
  srcDense: number,
  dsts: { tileId: number; dense: number }[],
  settledCap = 500_000,
): { settled: number; results: OneToManyResult[] } {
  if (!instance) throw new Error("WASM router not loaded");

  const headerLen = 20;
  const dstsLen = dsts.length * 8;
  const manifestLen = tiles.length * 12;
  let bytesLen = 0;
  for (const t of tiles) bytesLen += t.bytes.byteLength;
  const argsLen = headerLen + dstsLen + manifestLen + bytesLen;
  const resultLen = dsts.length * 8;

  const argsPtr = instance.od_alloc(argsLen);
  const resultPtr = instance.od_alloc(resultLen);
  try {
    const dv = new DataView(instance.memory.buffer, argsPtr, headerLen + dstsLen + manifestLen);
    dv.setUint32(0, srcTileId, true);
    dv.setUint32(4, srcDense, true);
    dv.setUint32(8, settledCap, true);
    dv.setUint32(12, dsts.length, true);
    dv.setUint32(16, tiles.length, true);
    for (let i = 0; i < dsts.length; i++) {
      const off = headerLen + i * 8;
      dv.setUint32(off, dsts[i].tileId, true);
      dv.setUint32(off + 4, dsts[i].dense, true);
    }
    const mem = new Uint8Array(instance.memory.buffer);
    let bytesCursor = headerLen + dstsLen + manifestLen;
    for (let i = 0; i < tiles.length; i++) {
      const off = headerLen + dstsLen + i * 12;
      dv.setUint32(off, tiles[i].tileId, true);
      dv.setUint32(off + 4, bytesCursor, true);
      dv.setUint32(off + 8, tiles[i].bytes.byteLength, true);
      mem.set(tiles[i].bytes, argsPtr + bytesCursor);
      bytesCursor += tiles[i].bytes.byteLength;
    }
    const settled = instance.od_dijkstra_one_to_many(argsPtr, argsLen, resultPtr, resultLen);
    const out = new DataView(instance.memory.buffer, resultPtr, resultLen);
    const results: OneToManyResult[] = [];
    for (let i = 0; i < dsts.length; i++) {
      const o = i * 8;
      const timeS = out.getFloat32(o, true);
      const lenM = out.getFloat32(o + 4, true);
      results.push({ timeS, lenM, ok: Number.isFinite(timeS) });
    }
    return { settled, results };
  } finally {
    instance.od_free(argsPtr, argsLen);
    instance.od_free(resultPtr, resultLen);
  }
}

/**
 * L1 overlay route: pass the raw L1 binary + endpoint lat/lon. Rust snaps
 * each to a node + runs forward A* internally. Returns snap distances so the
 * caller can decide whether the snap was acceptable.
 */
export function l1Route(
  l1Bytes: Uint8Array,
  srcLat: number, srcLon: number,
  dstLat: number, dstLon: number,
  settledCap = 1_000_000,
): L1RouteResult {
  if (!instance) throw new Error("WASM router not loaded");
  const argsLen = 24 + l1Bytes.byteLength;
  const argsPtr = instance.od_alloc(argsLen);
  const resultPtr = instance.od_alloc(28);
  try {
    const mem = new Uint8Array(instance.memory.buffer);
    const dv = new DataView(instance.memory.buffer, argsPtr, 24);
    dv.setFloat32(0, srcLat, true);
    dv.setFloat32(4, srcLon, true);
    dv.setFloat32(8, dstLat, true);
    dv.setFloat32(12, dstLon, true);
    dv.setUint32(16, settledCap, true);
    dv.setUint32(20, l1Bytes.byteLength, true);
    mem.set(l1Bytes, argsPtr + 24);
    const rc = instance.od_l1_route(argsPtr, argsLen, resultPtr);
    const out = new DataView(instance.memory.buffer, resultPtr, 28);
    return {
      ok: rc === 1 && Number.isFinite(out.getFloat32(0, true)),
      timeS: out.getFloat32(0, true),
      lenM: out.getFloat32(4, true),
      settledCount: out.getUint32(8, true),
      srcNode: out.getUint32(12, true),
      dstNode: out.getUint32(16, true),
      srcSnapDistM: out.getFloat32(20, true),
      dstSnapDistM: out.getFloat32(24, true),
    };
  } finally {
    instance.od_free(argsPtr, argsLen);
    instance.od_free(resultPtr, 28);
  }
}

export function astarMultiTile(
  tiles: MultiTileInput[],
  srcTileId: number,
  srcDense: number,
  dstTileId: number,
  dstDense: number,
  settledCap = 500_000,
): IntraTileResult {
  if (!instance) throw new Error("WASM router not loaded");

  // Layout: 24-byte header + manifest (n_tiles * 12 bytes) + concatenated tile bytes.
  const headerLen = 24;
  const manifestLen = tiles.length * 12;
  let bytesLen = 0;
  for (const t of tiles) bytesLen += t.bytes.byteLength;
  const argsLen = headerLen + manifestLen + bytesLen;

  const argsPtr = instance.od_alloc(argsLen);
  const resultPtr = instance.od_alloc(12);
  try {
    const dv = new DataView(instance.memory.buffer, argsPtr, headerLen + manifestLen);
    dv.setUint32(0, srcTileId, true);
    dv.setUint32(4, srcDense, true);
    dv.setUint32(8, dstTileId, true);
    dv.setUint32(12, dstDense, true);
    dv.setUint32(16, settledCap, true);
    dv.setUint32(20, tiles.length, true);
    const mem = new Uint8Array(instance.memory.buffer);
    let bytesCursor = headerLen + manifestLen;  // offset within args buffer
    for (let i = 0; i < tiles.length; i++) {
      const off = headerLen + i * 12;
      dv.setUint32(off, tiles[i].tileId, true);
      dv.setUint32(off + 4, bytesCursor, true);
      dv.setUint32(off + 8, tiles[i].bytes.byteLength, true);
      mem.set(tiles[i].bytes, argsPtr + bytesCursor);
      bytesCursor += tiles[i].bytes.byteLength;
    }
    const rc = instance.od_astar_multi_tile(argsPtr, argsLen, resultPtr);
    const out = new DataView(instance.memory.buffer, resultPtr, 12);
    const timeS = out.getFloat32(0, true);
    const lenM = out.getFloat32(4, true);
    const settledCount = out.getUint32(8, true);
    return { timeS, lenM, settledCount, ok: rc === 1 && Number.isFinite(timeS) };
  } finally {
    instance.od_free(argsPtr, argsLen);
    instance.od_free(resultPtr, 12);
  }
}

/**
 * Run weighted A* within a single tile. Returns NaN time/len if no path
 * within the tile (cross-tile edges are not followed by the intra-tile core).
 *
 * The caller passes the raw tile bytes; we copy into WASM linear memory,
 * call the entry point, read the 12-byte result, and free everything.
 */
export function astarIntraTile(
  tileBytes: Uint8Array,
  srcDense: number,
  dstDense: number,
  settledCap = 200_000,
): IntraTileResult {
  if (!instance) throw new Error("WASM router not loaded");
  const argsLen = 16 + tileBytes.byteLength;
  const argsPtr = instance.od_alloc(argsLen);
  const resultPtr = instance.od_alloc(12);
  try {
    const mem = new Uint8Array(instance.memory.buffer);
    const dv = new DataView(instance.memory.buffer, argsPtr, 16);
    dv.setUint32(0, srcDense, true);
    dv.setUint32(4, dstDense, true);
    dv.setUint32(8, settledCap, true);
    dv.setUint32(12, tileBytes.byteLength, true);
    mem.set(tileBytes, argsPtr + 16);
    const rc = instance.od_astar_intra_tile(argsPtr, argsLen, resultPtr);
    const out = new DataView(instance.memory.buffer, resultPtr, 12);
    const timeS = out.getFloat32(0, true);
    const lenM = out.getFloat32(4, true);
    const settledCount = out.getUint32(8, true);
    return { timeS, lenM, settledCount, ok: rc === 1 && Number.isFinite(timeS) };
  } finally {
    instance.od_free(argsPtr, argsLen);
    instance.od_free(resultPtr, 12);
  }
}
