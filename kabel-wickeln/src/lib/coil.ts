// The two pictures of a coil the animation uses:
//
// 1. `handCoil`: the coil as you see it in your own hands. The left fist holds the loops; inside it
//    the cable runs from right to left, each loop leaves the fist on the left, hangs down and comes
//    back in on the right. The rest of the cable hangs from the fist to the floor and lies there to
//    the right. The right hand picks it up from the floor and brings it up to the fist: a new loop.
//
// 2. `curlRow`: the loops pulled apart sideways, as on a table: a row of curls. Each curl crosses
//    itself once; "über" means the cable runs over itself there, "unter" under itself.

import { CableGeom, P3, Path3, STEP, arcLengths, arcOfLength, resample } from './geom';
import { TAU, clamp, hash, lerp, smooth } from './math';

export type Kind = 'over' | 'under';

/** values given per point of `raw`, looked up for the points of its resampled copy `pts` */
export function carry<T>(raw: P3[], vals: T[], pts: P3[]): T[] {
  const rawS = arcLengths(raw);
  const s = arcLengths(pts);
  const out: T[] = [];
  let r = 0;
  for (let i = 0; i < pts.length; i++) {
    while (r < rawS.length - 1 && rawS[r + 1] < s[i]) r++;
    out.push(vals[Math.min(r + 1, vals.length - 1)]);
  }
  return out;
}

/** a polyline morphed into another one point by point (both resampled to the same count) */
export function morph(a: P3[], b: P3[], t: number): P3[] {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const n = Math.max(a.length, b.length);
  const ra = resampleCount(a, n);
  const rb = resampleCount(b, n);
  return ra.map((p, i) => [lerp(p[0], rb[i][0], t), lerp(p[1], rb[i][1], t), lerp(p[2], rb[i][2], t)] as P3);
}

function resampleCount(pts: P3[], n: number): P3[] {
  const s = arcLengths(pts);
  const total = s[s.length - 1];
  const out: P3[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const target = (total * i) / Math.max(1, n - 1);
    while (k < s.length - 2 && s[k + 1] < target) k++;
    const t = clamp((target - s[k]) / (s[k + 1] - s[k] || 1));
    out.push([lerp(pts[k][0], pts[k + 1][0], t), lerp(pts[k][1], pts[k + 1][1], t), lerp(pts[k][2], pts[k + 1][2], t)]);
  }
  return out;
}

export interface HandCoilOpts {
  /** centre of the left fist */
  hx: number;
  hy: number;
  /** distance between where the loops leave and enter the fist */
  fist: number;
  /** length of one loop outside the fist */
  loop: number;
  /** finished loops */
  done: number;
  /** the loop in the making: 0 the right hand at the floor, 1 at the fist */
  form: number;
  /** after `form` reached 1: 0..1 the right hand lets go and the rest falls back */
  release: number;
  floorY: number;
  /** total length of the cable */
  total: number;
  /** length of the end that hangs from the fist with the plug */
  tail: number;
  kinds: Kind[];
  /** the twist the hands put into a loop is shown on the stripe */
  twist?: boolean;
}

/** where the loops leave (left) and enter (right) the fist: a little different for each loop */
function ends(o: HandCoilOpts, k: number) {
  const j = (a: number, s: number) => (hash(k, a) - 0.5) * s;
  return {
    lx: o.hx - o.fist / 2 + j(1, 14),
    ly: o.hy + 4 + j(2, 6),
    rx: o.hx + o.fist / 2 + j(3, 14),
    ry: o.hy + 4 + j(4, 6),
    len: o.loop * (1 + j(5, 0.07)),
  };
}

/** the right hand's way from the floor up to the fist (form 0..1) */
export function rightHandPath(o: HandCoilOpts, k: number, form: number) {
  const e = ends(o, k);
  const g = grabPoint(o, k);
  const t = smooth(form);
  // up first, then over to the fist: a quadratic curve through a point out to the right
  const cx = Math.max(g.x, e.rx + 230);
  const cy = lerp(o.floorY, e.ry, 0.35);
  const u = 1 - t;
  return { x: u * u * g.x + 2 * u * t * cx + t * t * e.rx, y: u * u * g.y + 2 * u * t * cy + t * t * e.ry };
}

