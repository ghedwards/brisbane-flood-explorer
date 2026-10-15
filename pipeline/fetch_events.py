"""Fetch hour-by-hour gauge readings for recorded floods (Water Data Online).

Usage: python pipeline/fetch_events.py config/events.json <gauges.geojson> <out.json>

For each event in the config, picks the Bureau gauge nearest the event's
location (within 8 km) whose name or basin matches the event's 'match'
pattern and that has a Water Data Online station, finds its finest water
level series (hourly means, else the readings as stored, else daily means),
reads the event window and averages it to hourly values.

Writes {fetched, events: [{id, name, gauge, ts_name, start, series:
[[hours from start, metres on the gauge board], ...], peak: {hours, level},
error?}]}. Levels are on the gauge's own datum (its board), not AHD; the app
uses the shape of the rise and fall and lines the peak up with the
scenario's peak.
"""
import datetime as dt
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_national import kiwis  # noqa: E402  (same client and user agent)

PREFERRED = ("HourlyMean", "AsStored", "DailyMean")


def km(lat1, lon1, lat2, lon2):
    dy = (lat1 - lat2) * 110.574
    dx = (lon1 - lon2) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, dy)


def pick_gauge(ev, gauges):
    pat = re.compile(ev.get("match", "."), re.I)
    best = None
    for f in gauges:
        p = f["properties"]
        if not p.get("station") or p.get("kind") == "tide":
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        d = km(ev["lat"], ev["lon"], lat, lon)
        if d > 8:
            continue
        named = bool(pat.search(f"{p.get('name', '')} {p.get('basin', '')}"))
        rank = {"forecast": 0, "information": 1}.get(p.get("kind"), 2)
        score = (0 if named else 100) + rank * 3 + d
        if best is None or score < best[0]:
            best = (score, f, d)
    return best


def pick_series(station):
    rows = kiwis({"request": "getTimeseriesList", "station_no": station, "parametertype_name": "Water Course Level",
                  "returnfields": "ts_id,ts_name"})
    if not rows or not isinstance(rows, list) or len(rows) < 2:
        return None
    header, data = rows[0], rows[1:]
    i_id, i_nm = header.index("ts_id"), header.index("ts_name")
    for want in PREFERRED:
        for r in data:
            if want in str(r[i_nm]) and "Merged" in str(r[i_nm]):
                return str(r[i_id]), str(r[i_nm])
    for want in PREFERRED:
        for r in data:
            if want in str(r[i_nm]):
                return str(r[i_id]), str(r[i_nm])
    return None


def parse_time(s):
    s = s.replace("Z", "+00:00")
    t = dt.datetime.fromisoformat(s)
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone(dt.timedelta(hours=10)))


def hourly(points, start):
    """Average readings into hourly bins: [[hours from start, level], ...]."""
    bins = {}
    for t, v in points:
        if v is None:
            continue
        h = math.floor((parse_time(t) - start).total_seconds() / 3600)
        bins.setdefault(h, []).append(float(v))
    return [[h, round(sum(vs) / len(vs), 3)] for h, vs in sorted(bins.items())]


def fetch_event(ev, gauges):
    out = {"id": ev["id"], "name": ev["name"], "lat": ev["lat"], "lon": ev["lon"]}
    g = pick_gauge(ev, gauges)
    if not g:
        out["error"] = "no Bureau gauge with readings within 8 km"
        return out
    _, f, d = g
    p = f["properties"]
    lon, lat = f["geometry"]["coordinates"][:2]
    out["gauge"] = {"name": p.get("name"), "station": p.get("station"), "id": p.get("id"), "lat": lat, "lon": lon, "km": round(d, 2)}
    ts = pick_series(p["station"])
    if not ts:
        out["error"] = "no water level series for this gauge"
        return out
    ts_id, ts_name = ts
    out["ts_name"] = ts_name
    aest = dt.timezone(dt.timedelta(hours=10))
    start = dt.datetime.fromisoformat(ev["start"]).replace(tzinfo=aest)
    end = dt.datetime.fromisoformat(ev["end"]).replace(tzinfo=aest) + dt.timedelta(days=1)
    res = kiwis({"request": "getTimeseriesValues", "ts_id": ts_id, "from": start.isoformat(), "to": end.isoformat(),
                 "returnfields": "Timestamp,Value"})
    entry = res[0] if isinstance(res, list) and res else res if isinstance(res, dict) else {}
    series = hourly(entry.get("data") or [], start)
    if len(series) < 6:
        out["error"] = f"too few readings ({len(series)}) in the window"
        return out
    out["start"] = start.isoformat()
    out["series"] = series
    pk = max(series, key=lambda r: r[1])
    out["peak"] = {"hours": pk[0], "level": pk[1]}
    return out


def main(cfg_path, gauges_path, out_path):
    cfg = json.loads(Path(cfg_path).read_text())
    gauges = json.loads(Path(gauges_path).read_text()).get("features", [])
    events = []
    for ev in cfg["events"]:
        try:
            events.append(fetch_event(ev, gauges))
        except Exception as e:  # noqa: BLE001 - one event failing shouldn't stop the rest
            events.append({"id": ev["id"], "name": ev["name"], "lat": ev["lat"], "lon": ev["lon"], "error": str(e)[:200]})
    ok = [e for e in events if e.get("series")]
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps({"fetched": now, "events": events}, separators=(",", ":")))
    print(f"Recorded floods: {len(ok)} of {len(events)} with hourly readings "
          f"({', '.join(e['id'] + ':' + e.get('ts_name', '?').split('.')[-2] if '.' in e.get('ts_name', '') else e['id'] for e in ok)})")
    for e in events:
        if e.get("error"):
            print(f"warning: {e['id']}: {e['error']}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
