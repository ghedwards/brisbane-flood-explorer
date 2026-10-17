#!/usr/bin/env bash
# Terrain hydrology with the RustGIS / GeoLibre tools.
#
# Usage: tests/geolibre/run_hydrology.sh config/brisbane.json work/brisbane
#
# Reads  work/<area>/dem.tif
# Writes work/<area>/
#   dem_breached.tif  depressions breached (least-cost), the rest filled
#   dem_cond.tif      hydrologically conditioned DEM (flats resolved)
#   d8.tif            D8 flow directions (Whitebox codes: 1=NE 2=E 4=SE 8=S
#                     16=SW 32=W 64=NW 128=N, 0=no outflow)
#   acc.tif           flow accumulation (cells)
#   streams.tif       stream network (cells above the area threshold)
#   hand.tif          height above nearest drainage (m)
#
# The same tools are in the RustGIS app under Analyze > GeoLibre > Hydrology,
# so every step here can be repeated by hand. Example: open dem.tif in
# RustGIS and run "Fill Depressions" with the parameters below.
set -euo pipefail

CONFIG="$1"
WORK="$2"
GL="${GEOLIBRE:-geolibre}"

cfg() { flood config "$CONFIG" "$1"; }
CELL="$(cfg cell_m)"
AREA_KM2="$(cfg stream_area_km2)"
BREACH="$(cfg breach_max_dist_cells)"
THRESH="$(awk -v a="$AREA_KM2" -v c="$CELL" 'BEGIN { printf "%d", a * 1e6 / (c * c) + 0.5 }')"

run() {
  echo "::group::geolibre $*"
  "$GL" "$@"
  echo "::endgroup::"
}

cd "$WORK"
"$GL" version

# 1. Carve through road embankments and bridges that a surface model shows
#    as dams, then fill whatever is left.
run breach_depressions_least_cost --dem=dem.tif --max_dist="$BREACH" \
    --fill_deps=true --output=dem_breached.tif

# 2. Make sure flat areas drain.
run fill_depressions --dem=dem_breached.tif --fix_flats=true --output=dem_cond.tif

# 3. Flow directions and accumulation.
run d8_pointer --dem=dem_cond.tif --esri_pntr=false --output=d8.tif
run d8_flow_accum --input=d8.tif --input_is_pointer=true --esri_pntr=false \
    --out_type=cells --output=acc.tif

# 4. Streams and height above nearest drainage (for use in RustGIS / QGIS).
run extract_streams --flow_accumulation=acc.tif --threshold="$THRESH" \
    --zero_background=true --output=streams.tif
run elevation_above_stream --dem=dem_cond.tif --streams=streams.tif --output=hand.tif

ls -la
