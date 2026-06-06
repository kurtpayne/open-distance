#!/usr/bin/env python3
"""Build the national L1 highway overlay graph.

L1 = motorway / trunk / primary edges only. A single global CSR binary:
~1-3M nodes, ~3-6M edges nationally (~100-200 MB uncompressed).

Strategy mirrors build_tiles.py partition pass but flat (no tiling):
  1. Per-state PBF scan: collect drivable HIGHWAY-class ways and their node refs.
  2. Second per-state pass: locate node coords for refs.
  3. After all states: dedupe nodes globally by OSM id, assign dense ids.
  4. Emit edges with dense ids, plus a spatial snap-grid index.

Used by the Worker for long-route routing (>= 200 mi straight line):
endpoints snap to nearest L1 node, A* runs over the much smaller L1 graph.

Binary layout (little-endian):
  magic[4]  = "HHL1"
  u32 fmt_ver
  u32 n_nodes
  u32 m_edges
  i32 grid_min_lat_e7, grid_min_lon_e7
  u32 grid_n_lat, grid_n_lon
  u32 cell_size_e5
  u32 reserved
  f32 lat[n_nodes]
  f32 lon[n_nodes]
  u32 edge_offsets[n_nodes + 1]
  u32 edge_targets[m_edges]
  f32 edge_time_s[m_edges]
  f32 edge_len_m[m_edges]
  u32 grid_offsets[grid_n_lat*grid_n_lon + 1]
  u32 grid_node_ids[n_nodes]
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
from pathlib import Path

import numpy as np

from etl.v2.config import (
    DEFAULT_SPEED_KMH, L1_HIGHWAY, SPEED_KMH, state_dir,
)
from etl.v2.states import BY_CODE


MAGIC = b"HHL1"
FMT_VER = 1
GRID_CELL_DEG = 0.1


def log(msg: str) -> None:
    print(f"[overlay] {msg}", flush=True)


def parse_maxspeed(value):
    if not value: return None
    import re
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*mph\s*$", value, re.I)
    if m: return float(m.group(1)) * 1.60934
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(?:km/?h)?\s*$", value, re.I)
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


def scan_state(state_code: str, ways_out, node_coords_out):
    """Add this state's L1 ways + node coords into the shared accumulators."""
    import osmium
    state = BY_CODE[state_code]
    pbf = state_dir(state_code) / f"{state.geofabrik}-latest.osm.pbf"
    if not pbf.exists():
        log(f"  {state_code}: PBF missing -- skip")
        return

    class WayH(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.ways = []
            self.needed = set()
        def way(self, w):
            tags = w.tags
            hw = tags.get("highway")
            if hw not in L1_HIGHWAY:
                return
            if tags.get("access") in ("no", "private"):
                return
            oneway = tags.get("oneway", "no") in ("yes", "true", "1")
            ms = parse_maxspeed(tags.get("maxspeed"))
            speed = ms if ms else SPEED_KMH.get(hw, DEFAULT_SPEED_KMH)
            refs = [n.ref for n in w.nodes]
            if len(refs) < 2:
                return
            self.ways.append((speed, oneway, refs))
            self.needed.update(refs)
    wh = WayH()
    wh.apply_file(str(pbf), locations=False)

    class NodeH(osmium.SimpleHandler):
        def __init__(self, needed, coords):
            super().__init__()
            self.needed = needed
            self.coords = coords  # shared dict; only sets if not already present
        def node(self, n):
            if n.id in self.needed and n.location.valid():
                if n.id not in self.coords:
                    self.coords[n.id] = (n.location.lat, n.location.lon)
    nh = NodeH(wh.needed, node_coords_out)
    nh.apply_file(str(pbf))

    ways_out.extend(wh.ways)
    log(f"  {state_code}: {len(wh.ways):,} L1 ways, {len(nh.coords) - (len(node_coords_out) - sum(1 for k in nh.coords if k not in wh.needed))} new node coords (total now {len(node_coords_out):,})")


def build_grid(lat, lon, n_nodes, bbox):
    min_lon, min_lat, max_lon, max_lat = bbox
    n_lat = int(math.ceil((max_lat - min_lat) / GRID_CELL_DEG)) + 1
    n_lon = int(math.ceil((max_lon - min_lon) / GRID_CELL_DEG)) + 1
    total = n_lat * n_lon
    log(f"grid: {n_lat} x {n_lon} = {total} cells")

    cell_ix = np.zeros(n_nodes, dtype=np.uint32)
    for i in range(n_nodes):
        cy = int((lat[i] - min_lat) / GRID_CELL_DEG)
        cx = int((lon[i] - min_lon) / GRID_CELL_DEG)
        cy = max(0, min(n_lat - 1, cy))
        cx = max(0, min(n_lon - 1, cx))
        cell_ix[i] = cy * n_lon + cx
    counts = np.bincount(cell_ix, minlength=total).astype(np.uint32)
    offsets = np.zeros(total + 1, dtype=np.uint32)
    np.cumsum(counts, out=offsets[1:])
    order = np.argsort(cell_ix, kind="stable").astype(np.uint32)
    return min_lat, min_lon, n_lat, n_lon, offsets, order


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("states", nargs="*", help="Default: all US-48+DC")
    args = ap.parse_args(argv)

    from etl.v2.config import DATA
    out_path = DATA / "out" / args.version / "l1-overlay.bin"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    states = args.states if args.states else sorted(BY_CODE)
    log(f"scanning {len(states)} states for L1 (motorway/trunk/primary) edges")

    all_ways = []          # list of (speed_kmh, oneway, [osm_node_refs])
    node_coords = {}       # osm_id -> (lat, lon), deduped across states
    for st in states:
        scan_state(st, all_ways, node_coords)
    log(f"total: {len(all_ways):,} ways, {len(node_coords):,} nodes")

    # Dedup + dense ids.
    used = set()
    for _, _, refs in all_ways:
        for r in refs:
            if r in node_coords:
                used.add(r)
    sorted_osm = sorted(used)
    osm_to_dense = {osm: i for i, osm in enumerate(sorted_osm)}
    N = len(sorted_osm)
    log(f"dense N = {N:,}")

    # Build edges.
    edge_records = []  # (u_dense, v_dense, len_m, time_s)
    for speed_kmh, oneway, refs in all_ways:
        speed_ms = speed_kmh / 3.6
        prev = None; prev_id = None
        for r in refs:
            if r not in node_coords:
                prev = None; prev_id = None
                continue
            if prev is not None:
                la1, lo1 = prev
                la2, lo2 = node_coords[r]
                d = haversine_m(la1, lo1, la2, lo2)
                if d > 0:
                    t = d / speed_ms
                    u = osm_to_dense[prev_id]; v = osm_to_dense[r]
                    edge_records.append((u, v, d, t))
                    if not oneway:
                        edge_records.append((v, u, d, t))
            prev = node_coords[r]; prev_id = r
    M = len(edge_records)
    log(f"M = {M:,} directed edges")

    # CSR.
    deg = np.zeros(N, dtype=np.uint32)
    for u, _, _, _ in edge_records:
        deg[u] += 1
    edge_offsets = np.zeros(N + 1, dtype=np.uint32)
    np.cumsum(deg, out=edge_offsets[1:])

    edge_targets = np.zeros(M, dtype=np.uint32)
    edge_len_m = np.zeros(M, dtype=np.float32)
    edge_time_s = np.zeros(M, dtype=np.float32)
    cursor = edge_offsets[:-1].copy()
    for u, v, d, t in edge_records:
        idx = cursor[u]
        edge_targets[idx] = v
        edge_len_m[idx] = d
        edge_time_s[idx] = t
        cursor[u] = idx + 1

    # Node coord arrays.
    lat = np.zeros(N, dtype=np.float32)
    lon = np.zeros(N, dtype=np.float32)
    for osm_id, dense in osm_to_dense.items():
        la, lo = node_coords[osm_id]
        lat[dense] = la
        lon[dense] = lo

    # Spatial bounds (US-48 + DC bbox).
    bbox = (
        float(lon.min()) - 0.01,
        float(lat.min()) - 0.01,
        float(lon.max()) + 0.01,
        float(lat.max()) + 0.01,
    )
    min_lat, min_lon, n_lat, n_lon, grid_offsets, grid_node_ids = build_grid(lat, lon, N, bbox)

    # Write binary.
    log(f"writing {out_path}")
    header = struct.pack(
        "<4sIII iiIII I",
        MAGIC, FMT_VER, N, M,
        int(round(min_lat * 1e7)),
        int(round(min_lon * 1e7)),
        n_lat, n_lon,
        int(round(GRID_CELL_DEG * 1e5)),
        0,
    )
    with open(out_path, "wb") as f:
        f.write(header)
        f.write(lat.tobytes())
        f.write(lon.tobytes())
        f.write(edge_offsets.tobytes())
        f.write(edge_targets.tobytes())
        f.write(edge_time_s.tobytes())
        f.write(edge_len_m.tobytes())
        f.write(grid_offsets.tobytes())
        f.write(grid_node_ids.tobytes())
    log(f"done: {out_path} ({out_path.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