/** where the right hand takes the cable: one loop length along the hanging rest */
export function grabPoint(o: HandCoilOpts, k: number) {
  const e = ends(o, k);
  const hang = o.floorY - e.ly - 40;
  const along = e.len - hang - 40 * (Math.PI / 2);
  return { x: e.lx + 40 + Math.max(0, along), y: o.floorY };
}

/** the rest of the cable: hangs from (x, y) to the floor (bend radius 40) and lies there to the right */
function hanging(x: number, y: number, floorY: number, len: number): P3[] {
  const r = 40;
  const p = new Path3(x, y);
  const down = Math.max(0, floorY - r - y);
  p.line(x, y + down);
  p.arc(x + r, floorY - r, r, Math.PI, Math.PI / 2);
  const used = down + (Math.PI / 2) * r;
  p.line(x + r + Math.max(1, len - used), floorY);
  return p.pts;
}

/** the rest of the cable held by the right hand at (x, y): out to the right, down, along the floor */
function fromHand(x: number, y: number, floorY: number, len: number): P3[] {
  const p = new Path3(x, y);
  const drop = floorY - y;
  const fx = x + 60 + drop * 0.45;
  p.cubic(x + 40, y, fx - Math.max(20, drop * 0.25), y + drop * 0.1, fx, floorY);
  p.cubic(fx + 20, floorY, fx + 30, floorY, fx + 50, floorY);
  const used = arcLengths(p.pts).at(-1) ?? 0;
  p.line(fx + 50 + Math.max(1, len - used), floorY);
  return p.pts;
}

export interface HandCoil {
  geom: CableGeom;
  /** the right hand (centre of the fist) while it forms a loop */
  hand: { x: number; y: number } | null;
  /** arc length where each finished loop starts and ends (for markers) */
  loops: { from: number; to: number; kind: Kind }[];
  /** colour index per point: -1 cable, else the loop number */
  owner: number[];
}

export function handCoil(o: HandCoilOpts): HandCoil {
  const p = new Path3(o.hx + o.fist / 2 + 6, o.hy + o.tail);
  const owner: number[] = [];
  const mark = (k: number) => {
    while (owner.length < p.pts.length) owner.push(k);
  };
  // the end with the plug hangs out of the fist on the right
  const e0 = ends(o, 0);
  p.line(e0.rx, e0.ry);
  p.line(e0.lx, e0.ly);
  mark(-1);
  const loops: HandCoil['loops'] = [];
  let used = 0;
  const lenNow = () => arcLengths(p.pts).at(-1) ?? 0;
  for (let k = 0; k < o.done; k++) {
    const e = ends(o, k);
    const from = lenNow();
    p.append(arcOfLength(e.lx, e.ly, e.rx, e.ry, e.len));
    mark(k);
    loops.push({ from, to: lenNow(), kind: o.kinds[k] ?? 'over' });
    // through the fist to where the next loop leaves it
    const n = ends(o, k + 1);
    p.line(n.lx, n.ly);
    mark(-1);
  }
  used = lenNow();
  const rest = Math.max(10, o.total - used);
  let hand: HandCoil['hand'] = null;
  const k = o.done;
  if (o.form > 0 && o.release <= 0) {
    const e = ends(o, k);
    const h = rightHandPath(o, k, o.form);
    hand = h;
    const loop = arcOfLength(e.lx, e.ly, h.x, h.y, e.len);
    // the cable cannot go through the floor
    for (const q of loop) q[1] = Math.min(q[1], o.floorY);
    const after = fromHand(h.x, h.y, o.floorY, rest - e.len);
    const lifted = [...loop, ...after.slice(1)];
    // at first the cable still lies as it hung: morph from there
    const lying = hanging(e.lx, e.ly, o.floorY, rest);
    const w = smooth(o.form / 0.22);
    const moved = morph(lying, lifted, w);
    // the first part of it is the new loop (by arc length, as morph resamples evenly)
    const loopShare = (arcLengths(loop).at(-1) ?? 0) / (arcLengths(lifted).at(-1) || 1);
    const before = p.pts.length;
    p.append(moved);
    const added = p.pts.length - before;
    for (let i = 0; i < added; i++) owner.push(i / Math.max(1, added) < loopShare ? k : -1);
  } else if (o.release > 0) {
    // the loop is in the fist; the rest falls from the right hand to hang from the fist again
    const e = ends(o, k);
    const from = lenNow();
    p.append(arcOfLength(e.lx, e.ly, e.rx, e.ry, e.len));
    mark(k);
    loops.push({ from, to: lenNow(), kind: o.kinds[k] ?? 'over' });
    const n = ends(o, k + 1);
    const restAfter = Math.max(10, rest - e.len);
    const held = fromHand(e.rx, e.ry, o.floorY, restAfter);
    const fallen = [...new Path3(e.rx, e.ry).line(n.lx, n.ly).pts, ...hanging(n.lx, n.ly, o.floorY, restAfter - (e.rx - n.lx)).slice(1)];
    p.append(morph(held, fallen, smooth(o.release)));
    mark(-1);
  } else {
    p.append(hanging(p.last[0], p.last[1], o.floorY, rest));
    mark(-1);
  }

  // resample, carry the owners along, and the twist for the stripe
  const pts = resample(p.pts, STEP);
  const s = arcLengths(pts);
  const own = carry(p.pts, owner, pts);
  const phi = s.map((x) => {
    if (!o.twist) return 0;
    let a = 0;
    for (const l of loops) {
      if (x <= l.from) break;
      const f = clamp((x - l.from) / (l.to - l.from));
      a += (l.kind === 'over' ? 1 : -1) * TAU * f;
    }
    return a;
  });
  return { geom: { pts, phi, plugStart: true, plugEnd: true }, hand, loops, owner: own };
}

