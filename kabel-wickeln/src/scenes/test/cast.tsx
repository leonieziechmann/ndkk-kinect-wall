// Test scene: the cast sheet. Every second shows one board:
//   0-2  the whole cast from the front, the side and the back (Ilse on a stand-in seat)
//   3-6  hands: right hand around a cable palm down (thumb on top), the same hand turned palm up,
//        the left hand holding a few loops (hook grip), a gloved hand around a thick cable
//   7-8  Noor coiling from outside (3/4 view) and from her own eyes (first-person view)
//   9    stances: squatting, kneeling, sitting, walking, carrying
//   10   Jonas' hands: painted nails, open hand and a pinch
// Stills: npm run stills -- --project test <scene start + 0.5, 1.5, …>

import { Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import * as THREE from 'three';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { ThreeView, World3D } from '../../three/view';
import { CAST, ILSE, JONAS, KOFI, MAI, NOOR, ROBIN } from '../../people/cast';
import { Person3D, SELF, eyesOf } from '../../people/body3d';
import { Grip, HandRig, gripFrame, kneel, rigPose, seated, squat, stand, walk } from '../../people/rig';
import { V3, local, madd, quatCols } from '../../people/math';
import { PersonSpec, Pose, yawFrame } from '../../people/people';

const BOARDS = [
  'Besetzung · von vorn',
  'Besetzung · von der Seite',
  'Besetzung · von hinten',
  'Rechte Hand, Handfläche unten, Daumen oben',
  'Dieselbe Hand umgedreht: Handfläche oben',
  'Linke Hand hält Schlaufen (Hakengriff)',
  'Handschuh um ein dickes Kabel',
  'Noor wickelt (außen)',
  'Noor wickelt (eigene Sicht)',
  'Hocke, Knien, Sitzen, Gehen, Tragen',
  'Lackierte Nägel, offene Hand, Pinzettengriff',
];

const SPACING = 0.78;
const XLR = 0.0035;
const CEE = 0.008;

/** where the two coiling hands of Noor hold the cable (also used for the close-ups) */
const RIGHT_DOWN = gripFrame([0.13, 1.0, -0.36], [-1, 0, -0.18], [0, 1, 0]);
const RIGHT_UP = gripFrame([0.13, 1.0, -0.36], [-1, 0, -0.18], [0, -1, 0]);
const LEFT_LOOPS = gripFrame([-0.14, 1.1, -0.33], [1, 0, 0.15], [0, -1, -0.35]);

const lin = (hex: string) => new THREE.Color(hex);

/** a cable through a grip: straight in the fist, bending away at both ends */
function cableThrough(g: Grip, before: number, after: number, droop: number, r: number, mat: THREE.Material) {
  const [, , d3] = quatCols(g.q);
  const down: V3 = [0, -1, 0];
  const pts = [
    madd(madd(g.p, d3, -before), down, droop),
    madd(madd(g.p, d3, -before * 0.55), down, droop * 0.25),
    madd(g.p, d3, -0.06),
    g.p,
    madd(g.p, d3, 0.06),
    madd(madd(g.p, d3, after * 0.55), down, droop * 0.25),
    madd(madd(g.p, d3, after), down, droop),
  ].map((p) => new THREE.Vector3(...p));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, r, 14), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** loops hanging from a hook grip: each one passes through the fist along d3 and hangs down */
function loopsFrom(g: Grip, n: number, mat: THREE.Material) {
  const [d1, d2, d3] = quatCols(g.q);
  const group = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const R = 0.13 + 0.006 * Math.sin(i * 2.1);
    // spread the strands inside the fist's hole
    const off = madd(madd(g.p, d1, (i % 2 ? 0.004 : -0.004) - 0.002), d2, (i - (n - 1) / 2) * 0.0065);
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s < 48; s++) {
      const a = (s / 48) * Math.PI * 2;
      // a teardrop: straight through the fist, round below
      const x = Math.sin(a) * R * (0.82 + 0.06 * Math.cos(a));
      const y = -(1 - Math.cos(a)) * R * 1.12;
      const p = madd(madd(off, d3, x), [0, 1, 0], y);
      const tilt = madd(p, d2, (1 - Math.cos(a)) * 0.03 * (i - (n - 1) / 2) * 0.5);
      pts.push(new THREE.Vector3(...tilt));
    }
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 220, XLR, 12, true), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

