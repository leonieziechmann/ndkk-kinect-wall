// The sounds, one per cue name (src/lib/sound.ts, set in the scenes). Each adds itself to the dry
// bus and sends some to the reverb and the delay. Everything is tuned to D major pentatonic, so the
// blips, pings and chimes sound together with the pad underneath. How loud a sound ends up in the
// mix is not set here but in LEVEL: tools/sound.mjs measures every cue and levels it to that.

import { SR, adEnv, bell, clamp, len, midi, pentatonic, pink, rng, saw, seedOf, shape, sine, smooth, sum, svf, triangle, white } from './dsp.mjs';

const HIGH = pentatonic(74, 98); // D5 .. D7: 11 notes
const MID = pentatonic(62, 86); // D4 .. D6: 11 notes
/** a note of a scale, the index kept inside it */
const pick = (scale, i) => scale[Math.max(0, Math.min(scale.length - 1, Math.floor(i)))];

/**
 * How loud each sound sits in the mix, in LUFS (EBU R128, 400 ms): its loudest moment, or for the
 * long textures (TEXTURES) what it mostly is. A cue's gain shifts it (gain 0.5: 6 dB quieter). The
 * whole track is brought to -16 LUFS afterwards, so what counts is how these relate: the pad lies
 * underneath, textures a little above it, blips and whooshes clearly above, the accents on top.
 */
export const LEVEL = {
  pad: -27,
  // textures
  pulses: -21, swarm: -19, shimmer: -21, trails: -21, data: -21, fluid: -21, specks: -24, sparkle: -22,
  // blips, pops, ticks
  tick: -26, pop: -21, select: -22, lock: -22, dots: -23, connect: -19, panels: -19,
  // movement
  whoosh: -15, swish: -17, scan: -19, zap: -21, laser: -20, word: -19, glint: -19, line: -21,
  // accents
  rise: -19, title: -17, build: -20, powerup: -19, ping: -16, chord: -17, lift: -18, grow: -19, dim: -18, drop: -19,
  ledreveal: -18, riser: -17, transform: -15, bloom: -18,
};
/** sounds measured by what they mostly are, not by their loudest moment */
export const TEXTURES = new Set(['pulses', 'swarm', 'shimmer', 'trails', 'data', 'fluid', 'specks', 'sparkle']);

/** put a mono sound on the buses */
function out(bus, sig, t, { gain = 1, pan = 0, panTo = pan, verb = 0.2, delay = 0 } = {}) {
  // where a sound is cut off, it fades out over 4 ms instead of clicking
  const f = Math.min(sig.length, Math.round(0.004 * SR));
  for (let i = 0; i < f; i++) sig[sig.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / f);
  bus.dry.add(sig, t, gain, pan, panTo);
  if (verb > 0) bus.verb.add(sig, t, gain * verb, pan, panTo);
  if (delay > 0) bus.delay.add(sig, t, gain * delay, pan, panTo);
}

/** a noise rush through a band pass that opens and closes with the loudness */
function rush(dur, seed, { lo = 250, hi = 2800, peak = 0.55, q = 0.8 } = {}) {
  const n = pink(dur, seed);
  const env = (x) => (x < peak ? smooth(x / peak) ** 1.2 : (1 - smooth((x - peak) / (1 - peak))) ** 1.3);
  const band = svf(n, 'bp', (t) => lo + (hi - lo) * env(t / dur), q);
  const body = svf(n, 'lp', 380, 0.7);
  return shape(sum([[band, 1], [body, 0.35]]), env);
}

/** a tiny pitch-dropping blip */
function blip(f, dur = 0.09, drop = 1.5, decay = 0.035) {
  const s = sine(dur, (t) => f * (1 + (drop - 1) * Math.exp(-t / 0.012)));
  return shape(s, adEnv(0.002, decay), true);
}