export interface CurlRowOpts {
  x0: number;
  x1: number;
  y: number;
  /** curls and their kind */
  kinds: Kind[];
  /** radius of a curl */
  r: number;
  /** straight cable before the first and after the last curl */
  lead: number;
  /** 0..1: the curls open up into a straight line (the cable is pulled out) */
  open?: number;
}

/**
 * A row of curls between x0 and x1 at height y (a prolate cycloid): the cable runs to the right
 * along the top and loops back once per curl. Each crossing gets its z from the curl's kind.
 */
export function curlRow(o: CurlRowOpts): { pts: P3[]; owner: number[]; centres: { x: number; y: number; kind: Kind }[] } {
  const n = o.kinds.length;
  const open = smooth(o.open ?? 0);
  const width = o.x1 - o.x0 - 2 * o.lead;
  const a = width / (TAU * n);
  const r = o.r * (1 - open);
  const p = new Path3(o.x0, o.y - r);
  p.line(o.x0 + o.lead, o.y - r);
  const owner: number[] = p.pts.map(() => -1);
  const centres: { x: number; y: number; kind: Kind }[] = [];
  const steps = n * 220;
  // u runs from π (top) over n curls; crossings near u = 2πk
  const start = Math.PI;
  for (let i = 1; i <= steps; i++) {
    const u = start + (TAU * n * i) / steps;
    const k = Math.round((u - start) / TAU - 0.5);
    const kind = o.kinds[Math.min(n - 1, Math.max(0, k))];
    const local = u - TAU * (k + 1);
    const z = (kind === 'over' ? 1 : -1) * Math.sin(local) * 10;
    const x = o.x0 + o.lead + a * (u - start) - r * Math.sin(u);
    const y = o.y + r * Math.cos(u);
    p.pts.push([x, y, Math.abs(local) < Math.PI ? z : 0]);
    owner.push(Math.min(n - 1, Math.max(0, k)));
  }
  for (let k = 0; k < n; k++) centres.push({ x: o.x0 + o.lead + a * (TAU * (k + 0.5)), y: o.y + r * 0.35, kind: o.kinds[k] });
  p.line(o.x1, o.y - r);
  while (owner.length < p.pts.length) owner.push(-1);
  const pts = resample(p.pts, STEP);
  return { pts, owner: carry(p.pts, owner, pts), centres };
}

export interface RollOutOpts {
  /** where the right hand holds the end */
  x0: number;
  floorY: number;
  /** radius of the ring */
  R: number;
  total: number;
  /** how much cable lies on the floor already */
  laid: number;
}

/**
 * The coil thrown out: the right hand holds the end, the ring rolls to the right along the floor and
 * lays the cable down behind it. The loops turn with the ring (their wobble belongs to the cable).
 */
