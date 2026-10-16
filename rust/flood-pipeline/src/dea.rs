//! Australia-wide image of DEA's "water seen by satellite since 1987" layer
//! (was pipeline/render_dea_mosaic.py).
//!
//! Usage: flood dea <out_dir>
//!
//! DEA's map server only draws the layer from about zoom 7. This fetches it
//! at the coarsest zoom it allows as Web Mercator tiles, stitches them into
//! one image (halved if it had to use zoom 8), reduces it to 96 colours and
//! writes water_frequency.png plus dea.json with its bounds.

use crate::geo::{decode_png_rgba, merc_to_lonlat, quantize, write_png_indexed};
use crate::net;
use crate::obj;
use crate::util::*;
use std::f64::consts::PI;
use std::path::Path;
use std::sync::Mutex;

const OWS: &str = "https://ows.dea.ga.gov.au/";
const LAYER: &str = "ga_ls_wo_fq_myear_3";
const STYLE: &str = "mysummary_wofs_frequency_3";
const AUS: (f64, f64, f64, f64) = (112.0, -44.0, 154.0, -9.0);
const HALF: f64 = PI * 6378137.0;
const FILL: (i32, i32, i32) = (150, 180, 200); // DEA's "zoomed out too far" colour

pub fn tile_range(z: u32) -> (i64, i64, i64, i64) {
    let n = 2f64.powi(z as i32);
    let tx = |lon: f64| ((lon + 180.0) / 360.0 * n) as i64;
    let ty = |lat: f64| {
        let r = lat.to_radians();
        ((1.0 - (r.tan() + 1.0 / r.cos()).ln() / PI) / 2.0 * n) as i64
    };
    (tx(AUS.0), tx(AUS.2), ty(AUS.3), ty(AUS.1))
}

pub fn tile_bbox(x: i64, y: i64, z: u32) -> (f64, f64, f64, f64) {
    let size = 2.0 * HALF / 2f64.powi(z as i32);
    let minx = -HALF + x as f64 * size;
    let maxy = HALF - y as f64 * size;
    (minx, maxy - size, minx + size, maxy)
}

/// An RGBA tile.
type Tile = (usize, usize, Vec<u8>);

fn fetch(x: i64, y: i64, z: u32) -> R<Tile> {
    let b = tile_bbox(x, y, z);
    let bbox = format!("{:.3},{:.3},{:.3},{:.3}", b.0, b.1, b.2, b.3);
    let q = net::urlencode(&[("service", "WMS"), ("version", "1.3.0"), ("request", "GetMap"), ("layers", LAYER), ("styles", STYLE), ("crs", "EPSG:3857"),
        ("bbox", bbox.as_str()), ("width", "256"), ("height", "256"), ("format", "image/png"), ("transparent", "true")]);
    let mut last = String::new();
    for attempt in 0..3u64 {
        match net::get(&format!("{}?{}", OWS, q), &[], 60).map_err(|e| e.to_string()).and_then(|r| decode_png_rgba(&r.body)) {
            Ok(t) => return Ok(t),
            Err(e) => last = e,
        }
        std::thread::sleep(std::time::Duration::from_secs(3 * (attempt + 1)));
    }
    Err(format!("tile {}/{}/{}: {}", z, x, y, last))
}

/// True if DEA returned its 'zoom in' fill instead of data.
pub fn is_fill(rgba: &[u8]) -> bool {
    let px = rgba.len() / 4;
    let n = rgba.chunks(4).filter(|p| p[3] != 0 && (p[0] as i32 - FILL.0).abs() < 4 && (p[1] as i32 - FILL.1).abs() < 4 && (p[2] as i32 - FILL.2).abs() < 4).count();
    n as f64 > px as f64 * 0.9
}

/// Halve an RGBA image (2x2 averages, colour weighted by alpha).
fn halve(w: usize, h: usize, px: &[u8]) -> (usize, usize, Vec<u8>) {
    let (w2, h2) = (w / 2, h / 2);
    let mut out = vec![0u8; w2 * h2 * 4];
    for y in 0..h2 {
        for x in 0..w2 {
            let (mut c, mut a) = ([0f64; 3], 0f64);
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let i = ((2 * y + dy) * w + 2 * x + dx) * 4;
                let al = px[i + 3] as f64;
                for k in 0..3 {
                    c[k] += px[i + k] as f64 * al;
                }
                a += al;
            }
            let o = (y * w2 + x) * 4;
            if a > 0.0 {
                for k in 0..3 {
                    out[o + k] = (c[k] / a).round() as u8;
                }
            }
            out[o + 3] = (a / 4.0).round() as u8;
        }
    }
    (w2, h2, out)
}

