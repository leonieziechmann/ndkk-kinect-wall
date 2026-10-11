// Test scene for the arm IK (people/ik.ts), the grips (body/hand.ts) and the first-person trick.
//   0-1    pose sheet A: Noor's right arm reaching all round the body (front, overhead, behind the
//          back, across the body, far out, out of reach)
//   1-2    pose sheet B: palm up / down in a fist, low at the side, the upper body helping, the
//          coiling start (left hand holding a coil, right hand pinching next to it)
//          On both sheets: a red sphere where the hand point should be; on the right arm a dot per
//          joint (shoulder, elbow, forearm, wrist): green = relaxed, orange = in the outer 15 % of its
//          range, red = at its limit. Under each figure: residual and the limits hit.
//   2-3    hands: the pinch (roll 0, rolled, open) and the coil grip at three bundle sizes, with the
//          collision capsules (colliders.ts) drawn see-through and a cable through the reached grip
//   3-4    the forearm twist: Kofi's right forearm (short sleeves) fully supinated, mid-prone and fully
//          pronated, the elbow at 90°: the twist spreads from the elbow to the wrist
//   4-...  the over-under sweep (ik-sweep.ts, solved with RigTrack): own view (only the arms, the
//          body's shadow on the floor) and outside view; an illustrative cable (not simulated)
//          through the grips the hands really reached
// Stills: node tools/render.mjs stills --project ik --scene ik --out output/ik <seconds> (src/test-ik.ts
// holds this scene and the cast sheet; both are in the test project too)

import { Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import * as THREE from 'three';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { splitPerson, splitScreen, viewLayers } from '../../lib/kit';
import { KOFI, NOOR } from '../../people/cast';
import { Person3D } from '../../people/body3d';
import { handColliders } from '../../people/colliders';
import { V3, add, madd, norm, quatCols, scale, sub } from '../../people/math';
import { ArmPose, Pose, PersonSpec } from '../../people/people';
import { DEG } from '../../people/ik';
import { HandRig, Rig, RigTrack, eyesOfRig, gripFrame, rigPose, stand } from '../../people/rig';
import { CableMesh } from '../../three/cable';
import { makeCamera, orbit, povFollow } from '../../three/camera';
import { project } from '../../three/overlay';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';
import { SWEEP_BEATS, SWEEP_PERIOD, sweepHands, sweepRig } from './ik-sweep';

const SHEET_GAP = 0.85;
const XLR = 0.0032;

interface Case {
  label: string;
  /** hands relative to the figure standing at the origin facing -z */
  hands: [HandRig | null, HandRig | null];
  reach?: number;
  lean?: number;
}

const towardsLeft: V3 = norm([-1, -0.3, -0.35]);
const SHEETS: Case[][] = [
  [
    { label: 'Pinzettengriff vorn', hands: [null, { grip: gripFrame([0.0, 0.9, -0.32], towardsLeft, [0, 0, 1]), hold: 'pinch', radius: XLR, free: 1, thumbTo: [-1, 0, 0] }] },
    { label: 'Über Kopf', hands: [null, { wrist: [0.12, 1.78, -0.12], palm: [0, 0, -1], curl: 0.2 }] },
    { label: 'Hinter dem Rücken', hands: [null, { wrist: [0.04, 0.98, 0.17], palm: [0, 0, 1], curl: 0.3 }] },
    { label: 'Quer zur linken Schulter', hands: [null, { wrist: [-0.1, 1.28, -0.16], palm: [0, 0, 1], curl: 0.3 }] },
    { label: 'Weit zur Seite', hands: [null, { wrist: [0.72, 1.32, -0.05], palm: [0, -1, 0], curl: 0.2 }] },
    { label: 'Außer Reichweite', hands: [null, { wrist: [0.3, 1.05, -0.95], palm: [0, -1, 0], curl: 0.2 }] },
  ],
  [
    { label: 'Faust, Handfläche oben', hands: [null, { grip: gripFrame([0.12, 1.0, -0.35], [1, 0, 0.1], [0, -1, 0]), radius: XLR }] },
    { label: 'Faust, Handfläche unten', hands: [null, { grip: gripFrame([0.12, 1.0, -0.35], [-1, 0, -0.1], [0, 1, 0]), radius: XLR }] },
    { label: 'Tief an der Seite', hands: [null, { wrist: [0.3, 0.62, -0.08], dir: [0, -1, -0.2], curl: 0.4 }] },
    { label: 'Weit vorn, Oberkörper hilft', reach: 1, hands: [null, { wrist: [0.15, 1.0, -0.72], palm: [0, -1, 0], curl: 0.3 }] },
    { label: 'Daumen nach oben, gestreckt', hands: [null, { wrist: [0.3, 1.05, -0.42], dir: [0, 0, -1], palm: [-1, 0, 0], curl: 0.2 }] },
    { label: 'Wickelstart', lean: 0.05, hands: [sweepHands(SWEEP_BEATS.start).left, sweepHands(SWEEP_BEATS.start).right] },
  ],
];

/** the hand close-ups: pinch variants and coil sizes, each a figure of its own */
const pinchClose: HandRig = { grip: gripFrame([0.06, 0.95, -0.33], towardsLeft, [0, 0, 1]), hold: 'pinch', radius: XLR, free: 1, thumbTo: [-1, 0, 0] };
const coilClose = (radius: number): HandRig => ({ grip: gripFrame([-0.1, 0.92, -0.3], norm([0.1, 0.4, -1]), [-1, 0.1, 0]), hold: 'coil', radius, free: 0.6 });
const fistClose = (radius: number, wrap: number): HandRig => ({ grip: gripFrame([0.1, 0.95, -0.32], norm([-1, 0.1, -0.2]), [0, 1, 0]), radius, wrap, free: 1 });
const CLOSE: { label: string; hand: HandRig; side: 0 | 1 }[] = [
  { label: 'Pinzette', side: 1, hand: pinchClose },
  { label: 'Pinzette, um 70° gerollt', side: 1, hand: { ...pinchClose, roll: 70 * DEG } },
  { label: 'Pinzette offen (Kabel gleitet)', side: 1, hand: { ...pinchClose, open: 1 } },
  { label: 'Faust, Daumen halb umgelegt', side: 1, hand: fistClose(XLR, 0.5) },
  { label: 'Bund Ø 1,6 cm', side: 0, hand: coilClose(0.008) },
  { label: 'Bund Ø 2,8 cm', side: 0, hand: coilClose(0.014) },
  { label: 'Bund Ø 4,4 cm', side: 0, hand: coilClose(0.022) },
  { label: 'Faust um Bund Ø 1,6 cm', side: 1, hand: fistClose(0.008, 1) },
];

const GREEN = new THREE.Color('#2f9a55');
const ORANGE = new THREE.Color('#e3871b');
const RED = new THREE.Color('#d0302a');

/** joint markers' colour: worst state of the joints that belong to it */
function stateOf(arm: ArmPose, names: string[]): THREE.Color {
  const r = arm.report;
  if (r.atLimit.some((l) => names.some((n) => l.startsWith(n)))) return RED;
  if (r.strained.some((l) => names.includes(l))) return ORANGE;
  return GREEN;
}

/** the German names of the limits for the labels */
const LIMIT_DE: Record<string, string> = {
  clavElev: 'Schlüsselbein', clavProt: 'Schlüsselbein', rot: 'Oberarmdrehung', elbow: 'Ellbogen', pron: 'Unterarmdrehung', shoulder: 'Schulter', wrist: 'Handgelenk',
};
function limitsText(arm: ArmPose): string {
  const hit = [...new Set(arm.report.atLimit.map((l) => LIMIT_DE[l.split(':')[0]] ?? l))];
  const st = [...new Set(arm.report.strained.map((l) => LIMIT_DE[l] ?? l))].filter((n) => !hit.includes(n));
  const parts = [];
  if (hit.length) parts.push(`Grenze: ${hit.join(', ')}`);
  if (st.length) parts.push(`knapp: ${st.join(', ')}`);
  return parts.join(' · ') || 'alles bequem';
}

/** a static cable along a smooth curve (the stripe carried along without twist) */
class Curve {
  public readonly mesh: CableMesh;
  private readonly pos: Float32Array;
  private readonly d1: Float32Array;

  public constructor(private readonly n: number, radius: number) {
    this.mesh = new CableMesh({ maxNodes: n, radius, ground: null, sub: 3 });
    this.pos = new Float32Array(3 * n);
    this.d1 = new Float32Array(3 * n);
  }

  public set(pts: V3[]) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    const x = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < this.n; i++) {
      const u = i / (this.n - 1);
      const p = curve.getPointAt(u);
      const t = curve.getTangentAt(u);
      x.addScaledVector(t, -x.dot(t));
      if (x.lengthSq() < 1e-8) x.set(1, 0, 0).addScaledVector(t, -t.x);
      x.normalize();
      this.pos.set([p.x, p.y, p.z], i * 3);
      this.d1.set([x.x, x.y, x.z], i * 3);
    }
    this.mesh.update(this.pos, this.d1, this.n);
  }
}

