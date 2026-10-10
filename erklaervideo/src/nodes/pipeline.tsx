// The steps every picture of the Kinect runs through (scene 7), with an icon each: named so that
// anyone understands them. Used by the full video and by the short cut for social media.

import { Gradient, Line, Node, Rect, Txt } from '@motion-canvas/2d';
import { hsv } from '../lib/math';
import { C, FONT } from '../lib/theme';

export const NAMES = ['Kinect', 'Vorberechnung', 'KI-Erkennung', 'Tracking', 'Visualisierung', 'LED-Wand'];

/** a stick figure with its arms */
const figure = (x: number, color: string, arms: [number, number][]) => (
  <Node x={x}>
    <Rect y={-40} width={15} height={15} radius={8} fill={color} />
    <Line points={[[0, -30], [0, 6], [-13, 34], [0, 6], [13, 34]]} stroke={color} lineWidth={4.5} lineCap={'round'} lineJoin={'round'} />
    <Line points={arms} stroke={color} lineWidth={4.5} lineCap={'round'} lineJoin={'round'} />
  </Node>
);

/** the icon of step i, drawn for a box of 232 × 156 */
export function pipelineIcon(i: number) {
  switch (i) {
    case 0:
      return (
        <Node y={-8}>
          <Rect width={150} height={36} radius={9} fill={'#121826'} stroke={C.line} lineWidth={2} />
          <Rect x={-28} width={17} height={17} radius={9} fill={C.sensor} />
          <Rect x={28} width={14} height={14} radius={7} fill={C.ir} />
          <Line points={[[-26, 52], [0, 20], [26, 52]]} stroke={C.truss} lineWidth={3} lineJoin={'round'} />
          <Line points={[[0, 20], [0, 54]]} stroke={C.truss} lineWidth={3} />
        </Node>
      );
    case 1:
      // pixels of the depth picture become points
      return (
        <Node>
          {Array.from({ length: 30 }, (_, k) => {
            const c = k % 6;
            const r = Math.floor(k / 6);
            const [cr, cg, cb] = hsv(0.62 - (r / 5) * 0.55, 0.85, 0.95);
            const col = `rgb(${Math.round(cr * 255)},${Math.round(cg * 255)},${Math.round(cb * 255)})`;
            const round = c >= 3;
            return <Rect x={-62 + c * 25 + (round ? 8 : 0)} y={-44 + r * 22} width={round ? 11 : 19} height={round ? 11 : 19} radius={round ? 6 : 2} fill={col} />;
          })}
        </Node>
      );
    case 2:
      // the pose model: a box around a person and its points
      return (
        <Node y={2}>
          <Line points={[[-46, -26], [-46, -52], [-20, -52]]} stroke={'#f0f4fa'} lineWidth={3.5} />
          <Line points={[[20, -52], [46, -52], [46, -26]]} stroke={'#f0f4fa'} lineWidth={3.5} />
          <Line points={[[46, 26], [46, 52], [20, 52]]} stroke={'#f0f4fa'} lineWidth={3.5} />
          <Line points={[[-20, 52], [-46, 52], [-46, 26]]} stroke={'#f0f4fa'} lineWidth={3.5} />
          {figure(0, '#f0f4fa', [[-22, 4], [-12, -18], [12, -18], [24, -36]])}
        </Node>
      );
    case 3:
      // tracking: who is who, from picture to picture
      return (
        <Node y={6}>
          {figure(-34, '#29e6ff', [[-50, -2], [-34, -18], [-18, -2]])}
          {figure(34, '#ff3fd0', [[18, -36], [34, -18], [50, -36]])}
          <Rect x={-58} y={-46} width={22} height={22} radius={6} fill={'#29e6ff'}>
            <Txt text={'1'} fontFamily={FONT} fontWeight={700} fontSize={16} fill={'#05070c'} />
          </Rect>
          <Rect x={58} y={-46} width={22} height={22} radius={6} fill={'#ff3fd0'}>
            <Txt text={'2'} fontFamily={FONT} fontWeight={700} fontSize={16} fill={'#05070c'} />
          </Rect>
        </Node>
      );
    case 4:
      return (
        <Node>
          <Rect width={170} height={110} radius={10} fill={'#0d1320'} stroke={C.line} lineWidth={2} clip>
            <Rect y={-44} width={170} height={22} fill={'#1a2233'} />
            <Rect
              y={11}
              width={170}
              height={88}
              fill={new Gradient({ type: 'linear', from: [-85, 0], to: [85, 0], stops: [{ offset: 0, color: '#1b2a8f' }, { offset: 0.5, color: '#7a2bb0' }, { offset: 1, color: '#e0367f' }] })}
            />
          </Rect>
          {[-70, -58, -46].map((x) => (
            <Rect x={x} y={-44} width={7} height={7} radius={4} fill={'#8592aa'} />
          ))}
        </Node>
      );
    default:
      // 12 × 2 panels of 0.5 × 1 m
      return (
        <Node>
          {Array.from({ length: 24 }, (_, k) => {
            const c = k % 12;
            const r = Math.floor(k / 12);
            const [cr, cg, cb] = hsv(c / 12, 0.6, 0.85 - r * 0.2);
            return <Rect x={-88 + c * 16} y={-16 + r * 32} width={14.5} height={30.5} radius={2} fill={`rgb(${Math.round(cr * 255)},${Math.round(cg * 255)},${Math.round(cb * 255)})`} />;
          })}
        </Node>
      );
  }
}
