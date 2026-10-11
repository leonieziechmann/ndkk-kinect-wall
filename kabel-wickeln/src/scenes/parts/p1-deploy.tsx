// Stage 1, part 2 (KONZEPT stage 1, items 3 and 4): laying the cable out again, done right – not
// unrolled like a cable drum, but
//
//   A  short cable: Ilse at the FOH desk opens the velcro tie of a short charging-cable ring, takes
//      both ends (both outside the ring, highlighted) and pulls her hands apart: the loops open one
//      after the other, the cable hangs and lies calm. First from outside, then split: her own view
//      and from outside, behind her left shoulder.
//   B  long cable: Kofi keeps the end and two or three loops loosely in his open left hand and
//      throws the rest of a 15 m XLR ring underhand towards a mic stand. In real time from behind
//      him, then in slow motion (0.25×) from the side: the loops peel off the back of the flying
//      ring one after the other, the loops in his hand pay out after them, the cable lands in gentle
//      bends without curls; he lets the rest follow.
//
// Both cables are baked simulations (shots/deploy-pull.ts, shots/throw.ts) of rings laid out
// over-under (shots/deploy-ring.ts); the hands come from the same choreographies.

import { Layout, Node, Txt } from '@motion-canvas/2d';
import { all, createSignal, easeInOutCubic, linear, useTime, waitFor } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, loadBake, smooth } from '../../sim';
import { DESK, PULL_T, SEAT, SHORT, TIE, YAW, geoFromTracks, pullChoreo } from '../../shots/deploy-pull';
import { MIC_AT, THROW_RADIUS, THROW_TIE, THROW_WIDE_RADIUS, throwChoreo, throwGeoFromTracks, throwTimes } from '../../shots/throw';
import { ILSE, KOFI } from '../../people/cast';
import { yawFrame } from '../../people/people';
import { rigPose } from '../../people/rig';
import { Person3D, eyesOf } from '../../people/body3d';
import { CAPTION_Y, Captions, GAP, PANEL_H, PanelTitle, TOP, fullView, readTime, slowBadge, twoViews, viewLayers } from '../../lib/kit';
import { C, FONT } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { CableMesh, paint, rgba } from '../../three/cable';
import { Orbit, lookFrom, makeCamera, mixOrbit, orbit } from '../../three/camera';
import { callout } from '../../three/overlay';
import { micStand, table, wheelchair } from '../../three/props';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

export function* part(layer: Node) {
  console.log(`[render] p1-deploy starts at ${useTime().toFixed(3)}`); // DEV
  yield* shortCable(layer);
  console.log(`[render] p1-deploy B starts at ${useTime().toFixed(3)}`); // DEV
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

/** scene seconds: a still moment before the shot runs, the change to the split screen, the end */
const A_INTRO = 1.0;
const A_SPLIT_AT = A_INTRO + PULL_T.letTie - 0.15, A_SPLIT = 1.1;
const A_LEN = A_INTRO + PULL_T.end + 1.4;

/** the outside cameras: wide from her front left (who and where), closer on the ring (the tie) */
const A_WIDE: Orbit = { target: [0.02, 0.88, 0.42], yaw: 0.62, pitch: 0.26, dist: 2.1, fov: 36 };
const A_TIE: Orbit = { target: [0.03, 1.0, 0.38], yaw: 0.55, pitch: 0.15, dist: 0.66, fov: 34 };
/** split: behind her left shoulder, both hands in view; a little wider while they pull apart */
const A_BACK: Orbit = { target: [-0.02, 1.0, 0.4], yaw: 2.25, pitch: 0.4, dist: 1.05, fov: 42 };
const A_BACK_WIDE: Orbit = { target: [0.0, 0.97, 0.42], yaw: 2.25, pitch: 0.42, dist: 1.5, fov: 46 };

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
  const m = new THREE.Mesh(wedge, body);
  g.add(m);
  const slope = Math.atan2(0.05, D);
  const surf = new THREE.Group();
  surf.position.set(0, 0.06, 0);
  surf.rotation.x = -slope;
  g.add(surf);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(W - 0.02, 0.004, D - 0.02), panel);
  surf.add(plate);
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
  for (const o of g.children) o.castShadow = o.receiveShadow = true;
  surf.traverse((o) => (o.castShadow = o.receiveShadow = true));
  return g;
}

