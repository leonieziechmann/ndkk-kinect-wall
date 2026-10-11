//! Pop sounds (port of sound.js): a short pitch drop plus a click of noise. The browser synthesized
//! every pop with WebAudio; here the same graph is rendered once per run (in the first make()) into
//! small banks (the pop's pitch in semitone steps, the click's band in 250 Hz steps, loud and quiet)
//! and played through ctx.audio. The output's sound is mono: the browser's panning to the bubble's
//! place on the wall is left out. The browser's bus (master gain = volume, then a DynamicsCompressor with its defaults)
//! is applied per sound as the compressor's static curve with its makeup gain.

use std::sync::OnceLock;

use crate::audio::{self, Audio, Biquad, Pcm, exp_ramp, noise, osc};
use crate::scenes::common::rand::Rng;

use super::game::{Event, Kind};

/// lowest pop pitch in the banks (Hz): the biggest giants (size 2.5)
const F_LO: f32 = 150.0;
/// semitones above F_LO: up to ~2200 Hz (the smallest bubbles), giants up to ~900 Hz
const NORMAL_STEPS: usize = 47;
const GIANT_STEPS: usize = 32;
/// the click's band: 2500..4000 Hz
const CLICK_LO: f32 = 2500.0;
const CLICK_STEP: f32 = 250.0;
const CLICK_STEPS: usize = 7;
/// gain of a scored pop and of a quiet one (age, demo)
const LOUD: f32 = 0.35;
const QUIET: f32 = 0.08;

/// a blip: frequency f0 falling to f1 over dur seconds (exponential ramps as WebAudio's)
fn blip(f0: f32, f1: f32, dur: f32, gain: f32, kind: &str) -> Pcm {
    let mut phase = 0.0_f32;
    audio::render(dur + 0.02, |t, _| {
        let f = if t < dur { f0 * (f1 / f0).powf(t / dur) } else { f1 };
        let g = if t < 0.004 { exp_ramp(t, 0.0, 0.0001, 0.004, gain) } else { exp_ramp(t, 0.004, gain, dur, 0.0001) };
        let s = osc(kind, phase) * g;
        phase = (phase + f / audio::RATE as f32).fract();
        s
    })
}

/// a click: noise through a band pass (Q 1.2), fading out in 30 ms; the browser used one noise
/// buffer for all clicks, so here too
fn click(freq: f32, gain: f32) -> Pcm {
    let mut f = Biquad::default();
    audio::render(0.05, |t, i| f.run("bandpass", noise(i, 0x5eed), freq, 1.2) * exp_ramp(t, 0.0, gain, 0.03, 0.0001))
}

fn peak(p: &Pcm) -> f32 {
    p.iter().fold(0.0_f32, |m, s| m.max(s.abs()))
}

fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn lin_to_db(x: f32) -> f32 {
    20.0 * x.max(1e-9).log10()
}

/// The static curve of Chromium's DynamicsCompressor (WebAudio's defaults: threshold -24 dB, knee
/// 30 dB, ratio 12) with its makeup gain: the level a sound peaking at x comes out with.
struct Compressor {
    threshold: f32,
    knee_threshold: f32,
    knee_threshold_db: f32,
    y_knee_db: f32,
    slope: f32,
    k: f32,
    makeup: f32,
}

