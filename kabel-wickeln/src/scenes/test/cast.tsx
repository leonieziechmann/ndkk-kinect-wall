// Test scene: the cast sheet, in the studio of the video (key, fill and rim light). Every second
// shows one board:
//   0-2  the whole cast from the front, the side and the back (Ilse in her active wheelchair)
//   3    heads (3/4 view)
//   4    Noor's hijab from the front, 3/4, the side and the back, at the distance of the outside view
//   5-7  Noor's rigger gloves: right hand around the cable palm down (thumb on top), the same hand
//        turned palm up, the left hand holding loops (hook grip)
//   8-9  Noor coiling from outside (3/4 view) and from her own eyes (first-person view)
//   10   dark hands around the black cable: Kofi, Ada, Teo
//   11   Mai's work glove around the black power cable
//   12   Jonas' hands: painted nails, open hand and a pinch
//   13   Ilse in the wheelchair pulling a short cable apart
//   14   stances: squatting, kneeling, sitting, walking, carrying
// Stills: npm run stills -- --project test <scene start + 0.5, 1.5, …> (the scene starts after the
// 9 s render test)

import { Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import * as THREE from 'three';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { CableMesh, CableOptions } from '../../three/cable';
import { wheelchair } from '../../three/props';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';
import { ADA, CAST, ILSE, JONAS, KOFI, MAI, NOOR, ROBIN, TEO } from '../../people/cast';
import { Person3D, SELF, eyesOf } from '../../people/body3d';
import { Grip, HandRig, gripFrame, kneel, rigPose, seated, squat, stand, walk } from '../../people/rig';
import { V3, local, madd, quatCols } from '../../people/math';
import { PersonSpec, Pose, yawFrame } from '../../people/people';

const BOARDS = [
  'Besetzung · von vorn',
  'Besetzung · von der Seite',
  'Besetzung · von hinten',
  'Köpfe',
  'Noors Hidschab: vorn, schräg, Seite, hinten',
  'Rigger-Handschuh: Handfläche unten, Daumen oben',
  'Dieselbe Hand umgedreht: Handfläche oben',
  'Linke Hand hält Schlaufen (Hakengriff)',
  'Noor wickelt (außen)',
  'Noor wickelt (eigene Sicht)',
  'Dunkle Hände am schwarzen Kabel: Kofi, Ada, Teo',
  'Arbeitshandschuh um das Starkstromkabel',
  'Lackierte Nägel, offene Hand, Pinzettengriff',
  'Ilse im Aktivrollstuhl zieht ein kurzes Kabel auseinander',
  'Hocke, Knien, Sitzen, Gehen, Tragen',
];

const SPACING = 0.78;
const XLR = 0.0035;
const CEE = 0.008;
/** the line-up camera, inside the cyclorama */
const LINEUP_CAM: V3 = [0, 1.0, 8.6];
const LINEUP_AT: V3 = [0, 0.86, 0];
const LINEUP_FOV = 23.6;
/** the wheelchair's origin (under the seat) in front of the hip joints */
const CHAIR_FWD = 0.03;

/** where the two coiling hands of Noor hold the cable (also used for the close-ups) */
const RIGHT_DOWN = gripFrame([0.13, 1.0, -0.36], [-1, 0, -0.18], [0, 1, 0]);
const RIGHT_UP = gripFrame([0.13, 1.0, -0.36], [-1, 0, -0.18], [0, -1, 0]);
const LEFT_LOOPS = gripFrame([-0.14, 1.1, -0.33], [1, 0, 0.15], [0, -1, -0.35]);

/**
 * A static cable of the video's kind (satin jacket, yellow stripe) along a smooth curve through
 * `pts`; the stripe is carried along without twist, starting on top.
 */
function cableAlong(pts: V3[], r: number, closed = false, o: Partial<CableOptions> = {}): CableMesh {
  const curve = new THREE.CatmullRomCurve3(
    pts.map((p) => new THREE.Vector3(...p)),
    closed,
  );
  const n = Math.max(8, Math.ceil(curve.getLength() / 0.008));
  const pos = new Float32Array(n * 3);
  const d1 = new Float32Array(n * 3);
  const x = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const p = curve.getPointAt(u);
    const t = curve.getTangentAt(u);
    x.addScaledVector(t, -x.dot(t));
    if (x.lengthSq() < 1e-8) x.set(1, 0, 0).addScaledVector(t, -t.x);
    x.normalize();
    pos.set([p.x, p.y, p.z], i * 3);
    d1.set([x.x, x.y, x.z], i * 3);
  }
  const mesh = new CableMesh({ maxNodes: n, radius: r, ground: null, ...o });
  mesh.update(pos, d1, n);
  return mesh;
}

