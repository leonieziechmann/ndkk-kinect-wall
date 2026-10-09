// Runs the pixel-jump-run scene headless (from web/, with this worktree's dev server running) and
// dumps its jump signal log; can also inject test figures and save LED images. See README.md.
//
//   node scenes/pixel-jump-run/calibrate/probe.mjs --hub 8092 --seconds 150 --log --nospawn //     --params '{"roundSecs":600}' --out .cache/shots/hops
//
// --hub PORT        the hub (a replay hub for recordings); --seconds N  how long
// --log             write <out>-log.json (rows: see people.js, signals())
// --nospawn         no obstacles (the round never hits anybody)
// --params JSON     scene params to set
// --fake            test figures instead of people (with --jumpEvery S: they hop)
// --shots 2,4.5     PNG of the LED image at these seconds; --every S --from S: JPEG sequence
// --timing -0.1,0,0.2,0.5  jump assist test: one test figure per value takes off that many s before
//                   a ground obstacle reaches its legs on the wall (its jump is detected 0.1 s later,
//                   as with people); prints per figure: obstacles cleared and hit, top, time in the air
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { findBrowser } from '../../../tools/wall-launch.js';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const has = (k) => args.includes(`--${k}`);
const hub = opt('hub', '8099');
const seconds = Number(opt('seconds', '6'));
const shots = String(opt('shots', '')).split(',').filter(Boolean).map(Number);
const out = opt('out', '.cache/shots/jr');
const params = JSON.parse(opt('params', '{}'));
const every = Number(opt('every', '0'));
const from = Number(opt('from', '0'));
const jumpEvery = Number(opt('jumpEvery', '0'));
const timing = String(opt('timing', '')).split(',').filter(Boolean).map(Number);
const info = JSON.parse(fs.readFileSync('.cache/dev-server.json', 'utf8'));
const exe = findBrowser();
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 600 });
  const logs = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${info.url}/scenes/pixel-jump-run/?hub=${hub}&kiosk`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => globalThis.__jumprun, { timeout: 20000, polling: 100 });
  await page.evaluate((pp) => Object.assign(globalThis.__jumprun.params, pp), params);
  if (has('nospawn')) await page.evaluate(() => { globalThis.__jumprun.game.spawn = () => { globalThis.__jumprun.game.nextSpawn = 1e12; }; });
  if (has('fake')) {
    await page.evaluate(() => {
      const f = globalThis.__jumprun.fake;
      f.push({ id: 1, x: 1.2, h: 1.75, slot: 1 });
      f.push({ id: 2, x: 2.6, h: 1.2, slot: 2, arms: 'up' });
      f.push({ id: 3, x: 3.9, h: 1.8, slot: 3, crouch: 1 });
      f.push({ id: 4, x: 5.0, h: 1.65, slot: 4, arms: 'side' });
      f.push({ id: 5, x: 3.2, h: 1.7, slot: 5, back: true });
    });
  }
  if (timing.length) {
    await page.evaluate((taus) => {
      const J = globalThis.__jumprun;
      const DETECT = 0.1; // s from the takeoff to the detected jump (calibrate/README.md)
      const stats = (J.timing = taus.map((tau) => ({ tau, jumps: [], cleared: 0, hit: 0 })));
      taus.forEach((tau, i) => J.fake.push({ id: 10 + i, x: 0.5 + (i * 5) / Math.max(1, taus.length - 1), h: 1.75, slot: 1 + (i % 16) }));
      const done = new Set();
      const tick = () => {
        const L = J.layout;
        const g = J.game;
        if (L) {
          const vc = Math.max(0.1, g.speed) / L.cellMx;
          stats.forEach((st, i) => {
            const fk = J.fake.find((q) => q.id === 10 + i);
            const f = J.people.figures.get(`fake${10 + i}`);
            if (!fk || !f || f.bbox[2] < f.bbox[0]) return;
            const [c0, , c1] = f.bbox;
            for (const th of g.things) {
              if (th.kind !== 'obstacle' || th.high || !th.frame) continue;
              const key = `${i}:${th.phase0 ?? (th.phase0 = th.phase)}`;
              if (th.passed.has(f.id) && !done.has(`p${key}`)) { done.add(`p${key}`); st.cleared++; }
              if (th.hit.has(f.id) && !done.has(`h${key}`)) { done.add(`h${key}`); st.hit++; }
              if (done.has(key)) continue;
              const lo = (th.x * L.pxX - L.ox) / L.cellPx;
              const a = (g.dir > 0 ? lo - (c1 + 1) : c0 - (lo + th.frame.w)) / vc; // s until it reaches the figure
              if (a <= st.tau - DETECT) { done.add(key); fk.jump = true; }
            }
            // the jumps: top and time in the air
            if (f.air && !st.cur) st.cur = { t0: g.time, top: 0 };
            if (st.cur) {
              st.cur.top = Math.max(st.cur.top, f.h);
              if (!f.air) { st.jumps.push([+st.cur.top.toFixed(2), +(g.time - st.cur.t0).toFixed(2)]); st.cur = null; }
            }
          });
        }
        requestAnimationFrame(tick);
      };
      tick();
    }, timing);
  }
  const t0 = Date.now();
  const pending = [...shots].sort((a, b) => a - b);
  let jumpAt = has('fake') ? 1.5 : 1e9;
  while ((Date.now() - t0) / 1000 < seconds) {
    const el = (Date.now() - t0) / 1000;
    if (jumpEvery && el > jumpAt) {
      await page.evaluate(() => {
        for (const f of globalThis.__jumprun.fake) if (f.id % 2 === 0) f.jump = true;
        // id 4 jumps again in the air
        setTimeout(() => { const f4 = globalThis.__jumprun.fake.find((f) => f.id === 4); if (f4) f4.jump = true; }, 350);
      });
      jumpAt = el + jumpEvery;
    } else if (el > jumpAt) {
      await page.evaluate(() => {
        for (const f of globalThis.__jumprun.fake) if (f.id % 2 === 0) f.jump = true;
      });
      jumpAt = 1e9;
    }
    if (every && el >= from) {
      const [gt, url] = await page.evaluate(() => [globalThis.__jumprun.game.time, document.querySelector('canvas').toDataURL('image/jpeg', 0.8)]);
      fs.mkdirSync(`${out}-seq`, { recursive: true });
      fs.writeFileSync(`${out}-seq/${gt.toFixed(2).padStart(7, '0')}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
    }
    if (pending.length && el >= pending[0]) {
      const at = pending.shift();
      const url = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(`${out}-${at}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
    await sleep(every ? Math.max(5, every * 1000 - 25) : 40);
  }
  const res = await page.evaluate(() => {
    const J = globalThis.__jumprun;
    return {
      status: globalThis.__kinectRuntime?.status?.(),
      score: J.game.score,
      speed: J.game.speed,
      things: J.game.things.length,
      phase: J.game.phase, round: J.game.round, results: J.game.results, crowns: [...J.game.crowns],
      figs: J.people.list.map((f) => ({ id: f.id, cells: f.cells, jumps: f.jumps, lives: f.lives, alive: f.alive, score: f.roundScore, round: f.round, player: f.player, maxLift: f.maxLift })),
      log: J.people.log,
      timing: J.timing?.map((st) => {
        const m = (k) => (st.jumps.length ? +(st.jumps.reduce((s, j) => s + j[k], 0) / st.jumps.length).toFixed(2) : 0);
        return { tau: st.tau, cleared: st.cleared, hit: st.hit, jumps: st.jumps.length, top: m(0), air: m(1) };
      }),
    };
  });
  if (has('log')) fs.writeFileSync(`${out}-log.json`, JSON.stringify(res.log));
  delete res.log;
  console.log(JSON.stringify(res, null, 1));
  console.log(logs.slice(0, 20).join('\n'));
} finally {
  await browser.close();
}