const SOUNDS = {
  whoosh(bus, c) {
    const dur = c.dur ?? 1;
    out(bus, rush(dur, seedOf('whoosh', c.t)), c.t, { gain: 0.5 * (c.gain ?? 1), pan: c.pan ?? 0, panTo: c.panTo ?? c.pan ?? 0, verb: 0.18 });
  },

  swish(bus, c) {
    const s = rush(0.36, seedOf('swish', c.t), { lo: 1200, hi: 6500, peak: 0.35, q: 0.9 });
    out(bus, s, c.t - 0.12, { gain: 0.42 * (c.gain ?? 1), pan: c.pan ?? 0, verb: 0.15 });
  },

  /** the very beginning: the first chord swells in and opens up, with air */
  rise(bus, c) {
    const dur = c.dur ?? 2;
    const total = dur + 0.6;
    const env = (x) => smooth(x / 0.75) * (1 - smooth((x - 0.82) / 0.18));
    [50, 57, 62, 66].forEach((m) => {
      for (const [det, pan] of [[-0.003, -0.5], [0.003, 0.5]]) {
        const s = svf(triangle(total, midi(m) * (1 + det)), 'lp', (t) => 250 + 2600 * smooth(t / dur) ** 2, 0.8);
        out(bus, shape(s, env), c.t, { gain: 0.05, pan, verb: 0.4 });
      }
    });
    out(bus, shape(svf(pink(total, seedOf('rise', c.t)), 'bp', (t) => 300 * 2 ** (3.5 * clamp(t / dur)), 0.8), env), c.t, { gain: 0.25, verb: 0.3 });
  },

  title(bus, c) {
    [81, 86, 90].forEach((m, i) => out(bus, bell(midi(m), 1.6, 0.3), c.t + i * 0.045, { gain: 0.11, pan: (i - 1) * 0.35, verb: 0.55, delay: 0.15 }));
  },

  build(bus, c) {
    const r = rng(seedOf('build', c.t));
    const dur = c.dur ?? 3;
    const hits = 14;
    for (let i = 0; i < hits; i++) {
      const t = c.t + (dur * (i + r() * 0.6)) / hits;
      const m = pick(MID, 4 + r() * 7);
      const tink = sum([
        [shape(sine(0.5, midi(m)), adEnv(0.001, 0.12), true), 1],
        [shape(sine(0.5, midi(m) * 2.76), adEnv(0.001, 0.05), true), 0.45],
        [shape(svf(white(0.03, seedOf('tk', t)), 'bp', 5000, 2), adEnv(0.001, 0.006), true), 0.5],
      ]);
      out(bus, tink, t, { gain: 0.07 + 0.04 * r(), pan: r() * 1.2 - 0.6, verb: 0.3 });
    }
    // the beam lands
    const t1 = c.t + dur;
    const thud = sum([
      [shape(sine(0.8, (t) => 70 + 50 * Math.exp(-t / 0.05)), adEnv(0.003, 0.18), true), 1],
      [shape(sine(0.3, (t) => midi(62) * (1 + 0.3 * Math.exp(-t / 0.01))), adEnv(0.002, 0.05), true), 0.35],
      [shape(svf(white(0.2, seedOf('thud', t1)), 'lp', 900), adEnv(0.001, 0.03), true), 0.4],
    ]);
    out(bus, thud, t1, { gain: 0.28, verb: 0.25 });
  },

  panels(bus, c) {
    const n = c.n ?? 24;
    const dur = c.dur ?? 3.8;
    const notes = pentatonic(74, 98);
    for (let i = 0; i < n; i++) {
      const t = c.t + (dur * i) / n;
      const m = notes[Math.floor((i / n) * notes.length)];
      const p = (c.pan ?? -0.8) + ((c.panTo ?? 0.8) - (c.pan ?? -0.8)) * (i / (n - 1));
      const b = sum([[blip(midi(m), 0.12, 1.6, 0.04), 1], [shape(svf(white(0.02, seedOf('pn', i)), 'hp', 6000), adEnv(0.001, 0.004), true), 0.3]]);
      out(bus, b, t, { gain: 0.1, pan: p, verb: 0.22 });
    }
    // the wall is on: a warm hum
    const t1 = c.t + dur * 0.92;
    const hum = shape(sum([[sine(2.5, midi(38)), 1], [sine(2.5, midi(50)), 0.6], [sine(2.5, midi(57)), 0.3], [svf(saw(2.5, midi(38)), 'lp', 400), 0.2]]), (x) => smooth(x / 0.2) * (1 - smooth((x - 0.3) / 0.7)));
    out(bus, hum, t1, { gain: 0.12, verb: 0.3 });
  },

  powerup(bus, c) {
    const dur = c.dur ?? 1.3;
    const env = (x) => smooth(x / 0.75) * (x > 0.75 ? 1 - smooth((x - 0.75) / 0.25) : 1);
    const f = (t) => 300 * 2 ** (2 * clamp(t / (dur * 0.8)));
    const tone = shape(sum([[sine(dur, f), 1], [sine(dur, (t) => f(t) * 3), 0.12]]), env);
    const air = shape(svf(pink(dur, seedOf('pu', c.t)), 'bp', (t) => 2 * f(t), 1.2), env);
    out(bus, tone, c.t, { gain: 0.06, verb: 0.3 });
    out(bus, air, c.t, { gain: 0.12, verb: 0.2 });
  },

  ping(bus, c) {
    const f = midi(86);
    const s = sum([
      [shape(sine(2.2, (t) => f * (1 - 0.012 * clamp(t / 0.5))), adEnv(0.003, 0.5), true), 1],
      [shape(sine(2.2, f / 2), adEnv(0.003, 0.35), true), 0.3],
    ]);
    out(bus, s, c.t, { gain: 0.14 * (c.gain ?? 1), pan: c.pan ?? 0, verb: 0.5, delay: 0.35 });
  },

  tick(bus, c) {
    const s = sum([
      [shape(svf(white(0.02, seedOf('tick', c.t)), 'bp', 5200, 2), adEnv(0.0005, 0.004), true), 0.8],
      [shape(sine(0.06, midi(105 - ((c.n ?? 0) % 3) * 2)), adEnv(0.001, 0.012), true), 0.5],
    ]);
    out(bus, s, c.t, { gain: 0.09 * (c.gain ?? 1), pan: c.pan ?? 0, verb: 0.12 });
  },

  scan(bus, c) {
    const dur = c.dur ?? 1.4;
    const src = sum([[saw(dur, midi(40)), 1], [pink(dur, seedOf('scan', c.t)), 0.6]]);
    const swept = svf(src, 'bp', (t) => 300 * 2 ** (3.3 * smooth(t / dur)), 5);
    const s = shape(swept, (x) => smooth(x / 0.12) * (1 - smooth((x - 0.75) / 0.25)));
    out(bus, s, c.t, { gain: 0.22, pan: c.pan ?? 0, panTo: c.panTo ?? c.pan ?? 0, verb: 0.2 });
  },

  /** the infrared pulses of the stage: four wave fronts, each every 4.4 / 2.42 s (Stage.pulseHit) */
  pulses(bus, c) {
    const end = c.t + (c.dur ?? 5);
    const period = 4.4 / 2.42;
    const times = [];
    for (let k = 0; k < 4; k++) for (let t = c.t + k * 0.5; t < end; t += period) times.push(t);
    times.sort((a, b) => a - b);
    times.forEach((t, i) => {
      const first = i === 0;
      const fade = clamp((end - t) / 1.2);
      const thum = sum([
        [shape(sine(0.6, (x) => 110 + 80 * Math.exp(-x / 0.03)), adEnv(0.002, first ? 0.3 : 0.16), true), 1],
        [shape(sine(0.3, (x) => midi(69) * (1 - 0.25 * smooth(x / 0.08))), adEnv(0.002, 0.045), true), 0.3],
        [shape(svf(white(0.06, seedOf('pl', t)), 'hp', 7000), adEnv(0.001, 0.012), true), 0.25],
      ]);
      out(bus, thum, t, { gain: (first ? 0.34 : 0.17) * (0.4 + 0.6 * fade), verb: first ? 0.35 : 0.12 });
    });
  },

  select(bus, c) {
    out(bus, shape(sine(0.08, midi(88)), adEnv(0.002, 0.02), true), c.t, { gain: 0.08, pan: c.pan ?? 0, verb: 0.2 });
    out(bus, shape(sine(0.2, midi(93)), adEnv(0.002, 0.05), true), c.t + 0.05, { gain: 0.08, pan: c.pan ?? 0, verb: 0.25 });
  },

  zap(bus, c) {
    const dur = c.dur ?? 0.8;
    const s = sine(dur, (t) => 600 * 2 ** (1.3 * (t / dur)));
    shape(s, (t) => (0.58 + 0.42 * Math.tanh(4 * (Math.sin(2 * Math.PI * 18 * t) + 0.2))) * smooth(t / 0.05) * (1 - smooth((t - dur + 0.15) / 0.15)), true);
    out(bus, svf(s, 'lp', 4000), c.t, { gain: 0.035, pan: c.pan ?? 0, panTo: c.panTo ?? 0, verb: 0.2 });
  },

  laser(bus, c) {
    const dur = c.dur ?? 1;
    const vib = (t) => 1 + 0.003 * Math.sin(2 * Math.PI * 6 * t);
    const beam = shape(sum([[sine(dur, (t) => midi(81) * vib(t)), 1], [sine(dur, (t) => midi(88) * vib(t)), 0.25], [sine(dur, (t) => midi(81) * 1.003 * vib(t)), 0.6]]), (x) => smooth(x / 0.5) * (1 - smooth((x - 0.85) / 0.15)));
    out(bus, beam, c.t, { gain: 0.045, pan: c.pan ?? 0, panTo: c.panTo ?? 0, verb: 0.3 });
    out(bus, rush(dur, seedOf('laser', c.t), { lo: 800, hi: 5000, peak: 0.7 }), c.t, { gain: 0.12, pan: c.pan ?? 0, panTo: c.panTo ?? 0, verb: 0.2 });
  },

  /** the picture flies into the room: a rush and a cloud of glittering grains */
  swarm(bus, c) {
    const dur = c.dur ?? 3;
    const r = rng(seedOf('swarm', c.t));
    const env = (x) => smooth(x / 0.7) * (1 - smooth((x - 0.82) / 0.18));
    out(bus, rush(dur + 0.3, seedOf('swarm-rush', c.t), { lo: 300, hi: 5200, peak: 0.75 }), c.t, { gain: 0.32, verb: 0.3 });
    const grains = 700;
    for (let g = 0; g < grains; g++) {
      // more of them where the flight is busiest
      let x = r();
      for (let k = 0; k < 4 && r() > env(x); k++) x = r();
      const note = pick(HIGH, (0.25 + 0.75 * x) * r() * HIGH.length + x * 5);
      const d = 0.012 + r() * 0.03;
      const grain = shape(sine(d, midi(note)), (y) => Math.sin(Math.PI * y) ** 2);
      out(bus, grain, c.t + x * dur, { gain: 0.03 * (0.3 + 0.7 * r()), pan: r() * 1.8 - 0.9, verb: 0.35 });
    }
  },

  shimmer(bus, c) {
    const dur = c.dur ?? 1.2;
    const r = rng(seedOf('shimmer', c.t));
    out(bus, shape(svf(white(dur, seedOf('sh', c.t)), 'hp', 6500), (x) => Math.sin(Math.PI * x) ** 2), c.t, { gain: 0.05, verb: 0.4 });
    for (let i = 0; i < 18; i++) out(bus, bell(midi(pick(HIGH, 4 + r() * 7)), 0.25, 0.4, 0.8), c.t + r() * dur, { gain: 0.025, pan: r() * 1.6 - 0.8, verb: 0.45 });
  },

  /** air that follows the waving hand (the motion of the lead person) */
  trails(bus, c, ctx) {
    const dur = c.dur ?? 4;
    const n = pink(dur, seedOf('trails', c.t));
    const m = (t) => ctx.motion(c.t + t, 'lead');
    const s = svf(n, 'bp', (t) => 500 + 3200 * m(t).speed, 1.1);
    shape(s, (t) => 0.15 + 0.85 * m(t).speed, true);
    shape(s, (x) => smooth(x / 0.15) * (1 - smooth((x - 0.85) / 0.15)));
    out(bus, s, c.t, { gain: 0.3, pan: 0, verb: 0.25 });
  },

  pop(bus, c) {
    const notes = [69, 74, 76, 78, 81, 83, 86];
    const f = midi(notes[(c.n ?? 0) % notes.length]);
    const s = sum([
      [shape(sine(0.3, (t) => f * (0.6 + 0.4 * smooth(t / 0.025))), adEnv(0.002, 0.07), true), 1],
      [shape(sine(0.3, f * 2), adEnv(0.002, 0.03), true), 0.2],
    ]);
    out(bus, s, c.t, { gain: 0.12 * (c.gain ?? 1), pan: c.pan ?? 0, verb: 0.22 });
  },

  lock(bus, c) {
    const beep = (m, d) => shape(sum([[sine(d + 0.05, midi(m)), 1], [sine(d + 0.05, midi(m) * 3), 0.15]]), (t) => (t < d ? 1 : Math.exp(-(t - d) / 0.01)) * smooth(t / 0.003), true);
    out(bus, beep(86, 0.045), c.t, { gain: 0.06, pan: c.pan ?? 0, verb: 0.15 });
    out(bus, beep(93, 0.07), c.t + 0.07, { gain: 0.06, pan: c.pan ?? 0, verb: 0.2 });
  },

  dots(bus, c) {
    const dur = c.dur ?? 1.4;
    const n = c.n ?? 30;
    const r = rng(seedOf('dots', c.t));
    for (let i = 0; i < n; i++) {
      const t = c.t + (dur * (i + r() * 0.8)) / n;
      out(bus, shape(sine(0.05, midi(pick(HIGH, 3 + r() * 8))), adEnv(0.001, 0.01), true), t, { gain: 0.035, pan: r() * 1.4 - 0.7, verb: 0.25 });
    }
  },

  connect(bus, c) {
    const dur = c.dur ?? 1.2;
    const notes = [74, 78, 81, 86, 90, 93];
    notes.forEach((m, i) => {
      const f = midi(m);
      const pluck = sum([
        [shape(sine(1.2, (t) => f * (1 + 0.004 * Math.exp(-t / 0.02))), adEnv(0.002, 0.28), true), 1],
        [shape(sine(1.2, f * 2), adEnv(0.002, 0.1), true), 0.25],
      ]);
      out(bus, pluck, c.t + (dur * i) / notes.length, { gain: 0.06, pan: -0.6 + (1.2 * i) / (notes.length - 1), verb: 0.35, delay: 0.1 });
    });
  },

  chord(bus, c) {
    [74, 78, 81, 88].forEach((m, i) => {
      for (const [det, pan] of [[-0.003, -0.5], [0.003, 0.5]]) {
        const s = shape(sum([[sine(2.5, midi(m) * (1 + det)), 1], [sine(2.5, midi(m) * 2 * (1 - det)), 0.15]]), adEnv(0.03, 0.6), true);
        out(bus, s, c.t + i * 0.012, { gain: 0.035, pan, verb: 0.5 });
      }
    });
  },

  lift(bus, c) {
    const dur = c.dur ?? 1.6;
    const env = (x) => smooth(x / 0.9) ** 1.5 * (x > 0.9 ? 1 - smooth((x - 0.9) / 0.1) : 1);
    const f = (t) => midi(57) * 2 ** ((17 / 12) * smooth(t / dur));
    const tone = shape(sum([[sine(dur, f), 1], [sine(dur, (t) => f(t) * 1.5), 0.35]]), env);
    out(bus, tone, c.t, { gain: 0.06, verb: 0.4 });
    out(bus, shape(svf(pink(dur, seedOf('lift', c.t)), 'bp', (t) => 500 * 2 ** (3.6 * (t / dur)), 1), env), c.t, { gain: 0.25, verb: 0.3 });
  },

  grow(bus, c) {
    const dur = c.dur ?? 2;
    const env = (x) => x ** 2.2 * (x > 0.93 ? 1 - smooth((x - 0.93) / 0.07) : 1);
    const pad = shape(sum([[triangle(dur, midi(57)), 1], [triangle(dur, midi(62)), 0.8], [triangle(dur, midi(66)), 0.6]]), env);
    out(bus, svf(pad, 'lp', (t) => 400 + 2600 * (t / dur) ** 2), c.t, { gain: 0.06, verb: 0.4 });
    out(bus, shape(svf(pink(dur, seedOf('grow', c.t)), 'bp', (t) => 300 * 2 ** (3 * (t / dur)), 0.9), env), c.t, { gain: 0.18, verb: 0.3 });
  },

  /** the room goes dark: a low thump and a falling tone */
  dim(bus, c) {
    const s = sum([
      [shape(sine(1.2, (t) => midi(38) * (1 + 0.5 * Math.exp(-t / 0.04))), adEnv(0.004, 0.32), true), 1],
      [shape(sine(0.9, (t) => midi(69) * 2 ** (-smooth(t / 0.5))), adEnv(0.01, 0.25), true), 0.3],
      [shape(svf(white(0.3, seedOf('dim', c.t)), 'lp', 700), adEnv(0.002, 0.05), true), 0.5],
    ]);
    out(bus, s, c.t, { gain: 0.3, verb: 0.25 });
  },

  /** the room drops away: a falling rush and falling grains */
  drop(bus, c) {
    const dur = c.dur ?? 2.2;
    const r = rng(seedOf('drop', c.t));
    const n = pink(dur, seedOf('drop-n', c.t));
    const env = (x) => smooth(x / 0.25) * (1 - smooth((x - 0.35) / 0.65));
    out(bus, shape(svf(n, 'bp', (t) => 4000 * 2 ** (-4.3 * (t / dur)), 0.9), env), c.t, { gain: 0.32, verb: 0.3 });
    for (let g = 0; g < 260; g++) {
      const x = r() ** 1.4;
      const note = pick(HIGH, (1 - x) * (HIGH.length - 1) - r() * 3);
      out(bus, shape(sine(0.03, midi(note)), (y) => Math.sin(Math.PI * y) ** 2), c.t + x * dur, { gain: 0.02 * (0.3 + 0.7 * r()), pan: r() * 1.8 - 0.9, verb: 0.35 });
    }
  },

  /** data running through the pipeline: soft blips, left to right, again and again */
  data(bus, c) {
    const dur = c.dur ?? 3;
    const r = rng(seedOf('data', c.t));
    const step = 0.1;
    const notes = pentatonic(81, 100);
    for (let i = 0; i * step < dur; i++) {
      const t = c.t + i * step;
      const x = (i * step) / dur;
      const fade = smooth(x / 0.15) * (1 - smooth((x - 0.8) / 0.2));
      const cycle = ((i * step) % 0.8) / 0.8;
      const s = shape(sine(0.06, midi(notes[Math.floor(r() * notes.length)])), adEnv(0.001, 0.012), true);
      out(bus, s, t, { gain: 0.045 * fade * (i % 4 === 0 ? 1.4 : 1), pan: -0.8 + 1.6 * cycle, verb: 0.15, delay: 0.12 });
    }
  },

  /** the fluid on the wall: water that follows how much the people move */
  fluid(bus, c, ctx) {
    const t0 = c.t;
    const t1 = ctx.end;
    const dur = t1 - t0;
    const m = (t) => ctx.motion(t, 'all');
    const nl = pink(dur, seedOf('fl-l', t0));
    const nr = pink(dur, seedOf('fl-r', t0));
    // louder once the wall fills the picture (scene 8), out with the black at its end
    const level = (t) => {
      const a = smooth((t - t0) / 2.0) * (0.55 + 0.45 * smooth((t - ctx.scenes.wand) / 1.5));
      return a * (1 - smooth((t - (ctx.scenes.abspann - 1.0)) / 1.0));
    };
    for (const [n, pan, seed] of [[nl, -0.7, 1], [nr, 0.7, 2]]) {
      const lfo = (t) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.13 + 0.05 * seed) * t + seed);
      const s = svf(n, 'bp', (t) => 350 + 1500 * m(t0 + t).speed + 250 * lfo(t), 1.3);
      shape(s, (t) => level(t0 + t) * (0.2 + 0.8 * m(t0 + t).speed), true);
      out(bus, s, t0, { gain: 0.26, pan, verb: 0.3 });
    }
    // bubbles and drops where the hands move
    const r = rng(seedOf('fluid', t0));
    for (let t = t0; t < t1; ) {
      const mo = m(t);
      const rate = 1.5 + 11 * mo.speed;
      t += -Math.log(1 - r()) / rate;
      const lv = level(t);
      if (lv < 0.02) continue;
      const f0 = 280 + r() * 380;
      const d = 0.05 + r() * 0.07;
      const bub = shape(sine(d + 0.05, (x) => f0 * (1 + 0.9 * smooth(x / d))), (x) => Math.sin(Math.PI * clamp(x / d)) ** 1.5, true);
      out(bus, svf(bub, 'lp', 2400), t, { gain: 0.05 * lv * (0.4 + 0.6 * r()), pan: clamp(mo.x / 3 + (r() - 0.5) * 0.5, -0.9, 0.9), verb: 0.35 });
    }
  },

  line(bus, c) {
    const dur = c.dur ?? 1;
    const f = (t) => midi(62) * 2 ** ((7 / 12) * smooth(t / dur));
    const s = shape(sum([[sine(dur + 0.6, f), 1], [sine(dur + 0.6, (t) => 2 * f(t)), 0.25]]), (x) => smooth(x / 0.4) * (1 - smooth((x - 0.6) / 0.4)));
    out(bus, s, c.t, { gain: 0.05, verb: 0.5 });
  },

  /** LEDs coming on one after the other, then a little chord of bells */
  ledreveal(bus, c) {
    const n = c.n ?? 40;
    const dur = c.dur ?? 1.6;
    const r = rng(seedOf('led', c.t));
    const notes = pentatonic(74, 102);
    const p0 = c.pan ?? -0.8;
    const p1 = c.panTo ?? 0.8;
    const g = c.gain ?? 1;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      const t = c.t + dur * x * (0.92 + 0.08 * r());
      const m = notes[Math.min(notes.length - 1, Math.floor(x * (notes.length - 1) + r() * 2))];
      out(bus, blip(midi(m), 0.08, 1.4, 0.022), t, { gain: 0.05 * g, pan: p0 + (p1 - p0) * x, verb: 0.3 });
    }
    out(bus, shape(svf(white(dur, seedOf('led-air', c.t)), 'hp', 5500), (x) => smooth(x) * (1 - smooth((x - 0.85) / 0.15))), c.t, { gain: 0.035 * g, pan: p0, panTo: p1, verb: 0.35 });
    [86, 90, 93, 98].forEach((m, i) => out(bus, bell(midi(m), 1.4, 0.5), c.t + dur + i * 0.035, { gain: 0.045 * g, pan: p1 * 0.6 + (i - 1.5) * 0.15, verb: 0.55, delay: 0.2 }));
  },

  /** sparse soft pings, like the specks of light behind the card */
  specks(bus, c, ctx) {
    const r = rng(seedOf('specks', c.t));
    const t1 = c.t + (c.dur ?? 8);
    for (let t = c.t + 0.5; t < t1 - 0.6; t += 0.25 + r() * 0.5) {
      const fade = 1 - smooth((t - (t1 - 1.4)) / 1.0);
      out(bus, bell(midi(pick(HIGH, 4 + r() * 7)), 0.7, 0.35, 2), t, { gain: 0.022 * fade, pan: 0.15 + r() * 0.75, verb: 0.6, delay: 0.2 });
    }
    void ctx;
  },

  glint(bus, c) {
    const dur = 0.8;
    const s = shape(svf(white(dur, seedOf('glint', c.t)), 'bp', (t) => 4000 + 5000 * (t / dur), 2), (x) => Math.sin(Math.PI * x) ** 2);
    const p0 = c.pan ?? -0.8;
    const p1 = c.panTo ?? 0.8;
    out(bus, s, c.t, { gain: 0.07 * (c.gain ?? 1), pan: p0, panTo: p1, verb: 0.4 });
    [86, 90, 93, 98, 102].forEach((m, i) => out(bus, bell(midi(m), 0.5, 0.4, 1.5), c.t + 0.1 + i * 0.12, { gain: 0.02 * (c.gain ?? 1), pan: p0 + ((p1 - p0) * i) / 4, verb: 0.5 }));
  },

  /** the flag twinkles: random pings, many more in the burst of the change */
  sparkle(bus, c, ctx) {
    const r = rng(seedOf('sparkle', c.t));
    const t1 = c.t + (c.dur ?? 8);
    const change = ctx.cue('transform')?.t ?? Infinity;
    const black = ctx.cue('black', c.t)?.t ?? t1;
    for (let t = c.t; t < t1; ) {
      const burst = Math.exp(-(((t - change - 0.3) / 0.6) ** 2));
      const rate = 6 + 34 * burst;
      t += -Math.log(1 - r()) / rate;
      const fade = smooth((t - c.t) / 0.8) * (1 - smooth((t - black) / 1.0));
      if (fade <= 0) continue;
      const star = r() < 0.15;
      const note = pick(HIGH, 4 + r() * 7);
      const s = bell(midi(note), star ? 0.9 : 0.3, star ? 0.7 : 0.3, star ? 2.5 : 1);
      out(bus, s, t, { gain: (star ? 0.03 : 0.016) * fade, pan: r() * 1.8 - 0.9, verb: 0.5, delay: star ? 0.25 : 0.08 });
    }
  },

  /** a word comes into focus: a soft breath of air with a tone in it */
  word(bus, c) {
    const dur = 0.85;
    const env = (x) => smooth(x / 0.55) * (1 - smooth((x - 0.6) / 0.4));
    out(bus, shape(svf(pink(dur, seedOf('word', c.t)), 'bp', (t) => 2400 * 2 ** (-2 * (t / dur)), 0.9), env), c.t - 0.1, { gain: 0.14 * (c.gain ?? 1), verb: 0.4 });
    out(bus, shape(sine(dur + 0.4, midi(74)), (x) => smooth(x / 0.5) * (1 - smooth((x - 0.5) / 0.5))), c.t, { gain: 0.025 * (c.gain ?? 1), verb: 0.5 });
  },

  /** up to the change: rising air, rising tones, and the reversed echo of the chord to come */
  riser(bus, c) {
    const dur = c.dur ?? 1.4;
    const env = (x) => x ** 2.4;
    out(bus, shape(svf(pink(dur, seedOf('riser', c.t)), 'bp', (t) => 400 * 2 ** (4.3 * (t / dur)), 1), env), c.t, { gain: 0.3, verb: 0.25 });
    const f = (t) => midi(62) * 2 ** (2 * (t / dur) ** 1.5);
    out(bus, shape(sum([[sine(dur, f), 1], [sine(dur, (t) => f(t) * 1.5), 0.5]]), env), c.t, { gain: 0.05, verb: 0.3 });
    // the reversed swell: the bells of the change, backwards, ending on it
    const ring = sum([86, 90, 93, 98].map((m) => [bell(midi(m), 1.2, 0.5, dur), 0.25]));
    ring.reverse();
    out(bus, ring, c.t, { gain: 0.09, verb: 0.6 });
  },

  /** the change to "Die Zukunft": bells, a deep bloom, a wash of shimmer */
  transform(bus, c) {
    [86, 90, 93, 98, 102].forEach((m, i) => out(bus, bell(midi(m), 1.8, 0.6), c.t + i * 0.028, { gain: 0.07, pan: -0.6 + i * 0.3, verb: 0.6, delay: 0.25 }));
    const sub = shape(sum([[sine(2.2, midi(38)), 1], [sine(2.2, midi(50)), 0.45], [sine(2.2, midi(57)), 0.2]]), (t) => smooth(t / 0.12) * Math.exp(-Math.max(0, t - 0.12) / 0.6), true);
    out(bus, sub, c.t, { gain: 0.2, verb: 0.25 });
    const wash = shape(svf(white(2.2, seedOf('wash', c.t)), 'hp', 5500), adEnv(0.02, 0.5), true);
    out(bus, wash, c.t, { gain: 0.06, pan: -0.5, verb: 0.6 });
    out(bus, svf(white(2.2, seedOf('wash2', c.t)), 'hp', 5500).map((v, i) => v * adEnv(0.02, 0.5)(i / SR)), c.t, { gain: 0.06, pan: 0.5, verb: 0.6 });
  },

  /** the last chord, "Die Zukunft ist bunt": D major with a ninth, warm and wide */
  bloom(bus, c, ctx) {
    const dur = c.dur ?? 4;
    const black = ctx.cue('black', c.t)?.t ?? c.t + dur;
    const total = black + 1.2 - c.t;
    const env = (t) => smooth(t / 0.7) * (1 - smooth((t - (black - c.t)) / 1.1));
    [50, 57, 66, 76, 81].forEach((m, i) => {
      for (const [det, pan] of [[-0.0028, -0.6], [0.0028, 0.6]]) {
        const s = sum([[triangle(total, midi(m) * (1 + det)), 1], [sine(total, midi(m) * 2 * (1 - det)), 0.12]]);
        const f = svf(s, 'lp', (t) => 600 + 2200 * smooth(t / 2));
        shape(f, env, true);
        out(bus, f, c.t, { gain: 0.028 * (i < 2 ? 1.2 : 1), pan, verb: 0.45 });
      }
    });
  },

  black() {
    // nothing to play: the pad and the textures fade with it (see pad() and the cues that use it)
  },
};

