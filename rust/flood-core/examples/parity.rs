//! Prints checksums of model runs on fixed inputs; tests/parity.js prints
//! the same from the JavaScript model and compares them.
use flood_core::*;

fn out(k: &str, v: &[f64]) {
    let s: Vec<String> = v.iter().map(|x| if x.is_finite() { format!("{:e}", x) } else { "NaN".into() }).collect();
    println!("{} {}", k, s.join(" "));
}
fn run_sum(r: &Run) -> Vec<f64> {
    let (mut wet, mut d, mut ws, mut lv) = (0.0, 0.0, 0.0, 0.0);
    for c in 0..r.wet.len() {
        if r.wet[c] != 0 { wet += 1.0; d += r.depth[c] as f64; }
        if r.wse[c].is_finite() { ws += r.wse[c]; }
        if r.level[c].is_finite() { lv += r.level[c] as f64; }
    }
    vec![wet, d, ws, lv]
}
fn fsum(v: &[f64]) -> f64 { v.iter().filter(|x| x.is_finite()).sum() }
fn valley() -> Grid {
    let (w, h) = (60usize, 21usize);
    let mut dem = vec![0f32; w * h];
    for y in 0..h { for x in 0..w { dem[y * w + x] = (2.0 + 0.01 * (w - x) as f64 + (y as f64 - 10.0).abs() * 0.2) as f32; } }
    Grid { w, h, cell: 10.0, dem, valid: None, inflow: None, d8: None }
}

