// node wall-bevy/bench/compare.mjs [--seconds 60] [--settle 8] [--scenes a,b] [--screen x,y,w,h]
//                                   [--hub 8090] [--only browser|native] [--out datei.json]
//
// Compares the two outputs of the LED wall on this machine: the browser output (/wall/ in the kiosk
// browser, with the kiosk's flags) and wall-bevy (the native app), one after the other, with the same
// show, hub, dev server and screen. Per output: frame rate and frame intervals of the scene (what the
// audience sees move), stutters, the work per frame in the main thread, CPU of the whole process
// tree, memory, on Windows also the GPU load per process (performance counters) and the CPU of the
// whole machine. Prints a table and writes everything to web/.cache/bench/.
//
// Run it while no output is open, e.g. after `start-wand.cmd -NoWall` (hub, dev server, control
// center without an output). Without --scenes both play the current show as it is; with --scenes each
// scene is measured alone (the show is swapped for a moment and restored afterwards).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const web = path.join(root, 'web');
const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const O = {
  seconds: Number(opt('seconds', 60)),
  settle: Number(opt('settle', 8)),
  scenes: opt('scenes', '') ? opt('scenes', '').split(',').filter(Boolean) : [],
  screen: opt('screen', ''),
  hub: opt('hub', ''),
  only: opt('only', ''),
  out: opt('out', ''),
};

let puppeteer;
let findBrowser;
let wallArgs;
let profileDir;
try {
  puppeteer = createRequire(path.join(web, 'package.json'))('puppeteer-core');
  ({ findBrowser, wallArgs, profileDir } = await import(pathToFileURL(path.join(web, 'tools', 'wall-launch.js')).href));
} catch (e) {
  console.error(`\n  web/ ist nicht eingerichtet (cd web && npm install): ${e.message}\n`);
  process.exit(1);
}

// ---------- environment ----------

function devServer() {
  try {
    return JSON.parse(fs.readFileSync(path.join(web, '.cache', 'dev-server.json'), 'utf8'));
  } catch {
    return null;
  }
}

const wallDir = process.env.KINECT_WALL_DIR ? path.resolve(process.env.KINECT_WALL_DIR) : path.join(web, '.cache', 'wall');
function setupWindow() {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(wallDir, 'setup.json'), 'utf8'))?.output?.window;
    if (w && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(w[k]))) return w;
  } catch {
    // no setup yet
  }
  return null;
}

function screenRect() {
  if (O.screen) {
    const [left, top, width, height] = O.screen.split(',').map(Number);
    if ([left, top, width, height].every(Number.isFinite)) return { left, top, width, height };
    console.error('  --screen erwartet x,y,breite,höhe');
    process.exit(1);
  }
  return setupWindow();
}

// ---------- the show (only with --scenes: one scene at a time, restored afterwards) ----------

const showFile = path.join(web, '.cache', 'wall', 'show.json');
let showBackup;
function setShow(scene) {
  if (showBackup === undefined) showBackup = fs.existsSync(showFile) ? fs.readFileSync(showFile, 'utf8') : null;
  const show = {
    entries: [{ id: 'bench', scene, label: '', duration: 3600, enabled: true, wait: false, params: {} }],
    auto: false,
    waitForEmpty: false,
    transition: 'cross',
    fade: 1,
  };
  fs.mkdirSync(path.dirname(showFile), { recursive: true });
  fs.writeFileSync(`${showFile}.tmp`, JSON.stringify(show, null, 1));
  fs.renameSync(`${showFile}.tmp`, showFile);
}
function restoreShow() {
  if (showBackup === undefined) return;
  try {
    if (showBackup === null) fs.rmSync(showFile, { force: true });
    else fs.writeFileSync(showFile, showBackup);
  } catch {
    console.error(`  Show nicht zurückgeschrieben: ${showFile}`);
  }
  showBackup = undefined;
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restoreShow();
    process.exit(130);
  });
}

// ---------- processes: CPU and memory of a process tree ----------

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 64 << 20 }, (err, out) => resolve(err ? null : out));
  });
}

/** A PowerShell script, passed encoded (no quoting rules in the way). */
const powershell = (script, timeout) => run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], timeout);

