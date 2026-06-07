#!/usr/bin/env bash
# Load v2 per-state address CSVs into the single od-geocode D1 (with state column).
#
# Schema is created idempotently on first run; subsequent runs replace rows for
# the listed states only (so we can re-load one state without touching others).
#
# usage: load_d1_shards.sh <VERSION> <STATE>...
set -euo pipefail
VERSION="${1:?}"; shift
STATES="$*"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="od-geocode"
ROWS_PER_INSERT=${ROWS_PER_INSERT:-200}
ROWS_PER_FILE=${ROWS_PER_FILE:-5000}

cd "$ROOT"

WORKDIR="data/v2/d1-sql/$VERSION"
mkdir -p "$WORKDIR"

# One-time schema (idempotent).
SCHEMA="$WORKDIR/000_schema.sql"
cat >"$SCHEMA" <<'SQL'
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  normalized TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addresses_state ON addresses(state);
CREATE VIRTUAL TABLE IF NOT EXISTS addr_fts USING fts5(
  normalized,
  state UNINDEXED,
  content='addresses',
  content_rowid='id'
);
SQL
echo "[load-d1] applying schema"
wrangler d1 execute "$DB" --remote --file "$SCHEMA" >/dev/null 2>&1

for STATE in $STATES; do
  CSV="data/v2/out/$VERSION/addresses/$STATE.csv"
  if [[ ! -f "$CSV" ]]; then
    echo "[load-d1] WARN: missing $CSV (skip $STATE)"
    continue
  fi

  SUB="$WORKDIR/$STATE"
  rm -rf "$SUB"; mkdir -p "$SUB"

  # Delete existing rows for this state (allows re-load).
  # NOTE: don't DELETE from addr_fts here -- the UNINDEXED state column can't
  # filter; we rebuild the whole FTS index once at the end.
  cat >"$SUB/0001_clear.sql" <<SQL
DELETE FROM addresses WHERE state = '$STATE';
SQL

  python3 - "$CSV" "$SUB" "$STATE" "$ROWS_PER_INSERT" "$ROWS_PER_FILE" <<'PY'
import csv, os, sys
csv_path, workdir, state, rows_per_insert, rows_per_file = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
def esc(s: str) -> str: return "'" + s.replace("'", "''") + "'"

file_idx = 2  # 0001_clear taken
inserts_per_file = max(1, rows_per_file // rows_per_insert)
out = None; insert_count = 0
def open_file(idx): return open(os.path.join(workdir, f"{idx:04d}_insert.sql"), "w")

with open(csv_path) as f:
    r = csv.reader(f); next(r)
    batch = []
    for row in r:
        if len(row) < 4: continue
        _id, norm, lat, lon = row[0], row[1], row[2], row[3]
        batch.append(f"({esc(state)}, {esc(norm)}, {float(lat)}, {float(lon)})")
        if len(batch) >= rows_per_insert:
            if out is None: out = open_file(file_idx)
            out.write("INSERT INTO addresses (state, normalized, lat, lon) VALUES\n")
            out.write(",\n".join(batch))
            out.write(";\n")
            batch = []; insert_count += 1
            if insert_count >= inserts_per_file:
                out.close(); out = None; file_idx += 1; insert_count = 0
    if batch:
        if out is None: out = open_file(file_idx)
        out.write("INSERT INTO addresses (state, normalized, lat, lon) VALUES\n")
        out.write(",\n".join(batch))
        out.write(";\n")
    if out: out.close()
PY

  total_files=$(ls "$SUB" | wc -l | tr -d ' ')
  i=0
  for f in "$SUB"/*.sql; do
    i=$((i+1))
    wrangler d1 execute "$DB" --remote --file "$f" >/dev/null 2>&1 \
      && echo "  $STATE [$i/$total_files] $(basename "$f")" \
      || { echo "  FAILED on $f" >&2; exit 1; }
  done
done

# Rebuild FTS once at the very end (covers every state inserted in this call).
echo "[load-d1] rebuilding addr_fts"
echo "INSERT INTO addr_fts(addr_fts) VALUES('rebuild');" > "$WORKDIR/_fts_rebuild.sql"
wrangler d1 execute "$DB" --remote --file "$WORKDIR/_fts_rebuild.sql" >/dev/null 2>&1 \
  || { echo "FAILED to rebuild addr_fts" >&2; exit 1; }
echo "[load-d1] done."
