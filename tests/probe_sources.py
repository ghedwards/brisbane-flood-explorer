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
    "GA 5 m LiDAR elevation (WCS GeoTIFF)":
        "https://services.ga.gov.au/gis/services/DEM_LiDAR_5m_2025/MapServer/WCSServer?service=WCS&version=1.0.0&request=GetCoverage&coverage=1&crs=EPSG:4326&bbox=" + BRIS + "&width=64&height=64&format=GeoTIFF",
    "GA 5 m LiDAR (WCS, GDA94 request)":
        "https://services.ga.gov.au/gis/services/DEM_LiDAR_5m_2025/MapServer/WCSServer?service=WCS&version=1.0.0&request=GetCoverage&coverage=1&crs=EPSG:4283&bbox=" + BRIS + "&width=64&height=64&format=GeoTIFF",
    "GA 5 m LiDAR (WCS, GTiff format name)":
        "https://services.ga.gov.au/gis/services/DEM_LiDAR_5m_2025/MapServer/WCSServer?service=WCS&version=1.0.0&request=GetCoverage&coverage=1&crs=EPSG:4326&bbox=" + BRIS + "&width=64&height=64&format=GTiff",
    "DEA water observations frequency (WCS GeoTIFF)":
        "https://ows.dea.ga.gov.au/?service=WCS&version=1.0.0&request=GetCoverage&coverage=ga_ls_wo_fq_myear_3&measurements=frequency&crs=EPSG:4326&bbox=" + BRIS + "&width=64&height=64&format=GeoTIFF",
    "Copernicus GLO-30 DEM (S3 COG range read)":
        "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S28_00_E153_00_DEM/Copernicus_DSM_COG_10_S28_00_E153_00_DEM.tif",
    "DEA Waterbodies (WFS)":
        "https://geoserver.dea.ga.gov.au/geoserver/wfs?service=WFS&version=1.1.0&request=GetFeature&typeName=DigitalEarthAustraliaWaterbodies_v3&outputFormat=application/json&maxFeatures=2&bbox=-27.6,152.9,-27.4,153.1,EPSG:4326",
    "Moreton Bay overland flow (FeatureServer count)":
        "https://services-ap1.arcgis.com/152ojN3Ts9H3cdtl/ArcGIS/rest/services/OM_Overland_Flow_Path_WebMercator_OpenData/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json",
    "Moreton Bay overland flow (features near Caboolture)":
        "https://services-ap1.arcgis.com/152ojN3Ts9H3cdtl/ArcGIS/rest/services/OM_Overland_Flow_Path_WebMercator_OpenData/FeatureServer/0/query?geometry=152.93,-27.10,153.00,-27.05&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&returnCountOnly=true&f=json",
    "Sunshine Coast overland flow (layer list)":
        "https://geoimage.scc.qld.gov.au/arcgis/rest/services/Emergency/FloodMapping_IndividualStudies_OverlandFlowModel_scrc/MapServer/layers?f=json",
    "Randwick overland flow (export)":
        "https://mapservices.randwick.nsw.gov.au/arcgis/rest/services/intStormwater/OverlandFlowPath/MapServer/export?bbox=151.22,-33.94,151.26,-33.90&bboxSR=4326&size=256,256&f=json",
    "Brisbane council flood layers (check)":
        "https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services/Flood_Awareness_Creek/FeatureServer/0/query?where=1%3D1&resultRecordCount=1&f=geojson",
}

JS = """async ([url, range]) => {
  const t0 = performance.now();
  try {
    const r = await fetch(url, range ? { headers: { Range: 'bytes=0-1023' } } : {});
    const buf = await r.arrayBuffer();
    let sample = '';
    try {
      const txt = new TextDecoder().decode(buf.slice(0, 4000));
      sample = (/html/i.test(r.headers.get('content-type') || '') ? txt.replace(/<style[\\s\\S]*?<\\/style>/gi, '').replace(/<[^>]+>/g, ' ') : txt.slice(0, 160)).replace(/\\s+/g, ' ').slice(0, 300);
    } catch (e) {}
    return { ok: r.ok, status: r.status, type: r.headers.get('content-type'), bytes: buf.byteLength,
             ms: Math.round(performance.now() - t0), sample };
  } catch (e) {
    return { ok: false, error: String(e), ms: Math.round(performance.now() - t0) };
  }
}"""


TIFF_JS = """async (url) => {
  const r = await fetch(url);
  const buf = await r.arrayBuffer();
  const dv = new DataView(buf);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const out = { status: r.status, type: r.headers.get('content-type'), bytes: buf.byteLength, magic: u16(2) };
  try {
    let ifd = u32(4), n = 0; out.ifds = [];
    while (ifd && n < 4 && ifd < buf.byteLength) {
      const count = u16(ifd); const tags = {};
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4), val = type === 3 && cnt === 1 ? u16(e + 8) : u32(e + 8);
        tags[tag] = [type, cnt, val];
      }
      out.ifds.push(tags);
      ifd = u32(ifd + 2 + count * 12); n++;
    }
  } catch (e) { out.parseError = String(e); }
  return out;
}"""


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
        wcs = PROBES["GA DEM-H elevation (WCS GeoTIFF)"].split("&bbox=")[0]
        for label, bbox in [("land", "152.92,-27.56,153.14,-27.38"), ("coast", "153.06,-27.46,153.28,-27.28")]:
            res = page.evaluate(TIFF_JS, wcs + "&bbox=" + bbox + "&width=667&height=667&format=GeoTIFF")
            print(f"::notice::TIFF {label}: {json.dumps(res)[:900]}")
        for name, url in PROBES.items():
            res = page.evaluate(JS, [url, "S3 COG" in name])
            level = "notice" if res.get("ok") else "warning"
            print(f"::{level}::Probe {name}: {json.dumps(res)[:420]}")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
