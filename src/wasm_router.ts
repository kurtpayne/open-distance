// TypeScript adapter for the Rust-compiled WASM router (rust-router/).
//
// FFI contract (must stay in lockstep with rust-router/src/lib.rs):
//   - od_alloc(size)            -> ptr
//   - od_free(ptr, size)
//   - od_dijkstra_one_to_many(args_ptr, args_len, result_ptr, result_len) -> settled_count
//
// Instantiation: the Worker binds the .wasm as a `WebAssembly.Module` via
// wrangler's [[rules]] CompiledWasm block. We instantiate once per isolate
// (lazy on first call) and reuse the instance across requests.

interface WasmExports {
  memory: WebAssembly.Memory;
  od_alloc: (size: number) => number;
  od_free: (ptr: number, size: number) => void;
  od_dijkstra_one_to_many: (argsPtr: number, argsLen: number, resultPtr: number, resultLen: number) => number;
}

let instance: WasmExports | null = null;

export function isLoaded(): boolean { return instance !== null; }

export async function loadWasmRouter(mod: WebAssembly.Module): Promise<void> {
  if (instance) return;
  const wasm = await WebAssembly.instantiate(mod, {});
  instance = wasm.exports as unknown as WasmExports;
}

interface MultiTileInput {
  tileId: number;        // packed u32: (tx << 16) | ty
  bytes: Uint8Array;
}

interface OneToManyResult {
  timeS: number;
  lenM: number;
  ok: boolean;
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

  // Allocations may grow WASM linear memory, which detaches any JS-side
  // ArrayBuffer reference. Always re-acquire instance.memory.buffer AFTER
  // both od_alloc calls.
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
