//! 8-bit sounds (sound.js): jump, coin, hit, smash, star, a new player, the round. Synthesized once
//! per run into PCM, as the browser built them with WebAudio: band-limited oscillators (the Fourier
//! series of OscillatorNode's square, sawtooth and triangle) with exponential pitch glides and gain
//! envelopes, and a noise buffer through a lowpass for the hisses.
//!
//! Differences: the browser panned every sound to where it happened on the wall and sent them
//! through a compressor; the output's audio is mono, so they play from the middle. (The compressor's
//! makeup gain, +3.7 dB at these levels, and the panner's -3 dB per side in the middle about cancel.)

use std::f64::consts::{PI, TAU};
use std::sync::LazyLock;

use wall::audio::{Audio, Biquad, Pcm, RATE, noise};

use super::game::Event;

#[derive(Clone, Copy)]
enum Wave {
    Square,
    Saw,
    Triangle,
}

const SR: f64 = RATE as f64;

/// One sample of a band-limited WebAudio oscillator at `phase` (cycles): its Fourier series with
/// the partials below Nyquist, normalized as WebAudio does (peak 1).
fn oscillator(wave: Wave, phase: f64, f: f64) -> f64 {
    let n = ((SR / 2.0) / f.max(1.0)).floor().max(1.0) as usize;
    let (s1, c1) = (phase * TAU).sin_cos();
    let two_c = 2.0 * c1;
    // sin(k x) by the recurrence sin(k x) = 2 cos(x) sin((k-1) x) - sin((k-2) x)
    let (mut s_prev, mut s_cur) = (0.0, s1);
    let mut sum = 0.0;
    for k in 1..=n {
        let kf = k as f64;
        let b = match wave {
            Wave::Square if k % 2 == 1 => 4.0 / (PI * kf),
            Wave::Saw => (if k % 2 == 1 { 2.0 } else { -2.0 }) / (PI * kf),
            Wave::Triangle if k % 2 == 1 => (if (k / 2) % 2 == 0 { 8.0 } else { -8.0 }) / (PI * PI * kf * kf),
            _ => 0.0,
        };
        sum += b * s_cur;
        let next = two_c * s_cur - s_prev;
        s_prev = s_cur;
        s_cur = next;
    }
    // WebAudio scales its built-in waves to a peak of 1 (the Gibbs overshoot of square and saw)
    match wave {
        Wave::Triangle => sum,
        _ => sum / 1.178_98,
    }
}

/// tone(): the pitch glides from f0 to f1 over dur (exponential), the gain rises in 5 ms, holds to
/// 60 %, falls to the end (exponential); the oscillator runs 20 ms more.
fn tone(f0: f64, f1: f64, dur: f64, gain: f64, wave: Wave) -> Vec<f32> {
    let f1 = f1.max(1.0);
    let n = ((dur + 0.02) * SR).ceil() as usize;
    let lo = 0.0001;
    let mut out = Vec::with_capacity(n);
    let mut phase = 0.0_f64;
    for i in 0..n {
        let t = i as f64 / SR;
        let f = if t < dur { f0 * (f1 / f0).powf(t / dur) } else { f1 };
        let g = if t < 0.005 {
            lo * (gain / lo).powf(t / 0.005)
        } else if t < dur * 0.6 {
            gain
        } else if t < dur {
            gain * (lo / gain).powf((t - dur * 0.6) / (dur * 0.4))
        } else {
            lo
        };
        out.push((oscillator(wave, phase, f) * g) as f32);
        phase = (phase + f / SR).fract();
    }
    out
}

/// hiss(): white noise through a lowpass gliding from `lowpass` to 120 Hz, the gain falling over dur
fn hiss(dur: f64, gain: f64, lowpass: f64) -> Vec<f32> {
    let n = ((dur + 0.02) * SR).ceil() as usize;
    let lo = 0.0001;
    let q = 10_f32.powf(1.0 / 20.0); // WebAudio's lowpass Q (default 1) is in dB
    let mut filter = Biquad::default();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f64 / SR;
        let (fc, g) = if t < dur { (lowpass * (120.0 / lowpass).powf(t / dur), gain * (lo / gain).powf(t / dur)) } else { (120.0, lo) };
        // the browser's noise buffer is the same for every hiss (0.5 s, made once)
        out.push(filter.run("lowpass", noise(i, 7), fc as f32, q) * g as f32);
    }
    out
}

