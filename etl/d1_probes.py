#!/usr/bin/env python3
"""Metering probes against a SCRATCH D1 database (never a live shard).

Settles the facts every dollar figure depends on, using < 10K rows written:

  P0  id round-trip      a row with id 2^40+12345 reads back exactly
  P1  A_ins              meta.rows_written of ONE 250-row trigger INSERT
                         (~501 => workerd model, ~760 => physical shadow rows,
                          ~1250 => README's 5x)
  P1b columnsize=0 twin  whether FTS shadow rows are metered at all
  P2  OR IGNORE replay   re-send P1 verbatim: changes==0, rows_written~0 ?
  P2b A_del              rows_written of a 250-row DELETE through the AD trigger
  P3  DDL cost           DROP TABLE on 250- and 10K-row tables; CREATE TRIGGER
  P4  atomicity          a request whose 2nd statement fails: did the 1st persist?
  P5  FTS commands       'pgsz', 'automerge', 'merge' are permitted; no-op floor

Writes state/calibration.json with the measured factors.

Usage:
  wrangler d1 create od-geo-pilot        # human; copy the database_id
  python3 -m etl.d1_probes --db-id <uuid> [--csv data/v2/out/2026-06/addresses/DC.csv]
  wrangler d1 delete od-geo-pilot        # afterwards
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import sys
import time
from pathlib import Path

from etl.config import DATA, ROOT
from etl.d1_http import D1Client, Ledger, TokenBucket, env_auth, make_session
from etl.rowkey import addr_row_from_csv, addr_values

import os as _os
CAL_PATH = (Path(_os.environ["OD_STATE_DIR"]) if _os.environ.get("OD_STATE_DIR") else ROOT / "state") / "calibration.json"
ID_BASE = 1 << 40

SCHEMA = """
DROP TRIGGER IF EXISTS addresses_ai;
DROP TRIGGER IF EXISTS addresses_ad;
DROP TRIGGER IF EXISTS addresses_au;
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

AD_TRIGGER = """CREATE TRIGGER IF NOT EXISTS addresses_ad AFTER DELETE ON addresses BEGIN
  INSERT INTO addr_fts(addr_fts, rowid, normalized) VALUES('delete', old.id, old.normalized);
END;"""

TWIN = """
DROP TABLE IF EXISTS twin_fts;
DROP TABLE IF EXISTS twin;
CREATE TABLE twin (id INTEGER PRIMARY KEY, normalized TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, tier TEXT NOT NULL);
CREATE VIRTUAL TABLE twin_fts USING fts5(normalized, content='twin', content_rowid='id', columnsize=0);
CREATE TRIGGER twin_ai AFTER INSERT ON twin BEGIN
  INSERT INTO twin_fts(rowid, normalized) VALUES (new.id, new.normalized);
END;
"""


