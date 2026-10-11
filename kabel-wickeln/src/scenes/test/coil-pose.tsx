// Test scene for the coil's geometry (no simulation): Noor holding a coil of six loops in her left
// hand, seen from her eyes, from her right side, from the front at hip height (like the user's
// camera B) and from above in front (camera A). t 0-1: loops hung like rings on a rod that points
// forward and out from the hand (each new loop further along it); t 1-2: loops lying along the
// bundle in the hand (the IK test scene's illustration).
// node tools/render.mjs stills --project test --scene coil-pose --out output/p1-coil/pose 0.5 1.5

import { Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import * as THREE from 'three';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { splitPerson, viewLayers } from '../../lib/kit';
import { NOOR } from '../../people/cast';
import { V3, cross, madd, norm } from '../../people/math';
import { HandRig, Rig, eyesOfRig, gripFrame, rigPose, stand } from '../../people/rig';
import { CableMesh } from '../../three/cable';
import { lookFrom, makeCamera } from '../../three/camera';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

const R = 0.0032;
const L0: V3 = [-0.15, 0.92, -0.3];

class Curve {
  public readonly mesh: CableMesh;
  private readonly pos: Float32Array;
  private readonly d1: Float32Array;
  public constructor(private readonly n: number) {
    this.mesh = new CableMesh({ maxNodes: n, radius: R, ground: null, sub: 3 });
    this.pos = new Float32Array(3 * n);
    this.d1 = new Float32Array(3 * n);
  }
  public set(pts: V3[]) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), true, 'centripetal');
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

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const t = createSignal(0);
  const model = () => (t() < 1 ? 0 : 1);
  // the coil's axis (where new loops go: away from the body) and the strands' direction at the top
  const N = norm([-0.05, 0.1, -1]);
  const A = norm(cross(N, [0, 1, 0]));
  const hook: HandRig = { grip: gripFrame(L0, norm([-A[0], 0.7, -A[2]]), norm([-0.57, -0.82, 0.1])), hold: 'coil', radius: 0.013, free: 0.4 };
  const rod: HandRig = { grip: gripFrame(L0, norm([-A[0], 1.0, -A[2]]), norm([-0.7, -0.7, 0.1])), hold: 'coil', radius: 0.013, free: 0.4 };
  const rigOf = (h: HandRig): Rig => ({ ...stand(NOOR, [0, 0], 0, { width: 0.3 }), lean: 0.05, look: [-0.05, 0.75, -0.4], hands: [h, null] });
  const poses = [rigPose(NOOR, rigOf(hook)), rigPose(NOOR, rigOf(rod))];
  for (const p of poses) console.log('coil-pose left arm', JSON.stringify(p.body.arms![0].report), JSON.stringify(p.body.arms![0].angles));
  const rig = rigOf(hook);
  const world = new World3D('test-coil-pose', update);
  const scene = world.scene;
  new Studio(scene, { focus: [0, 0.7, -0.2], focusRadius: 1.2 });
  const noor = splitPerson(NOOR, poses[0]);
  scene.add(noor.person.group);
  const loops = [0, 1, 2, 3, 4, 5].map(() => new Curve(90));
  for (const l of loops) scene.add(l.mesh.group);

  function ringsOnRod(k: number): V3[] {
    const g = poses[0].body.arms![0].grip!;
    const top = madd(g.p, N, -0.016 + 0.0065 * k);
    const w = 0.105, h = 0.15;
    void w;
    const pts: V3[] = [];
    for (let i = 0; i < 40; i++) {
      const th = (i / 40) * Math.PI * 2;
      pts.push(madd(madd(top, A, Math.sin(th) * w), [0, 1, 0], -(1 - Math.cos(th)) * h));
    }
    return pts;
  }
  function alongBundle(k: number): V3[] {
    const g = poses[1].body.arms![0].grip!;
    const top = madd(g.p, N, -0.016 + 0.0065 * k);
    const pts: V3[] = [];
    for (let i = 0; i < 40; i++) {
      const th = (i / 40) * Math.PI * 2;
      pts.push(madd(madd(top, A, Math.sin(th) * 0.105), [0, 1, 0], -(1 - Math.cos(th)) * 0.15));
    }
    return pts;
  }

  const eyes = eyesOfRig(NOOR, rig).p;
  const cams = [makeCamera(54), makeCamera(36), makeCamera(40), makeCamera(50)];
  viewLayers(cams[0], 'pov');
  for (const c of cams.slice(1)) viewLayers(c, 'ext');
  const look: V3 = [-0.1, 0.78, -0.3];
  lookFrom(cams[0], [eyes[0], eyes[1] + 0.04, eyes[2] + 0.02], look, 54);
  lookFrom(cams[1], [0.75, 1.25, 0.25], [-0.05, 0.8, -0.25], 36);
  lookFrom(cams[2], [0.12, 1.0, -0.62], L0, 34);
  lookFrom(cams[3], [-0.5, 0.95, -0.55], L0, 34);

  function update() {
    noor.update(poses[model()]);
    loops.forEach((l, k) => l.set(model() === 0 ? ringsOnRod(k) : alongBundle(k)));
    scene.updateMatrixWorld();
  }

  const titles = ['Ich-Ansicht', 'Rechts, leicht hinten', 'Hand von vorn innen', 'Hand von außen'];
  cams.forEach((c, i) => {
    const w = 940, h = 520, x = (i % 2 - 0.5) * (w + 16), y = (Math.floor(i / 2) - 0.5) * (h + 16);
    view.add(<ThreeView world={world} camera={c} x={x} y={y} width={w} height={h} radius={16} />);
    view.add(
      <Rect x={x - w / 2 + 12} y={y - h / 2 + 12} offset={[-1, -1]} layout padding={[4, 12]} radius={20} fill={'#ffffffe0'}>
        <Txt text={() => `${titles[i]} · ${model()} · ${JSON.stringify(poses[model()].body.arms![0].report.strained)} ${JSON.stringify(poses[model()].body.arms![0].report.atLimit)} ${(poses[model()].body.arms![0].report.posError * 1000).toFixed(1)}mm ${Object.values(poses[model()].body.arms![0].angles).map((v) => Math.round((v * 180) / Math.PI)).join('/')}`} fontFamily={FONT} fontWeight={700} fontSize={18} fill={C.text} />
      </Rect>,
    );
  });
  yield* t(2, 2, linear);
});
