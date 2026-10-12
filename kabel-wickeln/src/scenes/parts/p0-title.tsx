// Title (KONZEPT "Titel", ≈ 12 s): the load-out after a show, one wide shot. Everybody works,
// nobody is presented: Noor coils a cable (front left), Kofi crosses the back with a long ring
// over his shoulder, Mai and Ada lay rings into a crate, Jonas closes a flight case, Robin carries
// a mic stand across the front, Ilse sits at the FOH desk. The camera glides to a clean ring on a
// flight case (tie closed, both plugs outside); title "Kabel richtig aufwickeln", below it
// "über, unter, über … (Over-Under-Methode)", then the stage bar.
//
// Rough animation (animatic): the people are keyframed rigs (shots/p0-title-rig.ts) solved with
// the arm IK (RigTrack); their recorded takes replace them (MOCAP_SLOTS). The clean ring is a
// simulation (shots/p0-title.ts, bake p0-title-ring: the over-under XLR laid on the case, settled);
// the other cables are drawn (guided): Noor's from her hands, the carried rings rigid.

import { Gradient, Layout, Node, Rect, Txt } from '@motion-canvas/2d';
import { all, createSignal, delay, easeInOutCubic, easeOutCubic, linear, waitFor } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, loadBake } from '../../sim';
import { HERO_CASE, HERO_TOP, RING_T } from '../../shots/p0-title';
import {
  COIL, CREW, CRATE_RINGS, HINGE_POINT, KOFI_RING, LATCHES, RingPose, RingShape, SET, STACK_RING, adaRing, kofiRing, latchClosed, lidAngle, maiRing, noorCable, resample, robinStand, rot,
} from '../../shots/p0-title-rig';
import { TIE_POINTS, tieAt } from '../../shots/deploy-tie';
import { Person3D } from '../../people/body3d';
import type { V3 } from '../../people/math';
import { yawFrame } from '../../people/people';
import { RigTrack } from '../../people/rig';
import { fullView } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { StageBar } from '../../lib/ui';
import { CableMesh } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit } from '../../three/camera';
import { cableCrate, flightCase, micStand, table, wheelchair } from '../../three/props';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { World3D } from '../../three/view';

// ===================================================================================== timing

/** the beats (part time, s) */
export const BEATS = {
  /** the wide shot drifts slowly; the glide to the clean ring */
  glide0: 4.4,
  glide1: 7.7,
  /** the title, the line below it, the stage bar (then with stage 1 lit) */
  title: 6.6,
  sub: 7.1,
  bar: 8.4,
  bar1: 11.0,
  /** everything fades to the background */
  out: 12.0,
  end: 12.6,
};
export const LENGTH = BEATS.end;

/**
 * The recorded takes that replace the keyframed bodies (shot ids from mocap/shots.json, part time).
 * Everybody is seen from the wide shot until the camera has glided to the ring.
 */
export const MOCAP_SLOTS = [
  { shot: 'p1.coil.natural', role: 'Noor', from: 0, to: BEATS.glide1, note: 'Noor wickelt vorn links in natürlichem Tempo über-unter (Schlaufen 3–6 eines 5-m-XLR), von schräg vorn gesehen; dieselbe Aufnahme wie Stufe 1.1/3.7 („Titel (Noor wickelt)“ in shots.json)' },
  { shot: 't.kofi.walk', role: 'Kofi', from: 0, to: BEATS.glide1, note: 'hinten quer von links nach rechts (Variante „von D-Start nach D-Ziel“, im Bild gespiegelt, wenn nötig), langer Ring über der rechten Schulter, rechte Hand vorn am Ring' },
  { shot: 't.robin.stand', role: 'Robin', from: 0, to: BEATS.glide1, note: 'vorn quer von rechts nach links, Stativ in der linken Hand (zur Kamera), schräg nach vorn geneigt' },
  { shot: 't.stack', role: 'Mai', from: 0, to: BEATS.glide1, note: 'Take „als Mai: links neben der Kiste“: in die Hocke, einen Ring am Klettband nehmen, aufstehen, in die Kiste legen' },
  { shot: 't.stack', role: 'Ada', from: 0, to: BEATS.glide1, note: 'Take „als Ada: rechts neben der Kiste“, 1,5 s nach Mai (Ada beginnt bei 1,5 s)' },
  { shot: 't.jonas.case', role: 'Jonas', from: 0, to: BEATS.glide1, note: 'Deckel zuklappen (Scharnier auf der Kameraseite), andrücken, beide Verschlüsse auf seiner Seite schließen, aufstehen; „am Griff anheben“ wird nicht gebraucht' },
  { shot: 't.ilse.foh', role: 'Ilse', from: 0, to: BEATS.glide1, note: 'am FOH-Tisch im Rollstuhl, linke Hand am Fader, rechte am Drehknopf, schaut bei 2,6–4,9 s zur Bühne' },
];

