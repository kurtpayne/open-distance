//! od-router: tile-paged routing primitives, compiled to WASM.
//!
//! The TypeScript Worker owns orchestration -- fetching tiles from R2, the KV
//! leg cache, multi-candidate snap, cross-tile coordination. This crate owns
//! the hot inner loops:
//!   - tile binary decode (header + zero-copy slice offsets)
//!   - single-tile weighted A* (one src, one dst)
//!   - single-tile Dijkstra one-to-many (one src, N dsts) -- the leg-cache fill
//!
//! The WASM boundary uses a small linear-memory allocator. Caller allocates
//! via `od_alloc(n)`, copies bytes in, calls a routing function with the
//! pointer + length, and reads results from the location the function returns.
//!
//! Format mirrors src/tiles.ts exactly. The Rust + TypeScript decoders MUST
//! stay in lockstep; the binaries on R2 are the contract.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

// ---------------------------------------------------------------------------
// Linear-memory allocator surface for WASM callers.
// ---------------------------------------------------------------------------

/// Allocate a `size`-byte buffer in the WASM linear memory. The caller copies
/// the tile bytes (or input args) into it, then calls one of the routing
/// entry points with the returned pointer + the original size.
#[no_mangle]
pub extern "C" fn od_alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Free a buffer previously returned by `od_alloc`.
#[no_mangle]
pub unsafe extern "C" fn od_free(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        let _ = Vec::from_raw_parts(ptr, 0, size);
    }
}

// ---------------------------------------------------------------------------
// Tile format. Header constants must match etl/_tile_io.py and src/tiles.ts.
// ---------------------------------------------------------------------------

const MAGIC: u32 = 0x3054_4848; // "HHT0" little-endian

/// Zero-copy view into a tile binary. `bytes` is the full backing buffer; the
/// array fields are offsets + lengths interpreted on read.
pub struct TileView<'a> {
    pub tx: i32,
    pub ty: i32,
    pub n_local: u32,
    pub n_extern: u32,
    pub m_edges: u32,
    pub grid_n_lon: u16,
    pub grid_n_lat: u16,
    bytes: &'a [u8],
    off_local_lat: usize,   // f32 * n_local
    off_local_lon: usize,   // f32 * n_local
    off_edge_offsets: usize, // u32 * (n_local + 1)
    off_edge_targets: usize, // u32 * m_edges
    off_edge_time_s: usize,  // f32 * m_edges
    off_edge_len_m: usize,   // f32 * m_edges
    // For multi-tile routing: when an edge target >= n_local, it indexes into
    // the extern arrays (extern_idx = target - n_local). extern_packed[i] is a
    // u32 packed tile id (tx in high 16 bits, ty in low 16 bits, both i16);
    // extern_dense[i] is the target's dense id within that remote tile.
    off_extern_packed: usize, // u32 * n_extern
    off_extern_dense: usize,  // u32 * n_extern
}

