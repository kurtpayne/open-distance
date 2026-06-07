#!/usr/bin/env python3
"""Download source data per state.

For each state code:
  - OSM PBF from Geofabrik -> data/v2/states/<CODE>/<slug>-latest.osm.pbf
  - (NAD + TIGER: hooked but downloaded lazily by build_addresses.py)

Skips files already present and large enough to be the real archive.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests

from etl.config import geofabrik_url, state_dir
from etl.states import BY_CODE


# Minimum sane PBF size (anything smaller is a failed download).
MIN_PBF_BYTES = 5 * 1024 * 1024  # 5 MB


def log(msg: str) -> None:
    print(f"[fetch] {msg}", flush=True)


def download(url: str, dest: Path) -> None:
    """Stream a file to disk with progress logging. Atomic via .part rename."""
    tmp = dest.with_suffix(dest.suffix + ".part")
    log(f"GET {url}")
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        seen = 0
        chunk = 1 << 20  # 1 MB
        next_log = chunk * 32
        with open(tmp, "wb") as f:
            for buf in r.iter_content(chunk_size=chunk):
                if not buf:
                    continue
                f.write(buf)
                seen += len(buf)
                if seen >= next_log:
                    pct = (seen / total * 100) if total else 0
                    log(f"  {seen/1e6:6.0f} MB / {total/1e6:.0f} MB ({pct:5.1f}%)")
                    next_log += chunk * 32
    tmp.rename(dest)
    log(f"  wrote {dest} ({dest.stat().st_size/1e6:.0f} MB)")


def fetch_osm(state_code: str) -> Path:
    state = BY_CODE[state_code]
    sdir = state_dir(state_code)
    out = sdir / f"{state.geofabrik}-latest.osm.pbf"
    if out.exists() and out.stat().st_size >= MIN_PBF_BYTES:
        log(f"{state_code}: PBF cached ({out.stat().st_size/1e6:.0f} MB)")
        return out
    download(geofabrik_url(state.geofabrik), out)
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("states", nargs="+", help="2-letter USPS codes")
    args = ap.parse_args(argv)

    for code in args.states:
        if code not in BY_CODE:
            log(f"  WARN: unknown state {code!r}, skipping")
            continue
        try:
            fetch_osm(code)
        except Exception as e:  # noqa: BLE001
            log(f"  ERROR fetching {code}: {e}")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