// ===================================================================================== cameras

const RING_C: V3 = [HERO_CASE.x, HERO_TOP, HERO_CASE.z];
/** the wide shot: from the front, high; it drifts a little closer while everybody works */
const WIDE_A: Orbit = { target: [-0.1, 0.72, -0.9], yaw: 0.04, pitch: 0.29, dist: 7.7, fov: 36 };
const WIDE_B: Orbit = { target: [0.05, 0.7, -0.8], yaw: -0.03, pitch: 0.31, dist: 7.1, fov: 36 };
/** close on the clean ring, from the front and above: the ring in the lower half (the title above it) */
const CLOSE: Orbit = { target: [RING_C[0], HERO_TOP + 0.02, RING_C[2] - 0.14], yaw: -0.14, pitch: 0.95, dist: 1.0, fov: 34 };

// ===================================================================================== helpers

const ramp01 = (x: number, a: number, b: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** d1 along a polyline by parallel transport (a cable without twist: the stripe runs straight) */
function transport(pos: Float32Array, n: number, d1: Float32Array) {
  let px = 0, py = 1, pz = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = pos[3 * b] - pos[3 * a], ty = pos[3 * b + 1] - pos[3 * a + 1], tz = pos[3 * b + 2] - pos[3 * a + 2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // start sideways (the stripe on the side, not on top: from above a drawn cable stays black)
    if (i === 0) [px, py, pz] = Math.abs(ty) > 0.9 ? [1, 0, 0] : [-tz, 0, tx];
    const d = px * tx + py * ty + pz * tz;
    px -= d * tx; py -= d * ty; pz -= d * tz;
    const l = Math.hypot(px, py, pz) || 1;
    px /= l; py /= l; pz /= l;
    d1[3 * i] = px; d1[3 * i + 1] = py; d1[3 * i + 2] = pz;
  }
}

/** a drawn (guided) cable: a polyline in, a tube out */
class DrawnCable {
  public readonly mesh: CableMesh;
  private readonly pos: Float32Array;
  private readonly d1: Float32Array;

  public constructor(maxNodes: number, o: Partial<ConstructorParameters<typeof CableMesh>[0]> = {}) {
    this.mesh = new CableMesh({ maxNodes, radius: COIL.r, plugStart: 'xlr-male', plugEnd: 'xlr-female', plugScale: 1.6, haloPx: 0, stripeWidth: 0.025, ...o });
    this.pos = new Float32Array(3 * maxNodes);
    this.d1 = new Float32Array(3 * maxNodes);
  }

  public set(P: V3[]) {
    const n = Math.min(P.length, this.mesh.maxNodes);
    for (let i = 0; i < n; i++) this.pos.set(P[i], 3 * i);
    transport(this.pos, n, this.d1);
    this.mesh.update(this.pos, this.d1, n);
  }
}

/** a rigid coiled ring with its velcro tie, placed anywhere (the rings carried and lying about) */
class RigidRing {
  public readonly group = new THREE.Group();
  private readonly cable: DrawnCable;
  private readonly tie = new StrapMesh({ length: 0.26, width: 0.02, thickness: 0.002, color: '#7d8188', inner: '#666a71' });
  private readonly local: V3[];

  public constructor(private readonly shape: RingShape, ground: number | null = null) {
    this.local = resample(shape.pts, 0.011);
    this.cable = new DrawnCable(this.local.length + 2, { stripe: null, ground });
    this.group.add(this.cable.mesh.group, this.tie.group);
  }

  public place(p: RingPose) {
    this.cable.set(this.local.map((v) => add3(p.c, rot(p.q, v))));
    const tie = this.shape.tie;
    this.tie.pose({ center: add3(p.c, rot(p.q, tie.c)), axis: rot(p.q, tie.axis), start: rot(p.q, [0, 1, 0.3]), radius: tie.radius, wrap: 1, fold: 1 });
  }
}
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** a flight case with a hinged lid (on its +z edge) and two butterfly latches on its -z side */
function lidCase(o: { width: number; depth: number; height: number; lid: number }) {
  const { width: W, depth: D, height: H, lid: L } = o;
  const ply = new THREE.MeshLambertMaterial({ color: '#333438' });
  const alu = new THREE.MeshStandardMaterial({ color: '#b9bdc3', roughness: 0.32, metalness: 0.5 });
  const steel = new THREE.MeshStandardMaterial({ color: '#d6d8dc', roughness: 0.22, metalness: 0.6 });
  const inner = new THREE.MeshLambertMaterial({ color: '#2a2a2c' });
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const group = new THREE.Group();
  const hb = H - L;
  // the body: four walls and a floor (open at the top), foam inside, aluminium rims and corners
  box(W, 0.012, D, ply, 0, 0.006, 0, group);
  for (const s of [-1, 1]) {
    box(W, hb, 0.012, ply, 0, hb / 2, (s * (D - 0.012)) / 2, group);
    box(0.012, hb, D, ply, (s * (W - 0.012)) / 2, hb / 2, 0, group);
  }
  box(W - 0.03, 0.01, D - 0.03, inner, 0, hb - 0.08, 0, group);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.022, hb, 0.022, alu, (sx * (W - 0.01)) / 2, hb / 2, (sz * (D - 0.01)) / 2, group);
  for (const sz of [-1, 1]) box(W, 0.018, 0.016, alu, 0, hb - 0.009, (sz * (D - 0.004)) / 2, group);
  for (const sx of [-1, 1]) box(0.016, 0.018, D, alu, (sx * (W - 0.004)) / 2, hb - 0.009, 0, group);
  // the lid: hinged on the +z edge (the pivot), closed it lies towards -z
  const lid = new THREE.Group();
  lid.position.set(0, hb, D / 2);
  group.add(lid);
  box(W, L, D, ply, 0, L / 2, -D / 2, lid);
  for (const sz of [0, -D]) box(W, 0.018, 0.016, alu, 0, 0.009, sz + (sz ? 0.006 : -0.006), lid);
  for (const sx of [-1, 1]) box(0.022, L, 0.022, alu, (sx * (W - 0.01)) / 2, L / 2, -D + 0.011, lid);
  box(W - 0.03, 0.01, D - 0.03, inner, 0, 0.006, -D / 2, lid);
  // latches on the -z side: a keeper on the lid, a lever on the body that flips up over it
  const latches: THREE.Group[] = [];
  for (const x of LATCHES.x) {
    box(0.05, 0.03, 0.008, steel, x, 0.012, -D - 0.004, lid);
    const g = new THREE.Group();
    g.position.set(x, hb - 0.035, -D / 2 - 0.006);
    box(0.06, 0.07, 0.008, steel, 0, 0.03, -0.002, g);
    group.add(g);
    latches.push(g);
  }
  return { group, lid, latches };
}

