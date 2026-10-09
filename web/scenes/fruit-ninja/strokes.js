// The strokes of the blades, smooth and on the GPU (render.js draws them as soft ribbons, added onto
// the picture before the bloom):
// - the blade: the live hand, a thin crisp stroke, a white core in a glow of the player's color,
//   thick at the tip, thin at the tail;
// - the woosh: the exact skeletons follow 0.1-0.2 s later and draw the same swipe once more, thick and
//   soft with speed lines in it, like a gust of wind after the blade; it drifts on in the direction of
//   the swipe, widens and fades;
// - the slash: the cut through a fruit, a white lens.
//
// The tracking points come at 30 per second and wobble by a few cm, so a stroke does not follow them
// directly. A tracer runs a little behind them (`smoothDelay`, about two points): there the points
// before and after are known, and a Catmull-Rom spline through them gives a smooth path; the tip
// follows that path on a damped spring (`inertia`), which takes out what wobble is left. Its trail,
// sampled every frame, is the stroke. Cutting does not wait for any of this (people.js, game.js).

const FLOATS = 12; // per vertex: x, y (LED px), across (-1..1), along (0..1) | r, g, b, a | core, kind, 0, 0
export const MAX_TRAIL_VERTS = 30000;
export const KIND = { BLADE: 0, WOOSH: 1 };

const mixWhite = (c, k) => [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k];
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const cr = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

/**
 * A smooth tip that follows tracked points: at time `now - delay` on a Catmull-Rom spline through them,
 * on a damped spring. Its trail (every frame) is what is drawn.
 */
class Tracer {
  constructor() {
    this.x = null;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.t = 0;
    this.trail = []; // { x, y, t, v } wall m, s, m/s
    this.seen = 0;
  }

  /** pts: [{ x, y, t }] (t: when the point counts, ascending); time: the clock of t */
  update(pts, now, delay, omega, keep, maxJump) {
    if (!pts.length) return;
    this.seen = now;
    const T = now - delay;
    let k = pts.length - 1;
    while (k > 0 && pts[k].t > T) k--;
    let tx;
    let ty;
    if (T <= pts[0].t) {
      tx = pts[0].x;
      ty = pts[0].y;
    } else if (k >= pts.length - 1) {
      tx = pts[k].x; // past the newest point: hold it
      ty = pts[k].y;
    } else {
      const p0 = pts[Math.max(0, k - 1)];
      const p1 = pts[k];
      const p2 = pts[k + 1];
      const p3 = pts[Math.min(pts.length - 1, k + 2)];
      const u = Math.min(1, Math.max(0, (T - p1.t) / Math.max(1e-4, p2.t - p1.t)));
      tx = cr(p0.x, p1.x, p2.x, p3.x, u);
      ty = cr(p0.y, p1.y, p2.y, p3.y, u);
    }
    if (this.x === null || Math.hypot(tx - this.x, ty - this.y) > maxJump || now - this.t > 0.5) {
      // new, or the hand was lost: start here
      this.x = tx;
      this.y = ty;
      this.vx = 0;
      this.vy = 0;
      this.trail.length = 0;
    } else {
      // a critically damped spring, in small steps
      let dt = Math.min(0.1, now - this.t);
      while (dt > 1e-6) {
        const h = Math.min(dt, 1 / 120);
        this.vx += (omega * omega * (tx - this.x) - 2 * omega * this.vx) * h;
        this.vy += (omega * omega * (ty - this.y) - 2 * omega * this.vy) * h;
        this.x += this.vx * h;
        this.y += this.vy * h;
        dt -= h;
      }
    }
    this.t = now;
    this.trail.push({ x: this.x, y: this.y, t: now, v: Math.hypot(this.vx, this.vy) });
    let n = 0;
    while (n < this.trail.length - 1 && now - this.trail[n].t > keep) n++;
    if (n) this.trail.splice(0, n);
  }
}

export class Strokes {
  constructor() {
    this.buf = new Float32Array(MAX_TRAIL_VERTS * FLOATS);
    this.n = 0;
    this.blades = new Map(); // blade key -> Tracer
    this.wooshes = new Map(); // exact blade key -> Tracer
  }