/** All processes: pid -> { ppid, name, cpu (s), mem (bytes) }. */
async function processes() {
  const map = new Map();
  if (WIN) {
    const out = await powershell(
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,PrivatePageCount | ForEach-Object { ($_.ProcessId, $_.ParentProcessId, $_.Name, ($_.KernelModeTime + $_.UserModeTime), $_.PrivatePageCount) -join [char]9 }',
    );
    for (const line of (out ?? '').split(/\r?\n/)) {
      const [pid, ppid, name, cpu, mem] = line.split('\t');
      if (pid) map.set(Number(pid), { ppid: Number(ppid), name, cpu: Number(cpu) / 1e7, mem: Number(mem) });
    }
  } else {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');
        const name = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')'));
        let mem = 0;
        const m = /^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${d}/smaps_rollup`, 'utf8'));
        if (m) mem = Number(m[1]) * 1024;
        map.set(Number(d), { ppid: Number(rest[1]), name, cpu: (Number(rest[11]) + Number(rest[12])) / 100, mem });
      } catch {
        // gone
      }
    }
  }
  return { at: Date.now(), map };
}

function tree(snap, rootPid) {
  const kids = new Map();
  for (const [pid, p] of snap.map) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(pid);
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (out.includes(p)) continue;
    out.push(p);
    stack.push(...(kids.get(p) ?? []));
  }
  return out.filter((p) => snap.map.has(p));
}

/** CPU (% of one core) and memory (MB) of a process tree, and of processes by name (the hub). */
function usage(s0, s1, rootPid, names = []) {
  const secs = (s1.at - s0.at) / 1000;
  const pids = new Set([...tree(s0, rootPid), ...tree(s1, rootPid)]);
  let cpu = 0;
  let mem = 0;
  for (const pid of pids) {
    const a = s0.map.get(pid);
    const b = s1.map.get(pid);
    if (b) {
      cpu += b.cpu - (a && a.name === b.name ? a.cpu : 0);
      mem += b.mem;
    }
  }
  const byName = {};
  for (const n of names) {
    let c = 0;
    for (const [pid, b] of s1.map) {
      if (b.name.toLowerCase() !== n.toLowerCase()) continue;
      const a = s0.map.get(pid);
      c += b.cpu - (a ? a.cpu : 0);
    }
    byName[n] = Math.round((c / secs) * 1000) / 10;
  }
  return { cpu: Math.round((cpu / secs) * 1000) / 10, memMB: Math.round(mem / 1048576), processes: pids.size, byName };
}

/** Windows: GPU load per process (all engines and 3D) and the CPU of the whole machine, while it runs. */
function gpuSampler(seconds) {
  if (!WIN) return { done: Promise.resolve(null) };
  const n = Math.max(1, Math.floor(seconds / 2));
  const ps = `$ErrorActionPreference='SilentlyContinue'
