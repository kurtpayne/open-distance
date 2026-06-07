#!/usr/bin/env bash
# Acceptance test: poll /healthz, pick random Bay Area addresses, curl Distance Matrix.
set -euo pipefail

cd "$(dirname "$0")/.."
: "${OD_API_KEY:?Need OD_API_KEY in env}"

BASE="${OD_API_BASE:-${HHAPI_BASE:-https://open-distance.com}}"

echo "[acceptance] waiting for $BASE/healthz ..."
for i in $(seq 1 60); do
  RESP=$(curl -fsS "$BASE/healthz" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    echo "[acceptance] healthz: $RESP"
    break
  fi
  echo "  attempt $i ..."
  sleep 5
done

if ! echo "$RESP" | grep -q '"status":"ok"'; then
  echo "[acceptance] healthz never reached ok" >&2
  exit 1
fi

CSV="data/addresses.csv"
if [[ ! -f "$CSV" ]]; then
  echo "[acceptance] missing $CSV" >&2
  exit 1
fi

python3 - "$CSV" "$BASE" "$OD_API_KEY" <<'PY'
import csv, random, sys, urllib.parse, urllib.request, json
csv_path, base, key = sys.argv[1], sys.argv[2], sys.argv[3]

# group by city (token after first ", ")
by_city = {}
with open(csv_path) as f:
    r = csv.DictReader(f)
    for row in r:
        n = row["normalized"]
        parts = n.split(", ")
        if len(parts) < 2: continue
        city = parts[1].split(" ")[0]
        by_city.setdefault(city, []).append(n)

cities = [c for c, rows in by_city.items() if len(rows) >= 5]
random.seed()
random.shuffle(cities)

def hit(url):
    req = urllib.request.Request(url, headers={"user-agent": "hhapi-acceptance"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode()
    return r.status, body

urls = []
for city in cities[:3]:
    pool = by_city[city]
    sample = random.sample(pool, k=min(5, len(pool)))
    origins = sample[:2]
    destinations = sample[2:5]
    o = "|".join(origins)
    d = "|".join(destinations)
    url = f"{base}/maps/api/distancematrix/json?origins={urllib.parse.quote(o)}&destinations={urllib.parse.quote(d)}&units=imperial&key={key}"
    urls.append(url)

ok = 0
for url in urls:
    print("\nGET", url)
    status, body = hit(url)
    print("  HTTP", status)
    try:
        j = json.loads(body)
    except Exception:
        print("  bad JSON")
        continue
    print("  top status:", j.get("status"))
    rows = j.get("rows", [])
    any_ok = False
    for row in rows:
        for el in row.get("elements", []):
            print("    el:", el.get("status"),
                  el.get("distance", {}).get("text"),
                  el.get("duration", {}).get("text"))
            if el.get("status") == "OK" and el.get("distance", {}).get("value", 0) > 0:
                any_ok = True
    if j.get("status") == "OK" and any_ok:
        ok += 1
print(f"\n[acceptance] {ok}/{len(urls)} requests passed")
if ok == 0:
    sys.exit(1)
PY
echo "[acceptance] all good."
