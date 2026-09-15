#!/usr/bin/env python3
"""Download Census TIGER per-state edges-geodatabase ZIPs.

URL pattern (--vintage, default TGRGDB24):
  https://www2.census.gov/geo/tiger/TGRGDB24/tlgdb_2024_a_<fips>_<lc>_edges.gdb.zip
  https://www2.census.gov/geo/tiger/TGRGDB25/tlgdb_2025_a_<fips>_<lc>_edges.gdb.zip
  https://www2.census.gov/geo/tiger/TGRGDB26/tlgdb_2026_<fips>_<lc>_edges.gdb.zip

Local path: data/v2/tiger-gdb/<ST>_edges.gdb.zip for TGRGDB24 (the original
flat layout, so already-cached files keep validating) and
data/v2/tiger-gdb/<vintage>/<ST>_edges.gdb.zip for newer vintages.

This is a *huge* improvement over the per-county shapefile approach: ~49
medium-large downloads instead of ~6,000 small ones. The per-state edges
geodatabase has a single `All_Lines` layer with EDGES + ADDR pre-joined
(TLID, FULLNAME, LFROMADD/LTOADD, RFROMADD/RTOADD, ZIPL/ZIPR all in one row).

Idempotent: skips files that already exist and validate.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import sys
import zipfile
from pathlib import Path

import requests

from etl.config import DATA
from etl.states import BY_CODE


TIGER_DIR = DATA / "tiger-gdb"
BASE = "https://www2.census.gov/geo/tiger"
VINTAGES = ("TGRGDB24", "TGRGDB25", "TGRGDB26")
DEFAULT_VINTAGE = "TGRGDB24"
MIN_BYTES = 100 * 1024  # any state's edges gdb is at least 100 KB


def log(msg: str) -> None:
    print(f"[fetch-tiger] {msg}", flush=True)


def state_url(state, vintage: str = DEFAULT_VINTAGE) -> str:
    year = "20" + vintage[-2:]
    # 2026 dropped the "_a_" infix from the filename.
    infix = "" if vintage == "TGRGDB26" else "a_"
    return f"{BASE}/{vintage}/tlgdb_{year}_{infix}{state.fips}_{state.code.lower()}_edges.gdb.zip"


def tiger_gdb_path(state_code: str, vintage: str = DEFAULT_VINTAGE) -> Path:
    """Local ZIP path; TGRGDB24 keeps the original flat layout."""
    d = TIGER_DIR if vintage == DEFAULT_VINTAGE else TIGER_DIR / vintage
    return d / f"{state_code}_edges.gdb.zip"


def state_path(state, vintage: str = DEFAULT_VINTAGE) -> Path:
    return tiger_gdb_path(state.code, vintage)


def is_valid_zip(p: Path) -> bool:
    if not p.exists() or p.stat().st_size < MIN_BYTES:
        return False
    try:
        with zipfile.ZipFile(p) as z:
            return any(n.endswith(".gdb/") or "/a00000001" in n for n in z.namelist())
    except zipfile.BadZipFile:
        return False


def fetch_state(state_code: str, vintage: str = DEFAULT_VINTAGE) -> tuple[str, int, bool]:
    state = BY_CODE[state_code]
    out = state_path(state, vintage)
    if is_valid_zip(out):
        return (state_code, out.stat().st_size, False)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".part")
    url = state_url(state, vintage)
    log(f"GET {url}")
    with requests.get(url, stream=True, timeout=600, headers={"User-Agent": "open-distance/1.0"}) as r:
        if r.status_code == 404:
            log(f"  {state_code}: 404 (no _edges variant?)")
            return (state_code, 0, False)
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
    if tmp.stat().st_size < MIN_BYTES:
        tmp.unlink(missing_ok=True)
        log(f"  {state_code}: too small")
        return (state_code, 0, False)
    tmp.rename(out)
    return (state_code, out.stat().st_size, True)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6,
                    help="Census throttles; keep modest")
    ap.add_argument("--vintage", choices=VINTAGES, default=DEFAULT_VINTAGE,
                    help="TIGER geodatabase release (default: %(default)s)")
    ap.add_argument("states", nargs="*", help="State codes (default: all US-48+DC)")
    args = ap.parse_args(argv)

    states = args.states if args.states else sorted(BY_CODE)
    log(f"fetching {len(states)} states ({args.vintage}) with {args.workers} workers")

    total_new = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(fetch_state, s, args.vintage): s for s in states}
        done = 0
        for fut in concurrent.futures.as_completed(futs):
            s = futs[fut]
            done += 1
            try:
                _, size, downloaded = fut.result()
            except Exception as e:
                log(f"  ERROR {s}: {e}")
                continue
            if downloaded:
                total_new += size
            log(f"  {done}/{len(states)} {s}: {size/1e6:.1f} MB {'(new)' if downloaded else '(cached)'}")
    log(f"done. new bytes: {total_new/1e9:.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
