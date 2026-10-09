// wall-output.js — the output window (/wall/) for the LED controller. Loaded by the runtime in output
// mode. It plays the show (lib/wall-show.js), takes commands from the control center (/control/)
// over the wall bus, and reports back what runs (telemetry, preview pictures).
//
// On top of the scene: the color correction of the setup (brightness, gamma, white balance, as an
// SVG filter), test images, the calibration view and the play field assistant (a 2D canvas at LED
// resolution), and a black layer (blackout, transitions over black). Errors do not stop the show: a scene that fails in
// frame() is retried, one that keeps failing is skipped.

import { loadDoc } from './wall-bus.js';
import { crowdWait, normalizeShow, stepEntry } from './wall-show.js';
import { BONES, POINTS } from './persons.js';

const TELEMETRY_MS = 250;
const PREVIEW_MS = 200;
const PREVIEW_FOR_MS = 3000; // previews stop this long after the last request
const RETRY_MS = 2000; // a scene stopped by an error in frame() gets another go after this
const FAILS_TO_SKIP = 3; // ... and is skipped after this many errors within FAIL_WINDOW_MS
const FAIL_WINDOW_MS = 30000;
const CURRENT_KEY = 'kinect-wall:current';
const CROWD_SAMPLES = 16; // the crowd for the overrun limit: the most people seen in the last 16 × 0.5 s

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  parent?.append(e);
  return e;
}

