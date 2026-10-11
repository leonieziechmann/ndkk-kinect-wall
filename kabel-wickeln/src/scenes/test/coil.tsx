// Test scene: stage 1, shot 1 – Noor coils the 5 m XLR cable over and under into her left hand,
// split screen: her own view (left, 55 %) and from her right side, slightly behind her (right,
// 45 %). Both cameras look at the same side of the coil and stand still while the loops are
// compared. The cable is the baked simulation (shots/s1-coil.ts), the hands come from the same
// choreography (shots/coiling.ts), so they close around the cable where it is.
//
//   - two loops at a teaching pace: über, then unter (the right hand turns palm up, a 180° arrow
//     around the forearm), each followed by a freeze: time stops and the outside camera swings
//     ~70° round the left hand, so "in front of / behind" becomes left / right
//   - then four everyday loops; the tally ü u ü u ü u fills up as the loops are placed
//   - highlights as halos: the cable to the floor glows white, the new loop's arc at the crossing
//     gets a blue (über) or orange (unter) rim; labels on solid plates point at the crossing
//
// Stills: npm run stills -- --project test <scene start + s>

import { Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createSignal, linear, waitFor } from '@motion-canvas/core';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { BakedRod, V3, loadBake } from '../../sim';
import { COIL1, floorStart, loopNodes, povView } from '../../shots/s1-coil';
import { NOOR } from '../../people/cast';
import { Person3D } from '../../people/body3d';
import { rigPose } from '../../people/rig';
import { J } from '../../people/people';
import { ArcArrow } from '../../three/arrows';
import { CableMesh, rgba } from '../../three/cable';
import { lookFrom, makeCamera, orbit } from '../../three/camera';
import { callout } from '../../three/overlay';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

const OVER = '#2a6cc4';
const UNDER = '#b85000';

/** layers: the outside Noor (seen only by the outside camera), the first-person Noor (only by the POV) */
const OUTSIDE = 2, FIRST = 3;

/** the freezes: after loop k (1-based), how long the camera swings out, holds and comes back */
const FREEZE = { out: 1.4, hold: 1.6, back: 1.4 };
const FREEZE_LEN = FREEZE.out + FREEZE.hold + FREEZE.back;

/** shot time at which the clock stops for the freeze after loop k: the cable to the floor has dropped */
const freezeAt = (k: number) => COIL1.beats[k - 1].tFree + 0.45;

/** scene time → shot time: the shot runs at its own pace and stops for the two freezes */
function shotTime(tau: number) {
  let t = tau;
  for (const k of [1, 2]) {
    const f = freezeAt(k);
    if (t <= f) return t;
    t = Math.max(f, t - FREEZE_LEN);
  }
  return t;
}

/** scene time when the shot reaches shot time t (inverse of shotTime outside the freezes) */
function sceneTime(t: number) {
  let tau = t;
  for (const k of [1, 2]) if (t > freezeAt(k)) tau += FREEZE_LEN;
  return tau;
}

