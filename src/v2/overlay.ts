// L1 highway overlay loader + bidirectional A* search.
//
// L1 is a single national graph of motorway/trunk/primary edges only --
// ~1-3M nodes, ~3-6M edges. Loaded once per isolate from R2 and held in a
// module-global. Used for long-distance routes (>= 200 mi straight-line)
// where the L0 tiled graph hits the 2M-settled cap.
//
// Binary layout matches etl/v2/build_overlay.py exactly.

export interface Overlay {
  N: number;
  M: number;
  lat: Float32Array;
  lon: Float32Array;
  edgeOffsets: Uint32Array;
  edgeTargets: Uint32Array;
  edgeTimeS: Float32Array;
  edgeLenM: Float32Array;
  // Reverse edges -- targets per node. Computed once at decode time so backward
  // A* has access to incoming edges without scanning the whole edge list.
  revOffsets: Uint32Array;
  revSources: Uint32Array;     // source of each incoming edge (== "target" of the reverse)
  revTimeS: Float32Array;
  revLenM: Float32Array;
  // Spatial snap grid.
  gridMinLat: number;
  gridMinLon: number;
  gridNLat: number;
  gridNLon: number;
  gridCellDeg: number;
  gridOffsets: Uint32Array;
  gridNodeIds: Uint32Array;
}

const MAGIC = 0x314c4848; // "HHL1" little-endian

let cached: Overlay | null = null;
let loading: Promise<Overlay> | null = null;

export async function getOverlay(bucket: R2Bucket, version: string): Promise<Overlay> {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    const key = `overlay/${version}/l1.bin`;
    const obj = await bucket.get(key);
    if (!obj) throw new Error(`L1 overlay missing: ${key}`);
    const buf = await obj.arrayBuffer();
    const o = decode(buf);
    cached = o;
    loading = null;
    return o;
  })();
  return loading;
}

