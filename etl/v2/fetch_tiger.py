#!/usr/bin/env python3
"""Download Census TIGER EDGES + ADDR shapefiles per county.

Strategy:
  1. Download national COUNTY shapefile (~7 MB) once to enumerate counties.
  2. For each (state, county): download EDGES + ADDR ZIPs from
     https://www2.census.gov/geo/tiger/TIGER2024/
  3. Stash under data/v2/tiger/<STATE>/<county_fips>_{edges,addr}.zip
     Idempotent: skip files already present and big enough.

Run with --states CA TX to limit. Default: all US-48 + DC.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import io
import os
import sys
import zipfile
from pathlib import Path

import requests
import shapefile

from etl.v2.config import DATA, TIGER_BASE, TIGER_YEAR
from etl.v2.states import BY_CODE


TIGER_DIR = DATA / "tiger"
COUNTY_URL = f"{TIGER_BASE}/COUNTY/tl_{TIGER_YEAR}_us_county.zip"
COUNTY_ZIP = TIGER_DIR / "us_county.zip"
MIN_BYTES = 1024


def log(msg: str) -> None:
    print(f"[fetch-tiger] {msg}", flush=True)


def download(url: str, out: Path) -> bool:
    """Download to a temp .part then rename. Returns True if newly downloaded."""
    if out.exists() and out.stat().st_size > MIN_BYTES:
        return False
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".part")
    try:
        with requests.get(url, stream=True, timeout=120,
                          headers={"User-Agent": "hhapi/1.0"}) as r:
            if r.status_code == 404:
                return False
            r.raise_for_status()
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(chunk_size=512 * 1024):
                    if chunk:
                        f.write(chunk)
        if tmp.stat().st_size < MIN_BYTES:
            tmp.unlink(missing_ok=True)
            return False
        tmp.rename(out)
        return True
    except Exception as e:
        tmp.unlink(missing_ok=True)
        log(f"  ERROR {url}: {e}")
        return False


def list_counties() -> list[tuple[str, str, str, str]]:
    """Returns list of (state_code, state_fips, county_fips, county_name)."""
    if not COUNTY_ZIP.exists():
        log(f"GET {COUNTY_URL}")
        download(COUNTY_URL, COUNTY_ZIP)
    # Read the shapefile from inside the zip without unpacking.
    fips_to_state = {s.fips: s.code for s in BY_CODE.values()}
    out = []
    with zipfile.ZipFile(COUNTY_ZIP) as z:
        # Find the .shp + .dbf entries.
        names = z.namelist()
        shp_name = next(n for n in names if n.endswith(".shp"))
        dbf_name = next(n for n in names if n.endswith(".dbf"))
        with z.open(shp_name) as shp_fh, z.open(dbf_name) as dbf_fh:
            shp_bytes = shp_fh.read()
            dbf_bytes = dbf_fh.read()
        r = shapefile.Reader(shp=io.BytesIO(shp_bytes), dbf=io.BytesIO(dbf_bytes))
        for rec in r.records():
            d = rec.as_dict()
            state_fips = d.get("STATEFP")
            county_fips = d.get("COUNTYFP")
            name = d.get("NAME", "")
            sc = fips_to_state.get(state_fips)
            if sc is None: continue  # AK/HI/PR/etc.
            out.append((sc, state_fips, county_fips, name))
    return out


def county_urls(state_fips: str, county_fips: str) -> tuple[str, str]:
    """Returns (edges_url, addr_url)."""
    p = f"{state_fips}{county_fips}"
    return (
        f"{TIGER_BASE}/EDGES/tl_{TIGER_YEAR}_{p}_edges.zip",
        f"{TIGER_BASE}/ADDR/tl_{TIGER_YEAR}_{p}_addr.zip",
    )


def county_paths(state_code: str, county_fips: str) -> tuple[Path, Path]:
    d = TIGER_DIR / state_code
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{county_fips}_edges.zip", d / f"{county_fips}_addr.zip"


def download_county(state_code: str, state_fips: str, county_fips: str) -> tuple[int, int]:
    """Download both EDGES + ADDR for a county. Returns (edges_bytes, addr_bytes)."""
    edges_url, addr_url = county_urls(state_fips, county_fips)
    edges_path, addr_path = county_paths(state_code, county_fips)
    eb = 0; ab = 0
    if download(edges_url, edges_path) or edges_path.exists():
        eb = edges_path.stat().st_size
    if download(addr_url, addr_path) or addr_path.exists():
        ab = addr_path.stat().st_size
    return eb, ab


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("states", nargs="*", help="2-letter state codes (uppercase). Default: all US-48+DC")
    args = ap.parse_args(argv)

    accept = set(args.states) if args.states else set(BY_CODE)
    log(f"resolving counties for: {sorted(accept)}")

    counties = list_counties()
    counties = [c for c in counties if c[0] in accept]
    log(f"  {len(counties)} counties to fetch")

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(download_county, sc, sf, cf): (sc, sf, cf, name) for sc, sf, cf, name in counties}
        done = 0
        for fut in concurrent.futures.as_completed(futs):
            sc, sf, cf, name = futs[fut]
            done += 1
            try:
                eb, ab = fut.result()
            except Exception as e:
                log(f"  ERR {sc}/{cf} {name}: {e}")
                continue
            if done % 100 == 0 or done == len(counties):
                log(f"  {done}/{len(counties)}")
    log("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