/** 0 … 1 … 0 while the freeze after loop k swings the camera out and back */
function swing(tau: number, k: number) {
  const u = tau - sceneTime(freezeAt(k));
  const s = (x: number) => x * x * (3 - 2 * x);
  if (u <= 0 || u >= FREEZE_LEN) return 0;
  if (u < FREEZE.out) return s(u / FREEZE.out);
  if (u < FREEZE.out + FREEZE.hold) return 1;
  return s(1 - (u - FREEZE.out - FREEZE.hold) / FREEZE.back);
}

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const bake = (yield loadBake('s1-coil')) as BakedRod;
  const tau = createSignal(0);
  const n = bake.n;
  const pos = new Float32Array(3 * n), d1 = new Float32Array(3 * n), halo = new Float32Array(4 * n);
  const node = (i: number, t: number): V3 => bake.nodeAt(t, i, [0, 0, 0]);

  // where the floor strand crosses each loop (found by the bake's check, constant once placed)
  const cross = COIL1.beats.map((b) => ({ loop: bake.track(`crossLoop${b.k}`, bake.duration), floor: bake.track(`crossFloor${b.k}`, bake.duration) }));

  // ---------------------------------------------------------------- the world
  const cable = new CableMesh({ maxNodes: n, radius: bake.radius, plugStart: 'xlr-male', plugEnd: 'xlr-female', haloPx: 7, haloMax: 1.2 });
  // the velcro tie: a ring through its eyelet round the cable, and its tail hanging down along it
  const TIE_R = bake.radius + 0.0006;
  const strap = new StrapMesh({ color: '#1e1f22', length: 2 * Math.PI * TIE_R + 0.003 });
  const tail = new StrapMesh({ color: '#1e1f22', length: 0.12, maxPoints: 24 });
  const tailPath = new Float32Array(24 * 3);
  const flipArrow = new ArcArrow({ color: UNDER, thickness: 0.0035 });
  const noorOut = new Person3D(NOOR, rigPose(NOOR, COIL1.rig(NOOR, 0)));
  const noorPov = new Person3D(NOOR, rigPose(NOOR, COIL1.rig(NOOR, 0, true)));
  // the outside camera sees the whole outside Noor; the POV sees its own Noor without head and torso
  // (layer 1), whose cheated arms cast no shadows (the outside Noor casts the shadows for both)
  for (const m of noorOut.group.children) m.layers.set(OUTSIDE);
  for (const m of noorPov.group.children) {
    if (m.layers.isEnabled(0)) m.layers.set(FIRST);
    m.castShadow = false;
  }
  noorOut.material.transparent = true;

  const pv = povView();
  const povCam = makeCamera(pv.fov);
  lookFrom(povCam, pv.eye, pv.look, pv.fov);
  povCam.layers.set(0);
  povCam.layers.enable(FIRST);
  const extCam = makeCamera(40);
  extCam.layers.set(0);
  extCam.layers.enable(OUTSIDE);
  const extTarget = COIL1.at(0.1, -0.13, 0.01);
  // from her right and a little behind her, just above the hands: lower, the left forearm (which
  // points at this camera) would hide the coil
  const EXT = { yaw: 1.05, pitch: 0.16, dist: 0.85, fov: 42 };

  const world = new World3D('test-coil', () => {
    const tt = tau();
    const t = shotTime(tt);
    const sw = Math.max(swing(tt, 1), swing(tt, 2));

    noorOut.update(rigPose(NOOR, COIL1.rig(NOOR, t)));
    noorPov.update(rigPose(NOOR, COIL1.rig(NOOR, t, true)));
    // see through Noor while the camera swings round her hands
    noorOut.material.opacity = 1 - 0.65 * sw;
    noorOut.material.depthWrite = sw < 0.01;

    bake.frameSample(t, pos, d1);
    cable.update(pos, d1, n, undefined, highlight(t, tt) ? halo : undefined);

    // the velcro tie on the plug end, 16 cm from the plug
    const i0 = Math.round(0.16 / 0.0125);
    const a = node(i0 - 1, t), b = node(i0 + 1, t);
    const c = node(i0, t), ax: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    strap.pose({ center: c, axis: ax, start: COIL1.n, radius: TIE_R, wrap: 1, fold: 0 });
    const al = Math.hypot(...ax), u = COIL1.n;
    for (let j = 0; j < 24; j++) {
      const sl = (0.12 * j) / 23, off = TIE_R + 0.002 + 0.025 * (sl / 0.12) ** 2;
      // down along the cable (toward the plug), leaning slowly away from it
      tailPath.set([c[0] + u[0] * off - (ax[0] / al) * sl, c[1] + u[1] * off - (ax[1] / al) * sl, c[2] + u[2] * off - (ax[2] / al) * sl], 3 * j);
    }
    tail.update(tailPath, 24, [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]]);

    // the 180° arrow round the right forearm while the hand turns palm up for "unter"
    const r = COIL1.right(t);
    const under = COIL1.beats[r.loop].kind === 'under' && r.mode === 'take';
    flipArrow.group.visible = under && r.loop === 1;
    if (flipArrow.group.visible) {
      const pose = rigPose(NOOR, COIL1.rig(NOOR, t));
      const w = pose.joints[J.rightWrist], e = pose.joints[J.rightElbow];
      const mid: V3 = [w[0] + (e[0] - w[0]) * 0.3, w[1] + (e[1] - w[1]) * 0.3, w[2] + (e[2] - w[2]) * 0.3];
      flipArrow.update({ center: mid, axis: [w[0] - e[0], w[1] - e[1], w[2] - e[2]], from: [0, 1, 0], radius: 0.055, angle: -Math.PI, progress: Math.min(1, r.flip * 1.15 + 0.08) });
    }

    // in the freeze the camera also closes in on the crossing
    const k = swing(tt, 1) > 0 ? 1 : 2;
    const cp = node(Math.max(0, cross[k - 1].loop), t);
    const target: V3 = [extTarget[0] + (cp[0] - extTarget[0]) * sw, extTarget[1] + (cp[1] - extTarget[1]) * sw, extTarget[2] + (cp[2] - extTarget[2]) * sw];
    orbit(extCam, { target, yaw: EXT.yaw + 1.22 * sw, pitch: EXT.pitch + 0.1 * sw, dist: EXT.dist * (1 - 0.55 * sw), fov: EXT.fov });
  });
  const scene = world.scene;
  new Studio(scene, { focus: COIL1.at(0.15, -0.5, 0.1), focusRadius: 0.9 });
  scene.add(cable.group, strap.group, tail.group, flipArrow.group, noorOut.group, noorPov.group);

  /** writes the halos for shot time t; false when none are shown */
  function highlight(t: number, tt: number) {
    halo.fill(0);
    // only around the two teaching loops: from the drop of the floor strand until the hand comes back
    const k = [1, 2].find((x) => t > COIL1.beats[x - 1].tOpen && t < COIL1.beats[x].t0 + 0.3 && tt > 0);
    if (!k) return false;
    const b = COIL1.beats[k - 1];
    const on = Math.min(1, (t - b.tOpen) / 0.4) * Math.min(1, (COIL1.beats[k].t0 + 0.3 - t) / 0.3);
    const white = rgba('#ffffff', 0.95 * on);
    for (let i = floorStart(k) + 1; i < n; i++) halo.set(white, 4 * i);
    const c = cross[k - 1];
    if (c.loop >= 0) {
      const rim = rgba(b.kind === 'over' ? OVER : UNDER, on);
      const [l0, l1] = loopNodes(k);
      for (let i = Math.max(l0, c.loop - 6); i <= Math.min(l1, c.loop + 6); i++) halo.set(rim, 4 * i);
    }
    return true;
  }

  // ---------------------------------------------------------------- the picture
  const gap = 24;
  const wL = Math.round((1920 - 3 * gap) * 0.55);
  const wR = 1920 - 3 * gap - wL;
  const top = -540 + gap;
  const hP = 820;
  const left = (<ThreeView world={world} camera={povCam} x={-960 + gap + wL / 2} y={top + hP / 2} width={wL} height={hP} radius={28} />) as ThreeView;
  const right = (<ThreeView world={world} camera={extCam} x={960 - gap - wR / 2} y={top + hP / 2} width={wR} height={hP} radius={28} />) as ThreeView;
  const title = (text: string, x: number) => (
    <Rect x={x} y={top + 24} offset={[-1, -1]} padding={[10, 22]} radius={40} fill={'#ffffffe6'} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>
  );
  view.add([left, right, title('So siehst du es', -960 + gap + 24), title('Von außen', 960 - gap - wR + 24)]);

  // labels at the crossings: in the POV while the loop is shown, in the outside view during the freeze
  const crossPoint = (k: number) => () => node(Math.max(0, cross[k - 1].loop), shotTime(tau()));
  const shown = (k: number, inFreeze: boolean) => () => {
    const tt = tau(), t = shotTime(tt);
    const b = COIL1.beats[k - 1];
    if (inFreeze) return swing(tt, k);
    const a = Math.min(1, Math.max(0, (t - b.tFree) / 0.35));
    const z = Math.min(1, Math.max(0, (COIL1.beats[k].t0 + 0.3 - t) / 0.3));
    return cross[k - 1].loop >= 0 ? a * z : 0;
  };
  const LABELS = ['Kabel zum Boden: obenauf', 'Die Schlaufe deckt es zu'];
  for (const k of [1, 2]) {
    const color = k === 1 ? OVER : UNDER;
    view.add(callout({ view: left, target: crossPoint(k), at: [-960 + gap + wL - 330, top + hP - 120], text: LABELS[k - 1], color, opacity: shown(k, false) }));
    view.add(callout({ view: right, target: crossPoint(k), at: [960 - gap - wR / 2, top + hP - 90], text: LABELS[k - 1], color, size: 32, opacity: shown(k, true) }));
  }

  // the tally: one letter per placed loop
  const tally = (
    <Rect x={960 - gap - 24} y={top + 24} offset={[1, -1]} padding={[10, 22]} radius={40} fill={'#ffffffe6'} layout gap={14} />
  ) as Rect;
  COIL1.beats.forEach((b) => {
    const placed = () => Math.min(1, Math.max(0, (shotTime(tau()) - b.tPlace) / 0.25));
    tally.add(<Txt text={b.kind === 'over' ? 'ü' : 'u'} fontFamily={FONT} fontWeight={800} fontSize={40} fill={b.kind === 'over' ? OVER : UNDER} opacity={() => 0.15 + 0.85 * placed()} />);
  });
  view.add(tally);

  // captions: ~1 s before the motion, long enough to read (chars / 12 + 1 s)
  const caption = (text: string) => (
    <Txt text={text} y={top + hP + 88} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} opacity={0} />
  ) as Txt;
  const cap1 = caption('Leg Schlaufen in die linke Hand – abwechselnd über und unter.');
  const cap2 = caption('Für »unter« drehst du die rechte Hand um.');
  view.add(new Node({ children: [cap1, cap2] }));

  const end = sceneTime(bake.duration);
  // the second caption comes a second before the hand turns over, the first one goes before that
  const cap2At = sceneTime(COIL1.beats[1].t0) - 1;
  const cap2Off = sceneTime(COIL1.beats[1].tRet) + 1;
  yield* all(
    tau(end, end, linear),
    (function* () {
      yield* waitFor(0.3);
      yield* cap1.opacity(1, 0.4);
      yield* waitFor(cap2At - 1.2 - 0.7);
      yield* cap1.opacity(0, 0.4);
      yield* waitFor(0.4);
      yield* cap2.opacity(1, 0.4);
      yield* waitFor(cap2Off - cap2At - 0.4);
      yield* cap2.opacity(0, 0.4);
    })(),
  );
});
