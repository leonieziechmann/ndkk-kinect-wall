// Vite plugin for the scene workspace. One dev server per git worktree; all of them use the same
// kinect-hub for the data.
//
//   /scenes/<name>/        runs scene <name>: serves scene.html, the runtime imports scenes/<name>/main.js
//   /__scenes              JSON: this dev server and its scenes (name, title, thumbnail, ...)
//   /__thumb/<name>.jpg    thumbnail of a scene; the runtime POSTs one after a few seconds of running
//
// Editing a scene swaps it in place (no page reload, hub connection and GPU device stay). Editing
// lib/ reloads all pages. The dev server announces itself to the hub every few seconds, so
// http://127.0.0.1:8090/ lists the scenes of every worktree.
//
// Environment: KINECT_HUB (default http://127.0.0.1:8090), KINECT_DEV_LABEL (default: git branch),
// KINECT_NO_REGISTER=1 (no announcement, no .cache/dev-server.json; used by tools/check.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENTRY_FILES = ['main.js', 'main.ts'];
const ANNOUNCE_EVERY_MS = 5000;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const LOADERS_ID = 'virtual:kinect-scene-loaders';

const HOT_SNIPPET = `
// added by tools/vite-plugin-kinect.js: saving this file swaps the scene in place
if (import.meta.hot) {
  import.meta.hot.accept((next) => { if (next) globalThis.__kinectRuntime?.hotSwap(next); });
}
`;

export function normalizeHub(raw) {
  let h = String(raw || 'http://127.0.0.1:8090').trim();
  if (/^\d+$/.test(h)) h = `http://127.0.0.1:${h}`;
  else if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '');
}

function gitInfo(cwd) {
  const run = (...args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    } catch {
      return '';
    }
  };
  return { branch: run('rev-parse', '--abbrev-ref', 'HEAD'), top: run('rev-parse', '--show-toplevel') };
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

export default function kinect() {
  const hub = normalizeHub(process.env.KINECT_HUB);
  const register = !process.env.KINECT_NO_REGISTER;
  let root = process.cwd();
  let scenesDir = '';
  let libDir = '';
  let cacheDir = '';
  let thumbsDir = '';
  let outDir = '';
  let isBuild = false;
  let git = { branch: '', top: '' };
  let label = '';
  let logger = console;
  let server = null;
  let devUrl = null;
  let hubOk = null;
  let timer = null;
  let soon = null;
  let cached = null;

  function listScenes() {
    if (cached) return cached;
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
      });
    }
    scenes.sort((a, b) => a.name.localeCompare(b.name));
    cached = scenes;
    return scenes;
  }

  const serverInfo = () => ({ url: devUrl, label, branch: git.branch, worktree: git.top, hub });

  async function announce() {
    if (!register || !devUrl) return;
    const scenes = listScenes().map(({ entry, ...s }) => s);
    const body = JSON.stringify({ ...serverInfo(), pid: process.pid, scenes });
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
    try {
      fs.rmSync(path.join(cacheDir, 'dev-server.json'), { force: true });
    } catch {
      // nothing to clean up
    }
    if (register && devUrl && hubOk) {
      fetch(`${hub}/api/devservers?url=${encodeURIComponent(devUrl)}`, { method: 'DELETE', signal: AbortSignal.timeout(1000) }).catch(() => {});
    }
  }

  async function servePage(req, res, next) {
    try {
      const html = await fs.promises.readFile(path.join(root, 'scene.html'), 'utf8');
      send(res, 200, await server.transformIndexHtml('/scene.html', html, req.originalUrl), 'text/html; charset=utf-8');
    } catch (e) {
      next(e);
    }
  }

  function thumbs(req, res, pathname) {
    const m = /^\/__thumb\/([a-z0-9][a-z0-9_-]{0,63})(?:\.jpg)?$/.exec(pathname);
    if (!m) return send(res, 404, 'not found');
    const name = m[1];
    const file = path.join(thumbsDir, `${name}.jpg`);
    if (req.method === 'POST') {
      // only pages of this dev server (browsers always send Origin with POST)
      const origin = req.headers.origin;
      if (origin && origin !== devUrl && origin !== devUrl?.replace('127.0.0.1', 'localhost')) return send(res, 403, 'foreign origin');
      if (!listScenes().some((s) => s.name === name)) return send(res, 404, 'unknown scene');
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_THUMB_BYTES) {
          send(res, 413, 'too large');
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        const body = Buffer.concat(chunks);
        if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return send(res, 400, 'expected a JPEG');
        try {
          fs.mkdirSync(thumbsDir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, body);
          fs.renameSync(tmp, file);
        } catch (e) {
          return send(res, 500, String(e.message));
        }
        cached = null;
        clearTimeout(soon);
        soon = setTimeout(announce, 300);
        send(res, 204, '');
      });
      req.on('error', () => {});
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
      git = gitInfo(root);
      label = process.env.KINECT_DEV_LABEL || git.branch || path.basename(git.top || root);
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
        let pathname;
        try {
          pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        } catch {
          return next();
        }
        if (pathname === '/__scenes') return send(res, 200, JSON.stringify({ devserver: serverInfo(), scenes: listScenes() }), 'application/json');
        if (pathname.startsWith('/__thumb/')) return thumbs(req, res, pathname);
        const m = /^\/scenes\/([^/]+)\/?$/.exec(pathname);
        if (m && NAME_RE.test(m[1]) && (req.method === 'GET' || req.method === 'HEAD')) {
          // a scene may bring its own index.html; then Vite serves that one
          if (fs.existsSync(path.join(scenesDir, m[1], 'index.html'))) return next();
          if (!pathname.endsWith('/')) {
            res.statusCode = 302;
            res.setHeader('Location', `/scenes/${m[1]}/${new URL(req.url, 'http://x').search}`);
            return res.end();
          }
          return servePage(req, res, next);
        }
        return next();
      });

      s.watcher.on('all', (event, file) => {
        const f = path.normalize(file);
        if (isInside(f, scenesDir) && event !== 'change') scenesChanged();
        else if (isInside(f, scenesDir)) cached = null; // modification time
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
          logger.info(`\n  Szenen dieses Worktrees (${label}): ${devUrl}/\n  Hub: ${hub}   Alle Worktrees: ${hub}/\n`);
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
      const list = scenes.map((sc) => ({ ...sc, thumb: sc.thumb ? `/__thumb/${sc.name}.jpg` : null }));
      fs.writeFileSync(path.join(outDir, '__scenes'), JSON.stringify({ devserver: null, scenes: list }));
    },
  };
}