/** a small FOH mixing desk: a sloped wedge with fader rows, knobs and a meter bridge (facing -z) */
function mixer(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: '#3a3c41' });
  const panel = new THREE.MeshLambertMaterial({ color: '#55585e' });
  const cap = new THREE.MeshLambertMaterial({ color: '#c9c9c4' });
  const knob = new THREE.MeshLambertMaterial({ color: '#16171a' });
  const W = 0.5, D = 0.3;
  const shape = new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(D / 2, 0.085), new THREE.Vector2(-D / 2, 0.035)]);
  const wedge = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: false });
  wedge.translate(0, 0, -W / 2);
  wedge.rotateY(-Math.PI / 2);
  g.add(new THREE.Mesh(wedge, body));
  const surf = new THREE.Group();
  surf.position.set(0, 0.06, 0);
  surf.rotation.x = -Math.atan2(0.05, D);
  g.add(surf);
  surf.add(new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, 0.004, D - 0.02), panel));
  for (let i = 0; i < 12; i++) {
    const x = -W / 2 + 0.035 + i * ((W - 0.07) / 11);
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.02), cap);
    f.position.set(x, 0.008, -0.09 + 0.04 * Math.abs(Math.sin(i * 1.7)));
    surf.add(f);
    for (let k = 0; k < 4; k++) {
      const kb = new THREE.Mesh(new THREE.CylinderGeometry(0.0065, 0.0065, 0.012, 10), knob);
      kb.position.set(x, 0.008, 0.0 + k * 0.03);
      surf.add(kb);
    }
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(W, 0.05, 0.03), body);
  bridge.position.set(0, 0.11, D / 2 - 0.015);
  g.add(bridge);
  g.traverse((o) => (o.castShadow = o.receiveShadow = true));
  return g;
}

