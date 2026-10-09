// The soundtrack. The scenes mark the moments that make a sound (cue() in src/lib/sound.ts);
// `node tools/render.mjs cues` collects them into output/cues.json. This tool turns them into sound
// (tools/sound/sfx.mjs) over a soft pad, levels every sound to its place in the mix (LEVEL in
// sfx.mjs), sends them through a reverb and a ping-pong delay, masters the mix to -16 LUFS and
// writes src/audio/soundtrack.m4a, which the project puts under the video. Sounds that follow the
// people (the air of the waving hand, the water of the fluid) read their motion from the same
// choreography the picture shows (tools/sound/motion.mjs).
//
//   npm run sound                         collects the cues, then mixes
//   node tools/sound.mjs                  mixes the cues collected last time
//   node tools/sound.mjs --levels         also lists every cue: measured, target, gain
//   node tools/sound.mjs --solo swarm     only these cues (comma separated), no pad: output/solo.wav
//
// Everything is synthesized here (no samples): same input, same sound.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { SR, Track, momentary, pingPong, reverb, smooth, svf } from './sound/dsp.mjs';
import { loadStory } from './sound/motion.mjs';
import { LEVEL, TEXTURES, pad, play } from './sound/sfx.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const solo = opt('solo')?.split(',');
const FFMPEG = process.env.FFMPEG ?? ffmpegInstaller.path;

/** loudness of the finished track (LUFS) and the highest sample (dBFS) */
const TARGET_I = -16;
const CEILING = -1.5;

const cuesFile = path.join(root, 'output', 'cues.json');
if (!fs.existsSync(cuesFile)) {
  console.error('output/cues.json fehlt: erst `node tools/render.mjs cues` (oder `npm run sound`).');
  process.exit(1);
}
const cues = JSON.parse(fs.readFileSync(cuesFile, 'utf8'));
const { SCENES, motion } = await loadStory(root);
const END = SCENES.ende;
const ctx = {
  scenes: SCENES,
  end: END,
  cues,
  motion,
  /** the first cue of that name at or after `after` */
  cue: (name, after = -Infinity) => cues.find((c) => c.name === name && c.t >= after),
};

// --- every sound alone, leveled, onto the buses -------------------------------------------------------

const t0 = Date.now();
const LEN = END + 2;
const bus = { dry: new Track(LEN), verb: new Track(LEN), delay: new Track(LEN) };
const buses = (seconds, start) => ({ dry: new Track(seconds, start), verb: new Track(seconds, start), delay: new Track(seconds, start) });

/** how loud a sound is on its own: its loudest moment, or for a texture what it mostly is (LUFS) */
function loudness(b, texture) {
  // the reverb will add to it; about this much
  const L = b.dry.L.map((v, i) => v + 0.7 * b.verb.L[i]);
  const R = b.dry.R.map((v, i) => v + 0.7 * b.verb.R[i]);
  const m = momentary(L, R);
  const top = Math.max(...m);
  if (!texture || top < -100) return top;
  const on = m.filter((v) => v > top - 15).sort((a, b) => a - b);
  return on[Math.floor(on.length * 0.9)];
}

/** put a rendered sound on the buses at the loudness it should have */
function level(b, name, gain, texture) {
  const measured = loudness(b, texture);
  if (measured < -100) return null;
  const target = LEVEL[name] + 20 * Math.log10(gain);
  const g = 10 ** ((target - measured) / 20);
  bus.dry.mix(b.dry, g);
  bus.verb.mix(b.verb, g);
  bus.delay.mix(b.delay, g);
  return { measured, target };
}

const report = [];
if (!solo) {
  const b = buses(LEN, 0);
  pad(b, ctx);
  report.push({ t: 0, name: 'pad', ...level(b, 'pad', 1, true) });
}
for (const c of cues) {
  if (solo && !solo.includes(c.name)) continue;
  if (LEVEL[c.name] === undefined) continue; // e.g. "black": nothing to play
  const b = buses(c.name === 'fluid' ? END - c.t + 1.6 : (c.dur ?? 0) + 11.6, c.t - 0.6);
  play(b, c, ctx);
  const r = level(b, c.name, c.gain ?? 1, TEXTURES.has(c.name));
  if (r) report.push({ t: c.t, name: c.name, ...r });
}
if (args.includes('--levels')) {
  for (const r of report) console.log(`${r.t.toFixed(2).padStart(6)} s  ${r.name.padEnd(10)} ${r.measured.toFixed(1).padStart(6)} → ${r.target.toFixed(1)} LUFS (${r.target - r.measured >= 0 ? '+' : ''}${(r.target - r.measured).toFixed(1)} dB)`);
}

// the echoes get a little room too
const echo = pingPong(bus.delay, 0.32, 0.38);
bus.verb.mix(echo, 0.35);
const wet = reverb(bus.verb, { room: 0.84, damp: 0.4, predelay: 0.025 });
const mix = new Track(LEN);
mix.mix(bus.dry, 1);
mix.mix(echo, 0.75);
mix.mix(wet, 3);

