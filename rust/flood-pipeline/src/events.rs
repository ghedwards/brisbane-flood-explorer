//! Hour-by-hour gauge readings for recorded floods from Water Data Online
//! (was pipeline/fetch_events.py).
//!
//! Usage: flood events <config/events.json> <gauges.geojson> <out.json>
//!
//! For each event: the gauge near the town (within 8 km) named for the
//! river or town, its finest water level series (hourly means, else as
//! stored, else daily means) over the flood's dates, averaged to hours;
//! plus the same flood at up to four other gauges on the river. Writes
//! {fetched, events: [{id, name, lat, lon, gauge, ts_name, start, series:
//! [[hours from start, level], ...], peak: {hours, level}, others} or
//! {..., error}]}.

use crate::national::{col, kp};
use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub type Kiwis<'a> = &'a dyn Fn(&[(String, String)]) -> R<Value>;

const PREFERRED: [&str; 3] = ["HourlyMean", "AsStored", "DailyMean"];
pub const AEST: i64 = 10;

/// The event's pattern (Python's re.compile(match, re.I)).
pub fn pattern(ev: &Value) -> Regex {
    let m = get_str(ev, "match").unwrap_or(".");
    Regex::new(&format!("(?i){}", m)).unwrap_or_else(|_| Regex::new(&format!("(?i){}", regex::escape(m))).unwrap())
}

fn lonlat(f: &Value) -> (f64, f64) {
    let c = &f["geometry"]["coordinates"];
    (c[0].as_f64().unwrap_or(f64::NAN), c[1].as_f64().unwrap_or(f64::NAN))
}

fn label(p: &Value) -> String {
    format!("{} {}", p.get("name").map(|v| if v.is_null() { "None".into() } else { py_str(v) }).unwrap_or_default(),
        p.get("basin").map(|v| if v.is_null() { "None".into() } else { py_str(v) }).unwrap_or_default())
}

fn kind_rank(p: &Value) -> f64 {
    match get_str(p, "kind") {
        Some("forecast") => 0.0,
        Some("information") => 1.0,
        _ => 2.0,
    }
}

/// Gauges within 8 km, best first: named for the river or town, then
/// forecast before information gauges, then nearest. (score, feature, km)
pub fn candidates<'a>(ev: &Value, gauges: &'a [Value]) -> Vec<(f64, &'a Value, f64)> {
    let pat = pattern(ev);
    let (elat, elon) = (get_f64(ev, "lat").unwrap_or(f64::NAN), get_f64(ev, "lon").unwrap_or(f64::NAN));
    let mut out = Vec::new();
    for f in gauges {
        let p = &f["properties"];
        if !truthy(p.get("station")) || get_str(p, "kind") == Some("tide") {
            continue;
        }
        let (lon, lat) = lonlat(f);
        let d = km(elat, elon, lat, lon);
        if !matches!(d.partial_cmp(&8.0), Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)) {
            continue;
        }
        let named = pat.is_match(&label(p));
        out.push(((if named { 0.0 } else { 100.0 }) + kind_rank(p) * 3.0 + d, f, d));
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

#[cfg(test)]
pub fn pick_gauge<'a>(ev: &Value, gauges: &'a [Value]) -> Option<(f64, &'a Value, f64)> {
    let mut best: Option<(f64, &Value, f64)> = None;
    for c in candidates(ev, gauges) {
        if best.is_none_or(|b| c.0 < b.0) {
            best = Some(c);
        }
    }
    best
}

fn nearby_stations(kiwis: Kiwis, ev: &Value) -> R<Vec<Value>> {
    let (lat, lon) = (get_f64(ev, "lat").unwrap(), get_f64(ev, "lon").unwrap());
    let dy = 8.0 / 110.574;
    let dx = 8.0 / (111.32 * lat.to_radians().cos());
    let bbox = format!("{},{},{},{}", py_float(lon - dx), py_float(lat - dy), py_float(lon + dx), py_float(lat + dy));
    let rows = kiwis(&kp(&[("request", "getStationList"), ("bBox", &bbox), ("returnfields", "station_no,station_name,station_latitude,station_longitude")]))?;
    let rows = match rows.as_array() {
        Some(r) if r.len() >= 2 => r,
        _ => return Ok(Vec::new()),
    };
    let h = &rows[0];
    let (Some(ilat), Some(ilon), Some(iname), Some(ino)) = (col(h, "station_latitude"), col(h, "station_longitude"), col(h, "station_name"), col(h, "station_no")) else {
        return Ok(Vec::new());
    };
    let pat = pattern(ev);
    let fnum = |v: &Value| -> Option<f64> { v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())) };
    let mut out = Vec::new();
    for r in &rows[1..] {
        let (Some(slat), Some(slon)) = (fnum(&r[ilat]), fnum(&r[ilon])) else { continue };
        let name = py_str(&r[iname]);
        let d = km(lat, lon, slat, slon);
        if d <= 8.0 {
            let score = (if pat.is_match(&name) { 0.0 } else { 100.0 }) + d;
            out.push((score, obj! {"station" => py_str(&r[ino]), "name" => name, "lat" => slat, "lon" => slon}));
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out.into_iter().take(12).map(|x| x.1).collect())
}

