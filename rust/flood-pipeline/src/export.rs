//! Package the RustGIS / GeoLibre hydrology outputs for the web viewer (was
//! pipeline/export_viewer.py).
//!
//! Usage: flood export <config.json> <work_dir> <data_dir>
//!
//! Writes <data_dir>/<id>/dem.f32 (float32 little-endian, NaN = no data),
//! d8.u8 (Whitebox D8 codes, 255 = no data), meta.json and copies of the
//! HAND, streams, D8 and conditioned DEM GeoTIFFs, and adds the area to
//! <data_dir>/areas.json.

use crate::dem::g_fmt;
use crate::geo::{read_geotiff, Proj};
use crate::obj;
use crate::util::*;
use serde_json::{json, Value};
use std::path::Path;

fn runner_version() -> String {
    match std::process::Command::new("geolibre").arg("version").output() {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { "GeoLibre".into() } else { s }
        }
        Err(_) => "GeoLibre".into(),
    }
}

pub fn run(config_path: &str, work_dir: &str, data_dir: &str) -> R<String> {
    let cfg = read_json(config_path)?;
    let (work, data) = (Path::new(work_dir), Path::new(data_dir));
    let id = s_or_empty(cfg.get("id"));
    let out = data.join(&id);
    std::fs::create_dir_all(&out).map_err(err)?;
    let dem = read_geotiff(&std::fs::read(work.join("dem.tif")).map_err(|e| format!("dem.tif: {}", e))?)?;
    let d8 = read_geotiff(&std::fs::read(work.join("d8.tif")).map_err(|e| format!("d8.tif: {}", e))?)?;
    if (d8.w, d8.h) != (dem.w, dem.h) {
        return Err(format!("d8.tif is ({}, {}) but dem.tif is ({}, {})", d8.h, d8.w, dem.h, dem.w));
    }
    let n = dem.w * dem.h;
    let mut f32s = Vec::with_capacity(n * 4);
    let mut codes = Vec::with_capacity(n);
    for i in 0..n {
        let v = dem.data[i] as f32;
        let p = d8.data[i];
        let bad = !v.is_finite() || dem.nodata.map_or(false, |nd| v == nd as f32) || d8.nodata.map_or(false, |nd| p == nd);
        let code = if [0.0, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0].contains(&p) { p as u8 } else { 255 };
        codes.push(if bad { 255 } else { code });
        f32s.extend_from_slice(&(if bad { f32::NAN } else { v }).to_le_bytes());
    }
    std::fs::write(out.join("dem.f32"), &f32s).map_err(err)?;
    std::fs::write(out.join("d8.u8"), &codes).map_err(err)?;
    let epsg = dem.epsg.ok_or("dem.tif has no EPSG code")?;
    let proj = Proj::from_epsg(epsg).ok_or_else(|| format!("unsupported CRS EPSG:{}", epsg))?;
    let g = cfg.get("gauge").cloned().unwrap_or(json!({}));
    let (gx, gy) = proj.from_lonlat(get_f64(&g, "lon").ok_or("no gauge lon")?, get_f64(&g, "lat").ok_or("no gauge lat")?);
    let row = ((dem.y0 - gy) / dem.dy).floor() as i64;
    let col = ((gx - dem.x0) / dem.dx).floor() as i64;
    let mut rasters = Vec::new();
    for (name, label) in [("hand.tif", "HAND"), ("streams.tif", "Streams"), ("d8.tif", "D8 flow directions"), ("dem_cond.tif", "Conditioned DEM")] {
        if work.join(name).exists() {
            std::fs::copy(work.join(name), out.join(name)).map_err(err)?;
            rasters.push(obj! {"name" => label, "file" => name});
        }
    }
    let (left, top) = (dem.x0, dem.y0);
    let (right, bottom) = (dem.x0 + dem.w as f64 * dem.dx, dem.y0 - dem.h as f64 * dem.dy);
    // corners in lon/lat; grid north is within a few hundredths of a degree
    // of true north, so a box from each edge's mean corner matches closely
    let ll: Vec<(f64, f64)> = [(left, top), (right, top), (right, bottom), (left, bottom)].iter().map(|&(x, y)| proj.to_lonlat(x, y)).collect();
    let bounds_lonlat = vec![num((ll[0].0 + ll[3].0) / 2.0), num((ll[2].1 + ll[3].1) / 2.0), num((ll[1].0 + ll[2].0) / 2.0), num((ll[0].1 + ll[1].1) / 2.0)];
    let cell = dem.dx.abs();
    let meta = obj! {
        "id" => id.clone(), "name" => cfg.get("name").cloned().unwrap_or(Value::Null),
        "W" => dem.w, "H" => dem.h, "cell" => cell,
        "crs" => format!("EPSG:{}", epsg),
        "bounds" => vec![num(left), num(bottom), num(right), num(top)],
        "bounds_lonlat" => bounds_lonlat,
        "nodata" => Value::Null,
        "files" => obj! {"dem" => "dem.f32", "d8" => "d8.u8"},
        "gauge" => obj! {"name" => g.get("name").cloned().unwrap_or(Value::Null), "col" => col, "row" => row},
        "brisbaneGauge" => truthy(cfg.get("brisbane_gauge_events")),
        "streamAreaKm2" => cfg.get("stream_area_km2").cloned().unwrap_or(Value::Null),
        "source" => format!("Terrain: Copernicus GLO-30 surface model (ESA, Airbus), resampled to {} m. Heights are relative to the EGM2008 geoid, which differs from AHD by a few tenths of a metre here.", g_fmt(cell)),
        "processedWith" => format!("{} (the RustGIS hydrology tools)", runner_version()),
        "generated" => today(),
        "rasters" => rasters,
    };
    write_json_indent(out.join("meta.json"), &meta, 2)?;
    let areas_path = data.join("areas.json");
    let mut areas: Vec<Value> = if areas_path.exists() { arr(Some(&read_json(&areas_path)?)).to_vec() } else { Vec::new() };
    areas.retain(|a| a.get("id").map(py_str).as_deref() != Some(id.as_str()));
    areas.push(obj! {"id" => id.clone(), "name" => cfg.get("name").cloned().unwrap_or(Value::Null)});
    write_json_indent(&areas_path, &Value::Array(areas), 2)?;
    Ok(format!("Exported {}: {} x {} cells, gauge at row {}, col {}", id, dem.w, dem.h, row, col))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::write_geotiff_f32;

    #[test]
    fn exports_dem_codes_meta_and_areas() {
        let d = std::env::temp_dir().join(format!("ex-{}", std::process::id()));
        let (work, data) = (d.join("work"), d.join("data"));
        std::fs::create_dir_all(&work).unwrap();
        let proj = Proj::from_epsg(7856).unwrap();
        let (gx, gy) = proj.from_lonlat(153.0305, -27.4741);
        let (x0, y0) = ((gx / 40.0).floor() * 40.0 - 80.0, (gy / 40.0).ceil() * 40.0 + 40.0);
        let dem: Vec<f32> = vec![1.0, 2.0, -9999.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0];
        let d8: Vec<f32> = vec![1.0, 2.0, 4.0, 3.0, 8.0, 16.0, 32.0, 64.0, 128.0, 0.0, 1.0, 2.0];
        write_geotiff_f32(&work.join("dem.tif"), 4, 3, &dem, x0, y0, 40.0, 7856, -9999.0).unwrap();
        write_geotiff_f32(&work.join("d8.tif"), 4, 3, &d8, x0, y0, 40.0, 7856, -9999.0).unwrap();
        let cfg = d.join("c.json");
        std::fs::write(&cfg, json!({"id": "t", "name": "Test", "gauge": {"name": "G", "lon": 153.0305, "lat": -27.4741}, "stream_area_km2": 1.0}).to_string()).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("areas.json"), json!([{"id": "t", "name": "Old"}, {"id": "x", "name": "X"}]).to_string()).unwrap();
        run(cfg.to_str().unwrap(), work.to_str().unwrap(), data.to_str().unwrap()).unwrap();
        let codes = std::fs::read(data.join("t/d8.u8")).unwrap();
        assert_eq!(codes, vec![1, 2, 255, 255, 8, 16, 32, 64, 128, 0, 1, 2], "nodata and odd codes are 255");
        let f = std::fs::read(data.join("t/dem.f32")).unwrap();
        assert!(f32::from_le_bytes(f[8..12].try_into().unwrap()).is_nan());
        let meta = read_json(data.join("t/meta.json")).unwrap();
        assert_eq!(meta["crs"], "EPSG:7856");
        assert_eq!((meta["gauge"]["col"].as_i64(), meta["gauge"]["row"].as_i64()), (Some(2), Some(1)));
        let bl = meta["bounds_lonlat"].as_array().unwrap();
        assert!(bl[0].as_f64().unwrap() < 153.0305 && bl[2].as_f64().unwrap() > 153.0305);
        let areas = read_json(data.join("areas.json")).unwrap();
        assert_eq!(areas, json!([{"id": "x", "name": "X"}, {"id": "t", "name": "Test"}]));
        let _ = std::fs::remove_dir_all(d);
    }
}
