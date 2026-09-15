#!/usr/bin/env python3
"""Detect upstream data changes WITHOUT downloading any bulk data.

Compares cheap live signals from each upstream source against a snapshot
file of previously recorded fingerprints, writes a JSON report, and prints
a short markdown summary to stdout.

    python3 -m etl.check_upstream [--snapshot state/upstream-snapshot.json]
                                  [--out state/upstream-report.json]
                                  [--states CA NV ...] [--update-snapshot]
                                  [--seed-local] [--quiet]
    python3 -m etl.check_upstream --selftest      # offline, exercises compare logic

Sources and the signal used (network budget in parentheses):

  NAD    Socrata view metadata for fc2s-wawr: blobId (== ETag of the download
         redirect target), blobFileSize, metadata.custom_fields "Last Update".
         rowsUpdatedAt is deliberately ignored (stale).             (1 GET, ~7 KB)
  TIGER  newest TGRGDB<yy> vintage whose edges gdb exists (probe 27, 26, 25 with
         HEAD on one state) + per-state Content-Length/Last-Modified. (<=3 + 49 HEAD)
  OA     batch.openaddresses.io run listing: per source job + size.   (1 GET, ~1.4 MB)
  OSM    Geofabrik <state>-latest.osm.pbf.md5 per state.              (49 GET, 52 B each)

Exit code: 0 = no change, 3 = change detected, 1 = error (a source could not be
checked; the other sources are still reported and the snapshot keeps the
previous value for the failed source).

Snapshot semantics: if the snapshot file is missing it is created from the
current signals and every source is reported as "baseline" (not "changed").
With --update-snapshot the current signals are written back after comparing.
--seed-local fills gaps in the snapshot from what the fetchers recorded on
disk (data/v2/nad/nad-txt.meta.json etag -> blobId, data/v2/oa/sources.json)
so the first committed snapshot reflects what was actually loaded.

Each source is split into fetch_<src>() (network, returns a signals dict) and
compare_<src>(prev, cur) (pure), so the comparison logic is testable offline.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import json
import sys
from pathlib import Path
from typing import Any

import requests

from etl.config import DATA, ROOT, geofabrik_url
from etl.fetch_tiger import VINTAGES as KNOWN_TIGER_VINTAGES, state_url as tiger_state_url
from etl.states import BY_CODE

UA = {"User-Agent": "open-distance/1.0"}
TIMEOUT = (10, 30)  # (connect, read) seconds
SNAPSHOT_VERSION = 1

NAD_VIEW_URL = "https://data.transportation.gov/api/views/fc2s-wawr.json"
NAD_LOCAL_META = DATA / "nad" / "nad-txt.meta.json"
OA_API = "https://batch.openaddresses.io/api/data"
OA_LOCAL_SOURCES = DATA / "oa" / "sources.json"
TIGER_BASE = "https://www2.census.gov/geo/tiger"
TIGER_PROBE_VINTAGES = ("TGRGDB27", "TGRGDB26", "TGRGDB25")
TIGER_PROBE_STATE = "DE"  # smallest edges gdb; any state works for a HEAD

DEFAULT_SNAPSHOT = ROOT / "state" / "upstream-snapshot.json"
DEFAULT_REPORT = ROOT / "state" / "upstream-report.json"

QUIET = False


def log(msg: str) -> None:
    if not QUIET:
        print(f"[check-upstream] {msg}", file=sys.stderr, flush=True)


def utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# NAD
# ---------------------------------------------------------------------------
def _flatten_custom_fields(cf: Any, prefix: str = "") -> dict[str, Any]:
    """metadata.custom_fields is {group: {key: value}}; flatten to 'group/key'."""
    out: dict[str, Any] = {}
    if isinstance(cf, dict):
        for k, v in cf.items():
            key = f"{prefix}{str(k).strip()}"
            if isinstance(v, dict):
                out.update(_flatten_custom_fields(v, key + "/"))
            else:
                out[key] = v
    return out


def parse_nad_view(view: dict) -> dict:
    """Pure: extract the signals we care about from the Socrata view JSON."""
    flat = _flatten_custom_fields((view.get("metadata") or {}).get("custom_fields"))
    last_update = None
    for k, v in flat.items():
        leaf = k.rsplit("/", 1)[-1].lower().replace("_", " ")
        if "last update" in leaf and v:
            last_update = str(v).strip()
            break
    vlm = view.get("viewLastModified")
    return {
        "blobId": view.get("blobId"),
        "size": view.get("blobFileSize"),
        "filename": view.get("blobFilename"),
        "last_update": last_update,
        "view_last_modified": (
            datetime.datetime.fromtimestamp(vlm, datetime.timezone.utc).isoformat(timespec="seconds")
            if isinstance(vlm, (int, float)) else None
        ),
    }


def fetch_nad() -> dict:
    log(f"GET {NAD_VIEW_URL}")
    r = requests.get(NAD_VIEW_URL, headers=UA, timeout=TIMEOUT)
    r.raise_for_status()
    cur = parse_nad_view(r.json())
    if not cur["blobId"]:
        raise RuntimeError("NAD view JSON has no blobId")
    return cur


def compare_nad(prev: dict | None, cur: dict) -> dict:
    rep = {
        "status": "baseline",
        "changed": False,
        "blobId": cur.get("blobId"),
        "size": cur.get("size"),
        "last_update": cur.get("last_update"),
        "view_last_modified": cur.get("view_last_modified"),
        "prev_blobId": None,
        "prev_size": None,
        "prev_last_update": None,
    }
    if prev and prev.get("blobId"):
        rep["prev_blobId"] = prev.get("blobId")
        rep["prev_size"] = prev.get("size")
        rep["prev_last_update"] = prev.get("last_update")
        changed = prev.get("blobId") != cur.get("blobId") or (
            prev.get("size") is not None and cur.get("size") is not None and prev["size"] != cur["size"]
        )
        rep["changed"] = changed
        rep["status"] = "changed" if changed else "unchanged"
    return rep


# ---------------------------------------------------------------------------
# TIGER
# ---------------------------------------------------------------------------
def tiger_url(state, vintage: str) -> str:
    """URL for a state's edges gdb; delegates to fetch_tiger for known vintages.

    Newer-than-known vintages are assumed to follow the 2026 naming (no '_a_').
    """
    if vintage in KNOWN_TIGER_VINTAGES:
        return tiger_state_url(state, vintage)
    year = "20" + vintage[-2:]
    return f"{TIGER_BASE}/{vintage}/tlgdb_{year}_{state.fips}_{state.code.lower()}_edges.gdb.zip"


def _head(url: str) -> requests.Response:
    return requests.head(url, headers=UA, timeout=TIMEOUT, allow_redirects=True)


def probe_tiger_vintage() -> tuple[str, list[str]]:
    """Newest vintage whose edges gdb exists. Returns (vintage, vintages_probed)."""
    probed = []
    st = BY_CODE[TIGER_PROBE_STATE]
    for v in TIGER_PROBE_VINTAGES:
        url = tiger_url(st, v)
        log(f"HEAD {url}")
        probed.append(v)
        r = _head(url)
        if r.status_code == 200:
            return v, probed
    raise RuntimeError(f"no TIGER vintage found among {TIGER_PROBE_VINTAGES}")


def fetch_tiger(states: list[str], workers: int = 4) -> dict:
    vintage, probed = probe_tiger_vintage()
    log(f"TIGER newest vintage: {vintage} (probed {', '.join(probed)})")

    def one(code: str) -> tuple[str, dict]:
        r = _head(tiger_url(BY_CODE[code], vintage))
        if r.status_code != 200:
            return code, {"status": r.status_code}
        cl = r.headers.get("Content-Length")
        return code, {
            "content_length": int(cl) if cl and cl.isdigit() else None,
            "last_modified": r.headers.get("Last-Modified"),
        }

    per_state: dict[str, dict] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for code, sig in ex.map(one, states):
            per_state[code] = sig
    missing = [c for c, s in per_state.items() if "content_length" not in s]
    if missing:
        log(f"TIGER: no file for {len(missing)} states in {vintage}: {' '.join(missing)}")
    return {"vintage": vintage, "states": per_state}


def compare_tiger(prev: dict | None, cur: dict) -> dict:
    prev = prev or {}
    prev_states = prev.get("states") or {}
    rep = {
        "status": "baseline",
        "changed": False,
        "newest_vintage": cur.get("vintage"),
        "prev_vintage": prev.get("vintage"),
        "new_vintage": False,
        "changed_states": [],
        "baseline_states": [],
        "missing_states": sorted(c for c, s in (cur.get("states") or {}).items() if "content_length" not in s),
        "states_checked": len(cur.get("states") or {}),
    }
    if not prev.get("vintage") and not prev_states:
        rep["baseline_states"] = sorted(cur.get("states") or {})
        return rep
    if prev.get("vintage") and cur.get("vintage") and prev["vintage"] != cur["vintage"]:
        rep["new_vintage"] = True
    for code, sig in sorted((cur.get("states") or {}).items()):
        if "content_length" not in sig:
            continue
        psig = prev_states.get(code)
        if not psig or psig.get("content_length") is None:
            rep["baseline_states"].append(code)
        elif psig.get("content_length") != sig.get("content_length"):
            rep["changed_states"].append(code)
    rep["changed"] = rep["new_vintage"] or bool(rep["changed_states"])
    rep["status"] = "changed" if rep["changed"] else "unchanged"
    return rep


# ---------------------------------------------------------------------------
# OpenAddresses
# ---------------------------------------------------------------------------
def oa_state(source: str) -> str:
    parts = source.split("/")
    return parts[1].upper() if len(parts) >= 2 and parts[0] == "us" else "XX"


def parse_oa_runs(arr: list[dict], states: list[str] | None = None) -> dict:
    """Pure: US address-layer runs -> {source: {job, size, updated}} (same shape as fetch_oa)."""
    want = set(states) if states else None
    out: dict[str, dict] = {}
    for x in arr:
        src = x.get("source") or ""
        if x.get("layer") != "addresses" or not src.startswith("us/"):
            continue
        if not (x.get("output") or {}).get("output"):
            continue
        if want is not None and oa_state(src) not in want:
            continue
        out[src] = {"job": x.get("job"), "size": x.get("size"), "updated": x.get("updated")}
    return {"sources": out}


def fetch_oa(states: list[str] | None = None) -> dict:
    params = {"level": "run", "country": "us", "page": 0, "limit": 10000, "fabric": "false"}
    log(f"GET {OA_API} {params}")
    r = requests.get(OA_API, params=params, headers=UA, timeout=(10, 90))
    r.raise_for_status()
    cur = parse_oa_runs(r.json(), states)
    if not cur["sources"]:
        raise RuntimeError("OA listing returned no US address sources")
    return cur


def compare_oa(prev: dict | None, cur: dict) -> dict:
    prev_src = (prev or {}).get("sources") or {}
    cur_src = cur.get("sources") or {}
    rep = {
        "status": "baseline",
        "changed": False,
        "sources_checked": len(cur_src),
        "changed_sources": 0,
        "new_sources": 0,
        "removed_sources": 0,
        "per_state": {},
        "changed_list": [],
    }
    if not prev_src:
        return rep
    per_state: dict[str, int] = {}
    for src, sig in sorted(cur_src.items()):
        p = prev_src.get(src)
        if p is None:
            rep["new_sources"] += 1
            continue
        if p.get("job") != sig.get("job") or p.get("size") != sig.get("size"):
            rep["changed_sources"] += 1
            rep["changed_list"].append(src)
            per_state[oa_state(src)] = per_state.get(oa_state(src), 0) + 1
    rep["removed_sources"] = sum(1 for s in prev_src if s not in cur_src)
    rep["per_state"] = dict(sorted(per_state.items()))
    rep["changed"] = rep["changed_sources"] > 0
    rep["status"] = "changed" if rep["changed"] else "unchanged"
    return rep


# ---------------------------------------------------------------------------
# OSM (Geofabrik)
# ---------------------------------------------------------------------------
def parse_md5_body(text: str) -> str | None:
    tok = text.strip().split()
    return tok[0].lower() if tok and len(tok[0]) == 32 else None


def fetch_osm(states: list[str], workers: int = 8) -> dict:
    def one(code: str) -> tuple[str, str | None]:
        url = geofabrik_url(BY_CODE[code].geofabrik) + ".md5"
        r = requests.get(url, headers=UA, timeout=TIMEOUT)
        if r.status_code != 200:
            log(f"OSM {code}: HTTP {r.status_code}")
            return code, None
        return code, parse_md5_body(r.text)

    log(f"GET {len(states)} Geofabrik .md5 files")
    out: dict[str, str | None] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for code, md5 in ex.map(one, states):
            out[code] = md5
    if all(v is None for v in out.values()):
        raise RuntimeError("Geofabrik: every .md5 request failed")
    return {"states": out}


def compare_osm(prev: dict | None, cur: dict) -> dict:
    prev_states = (prev or {}).get("states") or {}
    rep = {
        "status": "baseline",
        "changed": False,
        "changed_states": [],
        "unknown_states": [],
        "unchanged_states": 0,
        "states_checked": 0,
    }
    for code, md5 in sorted((cur.get("states") or {}).items()):
        if md5 is None:
            continue
        rep["states_checked"] += 1
        p = prev_states.get(code)
        if not p:
            rep["unknown_states"].append(code)
        elif p != md5:
            rep["changed_states"].append(code)
        else:
            rep["unchanged_states"] += 1
    if rep["changed_states"]:
        rep["status"], rep["changed"] = "changed", True
    elif rep["unchanged_states"]:
        rep["status"] = "unchanged" if not rep["unknown_states"] else "partial"
    return rep


# ---------------------------------------------------------------------------
# Snapshot / report plumbing
# ---------------------------------------------------------------------------
def load_json(p: Path) -> dict | None:
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except ValueError as e:
        raise RuntimeError(f"{p}: invalid JSON ({e})")


def write_json(p: Path, obj: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=1, sort_keys=True) + "\n")


def seed_from_local(snap: dict) -> dict:
    """Fill gaps in the snapshot from what the fetchers recorded on disk (read-only)."""
    if not (snap.get("nad") or {}).get("blobId") and NAD_LOCAL_META.exists():
        try:
            meta = json.loads(NAD_LOCAL_META.read_text())
        except ValueError:
            meta = {}
        etag = (meta.get("etag") or "").strip('"')
        if etag:
            snap["nad"] = {"blobId": etag, "size": meta.get("bytes"), "last_update": None,
                           "seeded_from": str(NAD_LOCAL_META)}
            log(f"seeded NAD from {NAD_LOCAL_META}: blobId={etag}")
    if not ((snap.get("oa") or {}).get("sources")) and OA_LOCAL_SOURCES.exists():
        try:
            srcs = json.loads(OA_LOCAL_SOURCES.read_text())
        except ValueError:
            srcs = {}
        if srcs:
            snap["oa"] = {"sources": srcs, "seeded_from": str(OA_LOCAL_SOURCES)}
            log(f"seeded OA from {OA_LOCAL_SOURCES}: {len(srcs)} sources")
    return snap


def merge_snapshot(prev: dict | None, cur: dict[str, dict | None]) -> dict:
    """New snapshot = current signals, keeping prev for sources that failed (None)."""
    prev = prev or {}
    snap = {"version": SNAPSHOT_VERSION, "updated_at": utcnow()}
    for k in ("nad", "tiger", "oa", "osm"):
        c = cur.get(k)
        if c is None:
            if prev.get(k) is not None:
                snap[k] = prev[k]
        elif k in ("tiger", "osm") and prev.get(k):
            # per-state maps: keep prev entries for states not checked this run (--states)
            merged = dict((prev[k].get("states") or {}))
            merged.update(c.get("states") or {})
            snap[k] = dict(c, states=merged)
        elif k == "oa" and prev.get(k) and (prev[k].get("sources")):
            merged = dict(prev[k]["sources"])
            merged.update(c.get("sources") or {})
            snap[k] = {"sources": merged}
        else:
            snap[k] = c
    return snap


def overall_exit_code(report: dict) -> int:
    srcs = [report.get(k) or {} for k in ("nad", "tiger", "oa", "osm")]
    if any(s.get("status") == "error" for s in srcs):
        return 1
    if any(s.get("changed") for s in srcs):
        return 3
    return 0


def _fmt_bytes(n) -> str:
    if not isinstance(n, (int, float)):
        return "?"
    return f"{n/1e9:.2f} GB" if n >= 1e9 else f"{n/1e6:.1f} MB"


def _codes(lst: list[str], limit: int = 20) -> str:
    if not lst:
        return "-"
    s = " ".join(lst[:limit])
    return s + (f" (+{len(lst)-limit} more)" if len(lst) > limit else "")


def render_markdown(report: dict) -> str:
    nad, tiger, oa, osm = (report.get(k) or {} for k in ("nad", "tiger", "oa", "osm"))
    rc = report.get("exit_code")
    verdict = {0: "no upstream change", 3: "**upstream change detected**", 1: "**error** (see below)"}.get(rc, "?")
    lines = [
        f"## Upstream check {report.get('checked_at', '')[:10]} - {verdict}",
        "",
        "| Source | Status | Signal |",
        "|---|---|---|",
    ]

    def row(name: str, s: dict, signal: str) -> None:
        st = s.get("status", "?")
        if st == "error":
            signal = f"`{s.get('error', 'error')}`"
        lines.append(f"| {name} | {st} | {signal} |")

    row("NAD", nad,
        f"blobId `{nad.get('blobId')}` ({_fmt_bytes(nad.get('size'))}), Last Update {nad.get('last_update')}"
        + (f"; was `{nad.get('prev_blobId')}` ({_fmt_bytes(nad.get('prev_size'))})" if nad.get("changed") else ""))
    tsig = f"newest vintage {tiger.get('newest_vintage')}"
    if tiger.get("new_vintage"):
        tsig += f" (was {tiger.get('prev_vintage')})"
    if tiger.get("changed_states"):
        tsig += f"; {len(tiger['changed_states'])} state(s) changed size: {_codes(tiger['changed_states'])}"
    if tiger.get("baseline_states") and tiger.get("status") != "baseline":
        tsig += f"; {len(tiger['baseline_states'])} states without prior fingerprint"
    if tiger.get("missing_states"):
        tsig += f"; no file for {_codes(tiger['missing_states'])}"
    row("TIGER", tiger, tsig)
    osig = f"{oa.get('changed_sources', 0)}/{oa.get('sources_checked', 0)} sources changed"
    if oa.get("new_sources") or oa.get("removed_sources"):
        osig += f" (+{oa.get('new_sources', 0)} new, -{oa.get('removed_sources', 0)} removed)"
    if oa.get("per_state"):
        top = sorted(oa["per_state"].items(), key=lambda kv: -kv[1])[:12]
        osig += "; by state: " + ", ".join(f"{k} {v}" for k, v in top)
        if len(oa["per_state"]) > 12:
            osig += f", +{len(oa['per_state'])-12} more states"
    row("OpenAddresses", oa, osig)
    msig = f"{len(osm.get('changed_states') or [])} of {osm.get('states_checked', 0)} states changed"
    if osm.get("changed_states"):
        msig += f": {_codes(osm['changed_states'])}"
    if osm.get("unknown_states"):
        msig += f"; {len(osm['unknown_states'])} unknown (no recorded md5)"
    row("OSM (Geofabrik)", osm, msig)

    errs = [(k, s.get("error")) for k, s in (("nad", nad), ("tiger", tiger), ("oa", oa), ("osm", osm)) if s.get("status") == "error"]
    if errs:
        lines += ["", "Errors:"] + [f"- {k}: {e}" for k, e in errs]
    if rc == 3:
        lines += [
            "",
            "Next steps (manual, from the maintainer's machine): review the report, then run `refresh.sh`",
            "for the changed sources. Cloudflare billing renews on the 1st; start the D1 load early in a",
            "billing month so the write burst stays inside one cycle. NAD publishes quarterly with ~9 weeks",
            "lag from the 'Last Update' date.",
        ]
    if any(s.get("status") == "baseline" for s in (nad, tiger, oa, osm)):
        lines += ["", "_baseline_ = no prior fingerprint in the snapshot; recorded now, not counted as a change."]
    lines += ["", f"Report: `{report.get('report_path', '')}`  Snapshot: `{report.get('snapshot_path', '')}`"]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def run(args) -> int:
    snapshot_path = Path(args.snapshot)
    report_path = Path(args.out)
    states = sorted(s.upper() for s in args.states) if args.states else sorted(BY_CODE)
    for s in states:
        if s not in BY_CODE:
            print(f"unknown state code: {s}", file=sys.stderr)
            return 1

    prev = load_json(snapshot_path)
    creating = prev is None
    if creating:
        log(f"snapshot {snapshot_path} missing; will create it (all sources baseline)")
        prev = {}
    if args.seed_local:
        prev = seed_from_local(prev)

    cur: dict[str, dict | None] = {}
    report: dict[str, Any] = {
        "checked_at": utcnow(),
        "snapshot_path": str(snapshot_path),
        "report_path": str(report_path),
        "states": states,
    }
    plan = (
        ("nad", fetch_nad, compare_nad, ()),
        ("tiger", fetch_tiger, compare_tiger, (states,)),
        ("oa", fetch_oa, compare_oa, (states if args.states else None,)),
        ("osm", fetch_osm, compare_osm, (states,)),
    )
    for key, fetch, compare, fargs in plan:
        try:
            cur[key] = fetch(*fargs)
            report[key] = compare(prev.get(key), cur[key])
        except Exception as e:  # network / parse failure: report, keep prev in snapshot
            log(f"ERROR {key}: {e}")
            cur[key] = None
            report[key] = {"status": "error", "changed": False, "error": f"{type(e).__name__}: {e}"}
        log(f"{key}: {report[key].get('status')}")

    report["exit_code"] = overall_exit_code(report)
    report["snapshot_created"] = creating
    report["snapshot_updated"] = creating or args.update_snapshot
    write_json(report_path, report)
    if creating or args.update_snapshot:
        write_json(snapshot_path, merge_snapshot(prev, cur))
        log(f"snapshot -> {snapshot_path}")
    sys.stdout.write(render_markdown(report))
    return report["exit_code"]


# ---------------------------------------------------------------------------
# Offline self-test
# ---------------------------------------------------------------------------
def selftest() -> int:
    def check(cond: bool, what: str) -> None:
        if not cond:
            raise AssertionError(what)

    # NAD --------------------------------------------------------------
    view = {"blobId": "b189f78b", "blobFileSize": 7601412707, "blobFilename": "TXT.zip",
            "viewLastModified": 1788394487, "rowsUpdatedAt": 1,
            "metadata": {"custom_fields": {"Common Core": {"Last Update": "6/30/2026", "Update Frequency\t": "R/P3M"}}}}
    cur = parse_nad_view(view)
    check(cur["blobId"] == "b189f78b" and cur["size"] == 7601412707, "nad parse")
    check(cur["last_update"] == "6/30/2026", "nad last_update from grouped custom_fields")
    check(cur["view_last_modified"] == "2026-09-03T00:14:47+00:00", f"nad viewLastModified {cur['view_last_modified']}")
    r = compare_nad(None, cur)
    check(r["status"] == "baseline" and not r["changed"], "nad baseline")
    r = compare_nad(cur, cur)
    check(r["status"] == "unchanged" and not r["changed"], "nad unchanged")
    r = compare_nad({"blobId": "old", "size": 1}, cur)
    check(r["status"] == "changed" and r["changed"] and r["prev_blobId"] == "old", "nad changed blobId")
    r = compare_nad({"blobId": "b189f78b", "size": 5}, cur)
    check(r["changed"], "nad changed size only")
    check(parse_nad_view({})["blobId"] is None, "nad empty view")

    # TIGER ------------------------------------------------------------
    st_de, st_ca = BY_CODE["DE"], BY_CODE["CA"]
    check(tiger_url(st_de, "TGRGDB25").endswith("/TGRGDB25/tlgdb_2025_a_10_de_edges.gdb.zip"), "tiger url 25")
    check(tiger_url(st_de, "TGRGDB26").endswith("/TGRGDB26/tlgdb_2026_10_de_edges.gdb.zip"), "tiger url 26")
    check(tiger_url(st_ca, "TGRGDB27").endswith("/TGRGDB27/tlgdb_2027_06_ca_edges.gdb.zip"), "tiger url 27")
    t_prev = {"vintage": "TGRGDB26", "states": {"DE": {"content_length": 100}, "CA": {"content_length": 200}}}
    t_same = {"vintage": "TGRGDB26", "states": {"DE": {"content_length": 100}, "CA": {"content_length": 200}}}
    r = compare_tiger(None, t_same)
    check(r["status"] == "baseline" and r["baseline_states"] == ["CA", "DE"], "tiger baseline")
    r = compare_tiger(t_prev, t_same)
    check(r["status"] == "unchanged" and not r["changed_states"], "tiger unchanged")
    t_cur = {"vintage": "TGRGDB26", "states": {"DE": {"content_length": 101}, "CA": {"content_length": 200},
                                              "NV": {"content_length": 5}, "WY": {"status": 404}}}
    r = compare_tiger(t_prev, t_cur)
    check(r["changed"] and r["changed_states"] == ["DE"], "tiger changed_states")
    check(r["baseline_states"] == ["NV"] and r["missing_states"] == ["WY"], "tiger baseline/missing")
    r = compare_tiger(t_prev, {"vintage": "TGRGDB27", "states": {"DE": {"content_length": 100}}})
    check(r["changed"] and r["new_vintage"] and r["prev_vintage"] == "TGRGDB26", "tiger new vintage")

    # OA ---------------------------------------------------------------
    arr = [
        {"source": "us/ca/alameda", "layer": "addresses", "job": 1, "size": 10, "updated": "a", "output": {"output": "x"}},
        {"source": "us/ca/alameda", "layer": "buildings", "job": 9, "size": 1, "output": {"output": "x"}},
        {"source": "us/nv/clark", "layer": "addresses", "job": 2, "size": 20, "updated": "b", "output": {"output": "x"}},
        {"source": "us/tx/statewide", "layer": "addresses", "job": 3, "size": 30, "output": {}},
        {"source": "ca/on/toronto", "layer": "addresses", "job": 4, "size": 40, "output": {"output": "x"}},
    ]
    cur_oa = parse_oa_runs(arr)
    check(set(cur_oa["sources"]) == {"us/ca/alameda", "us/nv/clark"}, f"oa parse filter {cur_oa}")
    check(cur_oa["sources"]["us/ca/alameda"] == {"job": 1, "size": 10, "updated": "a"}, "oa parse shape")
    check(set(parse_oa_runs(arr, ["CA"])["sources"]) == {"us/ca/alameda"}, "oa --states filter")
    r = compare_oa(None, cur_oa)
    check(r["status"] == "baseline" and r["changed_sources"] == 0, "oa baseline")
    r = compare_oa(cur_oa, cur_oa)
    check(r["status"] == "unchanged", "oa unchanged")
    prev_oa = {"sources": {"us/ca/alameda": {"job": 0, "size": 10}, "us/nv/clark": {"job": 2, "size": 20},
                           "us/or/gone": {"job": 7, "size": 7}}}
    cur2 = {"sources": dict(cur_oa["sources"], **{"us/wa/king": {"job": 5, "size": 50}})}
    r = compare_oa(prev_oa, cur2)
    check(r["changed"] and r["changed_sources"] == 1 and r["per_state"] == {"CA": 1}, f"oa changed {r}")
    check(r["new_sources"] == 1 and r["removed_sources"] == 1, "oa new/removed")
    r = compare_oa(prev_oa, {"sources": {"us/nv/clark": {"job": 2, "size": 21}}})
    check(r["changed"] and r["per_state"] == {"NV": 1}, "oa size-only change")

    # OSM --------------------------------------------------------------
    check(parse_md5_body("d9cfde2619d1720ca6f7a3d7babacf25  delaware-latest.osm.pbf\n") == "d9cfde2619d1720ca6f7a3d7babacf25", "md5 parse")
    check(parse_md5_body("<html>nope</html>") is None, "md5 garbage")
    o_prev = {"states": {"DE": "a" * 32, "CA": "b" * 32}}
    r = compare_osm(None, {"states": {"DE": "a" * 32}})
    check(r["status"] == "baseline" and r["unknown_states"] == ["DE"], "osm first run unknown")
    r = compare_osm(o_prev, {"states": {"DE": "a" * 32, "CA": "b" * 32}})
    check(r["status"] == "unchanged" and not r["changed"], "osm unchanged")
    r = compare_osm(o_prev, {"states": {"DE": "a" * 32, "CA": "c" * 32, "NV": "d" * 32, "WY": None}})
    check(r["changed"] and r["changed_states"] == ["CA"] and r["unknown_states"] == ["NV"], f"osm changed {r}")
    check(r["states_checked"] == 3, "osm skips failed fetch")
    r = compare_osm(o_prev, {"states": {"DE": "a" * 32, "NV": "d" * 32}})
    check(r["status"] == "partial" and not r["changed"], "osm partial")

    # Exit codes / snapshot merge / markdown ---------------------------
    rep = {"nad": {"status": "unchanged", "changed": False}, "tiger": {"status": "unchanged", "changed": False},
           "oa": {"status": "baseline", "changed": False}, "osm": {"status": "partial", "changed": False}}
    check(overall_exit_code(rep) == 0, "exit 0")
    rep["osm"] = {"status": "changed", "changed": True}
    check(overall_exit_code(rep) == 3, "exit 3")
    rep["nad"] = {"status": "error", "changed": False, "error": "boom"}
    check(overall_exit_code(rep) == 1, "exit 1 beats 3")

    snap = merge_snapshot({"nad": {"blobId": "old"}, "osm": {"states": {"CA": "x", "DE": "y"}},
                           "oa": {"sources": {"us/ca/a": {"job": 1}}}, "tiger": t_prev},
                          {"nad": None, "osm": {"states": {"DE": "z"}}, "oa": {"sources": {"us/nv/b": {"job": 2}}},
                           "tiger": {"vintage": "TGRGDB27", "states": {"DE": {"content_length": 1}}}})
    check(snap["nad"] == {"blobId": "old"}, "merge keeps prev on error")
    check(snap["osm"]["states"] == {"CA": "x", "DE": "z"}, "merge per-state osm")
    check(set(snap["oa"]["sources"]) == {"us/ca/a", "us/nv/b"}, "merge oa sources")
    check(snap["tiger"]["vintage"] == "TGRGDB27" and snap["tiger"]["states"]["CA"]["content_length"] == 200, "merge tiger")
    check(snap["version"] == SNAPSHOT_VERSION and snap["updated_at"], "merge header")

    full = {"checked_at": "2026-09-14T13:00:00+00:00", "exit_code": 3, "report_path": "r.json", "snapshot_path": "s.json",
            "nad": compare_nad({"blobId": "old", "size": 1}, cur),
            "tiger": compare_tiger(t_prev, t_cur),
            "oa": compare_oa(prev_oa, cur2),
            "osm": compare_osm(o_prev, {"states": {"DE": "a" * 32, "CA": "c" * 32}})}
    md = render_markdown(full)
    check("upstream change detected" in md and "| NAD | changed |" in md and "was `old`" in md, "md nad row")
    check("| TIGER | changed |" in md and "DE" in md and "no file for WY" in md, "md tiger row")
    check("| OpenAddresses | changed | 1/3 sources changed (+1 new, -1 removed); by state: CA 1" in md, f"md oa row\n{md}")
    check("| OSM (Geofabrik) | changed | 1 of 2 states changed: CA" in md, "md osm row")
    check("Cloudflare billing" in md, "md next steps")
    full["nad"] = {"status": "error", "changed": False, "error": "ConnectionError: x"}
    full["exit_code"] = 1
    md = render_markdown(full)
    check("**error**" in md and "- nad: ConnectionError: x" in md, "md error")

    print("selftest OK")
    return 0


def main(argv: list[str]) -> int:
    global QUIET
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snapshot", default=str(DEFAULT_SNAPSHOT), help="fingerprint snapshot JSON (default: %(default)s)")
    ap.add_argument("--out", default=str(DEFAULT_REPORT), help="report JSON (default: %(default)s)")
    ap.add_argument("--states", nargs="+", metavar="ST", help="restrict TIGER/OA/OSM checks to these state codes")
    ap.add_argument("--update-snapshot", action="store_true", help="write current signals back to the snapshot")
    ap.add_argument("--seed-local", action="store_true",
                    help="fill snapshot gaps from data/v2 fetcher records (NAD meta etag, OA sources.json)")
    ap.add_argument("--quiet", action="store_true", help="suppress progress logging on stderr")
    ap.add_argument("--selftest", action="store_true", help="run offline self-test of the comparison logic")
    args = ap.parse_args(argv)
    QUIET = args.quiet
    if args.selftest:
        return selftest()
    try:
        return run(args)
    except Exception as e:
        print(f"[check-upstream] fatal: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