/** the back of the hall: a low stage with two speaker cabinets and two mic stands still on it */
function stageBack(): THREE.Group {
  const g = new THREE.Group();
  const top = new THREE.MeshLambertMaterial({ color: '#77797e' });
  const skirt = new THREE.MeshLambertMaterial({ color: '#45464b' });
  const cab = new THREE.MeshLambertMaterial({ color: '#1e1f22' });
  const grille = new THREE.MeshLambertMaterial({ color: '#3b3d42' });
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
  };
  const zc = SET.stageFront - 1.3;
  box(11, 0.04, 2.6, top, 0, 0.58, zc);
  box(11, 0.56, 2.6, skirt, 0, 0.28, zc);
  for (const x of [-3.9, 3.9]) {
    box(0.6, 1.0, 0.5, cab, x, 0.6 + 0.5, SET.stageFront - 0.5);
    box(0.52, 0.9, 0.02, grille, x, 0.6 + 0.5, SET.stageFront - 0.24);
  }
  for (const [x, rot] of [[-1.2, 0.4], [1.5, -0.3]]) {
    const m = micStand({ height: 1.4 });
    m.position.set(x, 0.6, SET.stageFront - 0.4);
    m.rotation.y = rot;
    g.add(m);
  }
  return g;
}

// ===================================================================================== the part

