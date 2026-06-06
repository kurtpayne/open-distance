#!/usr/bin/env python3
"""Build per-state TIGER street-segment CSVs from per-state edges-geodatabase.

Input:  data/v2/tiger-gdb/<STATE>_edges.gdb.zip
        Single layer `All_Lines` with TLID + FULLNAME + LFROMADD/LTOADD +
        RFROMADD/RTOADD + ZIPL/ZIPR + MTFCC + geometry.

Output: data/v2/out/<version>/segments/<STATE>.csv
        columns: id, street_normalized, zip, from_hn, to_hn, side,
                 from_lat, from_lon, to_lat, to_lon

Each row in All_Lines can produce up to 2 segment records (one per side)
depending on which side has a populated address range.
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

import fiona

from etl.v2.config import DATA
from etl.v2.states import BY_CODE


SUFFIX_ABBR = {
    "STREET": "st", "AVENUE": "ave", "BOULEVARD": "blvd", "ROAD": "rd",
    "DRIVE": "dr", "LANE": "ln", "COURT": "ct", "PLACE": "pl", "TERRACE": "ter",
    "TRAIL": "trl", "PARKWAY": "pkwy", "HIGHWAY": "hwy", "CIRCLE": "cir",
    "SQUARE": "sq", "WAY": "way", "ALLEY": "aly", "PLAZA": "plz",
    "STR": "st", "AVE": "ave", "BLVD": "blvd", "RD": "rd", "DR": "dr",
    "LN": "ln", "CT": "ct", "PL": "pl", "TER": "ter", "TRL": "trl",
    "PKWY": "pkwy", "HWY": "hwy", "CIR": "cir", "SQ": "sq", "ALY": "aly",
    "PLZ": "plz",
}
DIR_ABBR = {
    "NORTH": "n", "SOUTH": "s", "EAST": "e", "WEST": "w",
    "NORTHEAST": "ne", "NORTHWEST": "nw", "SOUTHEAST": "se", "SOUTHWEST": "sw",
    "N": "n", "S": "s", "E": "e", "W": "w",
    "NE": "ne", "NW": "nw", "SE": "se", "SW": "sw",
}

ROAD_MTFCC_RE = re.compile(r"^S1[0-9]{3}$")


def abbr_token(tok: str) -> str:
    u = tok.upper().strip(".,")
    if not u: return ""
    if u in SUFFIX_ABBR: return SUFFIX_ABBR[u]
    if u in DIR_ABBR: return DIR_ABBR[u]
    return u.lower()


def normalize_street(s: str) -> str:
    return " ".join(abbr_token(t) for t in s.split() if t)


def parse_int(s) -> int | None:
    if s is None: return None
    s = str(s).strip()
    if not s: return None
    m = re.match(r"^(\d+)", s)
    if not m: return None
    try: return int(m.group(1))
    except ValueError: return None


def segments_csv(version: str, state_code: str) -> Path:
    p = DATA / "out" / version / "segments"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{state_code}.csv"


def tiger_gdb_path(state_code: str) -> Path:
    return DATA / "tiger-gdb" / f"{state_code}_edges.gdb.zip"


def log(msg: str) -> None:
    print(f"[tiger-seg] {msg}", flush=True)


def linestring_endpoints(geom) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Return ((from_lon, from_lat), (to_lon, to_lat)) for a LineString or MultiLineString."""
    if geom is None: return None
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords: return None
    if gtype == "LineString":
        if len(coords) < 2: return None
        return (tuple(coords[0][:2]), tuple(coords[-1][:2]))
    if gtype == "MultiLineString":
        # Take the longest sub-line's endpoints, approximated by sub-line with most vertices.
        best = max(coords, key=len)
        if len(best) < 2: return None
        return (tuple(best[0][:2]), tuple(best[-1][:2]))
    return None


def build_state(state_code: str, version: str) -> int:
    gdb = tiger_gdb_path(state_code)
    if not gdb.exists():
        return 0
    out_path = segments_csv(version, state_code)
    written = 0
    with open(out_path, "w", newline="") as fo:
        w = csv.writer(fo)
        w.writerow(["id", "street_normalized", "zip", "from_hn", "to_hn",
                    "side", "from_lat", "from_lon", "to_lat", "to_lon"])
        try:
            layers = fiona.listlayers(f"zip://{gdb}")
        except Exception as e:
            log(f"  {state_code}: listlayers failed ({e})")
            return 0
        if "All_Lines" not in layers:
            log(f"  {state_code}: no All_Lines layer (found: {layers})")
            return 0
        with fiona.open(f"zip://{gdb}", layer="All_Lines") as f:
            for feat in f:
                props = feat["properties"]
                mtfcc = props.get("MTFCC", "")
                if not ROAD_MTFCC_RE.match(mtfcc or ""):
                    continue
                name = (props.get("FULLNAME") or "").strip()
                if not name:
                    continue
                ep = linestring_endpoints(feat.get("geometry"))
                if ep is None:
                    continue
                (fr_lon, fr_lat), (to_lon, to_lat) = ep
                street = normalize_street(name)
                if not street:
                    continue
                # Left side
                lfrom = parse_int(props.get("LFROMADD"))
                lto = parse_int(props.get("LTOADD"))
                if lfrom is not None and lto is not None:
                    lo, hi = min(lfrom, lto), max(lfrom, lto)
                    zip_l = (props.get("ZIPL") or "").strip()
                    written += 1
                    w.writerow([written, street, zip_l, lo, hi, "L",
                                f"{fr_lat:.6f}", f"{fr_lon:.6f}",
                                f"{to_lat:.6f}", f"{to_lon:.6f}"])
                # Right side
                rfrom = parse_int(props.get("RFROMADD"))
                rto = parse_int(props.get("RTOADD"))
                if rfrom is not None and rto is not None:
                    lo, hi = min(rfrom, rto), max(rfrom, rto)
                    zip_r = (props.get("ZIPR") or "").strip()
                    written += 1
                    w.writerow([written, street, zip_r, lo, hi, "R",
                                f"{fr_lat:.6f}", f"{fr_lon:.6f}",
                                f"{to_lat:.6f}", f"{to_lon:.6f}"])
    log(f"  {state_code}: {written:,} segments")
    return written


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("states", nargs="*")
    args = ap.parse_args(argv)
    states = args.states if args.states else sorted(BY_CODE)
    total = 0
    for s in states:
        total += build_state(s, args.version)
    log(f"done: {total:,} segments across {len(states)} states")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