$gpu=@{}; $g3d=@{}; $cpu=0.0; $k=0
for ($i = 0; $i -le ${n}; $i++) {
  $e = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name,UtilizationPercentage
  $t = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -Property PercentProcessorTime).PercentProcessorTime
  if ($i -gt 0) {
    $k++; $cpu += [double]$t
    foreach ($x in $e) { if ($x.Name -match '^pid_(\\d+)_') { $p = $Matches[1]; $gpu[$p] = [double]$gpu[$p] + $x.UtilizationPercentage; if ($x.Name -like '*engtype_3D*') { $g3d[$p] = [double]$g3d[$p] + $x.UtilizationPercentage } } }
  }
  Start-Sleep -Seconds 2
}
$o = @{ samples = $k; cpuTotal = $(if ($k) { $cpu / $k } else { $null }); gpu = @{}; gpu3d = @{} }
foreach ($p in @($gpu.Keys)) { $o.gpu[$p] = $gpu[$p] / [math]::Max(1, $k) }
foreach ($p in @($g3d.Keys)) { $o.gpu3d[$p] = $g3d[$p] / [math]::Max(1, $k) }
$o | ConvertTo-Json -Compress -Depth 3`;
  const done = powershell(ps, (seconds + 60) * 1000).then((out) => {
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  });
  return { done };
}

function gpuOf(g, pids) {
  if (!g) return null;
  let all = 0;
  let d3 = 0;
  for (const p of pids) {
    all += Number(g.gpu?.[String(p)] ?? 0);
    d3 += Number(g.gpu3d?.[String(p)] ?? 0);
  }
  return { gpu3d: Math.round(d3 * 10) / 10, gpuAll: Math.round(all * 10) / 10, machineCpu: g.cpuTotal == null ? null : Math.round(g.cpuTotal * 10) / 10 };
}

// ---------- statistics ----------

const q = (v, p) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const r2 = (x) => Math.round(x * 100) / 100;

/** Frames in which the scene drew: rate, intervals, stutters (an interval of twice the usual or more). */
function cadence(times) {
  const dts = times.slice(1).map((t, i) => t - times[i]);
  const med = q(dts, 0.5);
  return {
    frames: times.length,
    fps: times.length > 1 ? r2(((times.length - 1) * 1000) / (times[times.length - 1] - times[0])) : 0,
    p50: r2(med),
    p95: r2(q(dts, 0.95)),
    p99: r2(q(dts, 0.99)),
    max: r2(q(dts, 1)),
    stutters: med ? dts.filter((d) => d > 1.9 * med).length : 0,
    over50: dts.filter((d) => d > 50).length,
  };
}
const work = (v) => ({ p50: r2(q(v, 0.5)), p95: r2(q(v, 0.95)), p99: r2(q(v, 0.99)), max: r2(q(v, 1)) });

// ---------- the browser output ----------

async function measureBrowser(dev, hub, rect, scene) {
  const exe = findBrowser();
  if (!exe) throw new Error('kein Chrome/Edge gefunden (CHROME_PATH=… setzen)');
  // the kiosk window's profile: start-wand gives this browser the output's priority, as wall-bevy
  const profile = profileDir(wallDir);
  fs.mkdirSync(profile, { recursive: true });
  const args = [...wallArgs('about:blank', rect, profile), '--remote-debugging-port=0'];
  if (!WIN) args.push('--no-sandbox', '--enable-unsafe-webgpu');
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: exe, headless: false, defaultViewport: null, ignoreDefaultArgs: true, args, timeout: 60000 });
  } catch (e) {
    throw new Error(`der Browser startet nicht (läuft das Kiosk-Fenster noch? Erst schließen): ${e.message}`);
  }
  const pid = browser.process()?.pid;
  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.evaluateOnNewDocument(() => {
      const N = 1 << 17;
      const T = new Float64Array(N);
      const D = new Float64Array(N);
      const R = new Uint8Array(N);
      const scenes = [];
      const longs = [];
      let n = 0;
      let rec = false;
      let stopAt = 0;
      let curT = -1;
      let drew = 0;
      const mark = (proto, names) => {
        for (const k of names) {
          const f = proto?.[k];
          if (typeof f !== 'function') continue;
          proto[k] = function (...a) {
            drew = 1;
            return f.apply(this, a);
          };
        }
      };
      mark(globalThis.GPUCanvasContext?.prototype, ['getCurrentTexture']);
      mark(globalThis.CanvasRenderingContext2D?.prototype, ['clearRect', 'fillRect', 'drawImage', 'putImageData']);
      try {
        new PerformanceObserver((l) => {
          if (rec) for (const e of l.getEntries()) longs.push([e.startTime, e.duration]);
        }).observe({ type: 'longtask' });
      } catch {
        // no long tasks
      }
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) =>
        raf((t) => {
          const t0 = performance.now();
          try {
            cb(t);
          } finally {
            const d = performance.now() - t0;
            if (rec) {
              if (t !== curT) {
                if (n < N) {
                  T[n] = t;
                  D[n] = d;
                  R[n] = drew;
                  n++;
                }
                curT = t;
              } else if (n > 0) {
                D[n - 1] += d;
                R[n - 1] |= drew;
              }
              if (t >= stopAt) rec = false;
            }
            drew = 0;
          }
        });
      globalThis.__bench = {
        start(ms) {
          n = 0;
          curT = -1;
          longs.length = 0;
          scenes.length = 0;
          stopAt = performance.now() + ms;
          rec = true;
          let last = null;
          const id = setInterval(() => {
            if (!rec) return clearInterval(id);
            const sc = globalThis.__kinectRuntime?.status?.().scene ?? null;
            if (sc !== last) scenes.push([performance.now(), sc]);
            last = sc;
          }, 250);
        },
        data: () => ({ t: Array.from(T.subarray(0, n)), d: Array.from(D.subarray(0, n)), r: Array.from(R.subarray(0, n)), longs, scenes }),
      };
    });
    const t0 = Date.now();
    await page.goto(`${dev.url}/wall/?hub=${encodeURIComponent(hub)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let ready = -1;
    for (let i = 0; i < 1200 && ready < 0; i++) {
      const st = await page.evaluate(() => {
        const s = globalThis.__kinectRuntime?.status?.();
        return s ? { state: s.state, scene: s.scene, frames: s.frames } : null;
      });
      if (st?.state === 'running' && st.frames > 0 && (!scene || st.scene === scene)) ready = Date.now() - t0;
      else await sleep(100);
    }
    if (ready < 0) throw new Error(`die Szene läuft nicht an${scene ? ` (${scene})` : ''}`);
    await sleep(O.settle * 1000);
    await page.evaluate((ms) => globalThis.__bench.start(ms), O.seconds * 1000);
    const gpu = gpuSampler(O.seconds);
    const s0 = await processes();
    // no DevTools traffic while it is measured
    const ws = browser.wsEndpoint();
    await browser.disconnect();
    await sleep(Math.max(0, O.seconds * 1000 - (Date.now() - s0.at)));
    const s1 = await processes();
    const b2 = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    const p2 = (await b2.pages()).find((p) => p.url().includes('/wall/'));
    const data = await p2.evaluate(() => globalThis.__bench.data());
    const status = await p2.evaluate(() => {
      const s = globalThis.__kinectRuntime?.status?.();
      return s && { scene: s.scene, state: s.state, errors: s.errors?.map((e) => `${e.where}: ${e.message}`) };
    });
    const g = await gpu.done;
    await b2.close();
    const u = usage(s0, s1, pid, ['kinect-hub.exe', 'kinect-hub', 'fake_hub']);
    const drawn = data.t.filter((_, i) => data.r[i]);
    return {
      readyMs: ready,
      drawn: cadence(drawn),
      display: cadence(data.t),
      work: work(data.d.filter((_, i) => data.r[i])),
      longTasks: data.longs.length,
      longTaskMax: r2(Math.max(0, ...data.longs.map((l) => l[1]))),
      ...u,
      ...gpuOf(g, tree(s1, pid)),
      perScene: perSceneBrowser(data),
      status,
    };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

function perSceneBrowser(data) {
  const out = {};
  const at = (t) => {
    let sc = null;
    for (const [s, name] of data.scenes) if (s <= t) sc = name;
    return sc ?? '-';
  };
  const by = {};
  data.t.forEach((t, i) => {
    if (!data.r[i]) return;
    const sc = at(t);
    (by[sc] ??= { t: [], d: [] }).t.push(t);
    by[sc].d.push(data.d[i]);
  });
  for (const [sc, v] of Object.entries(by)) out[sc] = { ...cadence(v.t), work: work(v.d) };
  return out;
}

// ---------- wall-bevy ----------

async function measureNative(dev, hub, rect) {
  const exe = path.join(root, 'wall-bevy', 'target', 'release', WIN ? 'wall-bevy.exe' : 'wall-bevy');
  if (!fs.existsSync(exe)) throw new Error(`wall-bevy ist nicht gebaut (${exe}; in wall-bevy: cargo build --release)`);
  const dir = path.join(web, '.cache', 'bench', `native-${Date.now()}`);
  const args = ['--hub', hub, '--web', web, '--dev', dev.url, '--shots', dir, '--seconds', String(O.settle + O.seconds + 3), '--shot-every', '100000'];
  if (rect) args.push('--screen', `${rect.left},${rect.top},${rect.width},${rect.height}`);
  const t0 = Date.now();
  const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
  const log = [];
  let warmed = false;
  let exited = false;
  const onLine = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (!line) continue;
      log.push(line);
      if (log.length > 200) log.shift();
      if (line.includes('alle Szenen vorbereitet')) warmed = true;
    }
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine);
  const ended = new Promise((resolve) => child.on('exit', () => resolve((exited = true))));
  for (let i = 0; i < 1800 && !warmed && !exited; i++) await sleep(100);
  if (!warmed) {
    child.kill();
    throw new Error(`wall-bevy startet nicht:\n    ${log.slice(-8).join('\n    ')}`);
  }
  const ready = Date.now() - t0;
  await sleep(O.settle * 1000);
  const gpu = gpuSampler(O.seconds);
  const s0 = await processes();
  await sleep(Math.max(0, O.seconds * 1000 - 300));
  const s1 = await processes();
  const g = await gpu.done;
  await Promise.race([ended, sleep(30000)]);
  if (!exited) child.kill();
  const u = usage(s0, s1, child.pid, ['kinect-hub.exe', 'kinect-hub', 'fake_hub']);
  let rows;
  try {
    rows = fs
      .readFileSync(path.join(dir, 'frames.csv'), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(','));
  } catch {
    throw new Error(`wall-bevy hat keine Bildzeiten geschrieben:\n    ${log.slice(-8).join('\n    ')}`);
  }
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));
  // t_ms,dt_ms,cpu_ms,submit_ms,scene,rendered,fade,setup,first
  const win = rows.filter((r) => Number(r[0]) >= O.settle * 1000 && Number(r[0]) <= (O.settle + O.seconds) * 1000);
  const drawnRows = win.filter((r) => r[5] === '1');
  const by = {};
  for (const r of drawnRows) {
    (by[r[4]] ??= { t: [], d: [] }).t.push(Number(r[0]));
    by[r[4]].d.push(Number(r[2]));
  }
  const perScene = {};
  for (const [sc, v] of Object.entries(by)) perScene[sc] = { ...cadence(v.t), work: work(v.d) };
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    readyMs: ready,
    drawn: cadence(drawnRows.map((r) => Number(r[0]))),
    display: cadence(win.map((r) => Number(r[0]))),
    work: work(drawnRows.map((r) => Number(r[2]))),
    ...u,
    ...gpuOf(g, tree(s1, child.pid)),
    perScene,
    status: { errors: report.errors },
  };
}

