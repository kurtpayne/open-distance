"""US-48 + DC state catalog.

For each state:
  code:     USPS 2-letter code (used as D1 shard suffix, key prefix, etc.)
  name:     human name
  fips:     FIPS state code (used in NAD/TIGER paths)
  bbox:     (lon_min, lat_min, lon_max, lat_max)   -- generous, includes coastal buffer
  geofabrik: filename stem under https://download.geofabrik.de/north-america/us/
"""
from __future__ import annotations

from typing import NamedTuple


class State(NamedTuple):
    code: str
    name: str
    fips: str
    bbox: tuple[float, float, float, float]
    geofabrik: str


# 48 contiguous states + DC. Excludes AK, HI per "lower 48" requirement.
STATES: list[State] = [
    State("AL", "Alabama",        "01", (-88.47, 30.14, -84.89, 35.01), "alabama"),
    State("AZ", "Arizona",        "04", (-114.82, 31.33, -109.05, 37.00), "arizona"),
    State("AR", "Arkansas",       "05", (-94.62, 33.00, -89.64, 36.50), "arkansas"),
    State("CA", "California",     "06", (-124.48, 32.53, -114.13, 42.01), "california"),
    State("CO", "Colorado",       "08", (-109.06, 36.99, -102.04, 41.00), "colorado"),
    State("CT", "Connecticut",    "09", ( -73.73, 40.95,  -71.79, 42.05), "connecticut"),
    State("DE", "Delaware",       "10", ( -75.79, 38.45,  -75.04, 39.84), "delaware"),
    State("DC", "Dist. of Columbia","11", (-77.12, 38.79, -76.91, 38.99), "district-of-columbia"),
    State("FL", "Florida",        "12", ( -87.64, 24.40,  -79.97, 31.00), "florida"),
    State("GA", "Georgia",        "13", ( -85.61, 30.36,  -80.84, 35.00), "georgia"),
    State("ID", "Idaho",          "16", (-117.24, 41.99, -111.04, 49.00), "idaho"),
    State("IL", "Illinois",       "17", ( -91.51, 36.97,  -87.50, 42.51), "illinois"),
    State("IN", "Indiana",        "18", ( -88.10, 37.77,  -84.78, 41.76), "indiana"),
    State("IA", "Iowa",           "19", ( -96.64, 40.38,  -90.14, 43.50), "iowa"),
    State("KS", "Kansas",         "20", (-102.05, 36.99,  -94.59, 40.00), "kansas"),
    State("KY", "Kentucky",       "21", ( -89.57, 36.50,  -81.96, 39.15), "kentucky"),
    State("LA", "Louisiana",      "22", ( -94.04, 28.93,  -88.82, 33.02), "louisiana"),
    State("ME", "Maine",          "23", ( -71.08, 43.06,  -66.93, 47.46), "maine"),
    State("MD", "Maryland",       "24", ( -79.49, 37.91,  -75.05, 39.72), "maryland"),
    State("MA", "Massachusetts",  "25", ( -73.51, 41.24,  -69.93, 42.89), "massachusetts"),
    State("MI", "Michigan",       "26", ( -90.42, 41.70,  -82.41, 48.31), "michigan"),
    State("MN", "Minnesota",      "27", ( -97.24, 43.50,  -89.49, 49.39), "minnesota"),
    State("MS", "Mississippi",    "28", ( -91.66, 30.17,  -88.09, 35.01), "mississippi"),
    State("MO", "Missouri",       "29", ( -95.77, 35.99,  -89.10, 40.62), "missouri"),
    State("MT", "Montana",        "30", (-116.05, 44.36, -104.04, 49.00), "montana"),
    State("NE", "Nebraska",       "31", (-104.06, 39.99,  -95.31, 43.00), "nebraska"),
    State("NV", "Nevada",         "32", (-120.01, 35.00, -114.04, 42.00), "nevada"),
    State("NH", "New Hampshire",  "33", ( -72.56, 42.69,  -70.61, 45.31), "new-hampshire"),
    State("NJ", "New Jersey",     "34", ( -75.56, 38.92,  -73.89, 41.36), "new-jersey"),
    State("NM", "New Mexico",     "35", (-109.05, 31.33, -103.00, 37.00), "new-mexico"),
    State("NY", "New York",       "36", ( -79.76, 40.50,  -71.86, 45.02), "new-york"),
    State("NC", "North Carolina", "37", ( -84.32, 33.84,  -75.46, 36.59), "north-carolina"),
    State("ND", "North Dakota",   "38", (-104.05, 45.94,  -96.55, 49.00), "north-dakota"),
    State("OH", "Ohio",           "39", ( -84.82, 38.40,  -80.52, 42.33), "ohio"),
    State("OK", "Oklahoma",       "40", (-103.00, 33.62,  -94.43, 37.00), "oklahoma"),
    State("OR", "Oregon",         "41", (-124.57, 41.99, -116.46, 46.27), "oregon"),
    State("PA", "Pennsylvania",   "42", ( -80.52, 39.72,  -74.69, 42.27), "pennsylvania"),
    State("RI", "Rhode Island",   "44", ( -71.91, 41.15,  -71.12, 42.02), "rhode-island"),
    State("SC", "South Carolina", "45", ( -83.36, 32.03,  -78.55, 35.22), "south-carolina"),
    State("SD", "South Dakota",   "46", (-104.06, 42.48,  -96.44, 45.95), "south-dakota"),
    State("TN", "Tennessee",      "47", ( -90.31, 34.98,  -81.65, 36.68), "tennessee"),
    State("TX", "Texas",          "48", (-106.65, 25.84,  -93.51, 36.50), "texas"),
    State("UT", "Utah",           "49", (-114.05, 36.99, -109.04, 42.00), "utah"),
    State("VT", "Vermont",        "50", ( -73.44, 42.73,  -71.46, 45.02), "vermont"),
    State("VA", "Virginia",       "51", ( -83.68, 36.54,  -75.24, 39.47), "virginia"),
    State("WA", "Washington",     "53", (-124.85, 45.54, -116.92, 49.00), "washington"),
    State("WV", "West Virginia",  "54", ( -82.65, 37.20,  -77.72, 40.64), "west-virginia"),
    State("WI", "Wisconsin",      "55", ( -92.89, 42.49,  -86.25, 47.08), "wisconsin"),
    State("WY", "Wyoming",        "56", (-111.06, 40.99, -104.05, 45.01), "wyoming"),
]

BY_CODE: dict[str, State] = {s.code: s for s in STATES}


def states_intersecting_tile(lon_min: float, lat_min: float, lon_max: float, lat_max: float) -> list[State]:
    """All states whose bbox overlaps a given tile bbox."""
    out = []
    for s in STATES:
        a, b, c, d = s.bbox
        if a > lon_max or c < lon_min or b > lat_max or d < lat_min:
            continue
        out.append(s)
    return out
