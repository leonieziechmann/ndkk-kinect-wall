// Synthetische Kinect-Aufnahmen mit bekannter Wahrheit: bewegt die 3D-Figuren des Projekts
// (src/people) nach einer festen Choreographie, rendert sie aus einer virtuellen Kinect v2 (Tiefe in
// mm und Infrarot wie vom Hub, gespiegelt, mit Linsenverzeichnung, Rauschen und fliegenden Pixeln)
// und schreibt
//   output/synthetic/<name>.k2rec            genau im Format des Hubs (kinect-hub/src/recording.rs):
//                                            auswerten.py liest sie, `kinect-hub --source replay` spielt sie ab
//   output/synthetic/<name>.truth.json.gz    die Wahrheit im Take-Format (mocap/FORMAT.md) plus Block `truth`
//
//   node mocap/synthetic/erzeugen.mjs                    alle drei: coil, throw, tpose
//   node mocap/synthetic/erzeugen.mjs coil coil-a        nur diese (coil-a: dasselbe Wickeln aus Aufbau A, 30° von rechts)
//   Optionen: --out DIR, --seconds S, --ss N (Unterabtastung, 3), --noise F (1), --flying F (0.3),
//             --seed N, --no-distortion, --drop F (Anteil verlorener Frames, 0), --cable-ir A (0.1)
//
// Läuft mit Node allein (kein Browser, keine GPU): die TypeScript-Dateien lädt Vite wie tools/bake.mjs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const VALUE = ['out', 'seconds', 'ss', 'noise', 'flying', 'seed', 'drop', 'cable-ir'];
const names = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE.includes(args[i - 1].slice(2)) && args[i - 1].startsWith('--')));
const outDir = path.resolve(root, opt('out', 'output/synthetic'));
const num = (name) => (opt(name) !== undefined ? Number(opt(name)) : undefined);
const options = {
  seconds: num('seconds'),
  ss: num('ss'),
  noise: num('noise'),
  flying: num('flying'),
  seed: num('seed'),
  drop: num('drop'),
  cableIr: num('cable-ir'),
  distortion: !args.includes('--no-distortion'),
};

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});

/** the .k2rec header: magic, version, header_len, width, height, info_len, lut_len, reserved */
function k2recHeader(info, lut, width, height) {
  const infoBuf = Buffer.from(JSON.stringify(info), 'utf8');
  const lutBuf = Buffer.from(lut.buffer, lut.byteOffset, lut.byteLength);
  if (lutBuf.length !== width * height * 8) throw new Error(`LUT has ${lutBuf.length} bytes`);
  const h = Buffer.alloc(32);
  h.write('K2RC', 0, 'latin1');
  h.writeUInt32LE(1, 4);
  h.writeUInt32LE(32 + infoBuf.length + lutBuf.length, 8);
  h.writeUInt16LE(width, 12);
  h.writeUInt16LE(height, 14);
  h.writeUInt32LE(infoBuf.length, 16);
  h.writeUInt32LE(lutBuf.length, 20);
  h.writeBigUInt64LE(0n, 24);
  return Buffer.concat([h, infoBuf, lutBuf]);
}

/** one frame: magic, seq, capture time, flags (1 = IR follows), reserved, payload length, depth, IR */
function k2recFrame(f) {
  const depth = Buffer.from(f.depth.buffer, f.depth.byteOffset, f.depth.byteLength);
  const ir = Buffer.from(f.ir.buffer, f.ir.byteOffset, f.ir.byteLength);
  const h = Buffer.alloc(24);
  h.write('K2RF', 0, 'latin1');
  h.writeUInt32LE(f.seq >>> 0, 4);
  h.writeBigUInt64LE(BigInt(f.timeUs), 8);
  h.writeUInt16LE(1, 16);
  h.writeUInt16LE(0, 18);
  h.writeUInt32LE(depth.length + ir.length, 20);
  return [h, depth, ir];
}

try {
  const { MOTIONS, DEFAULT } = await server.ssrLoadModule('/mocap/synthetic/motions.ts');
  const { generate } = await server.ssrLoadModule('/mocap/synthetic/generate.ts');
  const todo = names.length ? names : DEFAULT;
  for (const n of todo) if (!MOTIONS[n]) throw new Error(`unbekannte Bewegung ${n}: ${Object.keys(MOTIONS).join(', ')}`);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [index, n] of todo.entries()) {
    const m = MOTIONS[n];
    const file = path.join(outDir, `${m.name}.k2rec`);
    const part = `${file}.part`;
    const fd = fs.openSync(part, 'w');
    let frames = 0;
    process.stdout.write(`${m.name}: ${m.about}\n`);
    const startUs = Date.UTC(2026, 9, 12, 10, index * 5, 0) * 1000;
    const res = generate(
      m,
      { ...options, startUs },
      (f) => {
        for (const b of k2recFrame(f)) fs.writeSync(fd, b);
        frames++;
        if (frames % 30 === 0) process.stdout.write(`  ${frames} Frames\r`);
      },
      (info, lut) => fs.writeSync(fd, k2recHeader(info, lut, 512, 424)),
    );
    fs.closeSync(fd);
    fs.renameSync(part, file);
    const truthFile = path.join(outDir, `${m.name}.truth.json.gz`);
    fs.writeFileSync(truthFile, zlib.gzipSync(Buffer.from(JSON.stringify(res.truth)), { level: 9 }));
    const mb = (fs.statSync(file).size / 1e6).toFixed(0);
    const kb = (fs.statSync(truthFile).size / 1e3).toFixed(0);
    console.log(`  ${file} (${res.stats.frames} Frames, ${mb} MB, ${res.stats.msPerFrame} ms/Frame)`);
    console.log(`  ${truthFile} (${kb} kB; IK-Restfehler max ${res.stats.ikPosErrorMaxMm} mm)`);
  }
} finally {
  await server.close();
}