/// The station's water level series, finest first (merged before raw).
pub fn series_list(kiwis: Kiwis, station: &str) -> R<Vec<(String, String)>> {
    let rows = kiwis(&kp(&[("request", "getTimeseriesList"), ("station_no", station), ("parametertype_name", "Water Course Level"), ("returnfields", "ts_id,ts_name")]))?;
    let rows = match rows.as_array() {
        Some(r) if r.len() >= 2 => r,
        _ => return Ok(Vec::new()),
    };
    let (Some(i_id), Some(i_nm)) = (col(&rows[0], "ts_id"), col(&rows[0], "ts_name")) else { return Ok(Vec::new()) };
    let mut out: Vec<(String, String)> = Vec::new();
    for want in PREFERRED {
        for merged in [true, false] {
            for r in &rows[1..] {
                let nm = py_str(&r[i_nm]);
                let item = (py_str(&r[i_id]), nm.clone());
                if nm.contains(want) && nm.contains("Merged") == merged && !out.contains(&item) {
                    out.push(item);
                }
            }
        }
    }
    Ok(out)
}

/// Average readings into hourly bins: [[hours from start, level], ...].
pub fn hourly(points: &[Value], start: f64) -> Vec<Value> {
    let mut bins: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
    for p in points {
        let (Some(t), Some(v)) = (p.get(0).and_then(|t| t.as_str()), p.get(1)) else { continue };
        let Some(v) = v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())) else { continue };
        let Some(ts) = parse_iso(t, AEST) else { continue };
        bins.entry(((ts - start) / 3600.0).floor() as i64).or_default().push(v);
    }
    bins.into_iter().map(|(h, vs)| json!([h, num(round_to(vs.iter().sum::<f64>() / vs.len() as f64, 3))])).collect()
}

fn readings(kiwis: Kiwis, ts_id: &str, start: f64, end: f64) -> R<Vec<Value>> {
    let res = kiwis(&kp(&[("request", "getTimeseriesValues"), ("ts_id", ts_id), ("from", &iso(start, AEST)), ("to", &iso(end, AEST)), ("returnfields", "Timestamp,Value")]))?;
    let entry = match &res {
        Value::Array(a) if !a.is_empty() => a[0].clone(),
        Value::Object(_) => res.clone(),
        _ => json!({}),
    };
    Ok(hourly(arr(entry.get("data")), start))
}

fn others_on_river(kiwis: Kiwis, ev: &Value, gauges: &[Value], main_station: &str, start: f64, end: f64) -> R<Vec<Value>> {
    let pat = pattern(ev);
    let (elat, elon) = (get_f64(ev, "lat").unwrap(), get_f64(ev, "lon").unwrap());
    let mut cands = Vec::new();
    for f in gauges {
        let p = &f["properties"];
        if !truthy(p.get("station")) || get_str(p, "station") == Some(main_station) || get_str(p, "kind") == Some("tide") {
            continue;
        }
        if !pat.is_match(&label(p)) {
            continue;
        }
        let (lon, lat) = lonlat(f);
        let d = km(elat, elon, lat, lon);
        if d <= 40.0 {
            cands.push((d, p, lat, lon));
        }
    }
    cands.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = Vec::new();
    for (d, p, lat, lon) in cands.into_iter().take(10) {
        if out.len() >= 4 {
            break;
        }
        let st = s_or_empty(p.get("station"));
        for (ts_id, ts_name) in series_list(kiwis, &st)?.into_iter().take(2) {
            let series = readings(kiwis, &ts_id, start, end)?;
            if series.len() >= 6 {
                out.push(obj! {"name" => p.get("name").cloned().unwrap_or(Value::Null), "station" => p.get("station").cloned().unwrap_or(Value::Null),
                    "lat" => lat, "lon" => lon, "km" => num(round_to(d, 2)), "ts_name" => ts_name, "series" => series});
                break;
            }
        }
    }
    Ok(out)
}

