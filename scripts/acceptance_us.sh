#!/usr/bin/env bash
# Cross-region acceptance test for v2 US-wide deployment.
# Avoids associative arrays so it runs on macOS's stock bash 3.2.
set -uo pipefail
: "${HHAPI_API_KEY:?Need HHAPI_API_KEY}"
BASE="${HHAPI_BASE:-https://hhapi.propspress.com}"

pass=0; fail=0

probe() {
  local label="$1"; local url="$2"; local check="$3"
  local body
  body=$(curl -sS --max-time 30 "$url" || true)
  if [[ -z "$body" ]]; then
    echo "FAIL: $label (no response)"; fail=$((fail+1)); return
  fi
  if echo "$body" | grep -qE "$check"; then
    echo "  ok: $label"; pass=$((pass+1))
  else
    echo "FAIL: $label"
    echo "  $body" | head -3
    fail=$((fail+1))
  fi
}

dm() {
  local orig="$1"; local dest="$2"
  echo "$BASE/maps/api/distancematrix/json?origins=$orig&destinations=$dest&units=imperial&key=$HHAPI_API_KEY"
}

echo "=== health ==="
probe "healthz" "$BASE/healthz" '"status":"ok"'

echo "=== auth ==="
probe "bad key -> REQUEST_DENIED" "$BASE/maps/api/distancematrix/json?origins=37.77,-122.42&destinations=37.44,-122.14&key=wrong" '"status":"REQUEST_DENIED"'

echo "=== within-metro coord routes ==="
probe "SF within"         "$(dm 37.7749,-122.4194 37.7849,-122.4094)" '"status":"OK".*"distance"'
probe "LA within"         "$(dm 34.0522,-118.2437 34.0622,-118.2337)" '"status":"OK".*"distance"'
probe "Seattle within"    "$(dm 47.6062,-122.3321 47.6162,-122.3221)" '"status":"OK".*"distance"'
probe "Portland within"   "$(dm 45.5152,-122.6784 45.5252,-122.6684)" '"status":"OK".*"distance"'
probe "Denver within"     "$(dm 39.7392,-104.9903 39.7492,-104.9803)" '"status":"OK".*"distance"'
probe "Austin within"     "$(dm 30.2672,-97.7431  30.2772,-97.7331)"  '"status":"OK".*"distance"'
probe "Houston within"    "$(dm 29.7604,-95.3698  29.7704,-95.3598)"  '"status":"OK".*"distance"'
probe "Chicago within"    "$(dm 41.8781,-87.6298  41.8881,-87.6198)"  '"status":"OK".*"distance"'
probe "Atlanta within"    "$(dm 33.7490,-84.3880  33.7590,-84.3780)"  '"status":"OK".*"distance"'
probe "Miami within"      "$(dm 25.7617,-80.1918  25.7717,-80.1818)"  '"status":"OK".*"distance"'
probe "Boston within"     "$(dm 42.3601,-71.0589  42.3701,-71.0489)"  '"status":"OK".*"distance"'
probe "NYC within"        "$(dm 40.7128,-74.0060  40.7228,-73.9960)"  '"status":"OK".*"distance"'
probe "DC within"         "$(dm 38.9072,-77.0369  38.9172,-77.0269)"  '"status":"OK".*"distance"'

echo "=== cross-region long coord routes ==="
probe "SF -> LA"         "$(dm 37.7749,-122.4194 34.0522,-118.2437)" '"status":"OK".*"distance"'
probe "Seattle -> PDX"   "$(dm 47.6062,-122.3321 45.5152,-122.6784)" '"status":"OK".*"distance"'
probe "Austin -> Houston" "$(dm 30.2672,-97.7431 29.7604,-95.3698)" '"status":"OK".*"distance"'
probe "NYC -> DC"        "$(dm 40.7128,-74.0060 38.9072,-77.0369)" '"status":"OK".*"distance"'
probe "Atlanta -> Miami" "$(dm 33.7490,-84.3880 25.7617,-80.1918)" '"status":"OK".*"distance"'

echo "=== cross-state commute ==="
probe "Niles MI -> Mishawaka IN"        "$(dm 41.8298,-86.2541 41.6620,-86.1586)" '"status":"OK".*"distance"'
probe "KCK -> KCMO"                     "$(dm 39.1142,-94.6275 39.0997,-94.5786)" '"status":"OK".*"distance"'
probe "Memphis TN -> West Memphis AR"   "$(dm 35.1495,-90.0490 35.1465,-90.1845)" '"status":"OK".*"distance"'

echo "=== CA address coverage ==="
probe "Richmond address"                "$(dm 753+s+49th+st,+richmond,+ca 2531+hinkley+ave,+richmond,+ca)" '"status":"OK".*"distance"'
probe "SF Market St rooftop"            "$(dm 1+market+st,+san+francisco,+ca 2280+market+st,+san+francisco,+ca)" '"status":"OK".*"distance"'
probe "TIGER-interp (700 Bair Island)"  "$(dm 700+bair+island+rd,+redwood+city,+ca+94063 200+independence+dr,+menlo+park,+ca+94025)" '"status":"OK".*"distance"'
probe "Private campus snap (Hacker Way)" "$(dm 2407+carlson+blvd,+richmond,+ca+94804 1+hacker+way,+menlo+park,+ca+94025)" '"status":"OK".*"distance"'
probe "match field present"             "$(dm 1+market+st,+san+francisco,+ca 2280+market+st,+san+francisco,+ca)" '"origin_matches":\[.*"(rooftop|interpolated)"'

echo "=== non-CA address coverage ==="
probe "NY Times Square area"           "$(dm 1466+broadway,+new+york,+ny+10036 350+5th+ave,+new+york,+ny+10118)" '"status":"OK".*"distance"'
probe "MA Boston rooftop"              "$(dm 1+city+hall+sq,+boston,+ma+02201 300+fenway,+boston,+ma+02115)" '"status":"OK".*"distance"'
probe "/coverage endpoint"             "$BASE/coverage" '"version".*"sources"'

echo
echo "=== $pass pass, $fail fail ==="
[[ $fail -eq 0 ]]
