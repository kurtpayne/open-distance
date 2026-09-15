#!/usr/bin/env python3
"""Seed state/fingerprints.json from the D1 mirror for shards loaded by the legacy loader.

Run once after `etl.export_d1_mirror` and before the first `etl.sync_d1`.  For
every state that has a mirror sidecar and no fingerprint entry yet, record the
version the shard currently holds (default 2026-06), its database_id and row
count.  This is what makes `etl/legacy_guard.py` refuse a DROP+reload of a
live shard and what `sync_d1` uses as the key-correctness reference version.

Usage:
  python3 -m etl.seed_fingerprints [--version 2026-06] [--states ...] [--force]
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from etl.export_d1_mirror import mirror_paths
from etl.states import BY_CODE
from etl.sync_d1 import FINGERPRINTS, dump_json, load_json


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="2026-06", help="version the shards currently hold")
    ap.add_argument("--states", nargs="*")
    ap.add_argument("--force", action="store_true", help="overwrite existing entries")
    args = ap.parse_args(argv)

    fp = load_json(FINGERPRINTS, {})
    seeded = 0
    for st in args.states or sorted(BY_CODE):
        for kind in ("addresses", "segments"):
            meta_p = mirror_paths(st, kind)["meta"]
            if not meta_p.exists():
                continue
            if fp.get(st, {}).get(kind) and not args.force:
                continue
            m = json.loads(meta_p.read_text())
            fp.setdefault(st, {})[kind] = {
                "version": args.version,
                "db_id": m["db_id"],
                "rows": m["rows"],
                "duplicate_rows": m.get("duplicate_rows", 0),
                "id_block_base": 0,
                "rows_written_actual": None,
                "loaded_at": None,
                "seeded_from_mirror_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "mirror_exported_at": m.get("exported_at"),
            }
            seeded += 1
    dump_json(FINGERPRINTS, fp)
    print(f"seeded {seeded} entries -> {FINGERPRINTS} ({len(fp)} states)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
