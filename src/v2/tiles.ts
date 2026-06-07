// Tile loader + LRU cache for the tiled L0 routing graph.
// Format mirrors etl/v2/_tile_io.py exactly.

export interface Tile {
  tx: number;
  ty: number;
  nLocal: number;
  nExtern: number;
  mEdges: number;
  gridNLon: number;
  gridNLat: number;
  localLat: Float32Array;
  localLon: Float32Array;
  externPacked: Uint32Array;
  externDense: Uint32Array;
  edgeOffsets: Uint32Array;
  edgeTargets: Uint32Array;
  edgeTimeS: Float32Array;
  edgeLenM: Float32Array;
  gridOffsets: Uint32Array;
  gridNodeIds: Uint32Array;
  bytes: number;  // approximate decoded size for LRU accounting
}

const MAGIC = 0x30544848; // "HHT0" little-endian as u32

export function packTileId(tx: number, ty: number): number {
  // Match etl/v2/_tile_io.py: tx in high 16 bits, ty in low 16 bits, both as int16.
  return (((tx & 0xffff) << 16) | (ty & 0xffff)) >>> 0;
}

export function unpackTileId(packed: number): { tx: number; ty: number } {
  let tx = (packed >>> 16) & 0xffff;
  let ty = packed & 0xffff;
  if (tx >= 0x8000) tx -= 0x10000;
  if (ty >= 0x8000) ty -= 0x10000;
  return { tx, ty };
}

function decode(buf: ArrayBuffer): Tile {
  const dv = new DataView(buf);
  let p = 0;
  const magic = dv.getUint32(p, true); p += 4;
  if (magic !== MAGIC) throw new Error(`bad tile magic 0x${magic.toString(16)}`);
  /* fmt_ver */ p += 4;
  const tx = dv.getInt32(p, true); p += 4;
  const ty = dv.getInt32(p, true); p += 4;
  const nLocal = dv.getUint32(p, true); p += 4;
  const nExtern = dv.getUint32(p, true); p += 4;
  const mEdges = dv.getUint32(p, true); p += 4;
  const gridNLon = dv.getUint16(p, true); p += 2;
  const gridNLat = dv.getUint16(p, true); p += 2;
  // Header padded to 32 bytes; assert
  if (p !== 32) throw new Error(`tile header size unexpected: ${p}`);

  const localLat = new Float32Array(buf, p, nLocal); p += nLocal * 4;
  const localLon = new Float32Array(buf, p, nLocal); p += nLocal * 4;
  const externPacked = new Uint32Array(buf, p, nExtern); p += nExtern * 4;
  const externDense = new Uint32Array(buf, p, nExtern); p += nExtern * 4;
  const edgeOffsets = new Uint32Array(buf, p, nLocal + 1); p += (nLocal + 1) * 4;
  const edgeTargets = new Uint32Array(buf, p, mEdges); p += mEdges * 4;
  const edgeTimeS = new Float32Array(buf, p, mEdges); p += mEdges * 4;
  const edgeLenM = new Float32Array(buf, p, mEdges); p += mEdges * 4;
  const gridCells = gridNLon * gridNLat;
  const gridOffsets = new Uint32Array(buf, p, gridCells + 1); p += (gridCells + 1) * 4;
  const gridNodeIds = new Uint32Array(buf, p, nLocal); p += nLocal * 4;

  return {
    tx, ty, nLocal, nExtern, mEdges, gridNLon, gridNLat,
    localLat, localLon, externPacked, externDense,
    edgeOffsets, edgeTargets, edgeTimeS, edgeLenM,
    gridOffsets, gridNodeIds,
    bytes: buf.byteLength,
  };
}

// ---------------------------------------------------------------------------
// Isolate-global LRU cache. Decoded tiles share isolate memory.
// ---------------------------------------------------------------------------

// Tile LRU budget. Workers isolate is 128 MB; this leaves headroom for L1
// overlay (~115 MB peaks under load) and request/heap.
const TILE_CACHE_BYTE_BUDGET = 48 * 1024 * 1024;

let cache: Map<number, Tile> = new Map();   // insertion-order LRU
let pending: Map<number, Promise<Tile>> = new Map();
let cacheBytes = 0;

function lruTouch(packed: number, tile: Tile): void {
  // Re-insert moves to most-recent position in JS Maps.
  cache.delete(packed);
  cache.set(packed, tile);
  cacheBytes += tile.bytes;
  while (cacheBytes > TILE_CACHE_BYTE_BUDGET && cache.size > 1) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    const t = cache.get(oldest);
    if (!t) break;
    cache.delete(oldest);
    cacheBytes -= t.bytes;
  }
}

function tileKey(version: string, tx: number, ty: number): string {
  return `tiles/${version}/${tx}_${ty}.bin`;
}

/**
 * Fetch a tile's raw bytes directly from R2, bypassing the decode + LRU
 * cache. Used by the WASM router which wants to copy the bytes into its
 * own linear memory and decode there.
 */
