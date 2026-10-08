// Opens the output window (/wall/) as a borderless kiosk window on the screen of the LED controller:
// a browser with a profile of its own (web/.cache/wall-browser of the main checkout), placed at the
// screen saved in the wall setup (output.window, chosen in the control center) or given by hand.
// Used by the dev server (button in /control/) and by `npm run wall`.
//
// The screen should run at 100 % Windows scaling: the window is placed in screen pixels and the page
// is forced to one CSS pixel per screen pixel, so the LED image is pixel-exact.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

export function findBrowser() {
  const local = process.env.LOCALAPPDATA ?? '';
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
  ].find((p) => p && fs.existsSync(p));
}

/** Command line for the kiosk window. win: { left, top, width, height } in screen pixels or null. */
export function wallArgs(url, win, profile) {
  const args = [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter,HardwareMediaKeyHandling',
    '--noerrdialogs',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-pinch',
    '--overscroll-history-navigation=0',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (win) args.push(`--window-position=${win.left},${win.top}`, `--window-size=${win.width},${win.height}`);
  args.push('--kiosk', `--app=${url}`);
  return args;
}

/** Starts the kiosk window; returns { pid, exe, args } (the browser keeps running on its own). */
export function launchWall({ url, win = null, profile, exe = findBrowser() }) {
  if (!exe) throw new Error('Kein Chrome/Edge gefunden (Pfad mit CHROME_PATH=… angeben).');
  fs.mkdirSync(profile, { recursive: true });
  const args = wallArgs(url, win, profile);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return { pid: child.pid, exe, args };
}

/** Ends a kiosk window started by launchWall (its whole process tree). */
export function closeWall(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => resolve(!err));
    } else {
      try {
        process.kill(-pid);
        resolve(true);
      } catch {
        resolve(false);
      }
    }
  });
}

/** Is the process still there? */
export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export const profileDir = (wallDir) => path.join(path.dirname(wallDir), 'wall-browser');
