// Stage 1, part 2 (KONZEPT stage 1, items 3 and 4): laying a coil out again, done right.
//
//   A  short cable: Ilse at the FOH desk opens the velcro tie of a short charging-cable ring (the
//      tie stays on the cable), takes the start end next to its plug, lets the ring hang from that
//      hand, takes the other end with the other hand (both ends outside the ring, highlighted) and
//      pulls her hands apart: the loops open one after the other, the cable hangs calm between her
//      hands. From outside; while she pulls, split: her own view (arms only, her shadow) | outside.
//   B  long cable: Kofi throws an XLR ring towards a mic stand (see longCable below).
//
// Both are baked simulations (shots/deploy-pull.ts, shots/throw.ts) of over-under rings
// (shots/deploy-ring.ts); the people's arms come from the same RigTracks as in the bakes.

import { Layout, Node } from '@motion-canvas/2d';
import { all, createSignal, easeInOutCubic, linear, waitFor } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, loadBake, smooth } from '../../sim';
import { DESK, PULL_T, SEAT, SHORT_RING, TIE, TIE_POINTS, YAW, endsFrom, planFrom, pullRig, pullTrack, tieShape } from '../../shots/deploy-pull';
import { LONG_RING, MIC_AT, THROW_T, THROW_WIDE_RADIUS, TIE_K, flight, planFromK, swingPoint, throwTrack, tieShapeK } from '../../shots/throw';
import { ILSE, KOFI } from '../../people/cast';
import { yawFrame } from '../../people/people';
import { eyesOfRig } from '../../people/rig';
import { Captions, GAP, PANEL_H, PanelTitle, TOP, readTime, slowBadge, splitPerson, viewLayers } from '../../lib/kit';
import { Mark, StageChip } from '../../lib/ui';
import { CableMesh, paint, rgba } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit, povFollow } from '../../three/camera';
import { callout, project } from '../../three/overlay';
import { flightCase, micStand, table, wheelchair } from '../../three/props';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

export function* part(layer: Node) {
  yield* shortCable(layer);
  yield* longCable(layer);
}

// ===================================================================================== layout

const wL = Math.round((1920 - 3 * GAP) * 0.55);
const wR = 1920 - 3 * GAP - wL;
const xL = -960 + GAP, xR = 960 - GAP - wR;
const midY = TOP + PANEL_H / 2;
const fullW = 1920 - 2 * GAP;
const ramp = (x: number, a: number, b: number) => smooth((x - a) / (b - a));

// ===================================================================================== A: short

/** scene seconds: a still moment before the shot runs; the split screen (shot times); the end */
const A_INTRO = 0.6;
// (her view only while her hands are still in it: they leave it as they go wide)
const A_SPLIT_IN = PULL_T.pull0 - 0.7, A_SPLIT_OUT = PULL_T.pull0 + 1.7, A_SPLIT = 0.6;
const A_LEN = A_INTRO + PULL_T.end + 0.9;

/**
 * The outside cameras. Wide from her front left across the desk (who and where); then a cut to
 * over her right shoulder for the tie and the second end (the black ring against the light desk,
 * not against her dark jacket); a cut back to her front left, closer, for the two ends; wider for
 * the pull.
 */
const A_WIDE: Orbit = { target: [0.0, 0.95, 0.3], yaw: 0.62, pitch: 0.3, dist: 2.3, fov: 34 };
const A_WIDE_IN: Orbit = { target: [0.0, 1.0, 0.35], yaw: 0.6, pitch: 0.28, dist: 2.0, fov: 34 };
const A_OTS: Orbit = { target: [0.0, 1.06, 0.42], yaw: Math.PI + 0.55, pitch: 0.72, dist: 0.85, fov: 34 };
const A_OTS2: Orbit = { target: [0.0, 1.02, 0.42], yaw: Math.PI + 0.5, pitch: 0.68, dist: 0.95, fov: 34 };
const A_HOLD: Orbit = { target: [0.0, 1.03, 0.42], yaw: 0.5, pitch: 0.25, dist: 1.35, fov: 34 };
/** while she pulls: wide enough for both hands */
const A_PULL: Orbit = { target: [0.0, 1.0, 0.42], yaw: 0.45, pitch: 0.28, dist: 2.1, fov: 36 };
/** the cuts (scene seconds from the part's start; shot seconds) */
const A_CUT_OTS = A_INTRO + 0.35, A_CUT_FRONT = PULL_T.pull0 - 0.7;

