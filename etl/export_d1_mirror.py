#!/usr/bin/env python3
"""Read every live D1 shard back into a local *mirror* (read-only, ~$0).

Why: the June CSVs are not a reliable picture of D1 (ids were reassigned by
AUTOINCREMENT under 6-way concurrency, one WI segments batch was lost, and the
loader's blind retry may have double-inserted batches).  The delta loader
(etl/sync_d1.py) diffs the new CSVs against THIS mirror, never against a CSV.

Per state and table the mirror is two aligned numpy arrays sorted by key:
  data/v2/state/mirror/<ST>.<kind>.keys.npy   uint64 content hash (etl/rowkey.py)
  data/v2/state/mirror/<ST>.<kind>.ids.npy    int64  D1 primary key
A key may appear more than once (duplicate rows) -> the multimap is just the
run of equal keys.  A JSON sidecar records counts, max id, size_after, the
trigger list and when the export happened.

Cost: rows read only (~$0.001/M; inside the 25B/month included tier).
Resumable: the cursor + partial arrays are checkpointed every few pages.

Usage:
  python3 -m etl.export_d1_mirror [--kind addresses|segments|both] [--states DC WY ...]
"""
from __future__ import annotations

import argparse
import array
import asyncio
import json
import sys
import time
from pathlib import Path

import numpy as np

from etl.config import DATA, ROOT
from etl.d1_http import D1Client, Ledger, TokenBucket, env_auth, make_session, parse_bindings
from etl.rowkey import addr_key, addr_row_from_d1, seg_key, seg_row_from_d1
from etl.states import BY_CODE

MIRROR_DIR = DATA / "state" / "mirror"

SELECT = {
    # NOTE: the text id is aliased id_text, never `id`: SQLite resolves a bare
    # `id` in WHERE/ORDER BY to the result alias, which turns the cursor walk
    # into a lexicographic one (pages skip and repeat).
    "addresses": "SELECT CAST(a.id AS TEXT) AS id_text, a.normalized, a.lat, a.lon, a.tier FROM addresses a "
                 "WHERE a.id > CAST(? AS INTEGER) ORDER BY a.id LIMIT ?",
    "segments": "SELECT CAST(s.id AS TEXT) AS id_text, s.street_normalized, s.zip, s.from_hn, s.to_hn, s.side, "
                "s.from_lat, s.from_lon, s.to_lat, s.to_lon FROM segments s "
                "WHERE s.id > CAST(? AS INTEGER) ORDER BY s.id LIMIT ?",
}
KEYF = {"addresses": (addr_row_from_d1, addr_key), "segments": (seg_row_from_d1, seg_key)}