/** the points of a cable through a grip: straight in the fist, bending away at both ends */
function throughGrip(g: Grip, before: number, after: number, droop: number): V3[] {
  const [, , d3] = quatCols(g.q);
  const down: V3 = [0, -1, 0];
  return [
    madd(madd(g.p, d3, -before), down, droop),
    madd(madd(g.p, d3, -before * 0.6), down, droop * 0.2),
    madd(g.p, d3, -0.1),
    g.p,
    madd(g.p, d3, 0.1),
    madd(madd(g.p, d3, after * 0.6), down, droop * 0.2),
    madd(madd(g.p, d3, after), down, droop),
  ];
}

/** loops hanging from a hook grip: each one passes through the fist along d3 and hangs down */
function loopsFrom(g: Grip, n: number): THREE.Group {
  const [d1, d2, d3] = quatCols(g.q);
  const group = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const R = 0.13 + 0.006 * Math.sin(i * 2.1);
    // spread the strands inside the fist's hole
    const off = madd(madd(g.p, d1, (i % 2 ? 0.004 : -0.004) - 0.002), d2, (i - (n - 1) / 2) * 0.0065);
    const pts: V3[] = [];
    for (let s = 0; s < 24; s++) {
      const a = (s / 24) * Math.PI * 2;
      // a teardrop: straight through the fist, round below
      const x = Math.sin(a) * R * (0.82 + 0.06 * Math.cos(a));
      const y = -(1 - Math.cos(a)) * R * 1.12;
      const p = madd(madd(off, d3, x), [0, 1, 0], y);
      pts.push(madd(p, d2, (1 - Math.cos(a)) * 0.03 * (i - (n - 1) / 2) * 0.5));
    }
    group.add(cableAlong(pts, XLR, true).group);
  }
  return group;
}

