"""Write data/status.json: what each data source returned in this build.

Usage: python pipeline/build_status.py <site_dir> <log>...

Each log is a step's output (national.log, events.log, osm.log, ...). For
each known source the first summary line is kept, with whether it came from
this run or an earlier one (a cache), and the date of the published data
file where it records one. The app shows this as the Data status list in
its About panel, so stale or blocked data is visible without reading build
logs.
"""
import datetime as dt
import json
import re
import sys
from pathlib import Path

# (name, log line prefix, published file holding a 'fetched' date, what it feeds)
SOURCES = [
    ("Bureau gauges, dams and readings", "National:", "national/meta.json", "the Australia map, reports, gauge levels"),
    ("Flood class levels and warnings", "Flood info:", "national/warnings.json", "warnings panel, minor/moderate/major levels"),
    ("Recorded floods (hourly readings)", "Recorded floods:", "events.json", "flood over time"),
    ("Recorded sea levels", "Sea levels:", "events.json", "the sea during recorded floods"),
    ("Gauge ratings", "Ratings:", "ratings.json", "routing, peak flows"),
    ("Tide heights", "Tides:", "tides.json", "storm tide, tide cycles"),
    ("Workers by place of work", "Workers:", "workers.json", "daytime impact"),
    ("OpenStreetMap copies", "OpenStreetMap copies:", None, "impact counts for the presets"),
    ("Levee lines", "Levees:", None, "levees and flood gates"),
    ("Google Flood Hub", "Flood Hub:", "floodhub.json", "forecasts (needs an API key)"),
]


def fetched_of(path):
    try:
        d = json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return None
    for k in ("fetched", "updated", "generated"):
        if isinstance(d, dict) and d.get(k):
            return str(d[k])
    return None


def main(site, logs):
    site = Path(site)
    lines = []
    for lg in logs:
        try:
            lines += Path(lg).read_text(errors="replace").splitlines()
        except OSError:
            continue
    out = []
    for name, prefix, file, feeds in SOURCES:
        line = next((ln for ln in lines if ln.startswith(prefix)), None)
        published = site / "data" / file if file else None
        when = fetched_of(published) if published and published.exists() else None
        exists = bool(published and published.exists()) if file else None
        if line:
            summary = line[len(prefix):].strip()
            bad = bool(re.search(r"unavailable|\b0 (lines|of)\b|failed|error", summary, re.I)) and not re.search(r"\b[1-9]\d* of\b", summary)
            state = "problem" if bad else "ok"
        elif exists:
            summary, state = "kept from an earlier build", "cached"
        else:
            summary, state = "not available", "missing"
        out.append({"name": name, "state": state, "summary": summary[:300], "fetched": when, "feeds": feeds})
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    (site / "data").mkdir(parents=True, exist_ok=True)
    (site / "data" / "status.json").write_text(json.dumps({"built": now, "sources": out}, indent=1))
    print("Data status: " + ", ".join(f"{s['name']} {s['state']}" for s in out))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
