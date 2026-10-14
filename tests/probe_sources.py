#!/usr/bin/env python3
"""Check which national data services a browser on the published site can use.

Usage: python tests/probe_sources.py https://ghedwards.github.io/brisbane-flood-explorer/

Each request is made with fetch() from the site's own origin, so a source that
does not allow cross-origin requests (CORS) fails here exactly as it would for
a visitor. Results are printed as GitHub annotations.
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000/"

BRIS = "152.9,-27.6,153.1,-27.4"
PROBES = {
    "BoM flood gauge network (forecast sites)":
        "https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/flood/National_Flood_Gauge_Network/FeatureServer/2/query?where=1%3D1&outFields=*&resultRecordCount=3&f=geojson",
    "BoM river and tide gauges":
        "https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/flood/National_Flood_Gauge_Network/FeatureServer/5/query?where=1%3D1&outFields=*&resultRecordCount=3&f=geojson",
    "BoM water storages":
        "https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/Australia_Water_Storages/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=3&f=geojson",
    "BoM Water Data Online (KiWIS)":
        "https://www.bom.gov.au/waterdata/services?service=kisters&type=QueryServices&format=json&request=getStationList&parameterType_name=Water%20Course%20Level&station_no=540198&returnfields=station_no,station_name",
    "GA DEM-H elevation (WCS GeoTIFF)":
        "https://services.ga.gov.au/gis/services/DEM_SRTM_1Second_Hydro_Enforced_2024/MapServer/WCSServer?service=WCS&version=1.0.0&request=GetCoverage&coverage=1&crs=EPSG:4326&bbox=" + BRIS + "&width=64&height=64&format=GeoTIFF",
    "Copernicus GLO-30 DEM (S3 COG range read)":
        "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S28_00_E153_00_DEM/Copernicus_DSM_COG_10_S28_00_E153_00_DEM.tif",
    "DEA Waterbodies (WFS)":
        "https://geoserver.dea.ga.gov.au/geoserver/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=DigitalEarthAustraliaWaterbodies_v3&outputFormat=application/json&maxFeatures=2&bbox=-27.6,152.9,-27.4,153.1,EPSG:4326",
    "Brisbane council flood layers (check)":
        "https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services/Flood_Awareness_Creek/FeatureServer/0/query?where=1%3D1&resultRecordCount=1&f=geojson",
}

JS = """async ([url, range]) => {
  const t0 = performance.now();
  try {
    const r = await fetch(url, range ? { headers: { Range: 'bytes=0-1023' } } : {});
    const buf = await r.arrayBuffer();
    let sample = '';
    try { sample = new TextDecoder().decode(buf.slice(0, 160)).replace(/\\s+/g, ' '); } catch (e) {}
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type'), bytes: buf.byteLength,
             ms: Math.round(performance.now() - t0), sample };
  } catch (e) {
    return { ok: false, error: String(e), ms: Math.round(performance.now() - t0) };
  }
}"""


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
        for name, url in PROBES.items():
            res = page.evaluate(JS, [url, "S3 COG" in name])
            level = "notice" if res.get("ok") else "warning"
            print(f"::{level}::Probe {name}: {json.dumps(res)[:420]}")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
