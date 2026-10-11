// Test scene for the coil's geometry and the left hand's grip (no simulation): Noor holding a coil
// of six round loops in her left fist, the right hand pinching the cable at the fist's medial end
// (the hand-over). Four variants of the left grip, one per second of scene time (t 0-1, 1-2, ...),
// each seen from her eyes, from the front at hip height (the user's camera B), from above in front
// (camera A) and from her right front (the outside camera).
// node tools/render.mjs stills --project coil --scene coil-pose --out output/p1-coil/pose 0.5 1.5 2.5 3.5

import { Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import * as THREE from 'three';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { splitPerson, viewLayers } from '../../lib/kit';
import { NOOR } from '../../people/cast';
import { V3, cross, madd, norm } from '../../people/math';
import { HandRig, Rig, eyesOfRig, gripFrame, rigPose } from '../../people/rig';
import { coilStance } from '../../shots/coil-engine';
import { CableMesh } from '../../three/cable';
import { lookFrom, makeCamera } from '../../three/camera';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

const R = 0.0032;
const D = Math.PI / 180;

class Curve {
  public readonly mesh: CableMesh;
  private readonly pos: Float32Array;
  private readonly d1: Float32Array;
  public constructor(private readonly n: number) {
    this.mesh = new CableMesh({ maxNodes: n, radius: R, ground: null, sub: 3 });
    this.pos = new Float32Array(3 * n);
    this.d1 = new Float32Array(3 * n);
  }
  public set(pts: V3[], closed = true) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), closed, 'centripetal');
    const x = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < this.n; i++) {
      const u = i / (this.n - 1);
      const p = curve.getPointAt(u), t = curve.getTangentAt(u);
      x.addScaledVector(t, -x.dot(t));
      if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
      x.normalize();
      this.pos.set([p.x, p.y, p.z], 3 * i);
      this.d1.set([x.x, x.y, x.z], 3 * i);
    }
    this.mesh.update(this.pos, this.d1, this.n);
  }
}

interface Variant {
  name: string;
  /** the coil's axis turned this far from forward towards her right */
  nAngle: number;
  /** the strands' lateral end this much higher */
  sUp: number;
  /** from the strands to the palm, in (N, up, A) of the coil */
  palm: [number, number, number];
  thumb: 1 | -1;
  at: V3;
  r: number;
}

const VARIANTS: Variant[] = [
  { name: 'Haken: Handfläche unten/hinten, R 16', nAngle: 45, sUp: 12, palm: [-0.4, -0.9, 0], thumb: 1, at: [-0.15, 0.9, -0.27], r: 0.016 },
  { name: 'Haken: Handfläche unten/hinten, R 11', nAngle: 45, sUp: 12, palm: [-0.4, -0.9, 0], thumb: 1, at: [-0.15, 0.9, -0.27], r: 0.011 },
  { name: 'Handfläche hinten, R 11', nAngle: 45, sUp: 12, palm: [-0.9, -0.2, 0], thumb: 1, at: [-0.15, 0.9, -0.27], r: 0.011 },
  { name: 'Handfläche hinten oben, R 12', nAngle: 45, sUp: 12, palm: [-0.7, 0.5, 0], thumb: 1, at: [-0.15, 0.9, -0.27], r: 0.012 },
];

