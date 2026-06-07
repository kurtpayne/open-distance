#!/usr/bin/env python3
"""Discover + download all OpenAddresses US address sources.

Talks to https://batch.openaddresses.io/api/data (level=run, fabric=false).
Filters to layer=addresses, source path starts with 'us/'. For each source:

  - Fetch job metadata to get the S3 GeoJSON URL.
  - Download the gzipped GeoJSON.LD to data/v2/oa/<state>/<source-slug>.geojson.gz

Idempotent: skip files that already exist with non-trivial size.

This pulls many small downloads (~2,300 sources for US). Uses a small thread
pool to keep it brisk without hammering the OA infra.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import time
import urllib.request
from pathlib import Path

import requests

from etl.v2.config import DATA


OA_API = "https://batch.openaddresses.io/api/data"
OA_DIR = DATA / "oa"
MIN_BYTES = 4 * 1024  # skip downloads smaller than this (broken/empty)


def log(msg: str) -> None:
    print(f"[fetch-oa] {msg}", flush=True)


def list_us_address_sources() -> list[dict]:
    """All US address-layer runs (counties, cities, statewide sources)."""
    log(f"GET {OA_API}?level=run&country=us&page=0&limit=10000&fabric=false")
    r = requests.get(
        OA_API,
        params={"level": "run", "country": "us", "page": 0, "limit": 10000, "fabric": "false"},
        headers={"User-Agent": "open-distance/1.0"},
        timeout=60,
    )
    r.raise_for_status()
    arr = r.json()
    runs = [
        x for x in arr
        if x.get("layer") == "addresses"
        and x.get("source", "").startswith("us/")
        and x.get("output", {}).get("output")
    ]
    log(f"  {len(runs)} US address sources")
    return runs


def slugify(src: str) -> tuple[str, str]:
    """Return (state_code, file_slug). Source path like us/ca/alameda -> ('CA', 'alameda')."""
    parts = src.split("/")
    if len(parts) < 3 or parts[0] != "us":
        return ("XX", src.replace("/", "_"))
    state = parts[1].upper()
    slug = "_".join(parts[2:])
    return state, slug


def download_one(run: dict, force: bool = False) -> tuple[str, str, int, bool]:
    src = run["source"]
    job = run["job"]
    state, slug = slugify(src)
    out_dir = OA_DIR / state
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{slug}.geojson.gz"
    if not force and out.exists() and out.stat().st_size > MIN_BYTES:
        return (state, slug, out.stat().st_size, False)

    # Resolve job -> s3 URL via the OA job endpoint.
    job_url = f"https://batch.openaddresses.io/api/job/{job}"
    meta = requests.get(job_url, headers={"User-Agent": "open-distance/1.0"}, timeout=60).json()
    s3 = meta.get("s3")
    if not s3 or not s3.startswith("s3://v2.openaddresses.io/"):
        return (state, slug, 0, False)
    # Map s3://v2.openaddresses.io/<key> -> https://v2.openaddresses.io/<key>
    url = "https://v2.openaddresses.io/" + s3[len("s3://v2.openaddresses.io/"):]
    tmp = out.with_suffix(out.suffix + ".part")
    with requests.get(url, stream=True, timeout=300, allow_redirects=True,
                      headers={"User-Agent": "open-distance/1.0"}) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
    tmp.rename(out)
    return (state, slug, out.stat().st_size, True)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--states", nargs="*", help="Optional state code filter (uppercase)")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    runs = list_us_address_sources()
    if args.states:
        accept = {s.upper() for s in args.states}
        runs = [r for r in runs if r["source"].split("/")[1].upper() in accept]
        log(f"  filtered to {len(runs)} sources for {accept}")

    OA_DIR.mkdir(parents=True, exist_ok=True)
    start = time.time()
    done = 0
    bytes_dl = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(download_one, r, args.force): r for r in runs}
        for fut in concurrent.futures.as_completed(futs):
            try:
                state, slug, size, downloaded = fut.result()
            except Exception as e:
                run = futs[fut]
                log(f"  ERROR {run['source']}: {e}")
                continue
            done += 1
            if downloaded:
                bytes_dl += size
            if done % 50 == 0 or done == len(runs):
                elapsed = time.time() - start
                log(f"  {done}/{len(runs)}  total_new={bytes_dl/1e9:.2f} GB  elapsed={elapsed:.0f}s")
    log(f"done in {time.time()-start:.0f}s; new bytes downloaded: {bytes_dl/1e9:.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