impl<'a> TileView<'a> {
    pub fn decode(bytes: &'a [u8]) -> Option<TileView<'a>> {
        if bytes.len() < 32 {
            return None;
        }
        let magic = u32::from_le_bytes(bytes[0..4].try_into().ok()?);
        if magic != MAGIC {
            return None;
        }
        // bytes[4..8] = fmt_ver, ignored
        let tx = i32::from_le_bytes(bytes[8..12].try_into().ok()?);
        let ty = i32::from_le_bytes(bytes[12..16].try_into().ok()?);
        let n_local = u32::from_le_bytes(bytes[16..20].try_into().ok()?);
        let n_extern = u32::from_le_bytes(bytes[20..24].try_into().ok()?);
        let m_edges = u32::from_le_bytes(bytes[24..28].try_into().ok()?);
        let grid_n_lon = u16::from_le_bytes(bytes[28..30].try_into().ok()?);
        let grid_n_lat = u16::from_le_bytes(bytes[30..32].try_into().ok()?);

        let nl = n_local as usize;
        let ne = n_extern as usize;
        let me = m_edges as usize;

        let mut p = 32;
        let off_local_lat = p;      p += nl * 4;
        let off_local_lon = p;      p += nl * 4;
        let off_extern_packed = p;  p += ne * 4;
        let off_extern_dense = p;   p += ne * 4;
        let off_edge_offsets = p;   p += (nl + 1) * 4;
        let off_edge_targets = p;   p += me * 4;
        let off_edge_time_s = p;    p += me * 4;
        let off_edge_len_m = p;     p += me * 4;
        // grid arrays follow but we don't need them for the routing core.

        if p > bytes.len() {
            return None;
        }

        Some(TileView {
            tx, ty, n_local, n_extern, m_edges, grid_n_lon, grid_n_lat,
            bytes,
            off_local_lat, off_local_lon,
            off_extern_packed, off_extern_dense,
            off_edge_offsets, off_edge_targets, off_edge_time_s, off_edge_len_m,
        })
    }

    #[inline]
    fn read_u32(&self, byte_off: usize) -> u32 {
        u32::from_le_bytes(self.bytes[byte_off..byte_off + 4].try_into().unwrap_or([0; 4]))
    }
    #[inline]
    fn read_f32(&self, byte_off: usize) -> f32 {
        f32::from_le_bytes(self.bytes[byte_off..byte_off + 4].try_into().unwrap_or([0; 4]))
    }

    #[inline]
    pub fn lat(&self, node: u32) -> f32 { self.read_f32(self.off_local_lat + (node as usize) * 4) }
    #[inline]
    pub fn lon(&self, node: u32) -> f32 { self.read_f32(self.off_local_lon + (node as usize) * 4) }
    #[inline]
    fn edge_range(&self, node: u32) -> (u32, u32) {
        let n = node as usize;
        let start = self.read_u32(self.off_edge_offsets + n * 4);
        let end = self.read_u32(self.off_edge_offsets + (n + 1) * 4);
        (start, end)
    }
    #[inline]
    fn edge_target(&self, edge: u32) -> u32 {
        self.read_u32(self.off_edge_targets + (edge as usize) * 4)
    }
    #[inline]
    fn edge_time_s(&self, edge: u32) -> f32 {
        self.read_f32(self.off_edge_time_s + (edge as usize) * 4)
    }
    #[inline]
    fn edge_len_m(&self, edge: u32) -> f32 {
        self.read_f32(self.off_edge_len_m + (edge as usize) * 4)
    }
    /// Returns (remote_tile_id, remote_dense) for an extern-indexed target.
    /// Caller must have already verified target >= n_local.
    #[inline]
    fn resolve_extern(&self, target: u32) -> (u32, u32) {
        let extern_idx = (target - self.n_local) as usize;
        let remote_tile = self.read_u32(self.off_extern_packed + extern_idx * 4);
        let remote_dense = self.read_u32(self.off_extern_dense + extern_idx * 4);
        (remote_tile, remote_dense)
    }
    pub fn packed_id(&self) -> u32 {
        (((self.tx as u32) & 0xffff) << 16) | ((self.ty as u32) & 0xffff)
    }
}

// ---------------------------------------------------------------------------
// A* core. Weighted heuristic: h(n) = k * haversine(n, dst) / max_road_speed.
// max_road_speed = 30 m/s, weight k = 1.5 (matches TS implementation).
// ---------------------------------------------------------------------------

// Used only by the host-target sanity tests below; the production path is
// Dijkstra-only (no heuristic) so these don't ship in the WASM build.
#[cfg(test)] const MAX_SPEED_M_PER_S: f32 = 30.0;
#[cfg(test)] const ASTAR_WEIGHT_K: f32 = 1.5;
#[cfg(test)] const EARTH_R_M: f32 = 6_371_000.0;

#[cfg(test)]
#[inline]
fn haversine_m(lat1: f32, lon1: f32, lat2: f32, lon2: f32) -> f32 {
    let to_rad = std::f32::consts::PI / 180.0;
    let dlat = (lat2 - lat1) * to_rad;
    let dlon = (lon2 - lon1) * to_rad;
    let a = (dlat * 0.5).sin().powi(2)
        + (lat1 * to_rad).cos() * (lat2 * to_rad).cos() * (dlon * 0.5).sin().powi(2);
    2.0 * EARTH_R_M * a.sqrt().asin()
}

#[derive(PartialEq)]
#[cfg(test)]
struct HeapNode { f: f32, g_time: f32, g_len: f32, node: u32 }

#[cfg(test)]
impl Eq for HeapNode {}
#[cfg(test)]
impl Ord for HeapNode {
    // Min-heap on f (via reverse).
    fn cmp(&self, other: &Self) -> Ordering {
        other.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal)
    }
}
#[cfg(test)]
impl PartialOrd for HeapNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}