/// parts mixed at their offsets (s)
fn mix(parts: Vec<(f64, Vec<f32>)>) -> Pcm {
    let len = parts.iter().map(|(at, p)| (at * SR) as usize + p.len()).max().unwrap_or(0);
    let mut v = vec![0.0_f32; len];
    for (at, p) in parts {
        let o = (at * SR) as usize;
        for (d, s) in v.iter_mut().skip(o).zip(p) {
            *d += s;
        }
    }
    std::sync::Arc::new(v)
}

/// the same tone on several pitches, one after the other
fn notes(list: &[(f64, f64)], dur: impl Fn(usize) -> f64, gain: f64, wave: Wave, glide: f64) -> Pcm {
    mix(list.iter().enumerate().map(|(i, &(f, at))| (at, tone(f, f * glide, dur(i), gain, wave))).collect())
}

struct Sounds {
    jump: Pcm,
    airjump: Pcm,
    coin: Pcm,
    clear: Vec<Pcm>,
    hit: Pcm,
    smash: Pcm,
    star: Pcm,
    count: Pcm,
    go: Pcm,
    goal_in: Pcm,
    finish: Pcm,
    die: Pcm,
    end: Pcm,
    enter: Pcm,
}

static SOUNDS: LazyLock<Sounds> = LazyLock::new(|| {
    let one = |v: Vec<f32>| std::sync::Arc::new(v);
    let steps = |fs: &[f64], every: f64| fs.iter().enumerate().map(|(i, &f)| (f, i as f64 * every)).collect::<Vec<_>>();
    Sounds {
        jump: one(tone(260.0, 720.0, 0.16, 0.12, Wave::Square)),
        airjump: one(tone(420.0, 1100.0, 0.14, 0.11, Wave::Square)),
        coin: mix(vec![(0.0, tone(988.0, 988.0, 0.07, 0.1, Wave::Square)), (0.07, tone(1319.0, 1319.0, 0.22, 0.1, Wave::Square))]),
        clear: (0..=12).map(|s| one(tone(660.0 + f64::from(s) * 40.0, 880.0 + f64::from(s) * 50.0, 0.06, 0.05, Wave::Triangle))).collect(),
        hit: mix(vec![(0.0, tone(220.0, 55.0, 0.3, 0.16, Wave::Saw)), (0.0, hiss(0.2, 0.25, 1500.0))]),
        smash: mix(vec![(0.0, hiss(0.35, 0.3, 4000.0)), (0.0, tone(400.0, 80.0, 0.25, 0.1, Wave::Square))]),
        star: notes(&steps(&[523.0, 659.0, 784.0, 1047.0, 1319.0, 1568.0], 0.055), |_| 0.08, 0.09, Wave::Square, 1.0),
        count: one(tone(660.0, 660.0, 0.18, 0.14, Wave::Square)),
        go: mix(vec![(0.0, tone(1320.0, 1320.0, 0.4, 0.14, Wave::Square)), (0.0, tone(990.0, 990.0, 0.4, 0.08, Wave::Triangle))]),
        goal_in: notes(&steps(&[1047.0, 1319.0, 1047.0, 1319.0], 0.09), |_| 0.08, 0.07, Wave::Triangle, 1.0),
        finish: notes(&steps(&[523.0, 659.0, 784.0, 1047.0], 0.07), |_| 0.1, 0.09, Wave::Square, 1.0),
        die: mix(vec![(0.0, tone(600.0, 150.0, 0.7, 0.12, Wave::Triangle)), (0.0, tone(606.0, 152.0, 0.7, 0.06, Wave::Square))]),
        end: notes(&[(784.0, 0.0), (784.0, 0.13), (784.0, 0.26), (1047.0, 0.42), (988.0, 0.58), (1047.0, 0.71), (1319.0, 0.86)], |i| if i == 6 { 0.5 } else { 0.12 }, 0.1, Wave::Square, 1.0),
        enter: notes(&steps(&[392.0, 523.0, 659.0, 784.0], 0.05), |_| 0.07, 0.06, Wave::Square, 1.01),
    }
});