  /**
   * A ribbon along pts ([x, y, halfWidth, alpha] in LED px), color col, kind (KIND), core: the share of
   * the half width that is the crisp white core (blades).
   */
  ribbon(pts, col, kind, core = 0) {
    const m = pts.length;
    if (m < 2 || this.n + (m - 1) * 6 > MAX_TRAIL_VERTS) return;
    const L = [];
    const R = [];
    for (let i = 0; i < m; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(m - 1, i + 1)];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      const w = pts[i][2];
      L.push([pts[i][0] - dy * w, pts[i][1] + dx * w]);
      R.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
    }
    const B = this.buf;
    const put = (p, across, i) => {
      const o = this.n++ * FLOATS;
      B[o] = p[0];
      B[o + 1] = p[1];
      B[o + 2] = across;
      B[o + 3] = i / (m - 1);
      B[o + 4] = col[0];
      B[o + 5] = col[1];
      B[o + 6] = col[2];
      B[o + 7] = pts[i][3];
      B[o + 8] = core;
      B[o + 9] = kind;
    };
    for (let i = 0; i < m - 1; i++) {
      put(L[i], 1, i);
      put(R[i], -1, i);
      put(L[i + 1], 1, i + 1);
      put(L[i + 1], 1, i + 1);
      put(R[i], -1, i);
      put(R[i + 1], -1, i + 1);
    }
  }

  /** the tracers of a set of blades (key -> blade with pts); time(p): when a point counts */
  trace(map, blades, now, P, keep, time) {
    const omega = P.inertia;
    for (const [key, b] of blades) {
      let tr = map.get(key);
      if (!tr) map.set(key, (tr = new Tracer()));
      tr.col = b.col;
      tr.id = b.id;
      tr.slot = b.slot;
      tr.update(
        b.pts.map((p) => ({ x: p.x, y: p.y, t: time(p) })).filter((p) => p.t <= now + 1),
        now,
        P.smoothDelay,
        omega,
        keep,
        P.maxJump,
      );
    }
    for (const [key, tr] of map) if (!blades.has(key) || now - tr.seen > 0.6) map.delete(key);
  }

  /**
   * All strokes of this frame. S: the scene state (people, game, L), P: params, now: real time (s).
   */
  build(S, P, now) {
    this.n = 0;
    const { L, people, game } = S;
    const k = L.ppm * L.S; // LEDs per m
    const px = (x) => x * k;
    const py = (y) => (L.top - y) * k;
    const fast0 = P.cutSpeed * 0.45;
    const fast1 = P.cutSpeed;

    // the live blades: thin, thick at the tip; seen where the tip is fast
    this.trace(this.blades, people.blades, now, P, P.trail, (p) => p.t);
    for (const tr of this.blades.values()) {
      if (tr.slot && !people.shown(tr.slot)) continue;
      const n = tr.trail.length;
      if (n >= 2 && tr.trail[n - 1].v >= fast0 * 0.5) {
        const raw = tr.trail.map((q, i) => {
          const age = Math.min(1, (now - q.t) / P.trail);
          const u = i / (n - 1);
          const on = smoothstep(fast0, fast1, q.v);
          return [px(q.x), py(q.y), Math.max(1.4, P.bladeWidth * k * (0.25 + 0.75 * u ** 0.7)), (1 - age) ** 0.9 * on];
        });
        this.ribbon(raw, tr.col, KIND.BLADE, 0.38);
      }
      // the hand itself: a small soft point of light at the tip
      if (tr.id !== null && tr.x !== null && (!tr.slot || people.shown(tr.slot))) {
        const r = P.bladeWidth * k * 0.8;
        this.ribbon(
          [
            [px(tr.x) - r * 0.4, py(tr.y), r, 0.75],
            [px(tr.x) + r * 0.4, py(tr.y), r, 0.75],
          ],
          tr.col,
          KIND.BLADE,
          0.35,
        );
      }
    }

    // the woosh: the exact blades, played back as their frames come in, wide and soft; it drifts on
    if (P.woosh > 0) {
      const life = P.wooshLife;
      this.trace(this.wooshes, people.exactBlades, now, P, life, (p) => p.a);
      for (const tr of this.wooshes.values()) {
        const n = tr.trail.length;
        if (n < 2) continue;
        const raw = [];
        for (let i = 0; i < n; i++) {
          const q = tr.trail[i];
          const t = Math.min(1, (now - q.t) / life);
          // the way the swipe went here: the gust drifts on that way
          const a = tr.trail[Math.max(0, i - 2)];
          const b = tr.trail[Math.min(n - 1, i + 2)];
          const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const drift = P.wooshDrift * (1 - (1 - t) ** 2);
          const on = smoothstep(fast0, fast1, q.v);
          const w = P.wooshWidth * k * (0.55 + 0.9 * t);
          raw.push([px(q.x + ((b.x - a.x) / l) * drift), py(q.y + ((b.y - a.y) / l) * drift), w, P.woosh * on * (1 - t) ** 1.3 * 0.7]);
        }
        this.ribbon(raw, mixWhite(tr.col, 0.35), KIND.WOOSH);
      }
    }

    // the cuts through the fruit: a white lens along the cut
    for (const s of game.slashes) {
      const age = (game.real - s.t0) / s.life;
      const raw = [];
      for (let i = 0; i <= 8; i++) {
        const u = i / 8;
        raw.push([px(s.x0 + (s.x1 - s.x0) * u), py(s.y0 + (s.y1 - s.y0) * u), P.bladeWidth * k * 1.3 * Math.sin(Math.PI * u) ** 0.6 * (1 + age * 0.6), (1 - age) ** 1.5]);
      }
      this.ribbon(raw, [1, 0.95, 0.85], KIND.BLADE, 0.55);
    }
    return this.n;
  }
}
