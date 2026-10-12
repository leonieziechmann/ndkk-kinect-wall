// Stage 4 (KONZEPT "4 · Klettband", ≈ 45 s planned): the rough animation (animatic). Jonas' hands,
// his own view and close-ups.
//
//   1  prepare once (own view | close-up): the velcro tie goes on 13 cm below the male plug's boot
//      ("Leg das Band 10–30 cm vor dem Stecker ums Kabel.", a dimension line), the long end round the
//      cable and through its own eyelet (a 3D arrow shows the way), pulled tight (slow motion 0.25×,
//      then once in real time); the pull test: he pinches the tie and tugs it, the cable follows,
//      ✓ "Rutscht nicht."; "Bei XLR: am Stecker mit den Stiften." (label at the pins), then wide:
//      the other end in the mic on its stand, "So hängt am Mikro kein Band."
//   2  ✗ | ✓ side by side: a band only wrapped round the ring is opened and falls to the floor; the
//      band that lives on the cable stays on it ("Nur drumgewickelt? Fällt ab, ist weg.")
//   3  coiling starts with this end (own view | outside): two loops, the band stays at the top in his
//      hand, the rest sped up ("Mit diesem Ende fängst du an zu wickeln." / "Dann ist das Band oben
//      in deiner Hand.")
//   4  closing (own view | close-up): the other end up beside the fist, the band round the whole ring
//      next to the fist, closed; "Beide Stecker außen"; then three columns, the same lift and shake:
//      ✗ too tight (an exaggerated dent), ✓ right, ✗ too loose (what falls out of the loose tie is
//      simulated): "Fest, aber nicht quetschen."
//   5  a long ring (15 m): the second tie opposite the first ("Lange oder schwere Ringe: zwei Bänder
//      gegenüber.")
//   6  ✗ | ✗ | ✓: a plastic cable tie ("quetscht"), the cable knotted round itself ("knickt"), the
//      velcro tie ("Kein Kabelbinder, kein Knoten.")
//
// The cables: p4-prep, p4-ring-ok / -loose and p4-two are simulated (shots/p4-strap.ts: the XLR
// preset); the coiling at 3 is kinematic (the ring of p4-ring-ok's first frame laid down loop by loop),
// the knot and the dents are drawn (kinematic, exaggerated), the bands are kinematic everywhere
// (shots/p4-strap-shape.ts). Jonas: IK from simple keys; every beat that will come from a Kinect
// recording is in MOCAP_SLOTS (part seconds).

import { Line, Node, Rect, Txt } from '@motion-canvas/2d';
import { all, waitFor } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, loadBake } from '../../sim';
import {
  A, N, PREP, PREP_T, MIC, RC, REST_R, RING_GEOM, RING_T, S_STRAP, SPEC, STRAP, TO_PALM, TWO_T, WRAP_LAG, WRAP_PHI0, WRAP_TURNS, bottomSection, ease, gripPath,
  perp, pinchR, prepPlanFrom, prepRig, prepStrap, prepTrack, ramp, rigBase, ringGrip, ringPlanFrom, ringPoint, ringRig, ringTrack, strapSection, tieFrame, twoRig, twoTrack, valPath,
} from '../../shots/p4-strap';
import { BAND, BandPath, Section, choke, falling, held, round, zipTie } from '../../shots/p4-strap-shape';
import { Person3D } from '../../people/body3d';
import type { Pose } from '../../people/people';
import { Grip, HandRig, Rig, RigTrack, eyesOfRig, gripFrame } from '../../people/rig';
import { CAPTION_Y, GAP, PANEL_H, PanelTitle, TOP, clock, readTime, viewLayers } from '../../lib/kit';
import { StageChip } from '../../lib/ui';
import { C, FONT } from '../../lib/theme';
import { ArcArrow } from '../../three/arrows';
import { CableMesh } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit, povFollow } from '../../three/camera';
import { callout, project } from '../../three/overlay';
import { micStand } from '../../three/props';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

// ===================================================================================== small math

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const mix = (a: V3, b: V3, u: number): V3 => add(a, mul(sub(b, a), u));
const UP: V3 = [0, 1, 0];

// ===================================================================================== the timeline

type SetId = 'prep' | 'drop' | 'start' | 'close' | 'fit' | 'two' | 'ties';
interface Seg {
  id: string;
  set: SetId;
  /** scene seconds */
  len: number;
  /** the set's clock (its bake's shot time, or its own) at the start and end */
  from: number;
  to: number;
  at: number;
}
const SEGS: Seg[] = [];
let sceneAt = 0;
const hold = (set: SetId, id: string, at: number, l: number) => {
  SEGS.push({ id, set, len: l, from: at, to: at, at: sceneAt });
  sceneAt += l;
};
const play = (set: SetId, id: string, from: number, to: number, speed = 1) => {
  const l = (to - from) / speed;
  SEGS.push({ id, set, len: l, from, to, at: sceneAt });
  sceneAt += l;
};

/** the drop beat's own clock: the right hand to the band's end, peels it off, lets go; the bands fall or hang */
const DROP_T = { reach: 0.6, pinch: 1.3, peel1: 2.5, let: 2.6, away: 3.6, end: 4.2 };
/** the coiling (kinematic): two loops at teaching pace, the other four sped up */
const FLASH = { lead: 1.2, slow: 1.6, fast0: 6.0, fast: 0.55, end: 10.0 };
/** the wrong ties: the cable tie pulled tight, the knot pulled tight */
const TIES_T = { reach: 0.4, pull0: 0.9, pull1: 1.7, let: 2.0, end: 6.6 };
const SLOW = 0.25;

// 1 · prepare once
hold('prep', 'open', 0, 1.3);
play('prep', 'place', 0, PREP_T.wrap0);
hold('prep', 'dim', PREP_T.wrap0, 1.6);
hold('prep', 'c2', PREP_T.wrap0, 1.0);
play('prep', 'wrap', PREP_T.wrap0, PREP_T.thread1);
play('prep', 'slow', PREP_T.thread1, PREP_T.cinch1, SLOW);
hold('prep', 'slowEnd', PREP_T.cinch1, 0.6);
hold('prep', 'dipOut', PREP_T.cinch1, 0.3);
hold('prep', 'dipIn', PREP_T.wrap1, 0.3);
play('prep', 'rt', PREP_T.wrap1, PREP_T.let + 0.4);
play('prep', 'tug', PREP_T.let + 0.4, PREP_T.rest);
play('prep', 'pins', PREP_T.rest, PREP_T.rest + 4.4);
play('prep', 'mic', PREP_T.rest + 4.4, PREP_T.end);
hold('prep', 'micHold', PREP_T.end, 2.2);
// 2 · only wrapped round: it falls off
play('drop', 'drop', 0, DROP_T.end);
hold('drop', 'dropHold', DROP_T.end, 3.0);
// 3 · start with this end
play('start', 'flash', 0, FLASH.end);
// 4 · close: the end up, the band round the ring, closed; both plugs outside
hold('close', 'closeIn', RING_T.reach0 - 0.2, 0.6);
play('close', 'fetch', RING_T.reach0 - 0.2, RING_T.let);
play('close', 'wrapRing', RING_T.let, RING_T.press1);
hold('close', 'closed', RING_T.press1, 3.4);
// 4 · too tight | right | too loose: the same lift and shake
play('fit', 'fit', RING_T.press1 - 0.4, RING_T.end);
hold('fit', 'fitHold', RING_T.end, 1.2);
// 5 · two ties on a long ring
play('two', 'two', 0, TWO_T.end);
// 6 · cable tie, knot, velcro
play('ties', 'ties', 0, TIES_T.end);

/** the part's length [s] */
export const LENGTH = sceneAt;

function seg(id: string): Seg {
  const s = SEGS.find((x) => x.id === id);
  if (!s) throw new Error(`p4-strap: no segment ${id}`);
  return s;
}
/** scene time where segment id starts / ends */
const S = (id: string) => seg(id).at;
const E = (id: string) => seg(id).at + seg(id).len;
/** the segment at scene time tau */
function segAt(tau: number): Seg {
  let s = SEGS[0];
  for (const x of SEGS) {
    if (tau < x.at) break;
    s = x;
  }
  return s;
}
/** the set's clock at tau (while the set is on; outside it, its first or last value) */
function clockOf(set: SetId, tau: number): number {
  const list = SEGS.filter((x) => x.set === set);
  if (tau <= list[0].at) return list[0].from;
  let s = list[0];
  for (const x of list) {
    if (tau < x.at) break;
    s = x;
  }
  const u = s.len > 0 ? Math.min(1, Math.max(0, (tau - s.at) / s.len)) : 1;
  return s.from + (s.to - s.from) * u;
}
/** the scene time span of a set */
const span = (set: SetId) => {
  const list = SEGS.filter((x) => x.set === set);
  return { a: list[0].at, b: list[list.length - 1].at + list[list.length - 1].len };
};
/** a set's views: faded in at its start, out at its end (a dip through the background between sets) */
const FADE = 0.3;

