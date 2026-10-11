// Bakes the simulated cable shots (src/shots, registered in src/shots/index.ts) into
// bakes/<id>.bin, which the scenes load with loadBake(id), plus bakes/<id>.json (hash, timing).
// The TypeScript runs in Node through Vite (ssrLoadModule). A shot is baked again only when its
// hash changes: the source of its module and of everything it imports from src/, its options and
// bakeShot (src/shots/index.ts).
//
//   npm run bake                   every shot whose hash changed
//   npm run bake -- id1 id2        only these shots
//   npm run bake -- --force        bake even if the hash is unchanged
//   npm run bake -- --jobs 1       one at a time (default: 2 workers when more than one is due)
//   npm run bake -- --list         list the shots and whether their bake is current

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAKES = path.join(root, 'bakes');
const INDEX = 'src/shots/index.ts';

/** A Vite server that only transforms TypeScript for Node (no project plugins, no HMR). */
async function shotLoader() {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const index = await server.ssrLoadModule(`/${INDEX}`);
  return { server, index };
}

/** Bakes one shot and writes bakes/<id>.bin and bakes/<id>.json. */
function bakeOne(index, id, hash) {
  const def = index.SHOTS[id];
  const baked = index.bakeShot(def);
  const bin = Buffer.from(baked.toBinary());
  fs.mkdirSync(BAKES, { recursive: true });
  fs.writeFileSync(path.join(BAKES, `${id}.bin`), bin);
  const meta = {
    id, hash, duration: def.duration, fps: baked.fps, frames: baked.frames, nodes: baked.n, radius: baked.radius,
    tracks: baked.trackNames, substeps: baked.stats.substeps, bytes: bin.length,
    wallSeconds: +baked.stats.wallSeconds.toFixed(2), simSecondsPerWallSecond: +baked.stats.simSecondsPerWallSecond.toFixed(3),
    // what the simulation reports about itself (rod.stats): a good bake has no capped speeds, no
    // held slips and no warnings, and joint gaps well below a millimetre
    maxJointGap_mm: baked.stats.maxJointGap !== undefined ? +(baked.stats.maxJointGap * 1000).toFixed(3) : undefined,
    speedCapped: baked.stats.speedCapped, heldSlip: baked.stats.heldSlip, jointFixes: baked.stats.jointFixes,
    warnings: baked.stats.warnings,
  };
  const bad = [];
  if (baked.stats.speedCapped) bad.push(`${baked.stats.speedCapped} capped speeds`);
  if (baked.stats.heldSlip) bad.push(`${baked.stats.heldSlip} held-pinch slips`);
  if (baked.stats.warnings?.length) bad.push(`${baked.stats.warnings.length} warnings, first: ${baked.stats.warnings[0]}`);
  if (baked.stats.maxJointGap > 0.0005) bad.push(`joint gap ${(baked.stats.maxJointGap * 1000).toFixed(2)} mm`);
  if (bad.length) console.warn(`  ${id}: ${bad.join('; ')}`);
  fs.writeFileSync(path.join(BAKES, `${id}.json`), JSON.stringify(meta, null, 2));
  return meta;
}

// ------------------------------------------------------------------ hashing

/** Relative imports of a source file, resolved to files under src/. */
function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const base = path.resolve(path.dirname(file), m[1]);
    const hit = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (hit && hit.startsWith(path.join(root, 'src') + path.sep)) out.push(hit);
  }
  return out;
}

/** The file and everything it imports (transitively) from src/, sorted. */
function closure(file) {
  const seen = new Set([file]);
  const todo = [file];
  while (todo.length) for (const f of importsOf(todo.pop())) if (!seen.has(f)) { seen.add(f); todo.push(f); }
  return [...seen].sort();
}

function shotHash(index, def, file) {
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify({ id: def.id, duration: def.duration, fps: def.fps, substeps: def.substeps, iterations: def.iterations }));
  h.update(index.bakeShot.toString());
  for (const f of closure(file)) h.update(`\0${path.relative(root, f)}\0`).update(fs.readFileSync(f));
  return h.digest('hex');
}

