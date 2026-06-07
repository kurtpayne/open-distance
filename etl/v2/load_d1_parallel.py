#!/usr/bin/env python3
"""Fast D1 shard loader via the Cloudflare D1 HTTP API.

For each state CSV (data/v2/out/<version>/addresses/<STATE>.csv):
  1. Reset the shard schema (idempotent).
  2. POST batched INSERT statements to D1 in parallel (concurrency-limited).
  3. Rebuild the FTS5 index at the end.

Why not wrangler: each `wrangler d1 execute --file` spawns Node.js
(seconds of overhead). For 80M rows across 49 shards we'd be there for days.
The HTTP API lets us batch + parallelize properly.

Auth: reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID from env.

Usage:
  python3 -m etl.v2.load_d1_parallel --version 2026-06 [STATE...]
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

from etl.v2.config import DATA, addresses_csv
from etl.v2.states import BY_CODE


ROWS_PER_INSERT = 250          # smaller batches: trigger overhead per row
CONCURRENCY = 6                # parallel HTTP per state -- keep under D1 burst limit
STATE_PARALLELISM = 6          # states in flight in parallel
RATE_LIMIT_BACKOFF_S = 5.0     # base backoff on 971 (rate-limit)


SCHEMA_SQL = """
DROP TRIGGER IF EXISTS addresses_ai;
DROP TABLE IF EXISTS addr_fts;
DROP TABLE IF EXISTS addresses;
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  tier TEXT NOT NULL
);
CREATE VIRTUAL TABLE addr_fts USING fts5(normalized, content='addresses', content_rowid='id');
CREATE TRIGGER addresses_ai AFTER INSERT ON addresses BEGIN
  INSERT INTO addr_fts(rowid, normalized) VALUES (new.id, new.normalized);
END;
"""

# Not used (FTS now populated via trigger), kept for legacy callers.
REBUILD_FTS_SQL = "SELECT 1;"


def log(msg: str) -> None:
    print(f"[d1-parallel {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def parse_bindings(toml_path: Path) -> dict[str, str]:
    """Parse wrangler.toml-style [[d1_databases]] blocks for shard ids."""
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
            v = v.strip().strip('"')
            cur[k.strip()] = v
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
            err = data.get("errors") or data.get("messages") or []
            err_str = str(err)
            # Retry on 971 (rate limit) and 7429 (CPU exceeded) with backoff.
            if any(code in err_str for code in ("971", "7429", "rate")):
                if attempt + 1 < max_retries:
                    await asyncio.sleep(backoff)
                    backoff *= 1.7
                    continue
            raise RuntimeError(f"d1 error: {err}")
    raise RuntimeError("d1 query: exhausted retries")


async def load_state(
    session: aiohttp.ClientSession,
    account_id: str,
    state: str,
    db_id: str,
    csv_path: Path,
) -> int:
    log(f"{state}: schema reset ({db_id})")
    await d1_query(session, account_id, db_id, SCHEMA_SQL)

    # Build batched INSERTs.
    batches: list[str] = []
    cur_values: list[str] = []
    with open(csv_path) as f:
        r = csv.reader(f); next(r)  # header
        for row in r:
            if len(row) < 5:
                continue
            _id, norm, lat, lon, tier = row
            try:
                lat = float(lat); lon = float(lon)
            except ValueError:
                continue
            cur_values.append(f"({esc(norm)}, {lat}, {lon}, {esc(tier)})")
            if len(cur_values) >= ROWS_PER_INSERT:
                batches.append("INSERT INTO addresses (normalized, lat, lon, tier) VALUES\n" +
                               ",\n".join(cur_values) + ";")
                cur_values = []
        if cur_values:
            batches.append("INSERT INTO addresses (normalized, lat, lon, tier) VALUES\n" +
                           ",\n".join(cur_values) + ";")

    total_rows = sum(b.count("(") for b in batches)
    log(f"{state}: {len(batches)} INSERT batches, {total_rows:,} rows")

    sem = asyncio.Semaphore(CONCURRENCY)
    failed: list[int] = []

    async def run_one(i: int, sql: str):
        async with sem:
            try:
                await d1_query(session, account_id, db_id, sql)
            except Exception as e:
                # Retry once.
                try:
                    await asyncio.sleep(1.0)
                    await d1_query(session, account_id, db_id, sql)
                except Exception as e2:
                    failed.append(i)
                    log(f"  {state}: batch {i} FAILED: {e2}")

    start = time.time()
    tasks = [run_one(i, b) for i, b in enumerate(batches)]
    # Progress reporter
    done = 0
    last_report = time.time()
    for chunk in [tasks[i:i+CONCURRENCY*2] for i in range(0, len(tasks), CONCURRENCY*2)]:
        await asyncio.gather(*chunk)
        done += len(chunk)
        if time.time() - last_report > 15:
            log(f"  {state}: {done}/{len(batches)} batches done")
            last_report = time.time()

    if failed:
        log(f"  {state}: {len(failed)} batches failed (will need a partial reload)")
    elapsed = time.time() - start
    inserted = total_rows - len(failed) * ROWS_PER_INSERT
    rate = inserted / elapsed if elapsed > 0 else 0
    log(f"{state}: done in {elapsed:.1f}s ({rate:.0f} rows/s, {inserted:,} inserted)")
    return inserted


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
        print("ERROR: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID required", file=sys.stderr)
        return 1

    toml_path = Path(args.bindings) if args.bindings else DATA.parent.parent / "wrangler.toml"
    bindings = parse_bindings(toml_path)
    log(f"loaded {len(bindings)} bindings from {toml_path}")

    states = args.states if args.states else sorted(BY_CODE)
    states_to_load: list[tuple[str, str, Path]] = []
    for s in states:
        binding = f"GEOCODE_{s}"
        db_id = bindings.get(binding)
        if not db_id:
            log(f"WARN: no binding for {s} (skip)")
            continue
        csv_path = addresses_csv(args.version, s)
        if not csv_path.exists():
            log(f"WARN: missing CSV for {s} (skip)")
            continue
        states_to_load.append((s, db_id, csv_path))

    if not states_to_load:
        log("nothing to load")
        return 1

    conn = aiohttp.TCPConnector(limit=CONCURRENCY * STATE_PARALLELISM + 8)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    timeout = aiohttp.ClientTimeout(total=120, connect=15)
    async with aiohttp.ClientSession(connector=conn, headers=headers, timeout=timeout) as session:
        sem_states = asyncio.Semaphore(STATE_PARALLELISM)

        async def gated(s, db_id, csv_path):
            async with sem_states:
                return await load_state(session, account_id, s, db_id, csv_path)

        results = await asyncio.gather(*(gated(*x) for x in states_to_load), return_exceptions=True)
        total = 0
        for r in results:
            if isinstance(r, int):
                total += r
        log(f"all done: {total:,} rows loaded across {len(states_to_load)} states")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
