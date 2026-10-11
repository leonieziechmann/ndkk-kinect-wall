// Helpers for the simulation tests: load the TypeScript sources through Vite (ssrLoadModule, as
// tools/bake.mjs does), snapshots of a rod, and pictures with the PIL renderer (render.py).
// Output: output/simtest/<name>.png, <name>.summary.json.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const OUT = path.join(ROOT, 'output/simtest');
fs.mkdirSync(OUT, { recursive: true });

/** Loads modules (paths from the project root, e.g. '/src/sim/index.ts'); call close() when done. */
export async function load(...files) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const mods = [];
  for (const f of files) mods.push(await server.ssrLoadModule(f));
  return { mods, close: () => server.close() };
}

/**
 * Snapshot of a rod for render.py: node positions, the stripe direction per node (d1, or d2 with
 * axis = 1, e.g. the top face of a ribbon), held segments, capsules.
 */
export function snap(sim, rod, label = '', extra = {}, axis = 0) {
  const fr = sim.nodeFramesFrom(rod.q, rod.n, new Float32Array(9 * rod.n));
  const d1 = [];
  for (let i = 0; i < rod.n; i++) d1.push(fr[9 * i + 3 * axis], fr[9 * i + 3 * axis + 1], fr[9 * i + 3 * axis + 2]);
  return { t: rod.time, label, pos: Array.from(rod.x, (v) => +v.toFixed(5)), d1: d1.map((v) => +v.toFixed(4)), grips: rod.heldSegments(), caps: [...rod.currentCapsules()], ...extra };
}

export function render(name, { title, radius, visScale = 2.5, views, snapshots, W, H }) {
  const json = path.join(OUT, `${name}.json`), png = path.join(OUT, `${name}.png`);
  fs.writeFileSync(json, JSON.stringify({ title, radius, visScale, views, snapshots, W, H }));
  execFileSync('python3', [path.join(here, 'render.py'), json, png]);
  fs.unlinkSync(json);
  return png;
}

export function writeSummary(name, obj) {
  fs.writeFileSync(path.join(OUT, `${name}.summary.json`), JSON.stringify(obj, null, 2));
}

export const smooth = (u) => {
  u = Math.min(1, Math.max(0, u));
  return u * u * (3 - 2 * u);
};
export const lerp3 = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
export const r4 = (v) => +v.toFixed(4);