function geom(v: Variant) {
  const N = norm([Math.sin(v.nAngle * D), 0, -Math.cos(v.nAngle * D)]);
  const A = norm([N[2], 0, -N[0]]);
  const S = norm([A[0], Math.tan(v.sUp * D), A[2]]);
  return { N, A, S };
}

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const t = createSignal(0);
  const vi = () => Math.min(VARIANTS.length - 1, Math.floor(t()));

  const poses = VARIANTS.map((v) => {
    const { N, A, S } = geom(v);
    const toPalm = norm([N[0] * v.palm[0] + A[0] * v.palm[2], v.palm[1], N[2] * v.palm[0] + A[2] * v.palm[2]]);
    const left: HandRig = { grip: gripFrame(v.at, S, toPalm), hold: 'coil', radius: v.r, thumbAlong: v.thumb, open: 0, free: 0.3 };
    // the right pads at the fist's medial end + 3.5 cm, the cable past the thumb tip running into the fist
    const pads = madd(v.at, S, -0.045 - 0.035);
    const right: HandRig = { grip: gripFrame(pads, S, [0, 0, 1]), hold: 'pinch', radius: R, cross: 0.3, free: 1, thumbTo: S, thumbWeight: 0.2 };
    const rig: Rig = { ...coilStance(NOOR), look: [-0.05, 0.75, -0.4], hands: [left, right] };
    const pose = rigPose(NOOR, rig);
    console.log('coil-pose', v.name, JSON.stringify(pose.body.arms!.map((a) => ({ strained: a.report.strained, atLimit: a.report.atLimit, err: +(a.report.posError * 1000).toFixed(1), ang: Object.values(a.angles).map((x) => Math.round(x / D)) }))));
    return { pose, rig, N, A, S };
  });

  const world = new World3D('test-coil-pose', update);
  const scene = world.scene;
  new Studio(scene, { focus: [0, 0.7, -0.2], focusRadius: 1.2 });
  const noor = splitPerson(NOOR, poses[0].pose);
  scene.add(noor.person.group);
  const loops = [0, 1, 2, 3, 4, 5].map(() => new Curve(110));
  for (const l of loops) scene.add(l.mesh.group);

  /** loop k: a round loop hanging below the fist in the plane of S and up, 7 mm further along N per loop */
  function loop(k: number): V3[] {
    const P = poses[vi()];
    const g = P.pose.body.arms![0].grip!;
    const top = madd(g.p, P.N, -0.012 + 0.005 * k);
    const h = cross(P.N, [0, 1, 0]);
    const across = norm([h[0], 0, h[2]]);
    const r = 0.105;
    const pts: V3[] = [];
    for (let i = 0; i < 48; i++) {
      const th = (i / 48) * Math.PI * 2;
      pts.push(madd(madd(top, across, Math.sin(th) * r * 0.95), [0, 1, 0], -(1 - Math.cos(th)) * r));
    }
    return pts;
  }

  const cams = [makeCamera(54), makeCamera(36), makeCamera(40), makeCamera(36)];
  viewLayers(cams[0], 'pov');
  for (const c of cams.slice(1)) viewLayers(c, 'ext');

  function update() {
    const P = poses[vi()];
    noor.update(P.pose);
    loops.forEach((l, k) => l.set(loop(k)));
    const eyes = eyesOfRig(NOOR, P.rig).p;
    const L = P.pose.body.arms![0].grip!.p;
    lookFrom(cams[0], [eyes[0], eyes[1] + 0.04, eyes[2] + 0.02], [L[0] + 0.12, L[1] - 0.15, L[2] - 0.05], 56);
    lookFrom(cams[1], [L[0] + 0.05, L[1] + 0.05, L[2] - 0.75], [L[0] + 0.03, L[1] - 0.06, L[2]], 30);
    lookFrom(cams[2], [L[0] + 0.05, L[1] + 0.55, L[2] - 0.45], [L[0] + 0.03, L[1] - 0.03, L[2]], 34);
    lookFrom(cams[3], [L[0] + 0.55, L[1] + 0.2, L[2] - 0.55], [L[0] + 0.0, L[1] - 0.06, L[2]], 32);
    scene.updateMatrixWorld();
  }

  const titles = ['Ich-Ansicht', 'Vorn, Hüfthöhe (B)', 'Oben vorn (A)', 'Rechts vorn'];
  cams.forEach((c, i) => {
    const w = 940, h = 500, x = (i % 2 - 0.5) * (w + 16), y = (Math.floor(i / 2) - 0.5) * (h + 16) + 20;
    view.add(<ThreeView world={world} camera={c} x={x} y={y} width={w} height={h} radius={16} />);
    view.add(
      <Rect x={x - w / 2 + 12} y={y - h / 2 + 12} offset={[-1, -1]} layout padding={[4, 12]} radius={20} fill={'#ffffffe0'}>
        <Txt text={titles[i]} fontFamily={FONT} fontWeight={700} fontSize={20} fill={C.text} />
      </Rect>,
    );
  });
  view.add(<Txt y={-520} text={() => `${vi() + 1}: ${VARIANTS[vi()].name} · L ${poses[vi()].pose.body.arms![0].report.strained.join(',') || 'ok'} ${poses[vi()].pose.body.arms![0].report.atLimit.join(',')} · R ${poses[vi()].pose.body.arms![1].report.strained.join(',') || 'ok'}`} fontFamily={FONT} fontWeight={700} fontSize={22} fill={C.text} />);
  yield* t(VARIANTS.length, VARIANTS.length, linear);
});
