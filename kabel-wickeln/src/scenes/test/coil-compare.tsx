// Test scene for the comparison sheet (output/p1-coil/compare.jpg): the stage 1 coiling bake seen
// like the user's camera B (in front of her at hip height, the whole coil and both hands) and from
// above in front like her camera A. Left half B, right half A.
// node tools/render.mjs stills --project coil --scene coil-compare --out output/p1-coil/compare <seconds>

import { makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import { fontsReady } from '../../lib/fonts';
import { C } from '../../lib/theme';
import { splitPerson } from '../../lib/kit';
import { NOOR } from '../../people/cast';
import { BakedRod, loadBake } from '../../sim';
import { CoilReplay } from '../../shots/coil-engine';
import { CableMesh } from '../../three/cable';
import { lookFrom, makeCamera } from '../../three/camera';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

const BAKE = 's1-coil';

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const bake = (yield loadBake(BAKE)) as BakedRod;
  const replay = new CoilReplay(bake, NOOR);
  const t = createSignal(0);
  const n = bake.n;
  const pos = new Float32Array(3 * n), d1 = new Float32Array(3 * n);
  const world = new World3D('test-coil-compare', update);
  const scene = world.scene;
  new Studio(scene, { focus: [0, 0.6, -0.3], focusRadius: 1.4 });
  const cable = new CableMesh({ maxNodes: n, radius: bake.radius, plugStart: 'xlr-male', plugEnd: 'xlr-female', haloPx: 0 });
  scene.add(cable.group);
  const noor = splitPerson(NOOR, replay.pose(0));
  scene.add(noor.person.group);
  const camB = makeCamera(40), camA = makeCamera(46);

  function update() {
    const tt = t();
    noor.update(replay.pose(tt));
    bake.frameSample(tt, pos, d1);
    cable.update(pos, d1, n);
    // B: in front of her, a little lower than her hands, the torso to the knees
    lookFrom(camB, [0.0, 0.95, -1.75], [0.02, 0.82, -0.2], 40);
    // A: above and in front of her left hand, looking down on the hands and the coil
    lookFrom(camA, [-0.15, 1.55, -0.85], [0.0, 0.8, -0.3], 46);
    scene.updateMatrixWorld();
  }

  view.add(<ThreeView world={world} camera={camB} x={-480} y={0} width={952} height={1080} />);
  view.add(<ThreeView world={world} camera={camA} x={480} y={0} width={952} height={1080} />);
  yield* t(bake.duration, bake.duration, linear);
});
