//! Brisbane City Council flood likelihood layers pre-rendered as images
//! (was pipeline/render_council_layers.py).
//!
//! Usage: flood council <out_dir>
//!
//! Downloads the creek and overland-flow likelihood polygons, rasterises
//! them in Web Mercator at 15 m and writes a palette PNG per layer plus
//! council.json with their bounds.

use crate::geo::{merc_to_lonlat, rasterize, write_png_indexed};
use crate::net;
use crate::obj;
use crate::util::*;
use serde_json::{json, Map, Value};
use std::path::Path;

const BCC: &str = "https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services/";
const PIXEL_M: f64 = 15.0;
const LAYERS: [(&str, &str); 2] = [("creek", "Flood_Awareness_Creek"), ("overland", "Flood_Awareness_Overland_Flow")];
/// class -> (value, colour); higher values are drawn last so they win
const CLASSES: [(&str, u8, &str); 4] = [("Very Low", 1, "#fff3a8"), ("Low", 2, "#f2c12e"), ("Medium", 3, "#e8710a"), ("High", 4, "#b3261e")];

pub type Ring = Vec<(f64, f64)>;

fn get_json(url: &str, params: &[(&str, String)]) -> R<Value> {
    let q = net::with_query(url, params);
    let mut last = String::new();
    for attempt in 0..4u64 {
        let r = net::get(&q, &[], 120).map_err(|e| e.to_string()).and_then(|r| serde_json::from_slice::<Value>(&r.body).map_err(err));
        match r {
            Ok(d) if d.get("error").is_some() => last = d["error"].to_string(),
            Ok(d) => return Ok(d),
            Err(e) => last = e,
        }
        std::thread::sleep(std::time::Duration::from_secs(5 * (attempt + 1)));
    }
    Err(format!("{}: {}", url, last))
}

fn fetch_features(service: &str) -> R<Vec<Value>> {
    let layer = format!("{}{}/FeatureServer/0/query", BCC, service);
    let (mut feats, mut offset) = (Vec::new(), 0usize);
    loop {
        let res = get_json(&layer, &[
            ("where", "1=1".into()), ("outFields", "FLOOD_RISK".into()), ("returnGeometry", "true".into()), ("outSR", "102100".into()),
            ("maxAllowableOffset", py_float(PIXEL_M / 2.0)), ("geometryPrecision", "1".into()), ("f", "json".into()),
            ("resultOffset", offset.to_string()), ("resultRecordCount", "2000".into()), ("orderByFields", "OBJECTID".into()),
        ])?;
        let batch = arr(res.get("features")).to_vec();
        let n = batch.len();
        feats.extend(batch);
        if n == 0 || !truthy(res.get("exceededTransferLimit")) {
            return Ok(feats);
        }
        offset += n;
    }
}

fn signed_area(r: &Ring) -> f64 {
    (0..r.len()).map(|i| { let (a, b) = (r[i], r[(i + 1) % r.len()]); a.0 * b.1 - b.0 * a.1 }).sum::<f64>() / 2.0
}