export default makeScene2D(function* (view) {
  yield fontsReady();
  const t = createSignal(0);
  const board = () => Math.min(BOARDS.length - 1, Math.floor(t()));

  // ---------------------------------------------------------------- studio
  const world = new World3D('test-cast', update);
  const scene = world.scene;
  const studio = new Studio(scene, { shadowMapSize: 2048 });
  const cam = new THREE.PerspectiveCamera(20, 16 / 9, 0.02, 60);
  cam.layers.enable(SELF);
  // the fog of the studio, and pushed back for the far line-up camera
  const fog = scene.fog as THREE.Fog;
  const fogNear = fog.near;
  const fogFar = fog.far;

  // ---------------------------------------------------------------- people and props
  const standing = (spec: PersonSpec, x: number, yaw: number, z = 0): Pose => rigPose(spec, { ...stand(spec, [x, z], yaw), hands: [null, null] });
  /** extra Noors for the hijab board (one Person3D per pose shown at the same time) */
  const NOORS: PersonSpec[] = [1, 2, 3].map((i) => ({ ...NOOR, name: `Noor ${i}` }));
  const people = [...CAST, ...NOORS].map((spec) => new Person3D(spec, standing(spec, 0, 0)));
  const byName = new Map(people.map((p) => [p.spec.name, p]));
  const person = (spec: PersonSpec) => byName.get(spec.name) as Person3D;
  for (const p of people) scene.add(p.group);

  const chair = wheelchair();
  scene.add(chair);

  const ceeGrip = gripFrame([0.13, 1.0, -0.36], [-1, 0, -0.18], [0, 1, 0]);
  /** dark hands board: the right hand of each person around the cable, in front of the chest */
  const DARK = [KOFI, ADA, TEO];
  const darkX = (i: number) => (i - 1) * 0.5;
  const darkGrip = (i: number) => gripFrame([darkX(i) - 0.1, 1.05, 0.4], [-1, 0, 0.25], [0, 1, 0]);
  /**
   * Ilse's hands pulling a short cable apart in front of her (seated at the origin, facing +z: +x is
   * her left), overhand; the cable runs from her left hand to her right (-x)
   */
  const ilseGrip = (s: number) => gripFrame([s * 0.25, 0.88, 0.34], [-1, -0.12 * s, 0], [0, 1, 0]);
  const props = {
    rightDown: cableAlong(throughGrip(RIGHT_DOWN, 0.32, 0.3, 0.16), XLR).group,
    rightUp: cableAlong(throughGrip(RIGHT_UP, 0.32, 0.3, 0.16), XLR).group,
    loops: loopsFrom(LEFT_LOOPS, 4),
    cee: cableAlong(throughGrip(ceeGrip, 0.35, 0.35, 0.2), CEE, false, { plugEnd: 'cee-red' }).group,
    dark: new THREE.Group(),
    short: cableAlong(
      [madd(ilseGrip(1).p, [0.05, -0.07, 0.01], 1), madd(ilseGrip(1).p, [0.02, -0.005, 0], 1), ilseGrip(1).p, madd(ilseGrip(1).p, [-0.06, -0.012, 0], 1), [0, 0.81, 0.35], madd(ilseGrip(-1).p, [0.06, -0.012, 0], 1), ilseGrip(-1).p, madd(ilseGrip(-1).p, [-0.02, -0.005, 0], 1), madd(ilseGrip(-1).p, [-0.05, -0.07, 0.01], 1)],
      0.003,
      false,
      { stripeEdge: '#3a3d44', plugStart: 'usb-c', plugEnd: 'usb-c' },
    ).group,
  };
  DARK.forEach((_, i) => props.dark.add(cableAlong(throughGrip(darkGrip(i), 0.3, 0.3, 0.3), XLR).group));
  for (const p of Object.values(props)) scene.add(p);

  // ---------------------------------------------------------------- the boards
  const lineupX = (i: number) => (i - (CAST.length - 1) / 2) * SPACING;
  const right = (g: Grip, more: HandRig = {}): HandRig => ({ grip: g, radius: XLR, ...more });
  const coiling = (spec: PersonSpec, pos: [number, number]) =>
    rigPose(spec, {
      ...stand(spec, pos, 0, { width: 0.3 }),
      lean: 0.06,
      look: [0, 0.95, -0.42],
      hands: [{ grip: LEFT_LOOPS, radius: 0.011, thumbAlong: -1 }, right(RIGHT_DOWN)],
    });

  let shown = -1;
  function update() {
    const b = board();
    if (b === shown) return;
    shown = b;
    for (const p of people) p.group.visible = false;
    for (const p of Object.values(props)) p.visible = false;
    chair.visible = false;
    cam.layers.enable(SELF);
    fog.near = b <= 2 ? fogNear + 6 : fogNear;
    fog.far = b <= 2 ? fogFar + 8 : fogFar;
    const show = (spec: PersonSpec, pose: Pose) => {
      const p = person(spec);
      p.update(pose);
      p.group.visible = true;
    };
    const look = (pos: V3, target: V3, fov: number) => {
      cam.position.set(...pos);
      cam.fov = fov;
      cam.lookAt(...target);
      cam.updateProjectionMatrix();
    };

    /** Ilse in her wheelchair; her hands on her lap or as given */
    const sit = (pos: [number, number], yaw: number, look?: V3, hands?: [HandRig, HandRig]) => {
      const fr = yawFrame(yaw);
      chair.visible = true;
      chair.position.set(pos[0] + fr.f[0] * CHAIR_FWD, 0, pos[1] + fr.f[2] * CHAIR_FWD);
      chair.rotation.y = Math.PI - yaw;
      const lap = (s: number): HandRig => ({ wrist: local([pos[0], 0.62, pos[1]], fr.r, [0, 1, 0], fr.f, s * 0.13, 0, 0.17), dir: madd(fr.f, fr.r, -0.5 * s), palm: [0, -1, 0], curl: 0.35 });
      show(ILSE, rigPose(ILSE, { ...seated(ILSE, pos, yaw, 0.5), look, hands: hands ?? [lap(-1), lap(1)] }));
    };

    if (b <= 2) {
      const yaw = [Math.PI, Math.PI / 2, 0][b];
      CAST.forEach((spec, i) => (spec === ILSE ? sit([lineupX(i), 0], yaw) : show(spec, standing(spec, lineupX(i), yaw))));
      look(LINEUP_CAM, LINEUP_AT, LINEUP_FOV);
      studio.focus([0, 0.9, 0], 3.3);
    } else if (b === 3) {
      CAST.forEach((spec, i) => {
        const x = (i - (CAST.length - 1) / 2) * 0.42;
        const lookAt: V3 = [x + 2, 1.5, 6];
        if (spec === ILSE) sit([x, 0.1], Math.PI - 0.5, [x + 2, 1.2, 6]);
        else show(spec, rigPose(spec, { ...stand(spec, [x, 0], Math.PI - 0.5), look: lookAt, hands: [null, null] }));
      });
      look([0.75, 1.5, 5.6], [0.05, 1.42, 0], 21);
      studio.focus([0, 1.2, 0], 2);
    } else if (b === 4) {
      // front, 3/4, side, back
      const yaws = [Math.PI, Math.PI - 0.75, Math.PI / 2 + Math.PI, 0];
      [NOOR, ...NOORS].forEach((spec, i) => show(spec, standing(spec, (i - 1.5) * 0.48, yaws[i])));
      look([0, 1.45, 2.3], [0, 1.37, 0], 24);
      studio.focus([0, 1.2, 0], 1.4);
    } else if (b <= 7) {
      // hand close-ups: Noor coiling at the origin
      if (b === 7) {
        show(NOOR, coiling(NOOR, [0, 0]));
        props.loops.visible = true;
      } else {
        show(NOOR, rigPose(NOOR, { ...stand(NOOR, [0, 0], 0, { width: 0.3 }), lean: 0.06, look: [0, 0.95, -0.42], hands: [null, right(b === 5 ? RIGHT_DOWN : RIGHT_UP, b === 6 ? { thumbAlong: -1 } : {})] }));
        (b === 5 ? props.rightDown : props.rightUp).visible = true;
      }
      const g = b === 7 ? LEFT_LOOPS.p : RIGHT_DOWN.p;
      const from: V3 = b === 7 ? [g[0] - 0.22, g[1] + 0.12, g[2] - 0.6] : b === 6 ? [g[0] + 0.2, g[1] + 0.3, g[2] - 0.38] : [g[0] + 0.12, g[1] + 0.34, g[2] - 0.36];
      look(from, b === 7 ? [g[0], g[1] - 0.1, g[2]] : g, b === 7 ? 34 : 24);
      studio.focus(g, 0.5);
    } else if (b <= 9) {
      const pose = coiling(NOOR, [0, 0]);
      show(NOOR, pose);
      props.loops.visible = true;
      props.rightDown.visible = true;
      if (b === 8) look([1.2, 1.7, -1.75], [-0.04, 1.12, -0.22], 32);
      else {
        // first person: the own head and torso stay out of the picture
        const e = eyesOf(pose);
        cam.layers.disable(SELF);
        look(e.p, [0, 0.98, -0.36], 72);
      }
      studio.focus([0, 0.9, -0.3], 1);
    } else if (b === 10) {
      DARK.forEach((spec, i) => show(spec, rigPose(spec, { ...stand(spec, [darkX(i), 0], Math.PI), lean: 0.05, look: [darkX(i), 0.95, 0.5], hands: [null, right(darkGrip(i))] })));
      props.dark.visible = true;
      look([0.1, 1.45, 1.75], [-0.1, 0.98, 0.3], 36);
      studio.focus([0, 1.0, 0.3], 1);
    } else if (b === 11) {
      show(MAI, rigPose(MAI, { ...stand(MAI, [0, 0], 0, { width: 0.3 }), lean: 0.06, hands: [null, { grip: ceeGrip, radius: CEE, wrap: 1 }] }));
      props.cee.visible = true;
      const g = ceeGrip.p;
      look([g[0] + 0.12, g[1] + 0.34, g[2] - 0.36], g, 26);
      studio.focus(g, 0.5);
    } else if (b === 12) {
      // Jonas' hands in front of him: the left open, the right in a pinch
      show(JONAS, rigPose(JONAS, { ...stand(JONAS, [0, 0], 0), look: [0, 1.0, -0.5], hands: [{ wrist: [-0.16, 1.06, -0.36], dir: [0.7, 0.15, -0.7], palm: [0, 1, 0], curl: 0.12 }, { wrist: [0.12, 1.1, -0.36], dir: [-0.3, 0.5, -1], palm: [-0.7, 0.3, -0.6], curl: 0.4, pinch: 1 }] }));
      look([0.12, 1.32, -0.9], [-0.01, 1.1, -0.4], 30);
      studio.focus([0, 1.1, -0.4], 0.6);
    } else if (b === 13) {
      sit([0, 0], Math.PI, [0, 0.75, 0.6], [
        { grip: ilseGrip(1), radius: 0.003, thumbAlong: 1 },
        { grip: ilseGrip(-1), radius: 0.003, thumbAlong: -1 },
      ]);
      props.short.visible = true;
      look([0.75, 1.3, 2.0], [0, 0.72, 0.05], 34);
      studio.focus([0, 0.7, 0], 1);
    } else {
      show(MAI, rigPose(MAI, { ...squat(MAI, [-2.2, 0.1], 0.35, 1), look: [-2.0, 0, -0.5], hands: [{ wrist: [-2.24, 0.1, -0.32], dir: [0.1, -0.5, -0.8], curl: 0.6 }, { wrist: [-1.98, 0.1, -0.26], dir: [0.3, -0.5, -0.8], curl: 0.6 }] }));
      show(KOFI, rigPose(KOFI, { ...kneel(KOFI, [-1.0, 0], -0.25, 'R'), look: [-1.1, 0, -0.9], hands: [{ wrist: [-1.12, 0.52, -0.42], curl: 0.3 }, { wrist: [-0.85, 0.2, -0.5], dir: [0, -0.6, -0.8], curl: 0.5 }] }));
      sit([0.15, 0.06], -0.3, [0.6, 1.2, -1.5]);
      show(ROBIN, rigPose(ROBIN, walk(ROBIN, [{ t: 0, x: 0.6, z: 0.6 }, { t: 2, x: 1.6, z: -0.4 }], 0.9)));
      // carrying a heavy coil in front, both hands under it
      const jf = yawFrame(-0.5);
      const carry = (s: number) => gripFrame(local([2.5, 0.88, 0], jf.r, [0, 1, 0], jf.f, s * 0.17, 0, 0.3), madd(jf.f, jf.r, 0.3 * s), [0, -1, 0]);
      show(ADA, rigPose(ADA, { ...stand(ADA, [2.5, 0], -0.5, { stagger: 0.2 }), lean: 0.05, look: local([2.5, 0.9, 0], jf.r, [0, 1, 0], jf.f, 0, 0, 1.2), hands: [{ grip: carry(-1), radius: 0.015, thumbAlong: -1 }, { grip: carry(1), radius: 0.015 }] }));
      look([0.15, 1.9, -6.4], [0.15, 0.7, 0], 34);
      studio.focus([0, 0.6, 0], 3);
    }
    scene.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- the picture
  view.fill(C.bg);
  view.add(<ThreeView world={world} camera={cam} width={1920} height={1080} />);
  view.add(
    <Rect x={0} y={-478} layout padding={[12, 28]} radius={40} fill={'#ffffffd9'}>
      <Txt text={() => BOARDS[board()]} fontFamily={FONT} fontWeight={700} fontSize={34} fill={C.text} />
    </Rect>,
  );
  // names under the people in the line-up (where the line-up camera puts them)
  CAST.forEach((spec, i) => {
    const v = new THREE.Vector3(lineupX(i), -0.06, 0.25);
    const c = new THREE.PerspectiveCamera(LINEUP_FOV, 16 / 9, 0.02, 60);
    c.position.set(...LINEUP_CAM);
    c.lookAt(...LINEUP_AT);
    c.updateMatrixWorld();
    v.project(c);
    view.add(<Txt x={v.x * 960} y={-v.y * 540 + 26} text={spec.name} fontFamily={FONT} fontWeight={600} fontSize={30} fill={C.text} opacity={() => (t() < 3 ? 1 : 0)} />);
  });

  yield* t(BOARDS.length, BOARDS.length, linear);
});