/** points of a cubic Bézier */
function bezier(a: V3, b: V3, c: V3, d: V3, n: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, v = 1 - u;
    out.push(add(add(scale(a, v * v * v), scale(b, 3 * v * v * u)), add(scale(c, 3 * v * u * u), scale(d, u * u * u))));
  }
  return out;
}

/** the cable through a grip frame: straight along d3 inside the hold, bending down on both sides */
function throughGrip(arm: ArmPose, before: number, after: number): V3[] {
  const g = arm.grip;
  if (!g) return [];
  const [, , d3] = quatCols(g.q);
  const down: V3 = [0, -1, 0];
  return [
    madd(madd(g.p, d3, -before), down, before * 0.6),
    madd(madd(g.p, d3, -before * 0.55), down, before * 0.12),
    madd(g.p, d3, -0.02),
    g.p,
    madd(g.p, d3, 0.02),
    madd(madd(g.p, d3, after * 0.55), down, after * 0.12),
    madd(madd(g.p, d3, after), down, after * 0.6),
  ];
}

/** loops hanging from a coil grip: each passes through the fist along d3 and hangs down */
function loopsOf(arm: ArmPose, n: number, R: number): V3[][] {
  const g = arm.grip;
  if (!g) return [];
  const [d1, d2, d3] = quatCols(g.q);
  const out: V3[][] = [];
  for (let i = 0; i < n; i++) {
    const off = madd(madd(g.p, d1, ((i % 2) - 0.5) * 0.6 * R), d2, (i / Math.max(1, n - 1) - 0.5) * 1.2 * R);
    const r = 0.15 + 0.01 * i;
    const pts: V3[] = [];
    for (let s = 0; s <= 24; s++) {
      const a = (s / 24) * Math.PI * 2;
      pts.push(madd(madd(off, d3, Math.sin(a) * r * 0.85), [0, 1, 0], -(1 - Math.cos(a)) * r * 1.05));
    }
    out.push(pts);
  }
  return out;
}

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const SWEEP_AT = 4;
  const total = SWEEP_AT + SWEEP_PERIOD;
  const t = createSignal(0);
  const board = () => (t() < 1 ? 0 : t() < 2 ? 1 : t() < 3 ? 2 : t() < 4 ? 4 : 3);

  // ---------------------------------------------------------------- the world
  const world = new World3D('test-ik', update);
  const scene = world.scene;
  const studio = new Studio(scene, { shadowMapSize: 2048 });
  // the studio's haze, pushed back for the far camera of the pose sheets
  const fog = scene.fog as THREE.Fog;
  const fogNear = fog.near;
  const fogFar = fog.far;

  /** a figure at x on the sheet (origin, facing -z, moved along x) */
  const atX = (x: number, hands: [HandRig | null, HandRig | null]): [HandRig | null, HandRig | null] =>
    hands.map((h) => (h ? { ...h, grip: h.grip ? { p: add(h.grip.p, [x, 0, 0]), q: h.grip.q } : undefined, wrist: h.wrist ? add(h.wrist, [x, 0, 0]) : undefined } : null)) as [HandRig | null, HandRig | null];
  // figure 0 on the left of the picture (the camera looks at their fronts)
  const sheetX = (i: number) => (2.5 - i) * SHEET_GAP;
  const sheetRig = (c: Case, i: number): Rig => ({ ...stand(NOOR, [sheetX(i), 0], 0, { width: 0.3 }), lean: c.lean ?? 0.03, look: [sheetX(i), 1.0, -0.5], reach: c.reach, hands: atX(sheetX(i), c.hands) });
  const closeX = (i: number) => (i - (CLOSE.length - 1) / 2) * 1.2;
  const closeRig = (i: number): Rig => {
    const c = CLOSE[i];
    const hands: [HandRig | null, HandRig | null] = c.side ? [null, c.hand] : [c.hand, null];
    return { ...stand(NOOR, [closeX(i), 4], 0, { width: 0.3 }), lean: 0.04, look: [closeX(i), 0.95, 3.6], hands: atX(closeX(i), hands).map((h) => (h ? { ...h, grip: h.grip ? { p: add(h.grip.p, [0, 0, 4]), q: h.grip.q } : undefined } : null)) as [HandRig | null, HandRig | null] };
  };

  // the people: one per figure on a sheet (reused for the close-ups), one for the sweep
  const figures: Person3D[] = [];
  for (let i = 0; i < CLOSE.length; i++) {
    const spec: PersonSpec = { ...NOOR, name: `Noor ${i}` };
    const p = new Person3D(spec, rigPose(spec, i < 6 ? sheetRig(SHEETS[0][i], i) : closeRig(i)));
    p.material.transparent = false;
    figures.push(p);
    scene.add(p.group);
  }
  // the forearm twist: three Kofis, the right forearm forward with the palm up, in, down
  const TWIST: { label: string; palm: V3 }[] = [
    { label: 'Supination (Handfläche oben)', palm: [0, 1, 0] },
    { label: 'Mittelstellung (Daumen oben)', palm: [-1, 0, 0] },
    { label: 'Pronation (Handfläche unten)', palm: [0, -1, 0] },
  ];
  const twistX = (i: number) => (1 - i) * 0.9;
  const twistRig = (i: number): Rig => ({ ...stand(KOFI, [twistX(i), -4], 0), look: [twistX(i), 1.0, -4.6], hands: [null, { wrist: [twistX(i) + 0.2, 1.06, -4.34], dir: [0, 0, -1], palm: TWIST[i].palm, elbow: [0, -1, 0.2], curl: 0.15 }] });
  const kofis = TWIST.map((_, i) => {
    const spec: PersonSpec = { ...KOFI, name: `Kofi ${i}` };
    const p = new Person3D(spec, rigPose(spec, twistRig(i)));
    scene.add(p.group);
    return p;
  });
  const twistCams = TWIST.map(() => makeCamera(26));
  for (const c of twistCams) viewLayers(c, 'ext');
  const track = new RigTrack(NOOR, sweepRig, 0, 60);
  const noor = splitPerson(NOOR, track.pose(0));
  scene.add(noor.person.group);

  // joint markers and target spheres (sheets)
  const dotGeo = new THREE.SphereGeometry(0.022, 14, 10);
  const markers = SHEETS[0].map(() => [0, 1, 2, 3].map(() => new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: GREEN, depthTest: false, transparent: true }))));
  const targets = SHEETS[0].map(() => new THREE.Mesh(new THREE.SphereGeometry(0.016, 14, 10), new THREE.MeshBasicMaterial({ color: RED })));
  for (const m of markers.flat()) {
    m.renderOrder = 10;
    scene.add(m);
  }
  for (const m of targets) scene.add(m);

  // cables: through the close-ups' grips, and the sweep's illustrative cable and loops
  const closeCables = CLOSE.map(() => new Curve(60, XLR));
  const closeLoops = CLOSE.map(() => [0, 1, 2].map(() => new Curve(70, XLR)));
  const sweepCable = new Curve(100, XLR);
  const sweepTail = new Curve(110, XLR);
  const sweepLoops = [0, 1, 2, 3].map(() => new Curve(70, XLR));
  for (const c of [...closeCables, ...closeLoops.flat(), sweepCable, sweepTail, ...sweepLoops]) scene.add(c.mesh.group);
  // collision capsules, see-through
  const capMat = new THREE.MeshStandardMaterial({ color: '#4aa3ff', transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.6 });
  const capGroup = new THREE.Group();
  scene.add(capGroup);

  const extCam = makeCamera(30);
  const sweepCam = makeCamera(30);
  const povCam = makeCamera(58);
  const closeCams = CLOSE.map(() => makeCamera(24));
  viewLayers(povCam, 'pov');
  viewLayers(extCam, 'ext');
  viewLayers(sweepCam, 'ext');
  for (const c of closeCams) viewLayers(c, 'ext');

  const poses: Pose[] = [];
  let shownBoard = -1;

  function update() {
    const b = board();
    const tt = t();
    const sheet = b <= 1;
    figures.forEach((f, i) => (f.group.visible = b === 2 || (b <= 1 && i < 6)));
    for (const f of kofis) f.group.visible = b === 4;
    noor.person.group.visible = b === 3;
    for (const m of [...markers.flat(), ...targets]) m.visible = sheet;
    for (const c of [...closeCables, ...closeLoops.flat()]) c.mesh.group.visible = b === 2;
    capGroup.visible = b === 2;
    fog.near = sheet ? fogNear + 6 : fogNear;
    fog.far = sheet ? fogFar + 8 : fogFar;
    for (const c of [sweepCable, sweepTail, ...sweepLoops]) c.mesh.group.visible = b === 3;

    if (sheet && b !== shownBoard) {
      SHEETS[b].forEach((c, i) => {
        const pose = rigPose(figures[i].spec, sheetRig(c, i));
        poses[i] = pose;
        figures[i].update(pose);
        const arm = pose.body.arms![1];
        const J = pose.joints;
        const fa = sub(J[10], J[8]);
        const out = scale(pose.F, 0.05);
        const pts: V3[] = [J[6], J[8], madd(J[8], fa, 0.5), J[10]];
        const names = [['shoulder', 'rot', 'clav'], ['elbow'], ['pron'], ['wrist']];
        pts.forEach((p, k) => {
          markers[i][k].position.set(...add(p, out));
          (markers[i][k].material as THREE.MeshBasicMaterial).color = stateOf(arm, names[k]);
        });
        const h = c.hands[1];
        const tp = h?.grip ? h.grip.p : (h?.wrist ?? [0, 0, 0]);
        targets[i].position.set(tp[0] + sheetX(i), tp[1], tp[2]);
      });
      orbit(extCam, { target: [0, 0.95, -0.1], yaw: Math.PI + 0.3, pitch: 0.14, dist: 7.6, fov: 31 });
      studio.focus([0, 0.9, 0], 3.4);
    }
    if (b === 2 && b !== shownBoard) {
      capGroup.clear();
      CLOSE.forEach((c, i) => {
        const pose = rigPose(figures[i].spec, closeRig(i));
        figures[i].update(pose);
        const arm = pose.body.arms![c.side];
        if (c.hand.hold === 'coil') {
          closeCables[i].mesh.group.visible = false;
          loopsOf(arm, 3, c.hand.radius ?? 0.012).forEach((pts, k) => closeLoops[i][k].set(pts));
        } else {
          for (const l of closeLoops[i]) l.mesh.group.visible = false;
          closeCables[i].set(throughGrip(arm, 0.22, 0.22));
        }
        for (const cap of handColliders(pose, c.side, { forearm: false })) {
          if (cap.off) continue;
          const a = new THREE.Vector3(...cap.a), bb = new THREE.Vector3(...cap.b);
          const len = a.distanceTo(bb);
          const m = new THREE.Mesh(new THREE.CapsuleGeometry(cap.r, Math.max(1e-4, len), 4, 12), capMat);
          m.position.copy(a).add(bb).multiplyScalar(0.5);
          if (len > 1e-6) m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), bb.clone().sub(a).normalize());
          capGroup.add(m);
        }
        const g = arm.grip?.p ?? pose.body.hands[c.side].wrist;
        // the pinch from above, in front and a little from the middle (as she sees it); the coil hand
        // from in front and below the midline side, into the hook of the fingers
        // the fist from in front, on its thumb side
        const eye: V3 = c.hand.hold === 'coil' ? [g[0] + 0.16, g[1] - 0.02, g[2] - 0.3] : c.hand.hold === 'pinch' ? [g[0] - 0.05, g[1] + 0.24, g[2] - 0.2] : [g[0] - 0.2, g[1] + 0.02, g[2] - 0.2];
        closeCams[i].position.set(...eye);
        closeCams[i].lookAt(g[0], g[1] - 0.01, g[2]);
      });
      studio.focus([0, 0.9, 4], 4);
    }
    if (b === 4 && b !== shownBoard) {
      kofis.forEach((f, i) => {
        const pose = rigPose(f.spec, twistRig(i));
        f.update(pose);
        const el = pose.joints[8], wr = pose.joints[10];
        const mid = madd(el, sub(wr, el), 0.85);
        twistCams[i].position.set(mid[0] + 0.42, mid[1] + 0.3, mid[2] - 0.52);
        twistCams[i].lookAt(mid[0], mid[1], mid[2]);
      });
      studio.focus([0, 1.0, -4.3], 1.6);
    }
    if (b === 3) {
      const st = tt - SWEEP_AT;
      const pose = track.pose(st);
      noor.update(pose);
      const [left, right] = pose.body.arms!;
      // the cable (illustration, not simulated): through the right pinch along d3, sagging over to
      // the coil in the left hand; behind the pinch it hangs down to the floor
      if (right.grip && left.grip) {
        const [, , d3] = quatCols(right.grip.q);
        const p = right.grip.p;
        const sag = Math.max(0.06, 0.32 - 0.3 * Math.hypot(p[0] - left.grip.p[0], p[2] - left.grip.p[2]));
        sweepCable.set(bezier(p, madd(madd(p, d3, 0.12), [0, -1, 0], sag), madd(left.grip.p, [0.1, -0.05, 0], -sag), left.grip.p, 24));
        const back = madd(p, d3, -0.015);
        // down to the floor and lying there in a curve off to the right
        sweepTail.set([madd(p, d3, 0.01), p, back, madd(back, [0, -1, 0], 0.1), [back[0], 0.3, back[2]], [back[0] + 0.02, 0.006, back[2] - 0.06], [back[0] + 0.2, 0.004, back[2] - 0.2], [back[0] + 0.45, 0.004, back[2] - 0.15]]);
        loopsOf(left, 4, 0.012).forEach((pts, k) => sweepLoops[k].set(pts));
      }
      orbit(sweepCam, { target: [0.02, 0.98, -0.2], yaw: Math.PI - 0.55, pitch: 0.12, dist: 2.6, fov: 30 });
      povFollow(povCam, (x) => eyesOfRig(NOOR, sweepRig(x)), () => [0.05, 0.84, -0.36], st, { back: 0.02, up: 0.04, fov: 54, smooth: 0.3 });
      studio.focus([0, 0.8, -0.2], 1.3);
    }
    shownBoard = b;
    scene.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- the picture
  const sheetView = (<ThreeView world={world} camera={extCam} width={1920} height={1080} opacity={() => (board() <= 1 ? 1 : 0)} />) as ThreeView;
  view.add(sheetView);
  const sheetsTitle = ['Posen A: rund um den Körper', 'Posen B: Griffe, Reichweite, Wickelstart'];
  view.add(
    <Rect x={0} y={-490} layout padding={[10, 26]} radius={40} fill={'#ffffffe0'} opacity={() => (board() <= 1 ? 1 : 0)}>
      <Txt text={() => sheetsTitle[Math.min(1, board())]} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>,
  );
  // labels under the figures: name, residual, limits
  for (let i = 0; i < 6; i++) {
    const label = () => {
      const b = Math.min(1, board());
      const c = SHEETS[b][i];
      const pose = poses[i];
      if (!pose) return c.label;
      const arm = pose.body.arms![1];
      // the orientation error of the firm goals: a grip's cable direction (a free grip's angle about
      // it and mild wishes do not count), a free hand's finger and palm directions
      const h = c.hands[1];
      const firm = h?.grip ? (h.free ? [0] : [0, 1]) : [h?.dir, h?.palm].map((g, k) => (g ? k : -1)).filter((k) => k >= 0).map((_, k) => k);
      const errs = firm.map((k) => arm.report.axisErrors[k] ?? 0);
      const ax = errs.length ? ` · ${Math.round(Math.max(...errs) / DEG)}°` : '';
      return `${c.label}\nΔ ${(arm.report.posError * 1000).toFixed(1)} mm${ax}\n${limitsText(arm)}`;
    };
    const pos = () => {
      board();
      const pr = project(sheetView, [sheetX(i), -0.05, 0.1]);
      return [pr.x, pr.y + (i % 2 ? 150 : 62)] as [number, number];
    };
    view.add(<Txt position={pos} text={label} textAlign={'center'} fontFamily={FONT} fontWeight={600} fontSize={21} lineHeight={26} fill={C.text} opacity={() => (board() <= 1 ? 1 : 0)} />);
  }

  // close-ups: 3 × 2 panels
  const closeRoot = (<Node opacity={() => (board() === 2 ? 1 : 0)} />) as Node;
  view.add(closeRoot);
  CLOSE.forEach((c, i) => {
    const col = i % 4, row = Math.floor(i / 4);
    const w = 456, h = 500;
    const x = (col - 1.5) * (w + 16), y = (row - 0.5) * (h + 24);
    closeRoot.add(<ThreeView world={world} camera={closeCams[i]} x={x} y={y} width={w} height={h} radius={20} />);
    closeRoot.add(
      <Rect x={x - w / 2 + 16} y={y - h / 2 + 16} offset={[-1, -1]} layout padding={[6, 16]} radius={30} fill={'#ffffffe0'}>
        <Txt text={c.label} fontFamily={FONT} fontWeight={700} fontSize={24} fill={C.text} />
      </Rect>,
    );
  });

  // the forearm twist: three panels
  const twistRoot = (<Node opacity={() => (board() === 4 ? 1 : 0)} />) as Node;
  view.add(twistRoot);
  TWIST.forEach((c, i) => {
    const w = 600, h = 760;
    const x = (i - 1) * (w + 24);
    twistRoot.add(<ThreeView world={world} camera={twistCams[i]} x={x} y={-40} width={w} height={h} radius={20} />);
    twistRoot.add(
      <Rect x={x - w / 2 + 16} y={-40 - h / 2 + 16} offset={[-1, -1]} layout padding={[6, 16]} radius={30} fill={'#ffffffe0'}>
        <Txt text={c.label} fontFamily={FONT} fontWeight={700} fontSize={24} fill={C.text} />
      </Rect>,
    );
    twistRoot.add(
      <Txt
        x={x}
        y={400}
        text={() => {
          board();
          const pose = rigPose(kofis[i].spec, twistRig(i));
          const a = pose.body.arms![1].angles;
          return `Unterarm ${Math.round(a.pron / DEG)}° · Handgelenk ${Math.round(a.wflex / DEG)}°/${Math.round(a.wdev / DEG)}° · Ellbogen ${Math.round(a.elbow / DEG)}°`;
        }}
        fontFamily={FONT}
        fontWeight={600}
        fontSize={24}
        fill={C.text}
      />,
    );
  });

  // the sweep: split screen
  const sweepRoot = (<Node opacity={() => (board() === 3 ? 1 : 0)} />) as Node;
  view.add(sweepRoot);
  splitScreen(sweepRoot, world, povCam, sweepCam);
  sweepRoot.add(
    <Txt
      y={460}
      text={() => {
        board();
        const pose = track.pose(Math.max(0, t() - SWEEP_AT));
        const r = pose.body.arms![1];
        return `rechter Arm: ${limitsText(r)} · Unterarm ${Math.round(r.angles.pron / DEG)}° · Kabelrichtung ±${Math.round((r.report.axisErrors[0] ?? 0) / DEG)}°`;
      }}
      fontFamily={FONT}
      fontWeight={600}
      fontSize={28}
      fill={C.text}
    />,
  );

  yield* t(total, total, linear);
});
