#!/usr/bin/env python3
"""Run a sample of routes through both open-distance and Google Distance Matrix
and produce a comparison report.

Requires GOOGLE_MAPS_API_KEY in the environment.

The route set spans:
  - urban / suburban / rural densities
  - short / medium / long lengths
  - traffic-prone corridors (SF Bay Bridge, NJ Turnpike etc.)
  - cross-state borders

Output: a per-route table + summary stats. Times are free-flow on our side,
"best guess" without departure_time on Google's side (matches our assumption).

Usage:
  GOOGLE_MAPS_API_KEY=... python3 scripts/benchmark_vs_google.py
  GOOGLE_MAPS_API_KEY=... python3 scripts/benchmark_vs_google.py --out report.md
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.parse
import urllib.request


OD_BASE = os.environ.get("OD_BASE", "https://open-distance.com")
GMAPS_BASE = "https://maps.googleapis.com/maps/api/distancematrix/json"


# (label, category, origin, destination)
# category: short | commute | inter_city | long | cross_state | rural | traffic
ROUTES: list[tuple[str, str, str, str]] = [
    # Short within-metro
    ("SF Civic Center -> SF Ferry Building",          "short urban",      "37.7793,-122.4193", "37.7955,-122.3937"),
    ("Manhattan Times Sq -> Penn Station",            "short urban",      "40.7580,-73.9855", "40.7506,-73.9935"),
    ("DTLA Pershing Sq -> LA Live",                   "short urban",      "34.0489,-118.2509", "34.0451,-118.2670"),
    ("Boston Faneuil Hall -> Fenway",                 "short urban",      "42.3601,-71.0563", "42.3467,-71.0972"),

    # Commute distance, suburban
    ("Palo Alto -> Mountain View",                    "commute",          "37.4419,-122.1430", "37.3861,-122.0839"),
    ("San Mateo -> Foster City",                      "commute",          "37.5630,-122.3255", "37.5585,-122.2711"),
    ("Brooklyn -> Newark Penn Station",               "commute",          "40.6782,-73.9442", "40.7345,-74.1646"),
    ("Bethesda MD -> DC Capitol",                     "commute",          "38.9849,-77.0947", "38.8899,-77.0091"),
    ("Cambridge MA -> Logan Airport",                 "commute",          "42.3736,-71.1097", "42.3656,-71.0096"),
    ("Pasadena -> Santa Monica",                      "commute",          "34.1478,-118.1445", "34.0195,-118.4912"),
    ("Plano TX -> Downtown Dallas",                   "commute",          "33.0198,-96.6989", "32.7767,-96.7970"),
    ("Naperville IL -> Chicago Loop",                 "commute",          "41.7508,-88.1535", "41.8781,-87.6298"),

    # Inter-city, same state
    ("SF -> Sacramento",                              "inter_city",       "37.7749,-122.4194", "38.5816,-121.4944"),
    ("LA -> San Diego",                               "inter_city",       "34.0522,-118.2437", "32.7157,-117.1611"),
    ("Houston -> Austin",                             "inter_city",       "29.7604,-95.3698", "30.2672,-97.7431"),
    ("Detroit -> Lansing",                            "inter_city",       "42.3314,-83.0458", "42.7325,-84.5555"),

    # Long-haul (was hitting the L0 cap before A* + L1)
    ("SF -> LA",                                      "long",             "37.7749,-122.4194", "34.0522,-118.2437"),
    ("Seattle -> Portland",                           "long",             "47.6062,-122.3321", "45.5152,-122.6784"),
    ("NYC -> Boston",                                 "long",             "40.7128,-74.0060", "42.3601,-71.0589"),
    ("NYC -> DC",                                     "long",             "40.7128,-74.0060", "38.9072,-77.0369"),
    ("Atlanta -> Miami",                              "long",             "33.7490,-84.3880", "25.7617,-80.1918"),
    ("Chicago -> Detroit",                            "long",             "41.8781,-87.6298", "42.3314,-83.0458"),
    ("Denver -> Salt Lake City",                      "long",             "39.7392,-104.9903", "40.7608,-111.8910"),
    ("Dallas -> Houston",                             "long",             "32.7767,-96.7970", "29.7604,-95.3698"),

    # True cross-country (tests L1 hard)
    ("NYC -> LA",                                     "long",             "40.7128,-74.0060", "34.0522,-118.2437"),
    ("Seattle -> Miami",                              "long",             "47.6062,-122.3321", "25.7617,-80.1918"),
    ("Boston -> Houston",                             "long",             "42.3601,-71.0589", "29.7604,-95.3698"),

    # Cross-state border commutes
    ("Niles MI -> Mishawaka IN",                      "cross_state",      "41.8298,-86.2541", "41.6620,-86.1586"),
    ("KCK -> KCMO",                                   "cross_state",      "39.1142,-94.6275", "39.0997,-94.5786"),
    ("Memphis TN -> West Memphis AR",                 "cross_state",      "35.1495,-90.0490", "35.1465,-90.1845"),
    ("Vancouver WA -> Portland OR",                   "cross_state",      "45.6280,-122.6739", "45.5152,-122.6784"),
    ("Jersey City NJ -> Manhattan",                   "cross_state",      "40.7178,-74.0431", "40.7128,-74.0060"),
    ("Camden NJ -> Philly Center City",               "cross_state",      "39.9259,-75.1196", "39.9526,-75.1652"),

    # Rural
    ("Bozeman MT -> Yellowstone (West)",              "rural",            "45.6794,-111.0448", "44.6588,-111.0989"),
    ("Eureka CA -> Crescent City",                    "rural",            "40.8021,-124.1637", "41.7558,-124.2026"),
    ("Bangor ME -> Acadia NP",                        "rural",            "44.8016,-68.7712", "44.3386,-68.2733"),
    ("Pierre SD -> Rapid City",                       "rural",            "44.3683,-100.3510", "44.0805,-103.2310"),
    ("Cheyenne WY -> Casper",                         "rural",            "41.1400,-104.8202", "42.8666,-106.3131"),

    # Traffic-prone corridors (we don't model traffic; expect bigger time diff)
    ("SF -> Berkeley (Bay Bridge)",                   "traffic",          "37.7749,-122.4194", "37.8716,-122.2727"),
    ("Newark Airport -> Manhattan (Lincoln Tunnel)",  "traffic",          "40.6895,-74.1745", "40.7484,-73.9857"),
    ("LAX -> Hollywood (405+101)",                    "traffic",          "33.9425,-118.4081", "34.1014,-118.3267"),
    ("Tysons Corner -> DC Capitol (I-66+I-395)",      "traffic",          "38.9189,-77.2231", "38.8899,-77.0091"),
    ("Marina del Rey -> LAX (405)",                   "traffic",          "33.9802,-118.4517", "33.9425,-118.4081"),
    ("Cambridge MA -> Boston Common (I-93)",          "traffic",          "42.3736,-71.1097", "42.3551,-71.0656"),
]


def hit_od(origin: str, dest: str, router: str = "") -> dict:
    params = {
        "origins": origin,
        "destinations": dest,
        "units": "imperial",
    }
    if router:
        params["router"] = router
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{OD_BASE}/maps/api/distancematrix/json?{qs}",
                                 headers={"User-Agent": "od-benchmark/1.0"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=45) as r:
        data = json.loads(r.read().decode())
        # Capture which engine actually answered (via the x-od-router-impl
        # header we set on the WASM path).
        impl = r.headers.get("x-od-router-impl") or "ts"
    return {"json": data, "wall_ms": int((time.time() - t0) * 1000), "impl": impl}


def hit_google(origin: str, dest: str, key: str) -> dict:
    qs = urllib.parse.urlencode({
        "origins": origin,
        "destinations": dest,
        "units": "imperial",
        "key": key,
    })
    req = urllib.request.Request(f"{GMAPS_BASE}?{qs}",
                                 headers={"User-Agent": "od-benchmark/1.0"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=45) as r:
        data = json.loads(r.read().decode())
    return {"json": data, "wall_ms": int((time.time() - t0) * 1000)}


def first_element(data: dict) -> dict | None:
    rows = data.get("rows") or []
    if not rows:
        return None
    elements = rows[0].get("elements") or []
    if not elements:
        return None
    return elements[0]


def fmt_pct(num: float | None) -> str:
    if num is None:
        return "—"
    return f"{num:+.1f}%"


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="Write a markdown report here (default: stdout)")
    ap.add_argument("--limit", type=int, default=0, help="Only run the first N routes (debug)")
    ap.add_argument("--router", default="", help="Force a router on the open-distance side (e.g. 'wasm'). Empty = let the Worker pick the default TS path.")
    args = ap.parse_args(argv)

    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        print("ERROR: GOOGLE_MAPS_API_KEY env var required", file=sys.stderr)
        return 1

    routes = ROUTES[:args.limit] if args.limit else ROUTES
    rows = []
    dist_diffs = {}; time_diffs = {}

    for label, cat, o, d in routes:
        print(f"[bench] {label}...", flush=True)
        try:
            od = hit_od(o, d, args.router)
            gg = hit_google(o, d, key)
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)
            rows.append({"label": label, "category": cat, "od_status": "ERROR", "gg_status": "—",
                         "od_distance": None, "gg_distance": None,
                         "od_time": None, "gg_time": None,
                         "dist_diff_pct": None, "time_diff_pct": None,
                         "od_wall": None, "gg_wall": None})
            continue

        od_el = first_element(od["json"])
        gg_el = first_element(gg["json"])
        if not od_el or not gg_el:
            print("  (incomplete response)")
            continue

        od_status = od_el.get("status", "?")
        gg_status = gg_el.get("status", "?")
        od_dist = (od_el.get("distance") or {}).get("value")
        gg_dist = (gg_el.get("distance") or {}).get("value")
        od_time = (od_el.get("duration") or {}).get("value")
        gg_time = (gg_el.get("duration") or {}).get("value")

        dist_diff = ((od_dist - gg_dist) / gg_dist * 100) if (od_dist and gg_dist) else None
        time_diff = ((od_time - gg_time) / gg_time * 100) if (od_time and gg_time) else None
        if dist_diff is not None:
            dist_diffs.setdefault(cat, []).append(abs(dist_diff))
        if time_diff is not None:
            time_diffs.setdefault(cat, []).append(abs(time_diff))

        rows.append({
            "label": label, "category": cat,
            "od_status": od_status, "gg_status": gg_status,
            "od_distance": od_dist, "gg_distance": gg_dist,
            "od_time": od_time, "gg_time": gg_time,
            "dist_diff_pct": dist_diff, "time_diff_pct": time_diff,
            "od_wall": od["wall_ms"], "gg_wall": gg["wall_ms"],
        })
        print(f"  OD: {od_dist}m / {od_time}s ({od['wall_ms']}ms)")
        print(f"  GG: {gg_dist}m / {gg_time}s ({gg['wall_ms']}ms)")
        print(f"  diff: dist {fmt_pct(dist_diff)}, time {fmt_pct(time_diff)}")
        time.sleep(0.1)  # Google rate friendliness

    # Summary
    lines = []
    lines.append("# open-distance vs Google Distance Matrix — accuracy benchmark\n")
    lines.append(f"Routes: {len(rows)}  ·  Categories: {len(dist_diffs)}  ·  Generated: {time.strftime('%Y-%m-%d')}\n")
    lines.append("\n## Summary by category (absolute % diff vs Google)\n\n")
    lines.append("| Category | Routes | Distance (median) | Distance (p90) | Time (median) | Time (p90) |\n")
    lines.append("|---|---:|---:|---:|---:|---:|\n")
    for cat in sorted(dist_diffs.keys()):
        d = dist_diffs[cat]; t = time_diffs.get(cat, [])
        dm = statistics.median(d) if d else 0
        dp90 = sorted(d)[int(len(d) * 0.9)] if d else 0
        tm = statistics.median(t) if t else 0
        tp90 = sorted(t)[int(len(t) * 0.9)] if t else 0
        lines.append(f"| {cat} | {len(d)} | {dm:.1f}% | {dp90:.1f}% | {tm:.1f}% | {tp90:.1f}% |\n")
    lines.append("\n## Per-route detail\n\n")
    lines.append("| Route | Cat | OD status | GG status | OD mi | GG mi | Δ dist | OD min | GG min | Δ time | OD ms | GG ms |\n")
    lines.append("|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
    for r in rows:
        od_mi = f"{r['od_distance']/1609.344:.1f}" if r.get('od_distance') else "—"
        gg_mi = f"{r['gg_distance']/1609.344:.1f}" if r.get('gg_distance') else "—"
        od_min = f"{r['od_time']/60:.0f}" if r.get('od_time') else "—"
        gg_min = f"{r['gg_time']/60:.0f}" if r.get('gg_time') else "—"
        lines.append(
            f"| {r['label']} | {r['category']} | {r['od_status']} | {r['gg_status']} | "
            f"{od_mi} | {gg_mi} | {fmt_pct(r.get('dist_diff_pct'))} | "
            f"{od_min} | {gg_min} | {fmt_pct(r.get('time_diff_pct'))} | "
            f"{r.get('od_wall') or '—'} | {r.get('gg_wall') or '—'} |\n"
        )

    text = "".join(lines)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
        print(f"\nwrote {args.out}", file=sys.stderr)
    else:
        print("\n" + text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