/// Single-tile weighted A*. Returns (time_s, len_m, settled_count) on success;
/// `time_s` is set to NaN to signal no path.
///
/// Settled cap controls runaway searches inside a tile (worst case nLocal,
/// but bounded for predictable Worker CPU usage).
#[cfg(test)]
fn astar_intra_tile(tile: &TileView, src: u32, dst: u32, settled_cap: u32)
    -> (f32, f32, u32)
{
    if src >= tile.n_local || dst >= tile.n_local {
        return (f32::NAN, f32::NAN, 0);
    }
    if src == dst {
        return (0.0, 0.0, 0);
    }

    let n = tile.n_local as usize;
    let mut g = vec![f32::INFINITY; n];
    let mut settled = vec![false; n];
    g[src as usize] = 0.0;

    let dst_lat = tile.lat(dst);
    let dst_lon = tile.lon(dst);

    let mut heap = BinaryHeap::<HeapNode>::new();
    let h0 = ASTAR_WEIGHT_K * haversine_m(tile.lat(src), tile.lon(src), dst_lat, dst_lon)
        / MAX_SPEED_M_PER_S;
    heap.push(HeapNode { f: h0, g_time: 0.0, g_len: 0.0, node: src });

    let mut settled_count: u32 = 0;
    while let Some(cur) = heap.pop() {
        let u = cur.node as usize;
        if settled[u] { continue; }
        settled[u] = true;
        settled_count += 1;
        if cur.node == dst {
            return (cur.g_time, cur.g_len, settled_count);
        }
        if settled_count >= settled_cap { break; }

        let (estart, eend) = tile.edge_range(cur.node);
        for e in estart..eend {
            let v = tile.edge_target(e);
            // Skip cross-tile edges in the intra-tile MVP. Cross-tile pointers
            // have the high bit set in extern_packed encoding; intra-tile
            // targets are < n_local. Bound-check defensively.
            if v >= tile.n_local { continue; }
            if settled[v as usize] { continue; }
            let dt = tile.edge_time_s(e);
            let dl = tile.edge_len_m(e);
            let new_g = cur.g_time + dt;
            if new_g < g[v as usize] {
                g[v as usize] = new_g;
                let h = ASTAR_WEIGHT_K
                    * haversine_m(tile.lat(v), tile.lon(v), dst_lat, dst_lon)
                    / MAX_SPEED_M_PER_S;
                heap.push(HeapNode {
                    f: new_g + h,
                    g_time: new_g,
                    g_len: cur.g_len + dl,
                    node: v,
                });
            }
        }
    }
    (f32::NAN, f32::NAN, settled_count)
}


// ---------------------------------------------------------------------------
// Multi-tile A*. Routes across cross-tile edges using the extern arrays.
//
// State key: packed (tile_id, dense) into a u64. Distances tracked in a
// HashMap keyed by that state. Heap entries store the f-score + g-time +
// g-len + state.
// ---------------------------------------------------------------------------

#[inline]
fn pack_state(tile_id: u32, dense: u32) -> u64 {
    ((tile_id as u64) << 32) | (dense as u64)
}

#[derive(PartialEq)]
#[cfg(test)]
struct MultiHeapNode { f: f32, g_time: f32, g_len: f32, state: u64 }

#[cfg(test)]
impl Eq for MultiHeapNode {}
#[cfg(test)]
impl Ord for MultiHeapNode {
    fn cmp(&self, other: &Self) -> Ordering {
        other.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal)
    }
}
#[cfg(test)]
impl PartialOrd for MultiHeapNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}

