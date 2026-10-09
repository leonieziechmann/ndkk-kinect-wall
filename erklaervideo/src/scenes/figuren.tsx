// The model sheet of one look (tools/harness.html?body=…): the people big from the front (as the
// Kinect sees them), from the side and from behind, the infrared and the depth picture at the same
// moment. The scene runs along the story from scene 2 on; its time t is story time SCENES.sensor + t.

import { Txt, makeScene2D } from '@motion-canvas/2d';
import { waitFor } from '@motion-canvas/core';
import { DEFAULT_STYLE } from '../lib/body/styles';
import { V3 } from '../lib/math';
import { people } from '../lib/people';
import { begin } from '../lib/shots';
import { C, FONT } from '../lib/theme';
import { SCENES } from '../lib/timeline';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage } from '../nodes/Stage';

const NAMES: Record<string, string> = { lowpoly: 'Low-Poly', natur: 'Natürlich' };

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.sensor);
  // the camera follows the middle of the people, and steps back when they spread out
  const middle = (): V3 => {
    const ps = people(T());
    if (!ps.length) return [0, 1, 2.6];
    let x0 = Infinity;
    let x1 = -Infinity;
    let z = 0;
    for (const p of ps) {
      x0 = Math.min(x0, p.center[0]);
      x1 = Math.max(x1, p.center[0]);
      z += p.center[2];
    }
    return [(x0 + x1) / 2, x1 - x0, z / ps.length];
  };
  const far = (base: number) => () => base + Math.max(0, middle()[1] - 1.8) * 1.6;
  const common = { time: T, grid: 1, truss: 0, wall: 0, wallAlpha: 0, kinect: 0, roomAlpha: 0, figures: 1 };
  view.add(<Stage {...common} width={1240} height={1080} x={-340} yaw={180} pitch={4} dist={far(6.2)} tx={() => middle()[0]} ty={0.95} tz={() => middle()[2]} fov={30} />);
  view.add(<Stage {...common} width={680} height={540} x={620} y={-270} yaw={-90} pitch={4} dist={far(6.4)} tx={() => middle()[0]} ty={0.95} tz={() => middle()[2]} fov={30} />);
  view.add(<Stage {...common} width={680} height={540} x={620} y={270} yaw={20} pitch={10} dist={far(6.6)} tx={() => middle()[0]} ty={0.95} tz={() => middle()[2]} fov={30} />);
  view.add(<SensorPanel time={T} mode={'ir'} width={256} height={212} x={-830} y={410} chrome={1} />);
  view.add(<SensorPanel time={T} mode={'depth'} width={256} height={212} x={-560} y={410} chrome={1} />);
  view.add(<Txt text={NAMES[DEFAULT_STYLE] ?? DEFAULT_STYLE} x={-930} y={-490} offset={[-1, 0]} fontFamily={FONT} fontWeight={700} fontSize={44} fill={C.text} />);
  view.add(<Txt text={() => `Story ${T().toFixed(1)} s`} x={-930} y={-440} offset={[-1, 0]} fontFamily={FONT} fontSize={24} fill={C.muted} />);
  yield* waitFor(SCENES.ende - SCENES.sensor);
});
