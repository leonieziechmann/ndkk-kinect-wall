// Vite plugin for the scene workspace. One dev server per git worktree; all of them use the same
// kinect-hub for the data.
//
//   /scenes/<name>/        runs scene <name>: serves scene.html, the runtime imports scenes/<name>/main.js
//   /wall/                 the output window for the LED wall (scene.html in output mode, see WALL.md)
//   /control/              the control center (presenter) for the output window
//   /__scenes              JSON: this dev server and its scenes (name, title, thumbnail, ...). Outside
//                          the main checkout only the scenes this worktree added or changed against
//                          main (git), so every worktree shows its own work; ?all=1 lists every scene.
//   /__thumb/<name>.jpg    thumbnail of a scene; the runtime POSTs one after a few seconds of running
//   /__wall/setup          GET/PUT the LED wall setup: one file shared by every worktree (the wall
//                          is the same physical thing): web/.cache/wall/setup.json of the main checkout
//   /__wall/projection     GET/PUT the projections (the default and one per scene, see lib/wall.js):
//                          shared like the setup, web/.cache/wall/projection.json of the main checkout
//   /__wall/show           GET/PUT the show (playlist) of this checkout: web/.cache/wall/show.json
//   /__wall/launch         POST: opens /wall/ as a kiosk window on the LED screen; GET: is it open;
//                          /__wall/close (POST) ends it
//
// Messages between the control center, the output window and wall scenes go through this dev
// server (HMR WebSocket event 'kinect:wall', relayed to every page), see lib/wall-bus.js.
//
// Editing a scene swaps it in place (no page reload, hub connection and GPU device stay). Editing
// lib/ reloads all pages. The dev server announces itself to the hub every few seconds, so
// http://127.0.0.1:8090/ lists the scenes of every worktree.
//
// Environment: KINECT_HUB (default http://127.0.0.1:8090), KINECT_DEV_LABEL (default: git branch),
// KINECT_NO_REGISTER=1 (no announcement, no .cache/dev-server.json; used by tools/check.mjs),
// KINECT_WALL_DIR (where setup.json lives), KINECT_ALL_SCENES=1 (no git filter).

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { launchWall, closeWall, alive, profileDir } from './wall-launch.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENTRY_FILES = ['main.js', 'main.ts'];
const ANNOUNCE_EVERY_MS = 5000;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_DOC_BYTES = 512 * 1024;
const LOADERS_ID = 'virtual:kinect-scene-loaders';
const WALL_DOCS = ['setup', 'projection', 'show'];
/** documents of the wall that every worktree shares (in the main checkout): the wall is one physical thing */
const SHARED_DOCS = new Set(['setup', 'projection']);
const CHANGED_EVERY_MS = 15000;

const HOT_SNIPPET = `
// added by tools/vite-plugin-kinect.js: saving this file swaps the scene in place
if (import.meta.hot) {
  import.meta.hot.accept((next) => { if (next) globalThis.__kinectRuntime?.hotSwap(next, import.meta.url); });
}
`;

export function normalizeHub(raw) {
  let h = String(raw || 'http://127.0.0.1:8090').trim();
  if (/^\d+$/.test(h)) h = `http://127.0.0.1:${h}`;
  else if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '');
}

function git(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

const gitAsync = (cwd, ...args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim()));
  });

function gitInfo(cwd) {
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return {
    branch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
    top: git(cwd, 'rev-parse', '--show-toplevel'),
    main: common ? path.dirname(common) : '', // the main checkout (all worktrees share its .git)
  };
}

