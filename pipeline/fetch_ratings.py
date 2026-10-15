"""Level-to-flow ratings for gauges near the presets (Water Data Online).

Usage: python pipeline/fetch_ratings.py viewer/app.js <gauges.geojson> <out.json> [--km 12] [--max 250]

For each Bureau gauge within --km of a preset that has both a water level
and a discharge series, reads ten years of daily means of both, pairs them
by day and fits a power-law rating, Q = a (h - h0)^b, by least squares on
logs (h0 searched on a grid below the lowest level). The app uses the
exponent b and the depth of normal flow (median level - h0) to turn the
gauge's levels into flows when routing a flood down the river, instead of
assuming a wide channel (b = 5/3).

Writes {fetched, ratings: {station: {name, a, b, h0, hmed, hmax, qmax, n, r2}}}.
Levels are on the gauge's own board; flows in cubic metres a second.
Daily means smooth flood peaks, so ratings above the highest daily level
are extrapolated.
"""
import datetime as dt
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_events import km  # noqa: E402
from fetch_national import kiwis  # noqa: E402
from fetch_osm import presets  # noqa: E402

YEARS = 10


def daily(station, parameter):
    rows = kiwis({"request": "getTimeseriesList", "station_no": station, "parametertype_name": parameter,
                  "returnfields": "ts_id,ts_name"})
    if not rows or not isinstance(rows, list) or len(rows) < 2:
        return None
    h, data = rows[0], rows[1:]
    ids = [(str(r[h.index("ts_id")]), str(r[h.index("ts_name")])) for r in data]
    ts = next((i for i, n in ids if "DailyMean" in n and "Merged" in n), None) or next((i for i, n in ids if "DailyMean" in n), None)
    if not ts:
        return None
    end = dt.date.today()
    start = end.replace(year=end.year - YEARS)
    res = kiwis({"request": "getTimeseriesValues", "ts_id": ts, "from": start.isoformat(), "to": end.isoformat(),
                 "returnfields": "Timestamp,Value"})
    entry = res[0] if isinstance(res, list) and res else res if isinstance(res, dict) else {}
    out = {}
    for t, v in entry.get("data") or []:
        if v is None:
            continue
        try:
            out[t[:10]] = float(v)
        except (TypeError, ValueError):
            continue
    return out


def fit(pairs):
    """Q = a (h - h0)^b; returns dict or None."""
    pairs = [(h, q) for h, q in pairs if q > 0 and math.isfinite(h) and math.isfinite(q)]
    if len(pairs) < 60:
        return None
    hs = [h for h, _ in pairs]
    hmin, hmax = min(hs), max(hs)
    if hmax - hmin < 0.3:
        return None
    best = None
    for k in range(1, 61):
        h0 = hmin - k * max(0.02, (hmax - hmin) / 60)
        xs = [math.log(h - h0) for h, _ in pairs]
        ys = [math.log(q) for _, q in pairs]
        n = len(xs)
        mx, my = sum(xs) / n, sum(ys) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        if sxx <= 0:
            continue
        b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
        la = my - b * mx
        ss = sum((y - la - b * x) ** 2 for x, y in zip(xs, ys))
        st = sum((y - my) ** 2 for y in ys) or 1e-9
        r2 = 1 - ss / st
        if best is None or r2 > best["r2"]:
            best = {"a": math.exp(la), "b": b, "h0": h0, "r2": r2}
    if not best or not (0.8 <= best["b"] <= 4.0) or best["r2"] < 0.8:
        return None
    hs.sort()
    best.update(hmed=hs[len(hs) // 2], hmax=hmax, qmax=max(q for _, q in pairs), n=len(pairs))
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in best.items()}


def main(app_js, gauges_path, out_path, near_km=12.0, max_n=250):
    ps = presets(app_js)
    feats = json.loads(Path(gauges_path).read_text()).get("features", [])
    picked = {}
    for f in feats:
        p = f["properties"]
        if not p.get("station") or p.get("kind") == "tide":
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        d = min(km(lat, lon, q["lat"], q["lon"]) for q in ps)
        if d <= near_km and (p["station"] not in picked or d < picked[p["station"]][0]):
            picked[p["station"]] = (d, p.get("name"))
    stations = sorted(picked.items(), key=lambda kv: kv[1][0])[:max_n]
    ratings, tried, no_q = {}, 0, 0
    for st, (_, name) in stations:
        tried += 1
        try:
            q = daily(st, "Water Course Discharge")
            if not q:
                no_q += 1
                continue
            h = daily(st, "Water Course Level")
            if not h:
                continue
            r = fit([(h[d], q[d]) for d in h.keys() & q.keys()])
            if r:
                ratings[st] = dict(name=name, **r)
        except Exception as e:  # noqa: BLE001 - one gauge failing shouldn't stop the rest
            print(f"warning: {st}: {str(e)[:100]}")
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps({"fetched": now, "ratings": ratings}, separators=(",", ":")))
    print(f"Ratings: {len(ratings)} of {tried} gauges near presets ({no_q} without flow records): "
          + ", ".join(f"{v['name']} (b {v['b']:.2f})" for v in list(ratings.values())[:40]))


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 3:
        sys.exit(__doc__)
    near = float(args[args.index("--km") + 1]) if "--km" in args else 12.0
    mx = int(args[args.index("--max") + 1]) if "--max" in args else 250
    main(args[0], args[1], args[2], near, mx)