pub fn fetch_event(kiwis: Kiwis, ev: &Value, gauges: &[Value]) -> R<Value> {
    let mut out = obj! {"id" => ev["id"].clone(), "name" => ev["name"].clone(), "lat" => ev["lat"].clone(), "lon" => ev["lon"].clone()};
    let start = parse_iso(get_str(ev, "start").ok_or("no start")?, AEST).ok_or("bad start date")?;
    let end = parse_iso(get_str(ev, "end").ok_or("no end")?, AEST).ok_or("bad end date")? + 86400.0;
    let (elat, elon) = (get_f64(ev, "lat").ok_or("no lat")?, get_f64(ev, "lon").ok_or("no lon")?);
    let mut stations: Vec<Value> = candidates(ev, gauges)
        .into_iter()
        .take(8)
        .map(|(_, f, d)| {
            let p = &f["properties"];
            let (lon, lat) = lonlat(f);
            let g = |k: &str| p.get(k).cloned().unwrap_or(Value::Null);
            obj! {"name" => g("name"), "station" => g("station"), "id" => g("id"), "lat" => lat, "lon" => lon, "km" => num(round_to(d, 2))}
        })
        .collect();
    let (mut tried, mut with_series) = (0, 0);
    for k in 0..2 {
        if k == 1 {
            let seen: Vec<Value> = stations.iter().map(|s| s["station"].clone()).collect();
            stations = nearby_stations(kiwis, ev)?
                .into_iter()
                .filter(|st| !seen.contains(&st["station"]))
                .map(|mut st| {
                    let d = km(elat, elon, st["lat"].as_f64().unwrap(), st["lon"].as_f64().unwrap());
                    st["km"] = num(round_to(d, 2));
                    st
                })
                .collect();
        }
        for st in &stations {
            tried += 1;
            let sl = series_list(kiwis, &s_or_empty(st.get("station")))?;
            if !sl.is_empty() {
                with_series += 1;
            }
            for (ts_id, ts_name) in sl.into_iter().take(4) {
                let series = readings(kiwis, &ts_id, start, end)?;
                if series.len() >= 6 {
                    let mut pk = &series[0];
                    for r in &series {
                        if r[1].as_f64() > pk[1].as_f64() {
                            pk = r;
                        }
                    }
                    let peak = obj! {"hours" => pk[0].clone(), "level" => pk[1].clone()};
                    out["gauge"] = st.clone();
                    out["ts_name"] = Value::from(ts_name);
                    out["start"] = Value::from(iso(start, AEST));
                    out["series"] = Value::from(series.clone());
                    out["peak"] = peak;
                    out["others"] = Value::from(others_on_river(kiwis, ev, gauges, &s_or_empty(st.get("station")), start, end)?);
                    return Ok(out);
                }
            }
        }
    }
    out["error"] = Value::from(if tried == 0 {
        "no gauge or Water Data Online station within 8 km".to_string()
    } else if with_series == 0 {
        format!("none of the {} gauges and stations within 8 km has a water level series on Water Data Online", tried)
    } else {
        format!("{} of {} stations within 8 km have water levels, but none for these dates", with_series, tried)
    });
    Ok(out)
}