def log(msg: str) -> None:
    print(f"[mirror {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def mirror_paths(state: str, kind: str) -> dict[str, Path]:
    b = str(MIRROR_DIR / f"{state}.{kind}")
    return {
        "keys": Path(b + ".keys.npy"),
        "ids": Path(b + ".ids.npy"),
        "meta": Path(b + ".json"),
        "part_keys": Path(b + ".part.keys"),
        "part_ids": Path(b + ".part.ids"),
        "cursor": Path(b + ".cursor"),
    }


def load_mirror(state: str, kind: str) -> tuple[np.ndarray, np.ndarray, dict]:
    p = mirror_paths(state, kind)
    if not p["keys"].exists():
        raise FileNotFoundError(f"no mirror for {state}/{kind}: run etl.export_d1_mirror first")
    keys = np.load(p["keys"])
    ids = np.load(p["ids"])
    meta = json.loads(p["meta"].read_text())
    return keys, ids, meta


def save_mirror(state: str, kind: str, keys: np.ndarray, ids: np.ndarray, meta: dict) -> None:
    p = mirror_paths(state, kind)
    MIRROR_DIR.mkdir(parents=True, exist_ok=True)
    order = np.lexsort((ids, keys))  # sort by key, then id
    keys = keys[order]
    ids = ids[order]
    np.save(p["keys"], keys)
    np.save(p["ids"], ids)
    distinct = int(np.unique(keys).size) if keys.size else 0
    meta = dict(meta)
    meta.update({
        "rows": int(keys.size),
        "distinct_keys": distinct,
        "duplicate_rows": int(keys.size) - distinct,
        "max_id": int(ids.max()) if ids.size else 0,
    })
    p["meta"].write_text(json.dumps(meta, indent=2, sort_keys=True))
    for k in ("part_keys", "part_ids", "cursor"):
        p[k].unlink(missing_ok=True)


async def export_state(client: D1Client, state: str, db_id: str, kind: str, page: int, fresh: bool) -> dict:
    p = mirror_paths(state, kind)
    MIRROR_DIR.mkdir(parents=True, exist_ok=True)
    if not fresh and p["keys"].exists() and not p["cursor"].exists():
        log(f"{state}/{kind}: mirror exists, skip (use --fresh to re-export)")
        return json.loads(p["meta"].read_text())

    keys = array.array("Q")
    ids = array.array("q")
    cursor = "0"
    if not fresh and p["cursor"].exists():
        cursor = p["cursor"].read_text().strip()
        with open(p["part_keys"], "rb") as f:
            keys.frombytes(f.read())
        with open(p["part_ids"], "rb") as f:
            ids.frombytes(f.read())
        log(f"{state}/{kind}: resuming at id > {cursor} ({len(keys):,} rows so far)")

    conv, keyf = KEYF[kind]
    sql = SELECT[kind]
    pages = 0
    t0 = time.time()
    size_after = None
    while True:
        results, metas = await client.query(db_id, sql, [cursor, page], label=f"{state}/{kind}")
        rows = results[0].get("results") or []
        if metas and metas[0].size_after is not None:
            size_after = metas[0].size_after
        for d in rows:
            keys.append(keyf(conv(d)))
            ids.append(int(d["id_text"]))
        pages += 1
        if not rows:
            break
        cursor = str(rows[-1]["id_text"])
        if len(rows) < page:
            break
        if pages % 25 == 0:
            with open(p["part_keys"], "wb") as f:
                f.write(keys.tobytes())
            with open(p["part_ids"], "wb") as f:
                f.write(ids.tobytes())
            p["cursor"].write_text(cursor)
        if pages % 100 == 0:
            rate = len(keys) / max(1e-9, time.time() - t0)
            log(f"  {state}/{kind}: {len(keys):,} rows ({rate:,.0f} rows/s)")

    # triggers + max(id) for the sidecar (cheap reads)
    trig, _ = await client.query(db_id, "SELECT name FROM sqlite_master WHERE type='trigger'", label=f"{state}/triggers")
    triggers = sorted(r["name"] for r in (trig[0].get("results") or []))

    meta = {
        "state": state,
        "kind": kind,
        "db_id": db_id,
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "size_after": size_after,
        "triggers": triggers,
        "pages": pages,
    }
    save_mirror(state, kind, np.frombuffer(keys.tobytes(), dtype=np.uint64).copy(),
                np.frombuffer(ids.tobytes(), dtype=np.int64).copy(), meta)
    meta = json.loads(p["meta"].read_text())
    log(f"{state}/{kind}: {meta['rows']:,} rows, {meta['duplicate_rows']:,} dup, max_id {meta['max_id']:,}, "
        f"size_after {size_after}, {time.time()-t0:.0f}s")
    return meta


async def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=["addresses", "segments", "both"], default="both")
    ap.add_argument("--states", nargs="*")
    ap.add_argument("--page", type=int, default=10000)
    ap.add_argument("--rps", type=float, default=10.0, help="global requests/second")
    ap.add_argument("--state-parallelism", type=int, default=4)
    ap.add_argument("--fresh", action="store_true", help="ignore an existing mirror/checkpoint")
    ap.add_argument("--bindings", default=str(ROOT / "wrangler.toml"))
    args = ap.parse_args(argv)

    token, acct = env_auth()
    bindings = parse_bindings(args.bindings)
    states = args.states or sorted(BY_CODE)
    kinds = ["addresses", "segments"] if args.kind == "both" else [args.kind]
    ledger = Ledger()
    bucket = TokenBucket(args.rps)
    sem = asyncio.Semaphore(args.state_parallelism)
    summary: dict[str, dict] = {}

    async with make_session(token, timeout_s=180) as session:
        client = D1Client(session, acct, bucket, ledger, log=log)

        async def one(state: str):
            db_id = bindings.get(f"GEOCODE_{state}")
            if not db_id:
                log(f"WARN: no binding for {state}")
                return
            async with sem:
                for kind in kinds:
                    try:
                        summary[f"{state}/{kind}"] = await export_state(client, state, db_id, kind, args.page, args.fresh)
                    except Exception as e:  # keep going; checkpoint allows resume
                        log(f"ERROR {state}/{kind}: {e}")
                        summary[f"{state}/{kind}"] = {"error": str(e)}

        await asyncio.gather(*(one(s) for s in states))

    out = MIRROR_DIR / "summary.json"
    prev = json.loads(out.read_text()) if out.exists() else {}
    prev.update(summary)
    out.write_text(json.dumps(prev, indent=2, sort_keys=True))
    log(f"done. ledger: {ledger.snapshot()} -> {out}")
    errors = [k for k, v in summary.items() if "error" in v]
    if errors:
        log(f"{len(errors)} export(s) failed: {errors}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
