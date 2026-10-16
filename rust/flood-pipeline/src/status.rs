//! data/status.json: what each data source returned in this build (was
//! pipeline/build_status.py).
//!
//! Usage: flood status <site_dir> <log>...
//!
//! For each source, the first summary line in the step logs, whether it
//! came from this run or an earlier one (a cache), and the date in the
//! published file. The app shows this as its Data status list.

use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::Value;
use std::path::Path;

/// (name, log line prefix, published file, what it feeds)
const SOURCES: [(&str, &str, &str, &str); 10] = [
    ("Bureau gauges, dams and readings", "National:", "national/meta.json", "the Australia map, reports, gauge levels"),
    ("Flood class levels and warnings", "Flood info:", "national/warnings.json", "warnings panel, minor/moderate/major levels"),
    ("Recorded floods (hourly readings)", "Recorded floods:", "events.json", "flood over time"),
    ("Recorded sea levels", "Sea levels:", "events.json", "the sea during recorded floods"),
    ("Gauge ratings", "Ratings:", "ratings.json", "routing, peak flows"),
    ("Tide heights", "Tides:", "tides.json", "storm tide, tide cycles"),
    ("Workers by place of work", "Workers:", "workers.json", "daytime impact"),
    ("OpenStreetMap copies", "OpenStreetMap copies:", "osm/index.json", "impact counts for the presets"),
    ("Levee lines", "Levees:", "levees.geojson", "levees and flood gates"),
    ("Google Flood Hub", "Flood Hub:", "floodhub.json", "forecasts (needs an API key)"),
];

fn fetched_of(path: &Path) -> Value {
    let Ok(d) = read_json(path) else { return Value::Null };
    for k in ["fetched", "updated", "generated"] {
        if d.is_object() && truthy(d.get(k)) {
            return Value::from(py_str(&d[k]));
        }
    }
    Value::Null
}

pub fn run(site: &str, logs: &[String]) -> R<String> {
    let site = Path::new(site);
    let mut lines = Vec::new();
    for lg in logs {
        if let Ok(b) = std::fs::read(lg) {
            lines.extend(String::from_utf8_lossy(&b).lines().map(String::from).collect::<Vec<_>>());
        }
    }
    let zero_err = Regex::new(r"(?i)\b0 errors?\b").unwrap();
    let bad_re = Regex::new(r"(?i)unavailable|\b0 (lines|of)\b|failed|error").unwrap();
    let good_re = Regex::new(r"\b[1-9]\d* of\b").unwrap();
    let mut out = Vec::new();
    for (name, prefix, file, feeds) in SOURCES {
        let line = lines.iter().find(|l| l.starts_with(prefix));
        let published = site.join("data").join(file);
        let exists = published.exists();
        let when = if exists { fetched_of(&published) } else { Value::Null };
        let (summary, state) = if let Some(l) = line {
            let summary = l[prefix.len()..].trim().to_string();
            let text = zero_err.replace_all(&summary, "");
            let bad = bad_re.is_match(&text) && !good_re.is_match(&text);
            (summary, if bad { "problem" } else { "ok" })
        } else if exists {
            ("kept from an earlier build".to_string(), "cached")
        } else {
            ("not available".to_string(), "missing")
        };
        out.push(obj! {"name" => name, "state" => state, "summary" => clip(&summary, 300), "fetched" => when, "feeds" => feeds});
    }
    write_json_indent(site.join("data").join("status.json"), &obj! {"built" => now_iso(), "sources" => out.clone()}, 1)?;
    Ok(format!("Data status: {}", out.iter().map(|s| format!("{} {}", s["name"].as_str().unwrap(), s["state"].as_str().unwrap())).collect::<Vec<_>>().join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summaries_states_and_dates() {
        let d = std::env::temp_dir().join(format!("st-{}", std::process::id()));
        let site = d.join("site");
        std::fs::create_dir_all(site.join("data/national")).unwrap();
        std::fs::write(site.join("data/national/meta.json"), json!({"fetched": "2026-10-16T00:00:00+00:00"}).to_string()).unwrap();
        std::fs::write(site.join("data/tides.json"), json!({"fetched": "2026-10-01T00:00:00+00:00", "points": []}).to_string()).unwrap();
        let log = d.join("a.log");
        std::fs::write(&log, "National: 3839 gauges, 303 storages, 0 errors\nLevees: 0 lines (nsw: unavailable)\nRecorded floods: 15 of 22 with hourly readings\n").unwrap();
        run(site.to_str().unwrap(), &[log.to_str().unwrap().into(), d.join("missing.log").to_str().unwrap().into()]).unwrap();
        let st = read_json(site.join("data/status.json")).unwrap();
        let by = |n: &str| st["sources"].as_array().unwrap().iter().find(|s| s["name"] == n).unwrap().clone();
        assert_eq!(by("Bureau gauges, dams and readings")["state"], "ok");
        assert_eq!(by("Bureau gauges, dams and readings")["fetched"], "2026-10-16T00:00:00+00:00");
        assert_eq!(by("Levee lines")["state"], "problem");
        assert_eq!(by("Recorded floods (hourly readings)")["state"], "ok");
        assert_eq!(by("Tide heights")["state"], "cached");
        assert_eq!(by("Workers by place of work")["state"], "missing");
        let _ = std::fs::remove_dir_all(d);
    }
}
