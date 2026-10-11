//! Arcade sounds (sound.js): the four-note march of the formations, lasers, explosions, the
//! mothership's wobble. The browser synthesized each with WebAudio when it happened; here the same
//! graphs are rendered once per run (the first make(), a worker thread) into PCM and played through
//! ctx.audio: band-limited oscillators (the Fourier series of OscillatorNode's square, sawtooth and
//! triangle) with exponential pitch glides and gain envelopes, white noise through biquad filters.
//! Variants are rendered for what changed per event (the kill's pitch by combo, the warp's pitch).
//!
//! Differences: the output's audio is mono, so the browser's panning to where it happened is left
//! out (every sound plays at the level of the panner's middle). The browser's bus (master gain =
//! volume, then a DynamicsCompressor with its defaults) is applied per sound as the compressor's
//! static curve with its makeup gain. The two sounds that run until they are stopped (the
//! mothership's wobble, the battleship's laser) play as a chain of short pieces that overlap a
//! little: they stop within one piece (a few tenths of a second) instead of fading at once.

use std::f64::consts::{PI, TAU};
use std::sync::{Arc, OnceLock};

use wall::audio::{Audio, Biquad, Pcm, RATE, noise};
use wall::common::rand::Rng;

use super::game::Ev;
use super::pixels::POWERS;

const SR: f64 = RATE as f64;
/// the panner's gain in the middle (equal power)
const MID: f64 = std::f64::consts::FRAC_1_SQRT_2;
/// the march: F2, D#2, D2, C2, the classic descending four notes
const MARCH: [f64; 4] = [87.31, 77.78, 73.42, 65.41];
/// most partials of an oscillator (20 Hz up to the Nyquist frequency)
const PARTIALS: usize = 1103;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Wave {
    Sine,
    Square,
    Saw,
    Triangle,
}

/// the Fourier coefficients of WebAudio's built-in waves, normalized to a peak of 1
struct Coefs {
    square: Vec<f64>,
    saw: Vec<f64>,
    triangle: Vec<f64>,
}

fn coefs() -> Coefs {
    let mut square = vec![0.0; PARTIALS + 1];
    let mut saw = vec![0.0; PARTIALS + 1];
    let mut triangle = vec![0.0; PARTIALS + 1];
    for k in 1..=PARTIALS {
        let kf = k as f64;
        if k % 2 == 1 {
            square[k] = 4.0 / (PI * kf) / 1.178_98;
            triangle[k] = (if (k / 2) % 2 == 0 { 8.0 } else { -8.0 }) / (PI * PI * kf * kf);
        }
        saw[k] = (if k % 2 == 1 { 2.0 } else { -2.0 }) / (PI * kf) / 1.178_98;
    }
    Coefs { square, saw, triangle }
}

/// One sample of a band-limited oscillator at `phase` (cycles), frequency f, partials below
/// `limit` Hz (the Nyquist frequency, or far above a lowpass that follows).
fn osc(c: &Coefs, wave: Wave, phase: f64, f: f64, limit: f64) -> f64 {
    let (s1, c1) = (phase * TAU).sin_cos();
    let table = match wave {
        Wave::Sine => return s1,
        Wave::Square => &c.square,
        Wave::Saw => &c.saw,
        Wave::Triangle => &c.triangle,
    };
    let n = ((limit / f.max(1.0)).floor() as usize).clamp(1, PARTIALS);
    let two_c = 2.0 * c1;
    // sin(k x) by the recurrence sin(k x) = 2 cos(x) sin((k-1) x) - sin((k-2) x)
    let (mut s_prev, mut s_cur) = (0.0, s1);
    let mut sum = 0.0;
    for &b in &table[1..=n] {
        sum += b * s_cur;
        let next = two_c * s_cur - s_prev;
        s_prev = s_cur;
        s_cur = next;
    }
    sum
}

/// WebAudio's lowpass and highpass Q is in dB
fn q_db(q: f64) -> f32 {
    10_f64.powf(q / 20.0) as f32
}

