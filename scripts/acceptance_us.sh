#!/usr/bin/env bash
# Cross-region acceptance test for v2 US-wide deployment.
#
# Probes:
#   - /healthz returns ok
#   - REQUEST_DENIED on bad key
#   - Several within-metro routes across distant metros (SF, NYC, Miami, Seattle, Austin, Boston)
#   - One long-haul coord pair per pair tier (cross-state, cross-region, cross-country)
#
# Expects HHAPI_API_KEY env var.
set -euo pipefail
: "${HHAPI_API_KEY:?Need HHAPI_API_KEY}"
BASE="${HHAPI_BASE:-https://hhapi.propspress.com}"

pass=0; fail=0

probe() {
  local label="$1"; local url="$2"; local check="$3"  # check: regex on response body
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

echo "=== health ==="
probe "healthz" "$BASE/healthz" '"status":"ok"'

echo "=== auth ==="
probe "bad key -> REQUEST_DENIED" "$BASE/maps/api/distancematrix/json?origins=37.77,-122.42&destinations=37.44,-122.14&key=wrong" '"status":"REQUEST_DENIED"'

# Centroids of major metros; coords skip geocoding so this isolates the router.
declare -A METRO=(
  [sf]="37.7749,-122.4194"      # San Francisco
  [la]="34.0522,-118.2437"      # Los Angeles
  [sea]="47.6062,-122.3321"     # Seattle
  [pdx]="45.5152,-122.6784"     # Portland
  [den]="39.7392,-104.9903"     # Denver
  [aus]="30.2672,-97.7431"      # Austin
  [hou]="29.7604,-95.3698"      # Houston
  [chi]="41.8781,-87.6298"      # Chicago
  [atl]="33.7490,-84.3880"      # Atlanta
  [mia]="25.7617,-80.1918"      # Miami
  [bos]="42.3601,-71.0589"      # Boston
  [nyc]="40.7128,-74.0060"      # New York
  [dc]="38.9072,-77.0369"       # Washington
)

# Within-metro short routes (offset destination 10 km east).
echo "=== within-metro coord routes ==="
for m in sf la sea pdx den aus hou chi atl mia bos nyc dc; do
  IFS=',' read -r lat lon <<<"${METRO[$m]}"
  # 10 km east -> lon delta ~ 0.1 / cos(lat)
  dlon=$(python3 -c "import math; print(0.1 / math.cos(math.radians($lat)))")
  dst="$lat,$(python3 -c "print($lon + $dlon)")"
  probe "$m within-metro" \
    "$BASE/maps/api/distancematrix/json?origins=${METRO[$m]}&destinations=$dst&key=$HHAPI_API_KEY" \
    '"status":"OK".*"distance"'
done

# Cross-region long routes (these will be slower but should complete).
echo "=== cross-region long routes ==="
probe "SF -> LA (~380 mi)"     "$BASE/maps/api/distancematrix/json?origins=${METRO[sf]}&destinations=${METRO[la]}&key=$HHAPI_API_KEY" '"status":"OK".*"distance"'
probe "Seattle -> Portland"     "$BASE/maps/api/distancematrix/json?origins=${METRO[sea]}&destinations=${METRO[pdx]}&key=$HHAPI_API_KEY" '"status":"OK".*"distance"'
probe "Austin -> Houston"       "$BASE/maps/api/distancematrix/json?origins=${METRO[aus]}&destinations=${METRO[hou]}&key=$HHAPI_API_KEY" '"status":"OK".*"distance"'
probe "NYC -> DC"               "$BASE/maps/api/distancematrix/json?origins=${METRO[nyc]}&destinations=${METRO[dc]}&key=$HHAPI_API_KEY" '"status":"OK".*"distance"'
probe "Atlanta -> Miami"        "$BASE/maps/api/distancematrix/json?origins=${METRO[atl]}&destinations=${METRO[mia]}&key=$HHAPI_API_KEY" '"status":"OK".*"distance"'

echo
echo "=== $pass pass, $fail fail ==="
[[ $fail -eq 0 ]]
