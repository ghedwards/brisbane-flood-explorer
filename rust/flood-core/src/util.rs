//! Small helpers shared by the model, written to behave exactly like the
//! JavaScript model they replace (rounding, heap tie-breaking, noise).

/// 8-neighbour offsets; the first four are the 4-neighbours.
pub const DX: [i64; 8] = [1, -1, 0, 0, 1, 1, -1, -1];
pub const DY: [i64; 8] = [0, 0, 1, -1, 1, -1, 1, -1];
pub const SQRT2: f64 = std::f64::consts::SQRT_2;
pub const DD: [f64; 8] = [1.0, 1.0, 1.0, 1.0, SQRT2, SQRT2, SQRT2, SQRT2];

/// JavaScript's Math.round: halves round towards +infinity.
#[inline]
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// JavaScript's `v || d` for numbers: 0 and NaN fall back to the default.
#[inline]
pub fn or(v: f64, d: f64) -> f64 {
    if v == 0.0 || v.is_nan() {
        d
    } else {
        v
    }
}

/// JavaScript's `v ?? d` for numbers passed through the interface, where a
/// missing value arrives as NaN.
#[inline]
pub fn nullish(v: f64, d: f64) -> f64 {
    if v.is_nan() {
        d
    } else {
        v
    }
}

/// Maximum of a slice the way Math.max(...a) does (-inf when empty; NaN wins).
pub fn js_max(v: impl IntoIterator<Item = f64>) -> f64 {
    let mut m = f64::NEG_INFINITY;
    for x in v {
        if x.is_nan() {
            return f64::NAN;
        }
        if x > m {
            m = x;
        }
    }
    m
}

/// Minimum of a slice the way Math.min(...a) does (+inf when empty; NaN wins).
pub fn js_min(v: impl IntoIterator<Item = f64>) -> f64 {
    let mut m = f64::INFINITY;
    for x in v {
        if x.is_nan() {
            return f64::NAN;
        }
        if x < m {
            m = x;
        }
    }
    m
}

/// Math.max(a, b) with JavaScript's NaN rule.
#[inline]
pub fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// Math.min(a, b) with JavaScript's NaN rule.
#[inline]
pub fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// Binary min-heap keyed by f64, with the same sift rules (and so the same
/// order for equal keys) as the JavaScript MinHeap.
pub struct MinHeap {
    k: Vec<f64>,
    v: Vec<i32>,
    pub n: usize,
}

impl MinHeap {
    pub fn new(cap: usize) -> Self {
        MinHeap { k: vec![0.0; cap.max(1)], v: vec![0; cap.max(1)], n: 0 }
    }

    pub fn push(&mut self, key: f64, val: i32) {
        if self.n >= self.k.len() {
            let cap = self.k.len() * 2;
            self.k.resize(cap, 0.0);
            self.v.resize(cap, 0);
        }
        let mut i = self.n;
        self.n += 1;
        while i > 0 {
            let p = (i - 1) >> 1;
            if self.k[p] <= key {
                break;
            }
            self.k[i] = self.k[p];
            self.v[i] = self.v[p];
            i = p;
        }
        self.k[i] = key;
        self.v[i] = val;
    }

    pub fn pop(&mut self) -> i32 {
        let top = self.v[0];
        self.n -= 1;
        let lk = self.k[self.n];
        let lv = self.v[self.n];
        let mut i = 0;
        loop {
            let mut c = 2 * i + 1;
            if c >= self.n {
                break;
            }
            if c + 1 < self.n && self.k[c + 1] < self.k[c] {
                c += 1;
            }
            if self.k[c] >= lk {
                break;
            }
            self.k[i] = self.k[c];
            self.v[i] = self.v[c];
            i = c;
        }
        self.k[i] = lk;
        self.v[i] = lv;
        top
    }
}