/// tone(): the pitch glides from f0 to f1 over dur (exponential), the gain rises in 4 ms and falls
/// to the end (exponential), an optional lowpass (Q 1); the oscillator runs 20 ms more.
fn tone(c: &Coefs, f0: f64, f1: f64, dur: f64, gain: f64, wave: Wave, lowpass: f64) -> Vec<f32> {
    let f1 = f1.max(1.0);
    let n = ((dur + 0.02) * SR).ceil() as usize;
    let lo = 0.0001;
    let limit = if lowpass > 0.0 { (lowpass * 16.0).min(SR / 2.0) } else { SR / 2.0 };
    let mut filter = Biquad::default();
    let q = q_db(1.0);
    let mut out = Vec::with_capacity(n);
    let mut phase = 0.0_f64;
    for i in 0..n {
        let t = i as f64 / SR;
        let f = if t < dur { f0 * (f1 / f0).powf(t / dur) } else { f1 };
        let g = if t < 0.004 {
            lo * (gain / lo).powf(t / 0.004)
        } else if t < dur {
            gain * (lo / gain).powf((t - 0.004) / (dur - 0.004).max(1e-6))
        } else {
            lo
        };
        let mut s = osc(c, wave, phase, f, limit) as f32;
        if lowpass > 0.0 {
            s = filter.run("lowpass", s, lowpass as f32, q);
        }
        out.push(s * g as f32);
        phase = (phase + f / SR).fract();
    }
    out
}

/// noiseBurst(): white noise through a filter gliding from freq to max(40, freq / 4) over dur, the
/// gain falling from `gain` (exponential); 50 ms more. The browser played it from its 1 s noise
/// buffer, started 0..0.5 s in: a long burst ends with the buffer (here after 0.75 s, the middle).
fn noise_burst(freq: f64, dur: f64, gain: f64, kind: &str, seed: u32) -> Vec<f32> {
    let n = ((dur + 0.05).min(0.75) * SR).ceil() as usize;
    let lo = 0.0001;
    let f_end = (freq * 0.25).max(40.0);
    let q = if kind == "bandpass" { 0.9 } else { q_db(0.9) };
    let mut filter = Biquad::default();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f64 / SR;
        let (fc, g) = if t < dur { (freq * (f_end / freq).powf(t / dur), gain * (lo / gain).powf(t / dur)) } else { (f_end, lo) };
        out.push(filter.run(kind, noise(i, seed), fc as f32, q) * g as f32);
    }
    out
}

/// parts mixed at their offsets (s), through the panner's middle
fn mix(parts: Vec<(f64, Vec<f32>)>, gain: f64) -> Snd {
    let len = parts.iter().map(|(at, p)| (at * SR) as usize + p.len()).max().unwrap_or(0);
    let mut v = vec![0.0_f32; len];
    for (at, p) in parts {
        let o = (at * SR) as usize;
        for (d, s) in v.iter_mut().skip(o).zip(p) {
            *d += s;
        }
    }
    for s in &mut v {
        *s *= gain as f32;
    }
    Snd::new(v)
}

/// a sound and its peak
struct Snd {
    pcm: Pcm,
    peak: f32,
}

impl Snd {
    fn new(v: Vec<f32>) -> Self {
        let peak = v.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
        Self { pcm: Arc::new(v), peak }
    }
}

