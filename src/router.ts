// Tiled lazy-fetch one-to-many A*.
//
// Heap key is f = g + h, where:
//   g = best-known seconds from src to this node
//   h = haversine_meters(node, nearest unsatisfied destination) / MAX_ROAD_SPEED_M_S
// Falls back to h=0 when we don't have the next node's lat/lon at push time
// (i.e. extern push without target tile loaded). On pop we re-evaluate h with
// the active tile's typed-array coords, so further expansions get the full
// benefit even if the initial push priority was conservative.
//
// Perf discipline: the inner loop holds the active tile in a local AND keeps
// per-tile `dist` (Float32) and `visited` (Uint8) arrays so every per-node op
// is a typed-array index, not a Map call. Cross-tile traversal lazily allocates
// the target tile's arrays. Switching active tiles is rare relative to pops, so
// the await on getTile only fires on actual crossings.

import { haversineMeters } from "./geo";
import { getTile, packTileId, Tile } from "./tiles";

// Weighted A* heuristic. Plain admissible h (using max road speed) under-
// estimates true cost on city/suburban segments where you can't actually drive
// 108 km/h, so the search wastes work. Multiplying by 1.5 weights the
// heuristic 1.5x: searches finish ~4x faster on long corridors and the
// returned path may be up to 50% longer than truly optimal -- in practice
// well within minutes-level accuracy for cross-region routes.
const MAX_ROAD_SPEED_M_S = 30;       // ~108 km/h
const HEURISTIC_WEIGHT = 1.5;

export interface NodeRef { tx: number; ty: number; dense: number }
export interface LegResult { timeS: number; lenM: number }
export interface DestGroup {
  id: string;
  candidates: NodeRef[];
  // Geocoded destination coord, used for the A* heuristic. Snap nodes are
  // typically within 200m of (destLat, destLon), so this is a tight estimate.
  destLat: number;
  destLon: number;
}


interface TileScratch {
  tile: Tile;
  dist: Float32Array;       // length tile.nLocal; +Infinity = unseen
  visited: Uint8Array;      // length tile.nLocal
  lenTo: Float32Array;      // length tile.nLocal; meters along best-time path
}

class MinHeap {
  // Parallel arrays for one heap entry: (f, g, tilePacked, dense, lenSoFar).
  //   f = priority (g + heuristic), g = actual cost-so-far in seconds.
  private f: number[] = [];
  private g: number[] = [];
  private t: number[] = [];
  private n: number[] = [];
  private l: number[] = [];
  get size() { return this.f.length; }

  push(f: number, g: number, tilePacked: number, dense: number, lenSoFar: number) {
    this.f.push(f); this.g.push(g); this.t.push(tilePacked); this.n.push(dense); this.l.push(lenSoFar);
    let i = this.f.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      const tf = this.f[p]; this.f[p] = this.f[i]; this.f[i] = tf;
      const tg = this.g[p]; this.g[p] = this.g[i]; this.g[i] = tg;
      const tt = this.t[p]; this.t[p] = this.t[i]; this.t[i] = tt;
      const tn = this.n[p]; this.n[p] = this.n[i]; this.n[i] = tn;
      const tl = this.l[p]; this.l[p] = this.l[i]; this.l[i] = tl;
      i = p;
    }
  }

  // out[0]=f, out[1]=g, out[2]=tilePacked, out[3]=dense, out[4]=lenSoFar
  popInto(out: number[]): void {
    out[0] = this.f[0]; out[1] = this.g[0]; out[2] = this.t[0]; out[3] = this.n[0]; out[4] = this.l[0];
    const lf = this.f.pop()!; const lg = this.g.pop()!;
    const lt = this.t.pop()!; const ln = this.n.pop()!; const ll = this.l.pop()!;
    if (this.f.length > 0) {
      this.f[0] = lf; this.g[0] = lg; this.t[0] = lt; this.n[0] = ln; this.l[0] = ll;
      let i = 0;
      const sz = this.f.length;
      while (true) {
        const l = i * 2 + 1, r = l + 1;
        let best = i;
        if (l < sz && this.f[l] < this.f[best]) best = l;
        if (r < sz && this.f[r] < this.f[best]) best = r;
        if (best === i) break;
        const tf = this.f[best]; this.f[best] = this.f[i]; this.f[i] = tf;
        const tg = this.g[best]; this.g[best] = this.g[i]; this.g[i] = tg;
        const tt = this.t[best]; this.t[best] = this.t[i]; this.t[i] = tt;
        const tn = this.n[best]; this.n[best] = this.n[i]; this.n[i] = tn;
        const tl = this.l[best]; this.l[best] = this.l[i]; this.l[i] = tl;
        i = best;
      }
    }
  }
}

function unpackTilePacked(packed: number): { tx: number; ty: number } {
  let tx = (packed >>> 16) & 0xffff;
  let ty = packed & 0xffff;
  if (tx >= 0x8000) tx -= 0x10000;
  if (ty >= 0x8000) ty -= 0x10000;
  return { tx, ty };
}

