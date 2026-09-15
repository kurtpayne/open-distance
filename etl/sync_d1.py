#!/usr/bin/env python3
"""Row-level delta loader for the per-state D1 shards.

Never DROPs a live shard.  For each state and table it

  plan    diff the new CSV (data/v2/out/<version>/...) against the local D1
          mirror (etl/export_d1_mirror.py) -> INS rows + DEL ids, forecast the
          rows written, run the gates, write a plan file
  apply   (only with --yes) bookmark the shard, install the FTS delete
          triggers, INSERT OR IGNORE the new rows with explicit ids, DELETE
          the vanished ids, verify counts, update the mirror + fingerprints

Every write statement is idempotent (explicit ids + OR IGNORE, delete by id),
so a lost response can be re-sent and a crashed run can be resumed from its
per-state checkpoint without double-writing.

Gates (not overridable by --yes):
  * key-correctness: |mirror keys ∩ previous-version CSV keys| / |CSV keys|
    must be >= 0.95 for every state in scope (exactly 1.0 expected)
  * churn: (|INS| + |DEL ids|) / rows_in_mirror >= 0.5 -> refuse unless
    --allow-rebuild ST (a full rebuild is cheaper past ~50%)
  * budget: forecast AND actual rows written must stay under --max-rows
  * ids: block base must exceed every id already in the shard; all ids < 2^53

Usage:
  python3 -m etl.sync_d1 --version 2026-09 --dry-run [--states DC WY]
  python3 -m etl.sync_d1 --version 2026-09 --states DC --yes --max-rows 2000000
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from etl.config import DATA, ROOT
from etl.d1_http import D1Client, D1PermanentError, Ledger, TokenBucket, env_auth, make_session, parse_bindings
from etl.export_d1_mirror import load_mirror, mirror_paths, save_mirror
from etl.rowkey import AddrRow, SegRow, addr_values, iter_csv_rows, seg_values
from etl.states import BY_CODE

import os as _os
STATE_DIR = Path(_os.environ["OD_STATE_DIR"]) if _os.environ.get("OD_STATE_DIR") else ROOT / "state"
FINGERPRINTS = STATE_DIR / "fingerprints.json"
CALIBRATION = STATE_DIR / "calibration.json"
PLAN_DIR = DATA / "state" / "plans"
CKPT_DIR = DATA / "state" / "checkpoints"
CSVKEY_DIR = DATA / "state" / "csvkeys"
LOG_DIR = DATA / "logs"

ID_BLOCK = 1 << 40
MAX_SAFE_ID = (1 << 53) - 1
ROWS_PER_STMT = 250
COUNT_CHUNK = 2_000_000

TABLE = {
    "addresses": {
        "insert": "INSERT OR IGNORE INTO addresses (id, normalized, lat, lon, tier) VALUES\n",
        "values": addr_values,
        "csv": lambda v, st: DATA / "out" / v / "addresses" / f"{st}.csv",
    },
    "segments": {
        "insert": "INSERT OR IGNORE INTO segments (id, street_normalized, zip, from_hn, to_hn, side, "
                  "from_lat, from_lon, to_lat, to_lon) VALUES\n",
        "values": seg_values,
        "csv": lambda v, st: DATA / "out" / v / "segments" / f"{st}.csv",
    },
}

PREAMBLE = [
    "CREATE TRIGGER IF NOT EXISTS addresses_ad AFTER DELETE ON addresses BEGIN\n"
    "  INSERT INTO addr_fts(addr_fts, rowid, normalized) VALUES('delete', old.id, old.normalized);\n"
    "END;",
    "CREATE TRIGGER IF NOT EXISTS addresses_au AFTER UPDATE ON addresses BEGIN\n"
    "  INSERT INTO addr_fts(addr_fts, rowid, normalized) VALUES('delete', old.id, old.normalized);\n"
    "  INSERT INTO addr_fts(rowid, normalized) VALUES (new.id, new.normalized);\n"
    "END;",
]


def log(msg: str) -> None:
    print(f"[sync {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def quarter_index(version: str) -> int:
    y, m = version.split("-")[:2]
    return (int(y) - 2026) * 4 + (int(m) - 1) // 3 + 1


def load_json(p: Path, default):
    return json.loads(p.read_text()) if p.exists() else default


def dump_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True))
    tmp.replace(p)


def db_names(toml_path: Path) -> dict[str, str]:
    """binding -> database_name (for wrangler time-travel)."""
    out, cur = {}, {}
    for line in toml_path.read_text().splitlines():
        line = line.strip()
        if line.startswith("[[d1_databases]]"):
            if cur.get("binding") and cur.get("database_name"):
                out[cur["binding"]] = cur["database_name"]
            cur = {}
        elif "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            cur[k.strip()] = v.strip().strip('"')
    if cur.get("binding") and cur.get("database_name"):
        out[cur["binding"]] = cur["database_name"]
    return out


def csv_keys(version: str, state: str, kind: str) -> np.ndarray:
    """Unique sorted uint64 keys of a CSV (cached as .npy)."""
    p = CSVKEY_DIR / version / f"{state}.{kind}.npy"
    src = TABLE[kind]["csv"](version, state)
    if p.exists() and (not src.exists() or p.stat().st_mtime >= src.stat().st_mtime):
        # cached keys stand in for a CSV that has since been deleted (disk policy)
        return np.load(p)
    if not src.exists():
        raise FileNotFoundError(f"{src} (and no cached keys at {p})")
    import array
    a = array.array("Q")
    for k, _ in iter_csv_rows(src, kind):
        a.append(k)
    keys = np.unique(np.frombuffer(a.tobytes(), dtype=np.uint64))
    p.parent.mkdir(parents=True, exist_ok=True)
    np.save(p, keys)
    return keys


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def time_travel_bookmark(db_name: str) -> str | None:
    try:
        out = subprocess.run(["npx", "wrangler", "d1", "time-travel", "info", db_name, "--json"],
                             capture_output=True, text=True, timeout=120, cwd=ROOT)
        txt = out.stdout.strip()
        m = re.search(r'"bookmark"\s*:\s*"([^"]+)"', txt) or re.search(r"([0-9a-f]{8}-[0-9a-f-]{20,})", txt)
        return m.group(1) if m else None
    except Exception as e:  # never block the run on the bookmark helper
        log(f"WARN: time-travel bookmark for {db_name} failed: {e}")
        return None


# ---------------------------------------------------------------------------
# plan
# ---------------------------------------------------------------------------
def plan_state(version: str, prev_version: str, state: str, kind: str, cal: dict, fp: dict,
               reuse: bool = False) -> dict | None:
    src = TABLE[kind]["csv"](version, state)
    if not src.exists():
        log(f"{state}/{kind}: no CSV at {src}, skip")
        return None
    if reuse:
        # Reuse a plan computed by an earlier --dry-run if the mirror and CSV are
        # unchanged since (saves re-hashing multi-GB CSVs before the writes).
        pp = PLAN_DIR / version / f"{state}.{kind}.json"
        if pp.exists():
            old = json.loads(pp.read_text())
            mp = mirror_paths(state, kind)
            mmeta = json.loads(mp["meta"].read_text())
            if (old.get("rows_mirror") == mmeta.get("rows") and old.get("mirror_max_id") == mmeta.get("max_id")
                    and pp.stat().st_mtime >= src.stat().st_mtime and old.get("A_ins") == (cal["A_ins"] if kind == "addresses" else cal["S_ins"])):
                log(f"{state}/{kind}: reusing plan {pp.name} (ins {old['ins']:,} del {old['del_ids']:,})")
                return old
            log(f"{state}/{kind}: existing plan is stale, re-planning")
    A_keys, A_ids, meta = load_mirror(state, kind)
    A_unique, A_first, A_counts = np.unique(A_keys, return_index=True, return_counts=True)
    B = csv_keys(version, state, kind)

    ins_keys = np.setdiff1d(B, A_unique, assume_unique=True)
    del_keys = np.setdiff1d(A_unique, B, assume_unique=True)

    # ids for DEL keys: every id carrying that key (multimap run)
    lefts = np.searchsorted(A_keys, del_keys, side="left")
    rights = np.searchsorted(A_keys, del_keys, side="right")
    del_ids = np.concatenate([A_ids[l:r] for l, r in zip(lefts, rights)]) if del_keys.size else np.zeros(0, np.int64)

    # duplicate cleanup for keys that survive: keep the lowest id, delete extras
    surv_dup = A_unique[(A_counts > 1) & np.isin(A_unique, B, assume_unique=True)]
    dl = np.searchsorted(A_keys, surv_dup, side="left")
    dr = np.searchsorted(A_keys, surv_dup, side="right")
    dup_extra_ids = np.concatenate([A_ids[l + 1:r] for l, r in zip(dl, dr)]) if surv_dup.size else np.zeros(0, np.int64)
    del_ids = np.unique(np.concatenate([del_ids, dup_extra_ids]))

    # key-correctness gate vs the previous version's CSV
    key_ratio = None
    prev_csv = TABLE[kind]["csv"](prev_version, state)
    if prev_csv.exists() or (CSVKEY_DIR / prev_version / f"{state}.{kind}.npy").exists():
        J = csv_keys(prev_version, state, kind)
        key_ratio = float(np.isin(J, A_unique, assume_unique=True).mean()) if J.size else 1.0

    # INS rows (second pass over the new CSV), ids assigned in key order
    ins_set = set(int(k) for k in ins_keys.tolist())
    ins_rows: dict[int, tuple] = {}
    if ins_set:
        for k, r in iter_csv_rows(src, kind):
            if k in ins_set and k not in ins_rows:
                ins_rows[k] = r
    base = ID_BLOCK * quarter_index(version)
    prev_max = int(meta.get("max_id") or 0)
    if prev_max >= base:
        # a later block is already in use (e.g. re-run in the same quarter); continue above it
        base = ((prev_max // ID_BLOCK) + 1) * ID_BLOCK
    ins_list = []
    for i, k in enumerate(sorted(ins_rows), start=1):
        ins_list.append([base + i, int(k), list(ins_rows[k])])
    if ins_list and ins_list[-1][0] > MAX_SAFE_ID:
        raise SystemExit(f"{state}/{kind}: ids would exceed 2^53")

    # jitter report (addresses only): INS/DEL pairs with the same normalized text
    jitter = None
    if kind == "addresses" and del_keys.size and ins_list and prev_csv.exists():
        del_set = set(int(k) for k in del_keys.tolist())
        by_norm: dict[str, list] = {}
        for k, r in iter_csv_rows(prev_csv, kind):
            if k in del_set:
                by_norm.setdefault(r.normalized, []).append(r)
        b1 = b10 = b_far = 0
        for _id, _k, row in ins_list:
            r = AddrRow(*row)
            cands = by_norm.get(r.normalized)
            if not cands:
                continue
            d = min(haversine_m(r.lat, r.lon, c.lat, c.lon) for c in cands)
            if d < 1:
                b1 += 1
            elif d < 10:
                b10 += 1
            else:
                b_far += 1
        jitter = {"pairs_lt_1m": b1, "pairs_1_10m": b10, "pairs_gt_10m": b_far,
                  "sub_metre_share_of_ins": round(b1 / max(1, len(ins_list)), 4)}

    a_ins = cal["A_ins"] if kind == "addresses" else cal["S_ins"]
    a_del = cal["A_del"] if kind == "addresses" else cal["S_del"]
    n_stmts = math.ceil(len(ins_list) / ROWS_PER_STMT) + math.ceil(del_ids.size / ROWS_PER_STMT)
    forecast = int(len(ins_list) * a_ins + del_ids.size * a_del + n_stmts)
    rows_mirror = int(A_keys.size)
    churn = (len(ins_list) + int(del_ids.size)) / max(1, rows_mirror)

    plan = {
        "version": version, "prev_version": prev_version, "state": state, "kind": kind,
        "db_id": meta["db_id"], "rows_mirror": rows_mirror, "mirror_duplicates": int(meta.get("duplicate_rows", 0)),
        "csv_rows_unique": int(B.size), "ins": len(ins_list), "del_ids": int(del_ids.size),
        "del_keys": int(del_keys.size), "dup_extra_ids": int(dup_extra_ids.size),
        "key_ratio": key_ratio, "churn": round(churn, 4), "forecast_rows_written": forecast,
        "A_ins": a_ins, "A_del": a_del, "id_block_base": base, "jitter": jitter,
        "mirror_max_id": prev_max, "mirror_triggers": meta.get("triggers"),
        "ins_rows": ins_list, "del_id_list": [int(x) for x in del_ids.tolist()],
    }
    body = json.dumps({k: v for k, v in plan.items() if k not in ("ins_rows", "del_id_list")}, sort_keys=True)
    plan["plan_sha"] = hashlib.sha256((body + str(len(ins_list)) + str(del_ids.size)).encode()).hexdigest()[:16]
    dump_json(PLAN_DIR / version / f"{state}.{kind}.json", plan)
    return plan


SHRINK_LIMIT = 0.10  # a state losing >10% of its rows is almost always a broken input, not real change


def gate(plan: dict, allow_rebuild: set[str], allow_shrink: set[str] = frozenset()) -> list[str]:
    problems = []
    net = plan["ins"] - plan["del_ids"]
    if plan["rows_mirror"] and -net / plan["rows_mirror"] > SHRINK_LIMIT and plan["state"] not in allow_shrink:
        problems.append(f"net row loss {-net:,} ({-net / plan['rows_mirror']:.1%} of the shard) > {SHRINK_LIMIT:.0%}: "
                        f"suspect a truncated/corrupt input (pass --allow-shrink {plan['state']} if it is real)")
    if plan["key_ratio"] is not None and plan["key_ratio"] < 0.95:
        problems.append(f"key ratio {plan['key_ratio']:.3f} < 0.95 (diff key mismatch)")
    if plan["key_ratio"] is None:
        problems.append("no previous-version CSV to check the diff key against")
    if plan["churn"] >= 0.5 and plan["state"] not in allow_rebuild:
        problems.append(f"churn {plan['churn']:.1%} >= 50%: cheaper to rebuild (pass --allow-rebuild {plan['state']})")
    if plan["mirror_max_id"] >= plan["id_block_base"]:
        problems.append("id block base does not exceed existing ids")
    return problems


def print_plan_table(plans: list[dict], cap: int) -> int:
    hdr = f"{'state':<5} {'kind':<9} {'mirror':>11} {'ins':>9} {'del':>9} {'churn':>7} {'key':>6} {'jit<1m':>7} {'forecast':>12} {'cum':>12}"
    print(hdr)
    print("-" * len(hdr))
    cum = 0
    for p in sorted(plans, key=lambda x: x["forecast_rows_written"]):
        cum += p["forecast_rows_written"]
        j = p["jitter"]["sub_metre_share_of_ins"] if p.get("jitter") else None
        print(f"{p['state']:<5} {p['kind']:<9} {p['rows_mirror']:>11,} {p['ins']:>9,} {p['del_ids']:>9,} "
              f"{p['churn']:>7.2%} {(p['key_ratio'] if p['key_ratio'] is not None else float('nan')):>6.3f} "
              f"{(f'{j:.0%}' if j is not None else '-'):>7} {p['forecast_rows_written']:>12,} {cum:>12,}")
    print(f"\nforecast total {cum:,} rows written; cap {cap:,}; est. $ above a fresh 50M allowance: "
          f"${max(0, cum - 50_000_000) / 1e6:,.2f}")
    return cum


# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------
class Budget:
    def __init__(self, cap: int, ledger: Ledger):
        self.cap = cap
        self.ledger = ledger
        self.stop = False

    def check(self) -> None:
        if self.ledger.committed_rows_written > self.cap:
            self.stop = True
            raise RuntimeError(f"--max-rows {self.cap:,} exceeded (actual {self.ledger.committed_rows_written:,})")


async def apply_state(client: D1Client, plan: dict, args, budget: Budget, names: dict, fp: dict) -> dict:
    state, kind, db_id = plan["state"], plan["kind"], plan["db_id"]
    valuesf = TABLE[kind]["values"]
    ckpt_path = CKPT_DIR / plan["version"] / f"{state}.{kind}.json"
    ck = load_json(ckpt_path, None)
    if ck and ck.get("plan_sha") != plan["plan_sha"]:
        raise SystemExit(f"{state}/{kind}: checkpoint is for a different plan ({ck.get('plan_sha')} != {plan['plan_sha']}); "
                         f"delete {ckpt_path} to start over")
    if not ck:
        bookmark = None if args.no_bookmark else time_travel_bookmark(names.get(f"GEOCODE_{state}", f"od-geo-{state.lower()}"))
        ck = {"plan_sha": plan["plan_sha"], "phase": "start", "bookmark_before": bookmark,
              "rollback_deadline": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 30 * 86400)),
              "next_insert": 0, "next_delete": 0, "rows_written": 0, "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        dump_json(ckpt_path, ck)
    log(f"{state}/{kind}: apply ins={plan['ins']:,} del={plan['del_ids']:,} forecast={plan['forecast_rows_written']:,} "
        f"(resume from ins#{ck['next_insert']} del#{ck['next_delete']}; bookmark {ck['bookmark_before']})")

    written_before = client.ledger.per_db.get(db_id, {}).get("rows_written", 0)
    prior_rows_written = int(ck.get("rows_written", 0))  # from earlier (crashed) runs; fixed for this run

    def rw() -> int:
        return client.ledger.per_db.get(db_id, {}).get("rows_written", 0) - written_before + prior_rows_written

    # count before (only on a fresh start)
    if ck["phase"] == "start":
        ck["count_before"] = await chunked_count(client, db_id, kind, plan)
        if kind == "addresses":
            for sql in PREAMBLE:
                await client.query(db_id, sql, label=f"{state}/preamble")
        ck["phase"] = "insert"
        dump_json(ckpt_path, ck)

    ins_rows = plan["ins_rows"]
    stmts = [TABLE[kind]["insert"] + ",\n".join(valuesf(r[0], (AddrRow if kind == "addresses" else SegRow)(*r[2]))
                                              for r in ins_rows[i:i + ROWS_PER_STMT]) + ";"
             for i in range(0, len(ins_rows), ROWS_PER_STMT)]
    k = args.stmts_per_request
    if ck["phase"] == "insert":
        i = ck["next_insert"]
        t0 = time.time()
        while i < len(stmts):
            group = stmts[i:i + k]
            try:
                _, metas = await client.query(db_id, "\n".join(group), label=f"{state}/ins{i}")
            except asyncio.TimeoutError:
                k = max(1, k // 2)
                log(f"  {state}: timeout -> {k} stmts/request")
                continue
            if metas and max(m.duration_ms for m in metas) > 10_000 and k > 1:
                k = max(1, k // 2)
            i += len(group)
            ck["next_insert"] = i
            ck["rows_written"] = rw()
            dump_json(ckpt_path, ck)
            budget.check()
            if args.abort_after_requests and client.ledger.requests >= args.abort_after_requests:
                raise RuntimeError("drill: simulated crash mid-insert")
            done_rows = min(i * ROWS_PER_STMT, len(ins_rows))
            if rw() > 1.5 * (done_rows * plan["A_ins"] + i) + 5000:
                raise RuntimeError(f"{state}: actual rows written {rw():,} > 1.5x forecast so far; aborting")
            if i % (k * 50) == 0:
                log(f"  {state}/{kind}: ins {i}/{len(stmts)} stmts, {rw():,} rows written, {time.time()-t0:.0f}s")
        ck["phase"] = "delete"
        dump_json(ckpt_path, ck)

    del_ids = plan["del_id_list"]
    dstmts = [f"DELETE FROM {kind} WHERE id IN ({','.join(str(x) for x in del_ids[i:i + ROWS_PER_STMT])});"
              for i in range(0, len(del_ids), ROWS_PER_STMT)]
    if ck["phase"] == "delete":
        i = ck["next_delete"]
        while i < len(dstmts):
            group = dstmts[i:i + k]
            try:
                await client.query(db_id, "\n".join(group), label=f"{state}/del{i}")
            except asyncio.TimeoutError:
                k = max(1, k // 2)
                continue
            i += len(group)
            ck["next_delete"] = i
            ck["rows_written"] = rw()
            dump_json(ckpt_path, ck)
            budget.check()
        ck["phase"] = "verify"
        dump_json(ckpt_path, ck)

    # verify: expected derives from the MIRROR (what D1 held at export), so it
    # survives partial runs and lost checkpoints; count_before is reported as a
    # drift check (it differs from the mirror only if something else wrote).
    count_after = await chunked_count(client, db_id, kind, plan)
    expected = plan["rows_mirror"] - len(del_ids) + len(ins_rows)
    ok = count_after == expected
    drift = ck.get("count_before", plan["rows_mirror"]) - plan["rows_mirror"]
    log(f"{state}/{kind}: count before {ck.get('count_before'):,} (mirror {plan['rows_mirror']:,}, drift {drift:+,}) -> "
        f"after {count_after:,} (expected {expected:,}) {'OK' if ok else 'MISMATCH'}; "
        f"rows written {rw():,} vs forecast {plan['forecast_rows_written']:,}")
    if kind == "addresses" and plan["rows_mirror"] < 1_000_000:
        try:
            await client.query(db_id, "INSERT INTO addr_fts(addr_fts, rank) VALUES('integrity-check', 0);", label=f"{state}/fts-check")
            log(f"{state}: FTS integrity-check (index-only) passed")
        except Exception as e:
            log(f"{state}: FTS integrity-check FAILED: {e}")
            ok = False
    result = {"state": state, "kind": kind, "ins": len(ins_rows), "del": len(del_ids), "forecast": plan["forecast_rows_written"],
              "actual_rows_written": rw(), "count_before": ck["count_before"], "count_after": count_after,
              "count_ok": ok, "bookmark_before": ck["bookmark_before"], "rollback_deadline": ck["rollback_deadline"]}
    if not ok:
        ck["phase"] = "verify-failed"
        dump_json(ckpt_path, ck)
        return result

    # commit: mirror + fingerprints
    keys, ids, meta = load_mirror(state, kind)
    if del_ids:
        keep = ~np.isin(ids, np.asarray(del_ids, dtype=np.int64))
        keys, ids = keys[keep], ids[keep]
    if ins_rows:
        keys = np.concatenate([keys, np.asarray([r[1] for r in ins_rows], dtype=np.uint64)])
        ids = np.concatenate([ids, np.asarray([r[0] for r in ins_rows], dtype=np.int64)])
    meta["last_sync"] = {"version": plan["version"], "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    save_mirror(state, kind, keys, ids, meta)
    fp.setdefault(state, {})[kind] = {
        "version": plan["version"], "db_id": db_id, "rows": int(count_after), "id_block_base": plan["id_block_base"],
        "rows_written_actual": rw(), "loaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bookmark_before": ck["bookmark_before"], "rollback_deadline": ck["rollback_deadline"],
    }
    dump_json(FINGERPRINTS, fp)
    ckpt_path.unlink(missing_ok=True)
    return result


async def chunked_count(client: D1Client, db_id: str, kind: str, plan: dict) -> int:
    hi = max(plan["mirror_max_id"], plan["id_block_base"] + plan["ins"] + 1)
    total = 0
    lo = 0
    # legacy id space in COUNT_CHUNK steps, then the new block(s) in one range
    edges = list(range(0, min(plan["mirror_max_id"], ID_BLOCK - 1) + COUNT_CHUNK, COUNT_CHUNK))
    ranges = [(edges[i], edges[i + 1] - 1) for i in range(len(edges) - 1)] + [(ID_BLOCK, hi)]
    for a, b in ranges:
        res, _ = await client.query(db_id, f"SELECT count(*) AS n FROM {kind} WHERE id BETWEEN {a} AND {b};", label=f"count {a}-{b}")
        total += int((res[0].get("results") or [{}])[0].get("n") or 0)
    return total


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
async def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--prev-version", default=None, help="version whose CSVs are the key-correctness reference (default: from fingerprints or 2026-06)")
    ap.add_argument("--states", nargs="*")
    ap.add_argument("--only", choices=["addresses", "segments", "both"], default="addresses")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--yes", action="store_true", help="actually write to D1")
    ap.add_argument("--max-rows", type=int, default=48_000_000, help="hard cap on ACTUAL rows written this run")
    ap.add_argument("--allow-rebuild", action="append", default=[], metavar="ST")
    ap.add_argument("--allow-shrink", action="append", default=[], metavar="ST",
                    help="accept a >10% net row loss for this state (default: refuse; usually a broken input)")
    ap.add_argument("--state-parallelism", type=int, default=4)
    ap.add_argument("--rps", type=float, default=10.0)
    ap.add_argument("--stmts-per-request", type=int, default=4)
    ap.add_argument("--no-bookmark", action="store_true", help="skip the wrangler time-travel bookmark")
    ap.add_argument("--reuse-plans", action="store_true", help="reuse plan files from an earlier --dry-run when mirror+CSV are unchanged")
    ap.add_argument("--bindings", default=str(ROOT / "wrangler.toml"))
    ap.add_argument("--abort-after-requests", type=int, default=0, help=argparse.SUPPRESS)  # resume drill hook
    args = ap.parse_args(argv)
    if not args.dry_run and not args.yes:
        ap.error("pass --dry-run or --yes")

    cal = load_json(CALIBRATION, {"A_ins": 3.1, "A_del": 3.1, "S_ins": 2.0, "S_del": 2.0, "source": "assumed-physical"})
    fp = load_json(FINGERPRINTS, {})
    states = args.states or sorted(BY_CODE)
    kinds = ["addresses", "segments"] if args.only == "both" else [args.only]
    log(f"calibration: {cal}")

    plans: list[dict] = []
    problems: dict[str, list[str]] = {}
    for st in states:
        # key-correctness reference = the CSV of the version the shard currently holds
        prev = args.prev_version or fp.get(st, {}).get("addresses", {}).get("version") or "2026-06"
        for kind in kinds:
            try:
                p = plan_state(args.version, prev, st, kind, cal, fp, reuse=args.reuse_plans)
            except FileNotFoundError as e:
                log(f"{st}/{kind}: {e}")
                continue
            if p is None:
                continue
            plans.append(p)
            probs = gate(p, set(args.allow_rebuild), set(args.allow_shrink))
            if probs:
                problems[f"{st}/{kind}"] = probs
    if not plans:
        log("nothing to do")
        return 1
    cum = print_plan_table(plans, args.max_rows)
    for k, v in problems.items():
        log(f"GATE {k}: " + "; ".join(v))
    if args.dry_run:
        log("dry-run: no writes")
        return 0
    if problems:
        log("refusing to apply: gates failed")
        return 2
    if cum > args.max_rows:
        log(f"refusing to apply: forecast {cum:,} > --max-rows {args.max_rows:,} (run fewer states or raise the cap)")
        return 2

    token, acct = env_auth()
    ledger = Ledger()
    budget = Budget(args.max_rows, ledger)
    names = db_names(Path(args.bindings))
    results = []
    sem = asyncio.Semaphore(args.state_parallelism)
    async with make_session(token) as session:
        client = D1Client(session, acct, TokenBucket(args.rps), ledger, log=log)

        async def one(p):
            async with sem:
                if budget.stop:
                    return
                try:
                    results.append(await apply_state(client, p, args, budget, names, fp))
                except Exception as e:
                    log(f"ERROR {p['state']}/{p['kind']}: {e}")
                    results.append({"state": p["state"], "kind": p["kind"], "error": str(e)})

        # smallest forecast first, TX last
        await asyncio.gather(*(one(p) for p in sorted(plans, key=lambda x: x["forecast_rows_written"])))

    report = {"version": args.version, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "calibration": cal,
              "ledger": ledger.snapshot(), "results": results}
    out = LOG_DIR / f"sync-{args.version}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    dump_json(out, report)
    bad = [r for r in results if r.get("error") or not r.get("count_ok")]
    log(f"done: {len(results) - len(bad)}/{len(results)} shards OK; rows written {ledger.committed_rows_written:,} "
        f"(failed attempts {ledger.failed_attempt_rows_written:,}); report {out}")
    for r in bad:
        log(f"  NOT OK: {r}")
    return 0 if not bad else 3


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
