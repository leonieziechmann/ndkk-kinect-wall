// Renders the video without opening the editor: starts Vite, loads tools/harness.html in a headless
// Chrome/Edge and drives Motion Canvas's renderer there.
//
//   npm run render                         the whole video → output/kinect-wand.mp4 (ffmpeg exporter)
//   npm run render -- --fps 30 --scale 0.5 a quicker preview
//   npm run stills -- 3 12.5 40            single frames (seconds) → output/stills/*.jpg
//   node tools/render.mjs cues             the sound cues of all scenes → output/cues.json (npm run sound)
//
// Options: --fps N, --scale S (resolution factor), --from S --to S (seconds), --out DIR (stills),
// --body puppe|lowpoly|natur (the look of the people), --project figuren (the comparison of the looks).
// The browser: CHROME_PATH, else Chrome/Edge/Chromium from the usual places.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the exporter finds the soundtrack by a path relative to the working directory
process.chdir(root);
const args = process.argv.slice(2);
const mode = args[0] === 'stills' ? 'stills' : args[0] === 'cues' ? 'cues' : 'video';
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const fps = Number(opt('fps', mode === 'stills' ? 30 : 60));
const scale = Number(opt('scale', mode === 'stills' ? 0.5 : 1));
const from = Number(opt('from', 0));
const to = Number(opt('to', Infinity));
const outDir = path.resolve(root, opt('out', 'output/stills'));
const query = new URLSearchParams();
if (opt('body')) query.set('body', opt('body'));
if (opt('project')) query.set('project', opt('project'));
/** the cues of the full video go to output/cues.json, those of another project to cues-<project>.json */
const cuesName = opt('project', 'project') === 'project' ? 'cues.json' : `cues-${opt('project')}.json`;
const times = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--')).map(Number);

function findBrowser() {
  const local = process.env.LOCALAPPDATA ?? '';
  const pw = '/opt/pw-browsers';
  const playwright = fs.existsSync(pw)
    ? fs.readdirSync(pw).filter((d) => d.startsWith('chromium-')).map((d) => path.join(pw, d, 'chrome-linux', 'chrome'))
    : [];
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${local}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    ...playwright,
  ].find((p) => p && fs.existsSync(p));
}

const exe = findBrowser();
if (!exe) {
  console.error('Kein Chrome/Edge gefunden. Pfad mit CHROME_PATH=... angeben.');
  process.exit(1);
}

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', server: { port: 9123, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  protocolTimeout: 0,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
let failed = false;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(0);
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || t.startsWith('[render]')) console.log(t);
  });
  page.on('pageerror', (e) => {
    failed = true;
    console.error('page error:', e.message);
  });
  await page.goto(new URL(`tools/harness.html?${query}`, base).href);
  await page.waitForFunction(() => window.__mc, { timeout: 120000 });

  if (mode === 'cues') {
    // run every scene once through (as for the length of the video) and collect the cue() calls
    const cues = await page.evaluate(async () => {
      const { project, PlaybackState, Renderer } = window.__mc;
      globalThis.__cues = [];
      const r = new Renderer(project);
      const settings = { ...project.meta.getFullRenderingSettings(), name: project.name, fps: 30, resolutionScale: 0.25 };
      r.stage.configure(settings);
      r.playback.fps = 30;
      r.playback.state = PlaybackState.Rendering;
      await r.reloadScenes(settings);
      await r.playback.recalculate();
      const cues = globalThis.__cues;
      globalThis.__cues = undefined;
      return cues;
    });
    // a scene may run more than once: keep each cue once
    const seen = new Set();
    const list = cues
      .filter((c) => {
        const k = JSON.stringify(c);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.t - b.t);
    fs.mkdirSync(path.join(root, 'output'), { recursive: true });
    fs.writeFileSync(path.join(root, 'output', cuesName), JSON.stringify(list, null, 1));
    console.log(`${list.length} Cues → output/${cuesName}`);
  } else if (mode === 'stills') {
    fs.mkdirSync(outDir, { recursive: true });
    const list = [...times].sort((a, b) => a - b);
    const shots = await page.evaluate(
      async ({ list, fps, scale }) => {
        const { project, PlaybackState, Renderer } = window.__mc;
        const r = new Renderer(project);
        const settings = { ...project.meta.getFullRenderingSettings(), name: project.name, fps, resolutionScale: scale };
        r.stage.configure(settings);
        r.playback.fps = fps;
        r.playback.state = PlaybackState.Rendering;
        await r.reloadScenes(settings);
        await r.playback.recalculate();
        await r.playback.reset();
        const out = [];
        for (const t of list) {
          const t0 = performance.now();
          await r.playback.seek(r.status.secondsToFrames(t));
          await r.stage.render(r.playback.currentScene, r.playback.previousScene);
          out.push({ t, data: r.stage.finalBuffer.toDataURL('image/jpeg', 0.9), ms: performance.now() - t0 });
          console.log(`[render] still ${t}s`);
        }
        return out;
      },
      { list, fps, scale },
    );
    for (const s of shots) {
      const file = path.join(outDir, `t${String(s.t.toFixed(2)).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(s.data.split(',')[1], 'base64'));
      console.log(`${file}  (${Math.round(s.ms)} ms)`);
    }
  } else {
    const { result, name } = await page.evaluate(
      async ({ fps, scale, from, to }) => {
        const { project, Renderer } = window.__mc;
        const r = new Renderer(project);
        const settings = {
          ...project.meta.getFullRenderingSettings(),
          name: project.name,
          fps,
          resolutionScale: scale,
          range: [from, to],
          exporter: { name: '@motion-canvas/ffmpeg', options: { fastStart: true, includeAudio: true } },
        };
        let last = 0;
        r.onFrameChanged.subscribe((f) => {
          if (f - last >= fps * 2) {
            last = f;
            console.log(`[render] ${(f / fps).toFixed(1)} s`);
          }
        });
        const done = new Promise((resolve) => r.onFinished.subscribe(resolve));
        r.render(settings);
        return { result: await done, name: project.name };
      },
      { fps, scale, from, to: Number.isFinite(to) ? to : 1e9 },
    );
    console.log(result === 0 ? `fertig: ${path.join(root, 'output', `${name}.mp4`)}` : `Rendern fehlgeschlagen (${result})`);
    if (result !== 0) failed = true;
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