export function startOutput(api) {
  const { bus, wall, rt, kinect } = api;
  let show = normalizeShow(null);
  let current = null; // the show entry on the wall
  let startedAt = performance.now();
  let blackout = false;
  let pattern = null; // name of a test image, or null
  let wizard = null; // the play field assistant of the control center: what to show (see drawWizard)
  let wizardAt = 0;
  let over = false; // test image over the scene instead of instead of it
  let waiting = null; // auto advance waits: 'round' (a game's round to end), 'empty' (an empty wall)
  let waitLeft = 0; // s until it switches anyway
  let waitLimit = 0; // s it may run over in all (maxWait … maxWaitMany by the crowd, or maxRoundWait)
  const seen = []; // people in front of the wall, every 0.5 s
  let crowd = 0; // the most of them: a track lost for a moment does not shrink the limit
  let previewUntil = 0;
  let lastPreview = 0;
  let errorAt = 0;
  let fails = [];
  let switching = false;
  let queued = null; // a switch asked for while another one runs: done right after it
  let liveShowAt = -1e9; // when the control center last sent the show (newer than the file then)

  // ---------- layers: color filter, test images, black ----------

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = `<filter id="k-wall-color" color-interpolation-filters="sRGB"><feComponentTransfer>${['R', 'G', 'B']
    .map((c) => `<feFunc${c} type="gamma" amplitude="1" exponent="1" offset="0"/>`)
    .join('')}</feComponentTransfer></filter>`;
  document.body.append(svg);
  const funcs = ['R', 'G', 'B'].map((c) => svg.querySelector(`feFunc${c}`));

  const overlay = el('canvas', 'k-canvas k-led k-wall-overlay', api.stage);
  overlay.style.zIndex = '3';
  overlay.style.pointerEvents = 'none';
  const g = overlay.getContext('2d');
  const black = el('div', 'k-wall-black', document.body);
  Object.assign(black.style, { position: 'fixed', inset: '0', background: '#000', opacity: '0', pointerEvents: 'none', zIndex: '8', transition: 'opacity 0.5s' });

  let colorKey = '';
  function applyColor() {
    const c = wall.setup.color;
    const key = `${c.brightness},${c.gamma},${c.r},${c.g},${c.b}`;
    if (key === colorKey) return;
    colorKey = key;
    const identity = c.brightness === 1 && c.gamma === 1 && c.r === 1 && c.g === 1 && c.b === 1;
    [c.r, c.g, c.b].forEach((gain, i) => {
      funcs[i].setAttribute('amplitude', String(c.brightness * gain));
      funcs[i].setAttribute('exponent', String(c.gamma));
    });
    api.stage.style.filter = identity ? '' : 'url(#k-wall-color)';
  }

  function fadeBlack(on, seconds = 0.5) {
    black.style.transition = `opacity ${seconds}s`;
    black.style.opacity = on ? '1' : '0';
    return new Promise((r) => setTimeout(r, seconds * 1000 + 30));
  }

  /** the overlay canvas sits exactly on the LED image (as the runtime places the scene canvas) */
  function placeOverlay() {
    const led = wall.setup.led;
    const out = wall.setup.output;
    const dpr = devicePixelRatio || 1;
    let css;
    if (out.fit === 'pixel' && !api.embedded) css = [out.x / dpr, out.y / dpr, led.w / dpr, led.h / dpr];
    else if (out.fit === 'stretch' && !api.embedded) css = [0, 0, innerWidth, innerHeight];
    else {
      const s = Math.min(innerWidth / led.w, innerHeight / led.h);
      css = [(innerWidth - led.w * s) / 2, (innerHeight - led.h * s) / 2, led.w * s, led.h * s];
    }
    if (overlay.width !== led.w || overlay.height !== led.h) {
      overlay.width = led.w;
      overlay.height = led.h;
    }
    Object.assign(overlay.style, { left: `${css[0]}px`, top: `${css[1]}px`, width: `${css[2]}px`, height: `${css[3]}px` });
  }

  // ---------- the show ----------

  function rememberCurrent() {
    try {
      localStorage.setItem(CURRENT_KEY, current?.id ?? '');
    } catch {
      // not remembered
    }
  }

  async function playEntry(entry, how = show.transition) {
    if (switching) {
      queued = { entry, how };
      return;
    }
    switching = true;
    try {
      current = entry;
      startedAt = performance.now();
      waiting = null;
      fails = [];
      rememberCurrent();
      if (!entry) {
        api.stop();
        rt.title = '';
        return;
      }
      const opts = { overrides: { ...entry.params }, fade: show.fade };
      let ok;
      if (how === 'black' && rt.current) {
        await fadeBlack(true, show.fade / 2);
        ok = await api.play(entry.scene, { ...opts, transition: 'cut' });
        if (!blackout) await fadeBlack(false, show.fade / 2);
      } else {
        ok = await api.play(entry.scene, { ...opts, transition: how });
      }
      if (!ok) {
        // setup() failed (the previous scene, if any, keeps running): the next entry, or again later
        setTimeout(() => {
          if (current?.id !== entry.id || switching) return;
          const next = stepEntry(show, entry.id, 1);
          playEntry(next && next.id !== entry.id ? next : entry, 'cut');
        }, 5000);
      }
    } finally {
      switching = false;
      telemetry();
      if (queued) {
        const q = queued;
        queued = null;
        playEntry(q.entry, q.how);
      }
    }
  }

  function step(dir) {
    const next = stepEntry(show, current?.id, dir);
    if (next) playEntry(next);
  }

  /** The show changed (control center): new params of the running entry apply right away. */
  function setShow(raw) {
    show = normalizeShow(raw);
    if (!current) return;
    const entry = show.entries.find((e) => e.id === current.id);
    if (!entry) {
      if (current.id !== 'adhoc') current = { ...current, removed: true };
      return;
    }
    const sceneChanged = entry.scene !== current.scene;
    current = entry;
    if (sceneChanged) return void playEntry(entry, 'cut');
    // only when they changed: the same values again leave a running glide alone (runtime retune())
    const inst = rt.current;
    if (inst?.name === entry.scene && JSON.stringify(inst.overrides) !== JSON.stringify(entry.params)) api.setParams({ ...entry.params });
  }

  async function loadShow() {
    const { doc } = await loadDoc('show');
    setShow(doc);
  }

  // ---------- commands ----------

  bus.on('play', (d) => {
    // an entry of the show, or just a scene to look at (not in the show: id 'adhoc')
    const entry = d.scene ? { id: 'adhoc', scene: String(d.scene), label: '', duration: 300, enabled: true, wait: true, params: {} } : show.entries.find((e) => e.id === d.entry);
    if (entry) playEntry(entry, d.transition ?? show.transition);
  });
  bus.on('next', () => step(1));
  bus.on('prev', () => step(-1));
  bus.on('stop', () => playEntry(null));
  bus.on('show', (d) => {
    liveShowAt = performance.now();
    setShow(d.show);
  });
  bus.on('file', (d) => {
    // the file follows the live message a moment later: an older save must not undo a newer change
    if (d.kind === 'show' && performance.now() - liveShowAt > 3000) loadShow();
  });
  bus.on('blackout', (d) => {
    blackout = !!d.on;
    fadeBlack(blackout, Number.isFinite(d.fade) ? d.fade : 0.5);
    telemetry();
  });
  bus.on('pattern', (d) => {
    pattern = typeof d.name === 'string' && d.name ? d.name : null;
    over = !!d.over;
    telemetry();
  });
  bus.on('preview', (d, msg) => {
    // the control center that embeds this preview sees it live: pictures only for the others
    if (api.embedded && msg.from === api.owner) return;
    previewUntil = d.on === false ? 0 : performance.now() + PREVIEW_FOR_MS;
  });
  bus.on('wizard', (d) => {
    wizard = d?.on ? d : null;
    wizardAt = performance.now();
    telemetry();
  });
  bus.on('reload', () => location.reload());
  bus.on('close', () => !api.embedded && window.close());
  bus.on('ping', () => telemetry());

  addEventListener('pointerdown', () => {
    if (!api.embedded && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  });

  // ---------- every frame ----------

  api.hooks.beforeFrame = (now) => {
    applyColor();
    // a scene stopped by an error gets another go; one that keeps failing is skipped
    if (rt.state === 'error' && rt.current) {
      if (!errorAt) {
        errorAt = now;
        fails = fails.filter((t) => now - t < FAIL_WINDOW_MS);
        fails.push(now);
      } else if (now - errorAt > RETRY_MS) {
        errorAt = 0;
        if (fails.length >= FAILS_TO_SKIP && stepEntry(show, current?.id, 1)?.id !== current?.id) {
          api.pushError('Show', `${current?.scene}: zu viele Fehler – weiter zur nächsten Szene`);
          step(1);
        } else api.resume();
      }
    }
  };

  api.hooks.afterFrame = (now, inst) => {
    placeOverlay();
    // the assistant ends by itself when its control center went away
    if (wizard && now - wizardAt > 10000) wizard = null;
    overlay.style.display = pattern || wizard ? 'block' : 'none';
    if (wizard) drawWizard(now);
    else if (pattern) drawPattern(now);
    if (now < previewUntil && now - lastPreview >= PREVIEW_MS) {
      lastPreview = now;
      sendPreview(inst);
    }
  };

  // ---------- auto advance, telemetry ----------

  setInterval(() => {
    seen.push(kinect.view.length);
    if (seen.length > CROWD_SAMPLES) seen.shift();
    crowd = Math.max(...seen);
    waiting = null;
    if (!show.auto || !current || blackout || switching) return;
    const elapsed = (performance.now() - startedAt) / 1000;
    if (elapsed < current.duration) return;
    // an entry with wait off (ads) switches on time; a game says whether a round runs (ctx.holdSwitch
    // true/false): it switches between rounds, people in front or not; every other scene when nobody
    // stands in front of the wall, at most longer the more people there are
    const inst = rt.current;
    const hold = inst?.name === current.scene && rt.state === 'running' ? inst.ctx?.holdSwitch : undefined;
    let limit = 0;
    if (current.wait !== false) {
      if (typeof hold === 'boolean' && show.waitForRound) {
        if (hold) [waiting, limit] = ['round', show.maxRoundWait];
      } else if (show.waitForEmpty && kinect.view.length > 0) [waiting, limit] = ['empty', crowdWait(show, crowd)];
    }
    waitLimit = limit;
    waitLeft = current.duration + limit - elapsed;
    if (waitLeft <= 0) waiting = null;
    if (waiting) return;
    const next = stepEntry(show, current.id, 1);
    if (next && next.id !== current.id) playEntry(next);
    else startedAt = performance.now(); // only one entry: keep it
  }, 500);

  /** the highest a person reaches (m above the floor): a hand, else the head */
  function reachOf(info) {
    let top = null;
    for (const j of ['leftHand', 'rightHand', 'leftWrist', 'rightWrist', 'head']) {
      const w = info.person.room?.joints?.[j];
      if (w && (top === null || w[1] > top)) top = w[1];
    }
    return top;
  }

  function telemetry() {
    const s = api.status();
    const ctx = rt.current?.ctx;
    const elapsed = (performance.now() - startedAt) / 1000;
    bus.send(
      'telemetry',
      {
        scene: rt.current?.name ?? null,
        title: rt.title,
        entry: current?.id ?? null,
        entryRemoved: !!current?.removed,
        state: switching ? 'switching' : s.state,
        elapsed,
        remaining: show.auto && current ? Math.max(0, current.duration - elapsed) : null,
        waiting,
        waitLeft: waiting ? waitLeft : null,
        waitLimit: waiting ? waitLimit : null,
        crowd,
        fps: s.fps,
        kinect: s.kinect,
        problem: rt.problem || null,
        tracker: api.personsActive() ? kinect.personTracker.statusText : null,
        status: ctx?.status || '',
        // where everybody stands (plan) and where the scene's projection puts them (x, y, norm)
        persons: api.sceneWall().persons.map((p) => ({
          id: p.id,
          slot: p.slot,
          css: p.person.css,
          x: p.x,
          y: p.y,
          z: p.z,
          dist: p.dist,
          lateral: p.lateral,
          real: p.real,
          shift: p.shift,
          inZone: p.inZone,
          top: p.top,
          feet: p.feet,
          norm: p.norm,
          scale: p.scale,
          gain: p.gain,
          height: Number.isFinite(p.person.height) ? p.person.height : null,
          reach: reachOf(p),
        })),
        projection: { scene: rt.current?.name ?? null, profile: api.sceneWall().projection },
        wizard: !!wizard,
        room: { found: wall.room.found, height: wall.room.height, source: wall.room.source, pitch: kinect.view.floor?.pitchDeg ?? null, matrix: [...wall.room.matrix] },
        xSign: api.xSign,
        tanH: wall.tanH,
        blocked: wall.blockedPersons,
        embedded: api.embedded,
        owner: api.owner || null,
        errors: rt.errors.slice(-6).map(({ where, message, count, at, scene }) => ({ where, message, count, at, scene })),
        blackout,
        pattern,
        over,
        led: [wall.setup.led.w, wall.setup.led.h],
        screen: {
          w: screen.width,
          h: screen.height,
          left: screen.availLeft ?? null,
          top: screen.availTop ?? null,
          dpr: devicePixelRatio,
          inner: [innerWidth, innerHeight],
          fullscreen: !!document.fullscreenElement,
        },
      },
      'control',
    );
  }
  setInterval(telemetry, TELEMETRY_MS);

  const shot = document.createElement('canvas');
  const shotG = shot.getContext('2d');
  function sendPreview(inst) {
    const led = wall.setup.led;
    const scale = Math.min(1, 640 / led.w);
    const w = Math.max(1, Math.round(led.w * scale));
    const h = Math.max(1, Math.round(led.h * scale));
    if (shot.width !== w || shot.height !== h) {
      shot.width = w;
      shot.height = h;
    }
    shotG.fillStyle = '#000';
    shotG.fillRect(0, 0, w, h);
    try {
      for (const l of rt.leaving) shotG.drawImage(l.inst.canvas, 0, 0, w, h);
      if (inst && rt.state !== 'loading') {
        shotG.globalAlpha = Number(inst.canvas.style.opacity || 1);
        shotG.drawImage(inst.canvas, 0, 0, w, h);
        shotG.globalAlpha = 1;
      }
      if (pattern || wizard) shotG.drawImage(overlay, 0, 0, w, h);
      bus.send('frame', { jpeg: shot.toDataURL('image/jpeg', 0.72), w, h, blackout }, 'control');
    } catch (e) {
      console.warn('preview', e);
    }
  }

  // ---------- test images ----------

  function drawPattern(now) {
    const W = overlay.width;
    const H = overlay.height;
    g.save();
    g.clearRect(0, 0, W, H);
    if (!(over && (pattern === 'people' || pattern === 'grid'))) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
    }
    const draw = { grid: drawGrid, people: drawPeople, bars: drawBars, ramp: drawRamp, sweep: drawSweep }[pattern];
    if (draw) draw(W, H, now);
    else {
      g.fillStyle = { white: '#fff', red: '#f00', green: '#0f0', blue: '#00f' }[pattern] ?? '#000';
      g.fillRect(0, 0, W, H);
    }
    g.restore();
  }

  const px = (n) => Math.max(1, Math.round(n));

  function drawGrid(W, H) {
    const s = wall.setup;
    const cw = s.cabinet.w;
    const ch = s.cabinet.h;
    g.fillStyle = '#3a3a44';
    for (let x = cw; x < W; x += cw) g.fillRect(x, 0, 1, H);
    for (let y = ch; y < H; y += ch) g.fillRect(0, y, W, 1);
    // cabinet numbers (column.row)
    g.fillStyle = '#6a6a78';
    g.font = `${px(Math.min(cw, ch) / 6)}px system-ui, sans-serif`;
    g.textBaseline = 'top';
    for (let r = 0; r * ch < H; r++) for (let c = 0; c * cw < W; c++) g.fillText(`${c + 1}.${r + 1}`, c * cw + 3, r * ch + 3);
    // a circle: round on the wall if the pixels are mapped right
    g.strokeStyle = '#2bd4ff';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(W / 2, H / 2, H * 0.42, 0, Math.PI * 2);
    g.stroke();
    // center cross
    g.fillStyle = '#2bd4ff';
    g.fillRect(Math.floor(W / 2), 0, 1, H);
    g.fillRect(0, Math.floor(H / 2), W, 1);
    // corners: red top left, green top right, blue bottom left, yellow bottom right
    const k = px(Math.min(W, H) * 0.12);
    const tri = (x, y, dx, dy, col) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + dx * k, y);
      g.lineTo(x, y + dy * k);
      g.fill();
    };
    tri(0, 0, 1, 1, '#ff2030');
    tri(W, 0, -1, 1, '#20ff40');
    tri(0, H, 1, -1, '#3050ff');
    tri(W, H, -1, -1, '#ffe020');
    // meters along the bottom
    const ppm = W / s.size.w;
    g.fillStyle = '#ddd';
    g.font = `${px(H / 22)}px system-ui, sans-serif`;
    g.textBaseline = 'bottom';
    for (let m = 0; m <= s.size.w + 1e-6; m += 0.5) {
      const x = Math.min(W - 1, Math.round(m * ppm));
      const big = Math.abs(m - Math.round(m)) < 1e-6;
      g.fillRect(x, H - px(big ? H / 14 : H / 28), 1, px(big ? H / 14 : H / 28));
      if (big && m > 0 && m < s.size.w - 0.01) g.fillText(`${m} m`, x + 3, H - 3);
    }
    // the outermost LEDs: a 1-pixel white frame
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, 1);
    g.fillRect(0, H - 1, W, 1);
    g.fillRect(0, 0, 1, H);
    g.fillRect(W - 1, 0, 1, H);
    g.font = `600 ${px(H / 9)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(`${W} × ${H}`, W / 2, H / 2 - H * 0.1);
    g.font = `${px(H / 16)}px system-ui, sans-serif`;
    g.fillStyle = '#bbb';
    g.fillText(`${s.size.w} × ${s.size.h} m · ${(1000 * s.size.w / W).toFixed(2)} mm`, W / 2, H / 2 + H * 0.08);
  }

  function drawBars(W, H) {
    const cols = ['#fff', '#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#000'];
    const bw = W / cols.length;
    cols.forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect(Math.round(i * bw), 0, Math.ceil(bw), Math.round(H * 0.7));
    });
    for (let i = 0; i < 16; i++) {
      const v = Math.round((i / 15) * 255);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(Math.round((i * W) / 16), Math.round(H * 0.7), Math.ceil(W / 16), H);
    }
  }

  function drawRamp(W, H) {
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#000');
    grad.addColorStop(1, '#fff');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H / 2);
    const steps = 32;
    for (let i = 0; i < steps; i++) {
      const v = Math.round((i / (steps - 1)) * 255);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(Math.round((i * W) / steps), Math.round(H / 2), Math.ceil(W / steps), Math.ceil(H / 4));
    }
    // the darkest steps, where LED walls lose detail
    for (let i = 0; i < 16; i++) {
      g.fillStyle = `rgb(${i},${i},${i})`;
      g.fillRect(Math.round((i * W) / 16), Math.round((H * 3) / 4), Math.ceil(W / 16), H);
    }
  }

  function drawSweep(W, H, now) {
    const t = now / 1000;
    const x = Math.floor(((t * 0.25) % 1) * W);
    const y = Math.floor(((t * 0.4) % 1) * H);
    g.fillStyle = '#fff';
    g.fillRect(x, 0, 4, H);
    g.fillStyle = '#2bd4ff';
    g.fillRect(0, y, W, 2);
  }

  function drawPeople(W, H) {
    const sw = api.sceneWall(); // the projection of the scene on the wall
    const s = sw.setup;
    const ppm = W / s.size.w;
    const toPx = (p) => sw.px(p);
    // a 1 m grid on the wall, heights every 0.5 m
    g.fillStyle = 'rgba(70, 110, 255, 0.55)';
    for (let m = 0; m <= s.size.w + 1e-6; m += 1) g.fillRect(Math.min(W - 1, Math.round(m * ppm)), 0, 1, H);
    for (let y = Math.ceil(s.bottom * 2) / 2; y <= s.bottom + s.size.h; y += 0.5) {
      const [, py] = toPx([0, y]);
      g.fillRect(0, Math.min(H - 1, Math.round(py)), W, 1);
    }
    g.font = `${px(H / 22)}px system-ui, sans-serif`;
    g.fillStyle = 'rgba(150, 175, 255, 0.9)';
    g.textBaseline = 'bottom';
    for (let m = 1; m < s.size.w; m += 1) g.fillText(`${m} m`, Math.round(m * ppm) + 3, H - 3);
    // the sensor
    const sx = (s.size.w / 2 + s.sensor.x) * ppm;
    const [, sy] = toPx([0, wall.room.height]);
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(sx, sy - H * 0.03);
    g.lineTo(sx - H * 0.03, sy + H * 0.03);
    g.lineTo(sx + H * 0.03, sy + H * 0.03);
    g.fill();
    // the projection's target range (where the play field's edges land) and its quarters
    const [tl, tr] = sw.target;
    g.strokeStyle = 'rgba(255, 220, 120, 0.75)';
    for (let q = 0; q <= 4; q++) {
      const x = (tl + ((tr - tl) * q) / 4) * ppm;
      g.setLineDash(q % 4 ? [2, 6] : [6, 4]);
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
    g.setLineDash([]);
    for (const info of sw.persons) {
      const p = info.person;
      const col = p.css ?? '#fff';
      g.globalAlpha = info.inZone ? 1 : 0.35;
      // where the person really stands -> where the wall shows them
      const rx = info.real * ppm;
      const mx = info.x * ppm;
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(rx, 0);
      g.lineTo(rx, H);
      g.stroke();
      g.setLineDash([]);
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(rx, H * 0.06);
      g.lineTo(mx, H * 0.06);
      g.stroke();
      g.fillStyle = col;
      g.fillRect(Math.round(mx), 0, 1, H);
      // the skeleton as the wall maps it
      g.lineWidth = 3;
      g.lineCap = 'round';
      for (const [a, b] of BONES) {
        const ja = sw.joint(p, POINTS[a]);
        const jb = sw.joint(p, POINTS[b]);
        if (!ja || !jb) continue;
        const [ax, ay] = toPx(ja);
        const [bx, by] = toPx(jb);
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
      }
      const head = sw.joint(p, 'head');
      if (head) {
        const [hx, hy] = toPx(head);
        g.beginPath();
        g.arc(hx, hy, 0.11 * ppm, 0, Math.PI * 2);
        g.stroke();
      }
      const [, fy] = toPx([0, info.feet]);
      g.beginPath();
      g.ellipse(mx, fy, 0.25 * ppm, 0.05 * ppm, 0, 0, Math.PI * 2);
      g.stroke();
      g.font = `600 ${px(H / 16)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'bottom';
      const [, ty] = toPx([0, info.top + 0.08]);
      g.fillText(`${info.dist.toFixed(1)} m · ${info.norm[0].toFixed(2)} / ${info.norm[2].toFixed(2)}`, mx, Math.max(px(H / 14), ty));
      g.textAlign = 'left';
      g.globalAlpha = 1;
      g.lineWidth = 1;
    }
  }

  // ---------- the play field assistant (control center: "Assistent") ----------

  // A small floor plan on the wall, so somebody alone in front of it sees where to go: the wall on
  // top, the audience below, x as people facing the wall see it. The view cone, the corners caught
  // so far, the corner asked for, everybody in front (the one being measured with a progress ring).
  function drawWizard(now) {
    const W = overlay.width;
    const H = overlay.height;
    const s = wall.setup;
    const w = wizard;
    g.save();
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const depth = Math.max(4, (w.far ?? 4.5) + 0.6);
    const half = Math.max(s.size.w / 2 + 0.3, (depth - s.sensor.front) * wall.tanH + 0.3);
    const cx = s.size.w / 2 + s.sensor.x;
    const scale = Math.min((H * 0.9) / depth, (W * 0.42) / (2 * half));
    const ox = W / 2 - cx * scale;
    const oy = H * 0.05;
    const P = (x, z) => [ox + x * scale, oy + z * scale];
    // the wall and a 1 m grid
    g.strokeStyle = 'rgba(80, 110, 200, 0.35)';
    g.lineWidth = 1;
    for (let x = Math.ceil(cx - half); x <= cx + half; x++) {
      const [a, b] = P(x, 0);
      g.beginPath();
      g.moveTo(a, b);
      g.lineTo(a, oy + depth * scale);
      g.stroke();
    }
    for (let z = 1; z < depth; z++) {
      const [, b] = P(0, z);
      g.beginPath();
      g.moveTo(ox + (cx - half) * scale, b);
      g.lineTo(ox + (cx + half) * scale, b);
      g.stroke();
    }
    g.fillStyle = '#8fc1ff';
    const [wx0, wy] = P(0, 0);
    g.fillRect(wx0, wy - 3, s.size.w * scale, 3);
    // the view cone
    const [sx, sy] = P(cx, s.sensor.front);
    g.fillStyle = 'rgba(120, 170, 255, 0.12)';
    g.beginPath();
    g.moveTo(sx, sy);
    const reach = depth - s.sensor.front;
    g.lineTo(...P(cx - reach * wall.tanH, depth));
    g.lineTo(...P(cx + reach * wall.tanH, depth));
    g.closePath();
    g.fill();
    g.fillStyle = '#fff';
    g.fillRect(sx - 4, sy - 2, 8, 4);
    // the play field so far
    const pts = (w.corners ?? []).filter(Boolean);
    if (pts.length >= 2) {
      g.strokeStyle = 'rgba(255, 220, 120, 0.9)';
      g.lineWidth = 2;
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(...P(x, z)) : g.moveTo(...P(x, z))));
      if (pts.length === 4) g.closePath();
      g.stroke();
    }
    for (const [x, z] of pts) {
      const [a, b] = P(x, z);
      g.fillStyle = '#ffdc78';
      g.beginPath();
      g.arc(a, b, 5, 0, Math.PI * 2);
      g.fill();
    }
    // where to go: a blinking ring at the corner's rough place
    if (w.hint) {
      const [a, b] = P(w.hint[0], w.hint[1]);
      g.strokeStyle = `rgba(255, 255, 255, ${0.45 + 0.4 * Math.sin(now / 180)})`;
      g.lineWidth = 2;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.arc(a, b, 16, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    // the people
    for (const p of wall.persons) {
      const [a, b] = P(p.real, p.z);
      const me = p.id === w.person;
      g.fillStyle = p.person.css ?? '#fff';
      g.beginPath();
      g.arc(a, b, me ? 9 : 6, 0, Math.PI * 2);
      g.fill();
      if (me && w.progress > 0) {
        g.strokeStyle = '#fff';
        g.lineWidth = 4;
        g.beginPath();
        g.arc(a, b, 17, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, w.progress));
        g.stroke();
      }
    }
    // the text, left and right of the plan
    g.fillStyle = '#fff';
    g.textBaseline = 'top';
    g.textAlign = 'left';
    const left = W * 0.03;
    const maxW = ox + (cx - half) * scale - left - W * 0.02;
    g.font = `600 ${px(H / 13)}px system-ui, sans-serif`;
    g.fillText(w.title ?? '', left, H * 0.08, maxW);
    g.font = `${px(H / 20)}px system-ui, sans-serif`;
    g.fillStyle = '#c8c8d4';
    wrap(w.text ?? '', left, H * 0.08 + H / 9, maxW, H / 15);
    g.textAlign = 'left';
    const right = ox + (cx + half) * scale + W * 0.02;
    g.fillStyle = w.ok ? '#8fe0a0' : '#ffcf6b';
    g.font = `600 ${px(H / 16)}px system-ui, sans-serif`;
    wrap(w.status ?? '', right, H * 0.1, W - right - W * 0.02, H / 13);
    g.restore();
  }

  function wrap(text, x, y, maxW, lh) {
    let line = '';
    for (const word of String(text).split(/\s+/)) {
      const t = line ? `${line} ${word}` : word;
      if (g.measureText(t).width > maxW && line) {
        g.fillText(line, x, y);
        y += lh;
        line = word;
      } else line = t;
    }
    if (line) g.fillText(line, x, y);
  }

  // ---------- start ----------

  loadShow()
    .then(() => {
      let id = '';
      try {
        id = localStorage.getItem(CURRENT_KEY) ?? '';
      } catch {
        // none remembered
      }
      const entry = show.entries.find((e) => e.id === id && e.enabled) ?? stepEntry(show, null, 1);
      return playEntry(entry ?? null, 'cut');
    })
    .catch((e) => api.pushError('Show', e));
  telemetry();
}
