#!/usr/bin/env python3
"""Per-state OSM PBF -> per-tile binary files.

Strategy (single-pass-per-state, finalize at end):

  pass_1 (per state):
    Stream OSM PBF. For each drivable-graph node, append (osm_id, lat, lon) to a
    per-tile staging file (npz). For each drivable way edge, append
    (u_osm, v_osm, length_m, time_s) to home_tile_u's staging file.
    Memory bounded by per-state node coords (kept in a numpy array, ~ tens of MB).

  finalize:
    For each tile, gather all node entries from every state's staging, dedupe by
    osm_id, sort, assign dense_ids 0..n_local-1. Build the per-tile osm_id->dense
    map. Then resolve edges: a target node whose home_tile == this tile maps to a
    local dense_id; otherwise it's added to an extern table as (target_tile,
    target_dense_in_target_tile). Look up target_dense by also building the other
    tiles' osm_id->dense maps lazily (LRU cache of recently-touched tiles).

For Bay Area validation we run pass_1 on CA only, then finalize. Result should
be equivalent (sum of edges/nodes) to the v1 single-blob graph when clipped to
the Bay Area bbox.
"""
from __future__ import annotations

import argparse
import math
import re
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

from etl.config import (
    DEFAULT_SPEED_KMH, DRIVABLE_HIGHWAY, SPEED_KMH, state_dir, tile_id, tiles_dir,
)
from etl.states import BY_CODE
from etl._tile_io import TileBuild, pack_tile_id, write_tile


def log(msg: str) -> None:
    print(f"[tiles] {msg}", flush=True)


# --------------------------------------------------------------------------
# OSM speed parsing
# --------------------------------------------------------------------------

_MPH = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*mph\s*$", re.I)
_KMH = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:km/?h)?\s*$", re.I)


def parse_maxspeed(value: str | None) -> float | None:
    if not value:
        return None
    m = _MPH.match(value)
    if m: return float(m.group(1)) * 1.60934
    m = _KMH.match(value)
    if m:
        try: return float(m.group(1))
        except ValueError: return None
    return None


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# --------------------------------------------------------------------------
# Pass 1: per-state PBF scan -> per-tile staging
# --------------------------------------------------------------------------

def staging_dir(version: str) -> Path:
    p = tiles_dir(version).parent / "staging"
    p.mkdir(parents=True, exist_ok=True)
    return p


