#!/usr/bin/env python3
"""Fetch national Bureau of Meteorology flood gauges, water storages and
their latest readings, for the Australia-wide map.

Usage: python pipeline/fetch_national.py site/data/national

Writes:
  gauges.geojson    BoM National Flood Gauge Network river, forecast,
                    information and tide gauges (point features)
  storages.geojson  BoM water storages (dams and reservoirs)
  readings.json     latest daily readings from Water Data Online:
                    river levels by station number and storage volumes
  meta.json         when it ran, counts, and anything that failed

BoM's services do not allow direct browser requests, so the build fetches
them and publishes the results with the site. Uses only the standard library.

Data: © Commonwealth of Australia (Bureau of Meteorology). The flood gauge
network is CC BY 4.0; Water Data Online is CC BY (see its copyright page;
some data owners set their own terms).
"""
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BOM_GIS = "https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/"
NFGN = BOM_GIS + "flood/National_Flood_Gauge_Network/FeatureServer/"
STORAGES = BOM_GIS + "Australia_Water_Storages/FeatureServer/0"
KIWIS = "https://www.bom.gov.au/waterdata/services"
UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)"}

GAUGE_LAYERS = {2: "forecast", 3: "information", 5: "river-tide"}
DAILY = "DMQaQc.Merged.DailyMean.24HR"


def http_json(url, params=None, retries=3):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{url[:120]}: {last}")


def query_all(layer_url, out_fields="*"):
    """Page through an ArcGIS feature layer as GeoJSON."""
    feats, offset = [], 0
    while True:
        res = http_json(layer_url + "/query", {
            "where": "1=1", "outFields": out_fields, "outSR": 4326, "f": "geojson",
            "resultOffset": offset, "resultRecordCount": 2000, "orderByFields": "objectid",
        })
        batch = res.get("features", [])
        feats += batch
        if not batch or not (res.get("exceededTransferLimit") or res.get("properties", {}).get("exceededTransferLimit")):
            return feats
        offset += len(batch)


def gauge_kind(p, layer_kind):
    text = " ".join(str(p.get(k) or "") for k in ("location_types", "forecast_site_classification")).lower()
    if "tide" in text:
        return "tide"
    if layer_kind in ("forecast", "information"):
        return layer_kind
    if "forecast" in text:
        return "forecast"
    if "information" in text:
        return "information"
    return "river"


def build_gauges(errors):
    rank = {"forecast": 3, "information": 2, "tide": 1, "river": 0}
    by_id = {}
    for layer, kind in GAUGE_LAYERS.items():
        try:
            feats = query_all(NFGN + str(layer))
        except Exception as e:
            errors.append(f"gauge layer {layer}: {e}")
            continue
        for f in feats:
            p = f.get("properties") or {}
            g = f.get("geometry")
            if not g:
                continue
            key = p.get("bom_stn_num") or p.get("awrc_stateid") or p.get("objectid")
            k = gauge_kind(p, kind)
            props = {
                "id": str(key),
                "station": (p.get("awrc_stateid") or "").strip(),
                "bom": p.get("bom_stn_num"),
                "name": (p.get("name") or "").strip(),
                "state": p.get("state"),
                "basin": p.get("basin"),
                "agency": p.get("agency"),
                "types": p.get("location_types"),
                "kind": k,
            }
            old = by_id.get(props["id"])
            if not old or rank[k] > rank[old["properties"]["kind"]]:
                by_id[props["id"]] = {"type": "Feature", "geometry": g, "properties": props}
    return list(by_id.values())


def build_storages(errors):
    try:
        feats = query_all(STORAGES, ",".join([
            "wstorname", "wstorurl", "storage_id", "wiski_station_no", "total_capacity_ml",
            "accessible_capacity_ml", "river_name", "state_name", "data_owner", "year_completion", "objectid"]))
    except Exception as e:
        errors.append(f"storages: {e}")
        return []
    out = []
    for f in feats:
        p = f.get("properties") or {}
        if not f.get("geometry"):
            continue
        out.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "id": str(p.get("storage_id") or p.get("objectid")),
            "station": (p.get("wiski_station_no") or "").strip(),
            "name": (p.get("wstorname") or "").strip(),
            "river": p.get("river_name"),
            "state": p.get("state_name"),
            "owner": p.get("data_owner"),
            "capacity_ml": p.get("accessible_capacity_ml") or p.get("total_capacity_ml"),
            "total_capacity_ml": p.get("total_capacity_ml"),
            "year": p.get("year_completion"),
            "url": p.get("wstorurl"),
            "kind": "storage",
        }})
    return out


def kiwis(params):
    base = {"service": "kisters", "type": "QueryServices", "format": "json"}
    return http_json(KIWIS, dict(base, **params))