/// Multi-tile weighted A*. Given a map of tile_id -> TileView and a
/// (src_tile, src_dense) + (dst_tile, dst_dense), expand across cross-tile
/// edges until reaching the destination or hitting `settled_cap`.
///
/// If the search visits a node whose remote tile is not in `tiles`, that edge
/// is skipped. Caller is responsible for loading enough tiles to span the
/// route (typically a corridor between src and dst with some buffer width).
#[cfg(test)]
fn astar_multi_tile(
    tiles: &HashMap<u32, TileView<'_>>,
    src_tile: u32,
    src_dense: u32,
    dst_tile: u32,
    dst_dense: u32,
    settled_cap: u32,
) -> (f32, f32, u32) {
    let src_state = pack_state(src_tile, src_dense);
    let dst_state = pack_state(dst_tile, dst_dense);

    if src_state == dst_state {
        return (0.0, 0.0, 0);
    }

    // Need at least the src tile loaded.
    let Some(src_t) = tiles.get(&src_tile) else { return (f32::NAN, f32::NAN, 0); };
    if src_dense >= src_t.n_local {
        return (f32::NAN, f32::NAN, 0);
    }
    // Destination lat/lon for the heuristic. If the dst tile isn't loaded we
    // still try a search (we just can't terminate on dst meeting), so caller
    // sees a NaN -- but in practice the caller always supplies the dst tile.
    let (dst_lat, dst_lon) = if let Some(dt) = tiles.get(&dst_tile) {
        if dst_dense >= dt.n_local {
            return (f32::NAN, f32::NAN, 0);
        }
        (dt.lat(dst_dense), dt.lon(dst_dense))
    } else {
        return (f32::NAN, f32::NAN, 0);
    };

    let mut g_time: HashMap<u64, f32> = HashMap::new();
    let mut settled: HashMap<u64, bool> = HashMap::new();
    g_time.insert(src_state, 0.0);

    let mut heap = BinaryHeap::<MultiHeapNode>::new();
    let h0 = ASTAR_WEIGHT_K
        * haversine_m(src_t.lat(src_dense), src_t.lon(src_dense), dst_lat, dst_lon)
        / MAX_SPEED_M_PER_S;
    heap.push(MultiHeapNode { f: h0, g_time: 0.0, g_len: 0.0, state: src_state });

    let mut settled_count: u32 = 0;
    while let Some(cur) = heap.pop() {
        if settled.get(&cur.state).copied().unwrap_or(false) { continue; }
        settled.insert(cur.state, true);
        settled_count += 1;
        if cur.state == dst_state {
            return (cur.g_time, cur.g_len, settled_count);
        }
        if settled_count >= settled_cap { break; }

        let cur_tile_id = (cur.state >> 32) as u32;
        let cur_dense = (cur.state & 0xffff_ffff) as u32;
        let Some(tile) = tiles.get(&cur_tile_id) else { continue; };
        if cur_dense >= tile.n_local { continue; }

        let (estart, eend) = tile.edge_range(cur_dense);
        for e in estart..eend {
            let target = tile.edge_target(e);
            let (nxt_tile_id, nxt_dense) = if target < tile.n_local {
                (cur_tile_id, target)
            } else {
                tile.resolve_extern(target)
            };
            // If the remote tile isn't loaded, we can't follow this edge.
            if !tiles.contains_key(&nxt_tile_id) { continue; }
            let nxt_state = pack_state(nxt_tile_id, nxt_dense);
            if settled.get(&nxt_state).copied().unwrap_or(false) { continue; }

            let dt = tile.edge_time_s(e);
            let dl = tile.edge_len_m(e);
            let new_g = cur.g_time + dt;
            let prev_g = *g_time.get(&nxt_state).unwrap_or(&f32::INFINITY);
            if new_g < prev_g {
                g_time.insert(nxt_state, new_g);
                // Heuristic: need lat/lon of nxt; only available if its tile
                // is loaded (which we already verified above).
                let nxt_tile = &tiles[&nxt_tile_id];
                if nxt_dense >= nxt_tile.n_local { continue; }
                let h = ASTAR_WEIGHT_K
                    * haversine_m(nxt_tile.lat(nxt_dense), nxt_tile.lon(nxt_dense), dst_lat, dst_lon)
                    / MAX_SPEED_M_PER_S;
                heap.push(MultiHeapNode {
                    f: new_g + h,
                    g_time: new_g,
                    g_len: cur.g_len + dl,
                    state: nxt_state,
                });
            }
        }
    }
    (f32::NAN, f32::NAN, settled_count)
}

// ---------------------------------------------------------------------------
// Multi-tile Dijkstra ONE-TO-MANY. The actual hot path for Distance Matrix
// requests (1 origin x N destinations). A single Dijkstra traversal covers
// every destination; we record its (time_s, len_m) when first settled.
// ---------------------------------------------------------------------------

