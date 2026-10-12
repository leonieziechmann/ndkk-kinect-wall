// Test scene for the retargeting (src/mocap): recorded takes on our people, side by side.
//   0–10 s   the synthetic coiling (mocap/synthetic: Noor from the front, setup A), three times on Noor:
//            (a) the ground truth, (b) the take auswerten.py made of the synthetic recording with the
//            true 2D points + 2.5 px noise (a stand-in for the strong models: body, feet, hands),
//            (c) the light model (YOLO11s: body only, no hands, no feet). Placed at the recording's own
//            place (scene x shifted per column). Orange dots: the recorded joints, placed but not scaled;
//            the grey cable is the truth's (where the cable really was); both hands hold it from 1 s
//            after the clap (holds: coil left, pinch right). Below: the hands close up. The numbers: how
//            far the figure's wrists are from the true ones.
//   10–17 s  the throw from the side (setup D): (a) the truth on Kofi (the recorded person), (b) the
//            truth on Noor (15 cm shorter: other proportions), (c) the light model on Kofi.
//   17–24 s  the coiling again, placed by its anchor (pos/yaw, not the recording's place): (a) on Noor,
//            (b) mirrored (a left-handed variant: the holds swap hands), (c) on Kofi (1.80 m): the
//            hands still meet at the coil.
// The takes are git-ignored synthetic data (mocap-retarget.md: how to make them):
//   output/synthetic/<name>.truth.json.gz, <name>.take-gt2d.json.gz, <name>.take-leicht.json.gz
// Stills: node tools/render.mjs stills --project mocap --scene mocap <seconds>

import { Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import * as THREE from 'three';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { KOFI, NOOR } from '../../people/cast';
import { Person3D } from '../../people/body3d';
import { V3 } from '../../people/math';
import { PersonSpec, Pose } from '../../people/people';
import { RigTrack } from '../../people/rig';
import { HoldSpec, Mocap, Placement } from '../../mocap/retarget';
import { Take, loadTake } from '../../mocap/take';
import { TAKE_JOINTS, takeJointsOf } from '../../mocap/joints';
import { CableMesh } from '../../three/cable';
import { makeCamera, orbit } from '../../three/camera';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

const SYN = '/output/synthetic';
/** the coiling runs from 0 to here, then the throw, then the coiling mirrored and on Kofi */
const THROW_AT = 10;
const MIRROR_AT = 17;
const TOTAL = 24;
/** world x of the three columns (far enough apart that a column's camera sees only its own figure) */
const X = [-3, 0, 3];
const XLR = 0.0032;
const NOOR_PLAIN: PersonSpec = { ...NOOR, gloves: 'none', pushed: true };

/** the coiling's holds (take time after the clap): the coil in the left hand, the cable pinched in the right */
const COIL_HOLDS: HoldSpec[] = [
  { side: 'left', from: 1.0, to: 8.2, hold: 'coil', radius: 0.012 },
  { side: 'right', from: 1.0, to: 8.2, hold: 'pinch', radius: XLR },
];

/** a static cable along a smooth curve (as in ik.tsx) */
class Curve {
  public readonly mesh: CableMesh;
  private readonly pos: Float32Array;
  private readonly d1: Float32Array;

  public constructor(private readonly n: number, radius: number) {
    this.mesh = new CableMesh({ maxNodes: n, radius, ground: 0, sub: 2, jacket: '#3a3d42', stripe: null });
    this.pos = new Float32Array(3 * n);
    this.d1 = new Float32Array(3 * n);
  }

  public set(pts: V3[]) {
    if (pts.length < 2) {
      this.mesh.group.visible = false;
      return;
    }
    this.mesh.group.visible = true;
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

/** the inverse of a row-major rigid 4 × 4 (mm), shifted by dx m along x afterwards */
function invRigid(M: number[], dx: number): number[] {
  const R = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
  const t = [M[3], M[7], M[11]];
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const ti = [0, 1, 2].map((r) => -(Rt[3 * r] * t[0] + Rt[3 * r + 1] * t[1] + Rt[3 * r + 2] * t[2]));
  return [Rt[0], Rt[1], Rt[2], ti[0] + dx * 1000, Rt[3], Rt[4], Rt[5], ti[1], Rt[6], Rt[7], Rt[8], ti[2], 0, 0, 0, 1];
}

interface Column {
  title: string;
  mc: Mocap;
  track: RigTrack;
  person: Person3D;
  /** the truth placed into this column (for the numbers), or null */
  truth: Mocap | null;
}

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const url = (n: string) => `${SYN}/${n}`;
  const files = ['synth-coil.truth.json.gz', 'synth-coil.take-gt2d.json.gz', 'synth-coil.take-leicht.json.gz', 'synth-throw.truth.json.gz', 'synth-throw.take-leicht.json.gz'];
  const takes: Record<string, Take> = {};
  for (const f of files) takes[f] = (yield loadTake(url(f))) as Take;
  const t = createSignal(0);
  const part = () => (t() < THROW_AT ? 0 : t() < MIRROR_AT ? 1 : 2);

  // ---------------------------------------------------------------- the takes on the figures
  const coilTruth = takes['synth-coil.truth.json.gz'];
  const M = coilTruth.doc.truth!.rig_to_world as number[];
  /** the coiling at the recording's own place: scene time = recording time */
  const coilAt = (take: Take, i: number, spec: PersonSpec) =>
    new Mocap(take, spec, { matrix: invRigid(M, X[i]), from: take.t0 - take.zero, to: take.t1 - take.zero, at: take.t0 }, { holds: COIL_HOLDS });
  const coil: Column[] = [
    ['Wahrheit (synthetisch)', 'synth-coil.truth.json.gz'],
    ['Auswertung: wahre 2D-Punkte + 2,5 px Rauschen', 'synth-coil.take-gt2d.json.gz'],
    ['Auswertung: leichtes Modell (ohne Hände)', 'synth-coil.take-leicht.json.gz'],
  ].map(([title, f], i) => {
    const mc = coilAt(takes[f], i, NOOR_PLAIN);
    const track = mc.track();
    return { title, mc, track, person: new Person3D(NOOR_PLAIN, track.pose(0)), truth: i ? coilAt(coilTruth, i, NOOR_PLAIN) : mc };
  });
  const throwTruth = takes['synth-throw.truth.json.gz'];
  // scene time THROW_AT + recording time; placed at the column, facing −z at the clap
  const throwPl = (take: Take, i: number): Placement => ({ pos: [X[i], 0], yaw: 0, anchor: 0, from: -1, to: 5.9, at: THROW_AT + take.zero - 1 });
  const throwCols: Column[] = [
    ['Wahrheit auf Kofi (die aufgenommene Person)', throwTruth, KOFI],
    ['Wahrheit auf Noor (15 cm kleiner)', throwTruth, NOOR],
    ['Auswertung leicht (Seitenansicht) auf Kofi', takes['synth-throw.take-leicht.json.gz'], KOFI],
  ].map(([title, take, spec], i) => {
    const mc = new Mocap(take as Take, spec as PersonSpec, throwPl(take as Take, i));
    const track = mc.track();
    return { title: title as string, mc, track, person: new Person3D(spec as PersonSpec, track.pose(THROW_AT)), truth: null as Mocap | null };
  });

  // the coiling by its anchor (facing −z at the column), from just before the grip: scene MIRROR_AT = 1.2 s after the clap
  const mirrorCols: Column[] = [
    ['Noor', false, NOOR_PLAIN],
    ['Noor gespiegelt (Linkshänderin)', true, NOOR_PLAIN],
    ['Kofi (1,80 m)', false, KOFI],
  ].map(([title, mirror, spec], i) => {
    const mc = new Mocap(coilTruth, spec as PersonSpec, { pos: [X[i], 0], yaw: 0, anchor: 1.2, from: 1.2, to: 8.2, at: MIRROR_AT, mirror: mirror as boolean }, { holds: COIL_HOLDS });
    const track = mc.track();
    return { title: title as string, mc, track, person: new Person3D(spec as PersonSpec, track.pose(MIRROR_AT)), truth: null as Mocap | null };
  });

  // ---------------------------------------------------------------- the world
  const world = new World3D('test-mocap', update);
  const scene = world.scene;
  const studio = new Studio(scene, { shadowMapSize: 2048 });
  studio.focus([0, 0.9, -0.2], 4.6);
  for (const c of [...coil, ...throwCols, ...mirrorCols]) scene.add(c.person.group);

  // the recorded joints as dots (placed, not scaled)
  const dotGeo = new THREE.SphereGeometry(1, 10, 8);
  const dotMat = new THREE.MeshBasicMaterial({ color: '#e07a1f' });
  const dots = [0, 1, 2].map(() => {
    const m = new THREE.InstancedMesh(dotGeo, dotMat, TAKE_JOINTS.length);
    m.frustumCulled = false;
    scene.add(m);
    return m;
  });
  const dm = new THREE.Matrix4();
  const putDots = (mesh: THREE.InstancedMesh, mc: Mocap, tt: number) => {
    const rec = mc.recorded(tt);
    rec.p.forEach((p, j) => {
      const hand = j >= 23 && j < 65;
      const r = rec.c[j] > 0.05 ? (hand ? 0.0045 : 0.011) : 0;
      dm.makeScale(r, r, r).setPosition(p[0], p[1], p[2]);
      mesh.setMatrixAt(j, dm);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  // the truth's cable, in every coil column
  const cables = [0, 1, 2].map(() => {
    const c = new Curve(420, XLR);
    scene.add(c.mesh.group);
    return c;
  });

  const bodyCams = [0, 1, 2].map(() => makeCamera(30));
  const handCams = [0, 1, 2].map(() => makeCamera(30));
  const poses: (Pose | null)[] = [null, null, null];

  function update() {
    const tt = t();
    const p = part();
    for (const c of coil) c.person.group.visible = p === 0;
    for (const c of throwCols) c.person.group.visible = p === 1;
    for (const c of mirrorCols) c.person.group.visible = p === 2;
    for (const d of dots) d.visible = true;
    const cols = [coil, throwCols, mirrorCols][p];
    cols.forEach((c, i) => {
      const pose = c.track.pose(tt);
      poses[i] = pose;
      c.person.update(pose);
      putDots(dots[i], c.mc, tt);
      if (p === 0) {
        const lines = coilTruth.cableAt(c.truth!.tauOf(tt) + coilTruth.zero) ?? [];
        cables[i].set(lines.length ? lines[0].pts.map(c.truth!.toScene) : []);
        orbit(bodyCams[i], { target: [X[i], 0.92, -0.1], yaw: Math.PI - 0.42, pitch: 0.12, dist: 3.0, fov: 30 });
        orbit(handCams[i], { target: [X[i] + 0.02, 0.87, -0.3], yaw: Math.PI - 0.3, pitch: 0.38, dist: 0.8, fov: 30 });
      } else if (p === 1) {
        cables[i].set([]);
        orbit(bodyCams[i], { target: [X[i], 0.95, -0.25], yaw: Math.PI - 0.95, pitch: 0.1, dist: 3.6, fov: 30 });
      } else {
        // the truth's cable where the figure's anchor puts the recording (mirrored with it)
        const lines = coilTruth.cableAt(c.mc.tauOf(tt) + coilTruth.zero) ?? [];
        cables[i].set(lines.length ? lines[0].pts.map((q) => c.mc.toScene(c.mc.take.mirrored ? [-q[0], q[1], q[2]] : q)) : []);
        orbit(bodyCams[i], { target: [X[i], 0.92, -0.1], yaw: Math.PI - 0.42, pitch: 0.12, dist: 3.0, fov: 30 });
        orbit(handCams[i], { target: [X[i] + 0.02, 0.87, -0.3], yaw: Math.PI - 0.3, pitch: 0.38, dist: 0.8, fov: 30 });
      }
    });
    scene.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- the picture
  const W = 616;
  const colX = (i: number) => (i - 1) * (W + 16);
  const top = -540 + 70;
  const bodyH = () => (part() === 1 ? 860 : 560);
  for (let i = 0; i < 3; i++) {
    view.add(<ThreeView world={world} camera={bodyCams[i]} x={colX(i)} y={() => top + bodyH() / 2} width={W} height={bodyH} radius={18} />);
    view.add(<ThreeView world={world} camera={handCams[i]} x={colX(i)} y={top + 560 + 16 + 170} width={W} height={340} radius={18} opacity={() => (part() === 1 ? 0 : 1)} />);
    view.add(
      <Rect x={colX(i) - W / 2 + 12} y={top + 12} offset={[-1, -1]} layout padding={[6, 14]} radius={24} fill={C.plate}>
        <Txt text={() => [coil, throwCols, mirrorCols][part()][i].title} fontFamily={FONT} fontWeight={700} fontSize={21} fill={C.text} />
      </Rect>,
    );
    // the numbers under each column
    view.add(
      <Txt
        x={colX(i)}
        y={490}
        textAlign={'center'}
        fontFamily={FONT}
        fontWeight={600}
        fontSize={18}
        lineHeight={23}
        fill={C.text}
        text={() => {
          const tt = t();
          const pose = poses[i];
          const col = [coil, throwCols, mirrorCols][part()][i];
          const q = col.mc.quality;
          if (!pose) return '';
          const lines: string[] = [];
          if (part() === 0 && col.truth) {
            const J = takeJointsOf(pose);
            const tr = col.truth.recorded(tt).p;
            const d = (j: number) => Math.round(Math.hypot(J[j][0] - tr[j][0], J[j][1] - tr[j][1], J[j][2] - tr[j][2]) * 1000);
            lines.push(`Handgelenke zur Wahrheit: links ${d(9)} mm, rechts ${d(10)} mm`);
          } else {
            lines.push(`Arme ×${q.scale.arm.toFixed(2)}, Beine ×${q.scale.leg.toFixed(2)}, Becken ×${q.scale.height.toFixed(2)}`);
          }
          const holding = [0, 1].map((s) => col.mc.holding(tt, s as 0 | 1)).map((h, s) => (h ? `${s ? 'rechts' : 'links'} (${{ pinch: 'Zange', fist: 'Faust', coil: 'Bund' }[h.hold]})` : '')).filter(Boolean);
          lines.push(`Handdrehung aus der Aufnahme: links ${Math.round(q.handData[0] * 100)} %, rechts ${Math.round(q.handData[1] * 100)} %`);
          lines.push(holding.length ? `hält: ${holding.join(', ')}` : 'Hände frei');
          return lines.join('\n');
        }}
      />,
    );
  }
  view.add(
    <Node>
      <Txt
        x={-940}
        y={-510}
        offsetX={-1}
        fontFamily={FONT}
        fontWeight={700}
        fontSize={26}
        fill={C.text}
        text={() => ['Retargeting: Wickeln (synthetisch, Aufbau A von vorn)', 'Retargeting: Wurf von der Seite (Aufbau D)', 'Retargeting: gespiegelt und andere Maße'][part()]}
      />
      <Txt
        x={940}
        y={-510}
        offsetX={1}
        fontFamily={FONT}
        fontWeight={500}
        fontSize={22}
        fill={C.muted}
        text={() => `t = ${(t() - [0, THROW_AT, MIRROR_AT][part()]).toFixed(2)} s · orange: aufgenommene Gelenke (unskaliert)`}
      />
    </Node>,
  );

  yield* t(TOTAL, TOTAL, linear);
});
