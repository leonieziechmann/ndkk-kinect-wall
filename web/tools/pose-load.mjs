// GPU load for the pose measurements (kinect-hub/pose-bench): renders one scene in headless Chrome
// and logs once a second "<unix ms> <frames rendered so far>", so that the scene's frame rate can be
// told apart for each phase of a measurement running meanwhile.
//   node tools/pose-load.mjs depth-shader --size 2560x1440 --seconds 200 --log .cache/pose-native/scene.log
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findBrowser } from './wall-launch.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const scene = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'depth-shader';
const [width, height] = opt('--size', '2560x1440').split('x').map(Number);
const seconds = Number(opt('--seconds', '120'));
const log = path.resolve(web, opt('--log', '.cache/pose-native/scene.log'));

process.env.KINECT_NO_REGISTER = '1';
const { createServer } = await import('vite');
const server = await createServer({ root: web, configFile: path.join(web, 'vite.config.js'), server: { port: 0 }, logLevel: 'error', clearScreen: false });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.goto(`${base}/scenes/${scene}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => globalThis.__kinectRuntime?.status().state === 'running', { timeout: 30000, polling: 100 });
  fs.writeFileSync(log, '');
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const frames = await page.evaluate(() => globalThis.__kinectRuntime.status().frames);
    fs.appendFileSync(log, `${Date.now()} ${frames}\n`);
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await browser.close();
  await server.close();
}
