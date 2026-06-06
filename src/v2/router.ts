// Tiled lazy-fetch one-to-many Dijkstra.
//
// Perf discipline: the inner loop holds the active tile in a local AND keeps
// per-tile `dist` (Float32) and `visited` (Uint8) arrays so every per-node op
// is a typed-array index, not a Map call. Cross-tile traversal lazily allocates
// the target tile's arrays. Switching active tiles is rare relative to pops, so
// the await on getTile only fires on actual crossings.

import { getTile, packTileId, Tile } from "./tiles";

export interface NodeRef { tx: number; ty: number; dense: number }
export interface LegResult { timeS: number; lenM: number }
export interface DestGroup { id: string; candidates: NodeRef[] }

interface TileScratch {
  tile: Tile;
  dist: Float32Array;       // length tile.nLocal; +Infinity = unseen
  visited: Uint8Array;      // length tile.nLocal
  lenTo: Float32Array;      // length tile.nLocal; meters along best-time path
}

class MinHeap {
  private d: number[] = [];
  private t: number[] = [];   // tilePacked
  private n: number[] = [];   // dense
  private l: number[] = [];   // lenSoFar -- authoritative, in case target tile isn't loaded yet
  get size() { return this.d.length; }

  push(dist: number, tilePacked: number, dense: number, lenSoFar: number) {
    this.d.push(dist); this.t.push(tilePacked); this.n.push(dense); this.l.push(lenSoFar);
    let i = this.d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p] <= this.d[i]) break;
      const td = this.d[p]; this.d[p] = this.d[i]; this.d[i] = td;
      const tt = this.t[p]; this.t[p] = this.t[i]; this.t[i] = tt;
      const tn = this.n[p]; this.n[p] = this.n[i]; this.n[i] = tn;
      const tl = this.l[p]; this.l[p] = this.l[i]; this.l[i] = tl;
      i = p;
    }
  }

  popInto(out: number[]): void {
    out[0] = this.d[0]; out[1] = this.t[0]; out[2] = this.n[0]; out[3] = this.l[0];
    const lastD = this.d.pop()!; const lastT = this.t.pop()!; const lastN = this.n.pop()!; const lastL = this.l.pop()!;
    if (this.d.length > 0) {
      this.d[0] = lastD; this.t[0] = lastT; this.n[0] = lastN; this.l[0] = lastL;
      let i = 0;
      const sz = this.d.length;
      while (true) {
        const l = i * 2 + 1, r = l + 1;
        let best = i;
        if (l < sz && this.d[l] < this.d[best]) best = l;
        if (r < sz && this.d[r] < this.d[best]) best = r;
        if (best === i) break;
        const td = this.d[best]; this.d[best] = this.d[i]; this.d[i] = td;
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

  const heap = new MinHeap();
  heap.push(0, srcPacked, src.dense, 0);
  const tmp = [0, 0, 0, 0];
  const maxSettled = opts.maxSettled ?? 2_000_000;

  let active = srcScratch;
  let activePacked = srcPacked;
  let settled = 0;

  while (heap.size > 0 && remaining > 0 && settled < maxSettled) {
    heap.popInto(tmp);
    const curDist = tmp[0];
    const curTile = tmp[1];
    const curDense = tmp[2];
    const curLen = tmp[3];

    if (curTile !== activePacked) {
      const next = await loadScratch(curTile);
      if (!next) continue;
      active = next;
      activePacked = curTile;
    }

    if (active.visited[curDense]) continue;
    active.visited[curDense] = 1;
    // Keep lenTo authoritative even for nodes reached via cross-tile push.
    active.lenTo[curDense] = curLen;
    settled++;

    const tInner = targets.get(curTile);
    if (tInner) {
      const id = tInner.get(curDense);
      if (id !== undefined && !groupSatisfied.has(id)) {
        groupSatisfied.add(id);
        out.set(id, { timeS: curDist, lenM: curLen });
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
      const nd = curDist + edgeT;
      const nl = curLen + edgeL;
      if (nextTile === activePacked) {
        if (active.visited[nextDense]) continue;
        if (nd < active.dist[nextDense]) {
          active.dist[nextDense] = nd;
          heap.push(nd, nextTile, nextDense, nl);
        }
      } else {
        const otherScratch = scratch.get(nextTile);
        if (otherScratch) {
          if (otherScratch.visited[nextDense]) continue;
          if (nd < otherScratch.dist[nextDense]) {
            otherScratch.dist[nextDense] = nd;
            heap.push(nd, nextTile, nextDense, nl);
          }
        } else {
          // Target tile not yet loaded. Push with authoritative len so we don't
          // lose track; visited check on pop handles dupes.
          heap.push(nd, nextTile, nextDense, nl);
        }
      }
    }
  }
  return out;
}
