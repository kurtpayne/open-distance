import { haversineMeters } from "./geo";

// L1 highway overlay graph: decoder + snap + bidir A*.
// Lives entirely in the L1Router DurableObject; never imported by the Worker
// directly (which has a tighter memory budget).
//
// Binary format v2 stores edge time as u16 seconds and edge length as u16
// decameters (10 m units). All highway edges are emitted bidirectional at
// build time, so the forward CSR is symmetric -- bidir A* uses it for both
// forward and backward expansion, eliminating the reverse CSR and saving
// ~32 MB at runtime.

export interface L1Graph {
  n: number;
  m: number;
  lat: Float32Array;
  lon: Float32Array;
  edgeOffsets: Uint32Array;
  edgeTargets: Uint32Array;
  edgeTimeS: Uint16Array;     // quantized seconds; raw value already in seconds
  edgeLenDam: Uint16Array;    // quantized decameters; meters = value * 10
  // Spatial snap grid (read straight from the binary).
  gridMinLat: number;
  gridMinLon: number;
  gridNLat: number;
  gridNLon: number;
  gridCellDeg: number;
  gridOffsets: Uint32Array;
  gridNodeIds: Uint32Array;
}

const MAGIC = 0x314c4848; // "HHL1" little-endian
const FMT_VER_EXPECTED = 2;
const MAX_ROAD_SPEED_M_S = 30;
const HEURISTIC_WEIGHT = 1.5;

export function decodeL1(buf: ArrayBuffer): L1Graph {
  const dv = new DataView(buf);
  let p = 0;
  const magic = dv.getUint32(p, true); p += 4;
  if (magic !== MAGIC) throw new Error(`bad L1 magic 0x${magic.toString(16)}`);
  const fmtVer = dv.getUint32(p, true); p += 4;
  if (fmtVer !== FMT_VER_EXPECTED) throw new Error(`L1 fmt ver ${fmtVer} (expected ${FMT_VER_EXPECTED})`);
  const n = dv.getUint32(p, true); p += 4;
  const m = dv.getUint32(p, true); p += 4;
  const gridMinLatE7 = dv.getInt32(p, true); p += 4;
  const gridMinLonE7 = dv.getInt32(p, true); p += 4;
  const gridNLat = dv.getUint32(p, true); p += 4;
  const gridNLon = dv.getUint32(p, true); p += 4;
  const cellSizeE5 = dv.getUint32(p, true); p += 4;
  /* reserved */ p += 4;
  if (p !== 40) throw new Error(`L1 header size unexpected: ${p}`);

  const lat = new Float32Array(buf, p, n); p += n * 4;
  const lon = new Float32Array(buf, p, n); p += n * 4;
  const edgeOffsets = new Uint32Array(buf, p, n + 1); p += (n + 1) * 4;
  const edgeTargets = new Uint32Array(buf, p, m); p += m * 4;
  const edgeTimeS = new Uint16Array(buf, p, m); p += m * 2;
  const edgeLenDam = new Uint16Array(buf, p, m); p += m * 2;
  const gridTotal = gridNLat * gridNLon;
  const gridOffsets = new Uint32Array(buf, p, gridTotal + 1); p += (gridTotal + 1) * 4;
  const gridNodeIds = new Uint32Array(buf, p, n); p += n * 4;

  return {
    n, m, lat, lon, edgeOffsets, edgeTargets, edgeTimeS, edgeLenDam,
    gridMinLat: gridMinLatE7 / 1e7,
    gridMinLon: gridMinLonE7 / 1e7,
    gridNLat, gridNLon,
    gridCellDeg: cellSizeE5 / 1e5,
    gridOffsets, gridNodeIds,
  };
}


export function snapL1(g: L1Graph, lat: number, lon: number, requireOutgoing: boolean): { node: number; distM: number } | null {
  if (g.n === 0) return null;
  const cy0 = Math.floor((lat - g.gridMinLat) / g.gridCellDeg);
  const cx0 = Math.floor((lon - g.gridMinLon) / g.gridCellDeg);
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r <= 10; r++) {
    const yMin = Math.max(0, cy0 - r);
    const yMax = Math.min(g.gridNLat - 1, cy0 + r);
    const xMin = Math.max(0, cx0 - r);
    const xMax = Math.min(g.gridNLon - 1, cx0 + r);
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (r > 0 && y !== yMin && y !== yMax && x !== xMin && x !== xMax) continue;
        const c = y * g.gridNLon + x;
        if (c < 0 || c >= g.gridOffsets.length - 1) continue;
        const s = g.gridOffsets[c];
        const e = g.gridOffsets[c + 1];
        for (let i = s; i < e; i++) {
          const node = g.gridNodeIds[i];
          if (requireOutgoing && g.edgeOffsets[node + 1] === g.edgeOffsets[node]) continue;
          const d = haversineMeters(lat, lon, g.lat[node], g.lon[node]);
          if (d < bestD) { bestD = d; best = node; }
        }
      }
    }
    if (best >= 0) return { node: best, distM: bestD };
  }
  return null;
}