pub fn run(cfg_path: &str, gauges_path: &str, out_path: &str, kiwis: Kiwis) -> R<String> {
    let cfg = read_json(cfg_path)?;
    let gauges = arr(read_json(gauges_path)?.get("features")).to_vec();
    let mut events = Vec::new();
    for ev in arr(cfg.get("events")) {
        events.push(fetch_event(kiwis, ev, &gauges).unwrap_or_else(|e| {
            obj! {"id" => ev["id"].clone(), "name" => ev["name"].clone(), "lat" => ev["lat"].clone(), "lon" => ev["lon"].clone(), "error" => clip(&e, 200)}
        }));
    }
    write_json(out_path, &obj! {"fetched" => now_iso(), "events" => events.clone()})?;
    let ok: Vec<&Value> = events.iter().filter(|e| truthy(e.get("series"))).collect();
    let n_other: usize = ok.iter().map(|e| arr(e.get("others")).len()).sum();
    let ids: Vec<String> = ok
        .iter()
        .map(|e| {
            let id = s_or_empty(e.get("id"));
            let ts = get_str(e, "ts_name").unwrap_or("");
            if ts.contains('.') {
                let parts: Vec<&str> = ts.split('.').collect();
                format!("{}:{}", id, parts[parts.len() - 2])
            } else {
                id
            }
        })
        .collect();
    let mut msg = format!("Recorded floods: {} of {} with hourly readings, {} more gauges along the rivers ({})", ok.len(), events.len(), n_other, ids.join(", "));
    let others: Vec<String> = ok
        .iter()
        .filter(|e| truthy(e.get("others")))
        .map(|e| format!("{}: {}", s_or_empty(e.get("id")), arr(e.get("others")).iter().map(|o| s_or_empty(o.get("name"))).collect::<Vec<_>>().join(", ")))
        .collect();
    msg.push_str(&format!("\nOther gauges per flood: {}", others.join("; ")));
    for e in &events {
        if let Some(x) = get_str(e, "error") {
            msg.push_str(&format!("\nwarning: {}: {}", s_or_empty(e.get("id")), x));
        }
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gauge(lon: f64, lat: f64, p: Value) -> Value {
        json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": p})
    }

    fn gauges() -> Vec<Value> {
        vec![
            gauge(153.277, -28.808, json!({"name": "Lismore (Rowing Club)", "basin": "Richmond River", "station": "203004", "kind": "forecast", "id": "1"})),
            gauge(153.300, -28.800, json!({"name": "Other Creek", "basin": "Richmond River", "station": "203999", "kind": "forecast", "id": "2"})),
            gauge(153.276, -28.809, json!({"name": "Lismore tide", "station": "T1", "kind": "tide", "id": "3"})),
        ]
    }

    fn fake(ps: &[(String, String)]) -> R<Value> {
        let req = ps.iter().find(|x| x.0 == "request").unwrap().1.as_str();
        if req == "getTimeseriesList" {
            return Ok(json!([["ts_id", "ts_name"], ["11", "DMQaQc.Merged.DailyMean.24HR"], ["22", "DMQaQc.Merged.AsStored.1"]]));
        }
        if req == "getStationList" {
            return Ok(json!([["station_no", "station_name", "station_latitude", "station_longitude"]]));
        }
        let mut data = Vec::new();
        for h in 0..20 {
            for m in [0, 30] {
                data.push(json!([format!("2022-02-26T{:02}:{:02}:00.000+10:00", h, m), 2.0 + h as f64 * 0.5]));
            }
        }
        Ok(json!([{"ts_id": "22", "data": data}]))
    }

    fn ev(m: &str) -> Value {
        json!({"id": "x", "name": "X", "lat": -28.809, "lon": 153.2765, "match": m, "start": "2022-02-26", "end": "2022-02-26"})
    }

    #[test]
    fn picks_the_named_gauge_not_the_tide_gauge() {
        let g = gauges();
        let best = pick_gauge(&json!({"lat": -28.809, "lon": 153.2765, "match": "lismore|wilson"}), &g).unwrap();
        assert_eq!(best.1["properties"]["station"], "203004");
    }

    #[test]
    fn prefers_finer_series_and_averages_to_hours() {
        let e = fetch_event(&fake, &ev("lismore"), &gauges()).unwrap();
        assert_eq!(e["ts_name"], "DMQaQc.Merged.AsStored.1");
        assert_eq!(e["series"][0], json!([0, 2.0]));
        assert_eq!(e["series"].as_array().unwrap().len(), 20);
        assert_eq!(e["peak"]["hours"], 19);
        assert_eq!(e["start"], "2022-02-26T00:00:00+10:00");
    }

    #[test]
    fn collects_the_same_flood_at_other_gauges_on_the_river() {
        let e = fetch_event(&fake, &ev("lismore|richmond"), &gauges()).unwrap();
        let st: Vec<&str> = e["others"].as_array().unwrap().iter().map(|o| o["station"].as_str().unwrap()).collect();
        assert_eq!(st, ["203999"], "the other Richmond gauge, not the tide gauge");
        assert_eq!(e["others"][0]["series"].as_array().unwrap().len(), 20);
    }

    #[test]
    fn records_errors_without_stopping() {
        let d = std::env::temp_dir().join(format!("ev-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let cfg = d.join("c.json");
        std::fs::write(&cfg, json!({"events": [
            {"id": "a", "name": "A", "lat": -28.809, "lon": 153.2765, "match": "lismore", "start": "2022-02-26", "end": "2022-02-26"},
            {"id": "b", "name": "B", "lat": -20.0, "lon": 140.0, "match": "x", "start": "2022-02-26", "end": "2022-02-26"}]}).to_string()).unwrap();
        let g = d.join("g.json");
        std::fs::write(&g, json!({"features": gauges()}).to_string()).unwrap();
        let out = d.join("o.json");
        run(cfg.to_str().unwrap(), g.to_str().unwrap(), out.to_str().unwrap(), &fake).unwrap();
        let res = read_json(&out).unwrap()["events"].clone();
        assert!(truthy(res[0].get("series")));
        assert!(res[1].get("error").is_some());
        let _ = std::fs::remove_dir_all(d);
    }
}