// ---------- report ----------

function line(label, b, n, f = (x) => x, better = 'low') {
  const fb = b == null ? '–' : f(b);
  const fn = n == null ? '–' : f(n);
  let mark = '';
  if (typeof b === 'number' && typeof n === 'number' && b !== n) mark = (better === 'low' ? n < b : n > b) ? '  ← nativ besser' : '  ← Browser besser';
  return `  ${label.padEnd(34)} ${String(fb).padStart(12)} ${String(fn).padStart(12)}${mark}`;
}

function print(title, b, n) {
  console.log(`\n${title}`);
  console.log(`  ${''.padEnd(34)} ${'Browser'.padStart(12)} ${'wall-bevy'.padStart(12)}`);
  const ms = (x) => `${x} ms`;
  const pc = (x) => `${x} %`;
  console.log(line('Bilder/s (Szene)', b?.drawn.fps, n?.drawn.fps, (x) => x, 'high'));
  console.log(line('Bildabstand p50', b?.drawn.p50, n?.drawn.p50, ms));
  console.log(line('Bildabstand p99', b?.drawn.p99, n?.drawn.p99, ms));
  console.log(line('Bildabstand max', b?.drawn.max, n?.drawn.max, ms));
  console.log(line('Ruckler (≥ 2× üblicher Abstand)', b?.drawn.stutters, n?.drawn.stutters));
  console.log(line('Bilder über 50 ms', b?.drawn.over50, n?.drawn.over50));
  console.log(line('Arbeit je Bild p50 (Hauptthread)', b?.work.p50, n?.work.p50, ms));
  console.log(line('Arbeit je Bild p99', b?.work.p99, n?.work.p99, ms));
  console.log(line('Arbeit je Bild max', b?.work.max, n?.work.max, ms));
  if (b?.longTasks != null) console.log(line('Long Tasks (> 50 ms)', b.longTasks, null));
  console.log(line('CPU (% eines Kerns, alle Prozesse)', b?.cpu, n?.cpu, pc));
  if (b?.gpu3d != null || n?.gpu3d != null) {
    console.log(line('GPU 3D', b?.gpu3d, n?.gpu3d, pc));
    console.log(line('GPU alle Engines', b?.gpuAll, n?.gpuAll, pc));
    console.log(line('CPU der ganzen Maschine', b?.machineCpu, n?.machineCpu, pc));
  }
  const hub = (x) => x && Object.values(x.byName).reduce((a, c) => a + c, 0);
  console.log(line('CPU des Hubs dabei', hub(b), hub(n), pc));
  console.log(line('Speicher', b?.memMB, n?.memMB, (x) => `${x} MB`));
  console.log(line('Start bis zum ersten Bild', b?.readyMs, n?.readyMs, ms));
}

