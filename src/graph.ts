// CSR road graph: warm-loaded from R2 once per isolate.
//
// Binary layout (little-endian):
//   magic[4]  = "HHGR"
//   u32 version_tag
//   u32 N (nodes)
//   u32 M (edges)
//   u32 grid_min_lat_e7, grid_min_lon_e7  (i32 actually)
//   u32 grid_n_lat, grid_n_lon            (cells per axis)
//   u32 cell_size_e5                      (cell width in 1e-5 deg units)
//   u32 grid_total_cells                  (== grid_n_lat * grid_n_lon)
//   u32 reserved
//   node_offsets : u32[N+1]
//   edge_targets : u32[M]
//   edge_time_s  : f32[M]
//   edge_len_m   : f32[M]
//   lat          : f32[N]
//   lon          : f32[N]
//   grid_offsets : u32[grid_total_cells+1]
//   grid_node_ids: u32[N]   (nodes bucketed by cell)

export interface Graph {
  version: number;
  N: number;
  M: number;
  nodeOffsets: Uint32Array;
  edgeTargets: Uint32Array;
  edgeTimeS: Float32Array;
  edgeLenM: Float32Array;
  lat: Float32Array;
  lon: Float32Array;
  gridMinLat: number;
  gridMinLon: number;
  gridNLat: number;
  gridNLon: number;
  cellSizeDeg: number;
  gridOffsets: Uint32Array;
  gridNodeIds: Uint32Array;
}

let cached: Graph | null = null;
let loading: Promise<Graph> | null = null;

export async function getGraph(bucket: R2Bucket, version: string): Promise<Graph> {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    const key = `graph-${version}.bin`;
    const obj = await bucket.get(key);
    if (!obj) throw new Error(`graph object not found: ${key}`);
    const buf = await obj.arrayBuffer();
    const g = decodeGraph(buf);
    cached = g;
    loading = null;
    return g;
  })();
  return loading;
}