fn point_in_ring(p: (f64, f64), ring: &Ring) -> bool {
    let mut inside = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let ((xi, yi), (xj, yj)) = (ring[i], ring[j]);
        let dy = if yj - yi == 0.0 { 1e-12 } else { yj - yi };
        if (yi > p.1) != (yj > p.1) && p.0 < (xj - xi) * (p.1 - yi) / dy + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Esri rings (outer clockwise, holes anticlockwise) -> polygons (outer first).
pub fn esri_to_polygons(rings: &[Ring]) -> Vec<Vec<Ring>> {
    let (mut outers, mut holes) = (Vec::new(), Vec::new());
    for r in rings {
        if r.len() < 4 {
            continue;
        }
        if signed_area(r) < 0.0 { outers.push(r.clone()) } else { holes.push(r.clone()) }
    }
    let mut polys: Vec<Vec<Ring>> = outers.into_iter().map(|o| vec![o]).collect();
    for h in holes {
        if let Some(p) = polys.iter_mut().find(|p| point_in_ring(h[0], &p[0])) {
            p.push(h);
        }
    }
    polys
}

fn render(name: &str, service: &str, out: &Path) -> R<(Value, String)> {
    let feats = fetch_features(service)?;
    let mut shapes: Vec<(Vec<Ring>, u8)> = Vec::new();
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for f in &feats {
        let risk = f.get("attributes").and_then(|a| get_str(a, "FLOOD_RISK")).unwrap_or("");
        let Some(cls) = CLASSES.iter().find(|c| c.0 == risk) else { continue };
        let rings: Vec<Ring> = arr(f.get("geometry").and_then(|g| g.get("rings"))).iter()
            .map(|r| arr(Some(r)).iter().map(|p| (p[0].as_f64().unwrap_or(f64::NAN), p[1].as_f64().unwrap_or(f64::NAN))).collect())
            .collect();
        if rings.is_empty() {
            continue;
        }
        for r in &rings {
            for &(x, y) in r {
                minx = minx.min(x);
                maxx = maxx.max(x);
                miny = miny.min(y);
                maxy = maxy.max(y);
            }
        }
        for p in esri_to_polygons(&rings) {
            shapes.push((p, cls.1));
        }
    }
    if shapes.is_empty() {
        return Err(format!("{}: no polygons", service));
    }
    shapes.sort_by_key(|s| s.1); // low classes first, so high classes win
    let (minx, miny) = ((minx / PIXEL_M).floor() * PIXEL_M, (miny / PIXEL_M).floor() * PIXEL_M);
    let (maxx, maxy) = ((maxx / PIXEL_M).ceil() * PIXEL_M, (maxy / PIXEL_M).ceil() * PIXEL_M);
    let (w, h) = (((maxx - minx) / PIXEL_M) as usize, ((maxy - miny) / PIXEL_M) as usize);
    let mut grid = vec![0u8; w * h];
    for (rings, v) in &shapes {
        rasterize(&mut grid, w, h, minx, maxy, PIXEL_M, rings, *v);
    }
    let mut palette = vec![[0u8, 0, 0]];
    for c in CLASSES {
        let hex = |i: usize| u8::from_str_radix(&c.2[i..i + 2], 16).unwrap();
        palette.push([hex(1), hex(3), hex(5)]);
    }
    let path = out.join(format!("{}.png", name));
    write_png_indexed(&path, w, h, &grid, &palette, &[0])?;
    let (wl, s) = merc_to_lonlat(minx, miny);
    let (e, n) = merc_to_lonlat(maxx, maxy);
    let counts = CLASSES.iter().map(|c| format!("'{}': {}", c.0, grid.iter().filter(|&&g| g == c.1).count())).collect::<Vec<_>>().join(", ");
    let kb = std::fs::metadata(&path).map(|m| m.len() / 1024).unwrap_or(0);
    let line = format!("{}: {} features -> {}x{} px, {} KB, cells {{{}}}", name, feats.len(), w, h, kb, counts);
    Ok((obj! {"file" => format!("{}.png", name), "bounds" => vec![num(wl), num(s), num(e), num(n)], "features" => feats.len(), "pixel_m" => PIXEL_M}, line))
}

pub fn run(out_dir: &str) -> R<String> {
    let out = Path::new(out_dir);
    std::fs::create_dir_all(out).map_err(err)?;
    let (mut layers, mut errors, mut log) = (Map::new(), Vec::new(), Vec::new());
    for (name, service) in LAYERS {
        match render(name, service, out) {
            Ok((m, line)) => {
                layers.insert(name.into(), m);
                log.push(line);
            }
            Err(e) => {
                errors.push(format!("{}: {}", name, e));
                log.push(format!("warning: {}: {}", name, e));
            }
        }
    }
    write_json_indent(out.join("council.json"), &obj! {"generated" => today(), "layers" => Value::Object(layers), "errors" => json!(errors)}, 1)?;
    Ok(log.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rings_become_polygons_with_holes() {
        let r = |v: &[(f64, f64)]| v.to_vec();
        let outer_a = r(&[(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0), (0.0, 0.0)]); // clockwise (y up)
        let hole_a = r(&[(2.0, 2.0), (4.0, 2.0), (4.0, 4.0), (2.0, 4.0), (2.0, 2.0)]);
        let outer_b = r(&[(20.0, 0.0), (20.0, 5.0), (25.0, 5.0), (25.0, 0.0), (20.0, 0.0)]);
        let polys = esri_to_polygons(&[outer_a, hole_a, outer_b]);
        assert_eq!(polys.len(), 2);
        assert_eq!(polys[0].len(), 2, "outer + hole");
        assert_eq!(polys[1].len(), 1);
    }
}
