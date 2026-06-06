"""v2 build config: tile geometry, paths, version, sources."""
from __future__ import annotations

from pathlib import Path

# Bump on incompatible binary-format changes; manifest carries the per-build version.
TILE_FORMAT_VERSION = 1

# Date-stamped build version; bumps each refresh.sh run.
# A live value gets written into data/v2/version.txt by refresh.sh.
DEFAULT_VERSION = "2026-06"

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


def tile_key(tx: int, ty: int) -> str:
    """Stable string key for a tile, used in R2 paths and node ids."""
    return f"{tx}_{ty}"


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

# Subset that lifts into the L1 (highway) overlay. Keep this TIGHT -- the
# whole graph must fit in a 128 MB Worker isolate after decoding into typed
# arrays + a computed reverse CSR. Motorway-only keeps us comfortably under
# that ceiling and covers ~all true long-haul corridors.
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
# Addresses (NAD + TIGER)
# ---------------------------------------------------------------------------
# NAD is published as one national geopackage; we clip per-state in the ETL.
# URL is documented at transportation.gov; pinning a public mirror in a config
# helper rather than hardcoding here, since the path moves.
NAD_RELEASE_TAG = "current"

# TIGER ALL_LINES (street segments with address ranges) is per-county.
# Census naming pattern: https://www2.census.gov/geo/tiger/TIGER2024/ADDR/tl_2024_<state_fips>_<county>_addr.zip
TIGER_YEAR = "2024"
TIGER_BASE = f"https://www2.census.gov/geo/tiger/TIGER{TIGER_YEAR}"


# ---------------------------------------------------------------------------
# Confidence threshold (the rule we picked in conversation)
# ---------------------------------------------------------------------------
# Tiers we will return OK for:
ACCEPTED_GEOCODE_TIERS = {"rooftop", "interpolated"}
# Tiers we reject as NOT_FOUND:
REJECTED_GEOCODE_TIERS = {"centroid"}


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]
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


def overlay_path(version: str) -> Path:
    p = DATA / "out" / version
    p.mkdir(parents=True, exist_ok=True)
    return p / "l1-overlay.bin"


def addresses_csv(version: str, state_code: str) -> Path:
    p = DATA / "out" / version / "addresses"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{state_code}.csv"


def manifest_path(version: str) -> Path:
    p = DATA / "out" / version
    p.mkdir(parents=True, exist_ok=True)
    return p / "manifest.json"
