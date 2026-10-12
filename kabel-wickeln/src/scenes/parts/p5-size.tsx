// Stage 5.3 (KONZEPT "5 · Fehler", item 3): "Die richtige Größe". The rough animation (animatic):
// every beat, caption, label, camera and counter in place; Noor's hands from simple keyframes
// (shots/p5-size-rig.ts, shots/p5-eight-rig.ts) on exactly the frames the simulation used; the
// recorded movements (MOCAP_SLOTS) replace them later.
//
//   A  Noor lets her cable sink slowly through her right hand to the floor; it lies down in bows
//      by itself (simulated: the XLR preset with its coil memory). A dashed circle is fitted to a
//      bow (measured in the bake), laid onto it and lifted as a ghost loop into her left hand:
//      "So groß will das Kabel liegen."
//   B  three rings of the same cable side by side, the same camera: too small (tighter than the
//      ghost loop, amber note), too big (the loops lie on the floor, her foot steps on one), right
//      (round by itself); the ghost loop hangs over each one
//   C  her view: a loop is too short and bulges; she lets 5 cm more slide into it, it lies round:
//      "Will die Schlaufe größer werden? Lass sie." (kinematic cable: the bulge is played, see
//      the report)
//   D  her view: a loop tilts out of the ring as soon as it is let go (it wants the other way);
//      she gives in and lays it the other way (hand turned over, unter), it lies flat; the tally
//      shows how she evens it out soon after: "Will sie andersherum? Gib nach und gleich es bald
//      aus." (simulated: the bakes of stage 5.2, shots/eight.ts)
//
// Everything on screen is a function of one scene clock (tau): SEGS map it to a shot and its time.

import { Layout, Node, Rect, Txt } from '@motion-canvas/2d';
import { BakedRod, V3, loadBake, smooth } from '../../sim';
import { RING_N, RING_T, RingKind, SINK_T, ringFist, sinkLH, sinkRH } from '../../shots/p5-size';
import { MORE_L, MORE_T, moreRig, ringRig, sinkRig } from '../../shots/p5-size-rig';
import { EIGHT_GEOM, OK_T, SNAP_T, earlierLoops, layPads, roundLoop } from '../../shots/eight';
import { eightRig } from '../../shots/p5-eight-rig';
import { NOOR } from '../../people/cast';
import { Rig, RigTrack, eyesOfRig } from '../../people/rig';
import { CAPTION_Y, GAP, LAYER, PANEL_H, PanelTitle, TOP, clock, readTime, splitPerson, viewLayers } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { ArcArrow, GhostPath } from '../../three/arrows';
import { CableMesh } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit, povFollow } from '../../three/camera';
import { callout } from '../../three/overlay';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

// ===================================================================================== the plan

type Shot = 'sink' | 'rings' | 'more' | 'snap' | 'rev';

interface Seg {
  id: string;
  /** scene seconds */
  len: number;
  shot: Shot;
  /** shot time at its start and end (equal: time stands still) */
  from: number;
  to: number;
  /** scene time of its start */
  at: number;
  /** a continuous take (a cut starts a new one): Noor's arms are solved per take */
  take: number;
}

const SEGS: Seg[] = [];
let sceneAt = 0, take = 0;
const cut = () => take++;
const hold = (id: string, shot: Shot, at: number, len: number) => {
  SEGS.push({ id, len, shot, from: at, to: at, at: sceneAt, take });
  sceneAt += len;
};
const play = (id: string, shot: Shot, from: number, to: number, speed = 1) => {
  const len = (to - from) / speed;
  SEGS.push({ id, len, shot, from, to, at: sceneAt, take });
  sceneAt += len;
};

/** the sink: the bows are measured here (settled), the circle lifts with her left hand */
const FIT_T = SINK_T.lift0 - 0.1;
const GHOST_T = SINK_T.lift1 + 0.3;
/** the over loop of eight-snap tilts out of the ring once let go (bake: from SNAP_T.free to ~3.2 s) */
const TILT_END = 3.15;

// A · the sink
hold('in', 'sink', 0, 1.3);
play('feed', 'sink', 0, SINK_T.feed1 + 0.2);
play('settle', 'sink', SINK_T.feed1 + 0.2, FIT_T);
hold('circle', 'sink', FIT_T, 3.6);
play('lift', 'sink', FIT_T, GHOST_T);
hold('ghost', 'sink', GHOST_T, 2.4);
// B · three rings, the same camera
cut();
hold('ringsIn', 'rings', 0, 1.2);
play('rings', 'rings', 0, RING_T.end);
hold('ringsHold', 'rings', RING_T.end, 4.6);
// C · her view: the bulge, 5 cm more
cut();
hold('moreIn', 'more', 0, 1.0);
play('moreBack', 'more', 0, MORE_T.bulge1 + 0.05);
hold('bulge', 'more', MORE_T.bulge1 + 0.05, 3.4);
play('letOut', 'more', MORE_T.bulge1 + 0.05, MORE_T.letOut1);
play('give', 'more', MORE_T.letOut1, MORE_T.end);
hold('round', 'more', MORE_T.end, 1.8);
// D · it wants the other way: give in, even it out soon
cut();
hold('gwIn', 'snap', 0, 0.8);
play('gwLay', 'snap', 0, SNAP_T.free);
play('gwTilt', 'snap', SNAP_T.free, TILT_END);
hold('gwAsk', 'snap', TILT_END, 2.4);
cut();
play('gwRev', 'rev', 0, OK_T.end);
hold('gwOk', 'rev', OK_T.end, 1.4);
hold('gwEven', 'rev', OK_T.end, 4.4);
hold('out', 'rev', OK_T.end, 0.6);

/** the part's length [s] */
export const LENGTH = sceneAt;

function seg(id: string): Seg {
  const s = SEGS.find((x) => x.id === id);
  if (!s) throw new Error(`p5-size: no segment ${id}`);
  return s;
}
/** scene time where segment id starts / ends */
const S = (id: string) => seg(id).at;
const E = (id: string) => seg(id).at + seg(id).len;

