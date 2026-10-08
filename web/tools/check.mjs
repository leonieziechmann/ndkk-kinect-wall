// npm run check [szene ...] [-- --seconds 4 --hub 8091 --size 1280x720 --headed]
//
// Renders scenes in headless Chrome/Edge on the real GPU (WebGPU works) and reports per scene:
// errors (runtime, WebGPU, WGSL, console), frame rate, Kinect frames and latency, and saves a
// screenshot to web/.cache/shots/<name>.png (look at it!). Without names: the scenes this worktree
// added or changed (in the main checkout: all scenes).
// Uses this worktree's running dev server (.cache/dev-server.json) or starts a temporary one.
// Exit code 1 if a scene has errors or does not render.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { normalizeHub } from './vite-plugin-kinect.js';
import { findBrowser } from './wall-launch.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { names: [], seconds: 4, hub: null, width: 1280, height: 720, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seconds') o.seconds = Number(argv[++i]) || 4;
    else if (a === '--hub') o.hub = argv[++i];
    else if (a === '--size') [o.width, o.height] = String(argv[++i]).split('x').map(Number);
    else if (a === '--headed') o.headed = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!a.startsWith('-')) o.names.push(a);
  }
  return o;
}

async function devServer() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(web, '.cache', 'dev-server.json'), 'utf8'));
    const r = await fetch(`${info.url}/__scenes?all=1`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return { url: info.url, close: async () => {} };
  } catch {
    // no dev server running in this worktree
  }
  process.env.KINECT_NO_REGISTER = '1'; // a throwaway server does not show up in the hub
  const { createServer } = await import('vite');
  const server = await createServer({ root: web, configFile: path.join(web, 'vite.config.js'), server: { port: 0 }, logLevel: 'error', clearScreen: false });
  await server.listen();
  const addr = server.httpServer.address();
  return { url: `http://127.0.0.1:${addr.port}`, close: () => server.close(), temporary: true };
}

/** Frames the hub received so far (its counter), to measure the sensor rate while a scene runs. */
async function hubFrames(hub) {
  try {
    const s = await (await fetch(`${hub}/api/status`, { signal: AbortSignal.timeout(1500) })).json();
    return { frames: s.frames, at: Date.now(), streaming: s.sensor?.state === 'streaming' };
  } catch {
    return null;
  }
}

async function checkScene(browser, base, name, o) {
  const page = await browser.newPage();
  await page.setViewport({ width: o.width, height: o.height });
  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warn' || t === 'warning') logs.push(`${t === 'error' ? 'Fehler' : 'Warnung'}: ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`Fehler: ${e.message}`));
  const q = o.hub ? `?hub=${encodeURIComponent(o.hub)}` : '';
  const url = `${base}/scenes/${name}/${q}`;
  const t0 = Date.now();
  let status = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page
      .waitForFunction(() => globalThis.__kinectRuntime && globalThis.__kinectRuntime.status().state !== 'loading', { timeout: 30000, polling: 100 })
      .catch(() => {});
    const readyMs = Date.now() - t0;
    const before = await hubFrames(o.hubUrl);
    await sleep(o.seconds * 1000);
    const after = await hubFrames(o.hubUrl);
    status = await page.evaluate(() => globalThis.__kinectRuntime?.status() ?? null);
    if (status) {
      status.readyMs = readyMs;
      if (before?.streaming && after?.streaming) status.hubFps = Math.round(((after.frames - before.frames) * 10000) / (after.at - before.at)) / 10;
    }
  } catch (e) {
    logs.push(`Fehler: ${e.message}`);
  }
  const shot = path.join(web, '.cache', 'shots', `${name}.png`);
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot }).catch((e) => logs.push(`Fehler: Screenshot: ${e.message}`));
  await page.close();
  return { name, url, status, logs, shot: path.relative(path.resolve(web, '..'), shot).replaceAll('\\', '/') };
}

