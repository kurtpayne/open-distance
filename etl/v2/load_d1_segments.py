#!/usr/bin/env python3
"""Load per-state TIGER segments into each D1 shard.

Schema:
  CREATE TABLE segments (
    id INTEGER PK AUTOINCREMENT,
    street_normalized TEXT,
    zip TEXT,
    from_hn INTEGER, to_hn INTEGER,
    side TEXT,
    from_lat REAL, from_lon REAL,
    to_lat REAL, to_lon REAL
  );
  CREATE INDEX idx_segments_street ON segments(street_normalized);

Bulk-loaded the same way the addresses loader does -- the Worker fallback
queries this table when the addresses table misses.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import os
import sys
import time
from pathlib import Path

import aiohttp

from etl.v2.config import DATA
from etl.v2.states import BY_CODE


ROWS_PER_INSERT = 250
CONCURRENCY = 6
STATE_PARALLELISM = 6
RATE_LIMIT_BACKOFF_S = 5.0

SCHEMA_SQL = """
DROP TABLE IF EXISTS segments;
CREATE TABLE segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  street_normalized TEXT NOT NULL,
  zip TEXT,
  from_hn INTEGER,
  to_hn INTEGER,
  side TEXT,
  from_lat REAL,
  from_lon REAL,
  to_lat REAL,
  to_lon REAL
);
CREATE INDEX idx_segments_street ON segments(street_normalized);
"""


def log(msg: str) -> None:
    print(f"[d1-seg {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def parse_bindings(toml_path: Path) -> dict[str, str]:
    out = {}
    cur = {}
    for line in toml_path.read_text().splitlines():
        line = line.strip()
        if line.startswith("[[d1_databases]]"):
            if cur.get("binding") and cur.get("database_id"):
                out[cur["binding"]] = cur["database_id"]
            cur = {}
        elif "=" in line:
            k, v = line.split("=", 1)
            cur[k.strip()] = v.strip().strip('"')
    if cur.get("binding") and cur.get("database_id"):
        out[cur["binding"]] = cur["database_id"]
    return out


def esc(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


async def d1_query(session: aiohttp.ClientSession, account_id: str, db_id: str, sql: str, max_retries: int = 5) -> dict:
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{db_id}/query"
    backoff = RATE_LIMIT_BACKOFF_S
    for attempt in range(max_retries):
        async with session.post(url, json={"sql": sql}) as r:
            data = await r.json()
            if data.get("success"):
                return data
            err_str = str(data.get("errors") or data)
            if any(c in err_str for c in ("971", "7429", "rate")):
                if attempt + 1 < max_retries:
                    await asyncio.sleep(backoff); backoff *= 1.7; continue
            raise RuntimeError(f"d1 error: {data}")
    raise RuntimeError("d1: exhausted retries")


def segments_csv(version: str, state: str) -> Path:
    return DATA / "out" / version / "segments" / f"{state}.csv"


async def load_state(
    session: aiohttp.ClientSession,
    account_id: str,
    state: str,
    db_id: str,
    csv_path: Path,
) -> int:
    log(f"{state}: reset segments table")
    await d1_query(session, account_id, db_id, SCHEMA_SQL)

    batches: list[str] = []
    cur: list[str] = []
    total = 0
    with open(csv_path) as f:
        r = csv.reader(f); next(r)
        for row in r:
            if len(row) < 10:
                continue
            try:
                _, street, zipc, lo, hi, side, fla, flo, tla, tlo = row[:10]
                lo_i = int(lo); hi_i = int(hi)
                fla_f = float(fla); flo_f = float(flo)
                tla_f = float(tla); tlo_f = float(tlo)
            except (ValueError, IndexError):
                continue
            if not street:
                continue
            cur.append(
                f"({esc(street)}, {esc(zipc or '')}, {lo_i}, {hi_i}, {esc(side or '')}, "
                f"{fla_f}, {flo_f}, {tla_f}, {tlo_f})"
            )
            total += 1
            if len(cur) >= ROWS_PER_INSERT:
                batches.append("INSERT INTO segments (street_normalized, zip, from_hn, to_hn, side, "
                               "from_lat, from_lon, to_lat, to_lon) VALUES\n" + ",\n".join(cur) + ";")
                cur = []
        if cur:
            batches.append("INSERT INTO segments (street_normalized, zip, from_hn, to_hn, side, "
                           "from_lat, from_lon, to_lat, to_lon) VALUES\n" + ",\n".join(cur) + ";")

    log(f"{state}: {len(batches)} batches, {total:,} segments")
    sem = asyncio.Semaphore(CONCURRENCY)
    failed = 0
    async def run_one(sql: str):
        nonlocal failed
        async with sem:
            try:
                await d1_query(session, account_id, db_id, sql)
            except Exception as e:
                failed += 1
                log(f"  {state}: batch failed: {e}")
    start = time.time()
    await asyncio.gather(*(run_one(b) for b in batches))
    elapsed = time.time() - start
    log(f"{state}: done in {elapsed:.1f}s ({total:,} segments, {failed} batch fails)")
    return total


async def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument(
        "--bindings",
        default=None,
        help="Path to a toml file with [[d1_databases]] entries. "
             "Defaults to wrangler.toml at the repo root.",
    )
    ap.add_argument("states", nargs="*")
    args = ap.parse_args(argv)
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not token or not account_id:
        print("ERROR: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID required", file=sys.stderr)
        return 1

    toml_path = Path(args.bindings) if args.bindings else DATA.parent.parent / "wrangler.toml"
    bindings = parse_bindings(toml_path)
    states = args.states if args.states else sorted(BY_CODE)
    queue: list[tuple[str, str, Path]] = []
    for s in states:
        db_id = bindings.get(f"GEOCODE_{s}")
        if not db_id:
            log(f"WARN: no binding for {s}, skip"); continue
        csvp = segments_csv(args.version, s)
        if not csvp.exists():
            log(f"WARN: no segments CSV for {s}, skip"); continue
        queue.append((s, db_id, csvp))

    conn = aiohttp.TCPConnector(limit=CONCURRENCY * STATE_PARALLELISM + 8)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    timeout = aiohttp.ClientTimeout(total=120, connect=15)
    async with aiohttp.ClientSession(connector=conn, headers=headers, timeout=timeout) as session:
        sem_states = asyncio.Semaphore(STATE_PARALLELISM)
        async def gated(s, db_id, csv_p):
            async with sem_states:
                return await load_state(session, account_id, s, db_id, csv_p)
        results = await asyncio.gather(*(gated(*x) for x in queue), return_exceptions=True)
        total = sum(r for r in results if isinstance(r, int))
        log(f"all done: {total:,} segments across {len(queue)} states")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