function segAt(tau: number): Seg {
  let s = SEGS[0];
  for (const x of SEGS) {
    if (tau < x.at) break;
    s = x;
  }
  return s;
}
/** the shot time at scene time tau */
function shotAt(tau: number): number {
  const s = segAt(tau);
  const u = s.len > 0 ? Math.min(1, Math.max(0, (tau - s.at) / s.len)) : 1;
  return s.from + (s.to - s.from) * u;
}
/** the first segment of a take */
const takeStart = (k: number) => (SEGS.find((x) => x.take === k) ?? SEGS[0]).at;

// ------------------------------------------------------------------------------------ captions

const CAPS: { text: string; a: number; b: number }[] = [
  { text: 'Lass das Kabel langsam auf den Boden sinken.', a: S('in') + 0.2, b: S('feed') + 5.6 },
  { text: 'So groß will das Kabel liegen.', a: S('circle') + 0.9, b: E('ghost') },
  { text: 'Wickle in dieser Größe – nicht kleiner, nicht größer.', a: S('ringsIn') + 0.2, b: E('ringsHold') },
  { text: 'Will die Schlaufe größer werden? Lass sie.', a: S('bulge') + 0.2, b: E('give') },
  { text: 'Will sie andersherum? Gib nach und gleich es bald aus.', a: S('gwAsk') + 0.2, b: E('gwEven') },
];
const CAP_IN = 0.35, CAP_OUT = 0.3;

/** captions shorter than their reading time (characters / 12 + 1 s), overlapping or too long: printed when the part runs */
const captionProblems = (() => {
  const out: string[] = [];
  CAPS.forEach((c, i) => {
    const visible = c.b - c.a - CAP_IN;
    if (visible < readTime(c.text) - 0.01) out.push(`"${c.text}" visible ${visible.toFixed(2)} s < ${readTime(c.text).toFixed(2)} s`);
    if (i > 0 && c.a < CAPS[i - 1].b) out.push(`"${c.text}" overlaps the caption before`);
    if (c.text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length > 10) out.push(`"${c.text}" has more than 10 words`);
  });
  return out;
})();

// ------------------------------------------------------------------------------------ mocap

/**
 * Beats whose movement comes from a Kinect recording later (mocap/shots.json ids; times in part
 * seconds). Until then Noor moves by the keyframes of shots/p5-size-rig.ts and shots/p5-eight-rig.ts.
 */
export const MOCAP_SLOTS = [
  { shot: 'p5.size.sink', role: 'Noor', from: S('in'), to: E('ghost'), note: 'Kabel auf Brusthöhe durch die locker geschlossene rechte Hand sinken lassen, die linke führt nach, die rechte wandert langsam nach rechts; am Ende zeigt die linke Hand an der Hüfte die Größe (dort hängt die Geisterschlaufe). Das Kabel bleibt Simulation: die Hände treiben die Führung über der rechten Hand' },
  { shot: 'p5.size.small', role: 'Noor', from: S('ringsIn'), to: E('ringsHold'), note: 'Feld „zu klein“: das Ende des Takes (Ring vor dem Körper halten); der Take endet auf Brusthöhe, unser Feld senkt den Ring auf Hüfthöhe (in allen drei Feldern gleich)' },
  { shot: 'p5.size.big', role: 'Noor', from: S('ringsIn'), to: E('ringsHold'), note: 'Feld „zu groß“: Ring auf Hüfthöhe, die Schlaufen liegen am Boden, der rechte Fuß tritt auf eine und bleibt stehen (Fuß = Kapsel in der Simulation)' },
  { shot: 'p1.coil.natural', role: 'Noor', from: S('ringsIn'), to: E('ringsHold'), note: 'Feld „richtig“: kein eigener p5-Shot; die Endpose von p1.coil.natural (Ring ruhig vor der linken Hüfte), der Aufnahmeplan nennt A5 auch für „Stufe 5.3 (richtig groß)“' },
  { shot: 'p5.size.more', role: 'Noor', from: S('moreIn'), to: E('round'), note: 'Ich-Ansicht: Schlaufe etwas zu klein, sie beult sich, die rechte Hand lockert und lässt 5 cm nachrutschen, dann Übergabe an die Faust' },
  { shot: 'p5.size.giveway', role: 'Noor', from: S('gwIn'), to: E('gwEven'), note: 'Schlaufe kippt (will andersherum): nachgeben, Hand umgedreht als unter-Schlaufe legen; das Ausgleichen danach zeigt bei uns nur die Strichliste' },
];

// ===================================================================================== helpers

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v: V3): V3 => mul3(v, 1 / (Math.hypot(v[0], v[1], v[2]) || 1));
const mixV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeInOut = (u: number) => u * u * (3 - 2 * u);
const ease = (u: number) => {
  const x = clamp01(u);
  return x * x * x * (10 - 15 * x + 6 * x * x);
};

const RC = 0.0032;
const UP: V3 = [0, 1, 0];

// layout: her view left (55 %), outside right; three equal panels for the rings
const wL = Math.round((1920 - 3 * GAP) * 0.55);
const wR = 1920 - 3 * GAP - wL;
const xL = -960 + GAP, xR = 960 - GAP - wR;
const midY = TOP + PANEL_H / 2;
const wP = (1920 - 4 * GAP) / 3;
const xP = [0, 1, 2].map((k) => -960 + GAP + k * (wP + GAP));

/** node d1 by parallel transport along a polyline (kinematic cables: the stripe on top at the start) */
function transportFrames(P: V3[], d0: V3 = [0, 1, 0]): V3[] {
  const out: V3[] = [];
  let d = d0;
  for (let i = 0; i < P.length; i++) {
    const t = norm3(sub3(P[Math.min(P.length - 1, i + 1)], P[Math.max(0, i - 1)]));
    d = norm3(sub3(d, mul3(t, dot3(d, t))));
    out.push(d);
  }
  return out;
}

/** points at equal spacing h along a polyline */
function resampleLine(P: V3[], h: number): V3[] {
  const out: V3[] = [P[0]];
  let acc = 0, next = h;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    while (acc + l >= next) {
      out.push(mixV(a, b, (next - acc) / l));
      next += h;
    }
    acc += l;
  }
  out.push(P[P.length - 1]);
  return out;
}

