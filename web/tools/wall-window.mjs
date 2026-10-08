// npm run wall [-- --screen left,top,width,height] [--url http://127.0.0.1:5173]
//
// Opens the output window of the LED wall (/wall/ of this worktree's dev server) as a borderless
// kiosk window on the LED controller's screen: the screen saved in the wall setup (control center:
// Wand-Setup → "Bildschirm für die Ausgabe wählen"), or the one given with --screen. The same as the
// button "Ausgabe öffnen → Kiosk-Fenster" in the control center. Close it with Alt+F4.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchWall, profileDir } from './wall-launch.js';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

function mainWeb() {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: web, encoding: 'utf8' }).trim();
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: web, encoding: 'utf8' }).trim();
    return path.join(path.dirname(common), path.relative(top, web));
  } catch {
    return web;
  }
}

let url = opt('--url');
if (!url) {
  try {
    url = JSON.parse(fs.readFileSync(path.join(web, '.cache', 'dev-server.json'), 'utf8')).url;
  } catch {
    console.error('\n  Kein Dev-Server in diesem Worktree: erst `npm run dev` starten (oder --url angeben).\n');
    process.exit(1);
  }
}
const wallDir = process.env.KINECT_WALL_DIR ? path.resolve(process.env.KINECT_WALL_DIR) : path.join(mainWeb(), '.cache', 'wall');
let win = null;
const screen = opt('--screen');
if (screen) {
  const [left, top, width, height] = screen.split(',').map(Number);
  if (![left, top, width, height].every(Number.isFinite)) {
    console.error('  --screen links,oben,breite,höhe (Bildschirm-Pixel), z. B. --screen 1920,0,1920,1080');
    process.exit(1);
  }
  win = { left, top, width, height };
} else {
  try {
    win = JSON.parse(fs.readFileSync(path.join(wallDir, 'setup.json'), 'utf8'))?.output?.window ?? null;
  } catch {
    // no setup yet
  }
}
try {
  const r = launchWall({ url: `${url.replace(/\/+$/, '')}/wall/`, win, profile: profileDir(wallDir) });
  console.log(`\n  LED-Ausgabe gestartet: ${url}/wall/ (PID ${r.pid})`);
  console.log(win ? `  auf dem Bildschirm bei ${win.left}, ${win.top} (${win.width}×${win.height})` : '  kein Bildschirm gewählt: der Browser wählt (Steuerzentrale → Wand-Setup → Bildschirm wählen)');
  console.log('  Steuern: ' + `${url}/control/` + ' · Schließen: Alt+F4 im Ausgabefenster\n');
} catch (e) {
  console.error(`\n  ${e.message}\n`);
  process.exit(1);
}