export function* part(layer: Node) {
  const bake = (yield loadBake('p0-title-ring')) as BakedRod;
  const tau = createSignal(0);
  const B = BEATS;

  // ---------------------------------------------------------------- the world
  const studio = { s: null as Studio | null };
  const cam = makeCamera(36, 0.05, 80);
  cam.layers.enableAll();

  // the clean ring: the last frame of the bake (settled), the tie from its bunch
  const tEnd = RING_T.end;
  const i0 = Math.round(bake.track('i0', 0)), i1 = Math.round(bake.track('i1', 0));
  const nc = i1 - i0 + 1;
  const pos = new Float32Array(3 * bake.n), d1 = new Float32Array(3 * bake.n);
  bake.frameSample(tEnd, pos, d1);
  const hero = new CableMesh({ maxNodes: nc, radius: bake.radius, plugStart: 'xlr-male', plugEnd: 'xlr-female', ground: HERO_TOP, haloPx: 0, sub: 3 });
  hero.update(pos.subarray(3 * i0), d1.subarray(3 * i0), nc);
  const tg = Array.from(bake.vector('tie', tEnd));
  const tieGeom = { c: tg.slice(0, 3) as V3, e: tg.slice(3, 6) as V3, v: tg.slice(6, 9) as V3, w: tg.slice(9, 12) as V3, a: tg[12], b: tg[13] };
  const heroTie = new StrapMesh({ length: 0.17, width: 0.014, thickness: 0.0016, color: '#7d8188', inner: '#666a71', maxPoints: TIE_POINTS });
  {
    const far = 1e6;
    const s = tieAt(tieGeom, { length: 0.17, width: 0.014, thickness: 0.0016, s: 0.1 }, { pinch: far, unfold: far + 1, letTie: far + 2, drop: far + 3 }, 0, { cableR: bake.radius, floorY: HERO_TOP });
    const path = new Float32Array(3 * TIE_POINTS);
    s.pts.forEach((p, k) => path.set(p, 3 * k));
    heroTie.update(path, TIE_POINTS, s.side);
  }
  const heroCase = flightCase({ width: HERO_CASE.width, depth: HERO_CASE.depth, height: HERO_CASE.height });
  heroCase.position.set(HERO_CASE.x, 0, HERO_CASE.z);
  // a light grey laminate: the black cable must stand out against it
  heroCase.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
    if (m && !Array.isArray(m) && m.color && m.color.getHexString() === '333438') m.color.set('#a3a6ab');
  });
  heroCase.rotation.y = HERO_CASE.yaw;

  // the people (keyframed rigs through the arm IK)
  const crew = CREW.map((c) => {
    const track = new RigTrack(c.spec, c.rig, 0, 60);
    return { track, person: new Person3D(c.spec, track.pose(0)) };
  });

  // Noor's cable (drawn from her hands every frame)
  const noorCab = new DrawnCable(Math.ceil(COIL.total / 0.012) + 40);
  // Kofi's ring, the rings Mai and Ada lay into the crate, the rings already in it and still on the floor
  const kofiR = new RigidRing(KOFI_RING);
  const maiR = new RigidRing(STACK_RING), adaR = new RigidRing(STACK_RING);
  const lying = [...CRATE_RINGS, { c: [SET.crate.x - 0.78, 0, SET.crate.z + 0.62] as V3, q: [0, Math.sin(0.6), 0, Math.cos(0.6)] as [number, number, number, number] }, { c: [SET.crate.x + 0.82, 0, SET.crate.z + 0.66] as V3, q: [0, Math.sin(-1.1), 0, Math.cos(-1.1)] as [number, number, number, number] }].map((p) => {
    const r = new RigidRing(STACK_RING);
    r.place(p);
    return r;
  });
  // Robin's mic stand
  const stand = micStand({ height: 1.35 });
  // Jonas' case, the crate, Ilse's desk and wheelchair
  const jc = lidCase(SET.jcase);
  jc.group.position.set(SET.jcase.x, 0, SET.jcase.z);
  void HINGE_POINT;
  const crate = cableCrate({ width: SET.crate.width, depth: SET.crate.depth, height: SET.crate.height });
  crate.position.set(SET.crate.x, 0, SET.crate.z);
  const desk = table({ width: SET.desk.width, depth: SET.desk.depth, height: SET.desk.height });
  desk.position.set(SET.desk.x, 0, SET.desk.z);
  const mix = mixer();
  mix.position.set(SET.mixer.x, SET.desk.height, SET.mixer.z);
  const chair = wheelchair();
  const fI = yawFrame(SET.ilse.yaw);
  chair.position.set(SET.ilse.seat[0] + fI.f[0] * 0.03, 0, SET.ilse.seat[1] + fI.f[2] * 0.03);
  chair.rotation.y = Math.PI - SET.ilse.yaw;
  // more of the load-out: cases stacked at the side, one waiting by the desk
  const extra: THREE.Object3D[] = [];
  const addCase = (x: number, y: number, z: number, r: number, w = 0.8, d = 0.6, h = 0.55) => {
    const c = flightCase({ width: w, depth: d, height: h });
    c.position.set(x, y, z);
    c.rotation.y = r;
    extra.push(c);
  };
  addCase(3.4, 0, -2.2, 0.15, 1.0, 0.6, 0.6);
  addCase(3.35, 0.6, -2.18, 0.1, 0.8, 0.5, 0.5);
  addCase(-4.1, 0, -0.9, -0.3, 0.6, 0.5, 0.5);
  addCase(0.55, 0, -2.25, 0.05, 0.9, 0.6, 0.45);

  const tmpOrbit: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const tmpWide: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const world = new World3D('p0-title', () => {
    const t = tau();
    for (const c of crew) c.person.update(c.track.pose(t));
    noorCab.set(resample(noorCable(t), 0.012));
    kofiR.place(kofiRing(t));
    maiR.place(maiRing(t));
    adaR.place(adaRing(t));
    const st = robinStand(t);
    stand.position.set(st.origin[0], st.origin[1], st.origin[2]);
    stand.quaternion.set(st.q[0], st.q[1], st.q[2], st.q[3]);
    jc.lid.rotation.x = lidAngle(t);
    jc.latches.forEach((g, i) => (g.rotation.x = -1.25 * (1 - latchClosed(t, LATCHES.x[i] < 0 ? 1 : 0))));
    // the camera: the wide shot drifting, then the glide to the ring
    const drift = easeInOutCubic(ramp01(t, 0, B.glide0));
    mixOrbit(WIDE_A, WIDE_B, drift, tmpWide);
    const u = easeInOutCubic(ramp01(t, B.glide0, B.glide1));
    orbit(cam, mixOrbit(tmpWide, CLOSE, u, tmpOrbit));
    // sharp shadows where the camera looks: the whole hall, then the case
    const fc: V3 = [-0.4 + (RING_C[0] + 0.4) * u, 0.7 + (RING_C[1] - 0.7) * u, -0.9 + (RING_C[2] + 0.9) * u];
    studio.s?.focus(fc, 6.2 * Math.pow(0.8 / 6.2, u));
  });
  const scene = world.scene;
  studio.s = new Studio(scene, { floorRadius: 16, focus: [-0.4, 0.7, -0.9], focusRadius: 6.2, shadowMapSize: 2048 });
  if (scene.fog instanceof THREE.Fog) {
    scene.fog.near = 15;
    scene.fog.far = 38;
  }
  scene.add(stageBack(), heroCase, hero.group, heroTie.group, noorCab.mesh.group, kofiR.group, maiR.group, adaR.group, ...lying.map((r) => r.group), stand, jc.group, crate, desk, mix, chair, ...extra);
  for (const c of crew) scene.add(c.person.group);

  // ---------------------------------------------------------------- the picture
  const view = fullView(layer, world, cam, true);
  view.opacity(0);

  // the title over the floor behind the case: a soft wash of the background colour keeps it readable
  const wash = (
    <Rect width={1920} height={620} y={-540 + 310} opacity={0}
      fill={new Gradient({ type: 'linear', from: [0, -310], to: [0, 310], stops: [{ offset: 0, color: 'rgba(242,238,230,0.92)' }, { offset: 0.62, color: 'rgba(242,238,230,0.75)' }, { offset: 1, color: 'rgba(242,238,230,0)' }] })} />
  ) as Rect;
  const title = (<Txt text={'Kabel richtig aufwickeln'} y={-300} fontFamily={FONT} fontWeight={800} fontSize={104} fill={C.text} letterSpacing={-2} opacity={0} />) as Txt;
  const word = (text: string, fill: string) => <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={56} fill={fill} />;
  const sub = (
    <Layout layout direction={'row'} alignItems={'center'} y={-192} opacity={0}>
      {word('über', OVER)}
      <Txt text={','} fontFamily={FONT} fontWeight={600} fontSize={56} fill={C.muted} marginRight={16} />
      {word('unter', UNDER)}
      <Txt text={','} fontFamily={FONT} fontWeight={600} fontSize={56} fill={C.muted} marginRight={16} />
      {word('über', OVER)}
      <Txt text={'…'} fontFamily={FONT} fontWeight={600} fontSize={56} fill={C.muted} marginLeft={14} />
      <Txt text={'(Over-Under-Methode)'} fontFamily={FONT} fontWeight={600} fontSize={44} fill={C.muted} marginLeft={26} />
    </Layout>
  ) as Layout;
  const bar0 = (<StageBar current={0} opacity={0} />) as Layout;
  const bar1 = (<StageBar current={1} opacity={0} />) as Layout;
  layer.add([wash, title, sub, bar0, bar1]);

  const rise = (n: Node, y: number, d = 0.8) => all(n.opacity(1, d, easeOutCubic), n.position.y(y + 28, 0).to(y, d, easeOutCubic));

  yield* all(
    tau(LENGTH, LENGTH, linear),
    view.opacity(1, 0.6, easeInOutCubic),
    (function* () {
      yield* waitFor(B.title - 0.3);
      yield* wash.opacity(0.8, 1.2, easeInOutCubic);
    })(),
    delay(B.title, rise(title, -300)),
    delay(B.sub, rise(sub, -192)),
    delay(B.bar, bar0.opacity(1, 0.7, easeInOutCubic)),
    delay(B.bar1, all(bar0.opacity(0, 0.6, easeInOutCubic), bar1.opacity(1, 0.6, easeInOutCubic))),
    delay(B.out, all(view.opacity(0, B.end - B.out, easeInOutCubic), wash.opacity(0, B.end - B.out), title.opacity(0, B.end - B.out), sub.opacity(0, B.end - B.out), bar1.opacity(0, B.end - B.out))),
  );

  layer.removeChildren();
  for (const c of crew) c.person.dispose();
  world.dispose();
}