/** a few passes of neighbour averaging (rounds the corners between the pieces of a kinematic cable) */
function relax(P: V3[], passes: number): V3[] {
  let A = P.map((p) => [...p] as V3);
  for (let r = 0; r < passes; r++) {
    const B = A.map((p) => [...p] as V3);
    for (let i = 1; i < A.length - 1; i++) B[i] = mixV(A[i], mul3(add3(A[i - 1], A[i + 1]), 0.5), 0.5);
    A = B;
  }
  return A;
}

/**
 * The bows the sunk cable lies in (bake, at shot time t): the free cable's nodes on the floor, its
 * turning in the floor plane split into runs of one sense; the strongest run (the clearest bow)
 * gets a circle fitted (least squares). Returns the circle and every bow's turning.
 */
function fitBows(b: BakedRod, t: number) {
  const i0 = Math.round(b.track('i0', 0));
  const sHand = b.track('feed', t);
  const tmp: V3 = [0, 0, 0];
  const P: V3[] = [];
  // (material coordinate ≈ node index × segment: nodes below the hand)
  const seg = 0.0075;
  const iHand = Math.min(b.n - 1, Math.floor(sHand / seg));
  for (let i = i0; i < iHand; i++) {
    const p = b.nodeAt(t, i, tmp);
    if (p[1] < RC + 0.004) P.push([p[0], p[1], p[2]]);
  }
  const turn: number[] = [];
  for (let i = 1; i < P.length - 1; i++) {
    const a = Math.atan2(P[i][2] - P[i - 1][2], P[i][0] - P[i - 1][0]);
    const c = Math.atan2(P[i + 1][2] - P[i][2], P[i + 1][0] - P[i][0]);
    let d = c - a;
    d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
    // (a jump between two floor pieces is not a bend)
    turn.push(Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][2] - P[i][2]) > 0.02 ? 0 : d);
  }
  const sm = turn.map((_, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - 4); j <= Math.min(turn.length - 1, i + 4); j++) { s += turn[j]; n++; }
    return s / n;
  });
  const runs: { a: number; b: number; turn: number }[] = [];
  let a = 0;
  for (let i = 1; i <= sm.length; i++) {
    if (i === sm.length || Math.sign(sm[i]) !== Math.sign(sm[a])) {
      let T = 0;
      for (let j = a; j < i; j++) T += turn[j];
      runs.push({ a, b: i, turn: T });
      a = i;
    }
  }
  const bows = runs.filter((r) => Math.abs(r.turn) > Math.PI / 2);
  const best = runs.reduce((m, r) => (Math.abs(r.turn) > Math.abs(m.turn) ? r : m), runs[0] ?? { a: 0, b: 0, turn: 0 });
  // Kasa fit: x² + z² + D x + E z + F = 0
  const pts = P.slice(best.a + 1, best.b + 1);
  let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, n = 0, sxr = 0, szr = 0, sr = 0;
  for (const p of pts) {
    const x = p[0], z = p[2], r = x * x + z * z;
    sxx += x * x; sxz += x * z; szz += z * z; sx += x; sz += z; n++;
    sxr += x * r; szr += z * r; sr += r;
  }
  // [sxx sxz sx; sxz szz sz; sx sz n] [D E F] = -[sxr szr sr]
  const M = [[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, n]];
  const v = [-sxr, -szr, -sr];
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d0 = det(M) || 1;
  const col = (k: number) => M.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)));
  const D = det(col(0)) / d0, Ez = det(col(1)) / d0, F = det(col(2)) / d0;
  const cx = -D / 2, cz = -Ez / 2;
  const R = Math.sqrt(Math.max(0, cx * cx + cz * cz - F));
  return { c: [cx, 0.004, cz] as V3, R, turn: best.turn, bows: bows.map((r) => r.turn), onFloor: P.length * seg };
}

/** a small dark chip (like the "Zeitlupe" badge), with any text */
function chip(layer: Node, text: string, visible: () => number, x: number, y = TOP + 24, fill: string = C.text) {
  layer.add(
    <Rect x={x} y={y} offset={[0, -1]} padding={[8, 20]} radius={30} fill={fill} opacity={visible} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={32} fill={'#fff'} />
    </Rect>,
  );
}

const G = EIGHT_GEOM;
const N8 = G.N;
/** the loop as it hangs below the fist (stage 5.2's geometry) */
const LOOP_C: V3 = add3(add3(G.F, mul3(G.E1, 0.035)), [0, -0.13, 0]);

// cameras (Noor stands at the origin facing -z)
/** the sink, outside: to her right and a little behind her, above, looking down at the floor in front of her */
const EXT_SINK: Orbit = { target: [0.12, 0.5, -0.45], yaw: 2.05, pitch: 0.6, dist: 2.9, fov: 40 };
/** the rings: all three panels, the same camera, the loops face-on from her front right */
const RING_CAM: Orbit = { target: [-0.1, 0.58, -0.38], yaw: Math.atan2(RING_N[0], RING_N[2]) + 0.1, pitch: 0.1, dist: 1.8, fov: 40 };
/** her loops (C, D), outside: from her right, a little in front, above: the loop against the light floor, not her dark clothes */
const EXT8: Orbit = { target: [LOOP_C[0], LOOP_C[1] - 0.02, LOOP_C[2]], yaw: 1.62, pitch: 0.42, dist: 1.2, fov: 38 };
/** the ghost loop in her hand faces her (a little to her right): her view sees it open */
const GHOST_N: V3 = norm3([0.15, 0, 1]);

/**
 * A dashed circle of radius R about c, tilted from the floor (theta 0) up into the vertical plane
 * facing N (theta π/2), about the horizontal axis cross(up, N); the first `frac` of it.
 */
