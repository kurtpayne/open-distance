"""Shared tile binary I/O for v2.

Per-tile binary layout (little-endian):

  Header (40 bytes):
    magic[4]     = b"HHT0"
    fmt_ver      u32   (== TILE_FORMAT_VERSION)
    tx, ty       i32 i32
    n_local      u32
    n_extern     u32
    m_edges      u32
    grid_n_lon   u16
    grid_n_lat   u16

  Node tables:
    local_lat[n_local]   f32
    local_lon[n_local]   f32

  Extern node refs (8 bytes each):
    tile_id_packed[n_extern]  u32  (tx in high 16 bits as int16, ty in low 16 as int16)
    target_dense[n_extern]    u32  (dense node id within the target tile)

  Edges (CSR, originating from local nodes only):
    edge_offsets[n_local + 1]  u32  (cumulative; edge_offsets[i+1]-edge_offsets[i] = degree of node i)
    edge_targets[m_edges]      u32  (0..n_local-1 = local idx; n_local..n_local+n_extern-1 = extern table idx)
    edge_time_s[m_edges]       f32
    edge_len_m[m_edges]        f32

  Spatial snap grid (local only):
    grid_offsets[grid_n_lon*grid_n_lat + 1]  u32
    grid_node_ids[n_local]                   u32

The grid covers the tile's bbox exactly (CELL_DEG x CELL_DEG); sub-cell size is
derived so grid_n_lon * sub_cell = CELL_DEG.
"""
from __future__ import annotations

import struct
from pathlib import Path
from typing import NamedTuple

import numpy as np

from etl.config import CELL_DEG, TILE_FORMAT_VERSION, tile_bbox


MAGIC = b"HHT0"
HEADER_FMT = "<4sIii III HH"
HEADER_SIZE = struct.calcsize(HEADER_FMT)
# = 4 + 4 + 4 + 4 + 4 + 4 + 4 + 2 + 2 = 32 bytes
assert HEADER_SIZE == 32, HEADER_SIZE


def pack_tile_id(tx: int, ty: int) -> int:
    """Pack (tx, ty) as i16/i16 into a u32 for compact storage."""
    return ((tx & 0xFFFF) << 16) | (ty & 0xFFFF)


def unpack_tile_id(packed: int) -> tuple[int, int]:
    tx = (packed >> 16) & 0xFFFF
    ty = packed & 0xFFFF
    # interpret as signed 16-bit
    if tx >= 0x8000: tx -= 0x10000
    if ty >= 0x8000: ty -= 0x10000
    return tx, ty


class TileBuild(NamedTuple):
    tx: int
    ty: int
    local_lat: np.ndarray    # f32[n_local]
    local_lon: np.ndarray    # f32[n_local]
    extern_packed: np.ndarray  # u32[n_extern]
    extern_dense: np.ndarray   # u32[n_extern]
    edge_offsets: np.ndarray   # u32[n_local + 1]
    edge_targets: np.ndarray   # u32[m_edges]
    edge_time_s: np.ndarray    # f32[m_edges]
    edge_len_m: np.ndarray     # f32[m_edges]


def build_snap_grid(
    lat: np.ndarray, lon: np.ndarray, tx: int, ty: int,
    sub_cells: int = 25,
) -> tuple[np.ndarray, np.ndarray, int]:
    """Bin local nodes into a grid_n x grid_n subgrid over the tile's bbox.

    Returns (grid_offsets, grid_node_ids, grid_n).
    """
    lon_min, lat_min, _, _ = tile_bbox(tx, ty)
    cell_size = CELL_DEG / sub_cells
    n = sub_cells
    # cy/cx in [0, n-1]
    cy = np.clip(((lat - lat_min) / cell_size).astype(np.int64), 0, n - 1)
    cx = np.clip(((lon - lon_min) / cell_size).astype(np.int64), 0, n - 1)
    cell = cy * n + cx
    total = n * n
    counts = np.bincount(cell, minlength=total).astype(np.uint32)
    offsets = np.zeros(total + 1, dtype=np.uint32)
    np.cumsum(counts, out=offsets[1:])
    order = np.argsort(cell, kind="stable").astype(np.uint32)
    return offsets, order, n


def write_tile(path: Path, t: TileBuild) -> None:
    n_local = len(t.local_lat)
    n_extern = len(t.extern_packed)
    m_edges = len(t.edge_targets)
    grid_offsets, grid_node_ids, sub_n = build_snap_grid(t.local_lat, t.local_lon, t.tx, t.ty)

    with open(path, "wb") as f:
        f.write(struct.pack(
            HEADER_FMT, MAGIC, TILE_FORMAT_VERSION, t.tx, t.ty,
            n_local, n_extern, m_edges, sub_n, sub_n,
        ))
        f.write(t.local_lat.astype(np.float32, copy=False).tobytes())
        f.write(t.local_lon.astype(np.float32, copy=False).tobytes())
        f.write(t.extern_packed.astype(np.uint32, copy=False).tobytes())
        f.write(t.extern_dense.astype(np.uint32, copy=False).tobytes())
        f.write(t.edge_offsets.astype(np.uint32, copy=False).tobytes())
        f.write(t.edge_targets.astype(np.uint32, copy=False).tobytes())
        f.write(t.edge_time_s.astype(np.float32, copy=False).tobytes())
        f.write(t.edge_len_m.astype(np.float32, copy=False).tobytes())
        f.write(grid_offsets.astype(np.uint32, copy=False).tobytes())
        f.write(grid_node_ids.astype(np.uint32, copy=False).tobytes())