impl Compressor {
    fn new(threshold_db: f32, knee_db: f32, ratio: f32) -> Self {
        let mut c = Self { threshold: db_to_lin(threshold_db), knee_threshold: 0.0, knee_threshold_db: threshold_db + knee_db, y_knee_db: 0.0, slope: 1.0 / ratio, k: 5.0, makeup: 1.0 };
        c.knee_threshold = db_to_lin(c.knee_threshold_db);
        // k for the slope 1/ratio at the end of the knee (KAtSlope)
        let (mut lo, mut hi, mut k) = (0.1_f32, 10000.0_f32, 5.0_f32);
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

    fn knee_curve(&self, x: f32, k: f32) -> f32 {
        if x < self.threshold { x } else { self.threshold + (1.0 - (-k * (x - self.threshold)).exp()) / k }
    }

    fn slope_at(&self, x: f32, k: f32) -> f32 {
        if x < self.threshold {
            return 1.0;
        }
        let x2 = x * 1.001;
        (lin_to_db(self.knee_curve(x2, k)) - lin_to_db(self.knee_curve(x, k))) / (lin_to_db(x2) - lin_to_db(x))
    }

    fn saturate(&self, x: f32) -> f32 {
        if x < self.knee_threshold { self.knee_curve(x, self.k) } else { db_to_lin(self.y_knee_db + self.slope * (lin_to_db(x) - self.knee_threshold_db)) }
    }

    /// volume to play a sound with that peaks at `level` in its PCM, through master gain `volume`
    fn volume(&self, level: f32, volume: f32) -> f32 {
        if level <= 0.0 { 0.0 } else { self.saturate(level * volume) * self.makeup / level }
    }
}

/// Every sound, rendered once for the run: every instance plays the same PCM (the output's sound
/// cache knows them by their Arc, so a scene that comes back plays them without converting again).
struct Bank {
    /// per semitone: [loud, quiet]
    normal: Vec<[Pcm; 2]>,
    giant: Vec<[Pcm; 2]>,
    clicks: Vec<[Pcm; 2]>,
    star: Pcm,
    star_peak: f32,
    wave: Pcm,
    wave_peak: f32,
    comp: Compressor,
}

static BANK: OnceLock<Bank> = OnceLock::new();

impl Bank {
    fn render() -> Self {
        let pitch = |i: usize| F_LO * 2f32.powf(i as f32 / 12.0);
        // the pitch falls from 1.8 f to 0.55 f; giants pop longer
        let pair = |f: f32, dur: f32| [blip(f * 1.8, f * 0.55, dur, LOUD, "sine"), blip(f * 1.8, f * 0.55, dur, QUIET, "sine")];
        let normal = (0..NORMAL_STEPS).map(|i| pair(pitch(i), 0.09)).collect();
        let giant = (0..GIANT_STEPS).map(|i| pair(pitch(i), 0.18)).collect();
        let clicks = (0..CLICK_STEPS)
            .map(|i| {
                let f = CLICK_LO + i as f32 * CLICK_STEP;
                [click(f, LOUD * 0.8), click(f, QUIET * 0.8)]
            })
            .collect();
        // star: a rising chord, one note every 60 ms
        let notes: Vec<Pcm> = [0.0_f32, 4.0, 7.0, 12.0]
            .iter()
            .map(|st| {
                let f = 880.0 * 2f32.powf(st / 12.0);
                blip(f, f, 0.25, 0.18, "triangle")
            })
            .collect();
        let parts: Vec<(f32, &Pcm, f32)> = notes.iter().enumerate().map(|(i, n)| (i as f32 * 0.06, n, 1.0)).collect();
        let star = audio::mix(&parts);
        let wave = blip(220.0, 1320.0, 0.7, 0.2, "triangle");
        Self { normal, giant, clicks, star_peak: peak(&star), star, wave_peak: peak(&wave), wave, comp: Compressor::new(-24.0, 30.0, 12.0) }
    }
}

pub struct Sound {
    bank: &'static Bank,
    /// times of the last sounds: at most a few at once
    recent: Vec<f64>,
    rng: Rng,
}

impl Sound {
    /// The first instance renders every sound (in make(): a worker thread).
    pub fn new() -> Self {
        Self { bank: BANK.get_or_init(Bank::render), recent: Vec::with_capacity(8), rng: Rng::from_time() }
    }

    fn budget(&mut self, now: f64) -> bool {
        self.recent.retain(|t| now - t < 0.12);
        if self.recent.len() >= 4 {
            return false;
        }
        self.recent.push(now);
        true
    }

    /// One event of the game (now: s on the monotonic clock).
    pub fn play(&mut self, e: &Event, audio: &mut Audio, volume: f32, now: f64) {
        let b = self.bank;
        match *e {
            Event::Pop { r, kind, quiet } => {
                if !self.budget(now) {
                    return;
                }
                // smaller bubble, higher pop
                let f = 700.0 * (0.12 / r.max(0.03)).powf(0.7) * (0.9 + self.rng.f64() * 0.25);
                let fc = CLICK_LO + self.rng.f32() * 1500.0;
                let gain = if quiet { QUIET } else { LOUD };
                let v = b.comp.volume(gain, volume);
                let q = usize::from(quiet);
                let pops = if kind == Kind::Giant { &b.giant } else { &b.normal };
                let i = ((12.0 * (f as f32 / F_LO).log2()).round().max(0.0) as usize).min(pops.len().saturating_sub(1));
                if let Some(p) = pops.get(i) {
                    audio.play(&p[q], v);
                }
                let c = (((fc - CLICK_LO) / CLICK_STEP).round().max(0.0) as usize).min(CLICK_STEPS - 1);
                if let Some(p) = b.clicks.get(c) {
                    audio.play(&p[q], v);
                }
            }
            Event::Star => audio.play(&b.star, b.comp.volume(b.star_peak, volume)),
            Event::Wave => audio.play(&b.wave, b.comp.volume(b.wave_peak, volume)),
        }
    }
}
