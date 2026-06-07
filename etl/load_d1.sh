#!/usr/bin/env bash
# Load data/addresses.csv into the od-geocode D1 database with an FTS5 index.
#
# D1 has a per-statement size cap (SQLITE_TOOBIG), so we keep each INSERT
# statement small (ROWS_PER_INSERT) and pack many INSERT statements per .sql
# file (ROWS_PER_FILE) to limit the number of wrangler calls.
set -euo pipefail

cd "$(dirname "$0")/.."
CSV="data/addresses.csv"
if [[ ! -f "$CSV" ]]; then
  echo "missing $CSV — run build_addresses.py first" >&2
  exit 1
fi

ROWS_PER_INSERT=${ROWS_PER_INSERT:-200}
ROWS_PER_FILE=${ROWS_PER_FILE:-5000}
DB=${DB:-od-geocode}

WORKDIR="data/d1-sql"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

cat >"$WORKDIR/000_schema.sql" <<'SQL'
DROP TABLE IF EXISTS addr_fts;
DROP TABLE IF EXISTS addresses;
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY,
  normalized TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
CREATE VIRTUAL TABLE addr_fts USING fts5(normalized, content='addresses', content_rowid='id');
SQL

python3 - "$CSV" "$WORKDIR" "$ROWS_PER_INSERT" "$ROWS_PER_FILE" <<'PY'
import csv, os, sys
csv_path, workdir, rows_per_insert, rows_per_file = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def esc(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"

file_idx = 1
out = None
inserts_per_file = max(1, rows_per_file // rows_per_insert)
def open_file(idx):
    return open(os.path.join(workdir, f"{idx:04d}_insert.sql"), "w")

with open(csv_path) as f:
    r = csv.reader(f)
    header = next(r)
    batch = []
    insert_count = 0
    for row in r:
        if len(row) < 4: continue
        rid, norm, lat, lon = row[0], row[1], row[2], row[3]
        batch.append(f"({int(rid)}, {esc(norm)}, {float(lat)}, {float(lon)})")
        if len(batch) >= rows_per_insert:
            if out is None:
                out = open_file(file_idx)
            out.write("INSERT INTO addresses (id, normalized, lat, lon) VALUES\n")
            out.write(",\n".join(batch))
            out.write(";\n")
            batch = []
            insert_count += 1
            if insert_count >= inserts_per_file:
                out.close(); out = None
                file_idx += 1
                insert_count = 0
    if batch:
        if out is None:
            out = open_file(file_idx)
        out.write("INSERT INTO addresses (id, normalized, lat, lon) VALUES\n")
        out.write(",\n".join(batch))
        out.write(";\n")
    if out:
        out.close()
print(f"last file index: {file_idx}")
PY

# Rebuild FTS at the end.
LAST_IDX=$(ls "$WORKDIR" | grep -E '_insert\.sql$' | sort | tail -1 | awk -F_ '{print $1}')
REBUILD_IDX=$(printf "%04d" $((10#$LAST_IDX + 1)))
cat >"$WORKDIR/${REBUILD_IDX}_fts.sql" <<'SQL'
INSERT INTO addr_fts(addr_fts) VALUES('rebuild');
SQL

for f in "$WORKDIR"/*.sql; do
  echo "[load_d1] applying $f"
  wrangler d1 execute "$DB" --remote --file "$f" >/dev/null 2>&1 && echo "  ok" || { echo "  FAILED"; exit 1; }
done

echo "[load_d1] done."