// --- master: no rumble, in and out with the picture (the video loops), loudness --------------------

const n = Math.round(END * SR);
const L = svf(svf(mix.L.subarray(0, n), 'hp', 35, 0.6), 'hp', 35, 0.6);
const R = svf(svf(mix.R.subarray(0, n), 'hp', 35, 0.6), 'hp', 35, 0.6);
for (let i = 0; i < n; i++) {
  const t = i / SR;
  // the last fade to black ends at the very end: silence, so the loop starts clean
  const g = smooth(t / 0.01) * (1 - smooth((t - (END - 1.25)) / 1.2));
  L[i] *= g;
  R[i] *= g;
}

const outDir = path.join(root, 'output');
fs.mkdirSync(outDir, { recursive: true });
const raw = path.join(outDir, solo ? 'solo-raw.wav' : 'soundtrack-raw.wav');
writeWav(raw, L, R);
const before = measure(raw);
fs.rmSync(raw);
const gainDb = TARGET_I - before.i;
const k = 10 ** (gainDb / 20);
for (let i = 0; i < n; i++) {
  L[i] *= k;
  R[i] *= k;
}
const squeezed = limit(L, R, 10 ** (CEILING / 20));
const wav = path.join(outDir, solo ? 'solo.wav' : 'soundtrack.wav');
writeWav(wav, L, R);

console.log(`${report.length} Klänge gemischt in ${((Date.now() - t0) / 1000).toFixed(1)} s; Lautheit ${before.i.toFixed(1)} LUFS → ${TARGET_I} (${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB), Limiter: ${squeezed}`);

if (solo) {
  console.log(`→ ${path.relative(root, wav)}`);
} else {
  const m4a = path.join(root, 'src', 'audio', 'soundtrack.m4a');
  fs.mkdirSync(path.dirname(m4a), { recursive: true });
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', m4a]);
  const after = measure(m4a);
  console.log(`→ ${path.relative(root, m4a)}: ${after.i.toFixed(1)} LUFS, Spitze ${after.tp.toFixed(1)} dBTP, ${(fs.statSync(m4a).size / 1e6).toFixed(1)} MB`);
}

// --- helpers ---------------------------------------------------------------------------------------

/** 32-bit float stereo WAV */
function writeWav(file, l, r) {
  const frames = l.length;
  const data = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    data.writeFloatLE(l[i], i * 8);
    data.writeFloatLE(r[i], i * 8 + 4);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); // IEEE float
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 8, 28);
  h.writeUInt16LE(8, 32);
  h.writeUInt16LE(32, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/** integrated loudness (LUFS) and true peak (dBTP) of a file, measured by ffmpeg (EBU R128) */
function measure(file) {
  const res = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const log = res.stderr ?? '';
  const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
  return { i: Number(m.input_i), tp: Number(m.input_tp) };
}

/**
 * A peak limiter with 5 ms lookahead: the gain is the minimum of what every sample around needs,
 * averaged over the same span (so it is down before the peak and never clicks), and comes back up
 * over 80 ms. Returns how much it had to work.
 */
function limit(l, r, ceiling) {
  const len = l.length;
  const look = Math.round(0.005 * SR);
  const need = new Float32Array(len);
  let count = 0;
  let deepest = 1;
  for (let i = 0; i < len; i++) {
    const p = Math.max(Math.abs(l[i]), Math.abs(r[i]));
    need[i] = p > ceiling ? ceiling / p : 1;
    if (need[i] < 1) count++;
    if (need[i] < deepest) deepest = need[i];
  }
  if (!count) return 'nicht nötig';
  // the minimum over i - look .. i + look (a monotonic queue) ...
  const lo = new Float32Array(len);
  const q = new Int32Array(len);
  let head = 0;
  let tail = 0;
  for (let j = 0; j < len + look; j++) {
    if (j < len) {
      while (tail > head && need[q[tail - 1]] >= need[j]) tail--;
      q[tail++] = j;
    }
    const i = j - look;
    if (i < 0) continue;
    while (q[head] < i - look) head++;
    lo[i] = need[q[head]];
  }
  // ... averaged over the same span: every value in it is at most what sample i needs
  const sum = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) sum[i + 1] = sum[i] + lo[i];
  const rel = 1 - Math.exp(-1 / (0.08 * SR));
  let g = 1;
  for (let i = 0; i < len; i++) {
    const a = Math.max(0, i - look);
    const b = Math.min(len, i + look + 1);
    const avg = Math.min(lo[i], (sum[b] - sum[a] + (2 * look + 1 - (b - a))) / (2 * look + 1));
    g = avg < g ? avg : g + (avg - g) * rel;
    l[i] *= g;
    r[i] *= g;
  }
  return `${((count / len) * 100).toFixed(2)} % der Samples, bis ${(20 * Math.log10(deepest)).toFixed(1)} dB`;
}
