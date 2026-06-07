-- One-time migration from v1 schema to v2 (adds state column).
-- Wipes the Bay Area OSM rows; v2 rebuild reloads CA which includes them.
DROP TABLE IF EXISTS addr_fts;
DROP TABLE IF EXISTS addresses;
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL,
  normalized TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);
CREATE INDEX idx_addresses_state ON addresses(state);
CREATE VIRTUAL TABLE addr_fts USING fts5(
  normalized,
  state UNINDEXED,
  content='addresses',
  content_rowid='id'
);
