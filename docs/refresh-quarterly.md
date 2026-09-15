# Quarterly refresh runbook (delta load)

Long-form companion to the "Quarterly refresh (delta load)" section of the
README. Everything here is manual and runs from the maintainer's Mac; the
GitHub workflow only detects changes.

## 0. What is where

| Path | Role |
|---|---|
| `state/upstream-snapshot.json` | committed fingerprints the weekly detector compares against |
| `state/calibration.json` | measured D1 metering factors (`A_ins`, `A_del`, `S_ins`, `S_del`) used by the forecast |
| `state/fingerprints.json` | per state and table: `db_id`, data `version`, row count, id block, Time Travel bookmark. A shard listed here is **live**: the legacy loaders refuse it and `refresh.sh` refuses to rebuild that version |
| `data/v2/state/mirror/<ST>.<kind>.{keys,ids}.npy` + `.json` | local mirror of D1 (64-bit content key + primary key per row, sorted by key) |
| `data/v2/state/csvkeys/<version>/` | cached key arrays of the CSVs |
| `data/v2/state/plans/<version>/<ST>.<kind>.json` | plan written by every `sync_d1` run (ins rows, del ids, gates, forecast, `plan_sha`) |
| `data/v2/state/checkpoints/<version>/<ST>.<kind>.json` | apply progress; deleted on success |
| `data/v2/logs/sync-<version>-*.json` | per-run report (ledger, per-shard results) |

`OD_STATE_DIR` overrides the `state/` directory and `OD_DATA_DIR` the
`data/v2` root (used by the offline test harness).

## 1. Credentials

```bash
source scripts/cf_env_infisical.sh
```

Reads the Infisical machine identity from `~/.env` (`INFISICAL_CLIENT_ID`,
`INFISICAL_SECRET`, `INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT`;
override the file with `OD_INFISICAL_ENV_FILE`), logs in with universal
auth, and exports the secret `CLOUDFLARE_API_KEY` as `CLOUDFLARE_API_TOKEN`
and `CF_ACCOUNT_ID` as `CLOUDFLARE_ACCOUNT_ID` (secret names overridable via
`OD_CF_TOKEN_SECRET_NAME` / `OD_CF_ACCOUNT_SECRET_NAME`; the account id falls
back to `wrangler.toml`). Nothing is written to disk. Forks without Infisical
keep using `.env` (`refresh.sh` reads it; the Python modules read the
environment).

## 2. Decide what to refresh this quarter

The weekly detector (`.github/workflows/refresh.yml`, Mondays 13:00 UTC)
runs `python3 -m etl.check_upstream --snapshot state/upstream-snapshot.json`
and exits 3 on change, opening or commenting on a "Quarterly refresh:
upstream changed YYYY-MM" issue with the report attached. Signals, none of
which download bulk data:

| Source | Signal | Decision |
|---|---|---|
| NAD | Socrata view `fc2s-wawr` `blobId` (= ETag of the download), size, "Last Update" | Refresh every release: the change is national. |
| OpenAddresses | `batch.openaddresses.io/api/data` per-source `job` + `size` | `fetch_oa --changed-only` re-downloads only changed/new/missing sources. The API job metadata no longer exposes an `s3` field; the public `v2.openaddresses.io/batch-prod/job/<id>/source.geojson.gz` path is used. |
| TIGER | newest `TGRGDB<yy>` vintage whose edges gdb exists (probes 27/26/25) + per-state Content-Length | `fetch_tiger --vintage TGRGDB25\|26`. A national segments reload is ~68M rows written, so it is a separate billing-cycle decision, not part of the address delta. |
| OSM | Geofabrik `<state>-latest.osm.pbf.md5` | Frozen unless the road tiles are rebuilt (tiles → `upload-r2` → `DATA_VERSION` bump). |

After a refresh, update the snapshot so the detector stops firing:
`python3 -m etl.check_upstream --update-snapshot` (or `--seed-local` to fill
it from what the fetchers recorded on disk), then commit `state/`.

## 3. Fetch and build

D1 billing renews on the 1st; start national runs on the 2nd so the whole
run lands in one 50M-row allowance.

```bash
echo 2026-09 > data/v2/version.txt
```

