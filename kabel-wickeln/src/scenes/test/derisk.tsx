// Test scene: the de-risked simulated shots (src/shots: knot, eight, throw, kink) played back from
// their bakes with the rendering kit, to check them in the real renderer. Run npm run bake first.
//   0-3    knot-pull (shot time ×5): the coil on a table, knots ringed orange once pulled tight
//   3-5    eight-snap (×2.5): the loop flips into an eight, is pushed round, flips back
//   5-6.6  eight-swivel (×2.5): fix 3, the twist runs out at the hanging end
//   6.6-9  throw (×1.83): Kofi's 15 m XLR, wide
//   9-11   kink (×3.25): curl, kink, kept kink
// Stills: npm run stills -- --project test <this scene's start + the times above>

import { Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { BakedRod, loadBake } from '../../sim/bake';
import { TABLE_Y } from '../../shots/knot';
import { CableMesh, rgba } from '../../three/cable';
import { makeCamera, orbit } from '../../three/camera';
import { micStand, table } from '../../three/props';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

/** scene time → shot, shot time */
const PARTS: { id: string; from: number; to: number; speed: number }[] = [
  { id: 'knot-pull', from: 0, to: 3, speed: 5 },
  { id: 'eight-snap', from: 3, to: 5, speed: 2.5 },
  { id: 'eight-swivel', from: 5, to: 6.6, speed: 2.5 },
  { id: 'throw', from: 6.6, to: 9, speed: 1.83 },
  { id: 'kink', from: 9, to: 11, speed: 3.25 },
];

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const bakes: Record<string, BakedRod> = {};
  for (const p of PARTS) bakes[p.id] = (yield loadBake(p.id)) as BakedRod;
  const t = createSignal(0);

  const meshes: Record<string, CableMesh> = {
    'knot-pull': new CableMesh({ maxNodes: bakes['knot-pull'].n, radius: 0.0035, plugStart: 'xlr-male', plugEnd: 'xlr-female', ground: TABLE_Y }),
    'eight-snap': new CableMesh({ maxNodes: bakes['eight-snap'].n, radius: 0.0035, plugEnd: 'xlr-female' }),
    'eight-swivel': new CableMesh({ maxNodes: bakes['eight-swivel'].n, radius: 0.0035, plugEnd: 'xlr-female' }),
    throw: new CableMesh({ maxNodes: bakes.throw.n, radius: 0.012, plugStart: 'xlr-male', plugEnd: 'xlr-female' }),
    kink: new CableMesh({ maxNodes: bakes.kink.n, radius: 0.003, plugStart: 'xlr-male', plugEnd: 'xlr-female', ground: null }),
  };
  const nMax = Math.max(...Object.values(bakes).map((b) => b.n));
  const pos = new Float32Array(3 * nMax), d1 = new Float32Array(3 * nMax), halo = new Float32Array(4 * nMax);
  const orange = rgba('#b85000');
  const cam = makeCamera(30);
  const label = createSignal('');
  // the table only for the knot, the mic stand only for the throw
  const desk = table({ width: 1.4, depth: 0.9, height: TABLE_Y });
  desk.position.set(0, 0, 0.15);
  const stand = micStand();
  stand.position.set(7.4, 0, 0.3);

  const world = new World3D('test-derisk', () => {
    const tt = t();
    const part = PARTS.find((p) => tt < p.to) ?? PARTS[PARTS.length - 1];
    const st = (tt - part.from) * part.speed;
    for (const [id, m] of Object.entries(meshes)) m.group.visible = id === part.id;
    desk.visible = part.id === 'knot-pull';
    stand.visible = part.id === 'throw';
    const b = bakes[part.id], n = b.frameSample(st, pos, d1);
    let hl: Float32Array | undefined;
    if (part.id === 'knot-pull') {
      // ring the knots that are pulled tight
      halo.fill(0);
      for (const k of [1, 2]) {
        const kx = b.track(`knot${k}X`, st), ky = b.track(`knot${k}Y`, st), kz = b.track(`knot${k}Z`, st);
        if (Number.isNaN(kx)) continue;
        for (let i = 0; i < n; i++) if (Math.hypot(pos[3 * i] - kx, pos[3 * i + 1] - ky, pos[3 * i + 2] - kz) < 0.04) halo.set(orange, 4 * i);
      }
      hl = halo;
    }
    meshes[part.id].update(pos, d1, n, undefined, hl);
    label(`${part.id}  t = ${st.toFixed(2)} s`);
    if (part.id === 'knot-pull') {
      studio.focus([0, TABLE_Y, 0.2], 0.9);
      orbit(cam, { target: [0, TABLE_Y + 0.02, 0.12], yaw: 0.5, pitch: 0.75, dist: 1.3, fov: 30 });
    } else if (part.id.startsWith('eight')) {
      studio.focus([0, 0.9, 0], 0.7);
      orbit(cam, { target: [0.02, 0.98, 0], yaw: 0.35, pitch: 0.12, dist: 1.0, fov: 30 });
    } else if (part.id === 'throw') {
      studio.focus([3.5, 0.3, 0], 4);
      orbit(cam, { target: [3.4, 0.5, 0], yaw: 0.9, pitch: 0.42, dist: 8.5, fov: 32 });
    } else {
      studio.focus([0, 1.0, 0], 0.7);
      orbit(cam, { target: [0, 1.0, 0], yaw: 0.25, pitch: 0.15, dist: 0.95, fov: 30 });
    }
  });
  const studio = new Studio(world.scene);
  world.scene.add(...Object.values(meshes).map((m) => m.group), desk, stand);

  view.add(<ThreeView world={world} camera={cam} width={1920} height={1080} />);
  view.add(<Txt text={label} x={-940} y={-500} offsetX={-1} fontFamily={FONT} fontSize={34} fill={C.text} />);
  yield* t(11, 11, linear);
});