function circlePoints(out: Float32Array, M: number, c: V3, R: number, N: V3, theta: number, frac = 1): number {
  const A = norm3(cross3(UP, N));
  const W = add3(mul3(N, -Math.cos(theta)), mul3(UP, Math.sin(theta)));
  const n = Math.max(2, Math.round((M - 1) * clamp01(frac)) + 1);
  for (let k = 0; k < n; k++) {
    // (start at the top: where a loop hangs from the hand)
    const ph = Math.PI / 2 + (2 * Math.PI * k) / (M - 1);
    const p = add3(c, add3(mul3(A, R * Math.cos(ph)), mul3(W, R * Math.sin(ph))));
    out.set(p, 3 * k);
  }
  return n;
}

/** two dashed tubes, dark and light (readable on the light floor and in front of the dark cable) */
function ghostMeshes(M: number, r = 0.0065) {
  const dark = new GhostPath({ maxPoints: M, radius: r, color: '#2b2f36', dash: 0.035, opacity: 0.8 });
  const light = new GhostPath({ maxPoints: M, radius: 0.62 * r, color: '#ffffff', dash: 0.035, opacity: 0.95 });
  dark.mesh.renderOrder = 5;
  light.mesh.renderOrder = 6;
  return {
    meshes: [dark.mesh, light.mesh],
    update(pts: Float32Array, n: number, on: boolean) {
      dark.mesh.visible = on;
      light.mesh.visible = on;
      if (!on) return;
      dark.update(pts, n);
      light.update(pts, n);
    },
  };
}

// ===================================================================================== the part

