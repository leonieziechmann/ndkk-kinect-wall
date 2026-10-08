// Runs the pose model in headless Chrome on the real GPU exactly as the persons worker does
// (tools/pose-ref.html) and writes the reference for kinect-hub/pose-bench next to the frames:
//   node tools/pose-ref.mjs clip04 clip10 [--runs 40] [--dir .cache/pose-native]
// Frames are <web>/<dir>/<name>.bin (512x424 u8 infrared). Writes <name>.browser.f32 (raw output
// 1x56x4704) and <name>.browser.txt (the poses PoseModel.detect returns, one per line: score, box
// u0 v0 u1 v1, 17 x (u, v, confidence)) and prints the timing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './wall-launch.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const frames = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const runs = opt('--runs', '40');
const dir = opt('--dir', '.cache/pose-native').replace(/^\/+/, '');

process.env.KINECT_NO_REGISTER = '1';
const { createServer } = await import('vite');
const server = await createServer({ root: web, configFile: path.join(web, 'vite.config.js'), server: { port: 0 }, logLevel: 'error', clearScreen: false });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('Fehler:', e.message));
  await page.goto(`${base}/tools/pose-ref.html?frames=${frames.map(encodeURIComponent).join(',')}&runs=${runs}&dir=/${encodeURIComponent(dir)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__poseRef, { timeout: 600000, polling: 500 });
  const r = await page.evaluate(() => globalThis.__poseRef);
  if (r.error) throw new Error(r.error);
  for (const f of r.results) {
    fs.writeFileSync(path.join(web, dir, `${f.name}.browser.f32`), Buffer.from(f.output, 'base64'));
    const lines = f.poses.map((p) => [p.score, ...p.box, ...p.kp].join(' '));
    fs.writeFileSync(path.join(web, dir, `${f.name}.browser.txt`), lines.map((l) => `${l}\n`).join(''));
    console.log(`${f.name}: ${f.poses.length} Posen`);
  }
  const fmt = (s) => `${s.med.toFixed(1)} ms (p90 ${s.p90.toFixed(1)}, min ${s.min.toFixed(1)})`;
  console.log(`GPU: ${r.info.vendor} ${r.info.arch} · shader-f16: ${r.info.f16} · Provider ${r.provider} · Laden ${r.loadMs} ms`);
  console.log(`detect() gesamt: ${fmt(r.detect)}`);
  console.log(`nur session.run: ${fmt(r.run)}`);
  fs.writeFileSync(path.join(web, dir, 'browser-times.json'), JSON.stringify({ detect: r.detectAll }));
} finally {
  await browser.close();
  await server.close();
}