`refresh.sh tiles|addresses|all` call `assert_version_not_loaded`: if
`state/fingerprints.json` already lists that version for any state they die
with "already loaded into D1; bump data/v2/version.txt". `addresses` also
runs a disk preflight (`OD_MIN_FREE_GB`, default 60 GB) before slicing NAD.

```bash
# NAD: fetch_nad is idempotent on data/v2/nad/nad-txt.zip, so move the
# previous archive aside first; refresh.sh addresses falls back to the newest
# nad-txt*.zip on disk (or $OD_NAD_ZIP). build_nad_addresses picks the single
# TXT/*.txt entry automatically (the release renames it, e.g. NAD_r22).
python3 -m etl.fetch_nad

# OA: only changed sources (compares against data/v2/oa/sources.json)
python3 -m etl.fetch_oa --changed-only

# TIGER: only when reloading segments (refresh.sh fetch/addresses use the
# default TGRGDB24; pass --vintage to both the fetcher and the builder)
python3 -m etl.fetch_tiger --vintage TGRGDB26
python3 -m etl.build_tiger_segments --version 2026-09 --vintage TGRGDB26

# per-state CSVs (NAD > OA > OSM merge + segments)
./refresh.sh addresses
```

`refresh.sh fetch` does not pass `--changed-only` or `--vintage`; call the
modules directly for a delta quarter.

## 4. Mirror D1

```bash
python3 -m etl.export_d1_mirror            # --kind addresses|segments|both (default both)
                                           # --states DC WY ...  --fresh  --rps 10  --state-parallelism 4
python3 -m etl.seed_fingerprints --version 2026-06   # once, before the first sync_d1
```

The mirror pages every shard by primary key (rows read only, ~$0.001/M —
~$0.26 for ~255M rows nationally), checkpoints every 25 pages and resumes
from `.cursor`. An existing complete mirror is skipped unless `--fresh`.
The sidecar JSON records row count, distinct keys, duplicate rows, `max_id`,
installed triggers and `size_after`.

`seed_fingerprints` records, for shards that were loaded by the legacy
loader and have no fingerprint yet, the version they hold (default
`2026-06`), `db_id` and row count. This is what arms the legacy guard and
what `sync_d1` uses as the key-correctness reference version. It is a
one-time step; `sync_d1` maintains the file afterwards.

## 5. Plan

```bash
python3 -m etl.sync_d1 --version 2026-09 --dry-run
python3 -m etl.sync_d1 --version 2026-09 --dry-run --states TX --only both
```

Per state and table (`--only` defaults to `addresses`):

1. Keys of the new CSV (`etl.rowkey`: same filters and canonicalisation as
   the legacy loaders, 64-bit blake2b of the canonical tuple) vs the mirror.
   `INS` = keys in the CSV but not the mirror; `DEL` = every id whose key is
   no longer in the CSV, plus extra ids of duplicated surviving keys (lowest
   id kept).
2. Key-correctness: share of the previous version's CSV keys present in the
   mirror. Must be `>= 0.95`; 1.0 is expected. Below that the diff key is
   wrong and the run refuses (not overridable). No previous CSV also refuses;
   `--prev-version` selects which CSVs to check against (default: the version
   in the fingerprint, else `2026-06`).
3. Churn `(INS + DEL) / mirror rows`. `>= 50%` refuses unless
   `--allow-rebuild ST`, because past that point a rebuild is cheaper.
4. Ids: inserts get explicit ids from block `2^40 × quarter_index`
   (quarter 1 = 2026-Q1); if the shard already holds ids in or above that
   block (a re-run in the same quarter) the next block is used. The block
   base must exceed every existing id and the last id must be `< 2^53`.
5. Forecast rows written `= INS × A_ins + DEL × A_del + statements`, using
   `state/calibration.json` (measured 2.0 / 2.0 / 2.0 / 2.0). Jitter report
   (addresses only): INS/DEL pairs with identical normalized text within
   1 m / 10 m / farther — a large sub-metre share means coordinate noise,
   not real change.

The table prints per-state ins/del/churn/key ratio/jitter/forecast and the
cumulative total with the estimated dollars above a fresh 50M allowance.
The plan file carries a `plan_sha`; a checkpoint from a different plan
refuses to resume.

## 6. Apply

```bash
python3 -m etl.sync_d1 --version 2026-09 --yes --max-rows 48000000 [--states ...] [--only both]
```