export async function getTileBytes(
  bucket: R2Bucket,
  version: string,
  tx: number,
  ty: number,
): Promise<Uint8Array | null> {
  const obj = await bucket.get(tileKey(version, tx, ty));
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

export async function getTile(
  bucket: R2Bucket,
  version: string,
  tx: number,
  ty: number,
): Promise<Tile | null> {
  const packed = packTileId(tx, ty);
  const hit = cache.get(packed);
  if (hit) {
    // touch
    cache.delete(packed);
    cache.set(packed, hit);
    return hit;
  }
  const inflight = pending.get(packed);
  if (inflight) return inflight;
  const p = (async () => {
    const obj = await bucket.get(tileKey(version, tx, ty));
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    const tile = decode(buf);
    lruTouch(packed, tile);
    pending.delete(packed);
    return tile;
  })().catch(e => {
    pending.delete(packed);
    throw e;
  });
  pending.set(packed, p as Promise<Tile>);
  return p;
}

export function cacheStats(): { tiles: number; bytes: number } {
  return { tiles: cache.size, bytes: cacheBytes };
}

// ---------------------------------------------------------------------------
// Snap: given a lat/lon, find the nearest local node within the containing tile
// (and optionally search neighbours if the tile has nothing nearby).
// ---------------------------------------------------------------------------

const CELL_DEG = 0.25;
const GRID_ORIGIN_LON = -180.0;
const GRID_ORIGIN_LAT = -90.0;

export function tileOf(lat: number, lon: number): { tx: number; ty: number } {
  return {
    tx: Math.floor((lon - GRID_ORIGIN_LON) / CELL_DEG),
    ty: Math.floor((lat - GRID_ORIGIN_LAT) / CELL_DEG),
  };
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Min separation between snap candidates, in meters. Forces candidates to
// land on different road segments so private-campus fragments don't dominate
// all top-K slots.
const SNAP_MIN_SEP_M = 200;

export function snapInTile(tile: Tile, lat: number, lon: number, k: number = 1): { dense: number; distM: number }[] {
  if (tile.nLocal === 0) return [];
  const tileLonMin = GRID_ORIGIN_LON + tile.tx * CELL_DEG;
  const tileLatMin = GRID_ORIGIN_LAT + tile.ty * CELL_DEG;
  const cell = CELL_DEG / tile.gridNLat;
  const cy0 = Math.max(0, Math.min(tile.gridNLat - 1, Math.floor((lat - tileLatMin) / cell)));
  const cx0 = Math.max(0, Math.min(tile.gridNLon - 1, Math.floor((lon - tileLonMin) / cell)));
  // Phase 1: gather many candidates from progressively wider rings.
  const all: { dense: number; distM: number }[] = [];
  const ringsToWiden = k > 1 ? 6 : 2;
  for (let r = 0; r <= 8; r++) {
    const yMin = Math.max(0, cy0 - r);
    const yMax = Math.min(tile.gridNLat - 1, cy0 + r);
    const xMin = Math.max(0, cx0 - r);
    const xMax = Math.min(tile.gridNLon - 1, cx0 + r);
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (r > 0 && y !== yMin && y !== yMax && x !== xMin && x !== xMax) continue;
        const c = y * tile.gridNLon + x;
        const s = tile.gridOffsets[c];
        const e = tile.gridOffsets[c + 1];
        for (let i = s; i < e; i++) {
          const n = tile.gridNodeIds[i];
          const d = haversineMeters(lat, lon, tile.localLat[n], tile.localLon[n]);
          all.push({ dense: n, distM: d });
        }
      }
    }
    if (all.length > 0 && r >= ringsToWiden && all[0].distM < 200) break;
  }
  all.sort((a, b) => a.distM - b.distM);
  // Phase 2: pick top-K with min separation, so candidates come from different
  // road segments (helps when the nearest cluster is on a disconnected fragment).
  const chosen: { dense: number; distM: number }[] = [];
  for (const cand of all) {
    let tooClose = false;
    for (const c of chosen) {
      const dx = tile.localLat[cand.dense] - tile.localLat[c.dense];
      const dy = tile.localLon[cand.dense] - tile.localLon[c.dense];
      // Rough meters: 1deg lat ~ 111km; lon scaled by cos(lat).
      const dm = Math.sqrt((dx * 111000) ** 2 + (dy * 111000 * Math.cos(lat * Math.PI / 180)) ** 2);
      if (dm < SNAP_MIN_SEP_M) { tooClose = true; break; }
    }
    if (tooClose) continue;
    chosen.push(cand);
    if (chosen.length >= k) break;
  }
  // Always keep the absolute closest as the first candidate even if we ended
  // up adding only spaced-out ones later.
  if (chosen.length === 0 && all.length > 0) return [all[0]];
  return chosen;
}

export interface SnapResult { tx: number; ty: number; dense: number; distM: number }

export async function snapK(
  bucket: R2Bucket,
  version: string,
  lat: number,
  lon: number,
  k: number = 5,
): Promise<SnapResult[]> {
  // Search home tile + neighbour ring up to radius 2 and keep top-K nearest.
  const home = tileOf(lat, lon);
  const found: SnapResult[] = [];
  for (let r = 0; r <= 2; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (r > 0 && Math.abs(dx) < r && Math.abs(dy) < r) continue;
        const tile = await getTile(bucket, version, home.tx + dx, home.ty + dy);
        if (!tile) continue;
        const matches = snapInTile(tile, lat, lon, k);
        for (const m of matches) {
          const r: SnapResult = { tx: tile.tx, ty: tile.ty, dense: m.dense, distM: m.distM };
          // Insert sorted.
          let pos = found.length;
          while (pos > 0 && found[pos - 1].distM > r.distM) pos--;
          found.splice(pos, 0, r);
          if (found.length > k) found.length = k;
        }
      }
    }
    if (found.length >= k && found[0].distM < 200) break; // good enough; stop widening
  }
  return found;
}

// Back-compat single-best wrapper.
export async function snap(
  bucket: R2Bucket,
  version: string,
  lat: number,
  lon: number,
): Promise<SnapResult | null> {
  const all = await snapK(bucket, version, lat, lon, 1);
  return all.length > 0 ? all[0] : null;
}
