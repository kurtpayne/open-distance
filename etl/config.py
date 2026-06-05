"""ETL config: bounding box, speed table, paths, version."""
from pathlib import Path

# (min_lon, min_lat, max_lon, max_lat) — SF + Peninsula + East Bay + South Bay.
BBOX = (-122.60, 37.20, -121.70, 38.10)
BBOX_NAME = "bayarea"

VERSION = "2026-06"

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

NORCAL_PBF_URL = "https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf"
NORCAL_PBF = DATA / "norcal-latest.osm.pbf"
BBOX_PBF = DATA / f"{BBOX_NAME}.osm.pbf"
GRAPH_BIN = DATA / f"graph-{VERSION}.bin"

# OpenAddresses statewide collection for California (run "us/ca" globally).
# Using the OpenAddresses S3 mirror that hosts collected jobs.
OA_CA_ZIP_URL = "https://data.openaddresses.io/runs/1100358/us/ca.zip"
OA_CA_ZIP = DATA / "openaddresses-ca.zip"
OA_CA_DIR = DATA / "openaddresses-ca"
ADDRESSES_CSV = DATA / "addresses.csv"

# Fallback speed (km/h) by OSM highway tag.
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

# Grid cell size in degrees (~1.1 km in lat). 0.01 keeps cells small + counts modest.
GRID_CELL_DEG = 0.01
