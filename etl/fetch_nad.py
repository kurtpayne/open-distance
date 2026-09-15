#!/usr/bin/env python3
"""Download the National Address Database (NAD) text release from US DOT.

Idempotent: skip if a valid ZIP64 already exists at the target path.
"""
from __future__ import annotations

import datetime
import json
import sys
import zipfile
from pathlib import Path

import requests

from etl.config import DATA


NAD_URL = "https://data.transportation.gov/download/fc2s-wawr/application/x-zip-compressed"
NAD_DIR = DATA / "nad"
NAD_ZIP = NAD_DIR / "nad-txt.zip"
NAD_META = NAD_DIR / "nad-txt.meta.json"
MIN_BYTES = 4 * 1024 * 1024 * 1024  # ~4 GB threshold (current release is ~8 GB)


def log(msg: str) -> None:
    print(f"[fetch-nad] {msg}", flush=True)


def is_valid(zip_path: Path) -> bool:
    if not zip_path.exists() or zip_path.stat().st_size < MIN_BYTES:
        return False
    try:
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            return any(n.endswith(".txt") for n in names)
    except zipfile.BadZipFile:
        return False


def write_meta(etag: str | None) -> None:
    """Record what we have on disk (url, bytes, upstream etag, download time).

    On a cache hit the existing etag/downloaded_at are preserved; only the byte
    count is refreshed from the file.
    """
    prev = {}
    if NAD_META.exists():
        try:
            prev = json.loads(NAD_META.read_text())
        except ValueError:
            prev = {}
    meta = {
        "url": NAD_URL,
        "bytes": NAD_ZIP.stat().st_size,
        "etag": etag if etag is not None else prev.get("etag"),
        "downloaded_at": (
            datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
            if etag is not None or not prev.get("downloaded_at")
            else prev["downloaded_at"]
        ),
    }
    NAD_META.write_text(json.dumps(meta, indent=2) + "\n")
    log(f"meta -> {NAD_META}")


def download() -> Path:
    NAD_DIR.mkdir(parents=True, exist_ok=True)
    if is_valid(NAD_ZIP):
        log(f"NAD cached: {NAD_ZIP} ({NAD_ZIP.stat().st_size/1e9:.1f} GB)")
        write_meta(None)
        return NAD_ZIP

    tmp = NAD_ZIP.with_suffix(".zip.part")
    log(f"GET {NAD_URL}")
    with requests.get(NAD_URL, stream=True, timeout=600, headers={"User-Agent": "Mozilla/5.0 open-distance"}) as r:
        r.raise_for_status()
        etag = r.headers.get("ETag")
        seen = 0
        chunk = 4 * 1024 * 1024
        next_log = 100 * 1024 * 1024
        with open(tmp, "wb") as f:
            for buf in r.iter_content(chunk_size=chunk):
                if not buf:
                    continue
                f.write(buf)
                seen += len(buf)
                if seen >= next_log:
                    log(f"  {seen/1e9:5.2f} GB")
                    next_log += 500 * 1024 * 1024
    tmp.rename(NAD_ZIP)
    if not is_valid(NAD_ZIP):
        log(f"ERROR: downloaded file is not a valid ZIP64 ({NAD_ZIP.stat().st_size} bytes)")
        sys.exit(1)
    log(f"NAD ready: {NAD_ZIP} ({NAD_ZIP.stat().st_size/1e9:.1f} GB)")
    write_meta(etag or "")
    return NAD_ZIP


def main() -> int:
    download()
    return 0


if __name__ == "__main__":
    sys.exit(main())