// ===================================================================================== text

/** captions: text, from, to (part seconds) */
const CAPS: { text: string; a: number; b: number }[] = [
  { text: 'Leg das Band 10–30 cm vor dem Stecker ums Kabel.', a: 0.25, b: E('dim') },
  { text: 'Durch den eigenen Schlitz – festziehen.', a: S('c2'), b: E('slowEnd') },
  { text: 'Zugprobe: Zieh am Band.', a: S('tug') + 0.2, b: S('tug') + 0.2 + readTime('Zugprobe: Zieh am Band.') + 0.8 },
  { text: 'Bei XLR: am Stecker mit den Stiften.', a: S('pins') + 0.2, b: E('pins') },
  { text: 'So hängt am Mikro kein Band.', a: S('mic') + 0.2, b: E('micHold') - 0.1 },
  { text: 'Nur drumgewickelt? Fällt ab, ist weg.', a: S('drop') + 0.25, b: E('dropHold') - 0.2 },
  { text: 'Mit diesem Ende fängst du an zu wickeln.', a: S('flash') + 0.25, b: S('flash') + 5.0 },
  { text: 'Dann ist das Band oben in deiner Hand.', a: S('flash') + 5.1, b: E('flash') - 0.1 },
  { text: 'Leg das Band oben um den ganzen Ring.', a: S('wrapRing') + 0.0, b: S('closed') + 1.0 },
  { text: 'Fest, aber nicht quetschen.', a: S('fit') + 0.2, b: E('fitHold') - 0.2 },
  { text: 'Lange oder schwere Ringe: zwei Bänder gegenüber.', a: S('two') + 0.25, b: E('two') - 0.2 },
  { text: 'Kein Kabelbinder, kein Knoten.', a: S('ties') + 0.25, b: E('ties') - 0.4 },
];
const CAP_IN = 0.35, CAP_OUT = 0.3;

/** captions shorter than their reading time (characters / 12 + 1 s), overlapping or over ten words: printed when the part runs */
const captionProblems = (() => {
  const out: string[] = [];
  CAPS.forEach((c, i) => {
    const visible = c.b - c.a - CAP_IN;
    if (visible < readTime(c.text) - 0.01) out.push(`"${c.text}" visible ${visible.toFixed(2)} s < ${readTime(c.text).toFixed(2)} s`);
    if (i > 0 && c.a < CAPS[i - 1].b) out.push(`"${c.text}" overlaps the caption before`);
    if (c.text.split(/\s+/).length > 10) out.push(`"${c.text}" has more than 10 words`);
  });
  return out;
})();

// ===================================================================================== mocap

/**
 * Beats whose movement comes from a Kinect recording later (mocap/shots.json, part "p4-strap"; times
 * in part seconds). Until then Jonas moves by IK from simple keys.
 */
export const MOCAP_SLOTS = [
  { shot: 'p4.prep', role: 'Jonas', from: S('open'), to: E('tug'), note: 'Band an den Stecker mit Stiften, um das Kabel, durch den eigenen Schlitz, festziehen (Zeitlupe 0,25× und Echtzeit aus derselben Aufnahme), Zugprobe; Schusszeit = shots/p4-strap.ts PREP_T' },
  { shot: 'idle.stand', role: 'Jonas', from: S('pins'), to: E('micHold'), note: 'Stecker mit Band in der linken Hand halten, Blick zum Mikro (kein eigener Shot; Ende von p4.prep weiterlaufen lassen geht auch)' },
  { shot: 'p4.wrong.wrapped', role: 'Jonas', from: S('drop'), to: E('dropHold'), note: 'Band öffnen; beide Spalten (✗ nur drumgewickelt, ✓ am Kabel) zeigen dieselbe Bewegung: kein eigener Shot für ✓' },
  { shot: 'p4.start.end', role: 'Jonas', from: S('flash'), to: E('flash'), note: 'zwei Schlaufen im Lehrtempo, danach vier im Zeitraffer (~3×): die Aufnahme hat nur zwei Schlaufen, der Rest kommt aus p1.coil.natural' },
  { shot: 'p4.close', role: 'Jonas', from: S('closeIn'), to: E('closed'), note: 'anderes Ende hoch zur Faust, Band oben um den ganzen Ring, zu; am Ende Ring zeigen' },
  { shot: 'p4.close.tight', role: 'Jonas', from: S('fit'), to: E('fitHold'), note: 'linke Spalte ✗ zu fest: kräftig zuziehen, dann wie die anderen anheben und schütteln' },
  { shot: 'p4.close.loose', role: 'Jonas', from: S('fit'), to: E('fitHold'), note: 'rechte Spalte ✗ zu locker: am Band anheben, leicht schütteln; die mittlere Spalte ✓ nutzt dieselbe Bewegung (kein eigener Shot)' },
  { shot: 'p4.two.straps', role: 'Jonas', from: S('two'), to: E('two'), note: 'langer Ring, zweites Band unten gegenüber' },
  { shot: 'p4.wrong.ziptie', role: 'Jonas', from: S('ties'), to: E('ties'), note: 'linke Spalte: Kabelbinder zuziehen' },
  { shot: 'p4.wrong.knot', role: 'Jonas', from: S('ties'), to: E('ties'), note: 'mittlere Spalte: Kabelende um den Ring geknotet, zuziehen' },
];

// ===================================================================================== layout

const midY = TOP + PANEL_H / 2;
const fullW = 1920 - 2 * GAP;
const wL = Math.round((1920 - 3 * GAP) * 0.55);
const wR = 1920 - 3 * GAP - wL;
const xL = -960 + GAP, xR = 960 - GAP - wR;
const wHalf = (1920 - 3 * GAP) / 2;
const xHalf = [-960 + GAP + wHalf / 2, 960 - GAP - wHalf / 2];
const wCol = (1920 - 4 * GAP) / 3;
const xCol = [0, 1, 2].map((k) => -960 + GAP + wCol / 2 + k * (wCol + GAP));

// ===================================================================================== cables from bakes

/** a baked cable: node positions and stripe directions at a time, material coordinates, the cable proper between the plugs */
class Baked {
  readonly n: number;
  readonly pos: Float32Array;
  readonly d1: Float32Array;
  /** material coordinate of every node (from the first frame) */
  readonly s: Float64Array;
  readonly total: number;
  readonly i0: number;
  readonly i1: number;
  private t = NaN;
  constructor(readonly b: BakedRod) {
    const n = (this.n = b.n);
    this.pos = new Float32Array(3 * n);
    this.d1 = new Float32Array(3 * n);
    b.frameSample(0, this.pos, this.d1);
    this.s = new Float64Array(n);
    for (let i = 1; i < n; i++) this.s[i] = this.s[i - 1] + Math.hypot(this.pos[3 * i] - this.pos[3 * i - 3], this.pos[3 * i + 1] - this.pos[3 * i - 2], this.pos[3 * i + 2] - this.pos[3 * i - 1]);
    this.total = this.s[n - 1];
    this.i0 = this.node(0.06);
    this.i1 = this.node(this.total - 0.06);
  }
  /** the nearest node to material s */
  node(s: number) {
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.s[m] <= s) lo = m;
      else hi = m;
    }
    return s - this.s[lo] < this.s[hi] - s ? lo : hi;
  }
  at(t: number) {
    if (t !== this.t) {
      this.b.frameSample(t, this.pos, this.d1);
      this.t = t;
    }
    return this;
  }
  /** the point at material s (of the last at()) */
  point(s: number): V3 {
    const P = this.pos;
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.s[m] <= s) lo = m;
      else hi = m;
    }
    const u = Math.max(0, Math.min(1, (s - this.s[lo]) / Math.max(1e-9, this.s[hi] - this.s[lo])));
    return [P[3 * lo] + (P[3 * hi] - P[3 * lo]) * u, P[3 * lo + 1] + (P[3 * hi + 1] - P[3 * lo + 1]) * u, P[3 * lo + 2] + (P[3 * hi + 2] - P[3 * lo + 2]) * u];
  }
  tangent(s: number): V3 {
    return norm(sub(this.point(s + 0.008), this.point(s - 0.008)));
  }
  nodeP(i: number): V3 {
    return [this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]];
  }
}

/**
 * Lays nodes from..n-1 along a path (dense points), at the cable's own spacing, with the stripe
 * carried along (no twist): for kinematic pieces (the coiling, the knot).
 */