export default makeScene2D(function* (view) {
  yield fontsReady();
  const t = createSignal(0);
  const board = () => Math.min(BOARDS.length - 1, Math.floor(t()));

  // ---------------------------------------------------------------- studio
  const floorC = '#ece3d6';
  const world = new World3D('test-cast', update);
  const scene = world.scene;
  scene.background = lin('#f3ede4');
  scene.fog = new THREE.Fog(lin('#f3ede4'), 11, 22);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: floorC, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const hemi = new THREE.HemisphereLight('#fff8ef', '#c9b8a2', 1.5);
  const key = new THREE.DirectionalLight('#fff3e2', 2.4);
  key.position.set(2.5, 6, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 5;
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.015;
  const fill = new THREE.DirectionalLight('#dfe7ff', 0.6);
  fill.position.set(-4, 2.5, 2);
  const rim = new THREE.DirectionalLight('#ffffff', 0.7);
  rim.position.set(-1.5, 3.5, -4);
  scene.add(floor, hemi, key, key.target, fill, rim);

  const cam = new THREE.PerspectiveCamera(20, 16 / 9, 0.02, 60);
  cam.layers.enable(SELF);

  // ---------------------------------------------------------------- people and props
  const standing = (spec: PersonSpec, x: number, yaw: number): Pose => rigPose(spec, { ...stand(spec, [x, 0], yaw), hands: [null, null] });
  const people = CAST.map((spec) => new Person3D(spec, standing(spec, 0, 0)));
  const byName = new Map(people.map((p) => [p.spec.name, p]));
  const person = (spec: PersonSpec) => byName.get(spec.name) as Person3D;
  for (const p of people) scene.add(p.group);

  // a stand-in seat for Ilse (the wheelchair is a prop of the render module)
  const seatMat = new THREE.MeshStandardMaterial({ color: '#8a8f96', roughness: 0.6 });
  const seat = new THREE.Group();
  const seatBox = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.44), seatMat);
  seatBox.position.set(0, 0.47, 0.02);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.42, 0.04), seatMat);
  back.position.set(0, 0.72, 0.24);
  for (const sx of [-0.2, 0.2]) {
    for (const sz of [-0.17, 0.21]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.44), seatMat);
      leg.position.set(sx, 0.22, sz);
      seat.add(leg);
    }
  }
  const rest = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.16), seatMat);
  rest.position.set(0, 0.09, -0.36);
  seat.add(seatBox, back, rest);
  seat.traverse((o) => ((o.castShadow = true), (o.receiveShadow = true)));
  scene.add(seat);

  const black = new THREE.MeshStandardMaterial({ color: '#25292f', roughness: 0.45 });
  const blue = new THREE.MeshStandardMaterial({ color: '#2b63c4', roughness: 0.5 });
  const props = {
    rightDown: cableThrough(RIGHT_DOWN, 0.32, 0.3, 0.16, XLR, black),
    rightUp: cableThrough(RIGHT_UP, 0.32, 0.3, 0.16, XLR, black),
    loops: loopsFrom(LEFT_LOOPS, 4, black),
    cee: cableThrough(gripFrame([0.13, 1.0, -0.36], [-1, 0, -0.18], [0, 1, 0]), 0.35, 0.35, 0.2, CEE, blue),
  };
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
    seat.visible = false;
    cam.layers.enable(SELF);
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

    /** Ilse on the stand-in seat, her hands on her lap */
    const sit = (pos: [number, number], yaw: number, look?: V3) => {
      const fr = yawFrame(yaw);
      seat.visible = true;
      seat.position.set(pos[0] + fr.f[0] * 0.06, 0, pos[1] + fr.f[2] * 0.06);
      seat.rotation.y = -yaw;
      const lap = (s: number): HandRig => ({ wrist: local([pos[0], 0.62, pos[1]], fr.r, [0, 1, 0], fr.f, s * 0.13, 0, 0.17), dir: madd(fr.f, fr.r, -0.5 * s), palm: [0, -1, 0], curl: 0.35 });
      show(ILSE, rigPose(ILSE, { ...seated(ILSE, pos, yaw, 0.5), look, hands: [lap(-1), lap(1)] }));
    };

    if (b <= 2) {
      const yaw = [Math.PI, Math.PI / 2, 0][b];
      CAST.forEach((spec, i) => (spec === ILSE ? sit([lineupX(i), 0], yaw) : show(spec, standing(spec, lineupX(i), yaw))));
      look([0, 1.05, 10.2], [0, 0.88, 0], 20);
      key.target.position.set(0, 0, 0);
    } else if (b <= 6) {
      // hand close-ups: Noor (Mai with gloves) coiling at the origin
      if (b === 6) {
        show(MAI, rigPose(MAI, { ...stand(MAI, [0, 0], 0, { width: 0.3 }), lean: 0.06, hands: [null, { grip: RIGHT_DOWN, radius: CEE, wrap: 1 }] }));
        props.cee.visible = true;
      } else if (b === 5) {
        show(NOOR, coiling(NOOR, [0, 0]));
        props.loops.visible = true;
      } else {
        show(NOOR, rigPose(NOOR, { ...stand(NOOR, [0, 0], 0, { width: 0.3 }), lean: 0.06, look: [0, 0.95, -0.42], hands: [null, right(b === 3 ? RIGHT_DOWN : RIGHT_UP, b === 4 ? { thumbAlong: -1 } : {})] }));
        (b === 3 ? props.rightDown : props.rightUp).visible = true;
      }
      const g = b === 5 ? LEFT_LOOPS.p : RIGHT_DOWN.p;
      const from: V3 = b === 5 ? [g[0] - 0.2, g[1] + 0.08, g[2] - 0.62] : [g[0] + 0.3, g[1] + 0.16, g[2] - 0.34];
      look(from, b === 5 ? [g[0], g[1] - 0.1, g[2]] : g, b === 5 ? 34 : 26);
      key.target.position.set(g[0], 0, g[2]);
    } else if (b <= 8) {
      const pose = coiling(NOOR, [0, 0]);
      show(NOOR, pose);
      props.loops.visible = true;
      props.rightDown.visible = true;
      if (b === 7) look([1.25, 1.55, 1.25], [-0.02, 0.98, -0.25], 30);
      else {
        // first person: the own head and torso stay out of the picture
        const e = eyesOf(pose);
        cam.layers.disable(SELF);
        look(e.p, [0, 0.98, -0.36], 72);
      }
      key.target.position.set(0, 0, 0);
    } else if (b === 9) {
      show(MAI, rigPose(MAI, { ...squat(MAI, [-2.2, 0.1], 0.35, 1), look: [-2.0, 0, -0.5], hands: [{ wrist: [-2.24, 0.1, -0.32], dir: [0.1, -0.5, -0.8], curl: 0.6 }, { wrist: [-1.98, 0.1, -0.26], dir: [0.3, -0.5, -0.8], curl: 0.6 }] }));
      show(KOFI, rigPose(KOFI, { ...kneel(KOFI, [-1.0, 0], -0.25, 'R'), look: [-1.1, 0, -0.9], hands: [{ wrist: [-1.12, 0.52, -0.42], curl: 0.3 }, { wrist: [-0.85, 0.2, -0.5], dir: [0, -0.6, -0.8], curl: 0.5 }] }));
      sit([0.15, 0.06], -0.3, [0.6, 1.2, -1.5]);
      show(ROBIN, rigPose(ROBIN, walk(ROBIN, [{ t: 0, x: 0.6, z: 0.6 }, { t: 2, x: 1.6, z: -0.4 }], 0.9)));
      show(JONAS, rigPose(JONAS, { ...stand(JONAS, [2.5, 0], -0.5, { stagger: 0.2 }), lean: 0.04, look: [1.9, 0.9, -0.8], hands: [{ grip: gripFrame([2.33, 0.95, -0.45], [0.9, 0, 0.45], [0.5, 0.2, -1]), radius: 0.06, wrap: 1 }, { grip: gripFrame([2.68, 0.95, -0.3], [0.9, 0, 0.45], [-0.5, 0.2, -1]), radius: 0.06, thumbAlong: -1, wrap: 1 }] }));
      look([0.15, 1.9, -6.4], [0.15, 0.7, 0], 34);
      key.target.position.set(0, 0, 0);
    } else {
      // Jonas' hands in front of him: the left open, the right in a pinch
      show(JONAS, rigPose(JONAS, { ...stand(JONAS, [0, 0], 0), look: [0, 1.0, -0.5], hands: [{ wrist: [-0.12, 1.08, -0.36], dir: [0.25, 0.3, -1], palm: [0.2, 0.9, 0.1], curl: 0.05 }, { wrist: [0.1, 1.1, -0.38], dir: [-0.3, 0.4, -1], palm: [-0.8, 0.2, -0.3], curl: 0.45, pinch: 1 }] }));
      look([0.05, 1.42, 0.25], [-0.01, 1.1, -0.42], 34);
      key.target.position.set(0, 0, 0);
    }
    key.target.updateMatrixWorld();
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
    const c = new THREE.PerspectiveCamera(20, 16 / 9, 0.02, 60);
    c.position.set(0, 1.05, 10.2);
    c.lookAt(0, 0.88, 0);
    c.updateMatrixWorld();
    v.project(c);
    view.add(<Txt x={v.x * 960} y={-v.y * 540 + 26} text={spec.name} fontFamily={FONT} fontWeight={600} fontSize={30} fill={C.text} opacity={() => (t() < 3 ? 1 : 0)} />);
  });

  yield* t(BOARDS.length, BOARDS.length, linear);
});
