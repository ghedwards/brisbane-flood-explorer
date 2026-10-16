use flood_core::*;
use std::time::Instant;
fn main() {
    let g = synthetic_terrain(1200, 900, 25.0, 1974);
    let t = Instant::now();
    let a = analyse(&g, 4.0);
    let ta = t.elapsed().as_millis();
    let s = Scenario { gauge: a.default_gauge, gauge_level: a.dem[a.default_gauge as usize] as f64 + 4.0, bay_level: 1.0, upstream_gradient: 0.3, ..Default::default() };
    let t = Instant::now();
    for _ in 0..5 { inundate(&a, &s); }
    println!("analyse {} ms, inundate {} ms", ta, t.elapsed().as_millis() / 5);
}
