//! Copernicus GLO-30 DEM for an area, reprojected to its grid (was
//! pipeline/fetch_dem.py).
//!
//! Usage: flood dem <config.json> <work_dir>
//!
//! Downloads the 1° tiles (public Cloud Optimized GeoTIFFs on AWS Open
//! Data; all-ocean tiles don't exist), mosaics them over the area and
//! resamples bilinearly to the configured CRS and cell size. Writes
//! <work_dir>/dem.tif (float32, nodata -9999) for the RustGIS / GeoLibre
//! hydrology tools.

use crate::geo::{read_geotiff, write_geotiff_f32, Proj, Raster};
use crate::net::{self, NetErr};
use crate::util::*;
use std::path::Path;

const BUCKET: &str = "https://copernicus-dem-30m.s3.amazonaws.com";
pub const NODATA: f64 = -9999.0;

pub fn tile_name(lat: i64, lon: i64) -> String {
    format!("Copernicus_DSM_COG_10_{}{:02}_00_{}{:03}_00_DEM", if lat >= 0 { 'N' } else { 'S' }, lat.abs(), if lon >= 0 { 'E' } else { 'W' }, lon.abs())
}

/// Download a tile unless it's already there; false if it doesn't exist.
fn download(url: &str, dest: &Path) -> R<bool> {
    if dest.metadata().map_or(false, |m| m.len() > 0) {
        return Ok(true);
    }
    match net::get(url, &[], 120) {
        Ok(r) => {
            std::fs::write(dest, r.body).map_err(err)?;
            Ok(true)
        }
        Err(NetErr::Status(403 | 404, _)) => {
            println!("  no tile at {} (sea)", url);
            Ok(false)
        }
        Err(e) => Err(format!("{}: {}", url, e)),
    }
}

/// `{:g}` for whole numbers and decimals alike.
pub fn g_fmt(v: f64) -> String {
    if v == v.trunc() && v.abs() < 1e15 { format!("{}", v as i64) } else { format!("{}", v) }
}

/// The tiles mosaicked onto one grid at the tiles' resolution over a box.
fn mosaic(tiles: &[Raster], w: f64, s: f64, e: f64, n: f64) -> Raster {
    let (dx, dy) = (tiles[0].dx, tiles[0].dy);
    let (cols, rows) = (((e - w) / dx).round() as usize, ((n - s) / dy).round() as usize);
    let mut data = vec![NODATA; cols * rows];
    for r in 0..rows {
        let y = n - (r as f64 + 0.5) * dy;
        for c in 0..cols {
            let x = w + (c as f64 + 0.5) * dx;
            for t in tiles {
                let (fc, fr) = ((x - t.x0) / t.dx, (t.y0 - y) / t.dy);
                if fc >= 0.0 && fr >= 0.0 && (fc as usize) < t.w && (fr as usize) < t.h {
                    let v = t.get(fc as usize, fr as usize);
                    if !t.is_nodata(v) {
                        data[r * cols + c] = v;
                        break;
                    }
                }
            }
        }
    }
    Raster { w: cols, h: rows, data, nodata: Some(NODATA), x0: w, dx, y0: n, dy, epsg: Some(4326) }
}

