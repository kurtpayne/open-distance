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
from pathlib import Path

import requests

from etl.config import DATA


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
    persist_attribution_manifest(runs)
    return runs


OA_SOURCE_RAW = "https://raw.githubusercontent.com/openaddresses/openaddresses/master/sources"


def _fetch_one_source_attribution(source_path: str) -> dict:
    """Pull the per-source manifest from OA's GitHub source repo.

    OA stores per-county / per-city authority + license info inside the source
    JSON at `layers.addresses[*]`, not at top-level. We pull the first layer
    that has an attribution string (most sources only have one addresses
    layer; some split residential/commercial).
    """
    url = f"{OA_SOURCE_RAW}/{source_path}.json"
    try:
        r = requests.get(url, headers={"User-Agent": "open-distance/1.0"}, timeout=20)
        if r.status_code != 200:
            return {"attribution": "", "license": "", "website": "", "note": ""}
        d = r.json()
    except Exception:
        return {"attribution": "", "license": "", "website": "", "note": ""}
    layers = (d.get("layers") or {}).get("addresses") or []
    for layer in layers:
        attribution = (layer.get("attribution") or "").strip()
        if attribution:
            return {
                "attribution": attribution,
                "license": layer.get("license") or "",
                "website": layer.get("website") or "",
                "note": (layer.get("note") or d.get("note") or "").strip(),
            }
    # No layer-level attribution; fall back to top-level fields (older schema)
    # or just the website if that's all we have.
    if layers:
        layer = layers[0]
        return {
            "attribution": "",
            "license": layer.get("license") or d.get("license") or "",
            "website": layer.get("website") or d.get("website") or "",
            "note": (layer.get("note") or d.get("note") or "").strip(),
        }
    return {
        "attribution": "",
        "license": d.get("license") or "",
        "website": d.get("website") or "",
        "note": (d.get("note") or "").strip(),
    }


def persist_attribution_manifest(runs: list[dict], workers: int = 24) -> None:
    """Write data/v2/oa/attribution.json with per-source attribution + license.

    OA's redistribution terms require downstream consumers to surface the
    originating authority for each source. The /api/data endpoint doesn't
    include attribution text -- that lives in OA's per-source manifests on
    GitHub. We fetch them concurrently and cache the result.

    Idempotent: re-running just re-fetches and writes again. Cheap: each
    manifest is a few KB and raw.githubusercontent.com is CDN-backed.
    """
    import datetime
    paths = []
    for r in runs:
        src = r.get("source", "")
        state = src.split("/")[1].upper() if src.startswith("us/") and "/" in src[3:] else ""
        paths.append((src, state))
    paths.sort(key=lambda p: p[0])

    log(f"  enriching {len(paths)} OA sources from {OA_SOURCE_RAW}/...")
    start = time.time()
    sources = [None] * len(paths)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {
            ex.submit(_fetch_one_source_attribution, src): (i, src, state)
            for i, (src, state) in enumerate(paths)
        }
        done_count = 0
        for fut in concurrent.futures.as_completed(futures):
            i, src, state = futures[fut]
            try:
                fields = fut.result()
            except Exception:
                fields = {"attribution": "", "license": "", "website": "", "note": ""}
            sources[i] = {"source": src, "state": state, **fields}
            done_count += 1
            if done_count % 250 == 0 or done_count == len(paths):
                elapsed = time.time() - start
                with_attr = sum(1 for s in sources if s and s["attribution"])
                log(f"  enrich progress: {done_count}/{len(paths)} ({with_attr} with attribution), {elapsed:.0f}s")

    out = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "source": "https://batch.openaddresses.io/api/data + per-source enrichment from " + OA_SOURCE_RAW,
        "count": len(sources),
        "with_attribution": sum(1 for s in sources if s["attribution"]),
        "with_license": sum(1 for s in sources if s["license"]),
        "sources": sources,
    }
    OA_DIR.mkdir(parents=True, exist_ok=True)
    path = OA_DIR / "attribution.json"
    path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    log(f"  wrote per-source attribution manifest -> {path}")
    log(f"    {len(sources)} sources, {out['with_attribution']} with attribution text, {out['with_license']} with license")


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
    ap.add_argument(
        "--metadata-only",
        action="store_true",
        help="Discover sources + refresh data/v2/oa/attribution.json (incl. "
             "per-source attribution from OA GitHub), then exit without "
             "downloading the GeoJSONs.",
    )
    args = ap.parse_args(argv)

    runs = list_us_address_sources()
    if args.states:
        accept = {s.upper() for s in args.states}
        runs = [r for r in runs if r["source"].split("/")[1].upper() in accept]
        log(f"  filtered to {len(runs)} sources for {accept}")

    if args.metadata_only:
        log("metadata-only: skipping GeoJSON downloads.")
        return 0

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
