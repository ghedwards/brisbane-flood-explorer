#!/usr/bin/env python3
"""Package pipeline outputs for the web viewer.

Usage: python pipeline/export_viewer.py config/brisbane.json work/brisbane site/data

Writes site/data/<id>/
  dem.f32    ground elevation, float32 little-endian, row-major (NaN = no data)
  d8.u8      Whitebox D8 codes (1..128, 0 = no outflow, 255 = no data)
  meta.json  grid size, cell size, CRS, bounds, gauge cell, provenance
  *.tif      d8, streams and HAND GeoTIFFs to open in RustGIS or QGIS
and adds the area to site/data/areas.json.
"""
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform as warp_transform


def runner_version() -> str:
    try:
        out = subprocess.run(["geolibre", "version"], capture_output=True, text=True, timeout=30)
        return out.stdout.strip() or "GeoLibre"
    except Exception:
        return "GeoLibre"


def main(config_path: str, work_dir: str, data_dir: str) -> None:
    cfg = json.loads(Path(config_path).read_text())
    work, data = Path(work_dir), Path(data_dir)
    out = data / cfg["id"]
    out.mkdir(parents=True, exist_ok=True)

    with rasterio.open(work / "dem.tif") as src:
        dem = src.read(1).astype("float32")
        nodata = src.nodata
        crs, tf, bounds = src.crs, src.transform, src.bounds
        H, W = dem.shape
    with rasterio.open(work / "d8.tif") as src:
        d8 = src.read(1)
        if d8.shape != dem.shape:
            sys.exit(f"d8.tif is {d8.shape} but dem.tif is {dem.shape}")
        d8_nodata = src.nodata

    bad = ~np.isfinite(dem)
    if nodata is not None:
        bad |= dem == nodata
    if d8_nodata is not None:
        bad |= d8 == d8_nodata
    codes = np.where(np.isin(d8, [0, 1, 2, 4, 8, 16, 32, 64, 128]), d8, 255).astype("uint8")
    codes[bad] = 255
    dem = np.where(bad, np.nan, dem).astype("<f4")

    dem.tofile(out / "dem.f32")
    codes.tofile(out / "d8.u8")

    g = cfg["gauge"]
    xs, ys = warp_transform("EPSG:4326", crs, [g["lon"]], [g["lat"]])
    row, col = rasterio.transform.rowcol(tf, xs[0], ys[0])

    rasters = []
    for name, label in [("hand.tif", "HAND"), ("streams.tif", "Streams"), ("d8.tif", "D8 flow directions"),
                        ("dem_cond.tif", "Conditioned DEM")]:
        if (work / name).exists():
            shutil.copy2(work / name, out / name)
            rasters.append({"name": label, "file": name})

    # Corners in lon/lat for the street map. MGA grid north is within a few
    # hundredths of a degree of true north here, so an axis-aligned box made
    # from the mean of each edge's corners matches the grid to a few metres.
    cx = [bounds.left, bounds.right, bounds.right, bounds.left]
    cy = [bounds.top, bounds.top, bounds.bottom, bounds.bottom]
    lons, lats = warp_transform(crs, "EPSG:4326", cx, cy)
    bounds_lonlat = [
        (lons[0] + lons[3]) / 2, (lats[2] + lats[3]) / 2,
        (lons[1] + lons[2]) / 2, (lats[0] + lats[1]) / 2,
    ]

    cell = abs(tf.a)
    meta = {
        "id": cfg["id"],
        "name": cfg["name"],
        "W": W, "H": H, "cell": cell,
        "crs": crs.to_string(),
        "bounds": [bounds.left, bounds.bottom, bounds.right, bounds.top],
        "bounds_lonlat": bounds_lonlat,
        "nodata": None,
        "files": {"dem": "dem.f32", "d8": "d8.u8"},
        "gauge": {"name": g["name"], "col": int(col), "row": int(row)},
        "brisbaneGauge": bool(cfg.get("brisbane_gauge_events")),
        "streamAreaKm2": cfg["stream_area_km2"],
        "source": "Terrain: Copernicus GLO-30 surface model (ESA, Airbus), "
                  f"resampled to {cell:g} m. Heights are relative to the EGM2008 geoid, "
                  "which differs from AHD by a few tenths of a metre here.",
        "processedWith": runner_version() + " (the RustGIS hydrology tools)",
        "generated": dt.date.today().isoformat(),
        "rasters": rasters,
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2))

    areas_path = data / "areas.json"
    areas = json.loads(areas_path.read_text()) if areas_path.exists() else []
    areas = [a for a in areas if a["id"] != cfg["id"]] + [{"id": cfg["id"], "name": cfg["name"]}]
    areas_path.write_text(json.dumps(areas, indent=2))
    print(f"Exported {cfg['id']}: {W} x {H} cells, gauge at row {row}, col {col}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
