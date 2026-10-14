//! A small, fast, seedable random generator (xoshiro128++) for the simulator.

/// xoshiro128++ by Blackman and Vigna.
#[derive(Clone, Debug)]
pub struct Rng {
    s: [u32; 4],
}

impl Rng {
    /// A generator from a seed (any value, also 0).
    pub fn new(seed: u64) -> Rng {
        // splitmix64 to spread the seed
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut next = || {
            z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        };
        let a = next();
        let b = next();
        Rng { s: [a as u32, (a >> 32) as u32 | 1, b as u32, (b >> 32) as u32] }
    }

    /// Next 32 random bits.
    pub fn next_u32(&mut self) -> u32 {
        let [s0, s1, s2, s3] = self.s;
        let result = s0.wrapping_add(s3).rotate_left(7).wrapping_add(s0);
        let t = s1 << 9;
        let mut s = [s0, s1, s2 ^ s0, s3 ^ s1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(11);
        self.s = s;
        result
    }

    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }

    /// Approximately standard normal (sum of four uniforms, scaled to variance 1).
    pub fn normal(&mut self) -> f32 {
        let s = self.uniform() + self.uniform() + self.uniform() + self.uniform();
        (s - 2.0) * 1.732_050_8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_has_unit_variance() {
        let mut r = Rng::new(1);
        let n = 200_000;
        let (mut sum, mut sq) = (0.0f64, 0.0f64);
        for _ in 0..n {
            let v = f64::from(r.normal());
            sum += v;
            sq += v * v;
        }
        let mean = sum / n as f64;
        let var = sq / n as f64 - mean * mean;
        assert!(mean.abs() < 0.01, "mean {mean}");
        assert!((var - 1.0).abs() < 0.02, "variance {var}");
    }
}