// ---------- main ----------

const dev = devServer();
if (!dev?.url) {
  console.error('\n  Kein Dev-Server: erst `start-wand.cmd -NoWall` oder `cd web && npm run dev` starten.\n');
  process.exit(1);
}
try {
  await fetch(`${dev.url}/__scenes?all=1`, { signal: AbortSignal.timeout(3000) });
} catch {
  console.error(`\n  Der Dev-Server ${dev.url} antwortet nicht.\n`);
  process.exit(1);
}
const hub = O.hub || dev.hub || 'http://127.0.0.1:8090';
const rect = screenRect();
console.log(`\nVergleich Browser-Ausgabe ↔ wall-bevy: ${O.seconds} s je Ausgabe nach ${O.settle} s Anlauf`);
console.log(`  Dev-Server ${dev.url}, Hub ${hub}, Bildschirm ${rect ? `${rect.left},${rect.top} ${rect.width}×${rect.height}` : 'Hauptbildschirm (Fenster)'}`);
console.log('  Keine andere Ausgabe darf laufen; während der Messung nichts am Rechner tun.');

const results = { at: new Date().toISOString(), options: O, devServer: dev.url, hub, screen: rect, platform: process.platform, runs: {} };
const outFile = O.out || path.join(web, '.cache', 'bench', `compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const plan = O.scenes.length ? O.scenes : [null];
try {
  for (const scene of plan) {
    if (scene) setShow(scene);
    const r = (results.runs[scene ?? 'show'] = {});
    for (const side of ['browser', 'native']) {
      if (O.only && O.only !== side) continue;
      process.stdout.write(`\n  ${scene ?? 'Show'}: ${side === 'browser' ? 'Browser' : 'wall-bevy'} misst …`);
      try {
        r[side] = side === 'browser' ? await measureBrowser(dev, hub, rect, scene) : await measureNative(dev, hub, rect);
        process.stdout.write(' fertig');
      } catch (e) {
        r[side] = { error: e.message };
        process.stdout.write(` Fehler: ${e.message}`);
      }
      fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
      await sleep(2000);
    }
    console.log();
    print(scene ?? 'Show', r.browser?.error ? null : r.browser, r.native?.error ? null : r.native);
    if (!scene) {
      const names = new Set([...Object.keys(r.browser?.perScene ?? {}), ...Object.keys(r.native?.perScene ?? {})]);
      if (names.size > 1) {
        console.log('\n  je Szene (Bilder/s, Bildabstand p99, Arbeit je Bild p99):');
        for (const sc of names) {
          const b = r.browser?.perScene?.[sc];
          const n = r.native?.perScene?.[sc];
          const f = (x) => (x ? `${x.fps} fps, ${x.p99} ms, ${x.work.p99} ms` : '–');
          console.log(`  ${sc.padEnd(20)} Browser ${f(b).padEnd(28)} wall-bevy ${f(n)}`);
        }
      }
    }
  }
} finally {
  restoreShow();
}
console.log(`\n  Alle Zahlen: ${outFile}\n`);
