// Checks loadBake() in a real browser: starts the project's Vite dev server (vite.config.ts, with
// the Motion Canvas plugin), opens a page in headless Chromium and imports src/sim/bake.ts there.
// loadBake('example-twist') must fetch /bakes/example-twist.bin, cache it (same object on the
// second call), and sample the same values as Node reading the file directly.
//   npm run bake && node tools/simtest/browser.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { ROOT, load, writeSummary, r4 } from './lib.mjs';

const ID = 'example-twist';
const binFile = path.join(ROOT, 'bakes', `${ID}.bin`);
if (!fs.existsSync(binFile)) throw new Error(`${binFile} missing: run npm run bake first`);

// reference: the same file read in Node
const { mods: [sim], close } = await load('/src/sim/index.ts');
const buf = fs.readFileSync(binFile);
const ref = sim.BakedRod.fromBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const T = [0, 1.234, 3.3, 4.5];
const probe = (b) => {
  const pos = new Float32Array(3 * b.n), d1 = new Float32Array(3 * b.n);
  return T.map((t) => {
    b.frameSample(t, pos, d1);
    const mid = Math.floor(b.n / 2);
    return { t, mid: [pos[3 * mid], pos[3 * mid + 1], pos[3 * mid + 2]], d1: [d1[3 * mid], d1[3 * mid + 1], d1[3 * mid + 2]], twist: b.track('twist', t), writhe: b.track('writhe', t) };
  });
};
const expected = { n: ref.n, frames: ref.frames, fps: ref.fps, tracks: [...ref.trackNames], samples: probe(ref) };
await close();

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5390, strictPort: false, hmr: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const pw = '/opt/pw-browsers';
const browserPath = process.env.CHROME_PATH ?? fs.readdirSync(pw).filter((d) => d.startsWith('chromium-')).map((d) => path.join(pw, d, 'chrome-linux', 'chrome')).find((p) => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  const requests = [];
  page.on('request', (r) => r.url().includes('/bakes/') && requests.push(r.url()));
  await page.goto(`${url}bakes/${ID}.json`);
  const got = await page.evaluate(
    async (id, T, probeSrc) => {
      const m = await import('/src/sim/bake.ts');
      const [a, b] = await Promise.all([m.loadBake(id), m.loadBake(id)]);
      const c = await m.loadBake(id);
      const probe = new Function('b', 'T', `return (${probeSrc})(b);`);
      return { cached: a === b && b === c && m.bakeOf(id) === a, n: a.n, frames: a.frames, fps: a.fps, tracks: [...a.trackNames], samples: probe(a, T) };
    },
    ID, T, probe.toString(),
  );
  let maxDiff = 0;
  got.samples.forEach((s, k) => {
    const e = expected.samples[k];
    for (const key of ['mid', 'd1']) for (let i = 0; i < 3; i++) maxDiff = Math.max(maxDiff, Math.abs(s[key][i] - e[key][i]));
    maxDiff = Math.max(maxDiff, Math.abs(s.twist - e.twist), Math.abs(s.writhe - e.writhe));
  });
  const out = {
    url: `${url}bakes/${ID}.bin`, binRequests: requests.filter((u) => u.endsWith('.bin')).length, cached: got.cached,
    header: { n: got.n, frames: got.frames, fps: got.fps, tracks: got.tracks }, maxDiffVsNode: maxDiff,
    end: { twist: r4(got.samples[3].twist), writhe: r4(got.samples[3].writhe), Lk: r4(got.samples[3].twist + got.samples[3].writhe) },
    ok: got.cached && maxDiff === 0 && got.n === expected.n && got.frames === expected.frames,
  };
  console.log(JSON.stringify(out));
  writeSummary('browser', out);
  if (!out.ok) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