export function* part(layer: Node) {
  const B = {
    sink: (yield loadBake('p5-size-sink')) as BakedRod,
    small: (yield loadBake('p5-size-small')) as BakedRod,
    big: (yield loadBake('p5-size-big')) as BakedRod,
    right: (yield loadBake('p5-size-right')) as BakedRod,
    snap: (yield loadBake('eight-snap')) as BakedRod,
    rev: (yield loadBake('eight-reverse')) as BakedRod,
  };
  for (const p of captionProblems) console.log('[render] p5-size caption:', p);

  const { tau, run } = clock(LENGTH);
  /** 0 → 1 → 0 between scene times a and b (fading in and out) */
  const win = (a: number, b: number, fi = 0.35, fo = 0.35) => {
    const s = tau();
    return smooth((s - a) / Math.max(1e-6, fi)) * (1 - smooth((s - (b - fo)) / Math.max(1e-6, fo)));
  };
  const cur = () => segAt(tau());
  const t = () => shotAt(tau());

  // ------------------------------------------------------------------------- what the bakes say
  const fit = fitBows(B.sink, FIT_T);
  const ghostR = fit.R;
  const ring = (k: RingKind) => {
    const b = B[k], T = RING_T.end;
    return { aspMin: b.track('aspMin', T), aspMean: b.track('aspMean', T), out: b.track('out', T), w: b.track('w', T), h: b.track('h', T), low: b.track('low', T), onFloor: b.track('onFloor', T), underFoot: b.track('underFoot', T) };
  };
  const R3 = { small: ring('small'), big: ring('big'), right: ring('right') };
  const tilt = { out: B.snap.track('out', TILT_END), out0: B.snap.track('out', SNAP_T.free), wr: B.snap.track('wrLoop', TILT_END) };
  const revEnd = { wr: B.rev.track('wrLoop', OK_T.end), out: B.rev.track('out', OK_T.end) };
  // what may be claimed (labels and ticks appear only if the bake shows it)
  const truth = {
    bows: fit.bows.length >= 2 && fit.R > 0.06 && fit.R < 0.2,
    /** the small ring springs open / stands out (KONZEPT); with the preset it does not, see the report */
    smallSprings: R3.small.aspMin < 0.6 || R3.small.out > 0.04,
    smallTight: R3.small.w < 0.75 * 2 * ghostR,
    bigFloor: R3.big.onFloor > 0.1 && R3.big.low < 0.002,
    bigStep: R3.big.underFoot < 0.003,
    rightRound: R3.right.aspMin > 0.6 && R3.right.low > 0.1,
    tilts: tilt.out > tilt.out0 + 0.025,
    revFlat: Math.abs(revEnd.wr) < 0.3,
  };
  console.log('[render] p5-size checks', JSON.stringify({
    length: +LENGTH.toFixed(2),
    segs: SEGS.map((x) => `${x.id} ${x.at.toFixed(2)}`).join(' | '),
    fit: { R: +fit.R.toFixed(3), c: fit.c.map((x) => +x.toFixed(3)), turnDeg: Math.round((fit.turn * 180) / Math.PI), bowsDeg: fit.bows.map((x) => Math.round((x * 180) / Math.PI)), onFloor: +fit.onFloor.toFixed(2) },
    rings: R3, tilt, revEnd, truth, captionProblems,
  }));
  const diamCm = Math.round(200 * ghostR);

  // ------------------------------------------------------------------------- Noor: one RigTrack per take
  const rigAt = (s: number): Rig => {
    const sc = Math.min(LENGTH, Math.max(0, s));
    const sg = segAt(sc);
    const tt = shotAt(sc);
    if (sg.shot === 'sink') return sinkRig(tt, sc);
    if (sg.shot === 'more') return moreRig(tt, sc);
    if (sg.shot === 'snap' || sg.shot === 'rev') return eightRig(sg.shot, tt, sc, {});
    return ringRig('right', tt, sc);
  };
  const tracks = new Map<number, RigTrack>();
  const trackOf = (k: number) => {
    let tr = tracks.get(k);
    if (!tr) {
      const s0 = takeStart(k);
      tr = new RigTrack(NOOR, (x) => rigAt(s0 + x), 0, 30);
      tracks.set(k, tr);
    }
    return tr;
  };
  const poseNow = () => {
    const sg = cur();
    return trackOf(sg.take).pose(tau() - takeStart(sg.take));
  };

  // ------------------------------------------------------------------------- A · the sink
  const nS = B.sink.n;
  const i0S = Math.round(B.sink.track('i0', 0));
  const posS = new Float32Array(3 * nS), d1S = new Float32Array(3 * nS);
  // (her view: the real 6.4 mm; outside, a wide shot: drawn 10 mm, as KONZEPT allows for a Totale)
  const cableS = new CableMesh({ maxNodes: nS, radius: RC, plugStart: 'xlr-female', plugEnd: 'xlr-male', stripeWidth: 0.05 });
  const cableSW = new CableMesh({ maxNodes: nS, radius: 0.005, plugStart: 'xlr-female', plugEnd: 'xlr-male', stripeWidth: 0.05, plugScale: 1.3 });
  cableS.group.traverse((o) => o.layers.set(LAYER.FIRST));
  cableSW.group.traverse((o) => o.layers.set(LAYER.OUTSIDE));
  const noorS = splitPerson(NOOR, trackOf(0).pose(0));
  const GM = 97;
  const ghostPts = new Float32Array(3 * GM);
  const ghostS = ghostMeshes(GM, 0.008);
  const orbitTmp: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  let wideNow = true;
  const povS = makeCamera(62);
  viewLayers(povS, 'pov');
  const extS = makeCamera(40);
  viewLayers(extS, 'ext');
  /** the ghost loop at shot time tt and scene time s: drawn onto the bow, then lifted into her left hand */
  const ghostAt = (tt: number, s: number) => {
    const u = ease((tt - SINK_T.lift0) / (SINK_T.lift1 - SINK_T.lift0));
    const hang = add3(add3(sinkLH(tt), [0, -ghostR - 0.012, 0]), mul3(GHOST_N, 0.03));
    // (it rises a little more than straight: an arc up from the floor)
    const c = mixV(fit.c, hang, u);
    c[1] += 0.12 * Math.sin(Math.PI * u);
    const drawn = clamp01((s - S('circle') - 0.1) / 0.8);
    return { c, theta: (Math.PI / 2) * u, drawn };
  };
  const ghostOnS = () => tau() >= S('circle') + 0.1 && tau() <= E('ghost') + 0.05;
  const lookS = (s: number): V3 => {
    const sc = Math.min(LENGTH, Math.max(0, s));
    const tt = shotAt(sc);
    const r = sinkRH(tt);
    const land: V3 = [r[0] - 0.02, 0.05, r[2] - 0.22];
    const g = ghostAt(tt, sc).c;
    return mixV(land, g, smooth((sc - S('circle')) / 0.8));
  };
  const worldS = new World3D('p5-size-sink', () => {
    if (cur().shot !== 'sink') return;
    const tt = t();
    B.sink.frameSample(tt, posS, d1S);
    cableS.update(posS.subarray(3 * i0S), d1S.subarray(3 * i0S), nS - i0S);
    cableSW.update(posS.subarray(3 * i0S), d1S.subarray(3 * i0S), nS - i0S);
    noorS.update(poseNow());
    const g = ghostAt(tt, tau());
    const n = circlePoints(ghostPts, GM, g.c, ghostR, GHOST_N, g.theta, g.drawn);
    ghostS.update(ghostPts, n, ghostOnS());
    // (outside: the wide shot; then in front of her, close on the ghost loop in her hand)
    const gEnd = add3(add3(sinkLH(SINK_T.lift1), [0, -ghostR - 0.012, 0]), mul3(GHOST_N, 0.03));
    const toGhost = easeInOut(clamp01((tau() - S('lift') - 0.3) / 1.8));
    orbit(extS, toGhost > 0 ? mixOrbit(EXT_SINK, { target: gEnd, yaw: Math.PI - 0.4, pitch: 0.22, dist: 1.45, fov: 36 }, toGhost, orbitTmp) : EXT_SINK);
    // (the thick wide-shot cable only while the outside camera is wide; close up both views show the real one)
    const wide = toGhost < 0.5;
    if (wide !== wideNow) {
      wideNow = wide;
      cableSW.group.visible = wide;
      cableS.group.traverse((o) => o.layers.set(wide ? LAYER.FIRST : 0));
    }
    povFollow(povS, (x) => eyesOfRig(NOOR, rigAt(x)), lookS, tau(), { back: 0.05, up: 0.04, fov: 64, smooth: 0.35 });
  });
  new Studio(worldS.scene, { focus: [0.1, 0.4, -0.4], focusRadius: 1.3 });
  worldS.scene.add(cableS.group, cableSW.group, noorS.person.group, ...ghostS.meshes);

  // ------------------------------------------------------------------------- B · three rings
  const ringCam = makeCamera(40);
  viewLayers(ringCam, 'ext');
  const KINDS: RingKind[] = ['small', 'big', 'right'];
  const ringWorlds = KINDS.map((kind) => {
    const b = B[kind];
    const n = b.n, i0 = Math.round(b.track('i0', 0)), i1 = Math.round(b.track('i1', 0));
    const pos = new Float32Array(3 * n), d1 = new Float32Array(3 * n);
    const cable = new CableMesh({ maxNodes: i1 - i0 + 1, radius: RC, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.05 });
    const track = new RigTrack(NOOR, (x) => ringRig(kind, Math.min(RING_T.end, Math.max(0, x)), x + 30), 0, 30);
    const noor = splitPerson(NOOR, track.pose(0));
    const gp = new Float32Array(3 * GM);
    const ghost = ghostMeshes(GM, 0.0055);
    const world = new World3D(`p5-size-ring-${kind}`, () => {
      if (cur().shot !== 'rings') return;
      const tt = t();
      b.frameSample(tt, pos, d1);
      cable.update(pos.subarray(3 * i0), d1.subarray(3 * i0), i1 - i0 + 1);
      noor.update(track.pose(tt));
      // (see-through, so the black cable stands against the light studio, not her dark trousers)
      noor.seeThrough(0.32);
      const c = add3(add3(ringFist(tt), [0, -ghostR - 0.012, 0]), mul3(RING_N, 0.04));
      const m = circlePoints(gp, GM, c, ghostR, RING_N, Math.PI / 2, 1);
      ghost.update(gp, m, win(S('rings') + 2.2, E('ringsHold'), 0.5, 0.4) > 0.02);
      orbit(ringCam, RING_CAM);
    });
    new Studio(world.scene, { focus: [-0.1, 0.4, -0.35], focusRadius: 1.2 });
    world.scene.add(cable.group, noor.person.group, ...ghost.meshes);
    /** a node of the cable at the current shot time */
    const at = (i: number) => (): V3 => b.nodeAt(t(), i, [0, 0, 0]);
    return { kind, b, world, at, i0, i1 };
  });

  // ------------------------------------------------------------------------- C, D · her loops (stage 5.2's geometry)
  const nE = Math.max(B.snap.n, B.rev.n, 700);
  const posE = new Float32Array(3 * nE), d1E = new Float32Array(3 * nE);
  const cableE = new CableMesh({ maxNodes: nE, radius: RC, plugStart: null, plugEnd: 'xlr-female', stripeWidth: 0.05 });
  const noorE = splitPerson(NOOR, trackOf(2).pose(0));
  const early = [0, 1].map(() => new CableMesh({ maxNodes: 61, radius: RC, plugStart: null, plugEnd: null, stripeWidth: 0.05 }));
  const earlyPos = new Float32Array(3 * 61), earlyD1 = new Float32Array(3 * 61);
  const drawEarly = () => {
    earlierLoops(G.F).forEach((L, k) => {
      const c = mul3(L.reduce((a, p) => add3(a, p), [0, 0, 0] as V3), 1 / L.length);
      L.forEach((p, i) => {
        earlyPos.set(p, 3 * i);
        const inward = norm3(sub3(c, p));
        const ph = (2 * Math.PI * i) / (L.length - 1) + k * 2.1;
        earlyD1.set(add3(mul3(N8, Math.cos(ph)), mul3(inward, Math.sin(ph))), 3 * i);
      });
      early[k].update(earlyPos, earlyD1, L.length);
    });
  };
  /**
   * C: the kinematic cable of the bulge beat (shot time tt): the tail in her fist, the loop from the
   * fist to her pads (too short, bulging; then 5 cm more, round), the strand beyond the pads hanging
   * down to the floor and lying there up to the plug.
   */
  const padsOver = layPads('over');
  const moreShape = (tt: number): V3[] => {
    const pf = padsOver(Math.min(tt, MORE_T.back1));
    const P = pf.p;
    const grow = ease((tt - MORE_T.letOut0) / (MORE_T.letOut1 - MORE_T.letOut0));
    const L = MORE_L.short + (MORE_L.long - MORE_L.short) * grow;
    const a = 0.05 * ease((tt - MORE_T.bulge0) / (MORE_T.bulge1 - MORE_T.bulge0)) * (1 - grow);
    const tail: V3[] = [];
    for (let k = 0; k <= 14; k++) tail.push(add3(G.F, mul3(N8, -0.035 * (1 - k / 14))));
    const loop = roundLoop(G.F, P, L, 140).slice(1);
    const c = mul3(loop.reduce((s, p) => add3(s, p), [0, 0, 0] as V3), 1 / loop.length);
    // the bulge: a lobe on the outer side, low on her side of the loop, a little out of the ring
    loop.forEach((p, k) => {
      const u = k / (loop.length - 1);
      const bump = Math.exp(-(((u - 0.3) / 0.11) ** 2));
      const outward = norm3(sub3(p, c));
      loop[k] = add3(p, mul3(add3(outward, mul3(N8, 0.3)), a * bump));
    });
    // beyond the pads: on along the pads' direction, down to the floor, along it to the plug
    const d3 = norm3(sub3(P, loop[loop.length - 2]));
    const after = add3(P, mul3(d3, 0.03));
    const fd: V3 = norm3([0.55, 0, -0.45]);
    const low: V3 = [after[0], RC + 0.05, after[2]];
    const onFloor = add3([after[0], RC, after[2]], mul3(fd, 0.05));
    const floorLen = 0.3 - (L - MORE_L.short);
    const plug = add3(onFloor, mul3(fd, floorLen));
    const rest: V3[] = [after, low, onFloor, plug];
    const dense: V3[] = [...tail, ...loop];
    for (const q of rest) {
      const from = dense[dense.length - 1];
      const k = Math.max(1, Math.round(Math.hypot(...sub3(q, from)) / 0.005));
      for (let j = 1; j <= k; j++) dense.push(mixV(from, q, j / k));
    }
    // (round only the corners beyond the pads)
    const nKeep = tail.length + loop.length;
    const tailEnd = relax(dense.slice(nKeep - 2), 10);
    return resampleLine([...dense.slice(0, nKeep - 2), ...tailEnd], 0.0075);
  };
  const tiltArrow = new ArcArrow({ color: UNDER, thickness: 0.003 });
  const povE = makeCamera(58);
  viewLayers(povE, 'pov');
  const extE = makeCamera(38);
  viewLayers(extE, 'ext');
  const lookE = (): V3 => add3(LOOP_C, [0.02, -0.04, -0.06]);
  const worldE = new World3D('p5-size-loops', () => {
    const sg = cur();
    if (sg.shot !== 'more' && sg.shot !== 'snap' && sg.shot !== 'rev') return;
    const tt = t();
    if (sg.shot === 'more') {
      const P = moreShape(tt);
      const D = transportFrames(P);
      P.forEach((p, i) => {
        posE.set(p, 3 * i);
        d1E.set(D[i], 3 * i);
      });
      cableE.update(posE, d1E, P.length);
    } else {
      const b = B[sg.shot];
      b.frameSample(tt, posE, d1E);
      cableE.update(posE, d1E, Math.round(b.track('iPlug', 0)) + 1);
    }
    drawEarly();
    noorE.update(poseNow());
    // the loop tilts out of the ring (it wants the other way): an arrow about the fist's axis
    const on = sg.shot === 'snap' ? win(S('gwAsk'), E('gwAsk'), 0.3, 0.3) : 0;
    tiltArrow.group.visible = on > 0.02;
    if (on > 0.02) {
      const down: V3 = [0, -1, 0];
      tiltArrow.update({ center: add3(G.F, mul3(G.E1, 0.035)), axis: norm3(cross3(down, N8)), from: down, radius: 0.24, angle: 0.55, progress: on });
    }
    orbit(extE, EXT8);
    povFollow(povE, (x) => eyesOfRig(NOOR, rigAt(x)), lookE, tau(), { back: 0.05, up: 0.03, fov: 58, smooth: 0.3 });
  });
  new Studio(worldE.scene, { focus: [0.05, 0.6, -0.2], focusRadius: 1.2 });
  worldE.scene.add(cableE.group, noorE.person.group, ...early.map((m) => m.group), tiltArrow.group);

  // ------------------------------------------------------------------------- the picture
  const root = new Node({ opacity: () => smooth(tau() / 0.5) * (1 - smooth((tau() - S('out')) / 0.6)) });
  layer.add(root);
  // (cross-fades: the next beat fades in over the last one, which stays until it is covered)
  const XF = 0.45;
  const opA = () => win(S('in') - 0.01, E('ghost') + XF + 0.2, 0.4, 0.2);
  const opB = () => win(S('ringsIn'), E('ringsHold') + XF + 0.2, XF, 0.2);
  const opE = () => win(S('moreIn'), LENGTH + 1, XF, 0.3);

  // A
  const nodeA = new Node({ opacity: opA });
  const povViewS = (<ThreeView world={worldS} camera={povS} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} />) as ThreeView;
  const extViewS = (<ThreeView world={worldS} camera={extS} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} />) as ThreeView;
  nodeA.add([povViewS, extViewS, <PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  root.add(nodeA);

  // B
  const nodeB = new Node({ opacity: opB });
  const ringViews = ringWorlds.map((rw, k) => (<ThreeView world={rw.world} camera={ringCam} x={xP[k] + wP / 2} y={midY} width={wP} height={PANEL_H} radius={28} />) as ThreeView);
  nodeB.add(ringViews);
  const head = (k: number, good: boolean | null, text: string) =>
    nodeB.add(
      <Rect x={xP[k] + 24} y={TOP + 24} offset={[-1, -1]} padding={good === null ? [8, 22] : [8, 22, 8, 12]} radius={40} fill={good === null ? C.amber : C.plate} layout alignItems={'center'} gap={12}>
        {good === null ? null : <Mark good={good} size={40} />}
        <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={32} fill={good === null ? '#fff' : C.text} />
      </Rect>,
    );
  head(0, null, 'zu klein');
  head(1, false, 'zu groß');
  head(2, true, 'richtig');
  root.add(nodeB);

  // C, D
  const nodeE = new Node({ opacity: opE });
  const povViewE = (<ThreeView world={worldE} camera={povE} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} />) as ThreeView;
  const extViewE = (<ThreeView world={worldE} camera={extE} x={xR + wR / 2} y={midY} width={wR} height={PANEL_H} radius={28} />) as ThreeView;
  nodeE.add([povViewE, extViewE, <PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  root.add(nodeE);

  root.add(<StageChip current={5} x={0} y={TOP + PANEL_H + 34} />);

  // ------------------------------------------------------------------------- labels where it happens
  const label = (o: { view: ThreeView; target: () => V3; at: [number, number]; text: string; color?: string; on: () => number }) =>
    root.add(callout({ view: o.view, target: o.target, at: o.at, text: o.text, color: o.color, size: 34, arrow: true, opacity: o.on }));
  // A: the bows; the circle's size
  const bowPoint = (): V3 => add3(fit.c, mul3(norm3([0.5, 0, 0.8]), fit.R));
  const rimTmp = new Float32Array(3 * 9);
  if (truth.bows) {
    label({ view: extViewS, target: bowPoint, at: [xR + wR / 2 + 60, TOP + 690], text: 'liegt in Bögen', on: () => win(S('settle') - 0.3, S('circle') + 0.6, 0.4, 0.3) });
    label({ view: povViewS, target: () => { const g = ghostAt(t(), tau()); const n = circlePoints(rimTmp, 9, g.c, ghostR, GHOST_N, g.theta); return [rimTmp[3 * (n - 1) - 3 * 2], rimTmp[3 * (n - 1) - 3 * 2 + 1], rimTmp[3 * (n - 1) - 3 * 2 + 2]] as V3; }, at: [xL + wL / 2 + 230, TOP + 170], text: `Ø ${diamCm} cm`, on: () => win(S('circle') + 0.9, E('ghost'), 0.4, 0.35) });
  }
  // B: what each ring does (only what the bakes show)
  const [rs, rb, rr] = ringWorlds;
  const mid = (rw: (typeof ringWorlds)[number], f: number) => rw.at(Math.round(rw.i0 + f * (rw.i1 - rw.i0)));
  const lowest = (rw: (typeof ringWorlds)[number]) => () => {
    const tmp: V3 = [0, 0, 0];
    let best: V3 = [0, 9, 0];
    for (let i = rw.i0; i <= rw.i1; i += 3) {
      const p = rw.b.nodeAt(t(), i, tmp);
      if (p[1] < best[1]) best = [p[0], p[1], p[2]];
    }
    return best;
  };
  const onB = (a: number) => () => win(S('rings') + a, E('ringsHold'), 0.4, 0.4);
  if (truth.smallSprings) label({ view: ringViews[0], target: mid(rs, 0.35), at: [xP[0] + wP / 2, TOP + 640], text: 'federt auf, steht ab', color: C.amber, on: onB(2.3) });
  else if (truth.smallTight) label({ view: ringViews[0], target: mid(rs, 0.35), at: [xP[0] + wP / 2, TOP + 640], text: 'enger, als es liegen will', color: C.amber, on: onB(2.3) });
  if (truth.bigFloor) label({ view: ringViews[1], target: lowest(rb), at: [xP[1] + wP / 2, TOP + 200], text: 'schleift am Boden', on: onB(2.0) });
  if (truth.bigStep) label({ view: ringViews[1], target: () => add3(rightFootNow(), [0, 0.03, -0.08]), at: [xP[1] + wP / 2 + 60, TOP + 660], text: 'tritt drauf', on: onB(RING_T.step1 + 0.2) });
  if (truth.rightRound) label({ view: ringViews[2], target: mid(rr, 0.42), at: [xP[2] + wP / 2, TOP + 640], text: 'liegt von allein rund', on: onB(2.3) });
  function rightFootNow(): V3 {
    // (the sole's front, where it stands on the loop: from the rig's foot)
    const f = ringRig('big', t(), 0).feet[1];
    return 'ankle' in f ? add3(f.ankle, mul3(f.dir, 0.1)) : [0, 0, 0];
  }
  // C: the bulge, 5 cm more, round
  const bulgePoint = (): V3 => {
    const P = moreShape(t());
    return P[Math.round(14 + 0.3 * 92)] ?? P[0];
  };
  label({ view: extViewE, target: bulgePoint, at: [xR + 190, TOP + 640], text: 'beult sich', color: C.amber, on: () => win(S('bulge') + 0.2, E('bulge') + 0.4, 0.4, 0.3) });
  label({ view: povViewE, target: () => padsOver(MORE_T.back1).p, at: [xL + wL / 2 + 250, TOP + 190], text: '+ 5 cm', on: () => win(E('bulge') - 1.3, E('letOut') + 0.3, 0.4, 0.3) });
  label({ view: extViewE, target: () => mixV(G.F, LOOP_C, 1.7), at: [xR + wR / 2, TOP + 640], text: '✓ liegt rund', on: () => win(S('round') - 0.2, E('round'), 0.4, 0.3) });
  // D: it tilts, she gives in, flat
  if (truth.tilts) label({ view: extViewE, target: () => mixV(G.F, LOOP_C, 1.8), at: [xR + wR / 2 + 30, TOP + 640], text: 'kippt: will andersherum', color: C.amber, on: () => win(S('gwAsk'), E('gwAsk') + 0.2, 0.3, 0.3) });
  label({ view: extViewE, target: () => layPads('under')(t()).p, at: [xR + 210, TOP + 170], text: 'Hand umgedreht', on: () => win(S('gwRev'), S('gwRev') + 2.4, 0.3, 0.3) });
  if (truth.revFlat) label({ view: extViewE, target: () => mixV(G.F, LOOP_C, 1.7), at: [xR + wR / 2, TOP + 640], text: '✓ liegt flach', on: () => win(S('gwOk') - 0.6, E('gwEven'), 0.4, 0.3) });

  // D: the tally (ü +1, u −1): she gave in (u twice), evens it out soon (ü twice): the sum is 0 again
  const TALLY: { k: 'ü' | 'u'; lit: () => number; mark?: string }[] = [
    { k: 'ü', lit: () => 1 },
    { k: 'u', lit: () => 1 },
    { k: 'u', lit: () => smooth((tau() - S('gwRev') - 2.2) / 0.3), mark: 'nachgegeben' },
    { k: 'ü', lit: () => smooth((tau() - S('gwEven') - 0.6) / 0.3) },
    { k: 'ü', lit: () => smooth((tau() - S('gwEven') - 1.3) / 0.3), mark: 'ausgeglichen' },
    { k: 'u', lit: () => smooth((tau() - S('gwEven') - 2.0) / 0.3) },
  ];
  const tallyOn = () => win(S('gwIn'), E('gwEven'), 0.4, 0.4);
  const tal = (<Rect x={xR + wR - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 22]} radius={40} fill={C.plate} layout alignItems={'center'} gap={14} opacity={tallyOn} />) as Rect;
  TALLY.forEach((e) =>
    tal.add(
      <Rect layout padding={[0, 6]} radius={10} lineWidth={3} stroke={e.mark ? (e.k === 'ü' ? OVER : UNDER) : null} opacity={() => 0.15 + 0.85 * e.lit()}>
        <Txt text={e.k} fontFamily={FONT} fontWeight={800} fontSize={40} fill={e.k === 'ü' ? OVER : UNDER} />
      </Rect>,
    ),
  );
  root.add(tal);
  root.add(
    <Rect x={xR + wR - 24} y={TOP + 100} offset={[1, -1]} padding={[8, 22]} radius={40} fill={UNDER} layout opacity={() => win(S('gwRev') + 2.4, S('gwEven') + 0.4, 0.4, 0.3)}>
      <Txt text={'nachgegeben: 2× u'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={'#fff'} />
    </Rect>,
  );
  root.add(
    <Rect x={xR + wR - 24} y={TOP + 100} offset={[1, -1]} padding={[8, 22]} radius={40} fill={OVER} layout opacity={() => win(S('gwEven') + 1.4, E('gwEven'), 0.4, 0.3)}>
      <Txt text={'bald ausgeglichen: 2× ü'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={'#fff'} />
    </Rect>,
  );
  root.add(
    <Rect x={xR + wR - 24} y={TOP + 176} offset={[1, -1]} padding={[8, 22]} radius={40} fill={C.plate} layout opacity={() => win(S('gwEven') + 2.3, E('gwEven'), 0.4, 0.3)}>
      <Txt text={'+1 −1 −1 +1 +1 −1 = 0'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>,
  );

  // ------------------------------------------------------------------------- captions
  const capNow = () => {
    const s = tau();
    for (const c of CAPS) if (s >= c.a && s <= c.b) return { text: c.text, op: smooth((s - c.a) / CAP_IN) * (1 - smooth((s - (c.b - CAP_OUT)) / CAP_OUT)) };
    return { text: '', op: 0 };
  };
  root.add(<Txt y={CAPTION_Y} text={() => capNow().text} opacity={() => capNow().op} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />);
  // B ends with the right size ticked
  root.add(
    <Layout layout direction={'row'} alignItems={'center'} gap={16} x={xP[2] + wP / 2} y={TOP + PANEL_H - 70} opacity={() => (truth.rightRound ? win(S('ringsHold') + 1.0, E('ringsHold'), 0.4, 0.3) : 0)}>
      <Mark good size={52} />
    </Layout>,
  );

  yield* run();

  layer.removeChildren();
  worldS.dispose();
  ringWorlds.forEach((r) => r.world.dispose());
  worldE.dispose();
}
