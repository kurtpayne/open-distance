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
