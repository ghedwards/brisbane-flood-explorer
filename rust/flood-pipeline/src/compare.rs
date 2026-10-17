//! Exact regression comparison for the six hydrology GeoTIFFs.
//! Compression and TIFF layout may differ; pixels, types and geospatial tags may not.

use crate::util::*;
use std::io::Cursor;
use std::path::Path;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

const RASTERS: [&str; 6] = ["dem_breached", "dem_cond", "d8", "acc", "streams", "hand"];
const TAGS: [Tag; 10] = [
    Tag::BitsPerSample, Tag::SampleFormat, Tag::SamplesPerPixel,
    Tag::ModelPixelScaleTag, Tag::ModelTiepointTag, Tag::ModelTransformationTag,
    Tag::GeoKeyDirectoryTag, Tag::GeoDoubleParamsTag, Tag::GeoAsciiParamsTag, Tag::GdalNodata,
];

fn identical(a: &DecodingResult, b: &DecodingResult) -> Option<(usize, usize)> {
    macro_rules! count {
        ($a:expr, $b:expr, $same:expr) => {{
            if $a.len() != $b.len() { return None; }
            Some(($a.iter().zip($b).filter($same).count(), $a.len()))
        }};
    }
    match (a, b) {
        (DecodingResult::U8(a), DecodingResult::U8(b)) => count!(a, b, |(x, y)| x == y),
        (DecodingResult::U16(a), DecodingResult::U16(b)) => count!(a, b, |(x, y)| x == y),
        (DecodingResult::U32(a), DecodingResult::U32(b)) => count!(a, b, |(x, y)| x == y),
        (DecodingResult::U64(a), DecodingResult::U64(b)) => count!(a, b, |(x, y)| x == y),
        (DecodingResult::I8(a), DecodingResult::I8(b)) => count!(a, b, |(x, y)| x == y),
        (DecodingResult::I16(a), DecodingResult::I16(b)) => count!(a, b, |(x, y)| x == y),
        (DecodingResult::I32(a), DecodingResult::I32(b)) => count!(a, b, |(x, y)| x == y),
        (DecodingResult::I64(a), DecodingResult::I64(b)) => count!(a, b, |(x, y)| x == y),
        (DecodingResult::F32(a), DecodingResult::F32(b)) => count!(a, b, |(x, y)| x == y || (x.is_nan() && y.is_nan())),
        (DecodingResult::F64(a), DecodingResult::F64(b)) => count!(a, b, |(x, y)| x == y || (x.is_nan() && y.is_nan())),
        _ => None,
    }
}

fn compare(a: &[u8], b: &[u8]) -> R<String> {
    let mut a = Decoder::new(Cursor::new(a)).map_err(err)?;
    let mut b = Decoder::new(Cursor::new(b)).map_err(err)?;
    if a.dimensions().map_err(err)? != b.dimensions().map_err(err)? {
        return Err("raster dimensions differ".into());
    }
    for tag in TAGS {
        // Compare every georeferencing tag, including transforms and custom CRS
        // parameters, rather than reducing CRS to an EPSG number.
        if a.find_tag(tag).map_err(err)? != b.find_tag(tag).map_err(err)? {
            return Err(format!("metadata differs: {:?}", tag));
        }
    }
    let a = a.read_image().map_err(err)?;
    let b = b.read_image().map_err(err)?;
    match identical(&a, &b) {
        Some((same, total)) if same == total => Ok(format!("{} of {} samples identical; grid, CRS, nodata and dtype match", same, total)),
        Some((same, total)) => Err(format!("only {} of {} samples identical", same, total)),
        None => Err("sample types or counts differ".into()),
    }
}

pub fn run(left: &str, right: &str) -> R<String> {
    let mut failures = Vec::new();
    for name in RASTERS {
        let result = (|| {
            let a = std::fs::read(Path::new(left).join(format!("{}.tif", name))).map_err(err)?;
            let b = std::fs::read(Path::new(right).join(format!("{}.tif", name))).map_err(err)?;
            compare(&a, &b)
        })();
        match result {
            Ok(message) => println!("::notice::{}: {}", name, message),
            Err(message) => {
                println!("::error::{}: {}", name, message);
                failures.push(name);
            }
        }
    }
    if failures.is_empty() { Ok("All six hydrology rasters match".into()) }
    else { Err(format!("Raster comparison failed: {}", failures.join(", "))) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiff::encoder::{colortype, TiffEncoder};

    fn fixture(values: &[f32], width: u32, epsg: u16, x: f64, nodata: &str) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut encoder = TiffEncoder::new(&mut bytes).unwrap();
            let mut image = encoder.new_image::<colortype::Gray32Float>(width, values.len() as u32 / width).unwrap();
            image.encoder().write_tag(Tag::ModelPixelScaleTag, &[40.0, 40.0, 0.0][..]).unwrap();
            image.encoder().write_tag(Tag::ModelTiepointTag, &[0.0, 0.0, 0.0, x, 7000000.0, 0.0][..]).unwrap();
            image.encoder().write_tag(Tag::GeoKeyDirectoryTag, &[1u16, 1, 0, 1, 3072, 0, 1, epsg][..]).unwrap();
            image.encoder().write_tag(Tag::GdalNodata, nodata).unwrap();
            image.write_data(values).unwrap();
        }
        bytes.into_inner()
    }

    #[test]
    fn detects_pixel_grid_crs_and_nodata_changes() {
        let a = fixture(&[1.0, 2.0], 2, 7856, 500000.0, "-9999");
        assert!(compare(&a, &a).is_ok());
        for b in [
            fixture(&[1.0, 3.0], 2, 7856, 500000.0, "-9999"),
            fixture(&[1.0, 2.0], 1, 7856, 500000.0, "-9999"),
            fixture(&[1.0, 2.0], 2, 7855, 500000.0, "-9999"),
            fixture(&[1.0, 2.0], 2, 7856, 500040.0, "-9999"),
            fixture(&[1.0, 2.0], 2, 7856, 500000.0, "-32768"),
        ] { assert!(compare(&a, &b).is_err()); }
    }

    #[test]
    fn preserves_nan_equality_and_exact_integer_types() {
        assert_eq!(identical(&DecodingResult::F64(vec![f64::NAN, f64::INFINITY]), &DecodingResult::F64(vec![f64::NAN, f64::INFINITY])), Some((2, 2)));
        assert_eq!(identical(&DecodingResult::U64(vec![u64::MAX]), &DecodingResult::U64(vec![u64::MAX - 1])), Some((0, 1)));
        assert_eq!(identical(&DecodingResult::U16(vec![1]), &DecodingResult::I16(vec![1])), None);
        assert!(run("/nonexistent/flood-left", "/nonexistent/flood-right").is_err());
    }
}
