#!/usr/bin/env python3
"""Regenerate src/panel_data.ts from a benchmark_panel.py markdown report.

Usage:
  python3 scripts/panel_to_ts.py /tmp/od-panel-final.md > src/panel_data.ts

The output is a TypeScript module exporting PANEL_SNAPSHOT (typed) -- the
shape src/site.ts imports for the /coverage HTML page and the FAQ Accuracy
answer numbers. See the existing src/panel_data.ts for the exact shape.
"""
from __future__ import annotations
import json
import re
import sys


def parse_panel(md: str) -> dict:
    prov_match = re.search(r"Providers: \d+ \(([^)]+)\)", md)
    if not prov_match:
        raise SystemExit("ERROR: couldn't parse provider list from panel md")
    providers = [p.strip() for p in prov_match.group(1).split(",")]
    date = re.search(r"Generated: (\d{4}-\d{2}-\d{2})", md).group(1)

    def parse_cat(name: str) -> dict:
        section = re.search(
            rf"## {name} spread by category\n\n\|.*?\n\|---.*?\n((?:\|.*?\n)+)",
            md, re.S,
        )
        if not section: return {}
        out = {}
        for line in section.group(1).strip().split("\n"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            cat, routes, spread = cells[0], int(cells[1]), float(cells[2].rstrip("%"))
            provs = {}
            for i, p in enumerate(providers):
                v = cells[3 + i]
                try:    provs[p] = float(v.replace("+", "").rstrip("%"))
                except: provs[p] = None
            out[cat] = {"routes": routes, "spread": spread, "providers": provs}
        return out

    def parse_routes(name: str, unit: str) -> list:
        section = re.search(
            rf"## Per-route detail \({name}.*?\n\|.*?\n\|---.*?\n((?:\|.*?\n)+)",
            md, re.S,
        )
        if not section: return []
        rows = []
        for line in section.group(1).strip().split("\n"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            route, cat = cells[0], cells[1]
            values = {}
            for i, p in enumerate(providers):
                v = cells[2 + i]
                try:    values[p] = float(v) if v != "—" else None
                except: values[p] = None
            try:    spread = float(cells[-1].rstrip("%"))
            except: spread = None
            rows.append({"route": route, "category": cat, "values": values, "spread": spread})
        return rows

    return {
        "generated": date,
        "providers": providers,
        "routes_total": 44,
        "distance": parse_cat("Distance"),
        "duration": parse_cat("Duration"),
        "distance_miles": parse_routes("distance", "mi"),
        "duration_minutes": parse_routes("duration", "min"),
    }


def to_ts_literal(v, indent=0) -> str:
    sp = "  " * indent
    if v is None:                       return "null"
    if isinstance(v, bool):              return "true" if v else "false"
    if isinstance(v, (int, float)):      return str(v)
    if isinstance(v, str):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(v, list):
        if not v: return "[]"
        return "[" + ", ".join(to_ts_literal(x) for x in v) + "]"
    if isinstance(v, dict):
        if not v: return "{}"
        items = []
        for k, val in v.items():
            # quote keys that aren't valid bare identifiers
            ks = '"' + k + '"' if (not k.replace("_", "").isalnum() or "-" in k) else k
            items.append(f"{sp}  {ks}: {to_ts_literal(val, indent+1)}")
        return "{\n" + ",\n".join(items) + f"\n{sp}}}"
    raise ValueError(repr(v))


HEADER = """\
// Auto-generated from scripts/benchmark_panel.py output. Regenerate via:
//   python3 scripts/benchmark_panel.py --out /tmp/od-panel.md
//   python3 scripts/panel_to_ts.py /tmp/od-panel.md > src/panel_data.ts

export interface PanelSnapshot {
  generated: string;
  providers: string[];
  routes_total: number;
  distance: Record<string, CategoryStat>;
  duration: Record<string, CategoryStat>;
  distance_miles: RouteRow[];
  duration_minutes: RouteRow[];
}
export interface CategoryStat {
  routes: number;
  spread: number;
  providers: Record<string, number | null>;
}
export interface RouteRow {
  route: string;
  category: string;
  values: Record<string, number | null>;
  spread: number | null;
}

export const PANEL_SNAPSHOT: PanelSnapshot = """


def main(argv):
    if len(argv) != 2:
        print("usage: panel_to_ts.py <panel.md>", file=sys.stderr)
        return 1
    with open(argv[1]) as f:
        md = f.read()
    snap = parse_panel(md)
    sys.stdout.write(HEADER + to_ts_literal(snap, 0) + ";\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
