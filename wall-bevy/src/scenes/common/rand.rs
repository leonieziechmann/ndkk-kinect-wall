//! Random numbers for the scenes (Math.random() in the browser): a small fast generator, one per
//! scene instance, or the thread's own for quick use.

use std::cell::Cell;

/// SplitMix64: fast, good enough for visuals and games.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9E37_79B9_7F4A_7C15)
    }

    /// seeded from the clock
    pub fn from_time() -> Self {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
        Self::new(t)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// 0..1 (as Math.random())
    pub fn f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// a..b
    #[allow(dead_code)]
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f32()
    }

    /// 0..n-1
    pub fn int(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next_u64() % n as u64) as usize }
    }

    /// true with probability p
    #[allow(dead_code)]
    pub fn chance(&mut self, p: f32) -> bool {
        self.f32() < p
    }

    /// an element of a slice
    #[allow(dead_code)]
    pub fn pick<'a, T>(&mut self, v: &'a [T]) -> Option<&'a T> {
        if v.is_empty() { None } else { v.get(self.int(v.len())) }
    }
}

thread_local! {
    static STATE: Cell<u64> = Cell::new(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(7));
}

/// Math.random(): 0..1 from the thread's generator.
#[allow(dead_code)]
pub fn random() -> f32 {
    STATE.with(|s| {
        let mut r = Rng(s.get());
        let v = r.f32();
        s.set(r.0);
        v
    })
}
