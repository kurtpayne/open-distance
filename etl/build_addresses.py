#!/usr/bin/env python3
"""Build addresses.csv from OSM addr:* tags within the Bay Area PBF.

v1 path (Bay Area only): pulls addresses from the same bbox-clipped OSM PBF
the road graph uses. Only addr-tagged nodes are emitted -- the simple, robust
path that doesn't depend on area assembly. Superseded by the v2 pipeline in
etl/v2/, which blends NAD + OpenAddresses + OSM + TIGER for US-wide coverage.

Output schema: id,normalized,lat,lon
"""
from __future__ import annotations

import csv

from config import ADDRESSES_CSV, BBOX_PBF


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
        if p in SUFFIX_ABBR:
            p = SUFFIX_ABBR[p]
        elif p in DIR_ABBR:
            p = DIR_ABBR[p]
        out.append(p)
    return " ".join(out)


def normalize_full(housenumber: str, street: str, city: str, state: str, postcode: str) -> str:
    hn = housenumber.strip().lower()
    st = normalize_street(street)
    ci = city.strip().lower()
    pc = postcode.strip()
    addr_line = " ".join(p for p in [hn, st] if p)
    tail = ", ".join(p for p in [ci, state.strip().lower()] if p)
    out = f"{addr_line}, {tail}"
    if pc:
        out += f" {pc}"
    return out


def main():
    import osmium

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
            state = tags.get("addr:state", "CA")
            pc = tags.get("addr:postcode", "")
            normalized = normalize_full(hn, st, city, state, pc)
            if normalized in self.seen:
                return
            self.seen.add(normalized)
            self.rows.append((normalized, n.location.lat, n.location.lon))

    h = AddrHandler()
    print(f"[build_addresses] scanning {BBOX_PBF}", flush=True)
    h.apply_file(str(BBOX_PBF))
    print(f"[build_addresses] collected {len(h.rows)} addresses", flush=True)

    with open(ADDRESSES_CSV, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "normalized", "lat", "lon"])
        for i, (norm, lat, lon) in enumerate(h.rows, start=1):
            w.writerow([i, norm, f"{lat:.7f}", f"{lon:.7f}"])
    print(f"[build_addresses] wrote {ADDRESSES_CSV}", flush=True)


if __name__ == "__main__":
    main()