const isInside = (file, dir) => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const text = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), 'application/json');

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export default function kinect() {
  const hub = normalizeHub(process.env.KINECT_HUB);
  const register = !process.env.KINECT_NO_REGISTER;
  let root = process.cwd();
  let scenesDir = '';
  let libDir = '';
  let cacheDir = '';
  let thumbsDir = '';
  let wallDir = '';
  let outDir = '';
  let isBuild = false;
  let gitState = { branch: '', top: '', main: '' };
  let label = '';
  let logger = console;
  let server = null;
  let devUrl = null;
  let hubOk = null;
  let timer = null;
  let soon = null;
  let cached = null;
  // scenes this worktree added or changed against main: null = show all (main checkout, no git)
  let changed = null;
  let changedAt = 0;
  let changedRunning = false;
  let changedSoon = null;
  let wallPid = 0;

  // ---------- which scenes are this worktree's own work ----------

  function filterOff() {
    return !!process.env.KINECT_ALL_SCENES || !gitState.top || ['main', 'master'].includes(gitState.branch) || path.resolve(gitState.top) === path.resolve(gitState.main);
  }

  function parseChanged(diff, untracked) {
    const set = new Set();
    for (const line of `${diff}\n${untracked}`.split('\n')) {
      const m = /^scenes\/([^/]+)\//.exec(line.trim().replaceAll('\\', '/'));
      if (m) set.add(m[1]);
    }
    return set;
  }

  /** The changed set, computed synchronously once (startup), then refreshed in the background. */
  function changedSync() {
    if (filterOff()) return null;
    const base = git(root, 'merge-base', 'HEAD', 'main') || git(root, 'merge-base', 'HEAD', 'origin/main');
    if (!base) return null;
    return parseChanged(git(root, 'diff', '--name-only', '--relative', base, '--', 'scenes'), git(root, 'ls-files', '--others', '--exclude-standard', '--', 'scenes'));
  }

  async function refreshChanged() {
    if (changedRunning || filterOff()) return;
    changedRunning = true;
    try {
      const base = (await gitAsync(root, 'merge-base', 'HEAD', 'main')) || (await gitAsync(root, 'merge-base', 'HEAD', 'origin/main'));
      if (!base) return;
      const [diff, untracked] = await Promise.all([
        gitAsync(root, 'diff', '--name-only', '--relative', base, '--', 'scenes'),
        gitAsync(root, 'ls-files', '--others', '--exclude-standard', '--', 'scenes'),
      ]);
      if (diff === null || untracked === null) return;
      const next = parseChanged(diff, untracked);
      changedAt = Date.now();
      const same = changed && next.size === changed.size && [...next].every((n) => changed.has(n));
      if (!same) {
        changed = next;
        scenesChanged();
      }
    } finally {
      changedRunning = false;
    }
  }

  function listScenes() {
    if (cached) return cached;
    if (!changedAt) {
      changed = changedSync();
      changedAt = Date.now();
    } else if (Date.now() - changedAt > CHANGED_EVERY_MS) {
      refreshChanged();
    }
    let dirs = [];
    try {
      dirs = fs.readdirSync(scenesDir, { withFileTypes: true });
    } catch {
      dirs = [];
    }
    const scenes = [];
    for (const d of dirs) {
      if (!d.isDirectory() || !NAME_RE.test(d.name)) continue; // _private, .hidden and odd names are skipped
      const dir = path.join(scenesDir, d.name);
      const entry = ENTRY_FILES.find((f) => fs.existsSync(path.join(dir, f)));
      if (!entry) continue;
      let meta = {};
      let error = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')) ?? {};
      } catch (e) {
        if (e.code !== 'ENOENT') error = `scene.json: ${e.message}`;
      }
      let modified = 0;
      try {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          if (f.isFile()) modified = Math.max(modified, fs.statSync(path.join(dir, f.name)).mtimeMs);
        }
      } catch {
        // folder vanished meanwhile
      }
      let thumb = null;
      try {
        const st = fs.statSync(path.join(thumbsDir, `${d.name}.jpg`));
        thumb = `/__thumb/${d.name}.jpg?v=${Math.round(st.mtimeMs)}`;
      } catch {
        // no thumbnail yet
      }
      scenes.push({
        name: d.name,
        entry,
        title: text(meta.title) || d.name,
        description: text(meta.description, 1000),
        author: text(meta.author),
        modified_ms: Math.round(modified),
        thumb,
        error,
        changed: changed ? changed.has(d.name) : true,
      });
    }
    scenes.sort((a, b) => a.name.localeCompare(b.name));
    cached = scenes;
    return scenes;
  }

  /** The scenes to show: this worktree's own (or every one with all). */
  const shownScenes = (all) => listScenes().filter((s) => all || s.changed);

  const serverInfo = () => ({ url: devUrl, label, branch: gitState.branch, worktree: gitState.top, hub, filtered: !!changed });

  async function announce() {
    if (!register || !devUrl) return;
    const scenes = shownScenes(false).map(({ entry, ...s }) => s);
    const body = JSON.stringify({ ...serverInfo(), pid: process.pid, scenes, total: listScenes().length });
    try {
      const r = await fetch(`${hub}/api/devservers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      if (hubOk !== true) logger.info(`  kinect-hub: angemeldet bei ${hub} – alle Worktrees: ${hub}/`, { timestamp: true });
      hubOk = true;
    } catch (e) {
      if (hubOk !== false) {
        logger.warn(
          `  kinect-hub unter ${hub} nicht erreichbar (${e.cause?.code ?? e.message}). Szenen laufen, bekommen aber keine Daten, bis der Hub läuft (siehe CLAUDE.md).`,
          { timestamp: true },
        );
      }
      hubOk = false;
    }
  }

  function scenesChanged() {
    cached = null;
    clearTimeout(soon);
    soon = setTimeout(announce, 300);
    server?.ws.send({ type: 'custom', event: 'kinect:scenes', data: {} });
  }

  function signOff() {
    clearInterval(timer);
    clearTimeout(soon);
    for (const kind of WALL_DOCS) fs.unwatchFile(docFile(kind));
    try {
      fs.rmSync(path.join(cacheDir, 'dev-server.json'), { force: true });
    } catch {
      // nothing to clean up
    }
    if (register && devUrl && hubOk) {
      fetch(`${hub}/api/devservers?url=${encodeURIComponent(devUrl)}`, { method: 'DELETE', signal: AbortSignal.timeout(1000) }).catch(() => {});
    }
  }

  async function servePage(req, res, next, file = 'scene.html') {
    try {
      const html = await fs.promises.readFile(path.join(root, file), 'utf8');
      send(res, 200, await server.transformIndexHtml(`/${file}`, html, req.originalUrl), 'text/html; charset=utf-8');
    } catch (e) {
      next(e);
    }
  }

  /** Only pages of this dev server may change things (browsers send Origin with POST/PUT). */
  function foreign(req) {
    const origin = req.headers.origin;
    return !!origin && origin !== devUrl && origin !== devUrl?.replace('127.0.0.1', 'localhost');
  }

  function thumbs(req, res, pathname) {
    const m = /^\/__thumb\/([a-z0-9][a-z0-9_-]{0,63})(?:\.jpg)?$/.exec(pathname);
    if (!m) return send(res, 404, 'not found');
    const name = m[1];
    const file = path.join(thumbsDir, `${name}.jpg`);
    if (req.method === 'POST') {
      if (foreign(req)) return send(res, 403, 'foreign origin');
      if (!listScenes().some((s) => s.name === name)) return send(res, 404, 'unknown scene');
      readBody(req, MAX_THUMB_BYTES).then(
        (body) => {
          if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return send(res, 400, 'expected a JPEG');
          try {
            writeAtomic(file, body);
          } catch (e) {
            return send(res, 500, String(e.message));
          }
          cached = null;
          clearTimeout(soon);
          soon = setTimeout(announce, 300);
          return send(res, 204, '');
        },
        (e) => send(res, e.status ?? 400, e.message),
      );
      return undefined;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'GET or POST');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'no thumbnail yet');
      res.setHeader('Access-Control-Allow-Origin', '*');
      send(res, 200, req.method === 'HEAD' ? '' : data, 'image/jpeg');
    });
    return undefined;
  }

  // ---------- LED wall: setup (shared by every worktree), show (this checkout), kiosk window ----------

  const docFile = (kind) => (SHARED_DOCS.has(kind) ? path.join(wallDir, `${kind}.json`) : path.join(cacheDir, 'wall', `${kind}.json`));

  function wallDoc(req, res, kind) {
    const file = docFile(kind);
    if (req.method === 'GET' || req.method === 'HEAD') {
      fs.readFile(file, 'utf8', (err, data) => {
        if (err) return sendJson(res, 200, {}); // none yet: the defaults apply
        return send(res, 200, req.method === 'HEAD' ? '' : data, 'application/json');
      });
      return undefined;
    }
    if (req.method !== 'PUT') return send(res, 405, 'GET or PUT');
    if (foreign(req)) return send(res, 403, 'foreign origin');
    readBody(req, MAX_DOC_BYTES).then(
      (body) => {
        let doc;
        try {
          doc = JSON.parse(body.toString('utf8'));
        } catch (e) {
          return send(res, 400, `JSON: ${e.message}`);
        }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return send(res, 400, 'expected a JSON object');
        try {
          writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
        } catch (e) {
          return send(res, 500, String(e.message));
        }
        return send(res, 204, '');
      },
      (e) => send(res, e.status ?? 400, e.message),
    );
    return undefined;
  }

  async function wallLaunch(req, res, pathname) {
    if (req.method === 'GET') return sendJson(res, 200, { running: alive(wallPid), pid: wallPid || null });
    if (req.method !== 'POST') return send(res, 405, 'GET or POST');
    if (foreign(req)) return send(res, 403, 'foreign origin');
    if (pathname === '/__wall/close') {
      const ok = await closeWall(wallPid);
      wallPid = 0;
      return sendJson(res, 200, { closed: ok });
    }
    let setup = {};
    try {
      setup = JSON.parse(fs.readFileSync(path.join(wallDir, 'setup.json'), 'utf8'));
    } catch {
      // defaults: the window opens where the browser likes
    }
    const w = setup?.output?.window;
    const win = w && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(w[k])) ? w : null;
    try {
      if (alive(wallPid)) await closeWall(wallPid);
      const r = launchWall({ url: `${devUrl}/wall/`, win, profile: profileDir(wallDir) });
      wallPid = r.pid;
      logger.info(`  LED-Ausgabe gestartet (PID ${r.pid})${win ? ` auf ${win.label || `${win.left},${win.top}`} ${win.width}×${win.height}` : ''}`, { timestamp: true });
      return sendJson(res, 200, { pid: r.pid, window: win, exe: r.exe });
    } catch (e) {
      return send(res, 500, e.message);
    }
  }

  return {
    name: 'kinect-scenes',

    config(_, env) {
      isBuild = env.command === 'build';
    },

    configResolved(config) {
      root = config.root;
      scenesDir = path.join(root, 'scenes');
      libDir = path.join(root, 'lib');
      cacheDir = path.join(root, '.cache');
      thumbsDir = path.join(cacheDir, 'thumbs');
      outDir = path.resolve(root, config.build.outDir);
      logger = config.logger;
      gitState = gitInfo(root);
      label = process.env.KINECT_DEV_LABEL || gitState.branch || path.basename(gitState.top || root);
      // one wall setup for every worktree: in the main checkout (web/ next to its .git)
      const mainWeb = gitState.main ? path.join(gitState.main, path.relative(gitState.top || root, root)) : root;
      wallDir = process.env.KINECT_WALL_DIR ? path.resolve(process.env.KINECT_WALL_DIR) : path.join(mainWeb, '.cache', 'wall');
    },

    resolveId(id) {
      return id === LOADERS_ID ? `\0${LOADERS_ID}` : null;
    },

    load(id) {
      if (id !== `\0${LOADERS_ID}`) return null;
      // dev: the runtime imports the one scene it shows (no glob: a new scene must not reload every page)
      return isBuild ? `export default import.meta.glob('/scenes/*/main.{js,ts}');` : 'export default null;';
    },

    transform(code, id) {
      if (isBuild) return null;
      const file = path.normalize(id.split('?')[0]);
      if (!isInside(file, scenesDir)) return null;
      const parts = path.relative(scenesDir, file).split(path.sep);
      if (parts.length !== 2 || !ENTRY_FILES.includes(parts[1])) return null;
      return { code: code + HOT_SNIPPET, map: null };
    },

    transformIndexHtml() {
      const cfg = isBuild ? { hub: 'same-origin', build: true } : serverInfo();
      return [{ tag: 'script', children: `window.__KINECT_DEV__ = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};`, injectTo: 'head-prepend' }];
    },

    handleHotUpdate({ file, server: s }) {
      const f = path.normalize(file);
      if (isInside(f, libDir) && !f.endsWith('.css')) {
        s.ws.send({ type: 'full-reload', path: '*' });
        return [];
      }
      if (isInside(f, scenesDir) && path.basename(f) === 'scene.json') {
        scenesChanged();
        return [];
      }
      return undefined;
    },

    configureServer(s) {
      server = s;
      s.middlewares.use((req, res, next) => {
        let url;
        let pathname;
        try {
          url = new URL(req.url, 'http://x');
          pathname = decodeURIComponent(url.pathname);
        } catch {
          return next();
        }
        if (pathname === '/__scenes') {
          const all = url.searchParams.has('all');
          return sendJson(res, 200, { devserver: serverInfo(), scenes: shownScenes(all), total: listScenes().length, all });
        }
        if (pathname.startsWith('/__thumb/')) return thumbs(req, res, pathname);
        const doc = /^\/__wall\/(setup|projection|show)$/.exec(pathname);
        if (doc) return wallDoc(req, res, doc[1]);
        if (pathname === '/__wall/launch' || pathname === '/__wall/close') {
          wallLaunch(req, res, pathname).catch((e) => send(res, 500, e.message));
          return undefined;
        }
        if (pathname === '/wall' || pathname === '/control') {
          res.statusCode = 302;
          res.setHeader('Location', `${pathname}/${url.search}`);
          return res.end();
        }
        if (pathname === '/wall/' && (req.method === 'GET' || req.method === 'HEAD')) return servePage(req, res, next);
        if (pathname === '/control/' && (req.method === 'GET' || req.method === 'HEAD')) return servePage(req, res, next, 'control.html');
        const m = /^\/scenes\/([^/]+)\/?$/.exec(pathname);
        if (m && NAME_RE.test(m[1]) && (req.method === 'GET' || req.method === 'HEAD')) {
          // a scene may bring its own index.html; then Vite serves that one
          if (fs.existsSync(path.join(scenesDir, m[1], 'index.html'))) return next();
          if (!pathname.endsWith('/')) {
            res.statusCode = 302;
            res.setHeader('Location', `/scenes/${m[1]}/${url.search}`);
            return res.end();
          }
          return servePage(req, res, next);
        }
        return next();
      });

      // control center <-> output window <-> wall scenes: relayed to the pages it is for. Every page
      // with a wall bus says hello first, so the relay knows its role and id (preview pictures only go
      // to control centers, not to every open scene page).
      const pages = new WeakMap(); // Vite's client object (stable per connection) -> { role, id }
      s.ws.on('kinect:wall', (msg, from) => {
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        if (typeof msg.from === 'string') pages.set(from, { role: String(msg.role ?? ''), id: msg.from });
        if (msg.type === 'hello') return;
        const payload = { type: 'custom', event: 'kinect:wall', data: msg };
        for (const c of s.ws.clients) {
          const page = pages.get(c);
          if (c === from || !page) continue;
          if (msg.to && msg.to !== page.role && msg.to !== page.id) continue;
          c.send(payload);
        }
      });
      // setup or show changed on disk (by this or another worktree's dev server): tell the pages
      for (const kind of WALL_DOCS) {
        fs.watchFile(docFile(kind), { interval: 1000 }, (cur, prev) => {
          if (cur.mtimeMs !== prev.mtimeMs) s.ws.send({ type: 'custom', event: 'kinect:wall-file', data: { kind } });
        });
      }

      s.watcher.on('all', (event, file) => {
        const f = path.normalize(file);
        if (!isInside(f, scenesDir)) return;
        if (event !== 'change') scenesChanged();
        else cached = null; // modification time
        if (changed && !changed.has(path.relative(scenesDir, f).split(path.sep)[0])) {
          clearTimeout(changedSoon);
          changedSoon = setTimeout(refreshChanged, 400); // a scene was touched for the first time
        }
      });

      s.httpServer?.once('listening', () => {
        const addr = s.httpServer.address();
        if (!addr || typeof addr === 'string') return;
        const host = addr.family === 'IPv6' || addr.family === 6 ? `[${addr.address}]` : addr.address;
        devUrl = `http://${host === '0.0.0.0' || host === '[::]' ? '127.0.0.1' : host}:${addr.port}`;
        if (register) {
          try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(
              path.join(cacheDir, 'dev-server.json'),
              JSON.stringify({ url: devUrl, pid: process.pid, hub, label, started: new Date().toISOString() }, null, 2),
            );
          } catch (e) {
            logger.warn(`  cannot write .cache/dev-server.json: ${e.message}`);
          }
          announce();
          timer = setInterval(announce, ANNOUNCE_EVERY_MS);
          timer.unref?.();
        }
        setTimeout(() => {
          const own = changed ? `  (zeigt die ${shownScenes(false).length} geänderten/neuen von ${listScenes().length} Szenen; alle: ${devUrl}/?all)` : '';
          logger.info(`\n  Szenen dieses Worktrees (${label}): ${devUrl}/${own}\n  LED-Wand: Steuerzentrale ${devUrl}/control/ · Ausgabe ${devUrl}/wall/\n  Hub: ${hub}   Alle Worktrees: ${hub}/\n`);
        }, 50);
      });
      s.httpServer?.once('close', signOff);
      process.once('exit', signOff);
    },

    // build: every scene gets its own page (copy of scene.html) and the list as a static file
    closeBundle() {
      if (!isBuild) return;
      const page = path.join(outDir, 'scene.html');
      if (!fs.existsSync(page)) return;
      const html = fs.readFileSync(page);
      const scenes = listScenes();
      for (const sc of scenes) {
        fs.mkdirSync(path.join(outDir, 'scenes', sc.name), { recursive: true });
        fs.writeFileSync(path.join(outDir, 'scenes', sc.name, 'index.html'), html);
        if (sc.thumb) {
          fs.mkdirSync(path.join(outDir, '__thumb'), { recursive: true });
          fs.copyFileSync(path.join(thumbsDir, `${sc.name}.jpg`), path.join(outDir, '__thumb', `${sc.name}.jpg`));
        }
      }
      fs.mkdirSync(path.join(outDir, 'wall'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'wall', 'index.html'), html);
      const control = path.join(outDir, 'control.html');
      if (fs.existsSync(control)) {
        fs.mkdirSync(path.join(outDir, 'control'), { recursive: true });
        fs.copyFileSync(control, path.join(outDir, 'control', 'index.html'));
      }
      const list = scenes.map((sc) => ({ ...sc, changed: true, thumb: sc.thumb ? `/__thumb/${sc.name}.jpg` : null }));
      fs.writeFileSync(path.join(outDir, '__scenes'), JSON.stringify({ devserver: null, scenes: list, total: list.length, all: true }));
    },
  };
}