function decode(buf: ArrayBuffer): Overlay {
  const dv = new DataView(buf);
  let p = 0;
  const magic = dv.getUint32(p, true); p += 4;
  if (magic !== MAGIC) throw new Error(`bad L1 magic 0x${magic.toString(16)}`);
  /* fmt_ver */ p += 4;
  const N = dv.getUint32(p, true); p += 4;
  const M = dv.getUint32(p, true); p += 4;
  const gridMinLatE7 = dv.getInt32(p, true); p += 4;
  const gridMinLonE7 = dv.getInt32(p, true); p += 4;
  const gridNLat = dv.getUint32(p, true); p += 4;
  const gridNLon = dv.getUint32(p, true); p += 4;
  const cellSizeE5 = dv.getUint32(p, true); p += 4;
  /* reserved */ p += 4;
  // Header total: 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 = 40 bytes
  if (p !== 40) throw new Error(`header offset ${p} != 40`);

  const lat = new Float32Array(buf, p, N); p += N * 4;
  const lon = new Float32Array(buf, p, N); p += N * 4;
  const edgeOffsets = new Uint32Array(buf, p, N + 1); p += (N + 1) * 4;
  const edgeTargets = new Uint32Array(buf, p, M); p += M * 4;
  const edgeTimeS = new Float32Array(buf, p, M); p += M * 4;
  const edgeLenM = new Float32Array(buf, p, M); p += M * 4;
  const gridTotal = gridNLat * gridNLon;
  const gridOffsets = new Uint32Array(buf, p, gridTotal + 1); p += (gridTotal + 1) * 4;
  const gridNodeIds = new Uint32Array(buf, p, N); p += N * 4;

  // Build reverse CSR: for each node v, list of (source u, time, len).
  const revDeg = new Uint32Array(N);
  for (let e = 0; e < M; e++) revDeg[edgeTargets[e]]++;
  const revOffsets = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) revOffsets[i + 1] = revOffsets[i] + revDeg[i];
  const revSources = new Uint32Array(M);
  const revTimeS = new Float32Array(M);
  const revLenM = new Float32Array(M);
  const cursor = new Uint32Array(N);
  for (let u = 0; u < N; u++) {
    const s = edgeOffsets[u]; const e = edgeOffsets[u + 1];
    for (let i = s; i < e; i++) {
      const v = edgeTargets[i];
      const slot = revOffsets[v] + cursor[v];
      revSources[slot] = u;
      revTimeS[slot] = edgeTimeS[i];
      revLenM[slot] = edgeLenM[i];
      cursor[v]++;
    }
  }

  return {
    N, M, lat, lon, edgeOffsets, edgeTargets, edgeTimeS, edgeLenM,
    revOffsets, revSources, revTimeS, revLenM,
    gridMinLat: gridMinLatE7 / 1e7,
    gridMinLon: gridMinLonE7 / 1e7,
    gridNLat, gridNLon,
    gridCellDeg: cellSizeE5 / 1e5,
    gridOffsets, gridNodeIds,
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

// Snap a (lat,lon) to the nearest L1 node. Spatial-grid search.
export function snapL1(o: Overlay, lat: number, lon: number): { node: number; distM: number } | null {
  if (o.N === 0) return null;
  const cy0 = Math.floor((lat - o.gridMinLat) / o.gridCellDeg);
  const cx0 = Math.floor((lon - o.gridMinLon) / o.gridCellDeg);
  let best = -1;
  let bestD = Infinity;
  // Expand outward up to 10 cells (~110 km) to handle areas with sparse highway coverage.
  for (let r = 0; r <= 10 && best < 0; r++) {
    const yMin = Math.max(0, cy0 - r);
    const yMax = Math.min(o.gridNLat - 1, cy0 + r);
    const xMin = Math.max(0, cx0 - r);
    const xMax = Math.min(o.gridNLon - 1, cx0 + r);
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (r > 0 && y !== yMin && y !== yMax && x !== xMin && x !== xMax) continue;
        const c = y * o.gridNLon + x;
        if (c < 0 || c >= o.gridOffsets.length - 1) continue;
        const s = o.gridOffsets[c];
        const e = o.gridOffsets[c + 1];
        for (let i = s; i < e; i++) {
          const n = o.gridNodeIds[i];
          const d = haversineMeters(lat, lon, o.lat[n], o.lon[n]);
          if (d < bestD) { bestD = d; best = n; }
        }
      }
    }
    if (best >= 0 && r >= 1) break;
  }
  return best >= 0 ? { node: best, distM: bestD } : null;
}

// ---------------------------------------------------------------------------
// Bidirectional weighted A*. Single in-memory graph -> no tile-fetch I/O.
// ---------------------------------------------------------------------------

const MAX_ROAD_SPEED_M_S = 30;
const HEURISTIC_WEIGHT = 1.5;

class MinHeap {
  private f: number[] = [];
  private g: number[] = [];
  private n: number[] = [];
  get size() { return this.f.length; }
  top(): number { return this.f.length > 0 ? this.f[0] : Infinity }
  push(f: number, g: number, n: number) {
    this.f.push(f); this.g.push(g); this.n.push(n);
    let i = this.f.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      const tf=this.f[p]; this.f[p]=this.f[i]; this.f[i]=tf;
      const tg=this.g[p]; this.g[p]=this.g[i]; this.g[i]=tg;
      const tn=this.n[p]; this.n[p]=this.n[i]; this.n[i]=tn;
      i = p;
    }
  }
  popInto(out: number[]) {
    out[0]=this.f[0]; out[1]=this.g[0]; out[2]=this.n[0];
    const lf=this.f.pop()!; const lg=this.g.pop()!; const ln=this.n.pop()!;
    if (this.f.length > 0) {
      this.f[0]=lf; this.g[0]=lg; this.n[0]=ln;
      let i=0; const sz=this.f.length;
      while (true) {
        const l=i*2+1, r=l+1; let best=i;
        if (l<sz && this.f[l]<this.f[best]) best=l;
        if (r<sz && this.f[r]<this.f[best]) best=r;
        if (best===i) break;
        const tf=this.f[best]; this.f[best]=this.f[i]; this.f[i]=tf;
        const tg=this.g[best]; this.g[best]=this.g[i]; this.g[i]=tg;
        const tn=this.n[best]; this.n[best]=this.n[i]; this.n[i]=tn;
        i=best;
      }
    }
  }
}