function* shortCable(layer: Node) {
  const bake = (yield loadBake('deploy-pull')) as BakedRod;
  const geo = geoFromTracks((k) => bake.track(k, 0));
  const ch = pullChoreo(geo);
  const n = bake.n;
  const T = PULL_T;
  const tau = createSignal(0);
  /** shot time: still during the intro, then real time */
  const t = () => Math.min(T.end, Math.max(0, tau() - A_INTRO));
  const split = () => easeInOutCubic(ramp(tau(), A_SPLIT_AT, A_SPLIT_AT + A_SPLIT));

  // ---------------------------------------------------------------- the world
  const pos = new Float32Array(3 * n), d1 = new Float32Array(3 * n), halo = new Float32Array(4 * n);
  const cable = new CableMesh({ maxNodes: n, radius: SHORT.radius, plugStart: 'usb-c', plugEnd: 'usb-c', stripeEdge: '#3a3d44', ground: DESK.height, haloPx: 6, haloMax: 3 });
  const tie = new StrapMesh({ length: TIE.length, width: TIE.width, thickness: TIE.thickness, color: '#80848b', inner: '#6c7077' });
  const pose = (tt: number) => rigPose(ILSE, ch.rig(tt));
  const ilse = twoViews(ILSE, pose(0), pose(0));
  const desk = table({ width: DESK.width, depth: DESK.depth, height: DESK.height });
  desk.position.set(DESK.x, 0, DESK.z);
  const mix = mixer();
  mix.position.set(0.32, DESK.height, DESK.z + 0.17);
  mix.rotation.y = -0.3;
  const chair = wheelchair();
  const f = yawFrame(YAW);
  chair.position.set(SEAT[0] + f.f[0] * 0.03, 0, SEAT[1] + f.f[2] * 0.03);
  chair.rotation.y = Math.PI - YAW;

  const extCam = makeCamera(36);
  viewLayers(extCam, 'ext');
  const povCam = makeCamera(70);
  viewLayers(povCam, 'pov');
  // her own view, steady: from the eyes, raised and moved back a little, so both hands stay in the
  // picture when they are apart
  const eyes = eyesOf(pose(T.gripB));
  const povEye: V3 = [eyes.p[0], eyes.p[1] + 0.1, eyes.p[2] - 0.12];
  const povLook: V3 = [0, 0.95, 0.42];

  /** both ends glow while they are pointed out */
  const endsOn = () => ramp(t(), T.gripB + 0.1, T.gripB + 0.5) * (1 - ramp(t(), T.pull0 - 0.1, T.pull0 + 0.4));
  const white = rgba('#ffffff', 1);
  const o1: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const o2: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  const o3: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };

  const world = new World3D('p1-deploy-ilse', () => {
    const tt = t();
    ilse.update(pose(tt), pose(tt));
    bake.frameSample(tt, pos, d1);
    const on = endsOn();
    if (on > 0) {
      halo.fill(0);
      paint(halo, 0, 10, white, 0.95 * on);
      paint(halo, n - 11, n, white, 0.95 * on);
    }
    cable.update(pos, d1, n, undefined, on > 0 ? halo : undefined);
    // the tie: on the ring, then off it and carried to the desk
    const s = ch.tie(tt);
    tie.pose({ center: geo.tie, axis: ch.tieAxis, start: ch.tieStart, radius: geo.tieR, wrap: s.wrap, fold: s.fold });
    const q = new THREE.Quaternion(...s.move.q);
    const pv = new THREE.Vector3(...s.pivot);
    tie.group.quaternion.copy(q);
    tie.group.position.copy(pv).add(new THREE.Vector3(...s.move.p)).sub(pv.clone().applyQuaternion(q));
    // cameras
    const sp = split();
    const back = mixOrbit(A_BACK, A_BACK_WIDE, easeInOutCubic(ramp(tt, T.outB, T.pull0)), o1);
    const front = mixOrbit(A_WIDE, A_TIE, easeInOutCubic(ramp(tau(), 0.5, A_INTRO + T.reach + 0.3)), o2);
    orbit(extCam, sp < 1 ? mixOrbit(front, back, sp, o3) : back);
    lookFrom(povCam, povEye, povLook, 78);
  });
  const scene = world.scene;
  new Studio(scene, { focus: [0, 0.85, 0.35], focusRadius: 1.1 });
  scene.add(cable.group, tie.group, ilse.out.group, ilse.pov.group, desk, mix, chair);

  // ---------------------------------------------------------------- the picture
  const extView = (
    <ThreeView world={world} camera={extCam} y={midY} height={PANEL_H} radius={28} opacity={0}
      x={() => -960 + GAP + fullW / 2 + (xR + wR / 2 - (-960 + GAP + fullW / 2)) * split()}
      width={() => fullW + (wR - fullW) * split()} />
  ) as ThreeView;
  const povView = (<ThreeView world={world} camera={povCam} x={xL + wL / 2} y={midY} width={wL} height={PANEL_H} radius={28} opacity={() => ramp(tau(), A_SPLIT_AT + A_SPLIT * 0.4, A_SPLIT_AT + A_SPLIT)} />) as ThreeView;
  layer.add([extView, povView]);
  const titles = new Node({ opacity: () => ramp(tau(), A_SPLIT_AT + A_SPLIT * 0.6, A_SPLIT_AT + A_SPLIT + 0.4) });
  titles.add([<PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  layer.add(titles);
  const chip = (<StageChip current={1} x={0} y={TOP + PANEL_H + 34} opacity={0} />) as Node;
  layer.add(chip);

  // both ends: labels in the outside view while the right hand draws its end out and holds still
  const end = (i: number) => () => bake.nodeAt(t(), i, [0, 0, 0]);
  const labelsOn = () => ramp(t(), T.gripB + 0.2, T.gripB + 0.5) * (1 - ramp(t(), T.hang - 0.2, T.hang + 0.1));
  layer.add(callout({ view: extView, target: end(2), at: [xR + 150, TOP + 200], text: 'Ende', opacity: labelsOn }));
  layer.add(callout({ view: extView, target: end(n - 3), at: [xR + wR - 150, TOP + 200], text: 'Ende', opacity: labelsOn }));

  // the end: ✓ the cable lies calm, no curls
  const done = (
    <Layout layout direction={'row'} alignItems={'center'} gap={18} x={xR + wR / 2} y={TOP + PANEL_H - 70} opacity={0}>
      <Mark good size={58} />
    </Layout>
  ) as Layout;
  layer.add(done);

  const cap = new Captions(layer);
  const CAP = 'Kurzes Kabel: Nimm beide Enden und zieh sie auseinander.';
  const at = (shotT: number) => A_INTRO + shotT;

  yield* all(
    tau(A_LEN, A_LEN, linear),
    extView.opacity(1, 0.5),
    chip.opacity(1, 0.5),
    (function* () {
      // the caption a second before the right hand goes for the end, until the hands are apart
      yield* waitFor(at(T.letTie) - 1.0);
      yield* cap.show(CAP);
      yield* waitFor(Math.max(readTime(CAP), at(T.pull1) - tau()));
      yield* cap.hide();
      yield* waitFor(at(T.lay1) - 0.2 - tau());
      yield* done.opacity(1, 0.4);
      yield* waitFor(A_LEN - tau() - 0.5);
      yield* all(...layer.children().map((c) => c.opacity(0, 0.5)));
    })(),
  );

  layer.removeChildren();
  world.dispose();
}

// ===================================================================================== B: long

// the cameras of the throw
/** his front right, close enough for the tie and the split */
const B_MED: Orbit = { target: [0.22, 1.02, -0.05], yaw: 0.9, pitch: 0.12, dist: 2.9, fov: 34 };
/** behind him, high and wide: the whole throw to the mic stand, in real time */
const B_BACK: Orbit = { target: [3.0, 0.3, 0.1], yaw: -1.45, pitch: 0.42, dist: 6.3, fov: 42 };
/** from his right side, following the flying ring (slow motion) */
const B_SIDE = { yaw: 0.06, pitch: 0.08, dist: 2.9, fov: 34 };
/** the laid cable from behind him and to his right, higher: from his hand to the mic stand */
const B_END: Orbit = { target: [3.2, 0.1, 0.0], yaw: -1.16, pitch: 0.45, dist: 6.9, fov: 40 };

function* longCable(layer: Node) {
  const bake = (yield loadBake('throw')) as BakedRod;
  const geo = throwGeoFromTracks((k) => bake.track(k, 0));
  const ch = throwChoreo(geo);
  const T = throwTimes(geo);
  const n = bake.n;

  // ---------------------------------------------------------------- scene time → shot time, camera
  /** four takes: the tie and the split (real time), the throw from behind (real time), the throw
   * again from the side (0.25×), the laid cable (real time, then a still moment) */
  const S1 = T.split1 + 0.3;
  const takes = [
    { len: S1, shot0: 0, rate: 1, cam: 'med' },
    { len: T.land + 1.3 - S1, shot0: S1, rate: 1, cam: 'back' },
    { len: (T.land + 0.35 - (T.release - 0.5)) / 0.25, shot0: T.release - 0.5, rate: 0.25, cam: 'side' },
    { len: T.end - (T.land + 0.35) + 2.6, shot0: T.land + 0.35, rate: 1, cam: 'end' },
  ] as const;
  const starts = takes.map((_, i) => takes.slice(0, i).reduce((a, k) => a + k.len, 0));
  const B_LEN = starts[3] + takes[3].len;
  const tau = createSignal(0);
  const take = () => {
    const s = tau();
    let i = takes.length - 1;
    while (i > 0 && s < starts[i]) i--;
    return i;
  };
  const t = () => {
    const i = take(), k = takes[i];
    return Math.min(T.end, k.shot0 + (tau() - starts[i]) * k.rate);
  };

  // ---------------------------------------------------------------- the world
  const pos = new Float32Array(3 * n), d1 = new Float32Array(3 * n);
  const near = new CableMesh({ maxNodes: n, radius: THROW_RADIUS, plugStart: 'xlr-male', plugEnd: 'xlr-female', sub: 3 });
  const wide = new CableMesh({ maxNodes: n, radius: THROW_WIDE_RADIUS, plugStart: 'xlr-male', plugEnd: 'xlr-female', plugScale: 1.4 });
  const tie = new StrapMesh({ ...THROW_TIE, color: '#80848b', inner: '#6c7077' });
  const kofi = new Person3D(KOFI, rigPose(KOFI, ch.rig(0, T.letGo)));
  const stand = micStand();
  stand.position.set(...MIC_AT);
  stand.rotation.y = -Math.PI / 2;
  const cam = makeCamera(34);
  const o: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  /** the side camera follows the ring, smoothly: a little behind it, never ahead of the landing */
  const sideAt = (tt: number): [number, number] => {
    const f = ch.flight(tt);
    const x = f ? f[0] : 0.6, y = f ? f[1] : 1.0;
    return [Math.min(MIC_AT[0] - 1.0, 0.9 + 0.75 * (x - 0.6)), 0.45 + 0.5 * y];
  };

  const world = new World3D('p1-deploy-kofi', () => {
    const tt = t();
    const which = takes[take()].cam;
    kofi.update(rigPose(KOFI, ch.rig(tt, T.letGo)));
    bake.frameSample(tt, pos, d1);
    const thin = which === 'med' || which === 'side';
    near.group.visible = thin;
    wide.group.visible = !thin;
    (thin ? near : wide).update(pos, d1, n);
    const s = ch.tie(tt);
    tie.group.visible = tt < T.pocket - 0.05;
    tie.pose({ center: geo.tie, axis: ch.tieAxis, start: ch.tieStart, radius: geo.tieR, wrap: s.wrap, fold: s.fold });
    const q = new THREE.Quaternion(...s.move.q);
    const pv = new THREE.Vector3(...s.pivot);
    tie.group.quaternion.copy(q);
    tie.group.position.copy(pv).add(new THREE.Vector3(...s.move.p)).sub(pv.clone().applyQuaternion(q));
    if (which === 'med') {
      orbit(cam, B_MED);
      studio.focus([0.2, 0.9, 0], 1.3);
    } else if (which === 'back') {
      orbit(cam, B_BACK);
      studio.focus([3.2, 0.4, 0.1], 4.6);
    } else if (which === 'side') {
      // average the ring's position over a third of a second of shot time: a calm pan
      let x = 0, y = 0;
      for (let k = -4; k <= 4; k++) {
        const a = sideAt(tt + k * 0.04);
        x += a[0] / 9;
        y += a[1] / 9;
      }
      orbit(cam, { ...B_SIDE, target: [x, y, 0.0] });
      studio.focus([x, 0.6, 0], 2.4);
    } else {
      orbit(cam, mixOrbit(B_END, { ...B_END, dist: B_END.dist * 0.94 }, smooth((tau() - starts[3]) / takes[3].len), o));
      studio.focus([3.3, 0.1, 0.1], 4.4);
    }
  });
  const scene = world.scene;
  const studio = new Studio(scene, { floorRadius: 9, focus: [0.2, 0.9, 0], focusRadius: 1.3 });
  scene.add(near.group, wide.group, tie.group, kofi.group, stand);

  // ---------------------------------------------------------------- the picture
  const view = fullView(layer, world, cam);
  /** fade in, and a short dip between the takes (the replay goes back in time) */
  view.opacity(() => {
    const s = tau();
    let d = Math.min(1, s / 0.4);
    for (const st of starts.slice(1)) d = Math.min(d, Math.abs(s - st) / 0.18);
    return d;
  });
  const chip = (<StageChip current={1} x={0} y={TOP + PANEL_H + 34} opacity={0} />) as Node;
  layer.add(chip);
  slowBadge(layer, () => (take() === 2 ? ramp(tau(), starts[2] + 0.1, starts[2] + 0.4) * (1 - ramp(tau(), starts[3] - 0.3, starts[3])) : 0));
  const done = (
    <Layout layout direction={'row'} alignItems={'center'} gap={20} y={CAPTION_Y} opacity={0}>
      <Mark good size={58} />
      <Txt text={'Keine Kringel, keine Knoten.'} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />
    </Layout>
  ) as Layout;
  layer.add(done);

  const cap = new Captions(layer);
  const CAP = 'Langes Kabel: Halt ein Ende fest und wirf den Ring Richtung Ziel.';

  yield* all(
    tau(B_LEN, B_LEN, linear),
    chip.opacity(1, 0.5),
    (function* () {
      // the caption while he gets ready, standing through the throw in real time
      yield* waitFor(0.5);
      yield* cap.show(CAP);
      yield* waitFor(Math.max(readTime(CAP), starts[2] - 0.6 - tau()));
      yield* cap.hide();
      // the slow motion runs without text; then the result
      yield* waitFor(starts[3] + 0.4 - tau());
      yield* done.opacity(1, 0.4);
      yield* waitFor(B_LEN - tau() - 0.5);
      yield* all(...layer.children().map((c) => c.opacity(0, 0.5)));
    })(),
  );

  layer.removeChildren();
  world.dispose();
}
