// Renders the animation without opening the editor: starts Vite, loads tools/harness.html in a
// headless Chrome/Edge and drives Motion Canvas's renderer there.
//
//   npm run render                       the whole video → output/kabel-wickeln.mp4, with chapters
//   npm run render -- --fps 30           the same with 30 fps (half the time)
//   npm run stills -- 3 12.5 40          single frames (seconds) → output/stills/*.jpg
//   npm run stills -- --project test 2   frames of the test project (model sheets, render tests)
//
// Options: --fps N, --scale S (resolution factor), --from S --to S (seconds), --out DIR (stills).
// The browser: CHROME_PATH, else Chrome/Edge/Chromium from the usual places.
//
// Every stage of the video is a chapter in the mp4 (src/lib/chapters.ts): players such as VLC
// jump from stage to stage.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the exporter writes relative to the working directory
process.chdir(root);
const args = process.argv.slice(2);
const mode = args[0] === 'stills' ? 'stills' : 'video';
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const fps = Number(opt('fps', mode === 'stills' ? 30 : 60));
const scale = Number(opt('scale', mode === 'stills' ? 0.5 : 1));
const from = Number(opt('from', 0));
const to = Number(opt('to', 1e9));
const outDir = path.resolve(root, opt('out', 'output/stills'));
/** `--project test` renders the test project (model sheets, render tests) */
const project = opt('project', 'project');
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

/** the ffmpeg that @ffmpeg-installer brings, else the one on the PATH */
async function ffmpegPath() {
  try {
    const m = await import('@ffmpeg-installer/ffmpeg');
    return (m.default ?? m).path;
  } catch {
    return 'ffmpeg';
  }
}

/** writes the chapters (one per stage, src/lib/chapters.ts) into the mp4, without re-encoding */
async function addChapters(file, scenes, fps) {
  const { CHAPTERS } = await server.ssrLoadModule('/src/lib/chapters.ts');
  const marks = [];
  for (const c of CHAPTERS) {
    const s = scenes.find((x) => x.name === c.scene);
    if (s) marks.push({ title: c.title, start: Math.round((s.first / fps) * 1000) });
  }
  if (!marks.length) return;
  const end = Math.round((Math.max(...scenes.map((s) => s.last)) / fps) * 1000);
  const meta = [';FFMETADATA1', 'title=Kabel richtig aufwickeln: Over-Under', ''];
  marks.forEach((m, i) => {
    meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${m.start}`, `END=${i + 1 < marks.length ? marks[i + 1].start : end}`, `title=${m.title}`, '');
  });
  const metaFile = path.join(root, 'output', 'chapters.txt');
  fs.writeFileSync(metaFile, meta.join('\n'));
  const tmp = file.replace(/\.mp4$/, '.tmp.mp4');
  const r = spawnSync(await ffmpegPath(), ['-y', '-loglevel', 'error', '-i', file, '-i', metaFile, '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', '-movflags', '+faststart', tmp], { stdio: 'inherit' });
  if (r.status === 0) {
    fs.renameSync(tmp, file);
    console.log(`${marks.length} Kapitel eingetragen`);
  } else console.log('Kapitel konnten nicht eingetragen werden');
}

const exe = findBrowser();
if (!exe) {
  console.error('Kein Chrome/Edge gefunden. Pfad mit CHROME_PATH=... angeben.');
  process.exit(1);
}

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn', server: { port: 9133, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  protocolTimeout: 0,
  // software WebGL (SwiftShader) must be allowed explicitly where there is no GPU
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-swiftshader'],
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
  await page.goto(new URL(`tools/harness.html?project=${project}`, base).href);
  await page.waitForFunction(() => window.__mc, { timeout: 120000 });

  if (mode === 'stills') {
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
        const scenes = r.playback.scenes.current.map((s) => ({ name: s.name, from: s.firstFrame / fps, to: s.lastFrame / fps }));
        await r.playback.reset();
        const out = [];
        for (const t of list) {
          const t0 = performance.now();
          await r.playback.seek(r.status.secondsToFrames(t));
          await r.stage.render(r.playback.currentScene, r.playback.previousScene);
          out.push({ t, data: r.stage.finalBuffer.toDataURL('image/jpeg', 0.9), ms: performance.now() - t0 });
        }
        return { out, scenes };
      },
      { list, fps, scale },
    );
    for (const s of shots.scenes) console.log(`  ${s.name.padEnd(16)} ${s.from.toFixed(2).padStart(7)} – ${s.to.toFixed(2).padStart(7)} s`);
    for (const s of shots.out) {
      const file = path.join(outDir, `t${String(s.t.toFixed(2)).padStart(6, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(s.data.split(',')[1], 'base64'));
      console.log(`${file}  (${Math.round(s.ms)} ms)`);
    }
  } else {
    const { result, name, scenes } = await page.evaluate(
      async ({ fps, scale, from, to }) => {
        const { project, Renderer } = window.__mc;
        const r = new Renderer(project);
        const settings = {
          ...project.meta.getFullRenderingSettings(),
          name: project.name,
          fps,
          resolutionScale: scale,
          range: [from, to],
          exporter: { name: '@motion-canvas/ffmpeg', options: { fastStart: true, includeAudio: false } },
        };
        let last = 0;
        r.onFrameChanged.subscribe((f) => {
          if (f - last >= fps * 5) {
            last = f;
            console.log(`[render] ${(f / fps).toFixed(1)} s`);
          }
        });
        const done = new Promise((resolve) => r.onFinished.subscribe(resolve));
        r.render(settings);
        const result = await done;
        const scenes = r.playback.scenes.current.map((s) => ({ name: s.name, first: s.firstFrame, last: s.lastFrame }));
        return { result, name: project.name, scenes };
      },
      { fps, scale, from, to },
    );
    const file = path.join(root, 'output', `${name}.mp4`);
    if (result === 0) {
      if (from === 0 && to >= 1e9) await addChapters(file, scenes, fps);
      console.log(`fertig: ${file}`);
    } else {
      console.log(`Rendern fehlgeschlagen (${result})`);
      failed = true;
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
