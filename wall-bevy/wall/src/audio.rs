//! Sound for the scenes: they synthesize their sounds once into PCM (the helpers below, WebAudio-like
//! building blocks) and ask for them with `ctx.audio.play()`; the output plays them through Bevy's
//! audio (its own thread: playing never waits).

use std::sync::Arc;

pub const RATE: u32 = 44_100;

/// A mono sound, f32 samples at RATE.
pub type Pcm = Arc<Vec<f32>>;

#[derive(Default)]
pub struct Audio {
    pub muted: bool,
    /// master volume 0..1
    pub volume: f32,
    requests: Vec<(Pcm, f32)>,
}

impl Audio {
    pub fn new(muted: bool) -> Self {
        Self { muted, volume: 1.0, requests: Vec::new() }
    }

    /// Plays a sound once (volume 0..1).
    pub fn play(&mut self, pcm: &Pcm, volume: f32) {
        if self.muted || volume <= 0.001 || pcm.is_empty() {
            return;
        }
        if self.requests.len() < 32 {
            self.requests.push((pcm.clone(), volume * self.volume));
        }
    }

    pub fn take(&mut self) -> Vec<(Pcm, f32)> {
        std::mem::take(&mut self.requests)
    }
}

// ---------- a tiny synthesizer (WebAudio-like building blocks) ----------

/// Renders `secs` seconds with `f(t, i)` -> sample.
pub fn render(secs: f32, mut f: impl FnMut(f32, usize) -> f32) -> Pcm {
    let n = (secs * RATE as f32).ceil() as usize;
    let mut v = Vec::with_capacity(n);
    for i in 0..n {
        v.push(f(i as f32 / RATE as f32, i));
    }
    Arc::new(v)
}

/// Mixes several sounds (starting at the given offsets in s).
pub fn mix(parts: &[(f32, &Pcm, f32)]) -> Pcm {
    let len = parts.iter().map(|(at, p, _)| (at * RATE as f32) as usize + p.len()).max().unwrap_or(0);
    let mut v = vec![0.0_f32; len];
    for (at, p, gain) in parts {
        let o = (at * RATE as f32) as usize;
        for (i, s) in p.iter().enumerate() {
            v[o + i] += s * gain;
        }
    }
    Arc::new(v)
}

/// Exponential ramp as WebAudio's exponentialRampToValueAtTime: from a at t0 to b at t1.
pub fn exp_ramp(t: f32, t0: f32, a: f32, t1: f32, b: f32) -> f32 {
    if t <= t0 {
        return a;
    }
    if t >= t1 {
        return b;
    }
    let a = a.max(1e-4);
    let b = b.max(1e-4);
    a * (b / a).powf((t - t0) / (t1 - t0))
}

#[allow(dead_code)]
pub fn lin_ramp(t: f32, t0: f32, a: f32, t1: f32, b: f32) -> f32 {
    if t <= t0 {
        return a;
    }
    if t >= t1 {
        return b;
    }
    a + (b - a) * (t - t0) / (t1 - t0)
}

/// Oscillator shapes (phase 0..1).
pub fn osc(kind: &str, phase: f32) -> f32 {
    let p = phase.fract();
    match kind {
        "square" => {
            if p < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        "sawtooth" => 2.0 * p - 1.0,
        "triangle" => 1.0 - 4.0 * (p - 0.5).abs(),
        _ => (p * std::f32::consts::TAU).sin(),
    }
}

/// Deterministic white noise (a hash of the sample index).
pub fn noise(i: usize, seed: u32) -> f32 {
    let mut x = (i as u32).wrapping_mul(0x9E37_79B9) ^ seed.wrapping_mul(0x85EB_CA6B);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7FEB_352D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846C_A68B);
    x ^= x >> 16;
    (x as f32 / u32::MAX as f32) * 2.0 - 1.0
}

/// A one-pole lowpass state (for filtered noise).
#[derive(Default, Clone, Copy)]
#[allow(dead_code)]
pub struct OnePole {
    y: f32,
}

#[allow(dead_code)]
impl OnePole {
    pub fn lowpass(&mut self, x: f32, cutoff: f32) -> f32 {
        let a = 1.0 - (-std::f32::consts::TAU * cutoff / RATE as f32).exp();
        self.y += a * (x - self.y);
        self.y
    }
}

/// A biquad filter (WebAudio BiquadFilterNode: lowpass, highpass, bandpass).
#[derive(Default, Clone, Copy)]
pub struct Biquad {
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    pub fn run(&mut self, kind: &str, x: f32, freq: f32, q: f32) -> f32 {
        let w0 = std::f32::consts::TAU * (freq / RATE as f32).clamp(1e-4, 0.49);
        let (s, c) = w0.sin_cos();
        let alpha = s / (2.0 * q.max(1e-3));
        let (b0, b1, b2, a0, a1, a2) = match kind {
            "highpass" => ((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha),
            "bandpass" => (alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * c, 1.0 - alpha),
            _ => ((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + alpha, -2.0 * c, 1.0 - alpha),
        };
        let y = (b0 * x + b1 * self.x1 + b2 * self.x2 - a1 * self.y1 - a2 * self.y2) / a0;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}
