#!/usr/bin/env python3
"""Per-state address shards from OSM addr:* tags.

For v2-first-pass we reuse OSM addr-tagged nodes as the address source
(same approach as v1, scaled per state). This is documented in the README
as the first step toward NAD+TIGER (which lands in a follow-up: same shard
schema, source swap only).

Output: data/v2/out/<version>/addresses/<STATE>.csv
        columns: id,normalized,lat,lon
"""
from __future__ import annotations

import argparse
import csv
import sys

from etl.config import DATA, state_dir
from etl.states import BY_CODE


def osm_csv(version: str, state_code: str):
    p = DATA / "out" / version / "addresses"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{state_code}.osm.csv"


SUFFIX_ABBR = {
    "street": "st", "avenue": "ave", "boulevard": "blvd", "road": "rd",
    "drive": "dr", "lane": "ln", "court": "ct", "place": "pl", "terrace": "ter",
    "trail": "trl", "parkway": "pkwy", "highway": "hwy", "circle": "cir",
    "square": "sq", "way": "way", "alley": "aly", "plaza": "plz",
}
DIR_ABBR = {
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
}


def normalize_street(s: str) -> str:
    parts = s.lower().split()
    out = []
    for p in parts:
        p = p.strip(".,")
        if p in SUFFIX_ABBR: p = SUFFIX_ABBR[p]
        elif p in DIR_ABBR: p = DIR_ABBR[p]
        out.append(p)
    return " ".join(out)


def normalize_full(hn: str, st: str, city: str, state: str, pc: str) -> str:
    hn = hn.strip().lower()
    st = normalize_street(st)
    ci = city.strip().lower()
    pc = pc.strip()
    addr_line = " ".join(p for p in [hn, st] if p)
    tail = ", ".join(p for p in [ci, state.strip().lower()] if p)
    out = f"{addr_line}, {tail}"
    if pc:
        out += f" {pc}"
    return out


def log(msg: str) -> None:
    print(f"[addresses] {msg}", flush=True)


def build_state(state_code: str, version: str) -> int:
    import osmium

    state = BY_CODE[state_code]
    pbf = state_dir(state_code) / f"{state.geofabrik}-latest.osm.pbf"
    if not pbf.exists():
        raise FileNotFoundError(f"missing PBF for {state_code}: {pbf}")

    log(f"{state_code}: scanning {pbf.name}")

    class AddrHandler(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.rows = []
            self.seen = set()

        def node(self, n):
            if not n.location.valid():
                return
            tags = n.tags
            hn = tags.get("addr:housenumber")
            st = tags.get("addr:street")
            if not hn or not st:
                return
            city = tags.get("addr:city", "")
            stt = tags.get("addr:state", state.code)
            pc = tags.get("addr:postcode", "")
            normalized = normalize_full(hn, st, city, stt, pc)
            if normalized in self.seen: return
            self.seen.add(normalized)
            self.rows.append((normalized, n.location.lat, n.location.lon))

    h = AddrHandler()
    h.apply_file(str(pbf))
    log(f"{state_code}:   collected {len(h.rows)} addresses")

    out = osm_csv(version, state_code)
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "normalized", "lat", "lon", "tier"])
        for i, (norm, lat, lon) in enumerate(h.rows, start=1):
            # OSM addr-tagged nodes -> 'interpolated' tier (good but not NAD-level
            # rooftop certainty; many are also good rooftop, but we keep the conservative
            # tier so NAD wins on collisions in the merge).
            w.writerow([i, norm, f"{lat:.7f}", f"{lon:.7f}", "interpolated"])
    return len(h.rows)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("states", nargs="+")
    args = ap.parse_args(argv)

    total = 0
    for code in args.states:
        if code not in BY_CODE:
            log(f"unknown state {code!r}; skipping")
            continue
        try:
            total += build_state(code, args.version)
        except FileNotFoundError as e:
            log(f"  WARN: {e}")
            continue
    log(f"done: {total:,} addresses across {len(args.states)} states")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