function layPath(pos: Float32Array, d1: Float32Array, s: Float64Array, from: number, path: V3[], floorY = RC) {
  const n = s.length;
  const arc = [0];
  for (let k = 1; k < path.length; k++) arc.push(arc[k - 1] + len(sub(path[k], path[k - 1])));
  let k = 0;
  let prevT: V3 = norm(sub([pos[3 * from], pos[3 * from + 1], pos[3 * from + 2]], [pos[3 * from - 3], pos[3 * from - 2], pos[3 * from - 1]]));
  let d: V3 = [d1[3 * from], d1[3 * from + 1], d1[3 * from + 2]];
  for (let i = from + 1; i < n; i++) {
    const want = s[i] - s[from];
    while (k < path.length - 2 && arc[k + 1] < want) k++;
    let p: V3;
    if (want <= arc[path.length - 1]) {
      const u = Math.max(0, Math.min(1, (want - arc[k]) / Math.max(1e-9, arc[k + 1] - arc[k])));
      p = mix(path[k], path[k + 1], u);
    } else {
      // beyond the path: straight on along the floor
      const last = path[path.length - 1], dir = norm(sub(last, path[path.length - 2]));
      p = add(last, mul(norm([dir[0], 0, dir[2]]), want - arc[path.length - 1]));
    }
    p[1] = Math.max(p[1], floorY);
    pos.set(p, 3 * i);
    const prev: V3 = [pos[3 * i - 3], pos[3 * i - 2], pos[3 * i - 1]];
    const t = norm(sub(p, prev));
    const ax = cross(prevT, t), sn = len(ax), cs = dot(prevT, t);
    if (sn > 1e-7) {
      const a = mul(ax, 1 / sn), ang = Math.atan2(sn, cs);
      d = add(add(mul(d, Math.cos(ang)), mul(cross(a, d), Math.sin(ang))), mul(a, dot(a, d) * (1 - Math.cos(ang))));
    }
    d = norm(sub(d, mul(t, dot(d, t))));
    d1.set(d, 3 * i);
    prevT = t;
  }
}

/**
 * Squeezes the strands round a tie (exaggerated, for "zu fest" and the cable tie): nodes near the
 * tie's plane are pulled towards its axis, their jacket gets thinner (radius factors), within `reach`
 * of the plane along the axis.
 */
function squeeze(pos: Float32Array, rad: Float32Array, i0: number, i1: number, sec: Section, amount: number, reach = 0.012, within = 0.04) {
  for (let i = i0; i <= i1; i++) {
    const p: V3 = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    const d = sub(p, sec.c);
    const along = dot(d, sec.a);
    if (Math.abs(along) > 3 * reach) continue;
    const r = sub(d, mul(sec.a, along));
    const rl = len(r);
    if (rl > within) continue;
    const f = Math.exp(-((along / reach) ** 2)) * amount;
    const q = add(p, mul(r, -f * 0.45));
    pos.set(q, 3 * i);
    rad[i] = Math.min(rad[i], 1 - 0.55 * f);
  }
}

// ===================================================================================== 3D bits

/** a microphone: body and grille, its XLR socket at the tail (where the female plug sits) */
function micMesh(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(MIC.r * 0.85, MIC.r, MIC.len * 0.8, 24), new THREE.MeshStandardMaterial({ color: '#2b2c30', roughness: 0.35, metalness: 0.5 }));
  body.position.y = MIC.len * 0.4;
  const grille = new THREE.Mesh(new THREE.SphereGeometry(MIC.r * 1.35, 24, 16), new THREE.MeshStandardMaterial({ color: '#9fa3a9', roughness: 0.45, metalness: 0.7 }));
  grille.position.y = MIC.len * 0.8 + MIC.r * 0.9;
  for (const m of [body, grille]) m.castShadow = true;
  g.add(body, grille);
  // local +y is the mic's axis; its tail at the origin
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...PREP.micDir));
  g.position.set(...MIC.tail);
  return g;
}

/** a band (StrapMesh) drawn from a BandPath */
function drawBand(m: StrapMesh, b: BandPath) {
  m.update(b.pts, b.M, [0, 1, 0], b.sides);
  m.placeEyelet(b.eye.p, b.eye.x, b.eye.y, b.eye.z);
}

const TIE_COLOR = '#74777e', TIE_INNER = '#666a71';
const newStrap = () => new StrapMesh({ color: TIE_COLOR, inner: TIE_INNER, length: STRAP.length, width: STRAP.width, thickness: STRAP.thickness, maxPoints: 200 });

// ===================================================================================== people (scene-only rigs)

const SEC = strapSection('p4');
const LEFT_COIL = (): HandRig => ({ grip: ringGrip('p4'), hold: 'coil', radius: RING_GEOM.p4.coilR, thumbAlong: 1, free: 0.3 });
const g3 = (q: V3, along: V3, toPalm: V3): Grip => gripFrame(q, along, perp(toPalm, along));

/** the drop beat: the right hand takes the band's end on the ring, peels it back, lets go */
function dropRig(end: V3) {
  const D = DROP_T;
  const out = norm(add(N, [0, 0.5, 0]));
  const atEnd = g3(end, norm(cross(A, SEC.u)), SEC.u);
  const peeled = g3(add(end, add(mul(out, 0.07), mul(UP, 0.03))), out, SEC.u);
  const grip = gripPath([[0, REST_R], [D.reach, REST_R], [D.pinch, atEnd], [D.pinch + 0.12, atEnd], [D.peel1, peeled], [D.let + 0.15, peeled], [D.away, REST_R]]);
  const open = valPath([[0, 1], [D.pinch - 0.1, 1], [D.pinch, 0], [D.let, 0], [D.let + 0.15, 1]]);
  return (t: number): Rig => ({ ...rigBase(t), look: add(SEC.c, [0, -0.1 - 0.4 * ramp(t, D.let, D.let + 0.8), 0]), hands: [LEFT_COIL(), pinchR(grip(t), open(t), RC + 2 * BAND.thickness, 0.6)] });
}

/** the wrong ties: the right hand pulls the cable tie's tail / the knot's end tight, lets go */
function tiesRig(which: 'zip' | 'knot' | 'ok', pull: V3, dir: V3) {
  const T = TIES_T;
  const a = g3(pull, dir, norm(add(N, UP)));
  const b = g3(add(pull, mul(dir, 0.04)), dir, norm(add(N, UP)));
  const grip = which === 'ok' ? () => REST_R : gripPath([[0, REST_R], [T.reach, REST_R], [T.pull0 - 0.05, a], [T.pull1, b], [T.let, b], [T.let + 0.9, REST_R]]);
  const open = which === 'ok' ? () => 1 : valPath([[0, 1], [T.pull0 - 0.15, 1], [T.pull0, 0], [T.let - 0.05, 0], [T.let + 0.1, 1]]);
  return (t: number): Rig => ({ ...rigBase(t + (which === 'knot' ? 1.3 : which === 'zip' ? 0 : 2.6)), look: add(SEC.c, [0, -0.05, 0]), hands: [LEFT_COIL(), pinchR(grip(t), open(t), RC, 0.6)] });
}

// ===================================================================================== the part