/// the kinds that have a budget
const JUMP: usize = 0;
const COIN: usize = 1;
const CLEAR: usize = 2;
const HIT: usize = 3;
const SMASH: usize = 4;
const FINISH: usize = 5;
const DIE: usize = 6;
const ENTER: usize = 7;

/// Plays the game's events (Sound.play), at most so many of a kind at once.
pub struct Player {
    recent: [Vec<f64>; 8],
}

impl Player {
    /// The sounds are made with the first player (in the scene's setup thread), once per run.
    pub fn new() -> Self {
        LazyLock::force(&SOUNDS);
        Self { recent: Default::default() }
    }

    /// at most n sounds of a kind within `window` seconds
    fn budget(&mut self, kind: usize, n: usize, window: f64, now: f64) -> bool {
        let Some(list) = self.recent.get_mut(kind) else { return false };
        list.retain(|&t| now - t < window);
        if list.len() >= n {
            return false;
        }
        list.push(now);
        true
    }

    /// now: s on a steady clock; volume: the master volume
    pub fn play(&mut self, e: Event, audio: &mut Audio, volume: f32, now: f64) {
        let s = &*SOUNDS;
        let pcm = match e {
            Event::Jump if self.budget(JUMP, 3, 0.15, now) => &s.jump,
            Event::AirJump if self.budget(JUMP, 3, 0.15, now) => &s.airjump,
            Event::Coin if self.budget(COIN, 4, 0.1, now) => &s.coin,
            Event::Clear(streak) if self.budget(CLEAR, 2, 0.1, now) => match s.clear.get(streak.clamp(0, 12) as usize) {
                Some(p) => p,
                None => return,
            },
            Event::Hit if self.budget(HIT, 3, 0.2, now) => &s.hit,
            Event::Smash if self.budget(SMASH, 3, 0.15, now) => &s.smash,
            Event::Star => &s.star,
            Event::Count => &s.count,
            Event::Go => &s.go,
            Event::GoalIn => &s.goal_in,
            Event::Finish if self.budget(FINISH, 3, 0.3, now) => &s.finish,
            Event::Die if self.budget(DIE, 2, 0.3, now) => &s.die,
            Event::End => &s.end,
            Event::Enter if self.budget(ENTER, 2, 0.5, now) => &s.enter,
            _ => return,
        };
        audio.play(pcm, volume);
    }

    pub fn stop_all(&mut self) {
        for l in &mut self.recent {
            l.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SOUNDS;

    /// Every sound is finite and below full scale, and the tones peak where the browser's do (sound.js
    /// rendered with an OfflineAudioContext: jump 0.120, count 0.139, die 0.178, at pan 0 / 0.707).
    #[test]
    fn sounds_are_sane() {
        let s = &*SOUNDS;
        let mut list = vec![
            ("jump", &s.jump),
            ("airjump", &s.airjump),
            ("coin", &s.coin),
            ("hit", &s.hit),
            ("smash", &s.smash),
            ("star", &s.star),
            ("count", &s.count),
            ("go", &s.go),
            ("goalIn", &s.goal_in),
            ("finish", &s.finish),
            ("die", &s.die),
            ("end", &s.end),
            ("enter", &s.enter),
        ];
        list.extend(s.clear.iter().map(|p| ("clear", p)));
        let peak = |pcm: &[f32]| pcm.iter().fold(0.0_f32, |m, v| m.max(v.abs()));
        for (name, pcm) in list {
            assert!(pcm.iter().all(|v| v.is_finite()), "{name}");
            let p = peak(pcm);
            assert!(p > 0.01 && p < 1.0, "{name}: peak {p}");
        }
        for (pcm, want) in [(&s.jump, 0.120), (&s.count, 0.139), (&s.die, 0.178)] {
            assert!((peak(pcm) - want).abs() < 0.004, "peak {} instead of {want}", peak(pcm));
        }
    }
}
