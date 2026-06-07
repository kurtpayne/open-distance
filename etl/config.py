"""Build config: tile geometry, paths, version, sources."""
from __future__ import annotations

from pathlib import Path

# Bump on incompatible binary-format changes for the L0 tile files.
TILE_FORMAT_VERSION = 1

# Tile grid: uniform 0.25 deg cells. ~28 km x 22 km at 37 deg N.
# US-48 bbox ~ lon [-125, -67] x lat [24, 49] = 232 x 100 = 23,200 cells max,
# but most are empty (oceans). Actual occupied tile count likely ~10-12k.
CELL_DEG = 0.25
# Origin of the global tile grid (so cell ids are stable across builds).
GRID_ORIGIN_LON = -180.0
GRID_ORIGIN_LAT = -90.0


def tile_id(lon: float, lat: float) -> tuple[int, int]:
    """(tx, ty) cell coordinates for a point. ty is positive going north."""
    tx = int((lon - GRID_ORIGIN_LON) // CELL_DEG)
    ty = int((lat - GRID_ORIGIN_LAT) // CELL_DEG)
    return tx, ty


def tile_bbox(tx: int, ty: int) -> tuple[float, float, float, float]:
    """(lon_min, lat_min, lon_max, lat_max)."""
    lon_min = GRID_ORIGIN_LON + tx * CELL_DEG
    lat_min = GRID_ORIGIN_LAT + ty * CELL_DEG
    return (lon_min, lat_min, lon_min + CELL_DEG, lat_min + CELL_DEG)


# ---------------------------------------------------------------------------
# Roads (OSM via Geofabrik)
# ---------------------------------------------------------------------------
GEOFABRIK_BASE = "https://download.geofabrik.de/north-america/us"


def geofabrik_url(state_slug: str) -> str:
    return f"{GEOFABRIK_BASE}/{state_slug}-latest.osm.pbf"


# Highway tags treated as drivable (subset of OSM).
DRIVABLE_HIGHWAY = {
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "unclassified", "residential", "living_street",
    "service", "road",
}

# Subset that lifts into the L1 (highway) overlay -- the binary held by the
# L1Router DurableObject for cross-country routing. Motorway-only (no _link)
# disconnects the graph at interchanges; motorway + motorway_link is the
# minimum that keeps every region reachable.
L1_HIGHWAY = {
    "motorway", "motorway_link",
}

# Fallback free-flow speed (km/h) by OSM highway tag.
SPEED_KMH = {
    "motorway": 105,
    "trunk": 90,
    "primary": 65,
    "secondary": 55,
    "tertiary": 45,
    "residential": 30,
    "service": 20,
    "unclassified": 40,
    "motorway_link": 60,
    "trunk_link": 50,
    "primary_link": 45,
    "secondary_link": 40,
    "tertiary_link": 35,
    "living_street": 15,
    "road": 40,
}
DEFAULT_SPEED_KMH = 40


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
# Repo root is one level above this file (etl/config.py -> repo root).
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "v2"


def state_dir(state_code: str) -> Path:
    """Per-state working directory under data/v2/states/<CODE>/."""
    p = DATA / "states" / state_code
    p.mkdir(parents=True, exist_ok=True)
    return p


def tiles_dir(version: str) -> Path:
    p = DATA / "out" / version / "tiles"
    p.mkdir(parents=True, exist_ok=True)
    return p


def addresses_csv(version: str, state_code: str) -> Path:
    p = DATA / "out" / version / "addresses"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{state_code}.csv"