// Min-heap for bidir A* frontiers.
class MinHeap {
  private f: number[] = [];
  private g: number[] = [];
  private n: number[] = [];
  get size() { return this.f.length; }
  top(): number { return this.f.length > 0 ? this.f[0] : Infinity; }
  push(f: number, g: number, n: number) {
    this.f.push(f); this.g.push(g); this.n.push(n);
    let i = this.f.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      const tf = this.f[p]; this.f[p] = this.f[i]; this.f[i] = tf;
      const tg = this.g[p]; this.g[p] = this.g[i]; this.g[i] = tg;
      const tn = this.n[p]; this.n[p] = this.n[i]; this.n[i] = tn;
      i = p;
    }
  }
  popInto(out: number[]) {
    out[0] = this.f[0]; out[1] = this.g[0]; out[2] = this.n[0];
    const lf = this.f.pop()!; const lg = this.g.pop()!; const ln = this.n.pop()!;
    if (this.f.length > 0) {
      this.f[0] = lf; this.g[0] = lg; this.n[0] = ln;
      let i = 0; const sz = this.f.length;
      while (true) {
        const l = i * 2 + 1, r = l + 1; let best = i;
        if (l < sz && this.f[l] < this.f[best]) best = l;
        if (r < sz && this.f[r] < this.f[best]) best = r;
        if (best === i) break;
        const tf = this.f[best]; this.f[best] = this.f[i]; this.f[i] = tf;
        const tg = this.g[best]; this.g[best] = this.g[i]; this.g[i] = tg;
        const tn = this.n[best]; this.n[best] = this.n[i]; this.n[i] = tn;
        i = best;
      }
    }
  }
}

/**
 * Bidirectional A* on the L1 overlay. The forward CSR is symmetric (every
 * edge has its reverse) so backward expansion uses the same array. Sparse
 * Map state for dist/len so memory scales with settled count, not n_nodes.
 */
export function bidirAStarL1(g: L1Graph, src: number, dst: number, maxSettled: number): { timeS: number; lenM: number; settled: number } | null {
  if (src === dst) return { timeS: 0, lenM: 0, settled: 0 };
  const dstLat = g.lat[dst], dstLon = g.lon[dst];
  const srcLat = g.lat[src], srcLon = g.lon[src];

  const hFwd = (n: number) => HEURISTIC_WEIGHT * haversineMeters(g.lat[n], g.lon[n], dstLat, dstLon) / MAX_ROAD_SPEED_M_S;
  const hBwd = (n: number) => HEURISTIC_WEIGHT * haversineMeters(g.lat[n], g.lon[n], srcLat, srcLon) / MAX_ROAD_SPEED_M_S;

  const fDist = new Map<number, number>(); const fLen = new Map<number, number>(); const fSet = new Set<number>();
  const bDist = new Map<number, number>(); const bLen = new Map<number, number>(); const bSet = new Set<number>();
  fDist.set(src, 0); fLen.set(src, 0);
  bDist.set(dst, 0); bLen.set(dst, 0);

  const fHeap = new MinHeap(); const bHeap = new MinHeap();
  fHeap.push(hFwd(src), 0, src);
  bHeap.push(hBwd(dst), 0, dst);

  let mu = Infinity; let muLen = Infinity;
  const tmp = [0, 0, 0];
  let settled = 0;

  while (fHeap.size > 0 && bHeap.size > 0 && settled < maxSettled) {
    if (fHeap.top() + bHeap.top() >= mu) break;
    if (fHeap.top() <= bHeap.top()) {
      fHeap.popInto(tmp);
      const u = tmp[2];
      if (fSet.has(u)) continue;
      fSet.add(u); settled++;
      const bd = bDist.get(u);
      if (bd !== undefined) {
        const total = (fDist.get(u) ?? Infinity) + bd;
        if (total < mu) { mu = total; muLen = (fLen.get(u) ?? 0) + (bLen.get(u) ?? 0); }
      }
      const gu = fDist.get(u)!; const luLen = fLen.get(u)!;
      const s = g.edgeOffsets[u]; const e = g.edgeOffsets[u + 1];
      for (let i = s; i < e; i++) {
        const v = g.edgeTargets[i];
        if (fSet.has(v)) continue;
        const nd = gu + g.edgeTimeS[i];
        if (nd < (fDist.get(v) ?? Infinity)) {
          fDist.set(v, nd);
          fLen.set(v, luLen + g.edgeLenDam[i] * 10);
          fHeap.push(nd + hFwd(v), nd, v);
        }
      }
    } else {
      bHeap.popInto(tmp);
      const u = tmp[2];
      if (bSet.has(u)) continue;
      bSet.add(u); settled++;
      const fd = fDist.get(u);
      if (fd !== undefined) {
        const total = fd + (bDist.get(u) ?? Infinity);
        if (total < mu) { muLen = (fLen.get(u) ?? 0) + (bLen.get(u) ?? 0); mu = total; }
      }
      const gu = bDist.get(u)!; const luLen = bLen.get(u)!;
      // Symmetric graph: outgoing edges of u are also incoming edges of u.
      const s = g.edgeOffsets[u]; const e = g.edgeOffsets[u + 1];
      for (let i = s; i < e; i++) {
        const v = g.edgeTargets[i];
        if (bSet.has(v)) continue;
        const nd = gu + g.edgeTimeS[i];
        if (nd < (bDist.get(v) ?? Infinity)) {
          bDist.set(v, nd);
          bLen.set(v, luLen + g.edgeLenDam[i] * 10);
          bHeap.push(nd + hBwd(v), nd, v);
        }
      }
    }
  }
  if (mu === Infinity) return null;
  return { timeS: mu, lenM: muLen, settled };
}
