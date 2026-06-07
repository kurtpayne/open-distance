#!/usr/bin/env python3
"""Merge per-state NAD + OSM CSVs into a single per-state CSV.

For each state:
  read <STATE>.nad.csv (rooftop)
  read <STATE>.osm.csv (interpolated)
  output <STATE>.csv: NAD rows first, then OSM rows that don't duplicate by
  (normalized, ~0.0001 deg lat/lon bucket) -- the bucket dedup catches the case
  where NAD and OSM both have the same address with slightly different coords.

NAD wins on collisions.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from etl.config import addresses_csv
from etl.states import BY_CODE


def log(msg: str) -> None:
    print(f"[merge] {msg}", flush=True)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("states", nargs="*")
    args = ap.parse_args(argv)

    states = args.states if args.states else sorted(BY_CODE)
    addr_dir = addresses_csv(args.version, "X").parent

    for state in states:
        nad = addr_dir / f"{state}.nad.csv"
        oa  = addr_dir / f"{state}.oa.csv"
        osm = addr_dir / f"{state}.osm.csv"
        out = addr_dir / f"{state}.csv"

        def read_csv(p):
            rows = []
            if p.exists():
                with open(p) as f:
                    r = csv.reader(f); next(r)
                    for row in r:
                        if len(row) >= 4:
                            try: rows.append((row[1], float(row[2]), float(row[3])))
                            except ValueError: pass
            return rows

        nad_rows = read_csv(nad)
        oa_rows  = read_csv(oa)
        osm_rows = read_csv(osm)

        seen: set[tuple[str, int, int]] = set()
        idx = 0
        kept_nad = kept_oa = kept_osm = 0
        with open(out, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "normalized", "lat", "lon", "tier"])
            # NAD first (rooftop, federal source)
            for norm, lat, lon in nad_rows:
                key = (norm, int(lat * 10_000), int(lon * 10_000))
                if key in seen: continue
                seen.add(key); idx += 1; kept_nad += 1
                w.writerow([idx, norm, f"{lat:.7f}", f"{lon:.7f}", "rooftop"])
            # OA next (rooftop, county/city authority sources)
            for norm, lat, lon in oa_rows:
                key = (norm, int(lat * 10_000), int(lon * 10_000))
                if key in seen: continue
                seen.add(key); idx += 1; kept_oa += 1
                w.writerow([idx, norm, f"{lat:.7f}", f"{lon:.7f}", "rooftop"])
            # OSM last (interpolated tier -- still passes our threshold)
            for norm, lat, lon in osm_rows:
                key = (norm, int(lat * 10_000), int(lon * 10_000))
                if key in seen: continue
                seen.add(key); idx += 1; kept_osm += 1
                w.writerow([idx, norm, f"{lat:.7f}", f"{lon:.7f}", "interpolated"])
            log(f"{state}: NAD={kept_nad:,} OA={kept_oa:,} OSM={kept_osm:,} total={idx:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
