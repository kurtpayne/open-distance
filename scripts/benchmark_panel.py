#!/usr/bin/env python3
"""Multi-provider routing accuracy panel.

For each route, hits every provider whose credentials are present in the
environment, and produces a report framed around the *spread* across providers
rather than bilateral diffs against one of them. The premise: no routing API
is ground truth; the honest question is "where does open-distance sit inside
the range that respectable providers produce."

Providers (env var to enable, first match wins):
  open-distance      OD_BASE                                  default https://open-distance.com
  google             GOOGLE_MAPS_API_KEY | GOOGLE_API_KEY
  osrm               (none — public demo at router.project-osrm.org)
  mapbox             MAPBOX_ACCESS_TOKEN | MAPBOX_KEY
  ors                ORS_API_KEY | HEIGIT_KEY                 (HeiGIT runs OpenRouteService)
  graphhopper        GRAPHHOPPER_API_KEY | GRACE_HOPPER_KEY
  tomtom             TOMTOM_API_KEY | TOMTOM_KEY
  valhalla           VALHALLA_BASE_URL                        e.g. http://104.237.154.223

Usage:
  python3 scripts/benchmark_panel.py               # report to stdout
  python3 scripts/benchmark_panel.py --out r.md    # write markdown
  python3 scripts/benchmark_panel.py --limit 5     # debug: first 5 routes
  python3 scripts/benchmark_panel.py --only osrm,open-distance
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
# Google retired the legacy Distance Matrix API. The current product is
# Routes API: POST /directions/v2:computeRoutes with X-Goog-Api-Key header.
GOOGLE_ROUTES_BASE = "https://routes.googleapis.com/directions/v2:computeRoutes"
OSRM_BASE = os.environ.get("OSRM_BASE", "https://router.project-osrm.org")
MAPBOX_BASE = "https://api.mapbox.com/directions/v5/mapbox/driving"
ORS_BASE = "https://api.openrouteservice.org/v2/directions/driving-car"
GRAPHHOPPER_BASE = "https://graphhopper.com/api/1/route"
TOMTOM_BASE = "https://api.tomtom.com/routing/1/calculateRoute"


# (label, category, origin, destination)
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

    # Long-haul
    ("SF -> LA",                                      "long",             "37.7749,-122.4194", "34.0522,-118.2437"),
    ("Seattle -> Portland",                           "long",             "47.6062,-122.3321", "45.5152,-122.6784"),
    ("NYC -> Boston",                                 "long",             "40.7128,-74.0060", "42.3601,-71.0589"),
    ("NYC -> DC",                                     "long",             "40.7128,-74.0060", "38.9072,-77.0369"),
    ("Atlanta -> Miami",                              "long",             "33.7490,-84.3880", "25.7617,-80.1918"),
    ("Chicago -> Detroit",                            "long",             "41.8781,-87.6298", "42.3314,-83.0458"),
    ("Denver -> Salt Lake City",                      "long",             "39.7392,-104.9903", "40.7608,-111.8910"),
    ("Dallas -> Houston",                             "long",             "32.7767,-96.7970", "29.7604,-95.3698"),

    # True cross-country
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

    # Traffic-prone corridors (we don't model traffic; expect bigger time spread)
    ("SF -> Berkeley (Bay Bridge)",                   "traffic",          "37.7749,-122.4194", "37.8716,-122.2727"),
    ("Newark Airport -> Manhattan (Lincoln Tunnel)",  "traffic",          "40.6895,-74.1745", "40.7484,-73.9857"),
    ("LAX -> Hollywood (405+101)",                    "traffic",          "33.9425,-118.4081", "34.1014,-118.3267"),
    ("Tysons Corner -> DC Capitol (I-66+I-395)",      "traffic",          "38.9189,-77.2231", "38.8899,-77.0091"),
    ("Marina del Rey -> LAX (405)",                   "traffic",          "33.9802,-118.4517", "33.9425,-118.4081"),
    ("Cambridge MA -> Boston Common (I-93)",          "traffic",          "42.3736,-71.1097", "42.3551,-71.0656"),
]


# ---------------------------------------------------------------------------
# Provider adapters. Each returns:
#   {"distance_m": float|None, "duration_s": float|None,
#    "wall_ms": int, "status": str, "error": str|None}
# ---------------------------------------------------------------------------

def _ll(s):
    a, b = s.split(",")
    return float(a), float(b)


def _request(req, timeout=45):
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return body, int((time.time() - t0) * 1000)


def hit_open_distance(origin: str, dest: str, _cfg) -> dict:
    qs = urllib.parse.urlencode({"origins": origin, "destinations": dest, "units": "imperial"})
    req = urllib.request.Request(f"{OD_BASE}/maps/api/distancematrix/json?{qs}",
                                 headers={"User-Agent": "od-panel/1.0"})
    try:
        body, wall = _request(req)
        data = json.loads(body.decode())
        el = ((data.get("rows") or [{}])[0].get("elements") or [{}])[0]
        if el.get("status") != "OK":
            return {"distance_m": None, "duration_s": None, "wall_ms": wall,
                    "status": el.get("status") or "?", "error": None}
        return {"distance_m": el["distance"]["value"], "duration_s": el["duration"]["value"],
                "wall_ms": wall, "status": "OK", "error": None}
    except Exception as e:
        return {"distance_m": None, "duration_s": None, "wall_ms": 0, "status": "EXC", "error": str(e)}


def hit_google(origin: str, dest: str, key: str) -> dict:
    lat1, lon1 = _ll(origin); lat2, lon2 = _ll(dest)
    body_json = json.dumps({
        "origin":      {"location": {"latLng": {"latitude": lat1, "longitude": lon1}}},
        "destination": {"location": {"latLng": {"latitude": lat2, "longitude": lon2}}},
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_UNAWARE",
    }).encode()
    req = urllib.request.Request(
        GOOGLE_ROUTES_BASE, data=body_json,
        headers={"Content-Type": "application/json",
                 "X-Goog-Api-Key": key,
                 "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
                 "User-Agent": "od-panel/1.0"},
    )
    try:
        body, wall = _request(req)
        data = json.loads(body.decode())
        routes = data.get("routes") or []
        if not routes:
            err = data.get("error", {}).get("message") or "NO_ROUTE"
            return {"distance_m": None, "duration_s": None, "wall_ms": wall,
                    "status": err[:32], "error": None}
        r = routes[0]
        # duration is "162005s" string; strip the 's'
        dur_str = r.get("duration", "0s")
        dur_s = float(dur_str.rstrip("s")) if dur_str else 0.0
        return {"distance_m": r.get("distanceMeters", 0), "duration_s": dur_s,
                "wall_ms": wall, "status": "OK", "error": None}
    except Exception as e:
        return {"distance_m": None, "duration_s": None, "wall_ms": 0, "status": "EXC", "error": str(e)}


def hit_osrm(origin: str, dest: str, _cfg) -> dict:
    lat1, lon1 = _ll(origin); lat2, lon2 = _ll(dest)
    url = f"{OSRM_BASE}/route/v1/driving/{lon1},{lat1};{lon2},{lat2}?overview=false"
    req = urllib.request.Request(url, headers={"User-Agent": "od-panel/1.0"})
    try:
        body, wall = _request(req)
        data = json.loads(body.decode())
        routes = data.get("routes") or []
        if not routes or data.get("code") != "Ok":
            return {"distance_m": None, "duration_s": None, "wall_ms": wall,
                    "status": data.get("code") or "?", "error": None}
        r = routes[0]
        return {"distance_m": r["distance"], "duration_s": r["duration"],
                "wall_ms": wall, "status": "OK", "error": None}
    except Exception as e:
        return {"distance_m": None, "duration_s": None, "wall_ms": 0, "status": "EXC", "error": str(e)}


def hit_mapbox(origin: str, dest: str, token: str) -> dict:
    lat1, lon1 = _ll(origin); lat2, lon2 = _ll(dest)
    qs = urllib.parse.urlencode({"access_token": token, "overview": "false",
                                 "geometries": "geojson"})
    url = f"{MAPBOX_BASE}/{lon1},{lat1};{lon2},{lat2}?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "od-panel/1.0"})
    try:
        body, wall = _request(req)
        data = json.loads(body.decode())
        routes = data.get("routes") or []
        if not routes:
            return {"distance_m": None, "duration_s": None, "wall_ms": wall,
                    "status": data.get("code") or "NO_ROUTE", "error": None}
        r = routes[0]
        return {"distance_m": r["distance"], "duration_s": r["duration"],
                "wall_ms": wall, "status": "OK", "error": None}
    except Exception as e:
        return {"distance_m": None, "duration_s": None, "wall_ms": 0, "status": "EXC", "error": str(e)}


def hit_ors(origin: str, dest: str, key: str) -> dict:
    lat1, lon1 = _ll(origin); lat2, lon2 = _ll(dest)
    body_json = json.dumps({"coordinates": [[lon1, lat1], [lon2, lat2]]}).encode()
    req = urllib.request.Request(
        ORS_BASE, data=body_json,
        headers={"Authorization": key, "Content-Type": "application/json",
                 "User-Agent": "od-panel/1.0"},
    )
    try:
        body, wall = _request(req)
        data = json.loads(body.decode())
        routes = data.get("routes") or []
        if not routes:
            return {"distance_m": None, "duration_s": None, "wall_ms": wall,
                    "status": "NO_ROUTE", "error": None}
        s = routes[0]["summary"]
        return {"distance_m": s["distance"], "duration_s": s["duration"],
                "wall_ms": wall, "status": "OK", "error": None}
    except Exception as e:
        return {"distance_m": None, "duration_s": None, "wall_ms": 0, "status": "EXC", "error": str(e)}


def hit_graphhopper(origin: str, dest: str, key: str) -> dict:
    # GraphHopper expects repeated 'point' params, urlencode handles lists via doseq.
    qs = urllib.parse.urlencode(
        [("point", origin), ("point", dest), ("vehicle", "car"),
         ("calc_points", "false"), ("instructions", "false"), ("key", key)]
    )
    req = urllib.request.Request(f"{GRAPHHOPPER_BASE}?{qs}",
                                 headers={"User-Agent": "od-panel/1.0"})
    try:
        body, wall = _request(req)
        data = json.loads(body.decode())
        paths = data.get("paths") or []
        if not paths:
            return {"distance_m": None, "duration_s": None, "wall_ms": wall,
                    "status": data.get("message", "NO_PATH"), "error": None}
        p = paths[0]
        return {"distance_m": p["distance"], "duration_s": p["time"] / 1000.0,
                "wall_ms": wall, "status": "OK", "error": None}
    except Exception as e:
        return {"distance_m": None, "duration_s": None, "wall_ms": 0, "status": "EXC", "error": str(e)}


def hit_tomtom(origin: str, dest: str, key: str) -> dict:
    lat1, lon1 = _ll(origin); lat2, lon2 = _ll(dest)
    url = f"{TOMTOM_BASE}/{lat1},{lon1}:{lat2},{lon2}/json?{urllib.parse.urlencode({'key': key, 'traffic': 'false'})}"
    req = urllib.request.Request(url, headers={"User-Agent": "od-panel/1.0"})
    try:
        body, wall = _request(req)
        data = json.loads(body.decode())
        routes = data.get("routes") or []
        if not routes:
            return {"distance_m": None, "duration_s": None, "wall_ms": wall,
                    "status": "NO_ROUTE", "error": None}
        s = routes[0]["summary"]
        return {"distance_m": s["lengthInMeters"], "duration_s": s["travelTimeInSeconds"],
                "wall_ms": wall, "status": "OK", "error": None}
    except Exception as e:
        return {"distance_m": None, "duration_s": None, "wall_ms": 0, "status": "EXC", "error": str(e)}


def hit_valhalla(origin: str, dest: str, base: str) -> dict:
    lat1, lon1 = _ll(origin); lat2, lon2 = _ll(dest)
    body_json = json.dumps({
        "locations": [{"lat": lat1, "lon": lon1}, {"lat": lat2, "lon": lon2}],
        "costing": "auto",
        "units": "kilometers",
    }).encode()
    req = urllib.request.Request(
        f"{base.rstrip('/')}/route", data=body_json,
        headers={"Content-Type": "application/json", "User-Agent": "od-panel/1.0"},
    )
    try:
        body, wall = _request(req)
        data = json.loads(body.decode())
        trip = data.get("trip") or {}
        summary = trip.get("summary") or {}
        if "length" not in summary:
            return {"distance_m": None, "duration_s": None, "wall_ms": wall,
                    "status": trip.get("status_message", "NO_ROUTE"), "error": None}
        # Valhalla 'length' is in km when units=kilometers; 'time' is seconds.
        return {"distance_m": summary["length"] * 1000.0, "duration_s": summary["time"],
                "wall_ms": wall, "status": "OK", "error": None}
    except Exception as e:
        return {"distance_m": None, "duration_s": None, "wall_ms": 0, "status": "EXC", "error": str(e)}


# (name, callable, list-of-acceptable-env-vars-or-None-if-keyless)
ALL_PROVIDERS = [
    ("open-distance", hit_open_distance, None),
    ("google",        hit_google,        ["GOOGLE_MAPS_API_KEY", "GOOGLE_API_KEY"]),
    ("osrm",          hit_osrm,          None),
    ("mapbox",        hit_mapbox,        ["MAPBOX_ACCESS_TOKEN", "MAPBOX_KEY"]),
    ("ors",           hit_ors,           ["ORS_API_KEY", "HEIGIT_KEY"]),
    ("graphhopper",   hit_graphhopper,   ["GRAPHHOPPER_API_KEY", "GRACE_HOPPER_KEY"]),
    ("tomtom",        hit_tomtom,        ["TOMTOM_API_KEY", "TOMTOM_KEY"]),
    ("valhalla",      hit_valhalla,      ["VALHALLA_BASE_URL"]),
]

# Politeness delay (sec) per provider, to stay under free-tier rate limits.
DELAY_S = {"osrm": 1.1, "graphhopper": 1.1, "ors": 1.6, "valhalla": 0.0,
           "google": 0.1, "mapbox": 0.1, "tomtom": 0.25, "open-distance": 0.0}


def active_providers(only: set[str] | None):
    out = []
    for name, fn, env_options in ALL_PROVIDERS:
        if only is not None and name not in only:
            continue
        if env_options is None:
            out.append((name, fn, None))
            continue
        cfg = next((os.environ[v] for v in env_options if os.environ.get(v)), None)
        if not cfg:
            continue
        out.append((name, fn, cfg))
    return out


def fmt_mi(meters):
    return f"{meters/1609.344:.1f}" if meters else "—"


def fmt_min(seconds):
    return f"{seconds/60:.0f}" if seconds else "—"


def fmt_pct(x):
    return "—" if x is None else f"{x:+.1f}%"


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="Write a markdown report here (default: stdout)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default="", help="Comma-separated provider whitelist")
    ap.add_argument("--json-out", help="Also dump raw rows here as JSON")
    args = ap.parse_args(argv)

    only = set(s.strip() for s in args.only.split(",") if s.strip()) if args.only else None
    providers = active_providers(only)
    if not providers:
        print("ERROR: no providers active. Set keys or pass --only.", file=sys.stderr)
        return 1

    names = [p[0] for p in providers]
    print(f"[panel] providers: {', '.join(names)}", flush=True)

    routes = ROUTES[:args.limit] if args.limit else ROUTES
    rows = []  # one per route

    for label, cat, o, d in routes:
        print(f"[panel] {label}...", flush=True)
        results = {}
        for name, fn, cfg in providers:
            r = fn(o, d, cfg)
            results[name] = r
            tag = r["status"]
            mi = fmt_mi(r["distance_m"])
            mn = fmt_min(r["duration_s"])
            print(f"  {name:>14}: {tag:>6}  {mi:>6} mi  {mn:>4} min  ({r['wall_ms']} ms)", flush=True)
            time.sleep(DELAY_S.get(name, 0.0))
        rows.append({"label": label, "category": cat, "results": results})

    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(rows, f, indent=2)

    # -----------------------------------------------------------------------
    # Report
    # -----------------------------------------------------------------------
    lines = []
    lines.append("# Routing accuracy panel — multi-provider comparison\n\n")
    lines.append(f"Routes: {len(rows)}  ·  Providers: {len(names)} ({', '.join(names)})  ·  "
                 f"Generated: {time.strftime('%Y-%m-%d')}\n\n")
    lines.append("No provider is treated as ground truth. The headline number for each "
                 "category is the *spread* across providers (max - min, as % of median) — "
                 "i.e. how much working routing engines disagree. Per provider we then show "
                 "deviation from the **panel median** so you can see where each one sits.\n\n")

    # Per-category summary
    by_cat: dict[str, list[dict]] = {}
    for r in rows:
        by_cat.setdefault(r["category"], []).append(r)

    lines.append("## Distance spread by category\n\n")
    head = "| Category | Routes | Spread (max-min, % of median) | " + " | ".join(
        f"Δ {n} (median)" for n in names) + " |\n"
    sep = "|---|---:|---:|" + ":---:|" * len(names) + "\n"
    lines.append(head); lines.append(sep)
    for cat, rs in sorted(by_cat.items()):
        spreads = []
        per_provider_devs: dict[str, list[float]] = {n: [] for n in names}
        for r in rs:
            dists = [r["results"][n]["distance_m"] for n in names
                     if r["results"][n]["distance_m"] is not None]
            if len(dists) < 2:
                continue
            mn, mx = min(dists), max(dists)
            med = statistics.median(dists)
            if med:
                spreads.append((mx - mn) / med * 100)
            for n in names:
                v = r["results"][n]["distance_m"]
                if v is not None and med:
                    per_provider_devs[n].append((v - med) / med * 100)
        spread = statistics.median(spreads) if spreads else 0.0
        cells = [f"{cat}", f"{len(rs)}", f"{spread:.1f}%"]
        for n in names:
            d = per_provider_devs[n]
            cells.append(f"{statistics.median(d):+.1f}%" if d else "—")
        lines.append("| " + " | ".join(cells) + " |\n")

    lines.append("\n## Duration spread by category\n\n")
    lines.append(head.replace("Distance", "Duration"))
    lines.append(sep)
    for cat, rs in sorted(by_cat.items()):
        spreads = []
        per_provider_devs: dict[str, list[float]] = {n: [] for n in names}
        for r in rs:
            durs = [r["results"][n]["duration_s"] for n in names
                    if r["results"][n]["duration_s"] is not None]
            if len(durs) < 2:
                continue
            mn, mx = min(durs), max(durs)
            med = statistics.median(durs)
            if med:
                spreads.append((mx - mn) / med * 100)
            for n in names:
                v = r["results"][n]["duration_s"]
                if v is not None and med:
                    per_provider_devs[n].append((v - med) / med * 100)
        spread = statistics.median(spreads) if spreads else 0.0
        cells = [f"{cat}", f"{len(rs)}", f"{spread:.1f}%"]
        for n in names:
            d = per_provider_devs[n]
            cells.append(f"{statistics.median(d):+.1f}%" if d else "—")
        lines.append("| " + " | ".join(cells) + " |\n")

    # Latency rollup -- median + p90 wall time per provider, OK responses only.
    # NOTE: these numbers are *from the benchmark machine*, not absolute server
    # latencies -- they include the network hop to each provider's endpoint
    # plus our serialization. Useful for relative comparison ("commercial = X,
    # us = Y, valhalla = Z"); not a guaranteed end-to-end SLO claim.
    lines.append("\n## Latency by provider (wall time from benchmark host)\n\n")
    lines.append("| Provider | Median ms | p90 ms | OK count |\n")
    lines.append("|---|---:|---:|---:|\n")
    for n in names:
        oks = [r["results"][n]["wall_ms"] for r in rows
               if r["results"][n]["status"] == "OK" and r["results"][n]["wall_ms"]]
        if not oks:
            lines.append(f"| {n} | — | — | 0 |\n")
            continue
        oks.sort()
        med = statistics.median(oks)
        p90 = oks[int(len(oks) * 0.9)] if len(oks) > 1 else oks[0]
        lines.append(f"| {n} | {med:.0f} | {p90:.0f} | {len(oks)} |\n")

    # Per-route detail
    lines.append("\n## Per-route detail (distance, miles)\n\n")
    lines.append("| Route | Cat | " + " | ".join(names) + " | Spread |\n")
    lines.append("|---|---|" + "---:|" * len(names) + "---:|\n")
    for r in rows:
        cells = [r["label"], r["category"]]
        dists = []
        for n in names:
            v = r["results"][n]["distance_m"]
            cells.append(fmt_mi(v))
            if v is not None:
                dists.append(v)
        if len(dists) >= 2:
            med = statistics.median(dists)
            spread = (max(dists) - min(dists)) / med * 100 if med else 0
            cells.append(f"{spread:.1f}%")
        else:
            cells.append("—")
        lines.append("| " + " | ".join(cells) + " |\n")

    lines.append("\n## Per-route detail (duration, minutes)\n\n")
    lines.append("| Route | Cat | " + " | ".join(names) + " | Spread |\n")
    lines.append("|---|---|" + "---:|" * len(names) + "---:|\n")
    for r in rows:
        cells = [r["label"], r["category"]]
        durs = []
        for n in names:
            v = r["results"][n]["duration_s"]
            cells.append(fmt_min(v))
            if v is not None:
                durs.append(v)
        if len(durs) >= 2:
            med = statistics.median(durs)
            spread = (max(durs) - min(durs)) / med * 100 if med else 0
            cells.append(f"{spread:.1f}%")
        else:
            cells.append("—")
        lines.append("| " + " | ".join(cells) + " |\n")

    text = "".join(lines)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
        print(f"\n[panel] wrote {args.out}", file=sys.stderr)
    else:
        print("\n" + text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