export function* part(layer: Node) {
  const bPrep = new Baked((yield loadBake('p4-prep')) as BakedRod);
  const bOk = new Baked((yield loadBake('p4-ring-ok')) as BakedRod);
  const bLoose = new Baked((yield loadBake('p4-ring-loose')) as BakedRod);
  const bTwo = new Baked((yield loadBake('p4-two')) as BakedRod);
  if (captionProblems.length) console.warn('p4-strap captions:', captionProblems);

  const { tau, run } = clock(LENGTH);
  const on = (set: SetId) => {
    const s = tau(), sp = span(set);
    return ease((s - sp.a) / FADE) * (1 - ease((s - sp.b + FADE) / FADE));
  };
  const active = (set: SetId) => {
    const s = tau(), sp = span(set);
    return s >= sp.a - 1e-6 && s < sp.b + 1e-6;
  };
  /** 0 → 1 → 0 between part times a and b */
  const win = (a: number, b: number, fi = 0.35, fo = 0.35) => {
    const s = tau();
    return ease((s - a) / Math.max(1e-6, fi)) * (1 - ease((s - (b - fo)) / Math.max(1e-6, fo)));
  };
  const tPrep = () => clockOf('prep', tau());
  const tDrop = () => clockOf('drop', tau());
  const tFlash = () => clockOf('start', tau());
  const tClose = () => clockOf('close', tau());
  const tFit = () => clockOf('fit', tau());
  const tTwo = () => clockOf('two', tau());
  const tTies = () => clockOf('ties', tau());

  // ------------------------------------------------------------------------- 1 · prepare (world W1)
  const prepPlan = prepPlanFrom(bPrep.b.vector('plan', 0));
  const prepRigAt = prepRig(prepPlan);
  const prepTr = prepTrack(prepPlan);
  const w1 = (() => {
    const person = new Person3D(SPEC, prepTr.pose(0));
    const cable = new CableMesh({ maxNodes: bPrep.n, radius: RC, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.045 });
    const strap = newStrap();
    const band = new BandPath(), band2 = new BandPath();
    const arrowRound = new ArcArrow({ color: C.text, thickness: 0.0016 });
    const arrowPull = new ArcArrow({ color: C.text, thickness: 0.0018 });
    const stand = micStand({ height: PREP.standH, boom: null });
    stand.position.set(PREP.stand[0], 0, PREP.stand[1]);
    const mic = micMesh();
    const pov = makeCamera(50), ext = makeCamera(34);
    viewLayers(pov, 'pov');
    viewLayers(ext, 'ext');
    const sec = (): Section => {
      const c = bPrep.point(S_STRAP), a = bPrep.tangent(S_STRAP);
      return { c, a, u: perp(prepPlan.u, a), r: RC };
    };
    let letGo: Float32Array | null = null;
    const pose = { v: prepTr.pose(0) as Pose };
    const NAH: Orbit = { target: mix(PREP.fist, prepPlan.p, 0.55), yaw: Math.PI - 0.55, pitch: 0.14, dist: 0.48, fov: 34 };
    const WIDE: Orbit = { target: [0.42, 0.78, -0.95], yaw: -2.2, pitch: 0.17, dist: 3.5, fov: 34 };
    const o1: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
    const world = new World3D('p4-strap-prep', () => {
      if (!active('prep')) return;
      const t = tPrep();
      pose.v = prepTr.pose(t);
      person.update(pose.v);
      bPrep.at(t);
      cable.update(bPrep.pos.subarray(3 * bPrep.i0), bPrep.d1.subarray(3 * bPrep.i0), bPrep.i1 - bPrep.i0 + 1);
      // the band
      const ps = prepStrap(t);
      const s = sec();
      const pads = pose.v.body.arms?.[1].grip?.p ?? s.c;
      if (t < PREP_T.wrap0 + 0.05) held(band, s, pads, ps.place);
      else if (t < PREP_T.wrap1) choke(band, s, Math.max(0, ps.wrap - 0.07), 0, 0, pads);
      else if (t < PREP_T.thread1) choke(band, s, 1, ps.thread, 0, pads);
      else if (t < PREP_T.let) choke(band, s, 1, 1, ps.cinch, pads);
      else {
        choke(band, s, 1, 1, 1, null);
        // (the end swings down from where the hand let it go)
        if (!letGo) {
          choke(band2, s, 1, 1, 1, pads);
          letGo = Float32Array.from(band2.pts);
        }
        const u = ease((t - PREP_T.let) / 0.35);
        if (u < 1) for (let k = 0; k < band.pts.length; k++) band.pts[k] = letGo[k] + (band.pts[k] - letGo[k]) * u;
      }
      if (t < PREP_T.let) letGo = null;
      drawBand(strap, band);
      // the arrow round the cable (the way the long end goes) and the pull out of the slot
      const r = s.c;
      const ar = ramp(tau(), S('c2') + 0.1, S('c2') + 0.9) * (1 - ramp(t, PREP_T.thread1 - 0.2, PREP_T.thread1 + 0.2));
      arrowRound.group.visible = ar > 0.01 && t < PREP_T.thread1 + 0.2;
      if (arrowRound.group.visible) arrowRound.update({ center: add(r, mul(s.a, -0.006)), axis: s.a, from: s.u, radius: 0.022, angle: 2 * Math.PI * 0.9, progress: ar });
      const ap = ramp(t, PREP_T.thread1 - 0.05, PREP_T.thread1 + 0.15) * (1 - ramp(t, PREP_T.let + 0.1, PREP_T.let + 0.4));
      arrowPull.group.visible = ap > 0.01;
      if (arrowPull.group.visible) {
        const p0 = add(r, mul(s.u, 0.03));
        const R = 0.4;
        arrowPull.update({ center: sub(p0, mul(s.a, R)), axis: cross(s.a, s.u), from: s.a, radius: R, angle: 0.11, progress: ap });
      }
      // cameras
      const eyes = (x: number) => eyesOfRig(SPEC, prepRigAt(x));
      const look = (x: number): V3 => {
        const base = add(mix(PREP.fist, prepPlan.p, 0.5), [0, -0.02, 0]);
        return mix(base, add(MIC.c, [0, -0.2, 0]), ramp(x, PREP_T.rest + 4.0, PREP_T.end - 0.5) * 0.0);
      };
      povFollow(pov, eyes, look, t, { back: 0.03, up: 0.03, fov: 46, smooth: 0.25 });
      const wide = ease((tau() - S('mic') + 0.2) / 2.0);
      orbit(ext, mixOrbit(NAH, WIDE, wide, o1));
    });
    new Studio(world.scene, { focus: [0.35, 0.6, -0.8], focusRadius: 1.9 });
    world.scene.add(person.group, cable.group, strap.group, arrowRound.group, arrowPull.group, stand, mic);
    return { world, pov, ext, sec, pose, band };
  })();

  // ------------------------------------------------------------------------- the ring world (W2): stations
  const ringPlan = ringPlanFrom(bOk.b.vector('plan', 0));
  const ringTr = ringTrack('p4', ringPlan);
  const ringRigAt = ringRig('p4', ringPlan);
  const tf = tieFrame('p4');
  const LOOSE_EXTRA = 0.014;
  // where the knot comes from: the last loop and the end (kinematic)
  const knotFrom = bOk.node(3.784);
  // the band's end on a closed ring (the drop rig goes there)
  const closedEnd = (() => {
    const b = new BandPath();
    bOk.at(0.5);
    const strand: Section = { c: bOk.point(S_STRAP), a: bOk.tangent(S_STRAP), u: SEC.u, r: RC };
    round(b, strand, { ...SEC, c: tf(0.5).p }, 1, null);
    return b.at(BAND.length - 0.006);
  })();
  const dropTr = new RigTrack(SPEC, dropRig(closedEnd), 0, 60);
  const knotPull: V3 = add(SEC.c, [0.02, -0.16, 0.02]);
  const tiesTr = {
    zip: new RigTrack(SPEC, tiesRig('zip', add(SEC.c, add(mul(SEC.u, 0.035), mul(cross(A, SEC.u), 0.015))), norm(add(SEC.u, mul(cross(A, SEC.u), 0.4)))), 0, 60),
    knot: new RigTrack(SPEC, tiesRig('knot', knotPull, [0, -1, 0]), 0, 60),
    ok: new RigTrack(SPEC, tiesRig('ok', SEC.c, [0, -1, 0]), 0, 60),
  };
  /** the coiling (kinematic): where along the ring the cable is laid to (loop units 0..6) at flash time f */
  const flashU = (f: number) => {
    if (f < FLASH.lead) return 0;
    if (f < FLASH.lead + 2 * FLASH.slow) return (f - FLASH.lead) / FLASH.slow;
    if (f < FLASH.fast0) return 2;
    return Math.min(6, 2 + (f - FLASH.fast0) / FLASH.fast);
  };
  const ringLoops: [number, number][] = [[0.25, 0.935], [0.935, 1.628], [1.628, 2.366], [2.366, 3.058], [3.058, 3.784], [3.784, 4.504]];
  bOk.at(0);
  const ring0 = { pos: Float32Array.from(bOk.pos), d1: Float32Array.from(bOk.d1) };
  const ringMid = (() => {
    let c: V3 = [0, 0, 0];
    const a = bOk.node(0.25), e = bOk.node(4.504);
    for (let i = a; i < e; i++) c = add(c, [ring0.pos[3 * i], ring0.pos[3 * i + 1], ring0.pos[3 * i + 2]]);
    return mul(c, 1 / (e - a));
  })();
  /** the winding point (material s) and the right hand at flash time f */
  const flashHand = (f: number) => {
    const u = flashU(f);
    const k = Math.min(5, Math.floor(u)), v = u - k;
    const [a, b] = ringLoops[k];
    const sw = u >= 6 ? 4.504 : a + (b - a) * ease(v);
    const i = bOk.node(sw);
    const at: V3 = [ring0.pos[3 * i], ring0.pos[3 * i + 1], ring0.pos[3 * i + 2]];
    const radial = norm(sub(at, ringMid));
    const hand = add(add(at, mul(radial, 0.07)), mul(N, 0.05));
    const turn = k % 2 === 1 && u < 6 ? Math.sin(Math.PI * v) : 0;
    return { sw, hand, turn };
  };
  const flashRigAt = (f: number): Rig => {
    const { hand, turn } = flashHand(f);
    const toRing = norm(sub(ringMid, hand));
    const palm: V3 = norm([0.2, -Math.cos(Math.PI * turn), 0.3 + 0.3 * Math.sin(Math.PI * turn)]);
    return { ...rigBase(f + 5), look: add(ringMid, [0, 0.05, 0]), hands: [LEFT_COIL(), { grip: gripFrame(hand, toRing, palm), hold: 'pinch', radius: RC, free: 0.5 }] };
  };
  const flashTr = new RigTrack(SPEC, flashRigAt, 0, 60);
  const FLOOR_DIR: V3 = norm([0.6, 0, -0.5]);

  /** a station: one Jonas with a ring at x offset `off` */
  class Station {
    readonly group = new THREE.Group();
    readonly person: Person3D;
    readonly cable: CableMesh;
    readonly strap = newStrap();
    readonly zip = new StrapMesh({ color: '#e7e3d6', inner: '#d6d1c2', eyelet: '#e7e3d6', length: 0.2, width: 0.0045, thickness: 0.0013, maxPoints: 200 });
    readonly band = new BandPath();
    readonly band2 = new BandPath();
    readonly zipBand = new BandPath(200, 0.2, 0.0013);
    readonly pos = new Float32Array(3 * bOk.n);
    readonly d1 = new Float32Array(3 * bOk.n);
    readonly rad = new Float32Array(bOk.n);
    letGo: Float32Array | null = null;
    pose: Pose;
    constructor(readonly off: number) {
      this.pose = ringTr.pose(0);
      this.person = new Person3D(SPEC, this.pose);
      this.cable = new CableMesh({ maxNodes: bOk.n, radius: RC, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.045 });
      this.group.position.x = off;
      this.group.add(this.person.group, this.cable.group, this.strap.group, this.zip.group);
    }
    /** the cable from a bake at t into the station's buffers */
    fromBake(b: Baked, t: number) {
      b.at(t);
      this.pos.set(b.pos);
      this.d1.set(b.d1);
      this.rad.fill(1);
    }
    draw() {
      const b = bOk;
      this.cable.update(this.pos.subarray(3 * b.i0), this.d1.subarray(3 * b.i0), b.i1 - b.i0 + 1, undefined, undefined, this.rad.subarray(b.i0));
    }
    point(s: number): V3 {
      // (bOk's material coordinates; the station's own positions)
      const b = bOk;
      const i = b.node(s);
      return [this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]];
    }
    strand(s: number, u: V3): Section {
      const a = norm(sub(this.point(s + 0.008), this.point(s - 0.008)));
      return { c: this.point(s), a, u: perp(u, a), r: RC };
    }
    /** world point (station offset added) */
    W(p: V3): V3 {
      return [p[0] + this.off, p[1], p[2]];
    }
  }
  const OFF = [-1.6, 0, 1.6];
  const st = OFF.map((o) => new Station(o));

  /** the band on a ring at bake time t (close and fit): hanging, taken, wrapped, closed; squeeze < 0 loosens */
  const ringBand = (S0: Station, t: number, pose: Pose, o: { squeeze?: number } = {}) => {
    const strand = S0.strand(S_STRAP, SEC.u);
    const bundle: Section = { ...SEC, c: tf(t).p };
    const pads = pose.body.arms?.[1].grip?.p ?? bundle.c;
    const T = RING_T;
    const full = (BAND.length - 0.03) / (SEC.r + 3 * BAND.thickness);
    if (t < T.tail1 - 0.4) choke(S0.band, strand, 1, 1, 1, null);
    else if (t < T.tail1) choke(S0.band, strand, 1, 1, 1, pads);
    else if (t < T.press1) {
      const handAng = WRAP_PHI0 + WRAP_TURNS * ease((t - T.tail1) / (T.wrap1 - T.tail1));
      const k = Math.min(1, Math.max(0, (handAng - WRAP_LAG) / full));
      const squeezeNow = (o.squeeze ?? 0) * ramp(t, T.wrap1, T.press1);
      round(S0.band, strand, bundle, t < T.wrap1 ? k : 1, t < T.wrap1 + 0.25 ? pads : null, { squeeze: squeezeNow });
    } else round(S0.band, strand, bundle, 1, null, { squeeze: o.squeeze ?? 0 });
    drawBand(S0.strap, S0.band);
  };

  /** the kinematic knot (✗): the last loop and the end wound once and a half round the ring's top beside the fist and tucked under itself; the rest hangs */
  const knotPath = (S0: Station, pull: number): { path: V3[]; bend: V3 } => {
    const c = add(SEC.c, mul(A, 0.012)), a = A;
    const P0 = S0.point(3.784);
    const u0 = perp(sub(P0, c), a), v0 = cross(a, u0);
    const Rk = SEC.r + 2.2 * RC - 0.004 * pull;
    const path: V3[] = [P0];
    const at = (th: number, r: number, along: number): V3 => add(add(c, mul(a, along)), add(mul(u0, r * Math.cos(th)), mul(v0, r * Math.sin(th))));
    const turns = 1.4 * 2 * Math.PI;
    for (let k = 1; k <= 160; k++) {
      const th = (turns * k) / 160;
      path.push(at(th, Rk + 2 * RC * (th / (2 * Math.PI)), -0.012 + 0.024 * (k / 160)));
    }
    // the tuck: under the first turn, then out
    const th1 = turns;
    let bend: V3 = at(th1 + 0.5, SEC.r + 0.6 * RC, 0.0);
    for (let k = 1; k <= 30; k++) {
      const u = k / 30;
      const p = at(th1 + 0.9 * u, Rk + 2.8 * RC - (2.8 * RC + 2.2 * RC - 0.6 * RC) * Math.sin(Math.PI * Math.min(1, u * 1.3)) * 0.9, 0.012 - 0.02 * u);
      path.push(p);
      if (k === 12) bend = p;
    }
    // out and down: the rest of the cable hangs from the knot
    const last = path[path.length - 1];
    const out = norm(sub(last, c));
    path.push(add(last, mul(out, 0.02)));
    const hangTop = add(last, add(mul(out, 0.03), [0, -0.03, 0]));
    path.push(hangTop);
    for (let k = 1; k <= 60; k++) path.push(add(hangTop, [0.002 * k * pull, -0.012 * k, 0]));
    return { path, bend };
  };

  const povR = makeCamera(55), extR = makeCamera(36);
  viewLayers(povR, 'pov');
  viewLayers(extR, 'ext');
  const colCam = [makeCamera(34), makeCamera(34), makeCamera(34)];
  for (const c of colCam) viewLayers(c, 'ext');
  const ringC = add(RING_AT_P4(), [0, -0.12, 0]);
  function RING_AT_P4(): V3 {
    return ringPoint('p4', [0, 1.598, RING_GEOM.p4.zMid]);
  }
  const YAW = 2.42;
  const knotBend: V3[] = [[0, 0, 0]];
  let dropFall: [Float32Array | null, Float32Array | null] = [null, null];
  const o2: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const o3: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const wRing = new World3D('p4-strap-ring', () => {
    const s = tau();
    for (const x of st) x.group.visible = false;
    if (active('drop')) {
      // ✗ only wrapped (station 0) | ✓ on the cable (station 2): the same opening
      const d = tDrop();
      const pose = dropTr.pose(d);
      const bt = Math.min(2.2, 0.3 * d);
      for (const k of [0, 2] as const) {
        const S0 = st[k];
        S0.group.visible = true;
        S0.person.update(pose);
        S0.fromBake(bOk, bt);
        S0.draw();
        const strand = S0.strand(S_STRAP, SEC.u);
        const bundle: Section = { ...SEC, c: tf(bt).p };
        const choked = k === 2;
        const pads = pose.body.arms?.[1].grip?.p ?? bundle.c;
        const o = ramp(d, DROP_T.pinch + 0.1, DROP_T.peel1);
        if (d < DROP_T.let) {
          round(S0.band, strand, bundle, 1, d > DROP_T.pinch ? pads : null, { open: o, choked });
          dropFall[k === 0 ? 0 : 1] = null;
          S0.letGo = Float32Array.from(S0.band.pts);
        } else if (!choked) {
          const p0 = S0.letGo ?? S0.band.pts;
          falling(S0.band, p0, A, d - DROP_T.let, 0);
        } else {
          choke(S0.band, strand, 1, 1, 1, null);
          const lg = S0.letGo;
          const u = ease((d - DROP_T.let) / 0.45);
          if (lg && u < 1) for (let q = 0; q < S0.band.pts.length; q++) S0.band.pts[q] = lg[q] + (S0.band.pts[q] - lg[q]) * u;
        }
        drawBand(S0.strap, S0.band);
        S0.zip.group.visible = false;
        const fall = ease((d - DROP_T.let - 0.1) / 1.0);
        const near: Orbit = { target: S0.W(add(SEC.c, [0, -0.05, 0])), yaw: YAW, pitch: 0.28, dist: 0.8, fov: 34 };
        const far: Orbit = { target: S0.W([SEC.c[0] + 0.1, 0.55, SEC.c[2]]), yaw: YAW, pitch: 0.12, dist: 1.95, fov: 34 };
        orbit(colCam[k], mixOrbit(near, far, fall, k === 0 ? o2 : o3));
      }
      void dropFall;
    } else if (active('start')) {
      const f = tFlash();
      const S0 = st[1];
      S0.group.visible = true;
      const pose = flashTr.pose(f);
      S0.person.update(pose);
      S0.pos.set(ring0.pos);
      S0.d1.set(ring0.d1);
      S0.rad.fill(1);
      const fh = flashHand(f);
      const iw = bOk.node(fh.sw);
      const hand = pose.body.arms?.[1].grip?.p ?? fh.hand;
      const P = (i: number): V3 => [ring0.pos[3 * i], ring0.pos[3 * i + 1], ring0.pos[3 * i + 2]];
      const pw = P(iw);
      const below: V3 = [hand[0], RC, hand[2]];
      layPath(S0.pos, S0.d1, bOk.s, iw, [pw, hand, add(hand, [0, -0.05, 0]), add(below, [0, 0.06, 0]), below, add(below, mul(FLOOR_DIR, 0.06))]);
      S0.draw();
      choke(S0.band, S0.strand(S_STRAP, SEC.u), 1, 1, 1, null);
      drawBand(S0.strap, S0.band);
      S0.zip.group.visible = false;
      povFollow(povR, (x) => eyesOfRig(SPEC, flashRigAt(x)), () => add(ringMid, [0.03, 0.04, 0]), f, { back: 0.04, up: 0.03, fov: 55, smooth: 0.3 });
      orbit(extR, { target: add(ringC, [0.0, -0.04, 0]), yaw: YAW + 0.08, pitch: 0.2, dist: 1.25, fov: 38 });
    } else if (active('close')) {
      const t = tClose();
      const S0 = st[1];
      S0.group.visible = true;
      S0.pose = ringTr.pose(t);
      S0.person.update(S0.pose);
      S0.fromBake(bOk, t);
      S0.draw();
      ringBand(S0, t, S0.pose);
      S0.zip.group.visible = false;
      povFollow(povR, (x) => eyesOfRig(SPEC, ringRigAt(x)), (x) => mix(add(SEC.c, [0.01, -0.04, 0]), add(ringPlan.plugC, [0, 0.06, 0]), 0.6 * ramp(x, RING_T.reach0 - 0.3, RING_T.grab) * (1 - ramp(x, RING_T.grab + 0.3, RING_T.lift1))), t, { back: 0.04, up: 0.03, fov: 52, smooth: 0.3 });
      const nah: Orbit = { target: add(SEC.c, [0, -0.03, 0]), yaw: YAW, pitch: 0.3, dist: 0.62, fov: 34 };
      const fetch: Orbit = { target: add(ringC, [0, -0.06, 0]), yaw: YAW, pitch: 0.2, dist: 1.0, fov: 34 };
      const u = ramp(t, RING_T.reach0 - 0.2, RING_T.reach0 + 0.5) * (1 - ramp(t, RING_T.lift1 - 0.2, RING_T.let + 0.6));
      const show = ease((s - S('closed') - 0.2) / 1.2);
      const front: Orbit = { target: add(ringC, [0, 0.03, 0]), yaw: YAW + 0.2, pitch: 0.18, dist: 0.85, fov: 34 };
      orbit(extR, mixOrbit(mixOrbit(nah, fetch, u, o2), front, show, o3));
    } else if (active('fit')) {
      const t = tFit();
      const pose = ringTr.pose(t);
      for (const k of [0, 1, 2] as const) {
        const S0 = st[k];
        S0.group.visible = true;
        S0.person.update(pose);
        S0.fromBake(k === 2 ? bLoose : bOk, t);
        if (k === 0) {
          // too tight: the band pulled hard round the strands (exaggerated: a dent, the strands squeezed)
          const sq = ramp(t, RING_T.wrap1, RING_T.press1);
          squeeze(S0.pos, S0.rad, bOk.i0, bOk.i1, { ...SEC, c: tf(t).p }, 0.9 * sq);
        }
        S0.draw();
        ringBand(S0, t, pose, { squeeze: k === 0 ? 0.3 : k === 2 ? -LOOSE_EXTRA / SEC.r : 0 });
        S0.zip.group.visible = false;
        const whole: Orbit = { target: S0.W(add(ringC, [0, 0.04 * ramp(t, RING_T.release, RING_T.lifted) - 0.03, 0])), yaw: YAW, pitch: 0.16, dist: 1.05, fov: 34 };
        const tight: Orbit = { target: S0.W(add(tf(t).p, [0, -0.02, 0])), yaw: YAW, pitch: 0.3, dist: 0.42, fov: 34 };
        orbit(colCam[k], k === 0 ? tight : whole);
      }
    } else if (active('ties')) {
      const z = tTies();
      const bt = RING_T.press1 - 0.05;
      const pull = ramp(z, TIES_T.pull0, TIES_T.pull1);
      for (const k of [0, 1, 2] as const) {
        const S0 = st[k];
        S0.group.visible = true;
        const pose = (k === 0 ? tiesTr.zip : k === 1 ? tiesTr.knot : tiesTr.ok).pose(z);
        S0.person.update(pose);
        S0.fromBake(bOk, k === 1 ? 2.0 : bt);
        S0.zip.group.visible = k === 0;
        S0.strap.group.visible = k === 2;
        if (k === 0) {
          const sec0: Section = { ...SEC, c: tf(bt).p };
          squeeze(S0.pos, S0.rad, bOk.i0, bOk.i1, sec0, 0.25 + 0.75 * pull, 0.006);
          zipTie(S0.zipBand, sec0, 0.05 + 0.25 * pull);
          S0.zip.update(S0.zipBand.pts, S0.zipBand.M, [0, 1, 0], S0.zipBand.sides);
          S0.zip.placeEyelet(S0.zipBand.eye.p, S0.zipBand.eye.x, S0.zipBand.eye.y, S0.zipBand.eye.z);
        } else if (k === 1) {
          const kp = knotPath(S0, 0.4 + 0.6 * pull);
          knotBend[0] = S0.W(kp.bend);
          layPath(S0.pos, S0.d1, bOk.s, knotFrom, kp.path);
        } else {
          ringBand(S0, bt, pose);
        }
        S0.draw();
        orbit(colCam[k], { target: S0.W(add(SEC.c, [0.0, k === 1 ? -0.05 : -0.035, 0])), yaw: YAW, pitch: 0.3, dist: k === 1 ? 0.62 : 0.5, fov: 34 });
      }
    }
  });
  const studioR = new Studio(wRing.scene, { focus: [0, 0.9, -0.3], focusRadius: 2.6 });
  void studioR;
  for (const x of st) wRing.scene.add(x.group);

  // ------------------------------------------------------------------------- 5 · two ties (world W3)
  const twoTr = twoTrack();
  const twoRigAt = twoRig();
  const w3 = (() => {
    const person = new Person3D(SPEC, twoTr.pose(0));
    const cable = new CableMesh({ maxNodes: bTwo.n, radius: RC, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.045 });
    const s1 = newStrap(), s2 = newStrap();
    const b1 = new BandPath(), b2 = new BandPath();
    const cam = makeCamera(36);
    viewLayers(cam, 'ext');
    const top = strapSection('long'), bot = bottomSection();
    // the second tie lives on the lowest strand at the bottom
    bTwo.at(TWO_T.gather1 + 0.6);
    let low = 0, ly = Infinity;
    for (let i = 0; i < bTwo.n; i++) {
      const p = bTwo.nodeP(i), d = sub(p, bot.c);
      if (Math.abs(dot(d, bot.a)) < 0.01 && len(d) < 0.06 && p[1] < ly) {
        ly = p[1];
        low = i;
      }
    }
    const sLow = bTwo.s[low];
    const world = new World3D('p4-strap-two', () => {
      if (!active('two')) return;
      const t = tTwo();
      const pose = twoTr.pose(t);
      person.update(pose);
      bTwo.at(t);
      cable.update(bTwo.pos.subarray(3 * bTwo.i0), bTwo.d1.subarray(3 * bTwo.i0), bTwo.i1 - bTwo.i0 + 1);
      const strand1: Section = { c: bTwo.point(RING_GEOM.long.sStrap), a: bTwo.tangent(RING_GEOM.long.sStrap), u: top.u, r: RC };
      round(b1, strand1, top, 1, null);
      drawBand(s1, b1);
      const p2 = bTwo.point(sLow);
      const u2 = norm(sub(p2, bot.c));
      const strand2: Section = { c: p2, a: bTwo.tangent(sLow), u: u2, r: RC };
      const T = TWO_T;
      const pads = pose.body.arms?.[1].grip?.p ?? bot.c;
      const full = (BAND.length - 0.03) / (bot.r + 3 * BAND.thickness);
      const handAng = 2.3 * Math.PI * ease((t - T.gather1 - 0.3) / (T.wrap1 - T.gather1 - 0.3));
      if (t < T.gather1 + 0.3) choke(b2, strand2, 1, 1, 1, null);
      else if (t < T.press1) round(b2, strand2, { ...bot, u: u2 }, t < T.wrap1 ? Math.max(0.02, Math.min(1, (handAng - 0.5) / full)) : 1, t < T.wrap1 + 0.2 ? pads : null);
      else round(b2, strand2, { ...bot, u: u2 }, 1, null);
      drawBand(s2, b2);
      orbit(cam, { target: mix(top.c, bot.c, 0.55), yaw: YAW + 0.05, pitch: 0.16, dist: 1.25, fov: 36 });
    });
    new Studio(world.scene, { focus: [0, 0.9, -0.3], focusRadius: 1.3 });
    world.scene.add(person.group, cable.group, s1.group, s2.group);
    void twoRigAt;
    return { world, cam, top, bot, b1, b2, s1: () => b1.at(0.05), s2: () => b2.at(0.05) };
  })();

  // ------------------------------------------------------------------------- the picture
  // 1 · prepare: own view | close-up, then the close-up grows to the whole width (the mic)
  const wideU = () => ease((tau() - S('mic') + 0.2) / 1.6);
  const prepExt = (
    <ThreeView world={w1.world} camera={w1.ext} y={midY} height={PANEL_H} radius={28}
      x={() => xR + wR / 2 + (0 - (xR + wR / 2)) * wideU()} width={() => wR + (fullW - wR) * wideU()} opacity={() => on('prep')} />
  ) as ThreeView;
  const prepPov = (<ThreeView world={w1.world} camera={w1.pov} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={() => on('prep') * (1 - wideU())} />) as ThreeView;
  // (the dips of the real-time replay)
  const dip = () => win(S('dipOut'), E('dipIn'), 0.3, 0.3);
  layer.add([prepPov, prepExt]);
  layer.add(<Rect x={0} y={midY} width={fullW} height={PANEL_H} radius={28} fill={C.bg} opacity={dip} />);
  // 2 · ✗ | ✓
  const dropV = [0, 1].map((k) => (<ThreeView world={wRing} camera={colCam[k === 0 ? 0 : 2]} x={xHalf[k]} y={midY} width={wHalf} height={PANEL_H} radius={28} opacity={() => on('drop')} />) as ThreeView);
  // 3, 4 · own view | outside / close-up
  const ringPov = (<ThreeView world={wRing} camera={povR} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={() => Math.max(on('start'), on('close'))} />) as ThreeView;
  const ringExt = (<ThreeView world={wRing} camera={extR} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} opacity={() => Math.max(on('start'), on('close'))} />) as ThreeView;
  // 4, 6 · three columns
  const colV = [0, 1, 2].map((k) => (<ThreeView world={wRing} camera={colCam[k]} x={xCol[k]} y={midY} width={wCol} height={PANEL_H} radius={28} opacity={() => Math.max(on('fit'), on('ties'))} />) as ThreeView);
  // 5 · the long ring
  const twoV = (<ThreeView world={w3.world} camera={w3.cam} x={0} y={midY} width={fullW} height={PANEL_H} radius={28} opacity={() => on('two')} />) as ThreeView;
  layer.add([...dropV, ringPov, ringExt, ...colV, twoV]);

  // panel titles
  const title = (text: string, x: number, opacity: () => number) => {
    const n = (<PanelTitle text={text} x={x} />) as Node;
    n.opacity(opacity);
    layer.add(n);
  };
  title('So siehst du es', xL + 24, () => on('prep') * (1 - wideU()));
  title('Nah', xR + 24, () => on('prep') * (1 - wideU()));
  title('✗ nur drumgewickelt', -960 + GAP + 24, () => on('drop'));
  title('✓ am Kabel befestigt', 960 - GAP - wHalf + 24, () => on('drop'));
  title('So siehst du es', xL + 24, () => Math.max(on('start'), on('close')));
  title('Von außen', xR + 24, () => on('start'));
  title('Nah', xR + 24, () => on('close'));
  const colTitles = [['✗ zu fest', '✓ richtig', '✗ zu locker'], ['✗ Kabelbinder', '✗ Knoten', '✓ Klettband']];
  for (let k = 0; k < 3; k++) {
    title(colTitles[0][k], xCol[k] - wCol / 2 + 24, () => on('fit'));
    title(colTitles[1][k], xCol[k] - wCol / 2 + 24, () => on('ties'));
  }
  layer.add(<StageChip current={4} x={0} y={TOP + PANEL_H + 34} />);

  // badges
  const badge = (text: string, visible: () => number, x: number) =>
    layer.add(
      <Rect x={x} y={TOP + 24} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.text} opacity={visible} layout>
        <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={28} fill={'#fff'} />
      </Rect>,
    );
  badge('Zeitlupe', () => win(S('slow') - 0.1, E('slowEnd')), 0);
  badge('Echtzeit', () => win(S('rt'), E('rt') - 0.4, 0.2, 0.3), 0);
  badge('Zeitraffer', () => (active('start') ? win(S('flash') + FLASH.fast0 - 0.2, S('flash') + FLASH.fast0 + 4 * FLASH.fast + 0.3, 0.2, 0.3) : 0), xL + wL / 2);

  // ------------------------------------------------------------------------- labels
  const W1 = (p: () => V3) => p;
  // 1 · the plug with the pins (own view), the 10–30 cm (close-up), "Rutscht nicht" (close-up), the pins, the mic
  layer.add(callout({ view: prepPov, target: W1(() => { bPrep.at(tPrep()); return bPrep.point(0.004); }), at: () => { const p = project(prepPov, (bPrep.at(tPrep()), bPrep.point(0.004))); return [p.x - 170, p.y - 120] as [number, number]; }, text: 'Stecker mit Stiften', size: 34, opacity: () => win(0.6, S('dim') + 0.6) }));
  // the dimension: from the plug's boot to the band, in the close-up, as a bracket beside the cable
  {
    const pA = () => project(prepExt, (bPrep.at(tPrep()), bPrep.point(0.062)));
    const pB = () => project(prepExt, (bPrep.at(tPrep()), bPrep.point(S_STRAP)));
    const off = () => {
      const a = pA(), b = pB();
      const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
      return { nx: (-dy / l) * 70, ny: (dx / l) * 70 };
    };
    const vis = () => (active('prep') ? win(S('place') + PREP_T.place1 - 0.1, E('c2') + 0.6) : 0);
    const bracket = new Node({ opacity: vis });
    bracket.add(new Line({ points: () => { const a = pA(), b = pB(), o = off(); return [[a.x + o.nx, a.y + o.ny], [b.x + o.nx, b.y + o.ny]]; }, stroke: C.text, lineWidth: 4, startArrow: true, endArrow: true, arrowSize: 12 }));
    for (const which of [pA, pB]) bracket.add(new Line({ points: () => { const a = which(), o = off(); return [[a.x + o.nx * 0.55, a.y + o.ny * 0.55], [a.x + o.nx * 1.25, a.y + o.ny * 1.25]]; }, stroke: C.text, lineWidth: 3 }));
    const plate = (
      <Rect layout padding={[8, 18]} radius={14} fill={'#ffffff'} x={() => { const a = pA(), b = pB(), o = off(); return (a.x + b.x) / 2 + o.nx * 2.4; }} y={() => { const a = pA(), b = pB(), o = off(); return (a.y + b.y) / 2 + o.ny * 2.4; }}>
        <Txt text={'10–30 cm'} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
      </Rect>
    );
    bracket.add(plate);
    layer.add(bracket);
  }
  layer.add(callout({ view: prepExt, target: () => (bPrep.at(tPrep()), bPrep.point(S_STRAP)), at: () => { const p = project(prepExt, (bPrep.at(tPrep()), bPrep.point(S_STRAP))); return [p.x + 150, p.y + 170] as [number, number]; }, text: '✓ Rutscht nicht.', color: C.good, size: 36, opacity: () => (active('prep') ? win(S('tug') + (PREP_T.back1 - (PREP_T.let + 0.4)), E('tug') + 0.2) : 0) }));
  layer.add(callout({ view: prepPov, target: () => (bPrep.at(tPrep()), bPrep.point(0.0)), at: () => { const p = project(prepPov, (bPrep.at(tPrep()), bPrep.point(0.0))); return [p.x - 160, p.y - 110] as [number, number]; }, text: 'Stifte', size: 34, opacity: () => (active('prep') ? win(S('pins') + 1.0, E('pins') - 0.2) : 0) }));
  layer.add(callout({ view: prepExt, target: () => (bPrep.at(tPrep()), bPrep.point(S_STRAP)), at: () => { const p = project(prepExt, (bPrep.at(tPrep()), bPrep.point(S_STRAP))); return [p.x - 60, p.y - 200] as [number, number]; }, text: 'Band', size: 34, opacity: () => (active('prep') ? win(S('mic') + 1.4, E('micHold')) : 0) }));
  layer.add(callout({ view: prepExt, target: () => MIC.tail, at: () => { const p = project(prepExt, MIC.tail); return [p.x + 40, p.y - 170] as [number, number]; }, text: '✓ Mikro: kein Band', color: C.good, size: 34, opacity: () => (active('prep') ? win(S('mic') + 1.4, E('micHold')) : 0) }));

  // 2 · ✗ falls off | ✓ stays on the cable
  layer.add(callout({ view: dropV[0], target: () => st[0].W(st[0].band.at(0.12)), at: () => { const p = project(dropV[0], st[0].W(st[0].band.at(0.12))); return [p.x + 40, p.y - 190] as [number, number]; }, text: '✗ fällt ab', color: C.bad, size: 36, opacity: () => (active('drop') ? win(S('drop') + DROP_T.let + 1.0, E('dropHold')) : 0) }));
  layer.add(callout({ view: dropV[1], target: () => st[2].W(st[2].band.at(0.06)), at: () => { const p = project(dropV[1], st[2].W(st[2].band.at(0.06))); return [p.x + 60, p.y + 200] as [number, number]; }, text: '✓ bleibt am Kabel', color: C.good, size: 36, opacity: () => (active('drop') ? win(S('drop') + DROP_T.let + 1.0, E('dropHold')) : 0) }));

  // 3 · the band at the top in the hand
  layer.add(callout({ view: ringPov, target: () => st[1].W(st[1].band.at(0.05)), at: () => { const p = project(ringPov, st[1].W(st[1].band.at(0.05))); return [p.x - 200, p.y - 150] as [number, number]; }, text: 'Band', size: 36, opacity: () => (active('start') ? win(S('flash') + FLASH.lead + 2 * FLASH.slow + 0.2, E('flash') - 0.1) : 0) }));

  // 4 · both plugs outside (one plate, two leader lines), in the close-up
  {
    const plugA = () => st[1].W(st[1].point(0.02));
    const plugB = () => st[1].W(st[1].point(bOk.total - 0.02));
    const vis = () => (active('close') ? win(S('closed') + 1.0, E('closed')) : 0);
    const at = () => {
      const a = project(ringExt, plugA()), b = project(ringExt, plugB());
      return { x: Math.max(xR + 200, Math.min(960 - GAP - 200, (a.x + b.x) / 2 + 20)), y: Math.max(TOP + 110, Math.min(a.y, b.y) - 150) };
    };
    const grp = new Node({ opacity: vis });
    for (const pl of [plugA, plugB]) grp.add(new Line({ points: () => { const q = project(ringExt, pl()), c = at(); return [[c.x, c.y], [q.x, q.y]]; }, stroke: C.text, lineWidth: 4, endArrow: true, arrowSize: 14 }));
    grp.add(
      <Rect layout padding={[9, 20]} radius={14} fill={C.good} x={() => at().x} y={() => at().y}>
        <Txt text={'✓ Beide Stecker außen'} fontFamily={FONT} fontWeight={700} fontSize={34} fill={'#fff'} />
      </Rect>,
    );
    layer.add(grp);
  }
  // 4 · the columns: too tight (dent), right (holds), too loose (what slipped: measured)
  const loopsBelow = (b: BakedRod, t: number) => [0, 1, 2, 3, 4, 5].map((k) => b.track(`loop${k}`, t));
  const slipped = (() => {
    // a loop that hangs more than 6 cm lower than in the closed ring (before the lift), or the end that dropped out
    const t0 = RING_T.press1 + 0.5, t1 = RING_T.end - 0.05;
    const a = loopsBelow(bLoose.b, t0), b = loopsBelow(bLoose.b, t1);
    const drops = b.map((x, k) => x - a[k] - 0.08 * 0);
    const okA = loopsBelow(bOk.b, t0), okB = loopsBelow(bOk.b, t1);
    const endDrop = bLoose.b.track('endBelow', t1) - bLoose.b.track('endBelow', t0);
    console.log('p4-strap fit check: loose loop drops (m)', JSON.stringify(drops.map((x) => +x.toFixed(3))), 'end drop', endDrop.toFixed(3), '| ok', JSON.stringify(okB.map((x, k) => +(x - okA[k]).toFixed(3))), 'ok end', (bOk.b.track('endBelow', t1) - bOk.b.track('endBelow', t0)).toFixed(3));
    let worst = -1, w = 0.06;
    drops.forEach((x, k) => {
      if (x > w) {
        w = x;
        worst = k;
      }
    });
    return { worst, endOut: endDrop > 0.06, drops, endDrop };
  })();
  const fitLabelOn = () => (active('fit') ? win(S('fit') + (12.6 - (RING_T.press1 - 0.4)), E('fitHold')) : 0);
  layer.add(callout({ view: colV[0], target: () => st[0].W(add(tf(tFit()).p, mul(SEC.u, -0.01))), at: [xCol[0], TOP + PANEL_H - 90], text: '✗ Delle im Mantel', color: C.bad, size: 34, opacity: () => (active('fit') ? win(S('fit') + 1.4, E('fitHold')) : 0) }));
  layer.add(callout({ view: colV[1], target: () => st[1].W(tf(tFit()).p), at: [xCol[1], TOP + PANEL_H - 90], text: '✓ hält', color: C.good, size: 34, opacity: fitLabelOn }));
  if (slipped.worst >= 0 || slipped.endOut) {
    const target = (): V3 => {
      const S2 = st[2];
      if (slipped.worst >= 0) {
        const [a, b] = ringLoops[slipped.worst];
        let lo = S2.point(a), y = Infinity;
        for (let s = a; s < b; s += 0.02) {
          const p = S2.point(s);
          if (p[1] < y) {
            y = p[1];
            lo = p;
          }
        }
        return S2.W(lo);
      }
      return S2.W(S2.point(bOk.total - 0.03));
    };
    layer.add(callout({ view: colV[2], target, at: [xCol[2], TOP + PANEL_H - 90], text: slipped.worst >= 0 ? '✗ Schlaufe rutscht heraus' : '✗ Ende rutscht heraus', color: C.bad, size: 32, opacity: fitLabelOn }));
  }

  // 5 · the two ties: 1 and 2, opposite
  layer.add(callout({ view: twoV, target: () => w3.s1(), at: () => { const p = project(twoV, w3.s1()); return [p.x - 260, p.y - 40] as [number, number]; }, text: 'Band 1', size: 34, opacity: () => (active('two') ? win(S('two') + 0.6, E('two')) : 0) }));
  layer.add(callout({ view: twoV, target: () => w3.s2(), at: () => { const p = project(twoV, w3.s2()); return [p.x - 260, p.y + 40] as [number, number]; }, text: 'Band 2: gegenüber', size: 34, opacity: () => (active('two') ? win(S('two') + (TWO_T.press1 + 0.2), E('two')) : 0) }));

  // 6 · cable tie squeezes, the knot kinks
  layer.add(callout({ view: colV[0], target: () => st[0].W(tf(RING_T.press1).p), at: [xCol[0], TOP + PANEL_H - 90], text: '✗ quetscht', color: C.bad, size: 36, opacity: () => (active('ties') ? win(S('ties') + TIES_T.pull1 + 0.2, E('ties')) : 0) }));
  layer.add(callout({ view: colV[1], target: () => knotBend[0], at: [xCol[1], TOP + PANEL_H - 90], text: '✗ knickt', color: C.bad, size: 36, opacity: () => (active('ties') ? win(S('ties') + TIES_T.pull1 + 0.2, E('ties')) : 0) }));
  layer.add(callout({ view: colV[2], target: () => st[2].W(st[2].band.at(0.1)), at: [xCol[2], TOP + PANEL_H - 90], text: '✓ so', color: C.good, size: 36, opacity: () => (active('ties') ? win(S('ties') + TIES_T.pull1 + 0.2, E('ties')) : 0) }));

  // ------------------------------------------------------------------------- captions
  const cap = (<Txt y={CAPTION_Y} text={() => CAPS.find((c) => tau() >= c.a - 0.01 && tau() < c.b)?.text ?? ''} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />) as Txt;
  cap.opacity(() => {
    const c = CAPS.find((x) => tau() >= x.a - 0.01 && tau() < x.b);
    if (!c) return 0;
    return ease((tau() - c.a) / CAP_IN) * (1 - ease((tau() - (c.b - CAP_OUT)) / CAP_OUT));
  });
  layer.add(cap);

  yield* all(
    run(),
    (function* () {
      yield* waitFor(LENGTH - 0.45);
      yield* all(...layer.children().map((c) => c.opacity(0, 0.4)));
    })(),
  );

  layer.removeChildren();
  w1.world.dispose();
  wRing.dispose();
  w3.world.dispose();
}
