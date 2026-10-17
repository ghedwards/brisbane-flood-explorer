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
    if dest.metadata().is_ok_and(|m| m.len() > 0) {
        return Ok(true);
    }
    // Large DEM tiles get a ten-minute transfer budget with ureq 3.
    match net::get(url, &[], 600) {
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

/// The tiles as one seamless grid of source pixels (they share a pixel
/// grid at these latitudes), sampled like GDAL's bilinear warp: a tent
/// filter that widens to the output cell when resampling to coarser cells.
pub struct Tiles {
    tiles: Vec<Raster>,
    x0: f64,
    y0: f64,
    dx: f64,
    dy: f64,
}

impl Tiles {
    pub fn new(tiles: Vec<Raster>) -> Tiles {
        let (x0, y0, dx, dy) = (tiles[0].x0, tiles[0].y0, tiles[0].dx, tiles[0].dy);
        Tiles { tiles, x0, y0, dx, dy }
    }

    /// The value of global source pixel (column, row), if any tile has data there.
    fn get(&self, gc: i64, gr: i64) -> Option<f64> {
        let (x, y) = (self.x0 + (gc as f64 + 0.5) * self.dx, self.y0 - (gr as f64 + 0.5) * self.dy);
        for t in &self.tiles {
            let (fc, fr) = ((x - t.x0) / t.dx, (t.y0 - y) / t.dy);
            if fc >= 0.0 && fr >= 0.0 && (fc as usize) < t.w && (fr as usize) < t.h {
                let v = t.get(fc as usize, fr as usize);
                return if t.is_nodata(v) { None } else { Some(v) };
            }
        }
        None
    }

    /// Sample at (lon, lat); `sx`, `sy`: output cell size in source pixels.
    pub fn sample(&self, lon: f64, lat: f64, sx: f64, sy: f64) -> Option<f64> {
        let fx = (lon - self.x0) / self.dx - 0.5;
        let fy = (self.y0 - lat) / self.dy - 0.5;
        let (rx, ry) = (sx.max(1.0), sy.max(1.0));
        let (mut sum, mut wsum) = (0.0, 0.0);
        for gr in (fy - ry).ceil() as i64..=(fy + ry).floor() as i64 {
            let wy = 1.0 - (gr as f64 - fy).abs() / ry;
            if wy <= 0.0 {
                continue;
            }
            for gc in (fx - rx).ceil() as i64..=(fx + rx).floor() as i64 {
                let wx = 1.0 - (gc as f64 - fx).abs() / rx;
                if wx <= 0.0 {
                    continue;
                }
                if let Some(v) = self.get(gc, gr) {
                    sum += wx * wy * v;
                    wsum += wx * wy;
                }
            }
        }
        if wsum > 0.0 { Some(sum / wsum) } else { None }
    }
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
    for t in &tiles {
        println!("tile georef: x0 {} y0 {} dx {} dy {} size {}x{}", t.x0, t.y0, t.dx, t.dy, t.w, t.h);
    }
    let mut src = Tiles::new(tiles);
    // diagnostic: FLOOD_DEM_SHIFT="dx,dy" moves the tiles by fractions of a
    // pixel (to measure an offset against another resampler)
    if let Ok(v) = std::env::var("FLOOD_DEM_SHIFT") {
        let p: Vec<f64> = v.split(',').filter_map(|x| x.trim().parse().ok()).collect();
        if p.len() == 2 {
            src.x0 += p[0] * src.dx;
            src.y0 -= p[1] * src.dy;
        }
    }
    let crs = s_or_empty(cfg.get("crs"));
    let dst = Proj::from_name(&crs).ok_or_else(|| format!("unsupported CRS {}", crs))?;
    let epsg: u32 = crs.trim().to_uppercase().trim_start_matches("EPSG:").parse().map_err(err)?;
    let cell = cfg.get("cell_m").and_then(|v| v.as_f64()).ok_or("no cell_m")?;
    // Optional vertical datum shift (e.g. EGM2008 -> AHD). Defaults to 0.
    let offset = cfg.get("geoid_offset_m").and_then(|v| v.as_f64()).unwrap_or(0.0);
    // the box's edges, densified, in the target CRS
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for k in 0..=22 {
        let f = k as f64 / 22.0;
        for (lon, lat) in [(w + (e - w) * f, s), (w + (e - w) * f, n), (w, s + (n - s) * f), (e, s + (n - s) * f)] {
            let (x, y) = dst.project_lonlat(lon, lat);
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
    // the output cell in source pixels, at the middle of the area
    let mid = (s + n) / 2.0;
    let sx = cell / (src.dx * 111320.0 * mid.to_radians().cos());
    let sy = cell / (src.dy * 110574.0);
    for r in 0..height {
        for c in 0..width {
            let (x, y) = (minx + (c as f64 + 0.5) * cell, maxy - (r as f64 + 0.5) * cell);
            let (lon, lat) = dst.to_lonlat(x, y);
            if let Some(v) = src.sample(lon, lat, sx, sy) {
                dem[r * width + c] = (v + offset) as f32;
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
    fn samples_a_plane_across_tiles() {
        // two tiles side by side: height = 10 * lon + lat, at 0.001 degrees
        let tile = |lon0: f64| {
            let (w, h) = (100usize, 100usize);
            let data: Vec<f64> = (0..w * h).map(|i| {
                let (c, r) = (i % w, i / w);
                10.0 * (lon0 + (c as f64 + 0.5) * 0.001) + (-27.0 - (r as f64 + 0.5) * 0.001)
            }).collect();
            Raster { w, h, data, nodata: Some(NODATA), x0: lon0, dx: 0.001, y0: -27.0, dy: 0.001, epsg: Some(4326) }
        };
        let t = Tiles::new(vec![tile(153.0), tile(153.1)]);
        // a plane is reproduced exactly, even straddling the tile edge and with a wide filter
        for (lon, sx) in [(153.05, 1.0), (153.1, 1.0), (153.1003, 1.6)] {
            let v = t.sample(lon, -27.05, sx, 1.3).unwrap();
            assert!((v - (10.0 * lon - 27.05)).abs() < if sx > 1.0 { 1e-3 } else { 1e-9 }, "{} {}", lon, v);
        }
        assert!(t.sample(152.0, -27.05, 1.0, 1.0).is_none());
    }
}
