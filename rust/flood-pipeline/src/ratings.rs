//! Level-to-flow ratings for gauges near the presets (was
//! pipeline/fetch_ratings.py).
//!
//! Usage: flood ratings <viewer/app.js> <gauges.geojson> <out.json> [--km 12] [--max 250]
//!
//! For each gauge within --km of a preset with both water level and
//! discharge series, ten years of daily means of both are paired by day
//! and fitted with Q = a (h - h0)^b by least squares on logs (h0 searched
//! below the lowest level). Writes {fetched, ratings: {station: {name, a,
//! b, h0, r2, hmed, hmax, qmax, n}}}.

use crate::events::Kiwis;
use crate::national::{col, kp};
use crate::obj;
use crate::osm::presets;
use crate::util::*;
use serde_json::{Map, Value};
use std::collections::HashMap;

const YEARS: i64 = 10;

fn daily(kiwis: Kiwis, station: &str, parameter: &str) -> R<Option<HashMap<String, f64>>> {
    let rows = kiwis(&kp(&[("request", "getTimeseriesList"), ("station_no", station), ("parametertype_name", parameter), ("returnfields", "ts_id,ts_name")]))?;
    let rows = match rows.as_array() {
        Some(r) if r.len() >= 2 => r,
        _ => return Ok(None),
    };
    let (Some(ii), Some(inm)) = (col(&rows[0], "ts_id"), col(&rows[0], "ts_name")) else { return Ok(None) };
    let ids: Vec<(String, String)> = rows[1..].iter().map(|r| (py_str(&r[ii]), py_str(&r[inm]))).collect();
    let ts = ids.iter().find(|(_, n)| n.contains("DailyMean") && n.contains("Merged")).or_else(|| ids.iter().find(|(_, n)| n.contains("DailyMean")));
    let Some((ts, _)) = ts else { return Ok(None) };
    let end = today();
    let (y, m, d): (i64, i64, i64) = (end[..4].parse().unwrap(), end[5..7].parse().unwrap(), end[8..10].parse().unwrap());
    let start = format!("{:04}-{:02}-{:02}", y - YEARS, m, if valid_date(y - YEARS, m, d) { d } else { 28 });
    let res = kiwis(&kp(&[("request", "getTimeseriesValues"), ("ts_id", ts), ("from", &start), ("to", &end), ("returnfields", "Timestamp,Value")]))?;
    let entry = match &res {
        Value::Array(a) if !a.is_empty() => a[0].clone(),
        Value::Object(_) => res.clone(),
        _ => Value::Null,
    };
    let mut out = HashMap::new();
    for r in arr(entry.get("data")) {
        let (Some(t), Some(v)) = (r.get(0).and_then(|t| t.as_str()), r.get(1)) else { continue };
        let Some(v) = v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())) else { continue };
        out.insert(clip(t, 10), v);
    }
    Ok(Some(out))
}

/// Q = a (h - h0)^b fitted to (level, flow) pairs, or None.
pub fn fit(pairs: &[(f64, f64)]) -> Option<Map<String, Value>> {
    let pairs: Vec<(f64, f64)> = pairs.iter().copied().filter(|&(h, q)| q > 0.0 && h.is_finite() && q.is_finite()).collect();
    if pairs.len() < 60 {
        return None;
    }
    let mut hs: Vec<f64> = pairs.iter().map(|p| p.0).collect();
    let hmin = hs.iter().cloned().fold(f64::INFINITY, f64::min);
    let hmax = hs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if hmax - hmin < 0.3 {
        return None;
    }
    let ys: Vec<f64> = pairs.iter().map(|p| p.1.ln()).collect();
    let n = pairs.len() as f64;
    let my = ys.iter().sum::<f64>() / n;
    let mut best: Option<(f64, f64, f64, f64)> = None; // a, b, h0, r2
    for k in 1..=60 {
        let h0 = hmin - k as f64 * f64::max(0.02, (hmax - hmin) / 60.0);
        let xs: Vec<f64> = pairs.iter().map(|p| (p.0 - h0).ln()).collect();
        let mx = xs.iter().sum::<f64>() / n;
        let sxx: f64 = xs.iter().map(|x| (x - mx).powi(2)).sum();
        if sxx <= 0.0 {
            continue;
        }
        let b = xs.iter().zip(&ys).map(|(x, y)| (x - mx) * (y - my)).sum::<f64>() / sxx;
        let la = my - b * mx;
        let ss: f64 = xs.iter().zip(&ys).map(|(x, y)| (y - la - b * x).powi(2)).sum();
        let st: f64 = ys.iter().map(|y| (y - my).powi(2)).sum();
        let st = if st == 0.0 { 1e-9 } else { st };
        let r2 = 1.0 - ss / st;
        if best.is_none_or(|bb| r2 > bb.3) {
            best = Some((la.exp(), b, h0, r2));
        }
    }
    let (a, b, h0, r2) = best?;
    if !(0.8..=4.0).contains(&b) || r2 < 0.8 {
        return None;
    }
    hs.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let qmax = pairs.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    let r4 = |v: f64| num(round_to(v, 4));
    let mut m = Map::new();
    m.insert("a".into(), r4(a));
    m.insert("b".into(), r4(b));
    m.insert("h0".into(), r4(h0));
    m.insert("r2".into(), r4(r2));
    m.insert("hmed".into(), r4(hs[hs.len() / 2]));
    m.insert("hmax".into(), r4(hmax));
    m.insert("qmax".into(), r4(qmax));
    m.insert("n".into(), Value::from(pairs.len()));
    Some(m)
}