def log(msg: str) -> None:
    print(f"[probe {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def load_rows(csv_path: Path, n: int) -> list:
    out = []
    with open(csv_path, newline="") as f:
        rd = csv.reader(f)
        next(rd)
        for raw in rd:
            r = addr_row_from_csv(raw)
            if r is None:
                continue
            out.append(r)
            if len(out) >= n:
                break
    return out


def insert_sql(table: str, rows, base: int) -> str:
    vals = ",\n".join(addr_values(base + i, r) for i, r in enumerate(rows, start=1))
    return f"INSERT OR IGNORE INTO {table} (id, normalized, lat, lon, tier) VALUES\n{vals};"


async def run(args) -> int:
    token, acct = env_auth()
    ledger = Ledger()
    rows = load_rows(Path(args.csv), 10250)
    if len(rows) < 10250:
        raise SystemExit(f"need >= 10,250 rows in {args.csv}")
    r250 = rows[:250]
    findings: dict = {"db_id": args.db_id, "csv": str(args.csv), "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    async with make_session(token) as session:
        c = D1Client(session, acct, TokenBucket(5.0), ledger, log=log)

        async def q(sql, label, params=None):
            res, metas = await c.query(args.db_id, sql, params, label=label)
            return res, metas

        # --- schema
        _, m = await q(SCHEMA, "schema")
        findings["schema_rows_written"] = sum(x.rows_written for x in m)
        log(f"schema: rows_written={findings['schema_rows_written']}")

        # --- P0 id round-trip
        big = ID_BASE + 12345
        await q(f"INSERT OR IGNORE INTO addresses (id, normalized, lat, lon, tier) VALUES ({big}, 'p0 probe', 1.5, -2.25, 'rooftop');", "P0-insert")
        res, _ = await q("SELECT id, CAST(id AS TEXT) AS id_text, lat, lon FROM addresses WHERE id = ?", "P0-select", [str(big)])
        row = (res[0].get("results") or [{}])[0]
        findings["P0"] = {"expected": big, "id_number": row.get("id"), "id_text": row.get("id_text"),
                          "lat": row.get("lat"), "lon": row.get("lon"),
                          "ok": str(row.get("id_text")) == str(big) and int(row.get("id", -1)) == big}
        log(f"P0 id round-trip: {findings['P0']}")
        await q(f"DELETE FROM addresses WHERE id = {big};", "P0-cleanup")

        # --- P1 A_ins: one 250-row production INSERT
        sql250 = insert_sql("addresses", r250, ID_BASE)
        _, m = await q(sql250, "P1")
        findings["P1"] = {"rows": 250, "rows_written": m[0].rows_written, "changes": m[0].changes,
                          "duration_ms": m[0].duration_ms, "sql_bytes": len(sql250.encode())}
        a_ins = m[0].rows_written / 250
        findings["P1"]["A_ins"] = round(a_ins, 3)
        log(f"P1 A_ins: rows_written={m[0].rows_written} (A={a_ins:.2f}) changes={m[0].changes} dur={m[0].duration_ms:.0f}ms")

        # --- P1b columnsize=0 twin
        await q(TWIN, "twin-schema")
        _, m = await q(insert_sql("twin", r250, ID_BASE), "P1b")
        findings["P1b"] = {"rows_written": m[0].rows_written, "A_ins_columnsize0": round(m[0].rows_written / 250, 3),
                           "shadow_rows_metered": (findings["P1"]["rows_written"] - m[0].rows_written) >= 200}
        log(f"P1b columnsize=0: rows_written={m[0].rows_written} -> shadow rows metered: {findings['P1b']['shadow_rows_metered']}")

        # --- P2 OR IGNORE replay
        _, m = await q(sql250, "P2")
        findings["P2"] = {"rows_written": m[0].rows_written, "changes": m[0].changes,
                          "replay_free": m[0].rows_written <= 2 and m[0].changes == 0}
        log(f"P2 replay: rows_written={m[0].rows_written} changes={m[0].changes} -> free replay: {findings['P2']['replay_free']}")

        # --- P2b A_del through the AD trigger
        _, m = await q(AD_TRIGGER, "P2b-trigger")
        findings["create_trigger_rows_written"] = m[0].rows_written
        ids = ",".join(str(ID_BASE + i) for i in range(1, 251))
        _, m = await q(f"DELETE FROM addresses WHERE id IN ({ids});", "P2b")
        findings["P2b"] = {"rows_written": m[0].rows_written, "changes": m[0].changes, "A_del": round(m[0].rows_written / 250, 3)}
        log(f"P2b A_del: rows_written={m[0].rows_written} (A_del={findings['P2b']['A_del']})")
        res, _ = await q("SELECT count(*) AS n FROM addresses; SELECT count(*) AS n FROM addr_fts WHERE addr_fts MATCH '\"" + r250[0].normalized.split(' ')[0] + "\"';", "P2b-verify")
        findings["P2b"]["addresses_left"] = (res[0].get("results") or [{}])[0].get("n")

        # --- P3 DDL cost: DROP TABLE at 250 and 10K rows (plain table, no FTS)
        await q("DROP TABLE IF EXISTS ddl250; CREATE TABLE ddl250 (id INTEGER PRIMARY KEY, t TEXT);", "P3-mk250")
        await q("INSERT INTO ddl250 (id, t) VALUES " + ",".join(f"({i}, 'x')" for i in range(250)) + ";", "P3-fill250")
        _, m = await q("DROP TABLE ddl250;", "P3-drop250")
        findings["P3"] = {"drop_250_rows_written": m[0].rows_written}
        await q("DROP TABLE IF EXISTS ddl10k; CREATE TABLE ddl10k (id INTEGER PRIMARY KEY, t TEXT);", "P3-mk10k")
        for b in range(0, 10000, 1000):
            await q("INSERT INTO ddl10k (id, t) VALUES " + ",".join(f"({i}, 'x')" for i in range(b, b + 1000)) + ";", f"P3-fill10k-{b}")
        _, m = await q("DROP TABLE ddl10k;", "P3-drop10k")
        findings["P3"]["drop_10k_rows_written"] = m[0].rows_written
        log(f"P3 DROP TABLE: 250 rows -> {findings['P3']['drop_250_rows_written']}, 10K rows -> {m[0].rows_written}")

        # --- P4 atomicity of a multi-statement request
        await q("DROP TABLE IF EXISTS atom; CREATE TABLE atom (id INTEGER PRIMARY KEY);", "P4-mk")
        try:
            await c.query(args.db_id, "INSERT INTO atom (id) VALUES (1); INSERT INTO no_such_table (id) VALUES (2);",
                          idempotent=False, label="P4")
            findings["P4"] = {"error": "expected failure did not occur"}
        except Exception as e:
            res, _ = await q("SELECT count(*) AS n FROM atom;", "P4-check")
            n = (res[0].get("results") or [{}])[0].get("n")
            findings["P4"] = {"first_statement_persisted": bool(n), "error": str(e)[:200]}
        log(f"P4 atomicity: {findings['P4']}")

        # --- P5 FTS control commands on the (now empty) addr_fts + 10K-row twin
        p5 = {}
        for label, sql in (("pgsz", "INSERT INTO addr_fts(addr_fts, rank) VALUES('pgsz', 32768);"),
                           ("automerge", "INSERT INTO addr_fts(addr_fts, rank) VALUES('automerge', 0);"),
                           ("merge", "INSERT INTO addr_fts(addr_fts, rank) VALUES('merge', 64);")):
            try:
                _, m = await q(sql, f"P5-{label}")
                p5[label] = {"ok": True, "rows_written": m[0].rows_written, "changes": m[0].changes}
            except Exception as e:
                p5[label] = {"ok": False, "error": str(e)[:200]}
        # no-op merge floor on twin after loading 10K rows there
        for b in range(0, 10000, 250):
            await q(insert_sql("twin", rows[b:b + 250], ID_BASE + 1000000 + b), f"P5-twin-{b}")
        floor = []
        for i in range(4):
            _, m = await q("INSERT INTO twin_fts(twin_fts, rank) VALUES('merge', 64);", f"P5-twin-merge-{i}")
            floor.append({"rows_written": m[0].rows_written, "changes": m[0].changes})
        p5["merge_series_twin_10k"] = floor
        findings["P5"] = p5
        log(f"P5 FTS commands: {json.dumps(p5)}")

        # --- cleanup scratch tables (leave nothing behind but the DB itself)
        await q("DROP TABLE IF EXISTS twin_fts; DROP TABLE IF EXISTS twin; DROP TABLE IF EXISTS atom;", "cleanup")

    findings["ledger"] = ledger.snapshot()
    model = "workerd (2.0)" if a_ins < 2.6 else ("physical (3.1)" if a_ins < 4.0 else "readme (5.0)")
    findings["metering_model"] = model
    cal = {
        "A_ins": round(a_ins, 3),
        "A_del": findings["P2b"]["A_del"],
        "S_ins": 2.0,
        "S_del": 2.0,
        "changes_per_ins": findings["P1"]["changes"] / 250,
        "replay_free": findings["P2"]["replay_free"],
        "source": f"d1_probes {findings['at']} on scratch db {args.db_id}",
        "metering_model": model,
    }
    CAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    CAL_PATH.write_text(json.dumps(cal, indent=2))
    out = DATA / "logs" / f"probes-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(findings, indent=2))
    log(f"calibration -> {CAL_PATH}: {cal}")
    log(f"full findings -> {out}; total rows written this session: {ledger.committed_rows_written:,}")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-id", required=True, help="database_id of the SCRATCH database (never a live shard)")
    ap.add_argument("--csv", default=str(DATA / "out" / "2026-06" / "addresses" / "DC.csv"))
    args = ap.parse_args(argv)
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
