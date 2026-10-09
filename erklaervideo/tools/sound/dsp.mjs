// The building blocks of the soundtrack: stereo tracks, oscillators, noise, filters that can sweep,
// envelopes, a reverb (Freeverb) and a ping-pong delay. Plain JavaScript, 48 kHz float.

export const SR = 48000;

/** seeded random numbers 0..1 (mulberry32) */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a seed from a string and a number */
export function seedOf(name, t) {
  let h = 2166136261;
  for (const ch of `${name}:${t}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export const midi = (m) => 440 * 2 ** ((m - 69) / 12);
/** D major pentatonic: D E F# A B, as MIDI notes from `lo` to `hi` */
export function pentatonic(lo, hi) {
  const out = [];
  for (let m = lo; m <= hi; m++) if ([2, 4, 6, 9, 11].includes(((m % 12) + 12) % 12)) out.push(m);
  return out;
}

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const smooth = (x) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};

/** a stereo track; it may start later on the story clock (`start`, s), for rendering one sound alone */
export class Track {
  constructor(seconds, start = 0) {
    this.start = start;
    this.n = Math.ceil(seconds * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
  }

  /** add a mono signal at t (s), panned (-1 left .. 1 right, moving from pan to panTo) */
  add(sig, t, gain = 1, pan = 0, panTo = pan) {
    const i0 = Math.round((t - this.start) * SR);
    const len = sig.length;
    const angle = (p) => ((clamp(p, -1, 1) + 1) * Math.PI) / 4;
    const still = pan === panTo;
    let gl = Math.cos(angle(pan)) * gain;
    let gr = Math.sin(angle(pan)) * gain;
    for (let i = 0; i < len; i++) {
      const j = i0 + i;
      if (j < 0 || j >= this.n) continue;
      if (!still && (i & 63) === 0) {
        const a = angle(pan + (panTo - pan) * (i / len));
        gl = Math.cos(a) * gain;
        gr = Math.sin(a) * gain;
      }
      this.L[j] += sig[i] * gl;
      this.R[j] += sig[i] * gr;
    }
  }

  /** add a stereo signal at t (s) */
  addStereo(l, r, t, gain = 1) {
    const i0 = Math.round((t - this.start) * SR);
    for (let i = 0; i < l.length; i++) {
      const j = i0 + i;
      if (j < 0 || j >= this.n) continue;
      this.L[j] += l[i] * gain;
      this.R[j] += r[i] * gain;
    }
  }

  /** mix another track into this one, where it sits on the story clock */
  mix(other, gain = 1) {
    const off = Math.round((other.start - this.start) * SR);
    for (let i = Math.max(0, -off); i < other.n; i++) {
      const j = off + i;
      if (j >= this.n) break;
      this.L[j] += other.L[i] * gain;
      this.R[j] += other.R[i] * gain;
    }
  }
}

/**
 * Loudness as EBU R128 measures it: K-weighted (a high shelf for how the head hears, a high pass
 * against rumble), the power of both channels over 400 ms, in LUFS. One value every 100 ms.
 */
export function momentary(L, R) {
  const k = (x) => {
    let y = Float32Array.from(x);
    for (const [b0, b1, b2, a1, a2] of [
      [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
      [1, -2, 1, -1.99004745483398, 0.99007225036621],
    ]) {
      const out = new Float32Array(y.length);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < y.length; i++) {
        const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = y[i];
        y2 = y1;
        y1 = v;
        out[i] = v;
      }
      y = out;
    }
    return y;
  };
  const kl = k(L);
  const kr = k(R);
  const power = new Float64Array(L.length + 1);
  for (let i = 0; i < L.length; i++) power[i + 1] = power[i] + kl[i] * kl[i] + kr[i] * kr[i];
  const hop = SR / 10;
  const win = 4 * hop;
  const out = [];
  for (let s = 0; s + win <= L.length; s += hop) {
    const ms = (power[s + win] - power[s]) / win;
    out.push(ms > 1e-12 ? -0.691 + 10 * Math.log10(ms) : -120);
  }
  return out;
}

/** samples for a length in seconds */
export const len = (s) => Math.max(1, Math.round(s * SR));

/** a sine whose frequency (Hz) may change: f is a number or a function of time (s) */
export function sine(dur, f, phase = 0) {
  const n = len(dur);
  const out = new Float32Array(n);
  let ph = phase;
  const fixed = typeof f === 'number';
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin(ph);
    ph += (2 * Math.PI * (fixed ? f : f(i / SR))) / SR;
  }
  return out;
}

/** a soft triangle (a few odd harmonics), for warmer pads */
export function triangle(dur, f, phase = 0) {
  const n = len(dur);
  const out = new Float32Array(n);
  let ph = phase;
  const fixed = typeof f === 'number';
  for (let i = 0; i < n; i++) {
    out[i] = 0.81 * (Math.sin(ph) - Math.sin(3 * ph) / 9 + Math.sin(5 * ph) / 25);
    ph += (2 * Math.PI * (fixed ? f : f(i / SR))) / SR;
  }
  return out;
}

/** a band-limited sawtooth (sum of harmonics below 8 kHz) */
export function saw(dur, f) {
  const n = len(dur);
  const out = new Float32Array(n);
  const H = Math.max(1, Math.floor(8000 / f));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= H; h++) v += Math.sin(h * ph) / h;
    out[i] = v * 0.55;
    ph += (2 * Math.PI * f) / SR;
  }
  return out;
}

export function white(dur, seed) {
  const r = rng(seed);
  const n = len(dur);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  return out;
}

/** pink noise (Paul Kellet's filter) */
export function pink(dur, seed) {
  const r = rng(seed);
  const n = len(dur);
  const out = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/**
 * State variable filter (topology-preserving), in place or into a copy. cutoff (Hz) and q may be
 * numbers or functions of time (s); type 'lp' | 'bp' | 'hp'. A band pass keeps unity gain at its peak.
 */
export function svf(input, type, cutoff, q = 0.707) {
  const out = new Float32Array(input.length);
  let ic1 = 0;
  let ic2 = 0;
  const cf = typeof cutoff === 'number' ? () => cutoff : cutoff;
  const qf = typeof q === 'number' ? () => q : q;
  let g = 0;
  let k = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  for (let i = 0; i < input.length; i++) {
    if ((i & 15) === 0) {
      const t = i / SR;
      const fc = clamp(cf(t), 10, SR * 0.45);
      g = Math.tan((Math.PI * fc) / SR);
      k = 1 / Math.max(0.05, qf(t));
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    }
    const x = input[i];
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    out[i] = type === 'lp' ? v2 : type === 'hp' ? x - k * v1 - v2 : k * v1;
  }
  return out;
}

/**
 * A second-order filter from the Audio EQ Cookbook (Robert Bristow-Johnson): 'peak' raises or
 * lowers a band around f0 by gainDb, 'highshelf' everything above f0.
 */
export function biquad(input, type, f0, gainDb = 0, q = 0.707) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === 'peak') {
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else {
    const sq = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 + (A - 1) * cos + sq);
    b1 = -2 * A * (A - 1 + (A + 1) * cos);
    b2 = A * (A + 1 + (A - 1) * cos - sq);
    a0 = A + 1 - (A - 1) * cos + sq;
    a1 = 2 * (A - 1 - (A + 1) * cos);
    a2 = A + 1 - (A - 1) * cos - sq;
  }
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** multiply by an envelope given as a function of the position 0..1 (or of seconds with byTime) */
export function shape(sig, env, byTime = false) {
  const n = sig.length;
  for (let i = 0; i < n; i++) sig[i] *= byTime ? env(i / SR) : env(i / n);
  return sig;
}

/** attack (s), then an exponential decay with a time constant (s) */
export function adEnv(attack, decay) {
  return (t) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));
}

/** sum signals (of different lengths) with gains */
export function sum(parts) {
  const n = Math.max(...parts.map(([s]) => s.length));
  const out = new Float32Array(n);
  for (const [s, g] of parts) for (let i = 0; i < s.length; i++) out[i] += s[i] * g;
  return out;
}

/** a short sine "bell": a few (inharmonic) partials with their own decays */
export function bell(f, decay = 1.2, bright = 0.5, dur = decay * 5) {
  // the high partials quieter than a real bell: bright enough to ring, soft on the ears
  const parts = [
    [1, 1, 1],
    [2.76, 0.28 * bright, 0.4],
    [5.4, 0.07 * bright, 0.2],
    [2, 0.22, 0.7],
  ];
  const n = len(dur);
  const out = new Float32Array(n);
  for (const [mul, amp, dk] of parts) {
    const w = (2 * Math.PI * f * mul) / SR;
    const tau = decay * dk;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const a = (t < 0.006 ? t / 0.006 : 1) * Math.exp(-t / tau);
      out[i] += Math.sin(w * i) * amp * a;
    }
  }
  return out;
}

/** Freeverb (Jezar's), stereo, on a whole track */
export function reverb(track, { room = 0.84, damp = 0.35, predelay = 0.02 } = {}) {
  const scale = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((x) => Math.round(x * scale));
  const alls = [556, 441, 341, 225].map((x) => Math.round(x * scale));
  const spread = Math.round(23 * scale);
  const pre = Math.round(predelay * SR);
  const out = new Track(track.n / SR);
  for (const [chan, src, off] of [[out.L, track.L, 0], [out.R, track.R, spread]]) {
    const cb = combs.map((c) => ({ buf: new Float32Array(c + off), i: 0, store: 0 }));
    const ab = alls.map((c) => ({ buf: new Float32Array(c + off), i: 0 }));
    for (let s = 0; s < track.n; s++) {
      const x = (s - pre >= 0 ? src[s - pre] : 0) * 0.015;
      let y = 0;
      for (const c of cb) {
        const o = c.buf[c.i];
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * room;
        if (++c.i >= c.buf.length) c.i = 0;
        y += o;
      }
      for (const a of ab) {
        const o = a.buf[a.i];
        a.buf[a.i] = y + o * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        y = o - y;
      }
      chan[s] = y;
    }
  }
  return out;
}

/** a ping-pong delay: left after `time`, right after twice that, fading */
export function pingPong(track, time = 0.32, feedback = 0.35) {
  const d = Math.round(time * SR);
  const out = new Track(track.n / SR);
  const bl = new Float32Array(d);
  const br = new Float32Array(d);
  let lpL = 0;
  let lpR = 0;
  let i = 0;
  for (let s = 0; s < track.n; s++) {
    const yl = bl[i];
    const yr = br[i];
    out.L[s] = yl;
    out.R[s] = yr;
    // the echoes get darker
    lpL += 0.25 * (yr - lpL);
    lpR += 0.25 * (yl - lpR);
    bl[i] = (track.L[s] + track.R[s]) * 0.5 + lpL * feedback;
    br[i] = lpR * feedback + track.R[s] * 0.0;
    if (++i >= d) i = 0;
  }
  return out;
}