def pass_1_state(state_code: str, version: str) -> None:
    """Stream the state PBF, append to per-tile staging files."""
    import osmium

    state = BY_CODE[state_code]
    sdir = state_dir(state_code)
    pbf = sdir / f"{state.geofabrik}-latest.osm.pbf"
    if not pbf.exists():
        raise FileNotFoundError(f"missing PBF for {state_code}: {pbf}")

    log(f"{state_code}: scanning {pbf.name}")

    class WayHandler(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.way_count = 0
            self.ways: list[tuple[float, bool, list[int]]] = []
            self.needed: set[int] = set()
        def way(self, w):
            hw = w.tags.get("highway")
            if hw not in DRIVABLE_HIGHWAY:
                return
            access = w.tags.get("access")
            if access in ("no", "private"):
                return
            oneway = w.tags.get("oneway", "no") in ("yes", "true", "1")
            ms = parse_maxspeed(w.tags.get("maxspeed"))
            speed = ms if ms else SPEED_KMH.get(hw, DEFAULT_SPEED_KMH)
            refs = [n.ref for n in w.nodes]
            if len(refs) < 2:
                return
            self.ways.append((speed, oneway, refs))
            self.needed.update(refs)
            self.way_count += 1

    wh = WayHandler()
    wh.apply_file(str(pbf), locations=False)
    log(f"{state_code}:   {wh.way_count} drivable ways, {len(wh.needed)} unique node refs")

    class NodeHandler(osmium.SimpleHandler):
        def __init__(self, needed):
            super().__init__()
            self.needed = needed
            self.coords: dict[int, tuple[float, float]] = {}
        def node(self, n):
            if n.id in self.needed and n.location.valid():
                self.coords[n.id] = (n.location.lat, n.location.lon)

    nh = NodeHandler(wh.needed)
    nh.apply_file(str(pbf))
    log(f"{state_code}:   located {len(nh.coords)} / {len(wh.needed)} nodes")
    coords = nh.coords

    # Partition: bucket nodes by their home tile.
    sdir_out = staging_dir(version)
    # Per-tile in-memory accumulators for this state's pass-1.
    tile_nodes: dict[tuple[int, int], list[tuple[int, float, float]]] = {}
    tile_edges: dict[tuple[int, int], list[tuple[int, int, float, float]]] = {}

    for osm_id, (lat, lon) in coords.items():
        tx, ty = tile_id(lon, lat)
        tile_nodes.setdefault((tx, ty), []).append((osm_id, lat, lon))

    # Emit edges; edges live in home_tile_u (the source node's tile).
    for speed_kmh, oneway, refs in wh.ways:
        speed_ms = speed_kmh / 3.6
        prev = None; prev_id = None
        for r in refs:
            if r not in coords:
                prev = None; prev_id = None
                continue
            if prev is not None:
                lat1, lon1 = prev
                lat2, lon2 = coords[r]
                d = haversine_m(lat1, lon1, lat2, lon2)
                if d > 0:
                    t = d / speed_ms
                    tx_u, ty_u = tile_id(lon1, lat1)
                    tile_edges.setdefault((tx_u, ty_u), []).append((prev_id, r, d, t))
                    if not oneway:
                        tx_v, ty_v = tile_id(lon2, lat2)
                        tile_edges.setdefault((tx_v, ty_v), []).append((r, prev_id, d, t))
            prev = coords[r]; prev_id = r

    # Append to per-tile staging files (numpy npz per state per tile).
    log(f"{state_code}:   writing staging for {len(tile_nodes)} tiles")
    for (tx, ty), items in tile_nodes.items():
        items.sort()  # by osm_id; helps dedupe later
        path = sdir_out / f"{tx}_{ty}.nodes.{state_code}.npz"
        np.savez(
            path,
            osm_id=np.array([x[0] for x in items], dtype=np.int64),
            lat=np.array([x[1] for x in items], dtype=np.float64),
            lon=np.array([x[2] for x in items], dtype=np.float64),
        )
    for (tx, ty), items in tile_edges.items():
        path = sdir_out / f"{tx}_{ty}.edges.{state_code}.npz"
        np.savez(
            path,
            u_osm=np.array([x[0] for x in items], dtype=np.int64),
            v_osm=np.array([x[1] for x in items], dtype=np.int64),
            length_m=np.array([x[2] for x in items], dtype=np.float64),
            time_s=np.array([x[3] for x in items], dtype=np.float64),
        )


# --------------------------------------------------------------------------
# Finalize: per-tile bin
# --------------------------------------------------------------------------

def list_tiles(version: str) -> list[tuple[int, int]]:
    sdir = staging_dir(version)
    tiles = set()
    for p in sdir.glob("*.nodes.*.npz"):
        # filename: <tx>_<ty>.nodes.<state>.npz
        stem = p.stem  # <tx>_<ty>.nodes.<state>
        head = stem.split(".nodes.")[0]
        tx, ty = head.split("_")
        tiles.add((int(tx), int(ty)))
    return sorted(tiles)


@lru_cache(maxsize=1024)
def _load_tile_node_map(version: str, tx: int, ty: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (sorted_osm_ids[uint64], lat[f32], lon[f32]) for a tile, deduped."""
    sdir = staging_dir(version)
    osm_parts, lat_parts, lon_parts = [], [], []
    for p in sorted(sdir.glob(f"{tx}_{ty}.nodes.*.npz")):
        d = np.load(p)
        osm_parts.append(d["osm_id"])
        lat_parts.append(d["lat"])
        lon_parts.append(d["lon"])
    if not osm_parts:
        return (np.zeros(0, np.int64), np.zeros(0, np.float32), np.zeros(0, np.float32))
    osm_ids = np.concatenate(osm_parts)
    lats = np.concatenate(lat_parts).astype(np.float32)
    lons = np.concatenate(lon_parts).astype(np.float32)
    # Dedupe by osm_id; keep first lat/lon (should all match).
    order = np.argsort(osm_ids, kind="stable")
    osm_ids = osm_ids[order]
    lats = lats[order]
    lons = lons[order]
    keep = np.empty(len(osm_ids), dtype=bool)
    keep[0] = True
    keep[1:] = osm_ids[1:] != osm_ids[:-1]
    return osm_ids[keep], lats[keep], lons[keep]


def _osm_to_dense(osm_ids_sorted: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Vectorized lookup: dense_ids for each target osm_id via binary search.
    Returns -1 where not found."""
    if len(osm_ids_sorted) == 0:
        return np.full(len(target), -1, dtype=np.int64)
    idx = np.searchsorted(osm_ids_sorted, target)
    in_bounds = idx < len(osm_ids_sorted)
    found = np.zeros(len(target), dtype=bool)
    found[in_bounds] = osm_ids_sorted[idx[in_bounds]] == target[in_bounds]
    out = np.where(found, idx, -1).astype(np.int64)
    return out


def finalize_tile(tx: int, ty: int, version: str) -> tuple[int, int]:
    """Resolve a tile's edges + write its binary. Returns (n_local, m_edges)."""
    osm_local, lat_local, lon_local = _load_tile_node_map(version, tx, ty)
    n_local = len(osm_local)
    if n_local == 0:
        return (0, 0)

    sdir = staging_dir(version)
    u_parts, v_parts, len_parts, time_parts = [], [], [], []
    for p in sorted(sdir.glob(f"{tx}_{ty}.edges.*.npz")):
        d = np.load(p)
        u_parts.append(d["u_osm"])
        v_parts.append(d["v_osm"])
        len_parts.append(d["length_m"])
        time_parts.append(d["time_s"])
    if not u_parts:
        # tile has nodes but no edges -- still emit so snapping works
        u_osm = np.zeros(0, np.int64)
        v_osm = np.zeros(0, np.int64)
        e_len = np.zeros(0, np.float32)
        e_time = np.zeros(0, np.float32)
    else:
        u_osm = np.concatenate(u_parts)
        v_osm = np.concatenate(v_parts)
        e_len = np.concatenate(len_parts).astype(np.float32)
        e_time = np.concatenate(time_parts).astype(np.float32)
        # Dedupe edges across states (same (u,v,len,time) may appear from multiple states)
        key = np.stack([u_osm, v_osm], axis=1)
        # Stable unique by key; keep first occurrence
        order = np.lexsort((v_osm, u_osm))
        u_osm = u_osm[order]; v_osm = v_osm[order]
        e_len = e_len[order]; e_time = e_time[order]
        keep = np.empty(len(u_osm), dtype=bool)
        keep[0] = True
        keep[1:] = (u_osm[1:] != u_osm[:-1]) | (v_osm[1:] != v_osm[:-1])
        u_osm = u_osm[keep]; v_osm = v_osm[keep]
        e_len = e_len[keep]; e_time = e_time[keep]

    m_edges = len(u_osm)

    # Resolve source dense ids (must all be local).
    src_dense = _osm_to_dense(osm_local, u_osm)
    bad_src = src_dense < 0
    if bad_src.any():
        # These edges originate from a node not in this tile -- shouldn't happen
        # given pass-1 partitioned by home_tile_u. Drop them defensively.
        keep_mask = ~bad_src
        u_osm = u_osm[keep_mask]; v_osm = v_osm[keep_mask]
        e_len = e_len[keep_mask]; e_time = e_time[keep_mask]
        src_dense = src_dense[keep_mask]
        m_edges = len(u_osm)

    # Resolve target dense ids: local first, then per-target-tile.
    tgt_dense_local = _osm_to_dense(osm_local, v_osm)
    is_local = tgt_dense_local >= 0
    # For non-local targets, find each one's home tile from its lat/lon.
    # We don't have v's lat/lon at this point in the edge stream, but we have the
    # raw v_osm. The fastest path: load each extern target's tile by trying nearby
    # tiles. To find each non-local target, look it up across the staging tile set.
    # Build a small lookup: for each non-local v_osm, scan neighbouring tiles to
    # find which tile holds it.
    extern_packed_list: list[int] = []
    extern_dense_list: list[int] = []
    extern_idx_for_edge = np.full(m_edges, -1, dtype=np.int64)
    if (~is_local).any():
        nonlocal_idx = np.where(~is_local)[0]
        nonlocal_osm = v_osm[nonlocal_idx]
        # Try 8 neighbouring tiles + self (self already failed).
        neighbours = [(tx + dx, ty + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if not (dx == 0 and dy == 0)]
        # Also expand by 2 in case a way segment spans more than one tile across the boundary.
        for r in (2,):
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    if abs(dx) <= 1 and abs(dy) <= 1:
                        continue
                    neighbours.append((tx + dx, ty + dy))
        # Try to resolve in neighbour order.
        remaining = np.ones(len(nonlocal_osm), dtype=bool)
        extern_lookup: dict[tuple[int, int, int], int] = {}
        for (ntx, nty) in neighbours:
            if not remaining.any():
                break
            try:
                nbr_osm, _nbr_lat, _nbr_lon = _load_tile_node_map(version, ntx, nty)
            except Exception:
                continue
            if len(nbr_osm) == 0:
                continue
            targets = nonlocal_osm[remaining]
            dense = _osm_to_dense(nbr_osm, targets)
            hit_mask = dense >= 0
            if not hit_mask.any():
                continue
            # Map hits back into the nonlocal_idx space.
            local_positions = np.where(remaining)[0][hit_mask]
            packed_tile = pack_tile_id(ntx, nty)
            for li, d in zip(local_positions, dense[hit_mask]):
                key = (packed_tile, int(d))
                ei = extern_lookup.get(key)
                if ei is None:
                    ei = len(extern_packed_list)
                    extern_lookup[key] = ei
                    extern_packed_list.append(packed_tile)
                    extern_dense_list.append(int(d))
                extern_idx_for_edge[nonlocal_idx[li]] = ei
            remaining_idx = np.where(remaining)[0]
            remaining[remaining_idx[hit_mask]] = False
        # Drop edges whose extern target couldn't be resolved (out-of-coverage).
        unresolved = (~is_local) & (extern_idx_for_edge < 0)
        if unresolved.any():
            keep_mask = ~unresolved
            u_osm = u_osm[keep_mask]; v_osm = v_osm[keep_mask]
            e_len = e_len[keep_mask]; e_time = e_time[keep_mask]
            src_dense = src_dense[keep_mask]
            tgt_dense_local = tgt_dense_local[keep_mask]
            is_local = is_local[keep_mask]
            extern_idx_for_edge = extern_idx_for_edge[keep_mask]
            m_edges = len(u_osm)

    # Build final target indices.
    edge_targets = np.where(
        is_local,
        tgt_dense_local,
        n_local + extern_idx_for_edge,
    ).astype(np.uint32)

    # Build CSR by source.
    order = np.argsort(src_dense, kind="stable")
    edge_targets = edge_targets[order]
    edge_time = e_time[order]
    edge_len = e_len[order]
    src_sorted = src_dense[order]
    deg = np.bincount(src_sorted, minlength=n_local).astype(np.uint32)
    edge_offsets = np.zeros(n_local + 1, dtype=np.uint32)
    np.cumsum(deg, out=edge_offsets[1:])

    extern_packed = np.array(extern_packed_list, dtype=np.uint32)
    extern_dense = np.array(extern_dense_list, dtype=np.uint32)

    out_path = tiles_dir(version) / f"{tx}_{ty}.bin"
    write_tile(out_path, TileBuild(
        tx=tx, ty=ty,
        local_lat=lat_local, local_lon=lon_local,
        extern_packed=extern_packed,
        extern_dense=extern_dense,
        edge_offsets=edge_offsets,
        edge_targets=edge_targets,
        edge_time_s=edge_time.astype(np.float32),
        edge_len_m=edge_len.astype(np.float32),
    ))
    return (n_local, m_edges)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--skip-partition", action="store_true",
                    help="Skip pass_1 (use existing staging); only run finalize.")
    ap.add_argument("states", nargs="*")
    args = ap.parse_args(argv)

    if not args.skip_partition:
        if not args.states:
            log("no states given; nothing to partition")
            return 1
        for code in args.states:
            if code not in BY_CODE:
                log(f"unknown state {code!r}; skipping")
                continue
            pass_1_state(code, args.version)

    tiles = list_tiles(args.version)
    log(f"finalize: {len(tiles)} tiles")
    total_nodes = 0
    total_edges = 0
    written = 0
    for i, (tx, ty) in enumerate(tiles):
        n, m = finalize_tile(tx, ty, args.version)
        total_nodes += n
        total_edges += m
        if n > 0:
            written += 1
        if (i + 1) % 100 == 0 or (i + 1) == len(tiles):
            log(f"  {i+1}/{len(tiles)}  nodes={total_nodes:,}  edges={total_edges:,}  written={written}")
    log(f"done: {written} tiles, {total_nodes:,} nodes, {total_edges:,} edges")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
