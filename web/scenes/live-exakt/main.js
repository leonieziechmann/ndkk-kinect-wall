// Live und exakt: what persons: { live: true } gives a scene. The live skeletons come at once
// (colored); the exact ones of every frame follow 100–250 ms later (thin, white). A raised hand is
// noticed on the live data at once (yellow ring) and then checked against the exact frames with
// LiveCheck: green = confirmed, red = overruled. The status line measures how far the live joints
// are from the exact ones of the same frame.
//
// Template for scenes that react at once and decide on the exact data (see /PERSONS.md, "Live and
// exact"):
//   - persons: { live: true }: ctx.persons is live; ctx.persons.exact, .exactUpdates, .exactAt(seq),
//     .liveAt(seq) bring the exact data
//   - LiveCheck: claims made on the live data, settled by the exact ones

import { LiveCheck, BONES, POINTS } from '/lib/persons.js';

const UP = 0.1; // m above the head: a hand counts as raised
const DOWN = 0.0; // m: lowered again (hysteresis)
const HANDS = ['leftHand', 'rightHand'];
const COMPARED = POINTS.slice(0, 22); // the 17 COCO joints, neck, pelvis, head, hands (raw camera points)

let g = null;
let mask = null; // 512×424 canvas with the live silhouettes
let maskData = null;
let check = null;
let raised = new Set(); // `${id}:${hand}` raised on the live data
let marks = []; // { claim, x, y, until }
let errs = []; // recent |live - exact| in cm, all compared points
let handErrs = [];
let missing = 0; // exact persons not in the live frame of the same seq
let compared = 0;
const tally = { ok: 0, no: 0, none: 0, waited: [] };
let shown = '';
let shownAt = 0;

/** A raw camera point (mm) of a person entry, or null. */
function raw(c, k) {
  const p = k < 17 ? c.joints[k] : c.extra?.[k - 17];
  return p && p[3] > 0 ? p : null;
}

function handRaised(p, hand, margin) {
  const h = p?.joints[hand];
  const head = p?.joints.head;
  return !!(h && head && h[1] > head[1] + margin);
}

function quantile(a, q) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(q * (s.length - 1))];
}

function push(a, v, n = 3000) {
  a.push(v);
  if (a.length > n) a.splice(0, a.length - n);
}

/** The exact frames that came in: how far the live joints of the same frame were from them. */
function measure(updates) {
  for (const ex of updates) {
    const lv = ex.liveAt(ex.seq);
    if (!lv) continue;
    for (const p of ex) {
      const q = lv.byId(p.id);
      compared++;
      if (!q) {
        missing++;
        continue;
      }
      for (let k = 0; k < COMPARED.length; k++) {
        const a = raw(p.camera, k);
        const b = raw(q.camera, k);
        if (!a || !b) continue;
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 10;
        push(errs, d);
        if (COMPARED[k] === 'leftHand' || COMPARED[k] === 'rightHand') push(handErrs, d);
      }
    }
  }
}

function drawSkeleton(view, color, width, ctx) {
  for (const p of view) {
    g.strokeStyle = color ?? p.css;
    g.lineWidth = width * ctx.pixelRatio;
    g.beginPath();
    for (const [a, b] of BONES) {
      const pa = p.image.joints[POINTS[a]];
      const pb = p.image.joints[POINTS[b]];
      if (!pa || !pb) continue;
      const [x0, y0] = ctx.kinectToScreen(pa[0], pa[1]);
      const [x1, y1] = ctx.kinectToScreen(pb[0], pb[1]);
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
    }
    g.stroke();
  }
}

function drawMask(ctx, alpha) {
  const r = ctx.kinect.persons;
  if (!r?.labels) return;
  const px = maskData.data;
  const view = ctx.persons;
  const rgb = new Map(view.all.map((p) => [p.slot, p.color.map((c) => Math.round(c * 255))]));
  px.fill(0);
  for (const i of r.indices) {
    const c = rgb.get(r.labels[i]);
    if (!c) continue;
    px[i * 4] = c[0];
    px[i * 4 + 1] = c[1];
    px[i * 4 + 2] = c[2];
    px[i * 4 + 3] = 255;
  }
  mask.getContext('2d').putImageData(maskData, 0, 0);
  const [x0, y0] = ctx.kinectToScreen(0, 0);
  const [x1, y1] = ctx.kinectToScreen(511, 423);
  g.save();
  g.globalAlpha = alpha;
  g.imageSmoothingEnabled = true;
  g.translate(x0, y0);
  g.scale(Math.sign(x1 - x0) || 1, 1);
  g.drawImage(mask, 0, 0, Math.abs(x1 - x0), y1 - y0);
  g.restore();
}