/** id → source file of the module that exports the ShotDef (one of the modules index.ts imports). */
async function shotFiles(server, index) {
  const files = {};
  for (const file of importsOf(path.join(root, INDEX))) {
    const mod = await server.ssrLoadModule(`/${path.relative(root, file).split(path.sep).join('/')}`);
    for (const value of Object.values(mod)) {
      for (const def of Array.isArray(value) ? value : [value]) {
        if (def && typeof def === 'object' && index.SHOTS[def.id] === def) files[def.id] = file;
      }
    }
  }
  return files;
}

// ------------------------------------------------------------------ main

function currentHash(id) {
  try {
    if (!fs.existsSync(path.join(BAKES, `${id}.bin`))) return null;
    return JSON.parse(fs.readFileSync(path.join(BAKES, `${id}.json`), 'utf8')).hash;
  } catch {
    return null;
  }
}

const report = (m) =>
  console.log(`  ${m.id.padEnd(28)} ${String(m.duration).padStart(5)} s  ${String(m.nodes).padStart(4)} nodes  ${String(m.frames).padStart(5)} frames  ${(m.bytes / 1024).toFixed(0).padStart(6)} KB  ${m.wallSeconds.toFixed(1).padStart(6)} s (${m.simSecondsPerWallSecond.toFixed(2)} sim-s/s)`);

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const jobsArg = args.indexOf('--jobs');
  const maxJobs = jobsArg >= 0 ? Math.max(1, Number(args[jobsArg + 1]) || 1) : 2;
  const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--jobs');

  const { server, index } = await shotLoader();
  const ids = Object.keys(index.SHOTS);
  const unknown = wanted.filter((id) => !ids.includes(id));
  if (unknown.length) {
    console.error(`unknown shot(s): ${unknown.join(', ')}\nshots: ${ids.join(', ')}`);
    await server.close();
    process.exit(1);
  }
  const files = await shotFiles(server, index);
  const hashes = Object.fromEntries(ids.map((id) => [id, shotHash(index, index.SHOTS[id], files[id] ?? path.join(root, INDEX))]));
  const selected = wanted.length ? wanted : ids;
  const due = selected.filter((id) => flag('force') || currentHash(id) !== hashes[id]);

  if (flag('list')) {
    for (const id of ids) console.log(`  ${id.padEnd(28)} ${currentHash(id) === hashes[id] ? 'current' : 'needs baking'}   ${path.relative(root, files[id] ?? INDEX)}`);
    await server.close();
    return;
  }
  for (const id of selected.filter((x) => !due.includes(x))) console.log(`  ${id.padEnd(28)} current`);
  if (!due.length) {
    await server.close();
    return;
  }

  const start = performance.now();
  let failed = 0;
  const jobs = Math.min(maxJobs, due.length);
  if (jobs === 1) {
    for (const id of due) {
      try {
        report(bakeOne(index, id, hashes[id]));
      } catch (e) {
        failed++;
        console.error(`  ${id}: FAILED\n${e?.stack ?? e}`);
      }
    }
    await server.close();
  } else {
    await server.close();
    const queue = [...due];
    await Promise.all(
      Array.from({ length: jobs }, () => new Promise((resolve, reject) => {
        const w = new Worker(fileURLToPath(import.meta.url));
        const next = () => {
          const id = queue.shift();
          w.postMessage(id ? { id, hash: hashes[id] } : null);
        };
        w.on('message', (m) => {
          if (m.error) {
            failed++;
            console.error(`  ${m.id}: FAILED\n${m.error}`);
          } else if (m.meta) report(m.meta);
          next();
        });
        w.on('error', reject);
        w.on('exit', resolve);
      })),
    );
  }
  console.log(`baked ${due.length - failed} of ${due.length} shot(s) in ${((performance.now() - start) / 1000).toFixed(1)} s${jobs > 1 ? ` with ${jobs} workers` : ''}`);
  if (failed) process.exit(1);
}

// ------------------------------------------------------------------ entry: main thread or worker

if (!isMainThread) {
  const { server, index } = await shotLoader();
  parentPort.on('message', (job) => {
    if (!job) {
      server.close().then(() => process.exit(0));
      return;
    }
    try {
      parentPort.postMessage({ id: job.id, meta: bakeOne(index, job.id, job.hash) });
    } catch (e) {
      parentPort.postMessage({ id: job.id, error: String(e?.stack ?? e) });
    }
  });
  parentPort.postMessage({ ready: true });
} else {
  await main();
}