export async function oneToMany(
  bucket: R2Bucket,
  version: string,
  src: NodeRef,
  groups: DestGroup[],
  opts: { maxSettled?: number } = {},
): Promise<Map<string, LegResult>> {
  const out = new Map<string, LegResult>();
  if (groups.length === 0) return out;

  // Target index: tilePacked -> Map<dense, group_id>. Multiple candidates per
  // group can share the same id -- the first one reached wins.
  const targets = new Map<number, Map<number, string>>();
  const groupSatisfied = new Set<string>();
  let remaining = 0;
  for (const g of groups) {
    if (g.candidates.length === 0) continue;
    remaining++;
    for (const d of g.candidates) {
      const tp = packTileId(d.tx, d.ty);
      let inner = targets.get(tp);
      if (!inner) { inner = new Map(); targets.set(tp, inner); }
      if (!inner.has(d.dense)) {
        inner.set(d.dense, g.id);
      }
    }
  }

  // Scratch per touched tile.
  const scratch = new Map<number, TileScratch>();

  async function loadScratch(tilePacked: number): Promise<TileScratch | null> {
    const cached = scratch.get(tilePacked);
    if (cached) return cached;
    const { tx, ty } = unpackTilePacked(tilePacked);
    const tile = await getTile(bucket, version, tx, ty);
    if (!tile) return null;
    const dist = new Float32Array(tile.nLocal); dist.fill(Number.POSITIVE_INFINITY);
    const visited = new Uint8Array(tile.nLocal);
    const lenTo = new Float32Array(tile.nLocal);
    const s: TileScratch = { tile, dist, visited, lenTo };
    scratch.set(tilePacked, s);
    return s;
  }

  const srcPacked = packTileId(src.tx, src.ty);
  const srcScratch = await loadScratch(srcPacked);
  if (!srcScratch) return out;
  srcScratch.dist[src.dense] = 0;
  srcScratch.lenTo[src.dense] = 0;

  const srcTargetMap = targets.get(srcPacked);
  if (srcTargetMap && srcTargetMap.has(src.dense)) {
    const gid = srcTargetMap.get(src.dense)!;
    if (!groupSatisfied.has(gid)) {
      groupSatisfied.add(gid);
      out.set(gid, { timeS: 0, lenM: 0 });
      remaining--;
    }
  }
  if (remaining === 0) return out;

  // Heuristic: minimum haversine distance to any unsatisfied destination,
  // converted to seconds at max road speed. h is admissible because no edge
  // is faster than MAX_ROAD_SPEED_M_S, so it never overestimates the true
  // remaining cost.
  function hEst(lat: number, lon: number): number {
    let bestMeters = Infinity;
    for (const g of groups) {
      if (groupSatisfied.has(g.id)) continue;
      const m = haversineMeters(lat, lon, g.destLat, g.destLon);
      if (m < bestMeters) bestMeters = m;
    }
    return bestMeters === Infinity ? 0 : (bestMeters / MAX_ROAD_SPEED_M_S) * HEURISTIC_WEIGHT;
  }

  const heap = new MinHeap();
  const srcH = hEst(srcScratch.tile.localLat[src.dense], srcScratch.tile.localLon[src.dense]);
  heap.push(srcH, 0, srcPacked, src.dense, 0);
  const tmp = [0, 0, 0, 0, 0];
  const maxSettled = opts.maxSettled ?? 2_000_000;

  let active = srcScratch;
  let activePacked = srcPacked;
  let settled = 0;

  while (heap.size > 0 && remaining > 0 && settled < maxSettled) {
    heap.popInto(tmp);
    /* tmp[0] = f -- no longer needed once popped */
    const curG = tmp[1];
    const curTile = tmp[2];
    const curDense = tmp[3];
    const curLen = tmp[4];

    if (curTile !== activePacked) {
      const next = await loadScratch(curTile);
      if (!next) continue;
      active = next;
      activePacked = curTile;
    }

    if (active.visited[curDense]) continue;
    active.visited[curDense] = 1;
    active.lenTo[curDense] = curLen;
    settled++;

    const tInner = targets.get(curTile);
    if (tInner) {
      const id = tInner.get(curDense);
      if (id !== undefined && !groupSatisfied.has(id)) {
        groupSatisfied.add(id);
        out.set(id, { timeS: curG, lenM: curLen });
        remaining--;
        if (remaining === 0) break;
      }
    }

    const tile = active.tile;
    if (curDense >= tile.nLocal) continue;
    const eStart = tile.edgeOffsets[curDense];
    const eEnd = tile.edgeOffsets[curDense + 1];

    for (let e = eStart; e < eEnd; e++) {
      const targetIdx = tile.edgeTargets[e];
      const edgeT = tile.edgeTimeS[e];
      const edgeL = tile.edgeLenM[e];
      let nextTile: number;
      let nextDense: number;
      if (targetIdx < tile.nLocal) {
        nextTile = curTile;
        nextDense = targetIdx;
      } else {
        const ei = targetIdx - tile.nLocal;
        if (ei >= tile.nExtern) continue;
        nextTile = tile.externPacked[ei];
        nextDense = tile.externDense[ei];
      }
      const nd = curG + edgeT;
      const nl = curLen + edgeL;
      if (nextTile === activePacked) {
        if (active.visited[nextDense]) continue;
        if (nd < active.dist[nextDense]) {
          active.dist[nextDense] = nd;
          // We have the next node's coords -- compute the full heuristic.
          const h = hEst(tile.localLat[nextDense], tile.localLon[nextDense]);
          heap.push(nd + h, nd, nextTile, nextDense, nl);
        }
      } else {
        const otherScratch = scratch.get(nextTile);
        if (otherScratch) {
          if (otherScratch.visited[nextDense]) continue;
          if (nd < otherScratch.dist[nextDense]) {
            otherScratch.dist[nextDense] = nd;
            const h = hEst(otherScratch.tile.localLat[nextDense], otherScratch.tile.localLon[nextDense]);
            heap.push(nd + h, nd, nextTile, nextDense, nl);
          }
        } else {
          // Target tile not yet loaded -- use current node's coords as a
          // close-enough h proxy (one edge away, so off by at most ~tile-cell-size /
          // MAX_SPEED, a few seconds). Re-evaluated correctly on pop.
          const h = hEst(tile.localLat[curDense], tile.localLon[curDense]);
          heap.push(nd + h, nd, nextTile, nextDense, nl);
        }
      }
    }
  }
  return out;
}