Refuses up front if any gate failed or the forecast total exceeds
`--max-rows` (default 48,000,000; run fewer states or raise it). Shards are
processed smallest forecast first (TX last), `--state-parallelism 4`,
`--rps 10`, `--stmts-per-request 4` (halved automatically on timeouts or
>10 s statements). Per shard:

1. `count_before` and a Time Travel bookmark via
   `npx wrangler d1 time-travel info <db> --json` (`--no-bookmark` to skip);
   `rollback_deadline` is 30 days out.
2. Addresses only: `CREATE TRIGGER IF NOT EXISTS addresses_ad` (FTS5
   `'delete'` on delete) and `addresses_au` (delete + reinsert on update).
   The insert trigger from the first load stays.
3. `INSERT OR IGNORE ... VALUES` in 250-row statements, several statements
   per REST request. Multi-statement requests are atomic. A replayed
   statement costs 0 rows, so a lost response is simply re-sent.
4. `DELETE FROM <table> WHERE id IN (...)` in 250-id statements.
5. Verify: `count_after == mirror rows − DEL + INS` (chunked `COUNT(*)` over
   id ranges); shards under 1M addresses also run an FTS5 `integrity-check`.
   A mismatch leaves the checkpoint in `verify-failed` and does not update
   the mirror or fingerprints.
6. Commit: mirror updated in place, `state/fingerprints.json` entry written
   (version, `db_id`, rows, id block, actual rows written, bookmark), the
   checkpoint deleted.

Budget guards during apply: the run aborts when the ledger's committed rows
written exceeds `--max-rows`, or when a shard's actual rows written exceeds
1.5× its forecast so far. The checkpoint (`phase`, `next_insert`,
`next_delete`, `rows_written`) is saved after every request, so re-running
the same command resumes; delete the checkpoint file to start a shard over
against the same plan.

Rollback: `wrangler d1 time-travel restore <db> --bookmark <bookmark_before>`
within 30 days, then `--fresh` re-export the mirror for that shard and remove
its fingerprint entry (or re-seed).

## 7. Publish

- `GEO_VERSION` (wrangler `[vars]`) versions only the KV geocode cache key
  `geo4:<GEO_VERSION>:<sha1>`. Bump it in `wrangler.toml` and
  `wrangler.toml.template` after the **last delete** of the refresh, commit,
  and deploy through GitHub. Bumping earlier would re-cache rows that are
  about to be deleted.
- `DATA_VERSION` stays tied to the R2 tile paths and changes only when tiles
  are rebuilt (OSM refresh). A tiles rebuild also needs `refresh.sh
  upload-r2` and `refresh.sh publish` (manifest in KV).
- Commit `state/` (`fingerprints.json`, updated `upstream-snapshot.json`).

## 8. Metering facts (measured 2026-09-14, scratch D1 database)

`python3 -m etl.d1_probes --db-id <scratch uuid>` writes
`state/calibration.json`. Never point it at a live shard. Findings:

| Probe | Result |
|---|---|
| insert one address (table + FTS5 trigger) | 2 rows written; FTS5 shadow-table rows are not metered |
| delete one address through the delete trigger | 2 rows written |
| insert one segment | 2 rows written (table + index) |
| replay an identical `INSERT OR IGNORE` with explicit ids | 0 rows written, 0 changes |
| `DROP TABLE` (250 and 10K rows) | 0 rows written |
| request whose 2nd statement fails | 1st statement not persisted (atomic) |
| id `2^40 + 12345` | round-trips exactly through the REST API |

Consequences: a full reload is ~221M addresses × 2 + ~34M segments × 2 ≈
510M rows ≈ $460 after the 50M/month included rows (the June 2026 load cost
about $500); a delta costs `(INS + DEL) × 2`, so a few percent churn stays
inside the monthly allowance. The README's earlier "~5× amplification /
~1.38B rows / $500–1,000" model was wrong.

## 9. Legacy loaders

`etl.load_d1_parallel` and `etl.load_d1_segments` (what `refresh.sh load-d1`
runs) reset the schema with `DROP TABLE` before loading. They remain the
cold-start path for a brand-new fork, and they refuse to run against any
`database_id` listed in `state/fingerprints.json` unless
`--i-know-this-drops-a-live-shard` is passed. Their per-version
`load_hashes.json` skip is superseded by the delta loader and only matters on
a first load.