pub fn run(out_dir: &str) -> R<String> {
    let out = Path::new(out_dir);
    std::fs::create_dir_all(out).map_err(err)?;
    // coarsest zoom the server will draw: 7, else 8 (then halve the size)
    let mut chosen = None;
    for z in [7u32, 8] {
        let (x0, x1, y0, y1) = tile_range(z);
        let probe = fetch((x0 + x1) / 2, (y0 + y1) / 2, z)?; // a tile over inland Australia
        if !is_fill(&probe.2) {
            chosen = Some((z, x0, x1, y0, y1));
            break;
        }
    }
    let (z, x0, x1, y0, y1) = chosen.ok_or("DEA would not draw the layer at zoom 7 or 8")?;
    let (cols, rows) = ((x1 - x0 + 1) as usize, (y1 - y0 + 1) as usize);
    let (mw, mh) = (cols * 256, rows * 256);
    let mosaic = Mutex::new(vec![0u8; mw * mh * 4]);
    let errors = Mutex::new(Vec::new());
    let jobs = Mutex::new((x0..=x1).flat_map(|x| (y0..=y1).map(move |y| (x, y))).collect::<Vec<_>>());
    std::thread::scope(|s| {
        for _ in 0..6 {
            s.spawn(|| loop {
                let Some((x, y)) = jobs.lock().unwrap().pop() else { return };
                match fetch(x, y, z) {
                    Ok((w, h, px)) if !is_fill(&px) => {
                        let mut m = mosaic.lock().unwrap();
                        let (ox, oy) = ((x - x0) as usize * 256, (y - y0) as usize * 256);
                        for r in 0..h.min(256) {
                            let src = &px[r * w * 4..(r * w + w.min(256)) * 4];
                            let d = ((oy + r) * mw + ox) * 4;
                            m[d..d + src.len()].copy_from_slice(src);
                        }
                    }
                    Ok(_) => {}
                    Err(e) => errors.lock().unwrap().push(e),
                }
            });
        }
    });
    let mut log: Vec<String> = errors.lock().unwrap().iter().map(|e| format!("warning: {}", e)).collect();
    let n_err = log.len();
    let (mut w, mut h, mut px) = (mw, mh, mosaic.into_inner().unwrap());
    if z == 8 {
        (w, h, px) = halve(w, h, &px);
    }
    let (idx, palette, alpha) = quantize(&px, 96);
    let path = out.join("water_frequency.png");
    write_png_indexed(&path, w, h, &idx, &palette, &alpha)?;
    let (minx, _, _, maxy) = tile_bbox(x0, y0, z);
    let (_, miny, maxx, _) = tile_bbox(x1, y1, z);
    let (wl, s) = merc_to_lonlat(minx, miny);
    let (e, n) = merc_to_lonlat(maxx, maxy);
    write_json_indent(out.join("dea.json"), &obj! {"generated" => today(), "zoom" => z,
        "water_frequency" => obj! {"file" => "water_frequency.png", "bounds" => vec![num(wl), num(s), num(e), num(n)]}, "tileErrors" => n_err}, 1)?;
    let kb = std::fs::metadata(&path).map(|m| m.len() / 1024).unwrap_or(0);
    log.push(format!("DEA mosaic: zoom {}, {}x{} tiles -> {}x{} px, {} KB, {} tile errors", z, cols, rows, w, h, kb, n_err));
    Ok(log.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_range_covers_australia() {
        let (x0, x1, y0, y1) = tile_range(7);
        assert_eq!((x0, x1), (103, 118));
        assert!(y0 < y1);
        let b0 = tile_bbox(x0, y1, 7);
        let b1 = tile_bbox(x1, y0, 7);
        let (w, s) = merc_to_lonlat(b0.0, b0.1);
        let (e, n) = merc_to_lonlat(b1.2, b1.3);
        assert!(w <= 112.0 && e >= 154.0 && s <= -44.0 && n >= -9.0);
    }

    #[test]
    fn fill_detection() {
        assert!(is_fill(&[150, 180, 200, 160].repeat(64)));
        assert!(!is_fill(&[0, 0, 0, 0].repeat(64)));
        assert_eq!(halve(2, 2, &[255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]).2, vec![255, 0, 0, 128]);
    }
}
