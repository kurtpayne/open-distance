#!/usr/bin/env bash
# Load data/addresses.csv into the hhapi-geocode D1 database with an FTS5 index.
#
# Strategy: build a single .sql file (schema + INSERTs in chunks), then push it
# to D1 with `wrangler d1 execute --file`. D1 caps the SQL file size per call,
# so we chunk by N rows per file.
set -euo pipefail

cd "$(dirname "$0")/.."
CSV="data/addresses.csv"
if [[ ! -f "$CSV" ]]; then
  echo "missing $CSV — run build_addresses.py first" >&2
  exit 1
fi

ROWS_PER_CHUNK=${ROWS_PER_CHUNK:-2000}
DB=${DB:-hhapi-geocode}

WORKDIR="data/d1-sql"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

# Schema first.
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

# Chunk the inserts.
python3 - "$CSV" "$WORKDIR" "$ROWS_PER_CHUNK" <<'PY'
import csv, os, sys
csv_path, workdir, rows_per = sys.argv[1], sys.argv[2], int(sys.argv[3])
def esc(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"
with open(csv_path) as f:
    r = csv.reader(f)
    header = next(r)
    chunk = []
    chunk_idx = 1
    def flush(idx, chunk):
        if not chunk: return
        path = os.path.join(workdir, f"{idx:04d}_insert.sql")
        with open(path, "w") as out:
            out.write("INSERT INTO addresses (id, normalized, lat, lon) VALUES\n")
            out.write(",\n".join(chunk))
            out.write(";\n")
    for row in r:
        if len(row) < 4: continue
        rid, norm, lat, lon = row[0], row[1], row[2], row[3]
        chunk.append(f"({int(rid)}, {esc(norm)}, {float(lat)}, {float(lon)})")
        if len(chunk) >= rows_per:
            flush(chunk_idx, chunk)
            chunk_idx += 1
            chunk = []
    flush(chunk_idx, chunk)
    total = chunk_idx
print(f"chunks written: {total}")
PY

# Rebuild FTS at the end.
LAST_IDX=$(ls "$WORKDIR" | grep _insert.sql | wc -l | tr -d ' ')
REBUILD_IDX=$(printf "%04d" $((LAST_IDX + 1)))
cat >"$WORKDIR/${REBUILD_IDX}_fts.sql" <<'SQL'
INSERT INTO addr_fts(addr_fts) VALUES('rebuild');
SQL

# Execute every chunk against D1 (remote).
for f in "$WORKDIR"/*.sql; do
  echo "[load_d1] applying $f"
  wrangler d1 execute "$DB" --remote --file "$f"
done

echo "[load_d1] done."