fn main() {
    let grid = sample_terrain();
    let a = analyse(&grid, 4.0);
    let g = a.default_gauge as usize;
    let mut rh = 0.0;
    for c in 0..a.n { rh += ((a.rec[c] + 1) as f64) * ((c % 97) as f64 + 1.0); }
    out("analysis", &[a.main_outlet as f64, a.default_gauge as f64, a.n_order as f64, fsum(&a.chain), a.acc.iter().sum(), a.stream.iter().map(|&x| x as f64).sum(), rh, fsum(&a.filled.clone().unwrap())]);
    let sc = |level: f64, bay: f64| Scenario { gauge: a.default_gauge, gauge_level: level, bay_level: bay, upstream_gradient: 0.3, ..Default::default() };
    let base = inundate(&a, &sc(0.5, 0.0));
    for l in [2.3, 3.85, 4.46, 5.45, 8.35] {
        let r = inundate(&a, &sc(l, 1.0));
        out(&format!("inundate{}", l), &run_sum(&r));
        let s = stats(&a, &r, Some(&base));
        out(&format!("stats{}", l), &[s.wet_land_km2, s.flooded_km2, s.deep_km2, s.max_depth, s.raw_max_depth, s.mean_depth]);
    }
    let mut path = Vec::new();
    let mut c = g as i64;
    while c >= 0 { path.push(c); c = a.rec[c as usize] as i64; }
    let mid = path[path.len() / 2];
    let mut s = sc(4.0, 1.0);
    s.controls = vec![(mid, 3.5)];
    out("controls", &run_sum(&inundate(&a, &s)));
    let mut s = sc(4.0, 1.0);
    s.gates = vec![path[path.len() / 3]];
    out("gates", &run_sum(&inundate(&a, &s)));
    let codes = encode_whitebox_d8(&a);
    let mut g2 = grid.clone();
    g2.d8 = Some(codes.clone());
    let b = analyse(&g2, 4.0);
    out("pointers", &[codes.iter().map(|&x| x as f64).sum(), b.rec.iter().map(|&x| x as f64).sum()]);
    for (name, st) in [
        ("flash40", Storm { rain_mm: 40.0, ..Default::default() }),
        ("flash200", Storm { rain_mm: 200.0, hours: 3.0, ..Default::default() }),
        ("flashpipe", Storm { rain_mm: 60.0, initial_loss: 3.0, cont_loss: 0.5, pipe_mm_h: 40.0, urban: Some(vec![1u8; a.n]), ..Default::default() }),
    ] {
        let r = flash_flood(&a, &st);
        let m = r.summary.clone().unwrap();
        let mut v = run_sum(&r);
        v.extend([m.excess_mm, m.runoff_coeff, m.creek_km2, m.overland_km2, m.pond_km2, m.max_creek_rise, m.piped_mm, m.urban_km2]);
        out(name, &v);
    }
    let big = inundate(&a, &sc(a.dem[g] as f64 + 4.0, 1.0));
    let small = inundate(&a, &sc(a.dem[g] as f64 + 2.0, 1.0));
    let hz = hazard(&a, &big);
    let mut v = hz.km2.to_vec();
    v.push(hz.vel.iter().map(|&x| x as f64).sum());
    out("hazard", &v);
    let cm = compare_runs(&a, &big, &small);
    out("compare", &[cm.both_km2, cm.only_now_km2, cm.only_pinned_km2, cm.deeper_km2, cm.shallower_km2, cm.d_depth.iter().map(|&x| x as f64).sum()]);
    out("uplift", &[storm_uplift(1.0, 1.0), storm_uplift(6.0, 2.0), storm_uplift(24.0, 1.5)]);
    // flood over time
    let dg = a.dem[g] as f64;
    let wsum = |w: &Wave, t: f64| { let mut o = vec![f64::NAN; a.n]; wave_surface(w, t, &mut o); fsum(&o) };
    let o = WaveOpts { base_level: dg + 0.3, rise_hours: 12.0, fall_hours: 24.0, speed_kmh: 2.0, route: true, ..Default::default() };
    let s4 = sc(dg + 4.0, 0.5);
    let w = wave_setup(&a, &s4, &o);
    let r = w.routed.as_ref().unwrap();
    let pk = r.peak_at(r.flows.len() - 1);
    out("routed", &[r.flows.len() as f64, pk.0, pk.1, r.flows.last().unwrap().q.iter().sum(), r.t0, r.dt, r.n_t as f64, r.tributaries as f64, r.extra_hours, wsum(&w, w.t_peak), wsum(&w, w.t_peak + 7.3)]);
    let mut o2 = o.clone();
    o2.rating = Some((2.4, 1.5));
    let w = wave_setup(&a, &s4, &o2);
    out("rated", &[wsum(&w, w.t_peak), wsum(&w, w.t_peak - 6.0), w.routed.as_ref().unwrap().exponent]);
    let s3 = sc(dg + 3.0, 1.2);
    let ot = WaveOpts { base_level: dg + 0.3, rise_hours: 12.0, fall_hours: 24.0, speed_kmh: 3.0, tide: Some((0.8, false)), ..Default::default() };
    let tl = flood_timeline(&a, &s3, &ot);
    let mut v: Vec<f64> = vec![tl.t0, tl.step, tl.steps as f64, tl.first_wet.iter().map(|&x| x as f64).sum(), tl.last_deep.iter().map(|&x| x as f64).sum(), tl.wet_bits.iter().map(|&x| x.count_ones() as f64).sum(), tl.deep_bits.iter().map(|&x| x.count_ones() as f64).sum()];
    v.extend(tl.wet_count.iter().map(|&x| x as f64));
    out("tidetimeline", &v);
    let mut u = g;
    for _ in 0..400 {
        let mut best: i64 = -1;
        for c in 0..a.n { if a.rec[c] == u as i32 && a.stream[c] != 0 && (best < 0 || a.acc[c] > a.acc[best as usize]) { best = c as i64; } }
        if best < 0 || a.chain[best as usize] - a.chain[g] > 15000.0 { break; }
        u = best as usize;
    }
    let hydro: Series = vec![(0.0, 1.0), (10.0, 5.0), (20.0, 2.0), (40.0, 1.0)];
    let up: Series = vec![(0.0, 2.0), (4.0, 8.0), (14.0, 3.0), (40.0, 2.0)];
    let w = wave_setup(&a, &s4, &WaveOpts { hydro: Some(hydro.clone()), speed_kmh: 3.0, others: vec![(u as i64, up.clone())], ..Default::default() });
    out("upper", &[wsum(&w, 4.0), wsum(&w, 10.0), wsum(&w, 17.5), w.up.as_ref().unwrap().gauges as f64]);
    let mut dn = g;
    while a.rec[dn] >= 0 && a.chain[g] - a.chain[dn] < 6000.0 { dn = a.rec[dn] as usize; }
    let w = wave_setup(&a, &s4, &WaveOpts { hydro: Some(hydro.clone()), speed_kmh: 3.0, route: true, others: vec![(dn as i64, up.clone())], ..Default::default() });
    out("lower", &[wsum(&w, 4.0), wsum(&w, 10.0), wsum(&w, 17.5), w.up.as_ref().unwrap().below as f64]);
    let sea: Series = vec![(0.0, 0.1), (6.0, 1.4), (12.0, -0.6), (18.0, 1.6), (30.0, 0.0)];
    let os = WaveOpts { hydro: Some(vec![(0.0, 1.0), (10.0, 5.0), (30.0, 1.0)]), speed_kmh: 3.0, sea: Some(sea), flatten: 2.0, ..Default::default() };
    let s02 = sc(dg + 3.0, 0.2);
    let w = wave_setup(&a, &s02, &os);
    out("sea", &[w.bay_at(9.0), w.at(6, 12.0), w.at(3, 7.5), wsum(&w, 11.0)]);
    let tl = flood_timeline(&a, &s02, &os);
    let mut v = vec![tl.t0, tl.step, tl.steps as f64, tl.first_deep.iter().map(|&x| x as f64).sum()];
    v.extend(tl.wet_count.iter().map(|&x| x as f64));
    out("seatimeline", &v);
    let orl = WaveOpts { base_level: dg + 0.3, rise_hours: 12.0, fall_hours: 24.0, speed_kmh: 3.0, release: Some((20.0, 30.0, 0.3)), ..Default::default() };
    let w = wave_setup(&a, &sc(dg + 3.0, 0.5), &orl);
    let ri = w.release_info.unwrap();
    out("release", &[w.gauge_at(10.0), w.gauge_at(30.0), w.gauge_at(60.0), ri.1, ri.2, w.t_start, w.t_end]);
    // the valley: levees, gates, timeline
    let vg = valley();
    let wv = vg.w;
    let lc: Vec<i64> = line_cells(&[(0.0, 13.0), (59.0, 13.0)], wv, vg.h).iter().map(|&x| x as i64).collect();
    let mut mask = vec![0u8; wv * vg.h];
    for &c in &lc { mask[c as usize] = 1; }
    for (name, lv) in [
        ("leveehigh", Levee { cells: lc.clone(), height: Some(3.0), ..Default::default() }),
        ("leveefailed", Levee { cells: lc.clone(), height: Some(3.0), failed: true, ..Default::default() }),
        ("leveebreach", Levee { cells: lc.clone(), height: Some(3.0), breaches: vec![13 * wv as i64 + 30], ..Default::default() }),
        ("leveelow", Levee { cells: lc.clone(), height: Some(0.3), ..Default::default() }),
        ("leveeterrain", Levee { cells: lc.clone(), height: None, ..Default::default() }),
    ] {
        let mut gg = vg.clone();
        gg.dem = burn_defences(&vg, &[lv]);
        let av = analyse(&gg, 0.001);
        let gauge = 10 * wv + 55;
        let r = inundate(&av, &Scenario { gauge: gauge as i32, gauge_level: vg.dem[gauge] as f64 + 1.5, bay_level: 0.0, upstream_gradient: 0.0, levee: Some(mask.clone()), ..Default::default() });
        let mut v = run_sum(&r);
        v.push(gg.dem.iter().map(|&x| x as f64).sum());
        out(name, &v);
    }
    let av = analyse(&vg, 0.001);
    let gauge = 10 * wv + 50;
    let s = Scenario { gauge: gauge as i32, gauge_level: vg.dem[gauge] as f64 + 1.5, bay_level: 0.0, upstream_gradient: 0.0, ..Default::default() };
    let tl = flood_timeline(&av, &s, &WaveOpts { base_level: vg.dem[gauge] as f64 + 0.1, rise_hours: 6.0, fall_hours: 12.0, speed_kmh: 0.1, ..Default::default() });
    let mut v = vec![tl.t0, tl.step, tl.steps as f64, tl.first_wet.iter().map(|&x| x as f64).sum(), tl.gauge.iter().map(|&x| x as f64).sum()];
    v.extend(tl.wet_count.iter().map(|&x| x as f64));
    out("valleytimeline", &v);
    // parsers
    let ag = parse_ascii_grid("ncols 3\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 25\nNODATA_value -9999\n1 2 3\n4 -9999 6\n").unwrap();
    out("ascii", &[ag.w as f64, ag.h as f64, ag.cell, ag.dem.iter().map(|&x| x as f64).filter(|x| x.is_finite()).sum()]);
    let ds = downsample(&grid, 100);
    out("downsample", &[ds.w as f64, ds.h as f64, ds.cell, ds.dem.iter().map(|&x| x as f64).sum()]);
}