export function rollOut(o: RollOutOpts): CableGeom {
  const p = holdPath(o);
  const { x: cx, max } = rollRing(o);
  const laid = Math.max(0, Math.min(o.laid, max));
  const start = (arcLengths(p.pts).at(-1) ?? 0) + o.R + 30;
  p.line(cx, o.floorY);
  const remaining = o.total - start - laid;
  const cy = o.floorY - o.R;
  const turn = TAU * o.R;
  const n = Math.max(2, Math.ceil(remaining / 2));
  p.fn((t) => {
    // u: distance from the inner end of the cable (belongs to the cable, turns with the ring)
    const along = t * remaining;
    const u = remaining - along;
    const r = o.R * (1 - 0.05 * Math.sin((u / turn) * 2.3 + 0.7) - 0.03 * Math.cos((u / turn) * 5.1));
    const a = Math.PI / 2 - along / o.R;
    // the ring sits on the floor: the radius grows from the contact point
    const k = smooth(along / 60);
    const rr = lerp(o.R, r, k);
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a), 0];
  }, n);
  return { pts: resample(p.pts, STEP), plugStart: true, plugEnd: true };
}

/** from the right hand down to the floor */
function holdPath(o: RollOutOpts) {
  const hold = 70;
  const p = new Path3(o.x0, o.floorY - hold);
  p.cubic(o.x0, o.floorY - hold * 0.4, o.x0 + hold * 0.3, o.floorY, o.x0 + hold * 0.8, o.floorY);
  return p;
}

/** the ring's position for a given amount laid down, and how much can be laid at most */
export function rollRing(o: RollOutOpts) {
  const p = holdPath(o);
  // the ring starts next to the hand, not on it
  const start = (arcLengths(p.pts).at(-1) ?? 0) + o.R + 30;
  const max = o.total - start - 6;
  return { x: p.last[0] + o.R + 30 + Math.min(Math.max(0, o.laid), max), max };
}

/** length of a hand coil with `done` loops and the rest hanging down to the floor plus `end` */
export function coilLength(o: HandCoilOpts, end: number) {
  const c = handCoil({ ...o, form: 0, release: 0, total: 1e5 });
  const s = arcLengths(c.geom.pts);
  // where the rest starts hanging: the end of the last loop plus the way through the fist
  const last = c.loops.at(-1);
  const hangFrom = last ? last.to + o.fist : o.tail + o.fist;
  return Math.min(s.at(-1) ?? 0, hangFrom + (o.floorY - o.hy) + end);
}

/**
 * The twist that a row of curls puts into the cable once it is pulled straight, at position x: each
 * curl one full turn, "über" one way, "unter" the other. While the curl opens (`amount` 0..1) the
 * turn spreads out from the middle of the curl over its whole length; the ends of the cable never
 * turn (a full turn looks the same as none).
 */
export function rowTwist(o: CurlRowOpts, x: number, amount: number, spread = 1) {
  const n = o.kinds.length;
  const period = (o.x1 - o.x0 - 2 * o.lead) / n;
  const f = (x - o.x0 - o.lead) / period;
  const w = Math.max(1e-3, amount * spread);
  let a = 0;
  for (let k = 0; k < n; k++) {
    const sign = o.kinds[k] === 'over' ? 1 : -1;
    a += sign * smooth(clamp((f - k - 0.5) / w + 0.5));
  }
  return a * TAU;
}

/**
 * A straight cable with pigtails: small loops that a twisted cable throws when it lies free.
 * `amount` 0 = straight, 1 = loops of radius `rho`.
 */
export function kinkLine(x0: number, x1: number, y: number, kinks: number[], amount: number, rho = 26): P3[] {
  const p = new Path3(x0, y);
  const r = rho * smooth(amount);
  const a = 9;
  for (const kx of kinks) {
    p.line(kx - a * Math.PI, y);
    p.fn((t) => {
      const u = -Math.PI + TAU * t;
      return [kx + a * u - r * Math.sin(u), y - r * (1 + Math.cos(u)), 6 * Math.sin(u)];
    }, 120);
  }
  p.line(x1, y, 0);
  return resample(p.pts, STEP);
}