export interface L1LegResult { timeS: number; lenM: number }

export function bidirAStar(
  o: Overlay,
  src: number,
  dst: number,
  opts: { maxSettled?: number } = {},
): L1LegResult | null {
  if (src === dst) return { timeS: 0, lenM: 0 };
  const N = o.N;
  const dstLat = o.lat[dst];
  const dstLon = o.lon[dst];
  const srcLat = o.lat[src];
  const srcLon = o.lon[src];

  const hFwd = (n: number) => {
    const d = haversineMeters(o.lat[n], o.lon[n], dstLat, dstLon);
    return (d / MAX_ROAD_SPEED_M_S) * HEURISTIC_WEIGHT;
  };
  const hBwd = (n: number) => {
    const d = haversineMeters(o.lat[n], o.lon[n], srcLat, srcLon);
    return (d / MAX_ROAD_SPEED_M_S) * HEURISTIC_WEIGHT;
  };

  const fDist = new Float32Array(N); fDist.fill(Infinity);
  const fLen = new Float32Array(N);
  const fSettled = new Uint8Array(N);
  const bDist = new Float32Array(N); bDist.fill(Infinity);
  const bLen = new Float32Array(N);
  const bSettled = new Uint8Array(N);
  fDist[src] = 0; bDist[dst] = 0;

  const fHeap = new MinHeap();
  const bHeap = new MinHeap();
  fHeap.push(hFwd(src), 0, src);
  bHeap.push(hBwd(dst), 0, dst);

  let mu = Infinity;       // tentative best total time
  let muLen = Infinity;
  const tmp = [0, 0, 0];
  const maxSettled = opts.maxSettled ?? 3_000_000;
  let settled = 0;

  while (fHeap.size > 0 && bHeap.size > 0 && settled < maxSettled) {
    // Termination: when the min f from EITHER direction would exceed mu, the
    // current tentative path is optimal.
    if (fHeap.top() + bHeap.top() >= mu) break;

    // Pop from the smaller frontier.
    if (fHeap.top() <= bHeap.top()) {
      fHeap.popInto(tmp);
      const u = tmp[2];
      if (fSettled[u]) continue;
      fSettled[u] = 1;
      settled++;
      // Meeting check.
      if (bDist[u] !== Infinity) {
        const total = fDist[u] + bDist[u];
        if (total < mu) {
          mu = total;
          muLen = fLen[u] + bLen[u];
        }
      }
      const gu = fDist[u];
      const luLen = fLen[u];
      const s = o.edgeOffsets[u]; const e = o.edgeOffsets[u + 1];
      for (let i = s; i < e; i++) {
        const v = o.edgeTargets[i];
        if (fSettled[v]) continue;
        const nd = gu + o.edgeTimeS[i];
        if (nd < fDist[v]) {
          fDist[v] = nd;
          fLen[v] = luLen + o.edgeLenM[i];
          fHeap.push(nd + hFwd(v), nd, v);
        }
      }
    } else {
      bHeap.popInto(tmp);
      const u = tmp[2];
      if (bSettled[u]) continue;
      bSettled[u] = 1;
      settled++;
      if (fDist[u] !== Infinity) {
        const total = fDist[u] + bDist[u];
        if (total < mu) {
          mu = total;
          muLen = fLen[u] + bLen[u];
        }
      }
      const gu = bDist[u];
      const luLen = bLen[u];
      const s = o.revOffsets[u]; const e = o.revOffsets[u + 1];
      for (let i = s; i < e; i++) {
        const v = o.revSources[i];
        if (bSettled[v]) continue;
        const nd = gu + o.revTimeS[i];
        if (nd < bDist[v]) {
          bDist[v] = nd;
          bLen[v] = luLen + o.revLenM[i];
          bHeap.push(nd + hBwd(v), nd, v);
        }
      }
    }
  }

  if (mu === Infinity) return null;
  return { timeS: mu, lenM: muLen };
}
