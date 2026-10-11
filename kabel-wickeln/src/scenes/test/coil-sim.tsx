// Test scene for a coiling bake (coil-dev or s1-coil): Noor's recorded arms (CoilReplay) and the
// simulated cable, seen from her eyes (arms only, the body's shadow), from her right front, from
// the front at hip height (like the user's camera B), from above in front (camera A), plus a close
// view of the hands. The bake's id is the scene's first line.
// node tools/render.mjs stills --project coil --scene coil-sim --out output/p1-coil/sim <seconds>

import { Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import { splitPerson, viewLayers } from '../../lib/kit';
import { NOOR } from '../../people/cast';
import { eyesOfRig } from '../../people/rig';
import { BakedRod, V3, loadBake } from '../../sim';
import { CoilReplay } from '../../shots/coil-engine';
import { CableMesh } from '../../three/cable';
import { lookFrom, makeCamera } from '../../three/camera';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

const BAKE = 'coil-dev';

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const bake = (yield loadBake(BAKE)) as BakedRod;
  const replay = new CoilReplay(bake, NOOR);
  const t = createSignal(0);
  const n = bake.n;
  const pos = new Float32Array(3 * n), d1 = new Float32Array(3 * n);
  const world = new World3D('test-coil-sim', update);
  const scene = world.scene;
  new Studio(scene, { focus: [0, 0.6, -0.3], focusRadius: 1.4 });
  const cable = new CableMesh({ maxNodes: n, radius: bake.radius, plugStart: 'xlr-male', plugEnd: 'xlr-female', haloPx: 0 });
  scene.add(cable.group);
  const noor = splitPerson(NOOR, replay.pose(0));
  scene.add(noor.person.group);

  const cams = [makeCamera(54), makeCamera(36), makeCamera(36), makeCamera(44), makeCamera(30)];
  viewLayers(cams[0], 'pov');
  for (const c of cams.slice(1)) viewLayers(c, 'ext');
  const titles = ['Ich-Ansicht', 'Rechts vorn', 'Vorn, Hüfthöhe (B)', 'Rechte Hand', 'Linke Hand'];

  function update() {
    const tt = t();
    const a = replay.at(tt);
    const pose = replay.pose(tt);
    noor.update(pose);
    bake.frameSample(tt, pos, d1);
    cable.update(pos, d1, n);
    const e = eyesOfRig(NOOR, a.rig).p;
    const lh = bake.frame('gripL', tt).p;
    lookFrom(cams[0], [e[0], e[1] + 0.04, e[2] + 0.02], [lh[0] + 0.12, lh[1] - 0.15, lh[2] - 0.05], 56);
    lookFrom(cams[1], [0.95, 1.3, -1.05], [0.0, 0.72, -0.25], 36);
    lookFrom(cams[2], [0.0, 0.8, -1.7], [-0.02, 0.72, -0.2], 38);
    const rh = bake.frame('gripR', tt).p;
    lookFrom(cams[3], [rh[0] + 0.12, rh[1] + 0.22, rh[2] - 0.42], [rh[0], rh[1] - 0.04, rh[2]], 40);
    const mid: V3 = [lh[0] + 0.1, lh[1] - 0.05, lh[2]];
    lookFrom(cams[4], [mid[0] + 0.25, mid[1] + 0.25, mid[2] - 0.55], mid, 30);
    scene.updateMatrixWorld();
  }

  const W = 628, H = 520;
  const slots = [
    [-W - 8, -H / 2 - 6, W, H], [0, -H / 2 - 6, W, H], [W + 8, -H / 2 - 6, W, H],
    [-W / 2 - 4, H / 2 + 6, W, H], [W / 2 + 4, H / 2 + 6, W, H],
  ];
  cams.forEach((c, i) => {
    const [x, y, w, h] = slots[i];
    view.add(<ThreeView world={world} camera={c} x={x} y={y} width={w} height={h} radius={14} />);
    view.add(
      <Rect x={x - w / 2 + 10} y={y - h / 2 + 10} offset={[-1, -1]} layout padding={[4, 12]} radius={20} fill={'#ffffffe0'}>
        <Txt text={() => (i === 0 ? `${titles[i]} · t ${t().toFixed(2)} · Schlaufe ${bake.track('loop', t()).toFixed(2)}` : titles[i])} fontFamily={FONT} fontWeight={700} fontSize={20} fill={C.text} />
      </Rect>,
    );
  });
  yield* t(bake.duration, bake.duration, linear);
});
