// Reads take files the way scenes and bakes do (src/mocap/take.ts) and prints what the TypeScript
// side sees as JSON, for tests/test_format.py (the Python ⇄ TypeScript cross-check of FORMAT.md).
//
//   node mocap/tests/take_format.mjs FILE...      (from kabel-wickeln/; needs npm install)
//
// Per file: frames, times, positions (m), confidences, how, markers, cable counts, whether the
// synchronous (node:zlib) and the browser path (DecompressionStream) agree, and whether mirror()
// swaps the sides. Plus the joint lists of src/mocap/joints.ts and mocap/synthetic/generate.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const tk = await server.ssrLoadModule('/src/mocap/take.ts');
  const jn = await server.ssrLoadModule('/src/mocap/joints.ts');
  const gen = await server.ssrLoadModule('/mocap/synthetic/generate.ts');
  const out = { take_joints: [...jn.TAKE_JOINTS], synthetic_joints: [...gen.JOINTS], files: {} };
  const NJ = jn.TAKE_JOINTS.length;
  for (const f of process.argv.slice(2)) {
    const a = tk.readTakeSync(f);
    // the browser path: fetch → bytes → DecompressionStream('gzip') → JSON
    const b = tk.parseTake(await tk.decodeTakeBytes(new Uint8Array(fs.readFileSync(f))), f);
    let syncAsync = 0;
    for (let k = 0; k < a.pos.length; k++) syncAsync = Math.max(syncAsync, Math.abs(a.pos[k] - b.pos[k]));
    const howSame = a.how.length === b.how.length && a.how.every((v, k) => v === b.how[k]);
    // mirror(): x → −x and left ⇄ right
    const m = a.mirror();
    let mirrorErr = 0;
    for (let i = 0; i < a.frames; i++) {
      for (let j = 0; j < NJ; j++) {
        const p = a.at(i, jn.MIRROR_OF[j]);
        const q = m.at(i, j);
        if (!p || !q) {
          if (!p !== !q) mirrorErr = Infinity;
          continue;
        }
        mirrorErr = Math.max(mirrorErr, Math.abs(q[0] + p[0]), Math.abs(q[1] - p[1]), Math.abs(q[2] - p[2]));
      }
    }
    const how = [];
    for (let i = 0; i < a.frames; i++) {
      let s = '';
      for (let j = 0; j < NJ; j++) s += a.howAt(i, j);
      how.push(s);
    }
    const cables = [];
    for (let i = 0; i < a.frames; i++) {
      const c = a.cableAt(a.time[i]);
      cables.push(c === null ? null : c.map((l) => l.pts.length));
    }
    // between two frames: position() interpolates; at a frame it is the frame
    const mid = a.frames > 4 ? (a.time[2] + a.time[3]) / 2 : a.time[0];
    out.files[f] = {
      shot: a.shot,
      take: a.take,
      kind: a.kind,
      person: a.person,
      frames: a.frames,
      time: Array.from(a.time),
      zero: a.zero,
      markers: a.markers,
      sensor: a.sensor,
      mark: a.mark,
      pos: Array.from(a.pos),
      conf: Array.from(a.conf),
      how,
      cables,
      sync_vs_async_max: syncAsync,
      sync_vs_async_how_same: howSame,
      mirror_max_err: mirrorErr,
      mirror_twice_mirrored: m.mirror().mirrored,
      mid: { t: mid, nose: a.position(0, mid) },
    };
  }
  process.stdout.write(JSON.stringify(out));
} finally {
  await server.close();
}