pub fn run(config_path: &str, out_dir: &str) -> R<String> {
    let cfg = read_json(config_path)?;
    let out = Path::new(out_dir);
    let tiles_dir = out.join("tiles");
    std::fs::create_dir_all(&tiles_dir).map_err(err)?;
    let bb: Vec<f64> = arr(cfg.get("bbox_lonlat")).iter().filter_map(|v| v.as_f64()).collect();
    let (w, s, e, n) = (bb[0], bb[1], bb[2], bb[3]);
    let pad = 0.02;
    let mut tiles = Vec::new();
    for lat in (s - pad).floor() as i64..=(n + pad).floor() as i64 {
        for lon in (w - pad).floor() as i64..=(e + pad).floor() as i64 {
            let name = tile_name(lat, lon);
            let dest = tiles_dir.join(format!("{}.tif", name));
            println!("tile {}", name);
            if download(&format!("{}/{}/{}.tif", BUCKET, name, name), &dest)? {
                tiles.push(read_geotiff(&std::fs::read(&dest).map_err(err)?).map_err(|e| format!("{}: {}", name, e))?);
            }
        }
    }
    if tiles.is_empty() {
        return Err("No DEM tiles found for this area.".into());
    }
    let src = mosaic(&tiles, w - pad, s - pad, e + pad, n + pad);
    drop(tiles);
    let crs = s_or_empty(cfg.get("crs"));
    let dst = Proj::from_name(&crs).ok_or_else(|| format!("unsupported CRS {}", crs))?;
    let epsg: u32 = crs.trim().to_uppercase().trim_start_matches("EPSG:").parse().map_err(err)?;
    let cell = cfg.get("cell_m").and_then(|v| v.as_f64()).ok_or("no cell_m")?;
    // the box's edges, densified, in the target CRS
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for k in 0..=22 {
        let f = k as f64 / 22.0;
        for (lon, lat) in [(w + (e - w) * f, s), (w + (e - w) * f, n), (w, s + (n - s) * f), (e, s + (n - s) * f)] {
            let (x, y) = dst.from_lonlat(lon, lat);
            minx = minx.min(x);
            maxx = maxx.max(x);
            miny = miny.min(y);
            maxy = maxy.max(y);
        }
    }
    let (minx, miny) = ((minx / cell).floor() * cell, (miny / cell).floor() * cell);
    let (maxx, maxy) = ((maxx / cell).ceil() * cell, (maxy / cell).ceil() * cell);
    let (width, height) = (((maxx - minx) / cell).round() as usize, ((maxy - miny) / cell).round() as usize);
    let mut dem = vec![NODATA as f32; width * height];
    for r in 0..height {
        for c in 0..width {
            let (x, y) = (minx + (c as f64 + 0.5) * cell, maxy - (r as f64 + 0.5) * cell);
            let (lon, lat) = dst.to_lonlat(x, y);
            if let Some(v) = src.bilinear(lon, lat) {
                dem[r * width + c] = v as f32;
            }
        }
    }
    write_geotiff_f32(&out.join("dem.tif"), width, height, &dem, minx, maxy, cell, epsg, NODATA)?;
    let valid: Vec<f32> = dem.iter().copied().filter(|&v| v as f64 != NODATA).collect();
    let lo = valid.iter().cloned().fold(f32::INFINITY, f32::min);
    let hi = valid.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    Ok(format!("dem.tif: {} x {} cells at {} m, elevation {:.1} to {:.1} m", width, height, g_fmt(cell), lo, hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_names() {
        assert_eq!(tile_name(-28, 153), "Copernicus_DSM_COG_10_S28_00_E153_00_DEM");
        assert_eq!(g_fmt(40.0), "40");
        assert_eq!(g_fmt(12.5), "12.5");
    }

    #[test]
    fn mosaic_and_resample_a_plane() {
        // one tile: height = 10 * lon + lat, at 0.001 degrees
        let (w, h) = (200usize, 200usize);
        let data: Vec<f64> = (0..w * h).map(|i| {
            let (c, r) = (i % w, i / w);
            10.0 * (153.0 + (c as f64 + 0.5) * 0.001) + (-27.0 - (r as f64 + 0.5) * 0.001)
        }).collect();
        let t = Raster { w, h, data, nodata: Some(NODATA), x0: 153.0, dx: 0.001, y0: -27.0, dy: 0.001, epsg: Some(4326) };
        let m = mosaic(&[t], 153.02, -27.18, 153.18, -27.02);
        let v = m.bilinear(153.1, -27.1).unwrap();
        assert!((v - (1531.0 - 27.1)).abs() < 1e-6, "{}", v);
    }
}