export function play(bus, c, ctx) {
  const f = SOUNDS[c.name];
  if (!f) {
    console.warn(`kein Sound für Cue "${c.name}"`);
    return;
  }
  f(bus, c, ctx);
}

/**
 * The pad underneath everything: a chord per scene, soft and slowly moving, out with each fade to
 * black. Open voicings in the middle (where small speakers still play), a soft root underneath.
 * The last scene sits on E minor 7 and gives way to the D major of the end (the bloom).
 */
export function pad(bus, ctx) {
  const S = ctx.scenes;
  const D = [38, [57, 64, 66]]; // D add9
  const Bm = [35, [50, 54, 61]]; // B minor add9
  const G = [31, [54, 59, 62]]; // G major 7
  const chords = [
    [S.aufbau, D],
    [S.sensor, Bm],
    [S.punktwolke, G],
    [S.flow, [33, [52, 59, 61]]], // A add9
    [S.ki, D],
    [S.masken, Bm],
    [S.daten, G],
    [S.wand, D],
    [S.abspann, [31, [54, 57, 59, 62]]], // G major 9
    [S.bunt, [40, [55, 59, 62]]], // E minor 7
  ];
  const blacks = ctx.cues.filter((c) => c.name === 'black');
  const changeAt = ctx.cue('transform')?.t ?? S.ende;
  // overall level: in at the start, out with every black, back with the next scene
  const level = (t) => {
    let a = smooth(t / 3);
    for (const b of blacks) {
      const next = chords.find(([s]) => s > b.t)?.[0] ?? S.ende;
      if (t >= b.t - 0.2 && t < next + 1.5) a *= t < next ? 1 - smooth((t - b.t + 0.2) / (b.dur ?? 1)) : smooth((t - next) / 1.5);
    }
    if (t > changeAt) a *= 1 - smooth((t - changeAt) / 0.5);
    return a;
  };
  chords.forEach(([start, [root, notes]], k) => {
    const end = (chords[k + 1]?.[0] ?? S.ende) + 1.2;
    const t0 = Math.max(0, start - 1.2);
    const dur = end - t0;
    const cross = (t) => smooth((t - (start - 1.2)) / 1.2) * (1 - smooth((t - (end - 1.2)) / 1.2));
    const env = (t) => cross(t0 + t) * level(t0 + t);
    notes.forEach((m, i) => {
      for (const [det, pan] of [[-0.004, -0.7], [0.004, 0.7]]) {
        const s = sum([[triangle(dur, midi(m) * (1 + det * (1 + i * 0.3))), 1], [sine(dur, midi(m) * 2 * (1 - det)), 0.08]]);
        const f = svf(s, 'lp', (t) => 750 + 300 * Math.sin(2 * Math.PI * 0.05 * (t0 + t) + i), 0.7);
        out(bus, shape(f, env, true), t0, { gain: 0.03, pan, verb: 0.35 });
      }
    });
    const low = shape(sum([[sine(dur, midi(root)), 1], [sine(dur, midi(root + 12)), 0.35]]), env, true);
    out(bus, low, t0, { gain: 0.035, verb: 0.2 });
  });
}
