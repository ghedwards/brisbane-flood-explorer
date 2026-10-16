//! Workers by place of work for each SA2 (ABS 2021 Census Working
//! Population Profile; was pipeline/fetch_workers.py).
//!
//! Usage: flood workers <out.json>
//!
//! Writes {source, file, table, fetched, workers: {sa2_code: count}}.

use crate::net;
use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::{Map, Value};

const BASE: &str = "https://www.abs.gov.au/census/find-census-data/datapacks/download/";
const NAMES: [&str; 3] = ["2021_WPP_SA2_for_AUS_short-header.zip", "2021_WPP_SA2_for_AUS_long-header.zip", "2021_WPP_all_for_AUS_short-header.zip"];
const BROWSER_UA: &str = "Mozilla/5.0 (compatible; brisbane-flood-explorer; github.com/ghedwards/brisbane-flood-explorer)";

fn download() -> R<(String, Vec<u8>)> {
    let mut why = Vec::new();
    for n in NAMES {
        match net::get(&format!("{}{}", BASE, n), &[("User-Agent", BROWSER_UA)], 300) {
            Ok(r) if r.body.starts_with(b"PK") => return Ok((n.to_string(), r.body)),
            Ok(r) => why.push(format!("{}: not a zip ({:?})", n, String::from_utf8_lossy(&r.body[..r.body.len().min(40)]))),
            Err(e) => why.push(format!("{}: {}", n, clip(&e.to_string(), 80))),
        }
    }
    Err(why.join("; "))
}

/// The column with total persons ('Tot_P', 'Total_Persons' and the like).
pub fn total_column(header: &[String]) -> Option<usize> {
    for pat in [r"(?i)^tot_p$", r"(?i)^total_persons$", r"(?i)^tot.*_p$", r"(?i)^total.*persons?$"] {
        let re = Regex::new(pat).unwrap();
        if let Some(i) = header.iter().position(|h| re.is_match(h.trim())) {
            return Some(i);
        }
    }
    None
}

/// (table file, column, {sa2: workers}) from the DataPack.
pub fn workers_from_zip(body: &[u8]) -> R<(String, String, Map<String, Value>)> {
    let files = unzip(body)?;
    let w01 = Regex::new(r"(?i)w01").unwrap();
    let mut csvs: Vec<&(String, Vec<u8>)> = files.iter().filter(|(n, _)| n.to_lowercase().ends_with(".csv") && n.to_lowercase().contains("sa2")).collect();
    csvs.sort_by_key(|(n, _)| (if w01.is_match(n) { 0 } else { 1 }, n.clone()));
    let sa2 = Regex::new(r"(?i)^sa2_code").unwrap();
    for (name, data) in &csvs {
        let text = String::from_utf8_lossy(data);
        let rows = csv_rows(text.trim_start_matches('\u{feff}'));
        if rows.len() < 100 {
            continue;
        }
        let header = &rows[0];
        let Some(ti) = total_column(header) else { continue };
        let ci = header.iter().position(|h| sa2.is_match(h.trim())).unwrap_or(0);
        let mut out = Map::new();
        for r in &rows[1..] {
            let (Some(code), Some(v)) = (r.get(ci), r.get(ti).and_then(|v| v.trim().parse::<f64>().ok())) else { continue };
            out.insert(code.trim().to_string(), Value::from(v.trunc() as i64));
        }
        if out.len() > 1000 {
            return Ok((name.rsplit('/').next().unwrap_or(name).to_string(), header[ti].clone(), out));
        }
    }
    Err(format!("no SA2 table with a total persons column among {} files", csvs.len()))
}

pub fn run(out_path: &str) -> R<String> {
    let (name, body) = download()?;
    let (table, col, workers) = workers_from_zip(&body)?;
    let total: i64 = workers.values().filter_map(|v| v.as_i64()).sum();
    let n = workers.len();
    write_json(out_path, &obj! {
        "source" => "ABS 2021 Census Working Population Profile (place of work), SA2, CC BY 4.0",
        "file" => name, "table" => format!("{} {}", table, col), "fetched" => now_iso(), "workers" => Value::Object(workers),
    })?;
    Ok(format!("Workers: {} SA2s, {} workers ({} {})", n, thousands(total), table, col))
}

/// 12,345,678
fn thousands(n: i64) -> String {
    let s = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{}", out) } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn datapack() -> Vec<u8> {
        let mut rows = vec!["SA2_CODE_2021,Age_15_19_M,Tot_M,Tot_F,Tot_P".to_string()];
        rows.extend((0..1500).map(|i| format!("{},1,5,6,{}", 100000000 + i, 11 + i)));
        let a = rows.join("\n");
        zip_stored(&[("2021 Census WPP SA2 for AUS/2021Census_W01A_AUS_SA2.csv", a.as_bytes()), ("2021 Census WPP SA2 for AUS/2021Census_W02_AUS_SA2.csv", b"SA2_CODE_2021,X\n1,2")])
    }

    #[test]
    fn reads_totals_per_sa2() {
        let (table, col, w) = workers_from_zip(&datapack()).unwrap();
        assert_eq!(col, "Tot_P");
        assert_eq!(w.len(), 1500);
        assert_eq!(w["100000000"], 11);
        assert!(table.contains("W01A"));
        assert_eq!(thousands(12034567), "12,034,567");
    }

    #[test]
    fn total_column_patterns() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(total_column(&s(&["SA2", "Tot_M", "Tot_P"])), Some(2));
        assert_eq!(total_column(&s(&["SA2", "Total_Persons"])), Some(1));
        assert_eq!(total_column(&s(&["SA2", "Males"])), None);
    }
}
