//! Terrain hydrology with the RustGIS tools, run inside `flood` (was
//! pipeline/run_hydrology.sh calling the separate `geolibre` program).
//!
//! Usage: flood hydrology <config.json> <work_dir>
//!        flood tool <tool-id> [--key=value ...]
//!        flood tool list
//!
//! The tools are whitebox_next_gen's (the `wbtools_oss` crate from
//! opengeos/whitebox-wasm), the same code RustGIS and GeoLibre run, pinned
//! to the commit inside the GeoLibre release the pipeline used before. From
//! <work_dir>/dem.tif `hydrology` writes:
//!   dem_breached.tif  depressions breached (least-cost), the rest filled
//!   dem_cond.tif      flats resolved
//!   d8.tif            D8 flow directions (Whitebox codes)
//!   acc.tif           flow accumulation (cells)
//!   streams.tif       streams (cells above the area threshold)
//!   hand.tif          height above nearest drainage (m)
//!   hydrology.json    the tools, version and arguments used
//! Every step can be repeated by hand in RustGIS (Analyze > GeoLibre >
//! Hydrology) or with `flood tool`.

use crate::obj;
use crate::util::*;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use wbcore::{AllowAllCapabilities, ProgressSink, ToolArgs, ToolContext};
use wbtools_oss::{register_default_tools, ToolRegistry};

/// The whitebox-wasm commit the tools come from (see Cargo.toml).
pub const TOOLS_REV: &str = "6b2a6eb";
pub const TOOLS: &str = "whitebox_next_gen tools (opengeos/whitebox-wasm 6b2a6eb, as in GeoLibre 1.6.0)";

/// Prints tool messages; progress every 25 %.
struct Progress {
    last: std::sync::atomic::AtomicI64,
}

impl ProgressSink for Progress {
    fn info(&self, msg: &str) {
        println!("  {}", msg);
    }
    fn progress(&self, pct: f64) {
        let p = (pct.clamp(0.0, 1.0) * 4.0).floor() as i64;
        if self.last.swap(p, std::sync::atomic::Ordering::Relaxed) != p && p > 0 {
            println!("  {}%", p * 25);
        }
    }
}

fn registry() -> ToolRegistry {
    let mut r = ToolRegistry::new();
    register_default_tools(&mut r);
    r
}

/// A command-line value as the tools expect it (as the geolibre runner does).
fn infer(raw: &str) -> Value {
    match raw {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        _ => {}
    }
    if let Ok(n) = raw.parse::<i64>() {
        return Value::from(n);
    }
    if let Ok(f) = raw.parse::<f64>() {
        if f.is_finite() {
            return Value::from(f);
        }
    }
    Value::String(raw.to_string())
}

/// `--key=value`, `--key value` and bare `--flag` arguments.
pub fn parse_args(flags: &[String]) -> ToolArgs {
    let mut args = BTreeMap::new();
    let mut i = 0;
    while i < flags.len() {
        let Some(k) = flags[i].strip_prefix("--") else {
            i += 1;
            continue;
        };
        if let Some((key, v)) = k.split_once('=') {
            args.insert(key.to_string(), infer(v));
            i += 1;
        } else if i + 1 < flags.len() && !flags[i + 1].starts_with("--") {
            args.insert(k.to_string(), infer(&flags[i + 1]));
            i += 2;
        } else {
            args.insert(k.to_string(), Value::Bool(true));
            i += 1;
        }
    }
    args
}

/// Run one tool on a thread with a large stack (some recurse deeply on big
/// rasters, as the geolibre runner allows for).
fn run_tool(reg: &ToolRegistry, id: &str, args: &ToolArgs) -> R<Value> {
    std::thread::scope(|s| {
        std::thread::Builder::new()
            .stack_size(256 * 1024 * 1024)
            .spawn_scoped(s, || {
                let progress = Progress { last: std::sync::atomic::AtomicI64::new(-1) };
                let ctx = ToolContext { progress: &progress, capabilities: &AllowAllCapabilities };
                reg.run(id, args, &ctx).map(|r| serde_json::to_value(&r.outputs).unwrap_or(Value::Null)).map_err(|e| format!("{}: {}", id, e))
            })
            .map_err(err)?
            .join()
            .map_err(|_| format!("{}: the tool stopped unexpectedly", id))?
    })
}

/// `flood tool <id> [--k=v ...]` / `flood tool list`
pub fn tool(argv: &[String]) -> R<String> {
    let reg = registry();
    match argv.first().map(|s| s.as_str()) {
        None => Err("usage: flood tool <list|tool-id> [--key=value ...]".into()),
        Some("list") => Ok(reg.list().iter().map(|m| m.id.to_string()).collect::<Vec<_>>().join("\n")),
        Some(id) => run_tool(&reg, id, &parse_args(&argv[1..])).map(|o| o.to_string()),
    }
}

/// The pipeline's steps: (tool, arguments). File names are in the work folder.
fn steps(cell: f64, area_km2: f64, breach: i64) -> Vec<(&'static str, Vec<(&'static str, Value)>)> {
    let thresh = (area_km2 * 1e6 / (cell * cell)).round_ties_even() as i64;
    let s = |v: &str| Value::String(v.to_string());
    vec![
        // carve through road embankments and bridges a surface model shows as dams, then fill the rest
        ("breach_depressions_least_cost", vec![("dem", s("dem.tif")), ("max_dist", Value::from(breach)), ("fill_deps", Value::Bool(true)), ("output", s("dem_breached.tif"))]),
        // make sure flat areas drain
        ("fill_depressions", vec![("dem", s("dem_breached.tif")), ("fix_flats", Value::Bool(true)), ("output", s("dem_cond.tif"))]),
        // flow directions and accumulation
        ("d8_pointer", vec![("dem", s("dem_cond.tif")), ("esri_pntr", Value::Bool(false)), ("output", s("d8.tif"))]),
        ("d8_flow_accum", vec![("input", s("d8.tif")), ("input_is_pointer", Value::Bool(true)), ("esri_pntr", Value::Bool(false)), ("out_type", s("cells")), ("output", s("acc.tif"))]),
        // streams and height above nearest drainage
        ("extract_streams", vec![("flow_accumulation", s("acc.tif")), ("threshold", Value::from(thresh)), ("zero_background", Value::Bool(true)), ("output", s("streams.tif"))]),
        ("elevation_above_stream", vec![("dem", s("dem_cond.tif")), ("streams", s("streams.tif")), ("output", s("hand.tif"))]),
    ]
}

