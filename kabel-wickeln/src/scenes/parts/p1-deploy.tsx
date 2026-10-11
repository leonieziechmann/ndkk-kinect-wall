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

import { Layout, Node, Txt } from '@motion-canvas/2d';
import { all, createSignal, easeInOutCubic, linear, waitFor } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, loadBake, smooth } from '../../sim';
import { DESK, PULL_T, SEAT, SHORT_RING, TIE, TIE_POINTS, YAW, endsFrom, planFrom, pullRig, pullTrack, tieShape } from '../../shots/deploy-pull';
import { ILSE } from '../../people/cast';
import { yawFrame } from '../../people/people';
import { eyesOfRig } from '../../people/rig';
import { CAPTION_Y, Captions, GAP, PANEL_H, PanelTitle, TOP, readTime, splitPerson, viewLayers } from '../../lib/kit';
import { C, FONT } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { CableMesh, paint, rgba } from '../../three/cable';
import { Orbit, makeCamera, mixOrbit, orbit, povFollow } from '../../three/camera';
import { callout } from '../../three/overlay';
import { table, wheelchair } from '../../three/props';
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
const A_SPLIT_IN = PULL_T.pull0 - 0.9, A_SPLIT_OUT = PULL_T.lay1 + 0.9, A_SPLIT = 0.8;
const A_LEN = A_INTRO + PULL_T.end + 0.9;

/** the outside cameras: from her front left across the desk; wide (who and where), then on the ring and her hands */
const A_WIDE: Orbit = { target: [0.0, 0.95, 0.3], yaw: 0.62, pitch: 0.3, dist: 2.3, fov: 34 };
const A_NEAR: Orbit = { target: [0.02, 1.06, 0.4], yaw: 0.72, pitch: 0.22, dist: 1.05, fov: 34 };
/** while she pulls: wide enough for both hands */
const A_PULL: Orbit = { target: [0.0, 1.0, 0.42], yaw: 0.45, pitch: 0.28, dist: 2.1, fov: 36 };

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
  mix.position.set(0.3, DESK.height, DESK.z + 0.2);
  mix.rotation.y = -0.25;
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
    // cameras: wide, closer on the ring, wider for the pull
    const near = mixOrbit(A_WIDE, A_NEAR, easeInOutCubic(ramp(tau(), 0.3, A_INTRO + T.pinch)), oa);
    orbit(extCam, mixOrbit(near, A_PULL, easeInOutCubic(ramp(tt, T.takeB - 0.4, T.pull0 + 0.6)), ob));
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
  const endAt = (i: number) => () => bake.nodeAt(t(), i, [0, 0, 0]);
  const labelsOn = () => ramp(t(), T.takeB, T.takeB + 0.3) * (1 - ramp(t(), T.pull0 + 0.3, T.pull0 + 0.6));
  layer.add(callout({ view: extView, target: endAt(i0 + 3), at: [xR + 120, TOP + 190], text: 'Ende', opacity: labelsOn }));
  layer.add(callout({ view: extView, target: endAt(i1 - 3), at: [xR + wR - 120, TOP + 190], text: 'Ende', opacity: labelsOn }));

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

function* longCable(layer: Node) {
  const t = new Txt({ text: 'Langes Kabel (im Umbau)', fontFamily: FONT, fontWeight: 600, fontSize: 36, fill: C.muted });
  layer.add(t);
  yield* waitFor(1);
  t.remove();
}