#[derive(PartialEq)]
struct DijkstraHeapNode { g_time: f32, g_len: f32, state: u64 }
impl Eq for DijkstraHeapNode {}
impl Ord for DijkstraHeapNode {
    // Min-heap on g_time (Dijkstra; no heuristic).
    fn cmp(&self, o: &Self) -> Ordering {
        o.g_time.partial_cmp(&self.g_time).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for DijkstraHeapNode {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> { Some(self.cmp(o)) }
}

/// Multi-tile Dijkstra from one source to many destinations. For each (dst_i)
/// we write (time_s_i, len_m_i) into `results` (NaN if never reached within
/// settled_cap). Returns the total settled count.
///
/// Terminates early when all destinations have been reached.
pub fn dijkstra_multi_tile_one_to_many(
    tiles: &HashMap<u32, TileView<'_>>,
    src_tile: u32, src_dense: u32,
    dsts: &[(u32, u32)],
    settled_cap: u32,
    results: &mut [(f32, f32)],
) -> u32 {
    // Initialize all results to NaN.
    for r in results.iter_mut() { *r = (f32::NAN, f32::NAN); }
    if dsts.is_empty() { return 0; }
    let Some(src_t) = tiles.get(&src_tile) else { return 0; };
    if src_dense >= src_t.n_local { return 0; }

    // Targets: map state -> index into results.
    let mut target_idx: HashMap<u64, usize> = HashMap::with_capacity(dsts.len());
    for (i, &(t, d)) in dsts.iter().enumerate() {
        target_idx.insert(pack_state(t, d), i);
    }
    let mut remaining = dsts.len();

    let mut g_time: HashMap<u64, f32> = HashMap::new();
    let mut settled: HashMap<u64, bool> = HashMap::new();
    let src_state = pack_state(src_tile, src_dense);
    g_time.insert(src_state, 0.0);

    let mut heap = BinaryHeap::<DijkstraHeapNode>::new();
    heap.push(DijkstraHeapNode { g_time: 0.0, g_len: 0.0, state: src_state });

    // If src is itself a destination, record (0, 0) and decrement remaining.
    if let Some(&i) = target_idx.get(&src_state) {
        results[i] = (0.0, 0.0);
        remaining = remaining.saturating_sub(1);
    }

    let mut settled_count: u32 = 0;
    while let Some(cur) = heap.pop() {
        if settled.get(&cur.state).copied().unwrap_or(false) { continue; }
        settled.insert(cur.state, true);
        settled_count += 1;

        if let Some(&i) = target_idx.get(&cur.state) {
            if results[i].0.is_nan() {
                results[i] = (cur.g_time, cur.g_len);
                remaining = remaining.saturating_sub(1);
                if remaining == 0 { return settled_count; }
            }
        }
        if settled_count >= settled_cap { break; }

        let cur_tile_id = (cur.state >> 32) as u32;
        let cur_dense = (cur.state & 0xffff_ffff) as u32;
        let Some(tile) = tiles.get(&cur_tile_id) else { continue; };
        if cur_dense >= tile.n_local { continue; }

        let (estart, eend) = tile.edge_range(cur_dense);
        for e in estart..eend {
            let target = tile.edge_target(e);
            let (nxt_tile_id, nxt_dense) = if target < tile.n_local {
                (cur_tile_id, target)
            } else {
                tile.resolve_extern(target)
            };
            if !tiles.contains_key(&nxt_tile_id) { continue; }
            let nxt_state = pack_state(nxt_tile_id, nxt_dense);
            if settled.get(&nxt_state).copied().unwrap_or(false) { continue; }

            let new_g = cur.g_time + tile.edge_time_s(e);
            let prev_g = *g_time.get(&nxt_state).unwrap_or(&f32::INFINITY);
            if new_g < prev_g {
                g_time.insert(nxt_state, new_g);
                heap.push(DijkstraHeapNode {
                    g_time: new_g,
                    g_len: cur.g_len + tile.edge_len_m(e),
                    state: nxt_state,
                });
            }
        }
    }
    settled_count
}

// ---------------------------------------------------------------------------
// One-to-many FFI. Args layout:
//   [0..4]    src_tile_id
//   [4..8]    src_dense
//   [8..12]   settled_cap
//   [12..16]  n_dsts
//   [16..20]  n_tiles
//   [20..]    n_dsts * (dst_tile_id: u32, dst_dense: u32)
//   [...]     n_tiles * (tile_id: u32, byte_off: u32, byte_len: u32)
//   [...]     concatenated tile bytes
// Result buffer must be (n_dsts * 8) bytes; entries are (f32 time_s, f32 len_m).
// Return value = settled count from the Dijkstra run.
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn od_dijkstra_one_to_many(
    args_ptr: *const u8,
    args_len: usize,
    result_ptr: *mut u8,
    result_len: usize,
) -> u32 {
    if args_ptr.is_null() || result_ptr.is_null() || args_len < 20 { return 0; }
    let args = std::slice::from_raw_parts(args_ptr, args_len);
    let src_tile = u32::from_le_bytes(args[0..4].try_into().unwrap());
    let src_dense = u32::from_le_bytes(args[4..8].try_into().unwrap());
    let cap = u32::from_le_bytes(args[8..12].try_into().unwrap());
    let n_dsts = u32::from_le_bytes(args[12..16].try_into().unwrap()) as usize;
    let n_tiles = u32::from_le_bytes(args[16..20].try_into().unwrap()) as usize;
    if result_len < n_dsts * 8 { return 0; }

    let dsts_off = 20;
    let dsts_bytes = n_dsts * 8;
    let tiles_manifest_off = dsts_off + dsts_bytes;
    let tiles_manifest_bytes = n_tiles * 12;
    if tiles_manifest_off + tiles_manifest_bytes > args.len() { return 0; }

    let mut dsts: Vec<(u32, u32)> = Vec::with_capacity(n_dsts);
    for i in 0..n_dsts {
        let off = dsts_off + i * 8;
        let tile_id = u32::from_le_bytes(args[off..off + 4].try_into().unwrap());
        let dense = u32::from_le_bytes(args[off + 4..off + 8].try_into().unwrap());
        dsts.push((tile_id, dense));
    }

    let mut tiles: HashMap<u32, TileView<'_>> = HashMap::with_capacity(n_tiles);
    for i in 0..n_tiles {
        let off = tiles_manifest_off + i * 12;
        let tile_id = u32::from_le_bytes(args[off..off + 4].try_into().unwrap());
        let byte_off = u32::from_le_bytes(args[off + 4..off + 8].try_into().unwrap()) as usize;
        let byte_len = u32::from_le_bytes(args[off + 8..off + 12].try_into().unwrap()) as usize;
        if byte_off + byte_len > args.len() { return 0; }
        if let Some(tv) = TileView::decode(&args[byte_off..byte_off + byte_len]) {
            tiles.insert(tile_id, tv);
        }
    }

    let mut results: Vec<(f32, f32)> = vec![(f32::NAN, f32::NAN); n_dsts];
    let settled = dijkstra_multi_tile_one_to_many(&tiles, src_tile, src_dense, &dsts, cap, &mut results);

    let out = std::slice::from_raw_parts_mut(result_ptr, n_dsts * 8);
    for (i, &(t, l)) in results.iter().enumerate() {
        let o = i * 8;
        out[o..o + 4].copy_from_slice(&t.to_le_bytes());
        out[o + 4..o + 8].copy_from_slice(&l.to_le_bytes());
    }
    settled
}



// ---------------------------------------------------------------------------
// Native-target tests (skipped under wasm32; cargo test runs on the host).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a tiny 3-node tile by hand to exercise the decode + A* path:
    /// 0 -- 100m / 10s --> 1 -- 200m / 20s --> 2
    fn synthetic_tile() -> Vec<u8> {
        let n_local: u32 = 3;
        let n_extern: u32 = 0;
        let m_edges: u32 = 2;
        let mut buf = Vec::<u8>::new();
        buf.extend_from_slice(&MAGIC.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes()); // fmt_ver
        buf.extend_from_slice(&0i32.to_le_bytes()); // tx
        buf.extend_from_slice(&0i32.to_le_bytes()); // ty
        buf.extend_from_slice(&n_local.to_le_bytes());
        buf.extend_from_slice(&n_extern.to_le_bytes());
        buf.extend_from_slice(&m_edges.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());  // grid_n_lon
        buf.extend_from_slice(&1u16.to_le_bytes());  // grid_n_lat
        assert_eq!(buf.len(), 32);
        // localLat / Lon
        for v in [37.0f32, 37.0, 37.0] { buf.extend_from_slice(&v.to_le_bytes()); }
        for v in [-122.0f32, -121.999, -121.998] { buf.extend_from_slice(&v.to_le_bytes()); }
        // (no extern arrays since n_extern = 0)
        // edge_offsets: 3 + 1 = 4 entries
        for v in [0u32, 1, 2, 2] { buf.extend_from_slice(&v.to_le_bytes()); }
        // edge_targets: 2 edges (0->1, 1->2)
        for v in [1u32, 2] { buf.extend_from_slice(&v.to_le_bytes()); }
        // edge_time_s
        for v in [10.0f32, 20.0] { buf.extend_from_slice(&v.to_le_bytes()); }
        // edge_len_m
        for v in [100.0f32, 200.0] { buf.extend_from_slice(&v.to_le_bytes()); }
        // grid_offsets: 1 cell + 1 = 2 entries; all 3 nodes in cell 0
        for v in [0u32, 3] { buf.extend_from_slice(&v.to_le_bytes()); }
        // grid_node_ids: 3 entries
        for v in [0u32, 1, 2] { buf.extend_from_slice(&v.to_le_bytes()); }
        buf
    }

    #[test]
    fn decode_synthetic_tile_header() {
        let buf = synthetic_tile();
        let t = TileView::decode(&buf).expect("decode");
        assert_eq!(t.n_local, 3);
        assert_eq!(t.m_edges, 2);
        assert_eq!(t.tx, 0);
        assert_eq!(t.ty, 0);
        assert!((t.lat(0) - 37.0).abs() < 1e-6);
        assert!((t.lon(2) - (-121.998)).abs() < 1e-4);
    }

    #[test]
    fn astar_traverses_two_edges() {
        let buf = synthetic_tile();
        let t = TileView::decode(&buf).unwrap();
        let (time_s, len_m, settled) = astar_intra_tile(&t, 0, 2, 1000);
        assert!((time_s - 30.0).abs() < 1e-3, "time_s={}", time_s);
        assert!((len_m - 300.0).abs() < 1e-3, "len_m={}", len_m);
        assert!(settled >= 2);
    }

    #[test]
    fn astar_same_node_is_zero() {
        let buf = synthetic_tile();
        let t = TileView::decode(&buf).unwrap();
        let (time_s, len_m, _) = astar_intra_tile(&t, 1, 1, 1000);
        assert_eq!(time_s, 0.0);
        assert_eq!(len_m, 0.0);
    }

    #[test]
    fn astar_unreachable_is_nan() {
        // Edit the synthetic tile to break the 1->2 edge so node 2 is unreachable.
        let mut buf = synthetic_tile();
        // edge_targets starts at: 32 + 3*4*2 (localLat+Lon) + 4*4 (edge_offsets) = 32+24+16 = 72
        // Set the second edge target to OOB so it's skipped.
        let off = 32 + 3 * 4 * 2 + 4 * 4 + 4;
        buf[off..off + 4].copy_from_slice(&999u32.to_le_bytes());
        let t = TileView::decode(&buf).unwrap();
        let (time_s, _, _) = astar_intra_tile(&t, 0, 2, 1000);
        assert!(time_s.is_nan());
    }

    #[test]
    fn bad_magic_fails_decode() {
        let mut buf = synthetic_tile();
        buf[0] = 0;
        assert!(TileView::decode(&buf).is_none());
    }

    /// Two tiles connected via a cross-tile edge:
    ///   Tile A (tx=0, ty=0): nodes 0 -> 1 (local edge, 100m/10s)
    ///                       node 1 -> extern_idx 0 (extern edge, 50m/5s)
    ///   Tile B (tx=1, ty=0): node 0 (the target of the extern edge)
    /// Expected: A* from A.0 to B.0 finds 150 m / 15 s via 0->1->B.0.
    fn cross_tile_pair() -> (Vec<u8>, Vec<u8>) {
        // Tile A: 2 local nodes, 1 extern target, 2 edges.
        let mut a = Vec::<u8>::new();
        a.extend_from_slice(&MAGIC.to_le_bytes());
        a.extend_from_slice(&1u32.to_le_bytes());
        a.extend_from_slice(&0i32.to_le_bytes());
        a.extend_from_slice(&0i32.to_le_bytes());
        a.extend_from_slice(&2u32.to_le_bytes());  // n_local
        a.extend_from_slice(&1u32.to_le_bytes());  // n_extern
        a.extend_from_slice(&2u32.to_le_bytes());  // m_edges
        a.extend_from_slice(&1u16.to_le_bytes());
        a.extend_from_slice(&1u16.to_le_bytes());
        for v in [37.0f32, 37.0] { a.extend_from_slice(&v.to_le_bytes()); }
        for v in [-122.0f32, -121.999] { a.extend_from_slice(&v.to_le_bytes()); }
        // extern_packed[0] = tile id (tx=1, ty=0) packed = (1 << 16) | 0
        a.extend_from_slice(&((1u32 << 16) | 0).to_le_bytes());
        // extern_dense[0] = 0 (node 0 in tile B)
        a.extend_from_slice(&0u32.to_le_bytes());
        // edge_offsets: 3 entries (0, 1, 2)
        for v in [0u32, 1, 2] { a.extend_from_slice(&v.to_le_bytes()); }
        // edge_targets: edge 0 = node 1 (local), edge 1 = n_local + extern_idx = 2 + 0 = 2
        for v in [1u32, 2] { a.extend_from_slice(&v.to_le_bytes()); }
        for v in [10.0f32, 5.0] { a.extend_from_slice(&v.to_le_bytes()); }
        for v in [100.0f32, 50.0] { a.extend_from_slice(&v.to_le_bytes()); }
        // grid_offsets + grid_node_ids (trivial)
        for v in [0u32, 2] { a.extend_from_slice(&v.to_le_bytes()); }
        for v in [0u32, 1] { a.extend_from_slice(&v.to_le_bytes()); }

        // Tile B: 1 node, 0 extern, 0 edges.
        let mut b = Vec::<u8>::new();
        b.extend_from_slice(&MAGIC.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&1i32.to_le_bytes());  // tx=1
        b.extend_from_slice(&0i32.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes());  // n_local
        b.extend_from_slice(&0u32.to_le_bytes());  // n_extern
        b.extend_from_slice(&0u32.to_le_bytes());  // m_edges
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        for v in [37.0f32] { b.extend_from_slice(&v.to_le_bytes()); }
        for v in [-121.998f32] { b.extend_from_slice(&v.to_le_bytes()); }
        // edge_offsets: 2 entries (0, 0)
        for v in [0u32, 0] { b.extend_from_slice(&v.to_le_bytes()); }
        // no edges
        // grid_offsets, grid_node_ids
        for v in [0u32, 1] { b.extend_from_slice(&v.to_le_bytes()); }
        for v in [0u32] { b.extend_from_slice(&v.to_le_bytes()); }
        (a, b)
    }

    #[test]
    fn multi_tile_astar_crosses_boundary() {
        let (a, b) = cross_tile_pair();
        let tv_a = TileView::decode(&a).unwrap();
        let tv_b = TileView::decode(&b).unwrap();
        let mut tiles: HashMap<u32, TileView<'_>> = HashMap::new();
        let id_a = tv_a.packed_id();
        let id_b = tv_b.packed_id();
        tiles.insert(id_a, tv_a);
        tiles.insert(id_b, tv_b);
        let (time_s, len_m, settled) = astar_multi_tile(&tiles, id_a, 0, id_b, 0, 1000);
        assert!((time_s - 15.0).abs() < 1e-3, "time_s={}", time_s);
        assert!((len_m - 150.0).abs() < 1e-3, "len_m={}", len_m);
        assert!(settled >= 2, "settled={}", settled);
    }


    #[test]
    fn multi_tile_missing_remote_returns_nan() {
        // Only load tile A; cross-edge should be skipped, dst unreachable.
        let (a, _b) = cross_tile_pair();
        let tv_a = TileView::decode(&a).unwrap();
        let mut tiles: HashMap<u32, TileView<'_>> = HashMap::new();
        let id_a = tv_a.packed_id();
        tiles.insert(id_a, tv_a);
        let id_b = ((1u32) << 16) | 0;
        let (time_s, _, _) = astar_multi_tile(&tiles, id_a, 0, id_b, 0, 1000);
        assert!(time_s.is_nan());
    }
}