/// The arguments that are files, made into paths in the work folder.
const FILE_ARGS: [&str; 6] = ["dem", "output", "input", "flow_accumulation", "streams", "d8_pntr"];

pub fn run(config_path: &str, work_dir: &str) -> R<String> {
    let cfg = read_json(config_path)?;
    let work = Path::new(work_dir);
    let cell = cfg.get("cell_m").and_then(|v| v.as_f64()).ok_or("no cell_m in the config")?;
    let area = cfg.get("stream_area_km2").and_then(|v| v.as_f64()).ok_or("no stream_area_km2 in the config")?;
    let breach = cfg.get("breach_max_dist_cells").and_then(|v| v.as_i64()).ok_or("no breach_max_dist_cells in the config")?;
    if !work.join("dem.tif").exists() {
        return Err(format!("no dem.tif in {}", work.display()));
    }
    let reg = registry();
    let mut log = Vec::new();
    for (id, a) in steps(cell, area, breach) {
        let mut args = ToolArgs::new();
        let mut shown = Vec::new();
        for (k, v) in &a {
            shown.push(format!("--{}={}", k, v.as_str().map(String::from).unwrap_or_else(|| v.to_string())));
            let v = match (FILE_ARGS.contains(k), v.as_str()) {
                (true, Some(f)) => Value::String(work.join(f).to_string_lossy().into_owned()),
                _ => v.clone(),
            };
            args.insert(k.to_string(), v);
        }
        println!("{} {}", id, shown.join(" "));
        let t = std::time::Instant::now();
        run_tool(&reg, id, &args)?;
        log.push(obj! {"tool" => id, "args" => shown.join(" "), "seconds" => round_to(t.elapsed().as_secs_f64(), 1)});
    }
    write_json_indent(work.join("hydrology.json"), &obj! {"tools" => TOOLS, "steps" => log.clone()}, 1)?;
    let secs: f64 = log.iter().filter_map(|s| s["seconds"].as_f64()).sum();
    Ok(format!("Hydrology: {} steps in {:.0} s with {}", log.len(), secs, TOOLS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::{read_geotiff, write_geotiff_f32};

    #[test]
    fn arguments_like_the_geolibre_runner() {
        let f: Vec<String> = ["--dem=a.tif", "--max_dist", "60", "--fill_deps=true", "--zero_background", "--x=1.5"].iter().map(|s| s.to_string()).collect();
        let a = parse_args(&f);
        assert_eq!(a["dem"], "a.tif");
        assert_eq!(a["max_dist"], 60);
        assert_eq!(a["fill_deps"], true);
        assert_eq!(a["zero_background"], true);
        assert_eq!(a["x"], 1.5);
        assert_eq!(steps(40.0, 1.0, 60)[4].1[1].1, 625, "stream threshold in cells");
    }

    #[test]
    fn the_tools_are_all_there() {
        let reg = registry();
        let ids: Vec<String> = reg.list().iter().map(|m| m.id.to_string()).collect();
        for (id, _) in steps(40.0, 1.0, 60) {
            assert!(ids.iter().any(|i| i == id), "{} missing", id);
        }
    }

    #[test]
    fn a_valley_drains_to_its_outlet() {
        // a V-shaped valley sloping east, with a pit to fill
        let (w, h) = (40usize, 21usize);
        let mut dem = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                dem[y * w + x] = (10.0 + 0.05 * (w - x) as f64 + 0.3 * (y as f64 - 10.0).abs()) as f32;
            }
        }
        dem[10 * w + 20] -= 3.0;
        let d = std::env::temp_dir().join(format!("hy-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        write_geotiff_f32(&d.join("dem.tif"), w, h, &dem, 500000.0, 7000000.0, 40.0, 7856, -9999.0).unwrap();
        let cfg = d.join("c.json");
        std::fs::write(&cfg, r#"{"cell_m": 40, "stream_area_km2": 0.05, "breach_max_dist_cells": 10}"#).unwrap();
        let msg = run(cfg.to_str().unwrap(), d.to_str().unwrap()).unwrap();
        assert!(msg.starts_with("Hydrology: 6 steps"), "{}", msg);
        let d8 = read_geotiff(&std::fs::read(d.join("d8.tif")).unwrap()).unwrap();
        // along the valley floor the water flows east (Whitebox code 2)
        assert_eq!(d8.get(30, 10), 2.0);
        let streams = read_geotiff(&std::fs::read(d.join("streams.tif")).unwrap()).unwrap();
        assert!(streams.get(35, 10) > 0.0, "the valley floor is a stream");
        let hand = read_geotiff(&std::fs::read(d.join("hand.tif")).unwrap()).unwrap();
        assert!(hand.get(30, 2) > hand.get(30, 10), "the valley side stands above the stream");
        assert!(read_json(d.join("hydrology.json")).unwrap()["steps"].as_array().unwrap().len() == 6);
        let _ = std::fs::remove_dir_all(d);
    }
}