function report(r) {
  const s = r.status;
  const problems = [];
  if (!s) problems.push('Runtime antwortet nicht (Seite kaputt? Konsole unten)');
  else {
    if (s.state === 'error') problems.push('Szene angehalten');
    for (const e of s.errors) problems.push(`${e.where}${e.count > 1 ? ` (${e.count}×)` : ''}: ${e.message}${e.stack ? `\n${e.stack}` : ''}`);
    if (s.state === 'running' && s.frames < 10) problems.push(`nur ${s.frames} Frames gerendert`);
    if (s.persons?.error) problems.push(`Personen-Tracker: ${s.persons.error}`);
    else if (s.persons && s.kinect?.received > 30 && !s.persons.results) problems.push('Personen-Tracker liefert keine Ergebnisse');
    if (s.hubFps !== undefined && s.hubFps < 22) {
      problems.push(
        `Die Kinect-Bildrate im Hub fiel auf ${s.hubFps} fps, solange die Szene lief: sie lastet die GPU so aus, dass die Tiefenberechnung (gleiche GPU) nicht mehr mitkommt. GPU-Last senken oder maxFps: 30 setzen.`,
      );
    }
  }
  // the runtime also logs its errors to the console: those are reported above already
  const logs = r.logs.filter((l) => !l.includes(`[${r.name}] `));
  const consoleErrors = logs.filter((l) => l.startsWith('Fehler'));
  const failed = problems.length > 0 || consoleErrors.length > 0;
  const k = s?.kinect;
  const data = !k ? '' : !k.connected ? `Kinect: keine Verbindung zu ${k.hub}` : k.received === 0 ? `Kinect: ${k.sensor}, keine Bilder` : `Kinect ${k.fps} fps · Latenz ${k.latencyMs} ms`;
  const hub = s?.hubFps !== undefined ? `Hub ${s.hubFps} fps` : null;
  const p = s?.persons;
  const persons = p ? `${p.count} Personen (Pose ${p.poseMs ?? '–'} ms ${p.provider ?? '?'} ×${p.poseRuns}, Maske ${p.ms ?? '–'} ms${p.delayMs ? `, verzögert ${p.delayMs} ms` : ''}${p.floor ? `, Boden ${p.floor} m` : ''})` : null;
  const line = s ? [`${s.fps} fps`, data, hub, persons, s.size ? s.size.join('×') : null, `bereit nach ${s.readyMs} ms`].filter(Boolean).join(' · ') : '';
  console.log(`${failed ? 'FEHLER' : 'OK    '}  ${r.name.padEnd(22)} ${line}`);
  if (k?.received > 0 && s.hubFps >= 22 && k.fps < 0.75 * s.hubFps) {
    logs.push(
      `Hinweis: Die Seite bekam nur ${k.fps} von ${s.hubFps} Kinect-Bildern/s (Latenz ${k.latencyMs} ms). Entweder blockiert frame() den Hauptthread zu lange, oder andere Szenen/Browserfenster belasten gerade CPU und GPU (dann später wiederholen).`,
    );
  }
  const indent = (t) => `        ${t.replaceAll('\n', '\n          ')}`;
  for (const p of problems) console.log(indent(p));
  for (const l of logs) console.log(indent(l.length > 400 ? `${l.slice(0, 400)} …` : l));
  console.log(`        Screenshot: ${r.shot}`);
  return failed;
}

const o = parseArgs(process.argv.slice(2));
if (o.help) {
  console.log('npm run check [szene ...] [-- --seconds 4 --hub 8091 --size 1280x720 --headed]');
  process.exit(0);
}
o.hubUrl = normalizeHub(o.hub ?? process.env.KINECT_HUB);
const exe = findBrowser();
if (!exe) {
  console.error('Kein Chrome/Edge gefunden. Pfad mit CHROME_PATH=... angeben.');
  process.exit(2);
}
const server = await devServer();
let failed = false;
try {
  const list = await (await fetch(`${server.url}/__scenes?all=1`)).json();
  const known = list.scenes.map((s) => s.name);
  const own = list.scenes.filter((s) => s.changed !== false).map((s) => s.name);
  const names = o.names.length ? o.names : own;
  if (!names.length) {
    console.log(`Dieser Worktree hat keine neuen oder geänderten Szenen. Namen angeben: npm run check <szene> (vorhanden: ${known.join(', ')})`);
    process.exit(0);
  }
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length) {
    console.error(`Unbekannte Szene(n): ${unknown.join(', ')}. Vorhanden: ${known.join(', ')}`);
    process.exit(1);
  }
  console.log(`Prüfe ${names.length} Szene(n) über ${server.url}${server.temporary ? ' (temporärer Dev-Server)' : ''}, je ${o.seconds} s, ${o.width}×${o.height} …`);
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: !o.headed,
    args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars'],
  });
  try {
    for (const name of names) failed = report(await checkScene(browser, server.url, name, o)) || failed;
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
