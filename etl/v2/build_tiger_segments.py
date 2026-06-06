#!/usr/bin/env python3
"""Build per-state TIGER street-segment CSVs for address interpolation.

For each county we have <county>_edges.zip + <county>_addr.zip:
  EDGES: TLID + geometry (LineString) + FULLNAME + MTFCC + ZIPL + ZIPR
  ADDR:  TLID + FROMHN + TOHN + SIDE + ZIP

We join EDGES and ADDR on TLID and emit, per matched pair, one segment row.

Output: data/v2/out/<version>/segments/<STATE>.csv
  columns: id, street_normalized, zip, from_hn, to_hn, side,
           from_lat, from_lon, to_lat, to_lon

street_normalized uses the same abbreviator as the addresses pipeline so the
Worker can match queries directly.
"""
from __future__ import annotations

import argparse
import csv
import io
import re
import sys
import zipfile
from pathlib import Path

import shapefile

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

# MTFCC codes for drivable / addressable roads (S1xxx).
ROAD_MTFCC_RE = re.compile(r"^S1[0-9]{3}$")


def abbr_token(tok: str) -> str:
    u = tok.upper().strip(".,")
    if not u: return ""
    if u in SUFFIX_ABBR: return SUFFIX_ABBR[u]
    if u in DIR_ABBR: return DIR_ABBR[u]
    return u.lower()


def normalize_street(s: str) -> str:
    return " ".join(abbr_token(t) for t in s.split() if t)


def segments_csv(version: str, state_code: str) -> Path:
    p = DATA / "out" / version / "segments"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{state_code}.csv"


def tiger_state_dir(state_code: str) -> Path:
    return DATA / "tiger" / state_code


def parse_int(s) -> int | None:
    if s is None: return None
    s = str(s).strip()
    if not s: return None
    # TIGER FROMHN/TOHN sometimes have letters like "100A" - extract leading int.
    m = re.match(r"^(\d+)", s)
    if not m: return None
    try: return int(m.group(1))
    except ValueError: return None


def load_edges(zip_path: Path) -> dict[int, dict]:
    """TLID -> {street, mtfcc, zipl, zipr, geometry}."""
    out: dict[int, dict] = {}
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        try:
            shp_name = next(n for n in names if n.endswith(".shp"))
            dbf_name = next(n for n in names if n.endswith(".dbf"))
        except StopIteration:
            return out
        shp_b = z.read(shp_name)
        dbf_b = z.read(dbf_name)
        r = shapefile.Reader(shp=io.BytesIO(shp_b), dbf=io.BytesIO(dbf_b))
        # Build field name list (skip the DeletionFlag first field).
        fields = [f[0] for f in r.fields[1:]]
        for i, rec in enumerate(r.records()):
            d = {fields[k]: rec[k] for k in range(len(fields))}
            mtfcc = d.get("MTFCC", "")
            if not ROAD_MTFCC_RE.match(mtfcc or ""):
                continue
            name = (d.get("FULLNAME") or "").strip()
            if not name:
                continue
            tlid = d.get("TLID")
            if tlid is None:
                continue
            shp = r.shape(i)
            pts = shp.points
            if not pts:
                continue
            out[int(tlid)] = {
                "street": normalize_street(name),
                "zipl": (d.get("ZIPL") or "").strip(),
                "zipr": (d.get("ZIPR") or "").strip(),
                "from_lon": float(pts[0][0]),
                "from_lat": float(pts[0][1]),
                "to_lon": float(pts[-1][0]),
                "to_lat": float(pts[-1][1]),
            }
    return out


def load_addr(zip_path: Path) -> list[dict]:
    """Return list of {TLID, FROMHN, TOHN, SIDE, ZIP} dicts."""
    out: list[dict] = []
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        try:
            dbf_name = next(n for n in names if n.endswith(".dbf"))
        except StopIteration:
            return out
        dbf_b = z.read(dbf_name)
        r = shapefile.Reader(dbf=io.BytesIO(dbf_b))
        fields = [f[0] for f in r.fields[1:]]
        for rec in r.records():
            d = {fields[k]: rec[k] for k in range(len(fields))}
            tlid = d.get("TLID")
            if tlid is None: continue
            out.append({
                "TLID": int(tlid),
                "FROMHN": d.get("FROMHN"),
                "TOHN": d.get("TOHN"),
                "SIDE": (d.get("SIDE") or "").upper().strip(),
                "ZIP": (d.get("ZIP") or "").strip(),
            })
    return out


def log(msg: str) -> None:
    print(f"[tiger-seg] {msg}", flush=True)


def build_state(state_code: str, version: str) -> int:
    sdir = tiger_state_dir(state_code)
    if not sdir.exists():
        return 0
    # county_fips deduced from filenames
    county_fips_set: set[str] = set()
    for p in sdir.glob("*_edges.zip"):
        county_fips_set.add(p.stem.split("_")[0])
    if not county_fips_set:
        return 0

    out_path = segments_csv(version, state_code)
    written = 0
    with open(out_path, "w", newline="") as fo:
        w = csv.writer(fo)
        w.writerow(["id", "street_normalized", "zip", "from_hn", "to_hn",
                    "side", "from_lat", "from_lon", "to_lat", "to_lon"])
        for cf in sorted(county_fips_set):
            edges_zip = sdir / f"{cf}_edges.zip"
            addr_zip = sdir / f"{cf}_addr.zip"
            if not edges_zip.exists() or not addr_zip.exists():
                continue
            try:
                edges = load_edges(edges_zip)
                addrs = load_addr(addr_zip)
            except Exception as e:
                log(f"  {state_code}/{cf}: skip ({e})")
                continue
            for a in addrs:
                tlid = a["TLID"]
                e = edges.get(tlid)
                if e is None: continue
                hn1 = parse_int(a["FROMHN"]); hn2 = parse_int(a["TOHN"])
                if hn1 is None or hn2 is None: continue
                lo, hi = min(hn1, hn2), max(hn1, hn2)
                side = a["SIDE"] or ("L" if e["zipl"] else "R")
                zip_used = a["ZIP"] or (e["zipl"] if side == "L" else e["zipr"])
                if not e["street"]:
                    continue
                written += 1
                w.writerow([
                    written, e["street"], zip_used, lo, hi, side,
                    f"{e['from_lat']:.6f}", f"{e['from_lon']:.6f}",
                    f"{e['to_lat']:.6f}", f"{e['to_lon']:.6f}",
                ])
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
