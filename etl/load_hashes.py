#!/usr/bin/env python3
"""Per-state source-hash manifest for the D1 loaders.

D1 bills per row WRITTEN ($1/M) and the per-row FTS5 trigger amplifies address
writes ~5x, so a full reload of every shard costs ~$1,000. Most refreshes touch
only a few states, so the loaders compute a SHA-256 of the exact artifact(s)
they would load for a state and skip the DROP+reload entirely when the hash
matches a previously-recorded successful load.

Manifest shape (data/v2/out/<version>/load_hashes.json):

  {
    "CA": { "addresses_sha256": "...", "segments_sha256": "..." },
    "NY": { "addresses_sha256": "...", "segments_sha256": "..." }
  }

The two loaders touch different keys of the same per-state record:
  - load_d1_parallel.py  -> "addresses_sha256" (merged addresses CSV)
  - load_d1_segments.py  -> "segments_sha256" (TIGER segments CSV)

Correctness contract: only skip a state when (a) the manifest records a hash
for that artifact AND (b) it matches the current file's hash. A missing entry
means "never successfully loaded" -> always (re)load. Hashes are written
incrementally after each successful state load so a mid-run failure preserves
the completed states.
"""
from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path

from etl.config import DATA


def manifest_path(version: str) -> Path:
    """Path to the load-hash manifest for a data version."""
    p = DATA / "out" / version
    p.mkdir(parents=True, exist_ok=True)
    return p / "load_hashes.json"


def file_sha256(path: Path) -> str:
    """Streaming SHA-256 of a file's bytes (CSVs can be large)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class LoadHashManifest:
    """Thread-safe reader/writer for the per-state load-hash manifest.

    Both loaders run states concurrently (asyncio + a thread or two), so reads
    and the read-modify-write of a successful load are guarded by a lock and
    each successful state is flushed to disk immediately (incremental write) so
    a crash mid-run keeps the hashes of states that already finished.
    """

    def __init__(self, version: str):
        self.path = manifest_path(version)
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, str]] = {}
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text())
                if isinstance(loaded, dict):
                    self._data = {
                        str(k): dict(v) for k, v in loaded.items() if isinstance(v, dict)
                    }
            except (json.JSONDecodeError, OSError):
                # A corrupt manifest must not block a load -- treat as empty,
                # which means every state reloads (safe, just not cheap).
                self._data = {}

    def recorded(self, state: str, field: str) -> str | None:
        """Previously-recorded hash for (state, field), or None if never set."""
        with self._lock:
            return self._data.get(state, {}).get(field)

    def matches(self, state: str, field: str, current_hash: str) -> bool:
        """True only if a hash was recorded for (state, field) and it matches."""
        prev = self.recorded(state, field)
        return prev is not None and prev == current_hash

    def record(self, state: str, field: str, current_hash: str) -> None:
        """Record a successful load's hash and flush to disk immediately."""
        with self._lock:
            self._data.setdefault(state, {})[field] = current_hash
            self._flush_locked()

    def _flush_locked(self) -> None:
        # Atomic-ish write: serialize under the lock, write to a temp file, then
        # replace, so a concurrent reader never sees a half-written file.
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._data, indent=2, sort_keys=True))
        tmp.replace(self.path)
