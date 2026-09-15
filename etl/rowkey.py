#!/usr/bin/env python3
"""Shared row filters + content keys for the D1 delta loader.

Both sides of every diff (the local CSV and the D1 mirror) MUST go through the
same functions here, otherwise the diff sees phantom churn.

Canonical forms
---------------
* Coordinates are canonicalised via ``repr(float(x))``.  The legacy loaders
  emit ``f"{float(x)}"`` (== repr) as a bare SQL literal, and D1 hands REAL
  values back as JSON numbers that round-trip through ``float`` exactly, so
  ``repr(float())`` is identical whether the value came from the CSV text
  (``38.9274680``) or from D1 (``38.927468``).  ``%.7f`` text is NOT used
  as a key (206/1000 DC values differ textually from repr).
* NULL / missing text columns (segments ``zip``, ``side``) canonicalise to
  the empty string, matching what the legacy loader inserted (``esc(zipc or
  '')``).
* Integers (``from_hn``/``to_hn``) canonicalise via ``str(int(x))``.

Filters
-------
``addr_row_from_csv`` / ``seg_row_from_csv`` apply exactly the skip rules of
``etl/load_d1_parallel.py`` and ``etl/load_d1_segments.py`` so that rows the
legacy loader silently dropped are not re-planned as inserts forever.

Keys
----
``addr_key`` / ``seg_key`` return an unsigned 64-bit blake2b digest of the
canonical tuple.  Collision odds for 32M rows at 64 bits are ~2.7e-5
(birthday bound); the sync tool additionally checks that a planned insert's
key is not already present, so a collision can only ever cause a *missed*
insert, never a wrong delete.
"""
from __future__ import annotations

import hashlib
from typing import Iterable, Iterator, NamedTuple, Optional


class AddrRow(NamedTuple):
    normalized: str
    lat: float
    lon: float
    tier: str


class SegRow(NamedTuple):
    street_normalized: str
    zip: str
    from_hn: int
    to_hn: int
    side: str
    from_lat: float
    from_lon: float
    to_lat: float
    to_lon: float


# ---------------------------------------------------------------------------
# canonicalisation
# ---------------------------------------------------------------------------
def canon_float(x) -> str:
    return repr(float(x))


def canon_text(x) -> str:
    return "" if x is None else str(x)


def canon_int(x) -> str:
    return str(int(x))


def _u64(s: str) -> int:
    return int.from_bytes(hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest(), "little")


def addr_key(r: AddrRow) -> int:
    return _u64(f"{r.normalized}|{canon_float(r.lat)}|{canon_float(r.lon)}|{r.tier}")


def seg_key(r: SegRow) -> int:
    return _u64(
        "|".join(
            (
                r.street_normalized,
                canon_text(r.zip),
                canon_int(r.from_hn),
                canon_int(r.to_hn),
                canon_text(r.side),
                canon_float(r.from_lat),
                canon_float(r.from_lon),
                canon_float(r.to_lat),
                canon_float(r.to_lon),
            )
        )
    )


# ---------------------------------------------------------------------------
# CSV-side filters (mirror the legacy loaders exactly)
# ---------------------------------------------------------------------------
def addr_row_from_csv(row: list[str]) -> Optional[AddrRow]:
    """etl/load_d1_parallel.py: skip len<5, skip float parse errors."""
    if len(row) < 5:
        return None
    _id, norm, lat, lon, tier = row[:5]
    try:
        latf = float(lat)
        lonf = float(lon)
    except ValueError:
        return None
    return AddrRow(norm, latf, lonf, tier)


def seg_row_from_csv(row: list[str]) -> Optional[SegRow]:
    """etl/load_d1_segments.py: skip len<10, parse errors, empty street."""
    if len(row) < 10:
        return None
    try:
        _, street, zipc, lo, hi, side, fla, flo, tla, tlo = row[:10]
        lo_i = int(lo)
        hi_i = int(hi)
        fla_f = float(fla)
        flo_f = float(flo)
        tla_f = float(tla)
        tlo_f = float(tlo)
    except (ValueError, IndexError):
        return None
    if not street:
        return None
    return SegRow(street, zipc or "", lo_i, hi_i, side or "", fla_f, flo_f, tla_f, tlo_f)


# ---------------------------------------------------------------------------
# D1-side constructors (from /query JSON rows)
# ---------------------------------------------------------------------------
def addr_row_from_d1(d: dict) -> AddrRow:
    return AddrRow(str(d["normalized"]), float(d["lat"]), float(d["lon"]), str(d["tier"]))


def seg_row_from_d1(d: dict) -> SegRow:
    return SegRow(
        str(d["street_normalized"]),
        canon_text(d.get("zip")),
        int(d["from_hn"]),
        int(d["to_hn"]),
        canon_text(d.get("side")),
        float(d["from_lat"]),
        float(d["from_lon"]),
        float(d["to_lat"]),
        float(d["to_lon"]),
    )


# ---------------------------------------------------------------------------
# SQL literal helpers (identical to the legacy loaders' formatting)
# ---------------------------------------------------------------------------
def esc(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def addr_values(id_: int, r: AddrRow) -> str:
    return f"({id_}, {esc(r.normalized)}, {canon_float(r.lat)}, {canon_float(r.lon)}, {esc(r.tier)})"


def seg_values(id_: int, r: SegRow) -> str:
    return (
        f"({id_}, {esc(r.street_normalized)}, {esc(r.zip)}, {r.from_hn}, {r.to_hn}, {esc(r.side)}, "
        f"{canon_float(r.from_lat)}, {canon_float(r.from_lon)}, {canon_float(r.to_lat)}, {canon_float(r.to_lon)})"
    )


def iter_csv_rows(path, kind: str) -> Iterator[tuple]:
    """Yield (key, row) for every row that passes the legacy filter."""
    import csv

    conv = addr_row_from_csv if kind == "addresses" else seg_row_from_csv
    keyf = addr_key if kind == "addresses" else seg_key
    with open(path, newline="") as f:
        rd = csv.reader(f)
        next(rd, None)
        for raw in rd:
            r = conv(raw)
            if r is None:
                continue
            yield keyf(r), r


if __name__ == "__main__":  # tiny self-check
    a = AddrRow("1 main st, x, dc 20001", 38.9274680, -77.0123456, "rooftop")
    b = AddrRow("1 main st, x, dc 20001", 38.927468, -77.0123456, "rooftop")
    assert addr_key(a) == addr_key(b)
    assert addr_row_from_csv(["1", "n", "x", "1.0", "t"]) is None
    assert seg_row_from_csv(["1", "", "20001", "1", "9", "L", "1", "2", "3", "4"]) is None
    print("rowkey self-check ok")
