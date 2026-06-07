#!/usr/bin/env python3
"""Stream the NAD ZIP, slice into per-state normalized address CSVs.

Input: data/v2/nad/nad-txt-2026q1.zip  (ZIP64, ~8.5 GB compressed, ~40 GB CSV)
Inside: TXT/NAD_r22.txt -- column schema in TXT/schema.ini (also embedded below).

Output per state: data/v2/out/<version>/addresses/<STATE>.csv
  columns: id, normalized, lat, lon, tier  (tier='rooftop' for all NAD points)
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
import zipfile
from pathlib import Path

from etl.config import DATA, addresses_csv
from etl.states import BY_CODE


def nad_csv(version: str, state_code: str):
    p = DATA / "out" / version / "addresses"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{state_code}.nad.csv"


# NAD r22 column names (per schema.ini).
COLUMNS = [
    "OID_", "AddNum_Pre", "Add_Number", "AddNum_Suf", "AddNo_Full",
    "St_PreMod", "St_PreDir", "St_PreTyp", "St_PreSep", "St_Name",
    "St_PosTyp", "St_PosDir", "St_PosMod", "StNam_Full",
    "Building", "Floor", "Unit", "Room", "Seat",
    "Addtl_Loc", "SubAddress", "LandmkName",
    "County", "Inc_Muni", "Post_City", "Census_Plc",
    "Uninc_Comm", "Nbrhd_Comm",
    "NatAmArea", "NatAmSub", "Urbnztn_PR", "PlaceOther", "PlaceNmTyp",
    "State", "Zip_Code", "Plus_4", "UUID", "AddAuth", "AddrRefSys",
    "Longitude", "Latitude", "NatGrid", "Elevation", "Placement", "AddrPoint",
    "Related_ID", "RelateType", "ParcelSrc", "Parcel_ID",
    "AddrClass", "Lifecycle",
    "Effective", "Expire", "DateUpdate",
    "AnomStatus", "LocatnDesc", "Addr_Type", "DeliverTyp",
    "NAD_Source", "DataSet_ID",
]

SUFFIX_ABBR = {
    "STREET": "st", "AVENUE": "ave", "BOULEVARD": "blvd", "ROAD": "rd",
    "DRIVE": "dr", "LANE": "ln", "COURT": "ct", "PLACE": "pl", "TERRACE": "ter",
    "TRAIL": "trl", "PARKWAY": "pkwy", "HIGHWAY": "hwy", "CIRCLE": "cir",
    "SQUARE": "sq", "WAY": "way", "ALLEY": "aly", "PLAZA": "plz",
    "STR": "st", "AVE": "ave", "BLVD": "blvd", "RD": "rd", "DR": "dr",
    "LN": "ln", "CT": "ct", "PL": "pl", "TER": "ter", "TRL": "trl",
    "PKWY": "pkwy", "HWY": "hwy", "CIR": "cir", "SQ": "sq", "ALY": "aly",
    "PLZ": "plz",
}
DIR_ABBR = {
    "NORTH": "n", "SOUTH": "s", "EAST": "e", "WEST": "w",
    "NORTHEAST": "ne", "NORTHWEST": "nw", "SOUTHEAST": "se", "SOUTHWEST": "sw",
    "N": "n", "S": "s", "E": "e", "W": "w",
    "NE": "ne", "NW": "nw", "SE": "se", "SW": "sw",
}


def abbr_token(tok: str) -> str:
    u = tok.upper().strip(".,")
    if not u: return ""
    if u in SUFFIX_ABBR: return SUFFIX_ABBR[u]
    if u in DIR_ABBR: return DIR_ABBR[u]
    return u.lower()


def normalize_tokens(s: str) -> list[str]:
    return [abbr_token(t) for t in s.split() if t]


def build_normalized(row: dict) -> tuple[str, str, float, float] | None:
    state = (row.get("State") or "").strip().upper()
    if len(state) != 2:
        return None

    # House number: prefer AddNo_Full (preformatted with pre/suf) over Add_Number.
    hn = (row.get("AddNo_Full") or row.get("Add_Number") or "").strip()
    if not hn:
        return None
    # Street name: prefer StNam_Full (preformatted) over the individual parts.
    street = (row.get("StNam_Full") or "").strip()
    if not street:
        parts = [
            row.get("St_PreDir"), row.get("St_PreTyp"), row.get("St_Name"),
            row.get("St_PosTyp"), row.get("St_PosDir"), row.get("St_PosMod"),
        ]
        street = " ".join((p or "").strip() for p in parts if (p or "").strip())
    if not street.strip():
        return None

    # Coords.
    try:
        lat = float(row.get("Latitude") or "")
        lon = float(row.get("Longitude") or "")
    except ValueError:
        return None
    if abs(lat) > 90 or abs(lon) > 180 or (lat == 0 and lon == 0):
        return None

    city = (row.get("Inc_Muni") or row.get("Post_City") or row.get("Census_Plc") or "").strip()
    zipc = (row.get("Zip_Code") or "").strip()
    plus4 = (row.get("Plus_4") or "").strip()

    # Normalize tokens.
    hn_norm = " ".join(normalize_tokens(hn))
    st_norm = " ".join(normalize_tokens(street))
    addr_line = (hn_norm + " " + st_norm).strip()
    tail = ", ".join(p for p in [city.lower(), state.lower()] if p)
    out = f"{addr_line}, {tail}"
    if zipc:
        if plus4 and plus4 != "0":
            out += f" {zipc}-{plus4}"
        else:
            out += f" {zipc}"
    return state, out, lat, lon


def log(msg: str) -> None:
    print(f"[nad] {msg}", flush=True)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--zip", required=True, help="Path to NAD ZIP")
    ap.add_argument("--inner", default="TXT/NAD_r22.txt", help="Name of the CSV entry inside the ZIP")
    ap.add_argument("--states", nargs="*", help="Optional state code filter (default: all in BY_CODE)")
    ap.add_argument("--limit", type=int, default=0, help="Optional row limit for testing")
    args = ap.parse_args(argv)

    zip_path = Path(args.zip)
    if not zip_path.exists():
        log(f"ERROR: {zip_path} does not exist")
        return 1

    accept_states = set(args.states) if args.states else set(BY_CODE)

    log(f"opening {zip_path}")
    with zipfile.ZipFile(zip_path) as z:
        if args.inner not in z.namelist():
            log(f"ERROR: entry {args.inner} not in zip")
            return 1
        info = z.getinfo(args.inner)
        log(f"  entry size: {info.file_size/1e9:.1f} GB")

        writers: dict[str, csv.writer] = {}
        files: dict[str, io.TextIOBase] = {}
        counts: dict[str, int] = {}

        with z.open(args.inner) as raw:
            # Wrap with BufferedReader for fast reads, then TextIOWrapper.
            buffered = io.BufferedReader(raw, buffer_size=8 * 1024 * 1024)  # 8 MB read buffer
            text = io.TextIOWrapper(buffered, encoding="utf-8-sig", errors="replace")
            reader = csv.DictReader(text, fieldnames=None)
            # Verify header matches our expected COLUMNS (loosely).
            seen_cols = reader.fieldnames or []
            log(f"  header has {len(seen_cols)} columns; first 5: {seen_cols[:5]}")

            total = 0
            kept = 0
            for row in reader:
                total += 1
                if args.limit and total > args.limit:
                    break
                if total % 1_000_000 == 0:
                    log(f"  read {total:,}  kept {kept:,}")

                r = build_normalized(row)
                if not r:
                    continue
                state, normalized, lat, lon = r
                if state not in accept_states:
                    continue
                w = writers.get(state)
                if w is None:
                    out_path = nad_csv(args.version, state)
                    fh = open(out_path, "w", encoding="utf-8", newline="")
                    w = csv.writer(fh)
                    w.writerow(["id", "normalized", "lat", "lon", "tier"])
                    writers[state] = w
                    files[state] = fh
                    counts[state] = 0
                counts[state] += 1
                w.writerow([counts[state], normalized, f"{lat:.7f}", f"{lon:.7f}", "rooftop"])
                kept += 1

            log(f"done: read {total:,}, kept {kept:,}")

    for fh in files.values():
        fh.close()

    for state, n in sorted(counts.items()):
        log(f"  {state}: {n:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
