// Test scene: the physics tests of the "dead" XLR cable and the hand grips (src/shots/phys-tests.ts),
// all eight side by side in real time, each from its bake (run npm run bake first). The test hands
// are drawn as their collision capsules (recorded in the bakes), so what you see is exactly what
// the cable collided with. Measurements: node tools/simtest/physics.mjs.
//   0-14.5 s: every cell plays its shot from 0 (cells whose shot is over hold the last frame)
// Stills: npm run stills -- --project test --scene physics <seconds>

import { Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import * as THREE from 'three';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { BakedRod, loadBake } from '../../sim/bake';
import type { V3 } from '../../sim/vec';
import { CableMesh } from '../../three/cable';
import { Orbit, makeCamera, orbit } from '../../three/camera';
import type { PlugKind } from '../../three/plugs';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

interface Cell {
  ids: string[];
  title: string;
  cam: Orbit;
  focus: [V3, number];
  plugs: [PlugKind | null, PlugKind | null];
  /** per bake: an offset in the world (two cantilevers side by side) */
  offsets?: V3[];
}

const XLR_R = 0.0032;
const DURATION = 14.5;

const CELLS: Cell[] = [
  { ids: ['phys-drape'], title: 'Über einen Finger gehängt', cam: { target: [0.005, 0.92, 0], yaw: 0.25, pitch: 0.1, dist: 0.55, fov: 30 }, focus: [[0, 0.9, 0], 0.3], plugs: ['xlr-male', null] },
  { ids: ['phys-cant-old', 'phys-cant-new'], title: '30 cm frei: alt (hinten) – neu (vorn)', cam: { target: [0.17, 0.88, 0.03], yaw: 0.55, pitch: 0.18, dist: 0.85, fov: 30 }, focus: [[0.15, 0.9, 0], 0.4], plugs: [null, null], offsets: [[0, 0, -0.08], [0, 0, 0.12]] },
  { ids: ['phys-u'], title: 'U zwischen zwei Händen', cam: { target: [0, 0.8, 0.08], yaw: 0.55, pitch: 0.12, dist: 1.5, fov: 32 }, focus: [[0, 0.7, 0], 0.8], plugs: [null, null] },
  { ids: ['phys-grab'], title: 'Aufheben, 50 cm bewegen, anhalten', cam: { target: [0.15, 0.35, 0.05], yaw: 0.3, pitch: 0.22, dist: 2.2, fov: 34 }, focus: [[0.1, 0.3, 0], 1.3], plugs: ['xlr-male', 'xlr-female'] },
  { ids: ['phys-lay'], title: 'Im Bogen ablegen, loslassen', cam: { target: [0.45, 0, -0.1], yaw: 0.15, pitch: 1.0, dist: 1.5, fov: 34 }, focus: [[0.2, 0, -0.1], 0.9], plugs: ['xlr-male', 'xlr-female'] },
  { ids: ['phys-coil'], title: 'Durchgleiten, halten, ins Bündel legen', cam: { target: [0.3, 0.74, 0], yaw: 0.3, pitch: 0.12, dist: 1.85, fov: 34 }, focus: [[0.25, 0.6, 0], 1.0], plugs: ['xlr-male', 'xlr-female'] },
  { ids: ['phys-roll'], title: 'Mit Daumen rollen, dann Hand drehen', cam: { target: [0.0, 0.88, 0], yaw: 3.6, pitch: 0.12, dist: 0.5, fov: 30 }, focus: [[0.1, 0.5, 0], 0.7], plugs: [null, 'xlr-female'] },
];

const SKIN = new THREE.MeshStandardMaterial({ color: '#d6a283', roughness: 0.65 });
const UP = new THREE.Vector3(0, 1, 0);

/** capsules drawn as cylinder + two spheres, from a capsule vector (7 numbers each) */
class Capsules {
  readonly group = new THREE.Group();
  private readonly parts: { cyl: THREE.Mesh; a: THREE.Mesh; b: THREE.Mesh }[] = [];
  private readonly va = new THREE.Vector3();
  private readonly vb = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(count: number) {
    const cg = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true), sg = new THREE.SphereGeometry(1, 16, 12);
    for (let k = 0; k < count; k++) {
      const p = { cyl: new THREE.Mesh(cg, SKIN), a: new THREE.Mesh(sg, SKIN), b: new THREE.Mesh(sg, SKIN) };
      for (const m of [p.cyl, p.a, p.b]) {
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
      }
      this.parts.push(p);
    }
  }

  update(v: ArrayLike<number>) {
    this.parts.forEach((p, k) => {
      const o = 7 * k, r = v[o + 6];
      const on = r > 0;
      p.cyl.visible = p.a.visible = p.b.visible = on;
      if (!on) return;
      this.va.set(v[o], v[o + 1], v[o + 2]);
      this.vb.set(v[o + 3], v[o + 4], v[o + 5]);
      p.a.position.copy(this.va);
      p.b.position.copy(this.vb);
      p.a.scale.setScalar(r);
      p.b.scale.setScalar(r);
      const len = this.va.distanceTo(this.vb);
      p.cyl.position.copy(this.va).add(this.vb).multiplyScalar(0.5);
      p.cyl.scale.set(r, Math.max(len, 1e-6), r);
      if (len > 1e-9) p.cyl.quaternion.setFromUnitVectors(UP, this.dir.copy(this.vb).sub(this.va).divideScalar(len));
    });
  }
}

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const t = createSignal(0);
  const W = 480, H = 540;
  const cells = [];
  for (const [ci, cell] of CELLS.entries()) {
    const bakes: BakedRod[] = [];
    for (const id of cell.ids) bakes.push((yield loadBake(id)) as BakedRod);
    const meshes = bakes.map((b) => new CableMesh({ maxNodes: b.n, radius: XLR_R, plugStart: cell.plugs[0], plugEnd: cell.plugs[1], ground: 0 }));
    const caps = bakes.map((b) => (b.vectorNames.includes('caps') ? new Capsules(b.vectorInfo.find((v) => v.name === 'caps')!.size / 7) : null));
    const nMax = Math.max(...bakes.map((b) => b.n));
    const pos = new Float32Array(3 * nMax), d1 = new Float32Array(3 * nMax);
    const capV = new Float32Array(7 * 16);
    const cam = makeCamera(cell.cam.fov ?? 32);
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    const holders = bakes.map((_, k) => {
      const g = new THREE.Group();
      const off = cell.offsets?.[k];
      if (off) g.position.set(off[0], off[1], off[2]);
      g.add(meshes[k].group);
      const c = caps[k];
      if (c) g.add(c.group);
      return g;
    });
    const world = new World3D(`test-physics-${ci}`, () => {
      const tt = t();
      bakes.forEach((b, k) => {
        b.frameSample(tt, pos, d1);
        // the tube over the cable proper, the plugs on the rigid end pieces beyond it
        const i0 = b.trackNames.includes('cable0') ? Math.round(b.track('cable0', 0)) : 0;
        const i1 = b.trackNames.includes('cable1') ? Math.round(b.track('cable1', 0)) : b.n - 1;
        meshes[k].update(pos.subarray(3 * i0), d1.subarray(3 * i0), i1 - i0 + 1);
        const c = caps[k];
        if (c) c.update(b.vector('caps', tt, capV));
      });
      orbit(cam, cell.cam);
      cam.aspect = W / H;
      cam.updateProjectionMatrix();
    });
    const studio = new Studio(world.scene, { focus: cell.focus[0], focusRadius: cell.focus[1] });
    void studio;
    world.scene.add(...holders);
    cells.push({ world, cam, cell });
  }

  const x0 = -960 + W / 2, y0 = -540 + H / 2;
  cells.forEach(({ world, cam, cell }, i) => {
    const x = x0 + (i % 4) * W, y = y0 + Math.floor(i / 4) * H;
    view.add(<ThreeView world={world} camera={cam} width={W} height={H} x={x} y={y} />);
    view.add(
      <Rect x={x} y={y - H / 2 + 26} width={W - 16} height={40} fill={C.plate} radius={8}>
        <Txt text={cell.title} fontFamily={FONT} fontSize={22} fontWeight={600} fill={C.text} />
      </Rect>,
    );
  });
  // the eighth cell: what is shown
  const lx = x0 + 3 * W, ly = y0 + H;
  view.add(
    <Rect x={lx} y={ly} width={W - 24} height={H - 24} fill={C.paper} radius={12} layout direction="column" padding={28} gap={14}>
      <Txt text="Kabelphysik: Testbilder" fontFamily={FONT} fontSize={30} fontWeight={700} fill={C.text} />
      <Txt text="XLR, Sommer SC-Stage 22 Highflex" fontFamily={FONT} fontSize={22} fill={C.muted} />
      <Txt text="Ø 6,4 mm · 42 g/m · Stecker 20 g" fontFamily={FONT} fontSize={22} fill={C.muted} />
      <Txt text="Hände = Kollisionskapseln" fontFamily={FONT} fontSize={22} fill={C.muted} />
      <Txt text="Echtzeit" fontFamily={FONT} fontSize={22} fill={C.muted} />
      <Txt text={() => `t = ${t().toFixed(2)} s`} fontFamily={FONT} fontSize={34} fontWeight={700} fill={C.text} marginTop={20} />
    </Rect>,
  );
  yield* t(DURATION, DURATION, linear);
});