/** a small FOH mixing desk: sloped surface, fader rows, knobs, a meter bridge (on the floor, facing -z) */
function mixer(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: '#3a3c41' });
  const panel = new THREE.MeshLambertMaterial({ color: '#55585e' });
  const cap = new THREE.MeshLambertMaterial({ color: '#c9c9c4' });
  const knob = new THREE.MeshLambertMaterial({ color: '#16171a' });
  const W = 0.44, D = 0.28;
  // a wedge: low at the front (towards Ilse, -z), higher at the back
  const shape = new THREE.Shape([new THREE.Vector2(-D / 2, 0), new THREE.Vector2(D / 2, 0), new THREE.Vector2(D / 2, 0.085), new THREE.Vector2(-D / 2, 0.035)]);
  const wedge = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: false });
  wedge.translate(0, 0, -W / 2);
  wedge.rotateY(-Math.PI / 2);
  g.add(new THREE.Mesh(wedge, body));
  const slope = Math.atan2(0.05, D);
  const surf = new THREE.Group();
  surf.position.set(0, 0.06, 0);
  surf.rotation.x = -slope;
  g.add(surf);
  surf.add(new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, 0.004, D - 0.02), panel));
  for (let i = 0; i < 10; i++) {
    const x = -W / 2 + 0.035 + i * ((W - 0.07) / 9);
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.02), cap);
    f.position.set(x, 0.008, -0.08 + 0.04 * Math.abs(Math.sin(i * 1.7)));
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

