#!/usr/bin/env python3
"""Build a CSR road graph binary from OSM PBF for the configured bbox.

Output layout matches src/graph.ts decodeGraph.
"""
from __future__ import annotations

import math
import re
import struct
import sys
import subprocess
import urllib.request
from pathlib import Path

import numpy as np

from config import (
    BBOX, BBOX_PBF, DATA, DEFAULT_SPEED_KMH, GRAPH_BIN, GRID_CELL_DEG,
    NORCAL_PBF, NORCAL_PBF_URL, SPEED_KMH, VERSION,
)

MAGIC = b"HHGR"


def log(msg: str) -> None:
    print(f"[build_graph] {msg}", flush=True)


def download_pbf() -> None:
    if NORCAL_PBF.exists() and NORCAL_PBF.stat().st_size > 50_000_000:
        log(f"PBF exists: {NORCAL_PBF} ({NORCAL_PBF.stat().st_size/1e6:.0f} MB)")
        return
    log(f"downloading {NORCAL_PBF_URL}")
    NORCAL_PBF.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(NORCAL_PBF_URL, NORCAL_PBF)
    log(f"got {NORCAL_PBF} ({NORCAL_PBF.stat().st_size/1e6:.0f} MB)")


def clip_bbox() -> None:
    if BBOX_PBF.exists() and BBOX_PBF.stat().st_size > 1_000_000:
        log(f"clipped PBF exists: {BBOX_PBF} ({BBOX_PBF.stat().st_size/1e6:.0f} MB)")
        return
    bbox = ",".join(str(c) for c in BBOX)
    log(f"clipping to bbox {bbox}")
    subprocess.run(
        ["osmium", "extract", "-b", bbox, str(NORCAL_PBF), "-o", str(BBOX_PBF), "--overwrite"],
        check=True,
    )
    log(f"clipped -> {BBOX_PBF} ({BBOX_PBF.stat().st_size/1e6:.0f} MB)")


DRIVABLE = {
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "unclassified", "residential", "living_street",
    "service", "road",
}


_MPH_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*mph\s*$", re.I)
_KMH_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:km/?h)?\s*$", re.I)