def timeseries_ids(parameter, errors):
    """station_no -> ts_id for the daily-mean series of a parameter."""
    try:
        rows = kiwis({"request": "getTimeseriesList", "parametertype_name": parameter, "ts_name": DAILY,
                      "returnfields": "station_no,ts_id"})
    except Exception as e:
        errors.append(f"timeseries list ({parameter}): {e}")
        return {}
    if not rows or not isinstance(rows, list):
        return {}
    header, data = rows[0], rows[1:]
    i_st, i_ts = header.index("station_no"), header.index("ts_id")
    return {str(r[i_st]).strip(): str(r[i_ts]) for r in data}


def latest_values(ts_ids, errors, days=10, batch=50):
    """ts_id -> list of [timestamp, value] for the last `days` days."""
    out = {}
    ids = list(ts_ids)
    for i in range(0, len(ids), batch):
        chunk = ids[i:i + batch]
        try:
            res = kiwis({"request": "getTimeseriesValues", "ts_id": ",".join(chunk),
                         "period": f"P{days}D", "returnfields": "Timestamp,Value"})
        except Exception as e:
            errors.append(f"values batch {i // batch}: {e}")
            continue
        for entry in (res if isinstance(res, list) else [res]):
            if not isinstance(entry, dict):
                continue
            vals = [[t, v] for t, v in (entry.get("data") or []) if v is not None]
            if entry.get("ts_id") is not None and vals:
                out[str(entry["ts_id"])] = vals
    return out


def readings_for(features, parameter, unit, errors):
    wanted = {f["properties"]["station"] for f in features if f["properties"].get("station")}
    ts = {st: tid for st, tid in timeseries_ids(parameter, errors).items() if st in wanted}
    vals = latest_values(ts.values(), errors) if ts else {}
    out = {}
    for st, tid in ts.items():
        series = vals.get(tid)
        if series:
            out[st] = {"unit": unit, "series": series[-10:], "latest": series[-1]}
    return out


def compact(features):
    """Point features as columns: {keys, dict, rows: [[lon, lat, v...]]}.
    Columns with few distinct values (state, basin, agency, kind) are stored
    as indexes into dict[key], which roughly halves the gauge file."""
    keys = sorted({k for f in features for k in (f.get("properties") or {})})
    vals = {k: [(f.get("properties") or {}).get(k) for f in features] for k in keys}
    dicts = {}
    for k in keys:
        uniq = list(dict.fromkeys(v for v in vals[k] if v is not None))
        if 0 < len(uniq) <= max(50, len(features) // 8) and all(isinstance(v, str) for v in uniq):
            dicts[k] = uniq
    index = {k: {v: i for i, v in enumerate(d)} for k, d in dicts.items()}
    rows = []
    for i, f in enumerate(features):
        x, y = (f.get("geometry") or {}).get("coordinates", [None, None])[:2]
        row = [x, y]
        for k in keys:
            v = vals[k][i]
            row.append(index[k].get(v, -1) if k in dicts and v is not None else (-1 if k in dicts else v))
        rows.append(row)
    return {"keys": keys, "dict": dicts, "rows": rows}


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    errors = []
    gauges = build_gauges(errors)
    storages = build_storages(errors)
    readings = {
        "level": readings_for(gauges, "Water Course Level", "m", errors),
        "storage": readings_for(storages, "Storage Volume", "ML", errors),
        "series": DAILY,
    }
    # about a metre is plenty for map points, and keeps the files small
    for f in gauges + storages:
        g = f.get("geometry") or {}
        if g.get("type") == "Point" and g.get("coordinates"):
            g["coordinates"] = [round(float(v), 5) for v in g["coordinates"][:2]]
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    (out / "gauges.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": gauges}, separators=(",", ":")))
    (out / "gauges.min.json").write_text(json.dumps(compact(gauges), separators=(",", ":"), ensure_ascii=False))
    (out / "storages.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": storages}, separators=(",", ":")))
    (out / "readings.json").write_text(json.dumps(readings, separators=(",", ":")))
    kinds = {}
    for g in gauges:
        kinds[g["properties"]["kind"]] = kinds.get(g["properties"]["kind"], 0) + 1
    meta = {"fetched": now, "gauges": len(gauges), "gaugeKinds": kinds, "storages": len(storages),
            "levelReadings": len(readings["level"]), "storageReadings": len(readings["storage"]), "errors": errors,
            "attribution": "© Commonwealth of Australia (Bureau of Meteorology)"}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"National: {len(gauges)} gauges {kinds}, {len(storages)} storages, "
          f"{meta['levelReadings']} level readings, {meta['storageReadings']} storage readings, {len(errors)} errors")
    for e in errors[:5]:
        print("warning:", e)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
