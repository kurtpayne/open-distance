#!/usr/bin/env python3
"""Safety guard for the legacy DROP+reload loaders.

state/fingerprints.json (repo root) records, per state, which D1 shard the
delta-refresh pipeline last loaded and at what data version:

  {
    "CA": {
      "addresses": {"db_id": "...", "version": "2026-09", ...},
      "segments":  {"db_id": "...", "version": "2026-09", ...}
    },
    ...
  }

Any shard listed there is live and managed by the delta pipeline. The legacy
loaders reset the schema (DROP TABLE) before loading, which would wipe a live
shard, so they refuse to touch a listed database_id unless explicitly told to.
"""
from __future__ import annotations

import json
from pathlib import Path

from etl.config import ROOT

FINGERPRINTS = ROOT / "state" / "fingerprints.json"
OVERRIDE_FLAG = "--i-know-this-drops-a-live-shard"
_KINDS = ("addresses", "segments")


def load_fingerprints() -> dict:
    """Parsed state/fingerprints.json, or {} if it does not exist."""
    if not FINGERPRINTS.exists():
        return {}
    data = json.loads(FINGERPRINTS.read_text())
    return data if isinstance(data, dict) else {}


def _entries(fp: dict):
    for state, rec in fp.items():
        if not isinstance(rec, dict):
            continue
        for kind in _KINDS:
            entry = rec.get(kind)
            if isinstance(entry, dict):
                yield state, kind, entry


def states_with_db_id(db_id: str) -> list[str]:
    """States whose addresses.db_id or segments.db_id equals db_id."""
    return sorted({s for s, _, e in _entries(load_fingerprints()) if e.get("db_id") == db_id})


def states_with_version(version: str) -> list[str]:
    """States whose addresses.version equals version (i.e. already loaded)."""
    fp = load_fingerprints()
    return sorted({s for s, kind, e in _entries(fp) if kind == "addresses" and e.get("version") == version})


def check_live_shard(db_id: str, state: str, allow: bool) -> None:
    """Raise unless db_id is not a live shard or `allow` (override flag) is set."""
    owners = states_with_db_id(db_id)
    if not owners or allow:
        return
    raise RuntimeError(
        f"{state}: database {db_id} is a live shard listed in {FINGERPRINTS} "
        f"(states: {', '.join(owners)}); a schema reset would drop it. "
        f"Pass {OVERRIDE_FLAG} to proceed anyway."
    )