def parse_maxspeed(value: str | None) -> float | None:
    if not value:
        return None
    m = _MPH_RE.match(value)
    if m:
        return float(m.group(1)) * 1.60934
    m = _KMH_RE.match(value)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            return None
    return None


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def collect_ways():
    """Single PBF pass: collect drivable way refs, then second pass for node locations."""
    import osmium
    log("scanning ways...")

    class WayHandler(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.ways = []  # list of (highway, oneway, speed_kmh, [node_ids])
            self.needed = set()
        def way(self, w):
            tags = w.tags
            hw = tags.get("highway")
            if hw not in DRIVABLE:
                return
            access = tags.get("access")
            if access in ("no", "private"):
                return
            oneway_tag = tags.get("oneway", "no")
            oneway = oneway_tag in ("yes", "true", "1")
            ms = parse_maxspeed(tags.get("maxspeed"))
            speed = ms if ms else SPEED_KMH.get(hw, DEFAULT_SPEED_KMH)
            refs = [n.ref for n in w.nodes]
            if len(refs) < 2:
                return
            self.ways.append((hw, oneway, speed, refs))
            self.needed.update(refs)

    wh = WayHandler()
    wh.apply_file(str(BBOX_PBF), locations=False)
    log(f"  {len(wh.ways)} drivable ways, {len(wh.needed)} unique node refs")

    class NodeHandler(osmium.SimpleHandler):
        def __init__(self, needed):
            super().__init__()
            self.needed = needed
            self.coords = {}  # osm_id -> (lat, lon)
        def node(self, n):
            if n.id in self.needed:
                loc = n.location
                if loc.valid():
                    self.coords[n.id] = (loc.lat, loc.lon)

    nh = NodeHandler(wh.needed)
    nh.apply_file(str(BBOX_PBF))
    log(f"  located {len(nh.coords)} / {len(wh.needed)} nodes")
    return wh.ways, nh.coords


def build_csr():
    ways, coords = collect_ways()

    # Reindex used nodes only.
    used = set()
    for _, _, _, refs in ways:
        for r in refs:
            if r in coords:
                used.add(r)
    used_list = sorted(used)
    osm_to_dense = {osm_id: i for i, osm_id in enumerate(used_list)}
    N = len(used_list)
    log(f"N (nodes) = {N}")

    # First pass: count edges per node.
    deg = np.zeros(N, dtype=np.uint32)
    edge_buf = []  # (u_dense, v_dense, len_m, time_s)
    for hw, oneway, speed_kmh, refs in ways:
        speed_ms = speed_kmh / 3.6
        prev = None
        prev_id = None
        for r in refs:
            if r not in coords:
                # break the way at missing nodes
                prev = None
                prev_id = None
                continue
            if prev is not None:
                lat1, lon1 = prev
                lat2, lon2 = coords[r]
                d = haversine_m(lat1, lon1, lat2, lon2)
                if d <= 0:
                    prev = (lat2, lon2)
                    prev_id = r
                    continue
                t = d / speed_ms
                u = osm_to_dense[prev_id]
                v = osm_to_dense[r]
                edge_buf.append((u, v, d, t))
                deg[u] += 1
                if not oneway:
                    edge_buf.append((v, u, d, t))
                    deg[v] += 1
            prev = coords[r]
            prev_id = r

    M = len(edge_buf)
    log(f"M (edges) = {M}")

    node_offsets = np.zeros(N + 1, dtype=np.uint32)
    np.cumsum(deg, out=node_offsets[1:])

    edge_targets = np.zeros(M, dtype=np.uint32)
    edge_len_m = np.zeros(M, dtype=np.float32)
    edge_time_s = np.zeros(M, dtype=np.float32)

    cursor = node_offsets[:-1].copy()
    for u, v, d, t in edge_buf:
        idx = cursor[u]
        edge_targets[idx] = v
        edge_len_m[idx] = d
        edge_time_s[idx] = t
        cursor[u] = idx + 1

    lat = np.zeros(N, dtype=np.float32)
    lon = np.zeros(N, dtype=np.float32)
    for osm_id, dense in osm_to_dense.items():
        la, lo = coords[osm_id]
        lat[dense] = la
        lon[dense] = lo

    return N, M, node_offsets, edge_targets, edge_time_s, edge_len_m, lat, lon


def build_grid(lat, lon, N):
    min_lat = float(BBOX[1])
    min_lon = float(BBOX[0])
    cell = GRID_CELL_DEG
    n_lat = int(math.ceil((BBOX[3] - BBOX[1]) / cell)) + 1
    n_lon = int(math.ceil((BBOX[2] - BBOX[0]) / cell)) + 1
    total = n_lat * n_lon
    log(f"grid: {n_lat} x {n_lon} = {total} cells")

    cell_ix = np.zeros(N, dtype=np.uint32)
    for i in range(N):
        cy = int((lat[i] - min_lat) / cell)
        cx = int((lon[i] - min_lon) / cell)
        cy = max(0, min(n_lat - 1, cy))
        cx = max(0, min(n_lon - 1, cx))
        cell_ix[i] = cy * n_lon + cx

    counts = np.bincount(cell_ix, minlength=total).astype(np.uint32)
    grid_offsets = np.zeros(total + 1, dtype=np.uint32)
    np.cumsum(counts, out=grid_offsets[1:])

    order = np.argsort(cell_ix, kind="stable").astype(np.uint32)
    grid_node_ids = order
    return min_lat, min_lon, n_lat, n_lon, cell, grid_offsets, grid_node_ids


def write_binary(N, M, node_offsets, edge_targets, edge_time_s, edge_len_m,
                 lat, lon, min_lat, min_lon, n_lat, n_lon, cell,
                 grid_offsets, grid_node_ids):
    version_tag = 1
    grid_min_lat_e7 = int(round(min_lat * 1e7))
    grid_min_lon_e7 = int(round(min_lon * 1e7))
    cell_size_e5 = int(round(cell * 1e5))
    grid_total = n_lat * n_lon

    header = struct.pack(
        "<4sIIIiiIIIII",
        MAGIC, version_tag, N, M,
        grid_min_lat_e7, grid_min_lon_e7,
        n_lat, n_lon,
        cell_size_e5, grid_total, 0,
    )

    log(f"writing {GRAPH_BIN}")
    with open(GRAPH_BIN, "wb") as f:
        f.write(header)
        f.write(node_offsets.tobytes())
        f.write(edge_targets.tobytes())
        f.write(edge_time_s.tobytes())
        f.write(edge_len_m.tobytes())
        f.write(lat.tobytes())
        f.write(lon.tobytes())
        f.write(grid_offsets.tobytes())
        f.write(grid_node_ids.tobytes())
    size = GRAPH_BIN.stat().st_size
    log(f"done: {GRAPH_BIN} ({size/1e6:.1f} MB)")


def main():
    download_pbf()
    clip_bbox()
    N, M, no_, et, ets, elm, lat, lon = build_csr()
    min_lat, min_lon, n_lat, n_lon, cell, go_, gn_ = build_grid(lat, lon, N)
    write_binary(N, M, no_, et, ets, elm, lat, lon,
                 min_lat, min_lon, n_lat, n_lon, cell, go_, gn_)


if __name__ == "__main__":
    main()
