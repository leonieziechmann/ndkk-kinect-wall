// Test scene for a coiling bake (s1-coil or one of the coil-dev* shots): Noor's recorded arms (CoilReplay)
// and the simulated cable, seen from her eyes (arms only, the body's shadow), from the front at hip
// height (like the user's camera B), from her right front (the outside camera) and close up on the
// hands from above in front (like the user's camera A). The bake's id is BAKE below.
// node tools/render.mjs stills --project coil --scene coil-sim --scale 1 --out output/p2/sim <seconds>

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

const BAKE = 's1-coil';
/** the fourth view: close on the right hand, close on the left fist, or both hands from above in front */
const CLOSE: 'right' | 'left' | 'both' = 'left';

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

  const cams = [makeCamera(60), makeCamera(36), makeCamera(34), makeCamera(36)];
  viewLayers(cams[0], 'pov');
  for (const c of cams.slice(1)) viewLayers(c, 'ext');
  const titles = ['Ich-Ansicht', 'Vorn, Hüfthöhe (B)', 'Rechts vorn', CLOSE === 'left' ? 'Linke Faust, nah' : CLOSE === 'right' ? 'Rechte Hand, nah' : 'Hände, oben vorn (A)'];

  function update() {
    const tt = t();
    const a = replay.at(tt);
    noor.update(replay.pose(tt));
    bake.frameSample(tt, pos, d1);
    cable.update(pos, d1, n);
    const e = eyesOfRig(NOOR, a.rig).p;
    const lh = bake.frame('gripL', tt).p;
    lookFrom(cams[0], [e[0], e[1] + 0.03, e[2] + 0.04], [lh[0] + 0.16, lh[1] - 0.2, lh[2] - 0.08], 62);
    lookFrom(cams[1], [0.0, 0.85, -1.6], [0.0, 0.72, -0.2], 38);
    lookFrom(cams[2], [1.0, 1.15, -1.1], [0.02, 0.72, -0.25], 36);
    const rh = bake.frame('gripR', tt).p;
    if (CLOSE === 'right') {
      const mid: V3 = [rh[0], rh[1] - 0.02, rh[2]];
      lookFrom(cams[3], [mid[0] + 0.25, mid[1] + 0.25, mid[2] - 0.35], mid, 34);
    } else if (CLOSE === 'left') {
      const mid: V3 = [lh[0] + 0.02, lh[1] - 0.03, lh[2]];
      lookFrom(cams[3], [mid[0] + 0.12, mid[1] + 0.3, mid[2] - 0.3], mid, 40);
    } else {
      const mid: V3 = [lh[0] + 0.12, lh[1] - 0.1, lh[2]];
      lookFrom(cams[3], [mid[0] + 0.05, mid[1] + 0.55, mid[2] - 0.55], mid, 46);
    }
    scene.updateMatrixWorld();
  }

  const W = 948, H = 528;
  cams.forEach((c, i) => {
    const x = (i % 2 - 0.5) * (W + 8), y = (Math.floor(i / 2) - 0.5) * (H + 8);
    view.add(<ThreeView world={world} camera={c} x={x} y={y} width={W} height={H} radius={12} />);
    view.add(
      <Rect x={x - W / 2 + 10} y={y - H / 2 + 10} offset={[-1, -1]} layout padding={[4, 12]} radius={20} fill={'#ffffffe0'}>
        <Txt text={() => (i === 0 ? `${BAKE} · ${titles[i]} · t ${t().toFixed(2)} · Schlaufe ${bake.track('loop', t()).toFixed(2)}` : titles[i])} fontFamily={FONT} fontWeight={700} fontSize={22} fill={C.text} />
      </Rect>,
    );
  });
  yield* t(bake.duration, bake.duration, linear);
});
