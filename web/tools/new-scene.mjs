// npm run new <name> [vorlage]
//
// Creates web/scenes/<name>/ as a copy of an existing scene (default: depth-shader, a single WGSL
// function) and gives it its own scene.json. Templates: every folder in web/scenes/.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenesDir = path.join(web, 'scenes');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const scenes = () =>
  fs
    .readdirSync(scenesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name) && ['main.js', 'main.ts'].some((f) => fs.existsSync(path.join(scenesDir, d.name, f))))
    .map((d) => d.name);

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const [name, from = 'depth-shader'] = process.argv.slice(2);
if (!name || name.startsWith('-')) {
  console.log(`
  npm run new <name> [vorlage]

  Legt web/scenes/<name>/ als Kopie einer vorhandenen Szene an.
  Vorlagen: ${scenes().join(', ')}
    depth-shader   2D, ein WGSL-Shader (schnellster Start, Standard)
    pointcloud     3D-Punktwolke, rohes WebGPU, Orbit-Kamera
    three-points   three.js (WebGPURenderer)
`);
  process.exit(name ? 0 : 1);
}
if (!NAME_RE.test(name)) fail(`Name "${name}": nur a-z, 0-9, - und _ (beginnt mit Buchstabe oder Ziffer, max. 64 Zeichen).`);
const src = path.join(scenesDir, from);
const dst = path.join(scenesDir, name);
if (!scenes().includes(from)) fail(`Vorlage "${from}" gibt es nicht. Vorhanden: ${scenes().join(', ')}`);
if (fs.existsSync(dst)) fail(`web/scenes/${name} gibt es schon – anderen Namen wählen oder die Szene direkt bearbeiten.`);

fs.cpSync(src, dst, { recursive: true, filter: (p) => !path.basename(p).startsWith('.') });

let author = process.env.KINECT_AUTHOR ?? '';
if (!author) {
  try {
    author = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: web, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    author = '';
  }
}
const meta = {
  title: name,
  description: `Basiert auf ${from}. TODO: in einem Satz beschreiben, was die Szene zeigt.`,
  author,
  based_on: from,
  created: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(path.join(dst, 'scene.json'), `${JSON.stringify(meta, null, 2)}\n`);

let url = null;
try {
  url = JSON.parse(fs.readFileSync(path.join(web, '.cache', 'dev-server.json'), 'utf8')).url;
} catch {
  url = null;
}
const files = fs.readdirSync(dst).map((f) => `web/scenes/${name}/${f}`);
console.log(`
  Neue Szene web/scenes/${name}/ (Kopie von ${from})
    ${files.join('\n    ')}

  Ansehen:  ${url ? `${url}/scenes/${name}/` : `npm run dev, dann http://127.0.0.1:<port>/scenes/${name}/`}
  Prüfen:   npm run check ${name}
  Titel und Beschreibung für die Galerie: web/scenes/${name}/scene.json
`);
