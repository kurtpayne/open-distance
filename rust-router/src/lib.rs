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
//! Format mirrors src/v2/tiles.ts exactly. The Rust + TypeScript decoders MUST
//! stay in lockstep; the binaries on R2 are the contract.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

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
// Tile format. Header constants must match etl/v2/_tile_io.py and src/v2/tiles.ts.
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
    // grid + extern offsets exist in the format but aren't needed for the
    // intra-tile router; we skip computing them.
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
        let off_local_lat = p;       p += nl * 4;
        let off_local_lon = p;       p += nl * 4;
        let _off_extern_packed = p;  p += ne * 4;
        let _off_extern_dense = p;   p += ne * 4;
        let off_edge_offsets = p;    p += (nl + 1) * 4;
        let off_edge_targets = p;    p += me * 4;
        let off_edge_time_s = p;     p += me * 4;
        let off_edge_len_m = p;      p += me * 4;
        // grid arrays follow but we don't need them for the routing core.

        if p > bytes.len() {
            return None;
        }

        Some(TileView {
            tx, ty, n_local, n_extern, m_edges, grid_n_lon, grid_n_lat,
            bytes,
            off_local_lat, off_local_lon,
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
}

// ---------------------------------------------------------------------------
// A* core. Weighted heuristic: h(n) = k * haversine(n, dst) / max_road_speed.
// max_road_speed = 30 m/s, weight k = 1.5 (matches TS implementation).
// ---------------------------------------------------------------------------

const MAX_SPEED_M_PER_S: f32 = 30.0;
const ASTAR_WEIGHT_K: f32 = 1.5;
const EARTH_R_M: f32 = 6_371_000.0;

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
struct HeapNode { f: f32, g_time: f32, g_len: f32, node: u32 }

impl Eq for HeapNode {}
impl Ord for HeapNode {
    // Min-heap on f (via reverse).
    fn cmp(&self, other: &Self) -> Ordering {
        other.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for HeapNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}

/// Single-tile weighted A*. Returns (time_s, len_m, settled_count) on success;
/// `time_s` is set to NaN to signal no path.
///
/// Settled cap controls runaway searches inside a tile (worst case nLocal,
/// but bounded for predictable Worker CPU usage).
pub fn astar_intra_tile(tile: &TileView, src: u32, dst: u32, settled_cap: u32)
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
// WASM-exposed entry point. ABI:
//   Input layout in linear memory (caller-supplied buffer at `args_ptr`):
//     [0..4]    src_dense  (u32 LE)
//     [4..8]    dst_dense  (u32 LE)
//     [8..12]   settled_cap (u32 LE)
//     [12..16]  tile_byte_len (u32 LE)
//     [16..]    tile bytes
//   Output written into the caller-supplied buffer at `result_ptr` (12 bytes):
//     [0..4]    time_s  (f32 LE, NaN on failure)
//     [4..8]    len_m   (f32 LE, NaN on failure)
//     [8..12]   settled_count (u32 LE)
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn od_astar_intra_tile(
    args_ptr: *const u8,
    args_len: usize,
    result_ptr: *mut u8,
) -> u32 {
    if args_ptr.is_null() || result_ptr.is_null() || args_len < 16 {
        return 0;
    }
    let args = std::slice::from_raw_parts(args_ptr, args_len);
    let src = u32::from_le_bytes(args[0..4].try_into().unwrap());
    let dst = u32::from_le_bytes(args[4..8].try_into().unwrap());
    let cap = u32::from_le_bytes(args[8..12].try_into().unwrap());
    let tlen = u32::from_le_bytes(args[12..16].try_into().unwrap()) as usize;
    if 16 + tlen > args_len { return 0; }
    let tile_bytes = &args[16..16 + tlen];
    let Some(tile) = TileView::decode(tile_bytes) else { return 0; };

    let (time_s, len_m, settled) = astar_intra_tile(&tile, src, dst, cap);
    let out = std::slice::from_raw_parts_mut(result_ptr, 12);
    out[0..4].copy_from_slice(&time_s.to_le_bytes());
    out[4..8].copy_from_slice(&len_m.to_le_bytes());
    out[8..12].copy_from_slice(&(settled as u32).to_le_bytes());
    1
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
}
