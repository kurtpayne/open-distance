#!/usr/bin/env python3
"""Parse downloaded OpenAddresses GeoJSON files into per-state CSVs.

Each source file in data/v2/oa/<STATE>/*.geojson.gz is NDJSON (one Feature per
line). We normalize to the same shape as the NAD/OSM CSVs:

  id, normalized, lat, lon, tier='rooftop'

Tier is 'rooftop' for OA -- each point is a curated address point from a county
or city authority, comparable in quality to NAD.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import sys
from pathlib import Path

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
    "PLZ": "plz", "BL": "blvd",
}
DIR_ABBR = {
    "NORTH": "n", "SOUTH": "s", "EAST": "e", "WEST": "w",
    "NORTHEAST": "ne", "NORTHWEST": "nw", "SOUTHEAST": "se", "SOUTHWEST": "sw",
    "N": "n", "S": "s", "E": "e", "W": "w",
    "NE": "ne", "NW": "nw", "SE": "se", "SW": "sw",
}


def abbr_token(tok: str) -> str:
    u = tok.upper().strip(".,")
    if not u: return ""
    if u in SUFFIX_ABBR: return SUFFIX_ABBR[u]
    if u in DIR_ABBR: return DIR_ABBR[u]
    return u.lower()


def normalize(num: str, street: str, city: str, state: str, postcode: str) -> str:
    num = " ".join(abbr_token(t) for t in num.split())
    street = " ".join(abbr_token(t) for t in street.split())
    city = city.lower()
    state = state.lower()
    postcode = postcode.strip()
    addr = " ".join(x for x in [num, street] if x)
    tail = ", ".join(x for x in [city, state] if x)
    out = f"{addr}, {tail}"
    if postcode:
        out += f" {postcode}"
    return out


def oa_csv(version: str, state: str) -> Path:
    p = DATA / "out" / version / "addresses"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{state}.oa.csv"


def oa_state_dir(state: str) -> Path:
    return DATA / "oa" / state


def log(msg: str) -> None:
    print(f"[oa] {msg}", flush=True)


def build_state(state: str, version: str) -> int:
    sdir = oa_state_dir(state)
    if not sdir.exists():
        return 0
    files = sorted(sdir.glob("*.geojson.gz"))
    if not files:
        return 0

    out = oa_csv(version, state)
    written = 0
    seen: set[str] = set()
    with open(out, "w", newline="") as fo:
        w = csv.writer(fo)
        w.writerow(["id", "normalized", "lat", "lon", "tier"])
        for fp in files:
            try:
                with gzip.open(fp, "rt", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            o = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        props = o.get("properties") or {}
                        num = (props.get("number") or "").strip()
                        street = (props.get("street") or "").strip()
                        if not num or not street:
                            continue
                        city = (props.get("city") or "").strip()
                        postcode = (props.get("postcode") or "").strip()
                        coords = (o.get("geometry") or {}).get("coordinates") or [None, None]
                        try:
                            lon, lat = float(coords[0]), float(coords[1])
                        except (TypeError, ValueError):
                            continue
                        if abs(lat) > 90 or abs(lon) > 180 or (lat == 0 and lon == 0):
                            continue
                        normalized = normalize(num, street, city, state, postcode)
                        if normalized in seen:
                            continue
                        seen.add(normalized)
                        written += 1
                        w.writerow([written, normalized, f"{lat:.7f}", f"{lon:.7f}", "rooftop"])
            except Exception as e:
                log(f"  {state}: skipping bad file {fp.name}: {e}")
    return written


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("states", nargs="*")
    args = ap.parse_args(argv)

    states = args.states if args.states else sorted(BY_CODE)
    total = 0
    for st in states:
        n = build_state(st, args.version)
        if n > 0:
            log(f"  {st}: {n:,}")
            total += n
    log(f"done: {total:,} OA addresses across {len(states)} states")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