export default {
  streams: ['persons'],
  persons: (p) => ({ live: p.live, mode: p.mode === 'Skelett' ? 'skeleton' : 'full' }),

  params: {
    live: { value: true, label: 'Live + exakt (aus: nur verzögert)' },
    compare: { value: 'jetzt', options: ['jetzt', 'gleiches Frame'], label: 'Exaktes Skelett' },
    mode: { value: 'Voll', options: ['Voll', 'Skelett'], label: 'Tracker' },
    silhouettes: { value: 0.25, min: 0, max: 1, step: 0.05, label: 'Silhouetten' },
  },

  setup(ctx) {
    g = ctx.canvas.getContext('2d');
    mask = document.createElement('canvas');
    mask.width = 512;
    mask.height = 424;
    maskData = new ImageData(512, 424);
    check = new LiveCheck((exact, c) => handRaised(exact.byId(c.id), c.hand, UP), { before: 2, after: 3 });
  },

  frame(ctx) {
    const view = ctx.persons;
    g.fillStyle = '#000';
    g.fillRect(0, 0, ctx.width, ctx.height);
    if (ctx.params.silhouettes > 0) drawMask(ctx, ctx.params.silhouettes);

    // live: a hand goes up -> a claim at once
    for (const p of view) {
      for (const hand of HANDS) {
        const key = `${p.id}:${hand}`;
        if (!raised.has(key) && handRaised(p, hand, UP)) {
          raised.add(key);
          const at = p.image.joints[hand];
          const [x, y] = at ? ctx.kinectToScreen(at[0], at[1]) : [-1e4, -1e4];
          marks.push({ claim: check.add(view, { id: p.id, hand }), x, y, until: Infinity });
        } else if (raised.has(key) && !handRaised(p, hand, DOWN)) raised.delete(key);
      }
    }
    for (const key of raised) if (!view.byId(Number(key.split(':')[0]))) raised.delete(key);

    // exact: settle the claims, measure the live error
    for (const c of check.update(view)) {
      if (c.ok === true) tally.ok++;
      else if (c.ok === false) tally.no++;
      else tally.none++;
      if (c.ok !== null) push(tally.waited, c.waitedMs, 200);
      const m = marks.find((x) => x.claim === c);
      if (m) m.until = ctx.time + 1.5;
    }
    measure(view.exactUpdates);

    // skeletons: live (colored) and exact (white)
    const exact = view.exact;
    if (ctx.params.compare === 'gleiches Frame' && exact && exact !== view) {
      const lv = view.liveAt(exact.seq);
      if (lv) drawSkeleton(lv, null, 3, ctx);
    } else drawSkeleton(view, null, 3, ctx);
    if (exact && exact !== view) {
      g.setLineDash([6 * ctx.pixelRatio, 4 * ctx.pixelRatio]);
      drawSkeleton(exact, '#ffffff', 1.5, ctx);
      g.setLineDash([]);
    }

    // the claims: yellow while open, green confirmed, red overruled, gray no exact data
    marks = marks.filter((m) => m.until > ctx.time);
    for (const m of marks) {
      const ok = m.claim.ok;
      g.strokeStyle = ok === undefined ? '#ffd23a' : ok ? '#3dff7a' : ok === false ? '#ff3d5a' : '#888';
      g.globalAlpha = m.until === Infinity ? 1 : Math.max(0, Math.min(1, m.until - ctx.time));
      g.lineWidth = 4 * ctx.pixelRatio;
      g.beginPath();
      g.arc(m.x, m.y, 22 * ctx.pixelRatio, 0, 2 * Math.PI);
      g.stroke();
      g.globalAlpha = 1;
    }

    // status (twice a second)
    if (ctx.time - shownAt > 0.5) {
      shownAt = ctx.time;
      const n = view.length;
      const lag = exact && exact !== view ? Math.round((view.captureTimeUs - exact.captureTimeUs) / 1000) : null;
      const e50 = quantile(errs, 0.5);
      const e90 = quantile(errs, 0.9);
      const h50 = quantile(handErrs, 0.5);
      const w50 = quantile(tally.waited, 0.5);
      const f = (x) => (x === null ? '–' : x.toFixed(1));
      shown = [
        `${n} ${n === 1 ? 'Person' : 'Personen'} · ${view.mode}`,
        lag !== null ? `exakt ${lag} ms hinter live` : null,
        errs.length ? `live−exakt: Median ${f(e50)} cm, p90 ${f(e90)} cm, Hände ${f(h50)} cm` : null,
        compared ? `${missing} von ${compared} ohne Live-Gegenstück` : null,
        `Hand hoch: ${tally.ok} bestätigt, ${tally.no} verworfen${tally.none ? `, ${tally.none} ohne exakte Daten` : ''}${w50 !== null ? ` (nach ${Math.round(w50)} ms)` : ''}`,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    ctx.status = shown;
  },

  dispose() {
    check?.clear();
    raised = new Set();
    marks = [];
    errs = [];
    handErrs = [];
  },
};