function* shortCable(layer: Node) {
  const bake = (yield loadBake('deploy-pull')) as BakedRod;
  const plan = planFrom((name, t) => bake.vector(name, t));
  const ends = endsFrom((name, t) => bake.frame(name, t));
  const track = pullTrack(plan, ends);
  const rig = pullRig(plan, ends).rig;
  const T = PULL_T;
  const i0 = Math.round(bake.track('cable0', 0)), i1 = Math.round(bake.track('cable1', 0));
  const nc = i1 - i0 + 1;
  const tieNode = Math.round(bake.track('tieNode', 0));
  const tau = createSignal(0);
  /** shot time: still during the intro, then real time */
  const t = () => Math.min(T.end, Math.max(0, tau() - A_INTRO));
  const split = () => easeInOutCubic(ramp(t(), A_SPLIT_IN, A_SPLIT_IN + A_SPLIT)) * (1 - easeInOutCubic(ramp(t(), A_SPLIT_OUT - A_SPLIT, A_SPLIT_OUT)));

  // ---------------------------------------------------------------- the world
  const pos = new Float32Array(3 * bake.n), d1 = new Float32Array(3 * bake.n), halo = new Float32Array(4 * nc);
  const cable = new CableMesh({ maxNodes: nc, radius: SHORT_RING.cable.od / 2, plugStart: 'usb-c', plugEnd: 'usb-c', stripeEdge: '#3a3d44', ground: DESK.height, haloPx: 7, haloMax: 3, sub: 3 });
  const tie = new StrapMesh({ length: TIE.length, width: TIE.width, thickness: TIE.thickness, color: '#7d8188', inner: '#666a71', maxPoints: TIE_POINTS });
  const tiePath = new Float32Array(3 * TIE_POINTS);
  const ilse = splitPerson(ILSE, track.pose(0));
  const desk = table({ width: DESK.width, depth: DESK.depth, height: DESK.height });
  desk.position.set(DESK.x, 0, DESK.z);
  const mix = mixer();
  mix.position.set(-0.42, DESK.height, DESK.z + 0.15);
  mix.rotation.y = 0.25;
  const chair = wheelchair();
  const f = yawFrame(YAW);
  chair.position.set(SEAT[0] + f.f[0] * 0.03, 0, SEAT[1] + f.f[2] * 0.03);
  chair.rotation.y = Math.PI - YAW;

  const extCam = makeCamera(34);
  viewLayers(extCam, 'ext');
  const povCam = makeCamera(62);
  viewLayers(povCam, 'pov');

  /** both ends glow while they are pointed out */
  const endsOn = () => ramp(t(), T.takeB - 0.1, T.takeB + 0.3) * (1 - ramp(t(), T.pull0 + 0.6, T.pull0 + 1.2));
  const white = rgba('#ffffff', 1);
  const oa: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const ob: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const nodeA: V3 = [0, 0, 0], nodeB: V3 = [0, 0, 0];
  const end = 0.04 / 0.006;

  const world = new World3D('p1-deploy-ilse', () => {
    const tt = t();
    ilse.update(track.pose(tt));
    bake.frameSample(tt, pos, d1);
    const on = endsOn();
    if (on > 0) {
      halo.fill(0);
      paint(halo, 0, Math.round(end), white, 0.95 * on);
      paint(halo, nc - Math.round(end), nc, white, 0.95 * on);
    }
    cable.update(pos.subarray(3 * i0), d1.subarray(3 * i0), nc, undefined, on > 0 ? halo : undefined);
    // the tie: kinematic round the ring, then hanging from the cable it lives on
    const ra = bake.nodeAt(tt, tieNode - 1, nodeA), rb = bake.nodeAt(tt, tieNode + 1, nodeB);
    const root = { p: [(ra[0] + rb[0]) / 2, (ra[1] + rb[1]) / 2, (ra[2] + rb[2]) / 2] as V3, d: [rb[0] - ra[0], rb[1] - ra[1], rb[2] - ra[2]] as V3 };
    const s = tieShape(plan, tt, root);
    s.pts.forEach((p, k) => tiePath.set(p, 3 * k));
    tie.update(tiePath, TIE_POINTS, s.side);
    // cameras: wide; cut over her shoulder; cut back to the front, wider for the pull
    if (tau() < A_CUT_OTS) orbit(extCam, mixOrbit(A_WIDE, A_WIDE_IN, easeInOutCubic(ramp(tau(), 0, A_CUT_OTS)), oa));
    else if (tt < A_CUT_FRONT) orbit(extCam, mixOrbit(A_OTS, A_OTS2, easeInOutCubic(ramp(tt, T.letTie, T.takeB)), oa));
    else orbit(extCam, mixOrbit(A_HOLD, A_PULL, easeInOutCubic(ramp(tt, T.pull0 - 0.6, T.pull0 + 1.0)), ob));
    povFollow(povCam, (x) => eyesOfRig(ILSE, rig(x)), () => [0.0, 1.0, 0.46], tt, { back: 0.08, up: 0.04, fov: 64, smooth: 0.3 });
  });
  const scene = world.scene;
  new Studio(scene, { focus: [0, 0.85, 0.35], focusRadius: 1.1 });
  scene.add(cable.group, tie.group, ilse.person.group, desk, mix, chair);

  // ---------------------------------------------------------------- the picture
  const extView = (
    <ThreeView world={world} camera={extCam} y={midY} height={PANEL_H} radius={28} opacity={0}
      x={() => -960 + GAP + fullW / 2 + (xR + wR / 2 - (-960 + GAP + fullW / 2)) * split()}
      width={() => fullW + (wR - fullW) * split()} />
  ) as ThreeView;
  const povView = (<ThreeView world={world} camera={povCam} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={() => ramp(split(), 0.4, 1)} />) as ThreeView;
  layer.add([extView, povView]);
  const titles = new Node({ opacity: () => ramp(split(), 0.6, 1) });
  titles.add([<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  layer.add(titles);
  const chip = (<StageChip current={1} x={0} y={TOP + PANEL_H + 34} opacity={0} />) as Node;
  layer.add(chip);

  // both ends: labels in the outside view while both hands hold still with them
  // (the plates stand above their ends, each on its own side, so the leaders never cross)
  const endAt = (i: number) => () => bake.nodeAt(t(), i, [0, 0, 0]);
  const plugA = endAt(i0 - 2), plugB = endAt(i1 + 2);
  const labelAt = (me: () => V3, other: () => V3) => () => {
    const p = project(extView, me()), q = project(extView, other());
    const side = p.x <= q.x ? -1 : 1;
    return [Math.max(-960 + GAP + 110, Math.min(960 - GAP - 110, p.x + side * 190)), Math.max(TOP + 60, p.y - 170)] as [number, number];
  };
  const labelsOn = () => ramp(t(), T.takeB, T.takeB + 0.3) * (1 - ramp(t(), A_SPLIT_IN - 0.3, A_SPLIT_IN));
  layer.add(callout({ view: extView, target: plugA, at: labelAt(plugA, plugB), text: 'Ende', opacity: labelsOn }));
  layer.add(callout({ view: extView, target: plugB, at: labelAt(plugB, plugA), text: 'Ende', opacity: labelsOn }));

  // the end: ✓ (the cable hangs calm, no curls)
  const done = (<Layout layout direction={'row'} alignItems={'center'} x={() => -960 + GAP + fullW / 2 + (xR + wR / 2 - (-960 + GAP + fullW / 2)) * split()} y={TOP + PANEL_H - 70} opacity={0}><Mark good size={58} /></Layout>) as Layout;
  layer.add(done);

  const cap = new Captions(layer);
  const CAP = 'Kurzes Kabel: Nimm beide Enden und zieh sie auseinander.';
  const at = (shotT: number) => A_INTRO + shotT;

  yield* all(
    tau(A_LEN, A_LEN, linear),
    extView.opacity(1, 0.5),
    chip.opacity(1, 0.5),
    (function* () {
      // the caption a second before the right hand goes for the start end; it stays through the pull
      yield* waitFor(at(T.letTie) - 1.0);
      yield* cap.show(CAP);
      yield* waitFor(Math.max(readTime(CAP), at(T.pull1) - tau()));
      yield* cap.hide();
      yield* waitFor(at(T.lay1) - tau());
      yield* done.opacity(1, 0.4);
      yield* waitFor(A_LEN - tau() - 0.5);
      yield* all(...layer.children().map((c) => c.opacity(0, 0.5)));
    })(),
  );

  layer.removeChildren();
  world.dispose();
}

// ===================================================================================== B: long

/** scene seconds: a still moment before the shot runs */
const B_INTRO = 0.4;
/** the real-time run ends a little after the landing (shot time); the slow-motion replay (shot times); the rest */
const B_RUN_END = THROW_T.land + 0.8;
const B_SLOW0 = THROW_T.release - 0.35, B_SLOW1 = THROW_T.land + 0.3, B_SLOW = 0.25;
const B_HOLD = 1.6;
/** the scene's phases */
const B_S_SLOW = B_INTRO + B_RUN_END, B_S_REST = B_S_SLOW + (B_SLOW1 - B_SLOW0) / B_SLOW;
const B_LEN = B_S_REST + (THROW_T.end - B_RUN_END) + B_HOLD;
/** shot time for scene time s: real time, the slow replay (a flashback), then real time again from where it stopped */
const throwTime = (s: number) =>
  s < B_S_SLOW ? Math.max(0, s - B_INTRO) : s < B_S_REST ? B_SLOW0 + (s - B_S_SLOW) * B_SLOW : Math.min(THROW_T.end, B_RUN_END + (s - B_S_REST));

/**
 * The cameras. Near, from his front right: the tie, the ring in his hands (its face to the
 * camera, the black cable against his pink shirt). Behind and above him, wide: the throw, the whole
 * flight, the ring's circle, the landing at the stand. The replay from the side, travelling with the
 * ring: the loops leave its back. Then high behind him: the cable on the floor.
 */
const B_NEAR: Orbit = { target: [0.38, 0.98, 0.0], yaw: 0.95, pitch: 0.12, dist: 1.75, fov: 34 };
const B_NEAR2: Orbit = { target: [0.32, 0.95, 0.12], yaw: 1.05, pitch: 0.14, dist: 2.1, fov: 34 };
const B_BEHIND: Orbit = { target: [5.2, 0.35, 0.3], yaw: -1.36, pitch: 0.3, dist: 8.9, fov: 38 };
const B_REST: Orbit = { target: [5.6, 0.0, 0.3], yaw: -1.2, pitch: 0.55, dist: 9.6, fov: 38 };
/** the cut from near to behind: just before the backswing */
const B_CUT = THROW_T.split + 0.1;

function* longCable(layer: Node) {
  const bake = (yield loadBake('throw')) as BakedRod;
  // (a bake from before this shot existed has no plan: then nothing to show yet)
  if (!bake.vectorNames.includes('plan')) return;
  const plan = planFromK((name, t) => bake.vector(name, t));
  const track = throwTrack(plan);
  const T = THROW_T;
  const i0 = Math.round(bake.track('cable0', 0)), i1 = Math.round(bake.track('cable1', 0));
  const nc = i1 - i0 + 1;
  const tieNode = Math.round(bake.track('tieNode', 0));
  const tau = createSignal(0);
  const t = () => throwTime(tau());
  const slow = () => (tau() >= B_S_SLOW && tau() < B_S_REST ? 1 : 0);

  // ---------------------------------------------------------------- the world
  const pos = new Float32Array(3 * bake.n), d1 = new Float32Array(3 * bake.n), halo = new Float32Array(4 * nc);
  const plugs = { plugStart: 'xlr-male' as const, plugEnd: 'xlr-female' as const };
  const near = new CableMesh({ maxNodes: nc, radius: LONG_RING.cable.od / 2, ...plugs, haloPx: 7, haloMax: 2 });
  // far away the real 6.4 mm would be a hair: the wide shots draw it 12 mm thick (KONZEPT)
  const wide = new CableMesh({ maxNodes: nc, radius: THROW_WIDE_RADIUS, ...plugs, plugScale: 1.6, haloPx: 7, haloMax: 2 });
  const tie = new StrapMesh({ length: TIE_K.length, width: TIE_K.width, thickness: TIE_K.thickness, color: '#7d8188', inner: '#666a71', maxPoints: TIE_POINTS });
  const tiePath = new Float32Array(3 * TIE_POINTS);
  const kofi = splitPerson(KOFI, track.pose(0));
  const stand = micStand();
  stand.position.set(...MIC_AT);
  stand.rotation.y = Math.PI / 2;
  // a calm load-out: cases at the side of the stage
  const cases = [flightCase({ width: 0.8, depth: 0.6, height: 0.7 }), flightCase({ width: 0.6, depth: 0.5, height: 0.5 }), flightCase({ width: 1.0, depth: 0.6, height: 0.6 })];
  cases[0].position.set(-1.2, 0, -1.6);
  cases[0].rotation.y = 0.2;
  cases[1].position.set(-1.1, 0.7, -1.55);
  cases[1].rotation.y = 0.3;
  cases[2].position.set(6.5, 0, -2.4);
  cases[2].rotation.y = -0.15;

  const cam = makeCamera(34);
  viewLayers(cam, 'ext');
  const oa: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const nodeA: V3 = [0, 0, 0], nodeB: V3 = [0, 0, 0];
  const white = rgba('#ffffff', 1);
  /** the end he keeps glows while it is pointed out */
  const endOn = () => (tau() < B_S_SLOW ? ramp(t(), 0.5, 0.8) * (1 - ramp(t(), T.split, T.split + 0.3)) : 0);
  /** where the ring is (for the travelling replay camera): the planned path, then where it lies */
  const ringAt = (tt: number): V3 => (tt < T.release ? swingPoint(plan, tt) : flight(Math.min(tt, T.land)));

  const world = new World3D('p1-deploy-kofi', () => {
    const tt = t(), s = tau();
    kofi.update(track.pose(tt));
    bake.frameSample(tt, pos, d1);
    const on = endOn();
    if (on > 0) {
      halo.fill(0);
      paint(halo, 0, 8, white, 0.95 * on);
    }
    // the wide shots draw the thick cable
    const far = s >= B_INTRO + B_CUT && !(s >= B_S_SLOW && s < B_S_REST);
    near.group.visible = !far;
    wide.group.visible = far;
    (far ? wide : near).update(pos.subarray(3 * i0), d1.subarray(3 * i0), nc, undefined, on > 0 ? halo : undefined);
    // the tie: kinematic round the ring, then hanging from the cable it lives on
    const ra = bake.nodeAt(tt, tieNode - 1, nodeA), rb = bake.nodeAt(tt, tieNode + 1, nodeB);
    const root = { p: [(ra[0] + rb[0]) / 2, (ra[1] + rb[1]) / 2, (ra[2] + rb[2]) / 2] as V3, d: [rb[0] - ra[0], rb[1] - ra[1], rb[2] - ra[2]] as V3 };
    const sh = tieShapeK(plan, tt, root);
    sh.pts.forEach((p, k) => tiePath.set(p, 3 * k));
    tie.update(tiePath, TIE_POINTS, sh.side);
    // cameras
    if (s < B_INTRO + B_CUT) orbit(cam, mixOrbit(B_NEAR, B_NEAR2, easeInOutCubic(ramp(s, 0, B_INTRO + B_CUT)), oa));
    else if (s < B_S_SLOW) orbit(cam, B_BEHIND);
    else if (s < B_S_REST) {
      // from his right side, travelling with the ring (a little behind it: the cable it pays out is in the picture)
      const r = ringAt(tt), u = ramp(tt, B_SLOW0, T.release + 0.3);
      const x = Math.max(0.3, r[0] - 0.9 * u);
      orbit(cam, { target: [x, 0.75, 0.3], yaw: 0.12, pitch: 0.14, dist: 3.4, fov: 40 });
    } else orbit(cam, mixOrbit(B_BEHIND, B_REST, easeInOutCubic(ramp(s, B_S_REST, B_S_REST + 1.5)), oa));
  });
  const scene = world.scene;
  const studio = new Studio(scene, { focus: [5.5, 0.4, 0.3], focusRadius: 7.5, floorRadius: 16 });
  void studio;
  scene.add(near.group, wide.group, tie.group, kofi.person.group, stand, ...cases);

  // ---------------------------------------------------------------- the picture
  const view = (<ThreeView world={world} camera={cam} x={0} y={midY} width={fullW} height={PANEL_H} radius={28} opacity={0} />) as ThreeView;
  layer.add(view);
  const chip = (<StageChip current={1} x={0} y={TOP + PANEL_H + 34} opacity={0} />) as Node;
  layer.add(chip);
  const badge = slowBadge(layer, () => ramp(tau(), B_S_SLOW, B_S_SLOW + 0.3) * (1 - ramp(tau(), B_S_REST - 0.3, B_S_REST)));
  void badge;
  // the end he keeps
  const plugA = () => bake.nodeAt(t(), i0 - 3, [0, 0, 0]);
  const labelOn = () => (tau() < B_S_SLOW ? ramp(t(), 0.5, 0.8) * (1 - ramp(t(), B_CUT - 0.35, B_CUT - 0.1)) : 0);
  layer.add(callout({ view, target: plugA, at: () => { const p = project(view, plugA()); return [p.x - 200, p.y - 150] as [number, number]; }, text: 'Ende', opacity: labelOn }));

  // the landed cable: the tick only if it really lies without curls (the bake's check)
  const curls = bake.track('curls', T.end), bend = bake.track('minBend', T.end);
  const clean = curls === 0 && bend > 0.03;
  const done = (<Layout layout direction={'row'} alignItems={'center'} x={0} y={TOP + PANEL_H - 70} opacity={0}><Mark good={clean} size={58} /></Layout>) as Layout;
  layer.add(done);

  const cap = new Captions(layer);
  const CAP = 'Langes Kabel: Halt ein Ende fest und wirf den Ring Richtung Ziel.';
  const CAP2 = clean ? 'Keine Kringel, keine Knoten.' : '';

  yield* all(
    tau(B_LEN, B_LEN, linear),
    view.opacity(1, 0.4),
    chip.opacity(1, 0.4),
    (function* () {
      // the caption well before the swing; it stays through the replay
      yield* waitFor(B_INTRO + 0.5);
      yield* cap.show(CAP);
      yield* waitFor(Math.max(readTime(CAP), B_S_REST - tau()));
      yield* cap.hide();
      if (CAP2) {
        yield* all(cap.show(CAP2), done.opacity(1, 0.4));
      }
      yield* waitFor(B_LEN - tau() - 0.5);
      yield* all(...layer.children().map((c) => c.opacity(0, 0.5)));
    })(),
  );

  layer.removeChildren();
  world.dispose();
}
