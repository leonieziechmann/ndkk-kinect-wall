// Times pose models in headless Chrome on the real GPU (WebGPU), like lib/persons-pose.js runs them.
//   node tools/pose-bench.mjs n-512x448-fp16 n-384x320-fp16 [--runs 30] [--dir /.cache/pose-bench]
// The models are <web>/<dir>/<name>.onnx (the input size in the name), with a frame.png (512x424 gray
// infrared) next to them. The GPU is shared with the Kinect's depth decoding: keep the runs short.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './wall-launch.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const models = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const runs = opt('--runs', '30');
const dir = opt('--dir', '/.cache/pose-bench');

process.env.KINECT_NO_REGISTER = '1';
const { createServer } = await import('vite');
const server = await createServer({ root: web, configFile: path.join(web, 'vite.config.js'), server: { port: 0 }, logLevel: 'error', clearScreen: false });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('Fehler:', e.message));
  await page.goto(`${base}/tools/pose-bench.html?models=${models.map(encodeURIComponent).join(",")}&runs=${runs}&dir=${encodeURIComponent(dir)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__bench, { timeout: 600000, polling: 500 });
  const { info, results } = await page.evaluate(() => globalThis.__bench);
  console.log(`GPU: ${info.vendor} ${info.arch} ${info.desc ?? ''} · shader-f16: ${info.f16}`);
  console.log('model                 load ms | pre ms | run ms (p90) | post ms | candidates');
  for (const r of results) {
    if (r.error) console.log(`${r.name.padEnd(22)} Fehler: ${r.error}`);
    else console.log(`${r.name.padEnd(22)} ${String(r.loadMs).padStart(6)} | ${r.pre.toFixed(1).padStart(6)} | ${r.run.toFixed(1).padStart(6)} (${r.run90.toFixed(1)}) | ${r.post.toFixed(1).padStart(7)} | ${r.found}`);
  }
} finally {
  await browser.close();
  await server.close();
}