function decodeGraph(buf: ArrayBuffer): Graph {
  const dv = new DataView(buf);
  let p = 0;
  const magic = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
  if (magic !== "HHGR") throw new Error(`bad graph magic: ${magic}`);
  p += 4;
  const version = dv.getUint32(p, true); p += 4;
  const N = dv.getUint32(p, true); p += 4;
  const M = dv.getUint32(p, true); p += 4;
  const gridMinLatE7 = dv.getInt32(p, true); p += 4;
  const gridMinLonE7 = dv.getInt32(p, true); p += 4;
  const gridNLat = dv.getUint32(p, true); p += 4;
  const gridNLon = dv.getUint32(p, true); p += 4;
  const cellSizeE5 = dv.getUint32(p, true); p += 4;
  const gridTotal = dv.getUint32(p, true); p += 4;
  /* reserved */ p += 4;

  const nodeOffsets = new Uint32Array(buf, p, N + 1); p += (N + 1) * 4;
  const edgeTargets = new Uint32Array(buf, p, M); p += M * 4;
  const edgeTimeS = new Float32Array(buf, p, M); p += M * 4;
  const edgeLenM = new Float32Array(buf, p, M); p += M * 4;
  const lat = new Float32Array(buf, p, N); p += N * 4;
  const lon = new Float32Array(buf, p, N); p += N * 4;
  const gridOffsets = new Uint32Array(buf, p, gridTotal + 1); p += (gridTotal + 1) * 4;
  const gridNodeIds = new Uint32Array(buf, p, N); p += N * 4;

  return {
    version, N, M,
    nodeOffsets, edgeTargets, edgeTimeS, edgeLenM, lat, lon,
    gridMinLat: gridMinLatE7 / 1e7,
    gridMinLon: gridMinLonE7 / 1e7,
    gridNLat, gridNLon,
    cellSizeDeg: cellSizeE5 / 1e5,
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

export function snap(g: Graph, lat: number, lon: number): { node: number; distM: number } | null {
  const cy = Math.floor((lat - g.gridMinLat) / g.cellSizeDeg);
  const cx = Math.floor((lon - g.gridMinLon) / g.cellSizeDeg);
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r < 8 && best < 0; r++) {
    const yMin = Math.max(0, cy - r);
    const yMax = Math.min(g.gridNLat - 1, cy + r);
    const xMin = Math.max(0, cx - r);
    const xMax = Math.min(g.gridNLon - 1, cx + r);
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (r > 0 && y !== yMin && y !== yMax && x !== xMin && x !== xMax) continue;
        const cell = y * g.gridNLon + x;
        if (cell < 0 || cell >= g.gridOffsets.length - 1) continue;
        const start = g.gridOffsets[cell];
        const end = g.gridOffsets[cell + 1];
        for (let i = start; i < end; i++) {
          const n = g.gridNodeIds[i];
          const d = haversineMeters(lat, lon, g.lat[n], g.lon[n]);
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    if (best >= 0 && r >= 1) break;
  }
  return best >= 0 ? { node: best, distM: bestD } : null;
}

// Binary min-heap keyed by [dist:number, node:number]
class MinHeap {
  private d: number[] = [];
  private n: number[] = [];
  get size() { return this.d.length; }
  push(dist: number, node: number) {
    this.d.push(dist); this.n.push(node);
    let i = this.d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.d[p] <= this.d[i]) break;
      [this.d[p], this.d[i]] = [this.d[i], this.d[p]];
      [this.n[p], this.n[i]] = [this.n[i], this.n[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const dist = this.d[0]; const node = this.n[0];
    const lastD = this.d.pop()!; const lastN = this.n.pop()!;
    if (this.d.length > 0) {
      this.d[0] = lastD; this.n[0] = lastN;
      let i = 0;
      const sz = this.d.length;
      while (true) {
        const l = i * 2 + 1, r = l + 1;
        let best = i;
        if (l < sz && this.d[l] < this.d[best]) best = l;
        if (r < sz && this.d[r] < this.d[best]) best = r;
        if (best === i) break;
        [this.d[best], this.d[i]] = [this.d[i], this.d[best]];
        [this.n[best], this.n[i]] = [this.n[i], this.n[best]];
        i = best;
      }
    }
    return [dist, node];
  }
}

// One-to-many Dijkstra over time_s. Returns map of dest node -> {time_s, len_m}.
// Stops once every target has been settled (or queue empty).
export function oneToMany(
  g: Graph,
  src: number,
  targets: number[],
): Map<number, { timeS: number; lenM: number }> {
  const result = new Map<number, { timeS: number; lenM: number }>();
  if (targets.length === 0) return result;
  const targetSet = new Set(targets);
  let remaining = targetSet.size;

  // For each node we track current best time and accumulated length.
  // Using sparse arrays-as-maps would be slow; for Bay Area N ~ 1-2M, allocate.
  const dist = new Float64Array(g.N);
  const lenTo = new Float32Array(g.N);
  const visited = new Uint8Array(g.N);
  dist.fill(Infinity);
  dist[src] = 0;

  if (targetSet.has(src)) {
    result.set(src, { timeS: 0, lenM: 0 });
    remaining--;
  }
  if (remaining === 0) return result;

  const heap = new MinHeap();
  heap.push(0, src);

  while (heap.size > 0 && remaining > 0) {
    const [d, u] = heap.pop();
    if (visited[u]) continue;
    visited[u] = 1;
    if (targetSet.has(u) && u !== src) {
      result.set(u, { timeS: d, lenM: lenTo[u] });
      remaining--;
      if (remaining === 0) break;
    }
    const start = g.nodeOffsets[u];
    const end = g.nodeOffsets[u + 1];
    for (let e = start; e < end; e++) {
      const v = g.edgeTargets[e];
      if (visited[v]) continue;
      const nd = d + g.edgeTimeS[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        lenTo[v] = lenTo[u] + g.edgeLenM[e];
        heap.push(nd, v);
      }
    }
  }
  return result;
}