/// The mulberry32 generator used by the sample terrain.
pub struct Mulberry32 {
    a: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Mulberry32 { a: seed }
    }
    pub fn next_f64(&mut self) -> f64 {
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let mut t = self.a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

/// Fractal value noise (as makeValueNoise in the JavaScript model).
pub struct ValueNoise {
    vals: Vec<f64>,
}

impl ValueNoise {
    const P: i64 = 256;

    pub fn new(seed: u32) -> Self {
        let mut rnd = Mulberry32::new(seed);
        let vals = (0..(Self::P * Self::P)).map(|_| rnd.next_f64()).collect();
        ValueNoise { vals }
    }

    #[inline]
    fn at(&self, ix: i64, iy: i64) -> f64 {
        self.vals[(((iy & (Self::P - 1)) * Self::P) + (ix & (Self::P - 1))) as usize]
    }

    fn noise(&self, x: f64, y: f64) -> f64 {
        let ix = x.floor() as i64;
        let iy = y.floor() as i64;
        let fade = |t: f64| t * t * (3.0 - 2.0 * t);
        let fx = fade(x - ix as f64);
        let fy = fade(y - iy as f64);
        let a = self.at(ix, iy);
        let b = self.at(ix + 1, iy);
        let c = self.at(ix, iy + 1);
        let d = self.at(ix + 1, iy + 1);
        (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy
    }

    /// 0..1
    pub fn fbm(&self, x: f64, y: f64, octaves: u32) -> f64 {
        let octaves = if octaves == 0 { 5 } else { octaves };
        let (mut sum, mut amp, mut freq, mut norm) = (0.0, 0.5, 1.0, 0.0);
        for _ in 0..octaves {
            sum += amp * self.noise(x * freq, y * freq);
            norm += amp;
            amp *= 0.5;
            freq *= 2.03;
        }
        sum / norm
    }
}

pub fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = jmin(1.0, jmax(0.0, (x - a) / (b - a)));
    t * t * (3.0 - 2.0 * t)
}

/// Two-pass chamfer distance (in cells) from cells where src[i] == 1.
pub fn chamfer_distance(src: &[u8], w: usize, h: usize) -> Vec<f64> {
    const INF: f64 = 1e9;
    let (a, b) = (1.0, SQRT2);
    let mut d: Vec<f64> = src.iter().map(|&s| if s != 0 { 0.0 } else { INF }).collect();
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let mut v = d[i];
            if x > 0 {
                v = jmin(v, d[i - 1] + a);
            }
            if y > 0 {
                v = jmin(v, d[i - w] + a);
                if x > 0 {
                    v = jmin(v, d[i - w - 1] + b);
                }
                if x < w - 1 {
                    v = jmin(v, d[i - w + 1] + b);
                }
            }
            d[i] = v;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = y * w + x;
            let mut v = d[i];
            if x < w - 1 {
                v = jmin(v, d[i + 1] + a);
            }
            if y < h - 1 {
                v = jmin(v, d[i + w] + a);
                if x < w - 1 {
                    v = jmin(v, d[i + w + 1] + b);
                }
                if x > 0 {
                    v = jmin(v, d[i + w - 1] + b);
                }
            }
            d[i] = v;
        }
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_matches_javascript() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
    }

    #[test]
    fn heap_pops_in_order() {
        let mut h = MinHeap::new(2);
        for (k, v) in [(3.0, 3), (1.0, 1), (2.0, 2), (1.0, 4)] {
            h.push(k, v);
        }
        let out: Vec<i32> = (0..4).map(|_| h.pop()).collect();
        assert_eq!(out[2..], [2, 3]);
        assert!(out[..2].contains(&1) && out[..2].contains(&4));
    }

    #[test]
    fn mulberry_is_deterministic_and_in_range() {
        let mut r = Mulberry32::new(1974);
        let a: Vec<f64> = (0..5).map(|_| r.next_f64()).collect();
        let mut r2 = Mulberry32::new(1974);
        let b: Vec<f64> = (0..5).map(|_| r2.next_f64()).collect();
        assert_eq!(a, b);
        assert!(a.iter().all(|&x| (0.0..1.0).contains(&x)));
    }
}