pub fn run(app_js: &str, gauges_path: &str, out_path: &str, near_km: f64, max_n: usize, kiwis: Kiwis) -> R<String> {
    let ps = presets(app_js)?;
    let feats = arr(read_json(gauges_path)?.get("features")).to_vec();
    let mut picked: Vec<(String, f64, Value)> = Vec::new();
    for f in &feats {
        let p = &f["properties"];
        if !truthy(p.get("station")) || get_str(p, "kind") == Some("tide") {
            continue;
        }
        let c = &f["geometry"]["coordinates"];
        let (lon, lat) = (c[0].as_f64().unwrap_or(f64::NAN), c[1].as_f64().unwrap_or(f64::NAN));
        let d = ps.iter().map(|q| km(lat, lon, q.lat, q.lon)).fold(f64::INFINITY, f64::min);
        let st = s_or_empty(p.get("station"));
        if d <= near_km {
            let name = p.get("name").cloned().unwrap_or(Value::Null);
            match picked.iter_mut().find(|x| x.0 == st) {
                Some(x) if d < x.1 => {
                    x.1 = d;
                    x.2 = name;
                }
                Some(_) => {}
                None => picked.push((st, d, name)),
            }
        }
    }
    picked.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut ratings = Map::new();
    let (mut tried, mut no_q) = (0, 0);
    let mut warnings = Vec::new();
    for (st, _, name) in picked.into_iter().take(max_n) {
        tried += 1;
        let r = (|| -> R<()> {
            let Some(q) = daily(kiwis, &st, "Water Course Discharge")?.filter(|q| !q.is_empty()) else {
                no_q += 1;
                return Ok(());
            };
            let Some(h) = daily(kiwis, &st, "Water Course Level")?.filter(|h| !h.is_empty()) else { return Ok(()) };
            let pairs: Vec<(f64, f64)> = h.iter().filter_map(|(d, hv)| q.get(d).map(|qv| (*hv, *qv))).collect();
            if let Some(mut r) = fit(&pairs) {
                let mut m = Map::new();
                m.insert("name".into(), name.clone());
                m.append(&mut r);
                ratings.insert(st.clone(), Value::Object(m));
            }
            Ok(())
        })();
        if let Err(e) = r {
            warnings.push(format!("warning: {}: {}", st, clip(&e, 100)));
        }
    }
    write_json(out_path, &obj! {"fetched" => now_iso(), "ratings" => Value::Object(ratings.clone())})?;
    let list: Vec<String> = ratings.values().take(40).map(|v| format!("{} (b {:.2})", s_or_empty(v.get("name")), v["b"].as_f64().unwrap_or(f64::NAN))).collect();
    let mut msg = warnings.join("\n");
    if !msg.is_empty() {
        msg.push('\n');
    }
    msg.push_str(&format!("Ratings: {} of {} gauges near presets ({} without flow records): {}", ratings.len(), tried, no_q, list.join(", ")));
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fit_recovers_a_power_law() {
        let pairs: Vec<(f64, f64)> = (0..100).map(|i| (1.2 + 0.05 * i as f64, 30.0 * (0.05 * i as f64 + 0.7).powf(1.8))).collect();
        let r = fit(&pairs).unwrap();
        assert!((r["b"].as_f64().unwrap() - 1.8).abs() < 0.15);
        assert!((r["h0"].as_f64().unwrap() - 0.5).abs() < 0.15);
        assert!(r["r2"].as_f64().unwrap() > 0.99);
    }

    #[test]
    fn fit_rejects_too_little_or_flat_data() {
        assert!(fit(&[(1.0, 5.0); 10]).is_none());
        assert!(fit(&(0..100).map(|i| (1.0 + i as f64 * 0.001, 5.0 + i as f64)).collect::<Vec<_>>()).is_none());
    }

    #[test]
    fn fits_gauges_near_presets() {
        let fake = |ps: &[(String, String)]| -> R<Value> {
            let g = |k: &str| ps.iter().find(|x| x.0 == k).map(|x| x.1.clone()).unwrap_or_default();
            if g("request") == "getTimeseriesList" {
                let id = if g("parametertype_name").contains("Discharge") { "Q" } else { "H" };
                return Ok(json!([["ts_id", "ts_name"], [id, "DMQaQc.Merged.DailyMean.24HR"]]));
            }
            let mut days = Vec::new();
            for m in 1..=12 {
                for d in 1..=28 {
                    let v = 1.0 + (m * 28 + d) as f64 * 0.01;
                    let v = if g("ts_id") == "Q" { 20.0 * (v - 0.5).powi(2) } else { v };
                    days.push(json!([format!("2020-{:02}-{:02}T00:00:00+10:00", m, d), v]));
                }
            }
            Ok(json!([{"data": days}]))
        };
        let d = std::env::temp_dir().join(format!("rt-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let g = d.join("g.json");
        std::fs::write(&g, json!({"features": [
            {"geometry": {"coordinates": [153.2765, -28.809]}, "properties": {"station": "203004", "name": "Lismore", "kind": "forecast"}},
            {"geometry": {"coordinates": [140.0, -20.0]}, "properties": {"station": "999", "name": "Far away", "kind": "forecast"}}]}).to_string()).unwrap();
        let out = d.join("r.json");
        run(&crate::osm::tests::app(), g.to_str().unwrap(), out.to_str().unwrap(), 12.0, 250, &fake).unwrap();
        let res = read_json(&out).unwrap()["ratings"].clone();
        assert_eq!(res.as_object().unwrap().keys().collect::<Vec<_>>(), ["203004"]);
        assert!((res["203004"]["b"].as_f64().unwrap() - 2.0).abs() < 0.2);
        let _ = std::fs::remove_dir_all(d);
    }
}