fn db_to_lin(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

fn lin_to_db(x: f64) -> f64 {
    20.0 * x.max(1e-9).log10()
}

/// The static curve of Chromium's DynamicsCompressor (WebAudio's defaults: threshold -24 dB, knee
/// 30 dB, ratio 12) with its makeup gain: the level a sound peaking at x comes out with.
struct Compressor {
    threshold: f64,
    knee_threshold: f64,
    knee_threshold_db: f64,
    y_knee_db: f64,
    slope: f64,
    k: f64,
    makeup: f64,
}

impl Compressor {
    fn new(threshold_db: f64, knee_db: f64, ratio: f64) -> Self {
        let mut c = Self { threshold: db_to_lin(threshold_db), knee_threshold: 0.0, knee_threshold_db: threshold_db + knee_db, y_knee_db: 0.0, slope: 1.0 / ratio, k: 5.0, makeup: 1.0 };
        c.knee_threshold = db_to_lin(c.knee_threshold_db);
        // k for the slope 1/ratio at the end of the knee (KAtSlope)
        let (mut lo, mut hi, mut k) = (0.1_f64, 10000.0_f64, 5.0_f64);
        for _ in 0..15 {
            if c.slope_at(c.knee_threshold, k) < c.slope {
                hi = k;
            } else {
                lo = k;
            }
            k = (lo * hi).sqrt();
        }
        c.k = k;
        c.y_knee_db = lin_to_db(c.knee_curve(c.knee_threshold, k));
        c.makeup = (1.0 / c.saturate(1.0).max(1e-6)).powf(0.6);
        c
    }

    fn knee_curve(&self, x: f64, k: f64) -> f64 {
        if x < self.threshold { x } else { self.threshold + (1.0 - (-k * (x - self.threshold)).exp()) / k }
    }

    fn slope_at(&self, x: f64, k: f64) -> f64 {
        if x < self.threshold {
            return 1.0;
        }
        let x2 = x * 1.001;
        (lin_to_db(self.knee_curve(x2, k)) - lin_to_db(self.knee_curve(x, k))) / (lin_to_db(x2) - lin_to_db(x))
    }

    fn saturate(&self, x: f64) -> f64 {
        if x < self.knee_threshold { self.knee_curve(x, self.k) } else { db_to_lin(self.y_knee_db + self.slope * (lin_to_db(x) - self.knee_threshold_db)) }
    }

    /// volume to play a sound with that peaks at `level` in its PCM, through master gain `volume`
    fn volume(&self, level: f32, volume: f32) -> f32 {
        let level = f64::from(level);
        if level <= 0.0 { 0.0 } else { (self.saturate(level * f64::from(volume)) * self.makeup / level) as f32 }
    }
}

/// a sound that runs until it is stopped, as pieces: the first one with the attack, then the loop
/// piece every `period` s; every piece holds a little longer than its period, then releases
struct Held {
    start: Snd,
    piece: Snd,
    /// s from the start piece to the first loop piece, and between loop pieces
    first: f64,
    period: f64,
}

/// the mothership: a sawtooth at 520 Hz wobbling ±140 Hz at 7 Hz, lowpass 1400 Hz, gain 0.06 after a
/// 0.3 s rise (no panner: straight to the bus); 0.15 s to fade
fn ufo_held(c: &Coefs) -> Held {
    let period = 2.0 / 7.0; // two wobbles: the wobble runs on seamlessly
    let render = |len: f64, attack: bool| {
        let n = ((len + 0.035 + 0.15) * SR).ceil() as usize;
        let mut filter = Biquad::default();
        let q = q_db(1.0);
        let mut out = Vec::with_capacity(n);
        let mut phase = 0.0_f64;
        for i in 0..n {
            let t = i as f64 / SR;
            let f = 520.0 + 140.0 * (TAU * 7.0 * t).sin();
            let s = filter.run("lowpass", osc(c, Wave::Saw, phase, f, (1400.0 * 16.0_f64).min(SR / 2.0)) as f32, 1400.0, q);
            let local = t;
            let mut g = if attack { if local < 0.3 { 0.0001 * (0.06_f64 / 0.0001).powf(local / 0.3) } else { 0.06 } } else { 0.06 * (local / 0.01).min(1.0) };
            let hold = len + 0.035;
            if local > hold {
                g *= (0.0001_f64 / 0.06).powf(((local - hold) / 0.15).min(1.0));
            }
            out.push(s * g as f32);
            phase = (phase + f / SR).fract();
        }
        Snd::new(out)
    };
    Held { start: render(2.0 * period, true), piece: render(period, false), first: 2.0 * period, period }
}

/// the battleship's laser: looped noise through a lowpass at 1800 Hz and a sawtooth at 55 Hz, gain
/// 0.5 after a 50 ms rise, through the panner; 0.25 s to fade
fn beam_held(c: &Coefs) -> Held {
    let period = 0.2; // eleven periods of 55 Hz: the sawtooth runs on seamlessly
    let render = |len: f64, attack: bool, seed: u32| {
        let n = ((len + 0.035 + 0.25) * SR).ceil() as usize;
        let mut filter = Biquad::default();
        let q = q_db(1.0);
        let mut out = Vec::with_capacity(n);
        let mut phase = 0.0_f64;
        for i in 0..n {
            let local = i as f64 / SR;
            let s = filter.run("lowpass", noise(i, seed), 1800.0, q) + osc(c, Wave::Saw, phase, 55.0, SR / 2.0) as f32;
            let mut g = if attack { if local < 0.05 { 0.0001 * (0.5_f64 / 0.0001).powf(local / 0.05) } else { 0.5 } } else { 0.5 * (local / 0.01).min(1.0) };
            let hold = len + 0.035;
            if local > hold {
                g *= (0.0001_f64 / 0.5).powf(((local - hold) / 0.25).min(1.0));
            }
            out.push(s * (g * MID) as f32);
            phase = (phase + 55.0 / SR).fract();
        }
        Snd::new(out)
    };
    Held { start: render(period, true, 0xbea0), piece: render(period, false, 0xbea1), first: period, period }
}

/// Every sound, rendered once for the run.
struct Bank {
    march: Vec<Snd>,
    laser: Snd,
    /// by combo 0..12
    kill: Vec<Snd>,
    /// the warp's random pitch, in steps
    warp: Vec<Snd>,
    dive: Snd,
    fall: Snd,
    rebuild: Snd,
    shield: Snd,
    shield_break: Snd,
    bomb_throw: Snd,
    bomb_land: Snd,
    bomb_beep: Snd,
    bomb: Snd,
    ship_enter: Snd,
    charge: Snd,
    ship_hit: Snd,
    ship_kill: Snd,
    item: Snd,
    /// in POWERS order
    pickup: Vec<Snd>,
    edge_charge: Snd,
    edge_fire: Snd,
    jump: Snd,
    jump_empty: Snd,
    boost: Snd,
    boost_end: Snd,
    boost_ready: Snd,
    ping: Snd,
    fortify: Snd,
    link: Snd,
    zap: Snd,
    block: Snd,
    hit: Snd,
    city: Snd,
    crash: Snd,
    storm: Snd,
    ufo_kill: Snd,
    clear: Snd,
    firework: Snd,
    enter: Snd,
    ufo: Held,
    beam: Held,
    comp: Compressor,
}

impl Bank {
    fn render() -> Self {
        use Wave::{Saw, Sine, Square, Triangle};
        let c = coefs();
        let c = &c;
        let one = |v: Vec<f32>| mix(vec![(0.0, v)], MID);
        let semis = |base: f64, st: f64| base * 2f64.powf(st / 12.0);
        let kill = (0..=12)
            .map(|combo| {
                // kills in quick succession climb a scale: the longer the streak, the higher
                let up = 2f64.powf(f64::from(combo) / 12.0);
                let mut parts = vec![(0.0, noise_burst(1400.0 * up, 0.25, 0.45, "bandpass", 11)), (0.0, tone(c, 520.0 * up, 70.0 * up, 0.2, 0.09, Square, 0.0))];
                if combo >= 2 {
                    parts.push((0.03, tone(c, 880.0 * up, 880.0 * up, 0.08, 0.05, Triangle, 0.0)));
                }
                mix(parts, MID)
            })
            .collect();
        let pickup = POWERS
            .iter()
            .map(|pw| {
                let base = [392.0, 523.0, 587.0, 440.0, 330.0, 494.0, 349.0][pw.idx()];
                let mut parts: Vec<(f64, Vec<f32>)> =
                    [0.0, 4.0, 7.0, 12.0, 16.0].iter().enumerate().map(|(i, &st)| (i as f64 * 0.05, tone(c, semis(base, st), semis(base, st), 0.14, 0.12, Square, 3500.0))).collect();
                if *pw == super::pixels::Power::Nova {
                    parts.push((0.0, noise_burst(800.0, 0.8, 0.7, "lowpass", 21)));
                }
                mix(parts, MID)
            })
            .collect();
        Self {
            march: MARCH.iter().map(|&f| one(tone(c, f, f * 0.98, 0.14, 0.35, Square, 600.0))).collect(),
            laser: one(tone(c, 1500.0, 380.0, 0.09, 0.05, Square, 0.0)),
            kill,
            warp: (0..8).map(|k| one(tone(c, 400.0 + 400.0 * (f64::from(k) + 0.5) / 8.0, 1600.0, 0.07, 0.04, Triangle, 0.0))).collect(),
            dive: mix(vec![(0.0, tone(c, 1400.0, 160.0, 0.7, 0.07, Saw, 2500.0)), (0.0, noise_burst(2500.0, 0.6, 0.12, "bandpass", 3))], MID),
            fall: mix(
                vec![(0.0, tone(c, 440.0, 40.0, 2.5, 0.25, Saw, 1200.0)), (0.0, tone(c, 220.0, 30.0, 3.0, 0.3, Square, 400.0)), (0.0, noise_burst(300.0, 2.5, 0.8, "lowpass", 4))],
                MID,
            ),
            rebuild: mix([0.0, 3.0, 7.0, 10.0, 12.0, 15.0].iter().enumerate().map(|(i, &st)| (i as f64 * 0.12, tone(c, semis(220.0, st), semis(220.0, st), 0.25, 0.1, Triangle, 0.0))).collect(), MID),
            shield: one(tone(c, 2600.0, 2000.0, 0.06, 0.06, Triangle, 0.0)),
            shield_break: mix(
                std::iter::once((0.0, noise_burst(5000.0, 0.3, 0.3, "highpass", 5))).chain([0.0, 0.03, 0.06].iter().map(|&at| (at, tone(c, 3000.0 - at * 8000.0, 1500.0, 0.08, 0.06, Triangle, 0.0)))).collect(),
                MID,
            ),
            bomb_throw: one(tone(c, 300.0, 900.0, 0.3, 0.05, Triangle, 0.0)),
            bomb_land: one(tone(c, 200.0, 120.0, 0.08, 0.12, Square, 800.0)),
            bomb_beep: one(tone(c, 1800.0, 1800.0, 0.04, 0.06, Square, 4000.0)),
            bomb: mix(vec![(0.0, noise_burst(600.0, 0.7, 0.8, "lowpass", 6)), (0.0, tone(c, 120.0, 30.0, 0.6, 0.35, Sine, 0.0))], MID),
            ship_enter: mix(vec![(0.0, tone(c, 55.0, 110.0, 1.6, 0.3, Saw, 500.0)), (0.0, tone(c, 82.0, 164.0, 1.6, 0.2, Saw, 500.0))], MID),
            charge: mix(vec![(0.0, tone(c, 120.0, 1600.0, 1.5, 0.12, Saw, 3000.0)), (0.0, tone(c, 60.0, 800.0, 1.5, 0.12, Square, 1500.0))], MID),
            ship_hit: one(tone(c, 900.0, 60.0, 1.2, 0.3, Saw, 2000.0)),
            ship_kill: mix(
                vec![(0.0, noise_burst(1200.0, 2.2, 1.0, "lowpass", 7)), (0.0, tone(c, 200.0, 20.0, 2.0, 0.5, Sine, 0.0))]
                    .into_iter()
                    .chain([0.0, 0.1, 0.2, 0.3, 0.45].iter().enumerate().map(|(i, &at)| (0.6 + at, tone(c, 800.0 + i as f64 * 200.0, 1600.0 + i as f64 * 300.0, 0.25, 0.1, Triangle, 0.0))))
                    .collect(),
                MID,
            ),
            item: mix([1568.0, 1175.0, 1568.0].iter().enumerate().map(|(i, &f)| (i as f64 * 0.07, tone(c, f, f, 0.1, 0.08, Triangle, 0.0))).collect(), MID),
            pickup,
            edge_charge: one(tone(c, 200.0, 1400.0, 1.2, 0.05, Saw, 2500.0)),
            edge_fire: mix(vec![(0.0, noise_burst(2500.0, 0.75, 0.45, "bandpass", 8)), (0.0, tone(c, 140.0, 70.0, 0.75, 0.25, Saw, 900.0))], MID),
            jump: one(tone(c, 280.0, 900.0, 0.16, 0.12, Sine, 0.0)),
            jump_empty: mix(vec![(0.08, tone(c, 160.0, 110.0, 0.18, 0.12, Square, 600.0))], MID),
            boost: mix(
                [0.0, 7.0, 12.0, 19.0, 24.0]
                    .iter()
                    .enumerate()
                    .map(|(i, &st)| (i as f64 * 0.035, tone(c, semis(220.0, st), semis(220.0, st) * 1.02, 0.3, 0.12, Saw, 4000.0)))
                    .chain([(0.0, tone(c, 80.0, 400.0, 0.5, 0.3, Sine, 0.0)), (0.0, noise_burst(3000.0, 0.4, 0.3, "bandpass", 9))])
                    .collect(),
                MID,
            ),
            boost_end: one(tone(c, 660.0, 220.0, 0.4, 0.1, Triangle, 0.0)),
            boost_ready: mix([988.0, 1319.0].iter().enumerate().map(|(i, &f)| (i as f64 * 0.08, tone(c, f, f, 0.12, 0.08, Triangle, 0.0))).collect(), MID),
            ping: one(tone(c, 1800.0, 1500.0, 0.05, 0.07, Triangle, 0.0)),
            fortify: mix(vec![(0.0, tone(c, 330.0, 330.0, 0.06, 0.07, Triangle, 0.0)), (0.06, tone(c, 495.0, 495.0, 0.08, 0.07, Triangle, 0.0))], MID),
            link: one(tone(c, 600.0, 1800.0, 0.18, 0.06, Saw, 3000.0)),
            zap: one(tone(c, 2400.0, 300.0, 0.12, 0.08, Saw, 4000.0)),
            block: one(tone(c, 2400.0, 1200.0, 0.05, 0.06, Triangle, 0.0)),
            hit: mix(vec![(0.0, noise_burst(500.0, 0.45, 0.7, "lowpass", 10)), (0.0, tone(c, 180.0, 40.0, 0.4, 0.15, Triangle, 0.0))], MID),
            city: one(noise_burst(700.0, 0.12, 0.25, "bandpass", 12)),
            crash: one(noise_burst(300.0, 0.6, 0.6, "lowpass", 13)),
            storm: one(tone(c, 330.0, 55.0, 1.2, 0.18, Saw, 900.0)),
            ufo_kill: mix(
                [0.0, 0.08, 0.16, 0.24]
                    .iter()
                    .enumerate()
                    .map(|(i, &at)| (at, tone(c, 1200.0 - i as f64 * 180.0, 300.0, 0.12, 0.12, Square, 0.0)))
                    .chain(std::iter::once((0.0, noise_burst(2000.0, 0.6, 0.5, "bandpass", 14))))
                    .collect(),
                MID,
            ),
            clear: mix([0.0, 4.0, 7.0, 12.0, 16.0].iter().enumerate().map(|(i, &st)| (i as f64 * 0.08, tone(c, semis(523.0, st), semis(523.0, st), 0.22, 0.12, Triangle, 0.0))).collect(), MID),
            firework: one(noise_burst(3000.0, 0.35, 0.2, "bandpass", 15)),
            enter: one(tone(c, 110.0, 440.0, 0.8, 0.1, Saw, 1200.0)),
            ufo: ufo_held(c),
            beam: beam_held(c),
            comp: Compressor::new(-24.0, 30.0, 12.0),
        }
    }
}

static BANK: OnceLock<Bank> = OnceLock::new();

/// the kinds with a budget (at most n sounds within a window)
#[derive(Clone, Copy)]
enum Budget {
    Laser,
    Kill,
    Warp,
    Shield,
    BombBeep,
    Ping,
    Zap,
    Block,
    City,
    Crash,
    Firework,
}

/// a running held sound: when its next piece is due (s on the monotonic clock)
#[derive(Clone, Copy, Default)]
struct Running {
    on: bool,
    next: f64,
}

pub struct Sound {
    bank: &'static Bank,
    recent: [Vec<f64>; 11],
    rng: Rng,
    ufo: Running,
    beam: Running,
}

impl Default for Sound {
    fn default() -> Self {
        Self::new()
    }
}

impl Sound {
    /// The first instance renders every sound (in make(): a worker thread).
    pub fn new() -> Self {
        Self { bank: BANK.get_or_init(Bank::render), recent: Default::default(), rng: Rng::from_time(), ufo: Running::default(), beam: Running::default() }
    }

    fn budget(&mut self, kind: Budget, n: usize, window: f64, now: f64) -> bool {
        let Some(list) = self.recent.get_mut(kind as usize) else { return false };
        list.retain(|&t| now - t < window);
        if list.len() >= n {
            return false;
        }
        list.push(now);
        true
    }

    fn snd(&self, s: &Snd, audio: &mut Audio, volume: f32) {
        audio.play(&s.pcm, self.bank.comp.volume(s.peak, volume));
    }

    /// One event of the game (now: s on the monotonic clock; volume: the master volume).
    pub fn play(&mut self, e: Ev, audio: &mut Audio, volume: f32, now: f64) {
        let b = self.bank;
        let s: &Snd = match e {
            Ev::March(note) => match b.march.get(note % 4) {
                Some(s) => s,
                None => return,
            },
            Ev::Laser if self.budget(Budget::Laser, 3, 0.1, now) => &b.laser,
            Ev::Kill(combo) if self.budget(Budget::Kill, 4, 0.12, now) => match b.kill.get(combo.clamp(0, 12) as usize) {
                Some(s) => s,
                None => return,
            },
            Ev::Warp if self.budget(Budget::Warp, 3, 0.08, now) => {
                let k = self.rng.int(b.warp.len());
                match b.warp.get(k) {
                    Some(s) => s,
                    None => return,
                }
            }
            Ev::Dive => &b.dive,
            Ev::Fall => &b.fall,
            Ev::Rebuild => &b.rebuild,
            Ev::Shield if self.budget(Budget::Shield, 3, 0.08, now) => &b.shield,
            Ev::ShieldBreak => &b.shield_break,
            Ev::BombThrow => &b.bomb_throw,
            Ev::BombLand => &b.bomb_land,
            Ev::BombBeep if self.budget(Budget::BombBeep, 4, 0.06, now) => &b.bomb_beep,
            Ev::Bomb => &b.bomb,
            Ev::ShipEnter => &b.ship_enter,
            Ev::Charge => &b.charge,
            Ev::Beam(on) => {
                self.hold(true, on, audio, volume, now);
                return;
            }
            Ev::ShipHit => &b.ship_hit,
            Ev::ShipKill => &b.ship_kill,
            Ev::Item => &b.item,
            Ev::Pickup(pw) => match b.pickup.get(pw.idx()) {
                Some(s) => s,
                None => return,
            },
            Ev::EdgeCharge => &b.edge_charge,
            Ev::EdgeFire => &b.edge_fire,
            Ev::Jump => &b.jump,
            Ev::JumpEmpty => &b.jump_empty,
            Ev::Boost => &b.boost,
            Ev::BoostEnd => &b.boost_end,
            Ev::BoostReady => &b.boost_ready,
            Ev::Ping if self.budget(Budget::Ping, 3, 0.08, now) => &b.ping,
            Ev::Fortify => &b.fortify,
            Ev::Link => &b.link,
            Ev::Zap if self.budget(Budget::Zap, 3, 0.1, now) => &b.zap,
            Ev::Block if self.budget(Budget::Block, 3, 0.1, now) => &b.block,
            Ev::Hit => &b.hit,
            Ev::City if self.budget(Budget::City, 3, 0.1, now) => &b.city,
            Ev::Crash if self.budget(Budget::Crash, 3, 0.15, now) => &b.crash,
            Ev::Storm => &b.storm,
            Ev::Ufo(on) => {
                self.hold(false, on, audio, volume, now);
                return;
            }
            Ev::UfoKill => &b.ufo_kill,
            Ev::Clear => &b.clear,
            Ev::Firework if self.budget(Budget::Firework, 2, 0.2, now) => &b.firework,
            Ev::Enter => &b.enter,
            _ => return,
        };
        self.snd(s, audio, volume);
    }

    /// starts or stops a held sound (beam: the laser, else the mothership)
    fn hold(&mut self, beam: bool, on: bool, audio: &mut Audio, volume: f32, now: f64) {
        let held = if beam { &self.bank.beam } else { &self.bank.ufo };
        let run = if beam { &mut self.beam } else { &mut self.ufo };
        if on && !run.on {
            run.on = true;
            run.next = now + held.first;
            audio.play(&held.start.pcm, self.bank.comp.volume(held.start.peak, volume));
        } else if !on {
            run.on = false;
        }
    }

    /// Every frame: the next pieces of what runs (half a frame early rather than late).
    pub fn tick(&mut self, audio: &mut Audio, volume: f32, now: f64) {
        for beam in [false, true] {
            let held = if beam { &self.bank.beam } else { &self.bank.ufo };
            let run = if beam { &mut self.beam } else { &mut self.ufo };
            if !run.on || now < run.next - 0.017 {
                continue;
            }
            audio.play(&held.piece.pcm, self.bank.comp.volume(held.piece.peak, volume));
            run.next += held.period;
            if run.next < now {
                run.next = now + held.period;
            }
        }
    }

    pub fn stop_all(&mut self) {
        self.ufo.on = false;
        self.beam.on = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every sound is finite, below full scale and not silent.
    #[test]
    fn sounds_are_sane() {
        let b = BANK.get_or_init(Bank::render);
        let mut list: Vec<&Snd> = vec![
            &b.laser,
            &b.dive,
            &b.fall,
            &b.rebuild,
            &b.shield,
            &b.shield_break,
            &b.bomb_throw,
            &b.bomb_land,
            &b.bomb_beep,
            &b.bomb,
            &b.ship_enter,
            &b.charge,
            &b.ship_hit,
            &b.ship_kill,
            &b.item,
            &b.edge_charge,
            &b.edge_fire,
            &b.jump,
            &b.jump_empty,
            &b.boost,
            &b.boost_end,
            &b.boost_ready,
            &b.ping,
            &b.fortify,
            &b.link,
            &b.zap,
            &b.block,
            &b.hit,
            &b.city,
            &b.crash,
            &b.storm,
            &b.ufo_kill,
            &b.clear,
            &b.firework,
            &b.enter,
            &b.ufo.start,
            &b.ufo.piece,
            &b.beam.start,
            &b.beam.piece,
        ];
        list.extend(b.march.iter());
        list.extend(b.kill.iter());
        list.extend(b.warp.iter());
        list.extend(b.pickup.iter());
        for (i, s) in list.iter().enumerate() {
            assert!(s.pcm.iter().all(|v| v.is_finite()), "{i}");
            assert!(s.peak > 0.005 && s.peak < 1.0, "{i}: peak {}", s.peak);
        }
        // a quiet sound comes out louder than the master gain alone (the compressor's makeup gain),
        // a loud one is held back
        assert!(b.comp.volume(0.02, 0.5) > 0.5, "{}", b.comp.volume(0.02, 0.5));
        assert!(b.comp.volume(0.8, 1.0) < 1.0, "{}", b.comp.volume(0.8, 1.0));
    }
}
