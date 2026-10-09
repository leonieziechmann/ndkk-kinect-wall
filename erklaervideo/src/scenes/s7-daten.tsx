// 7 · Daten an die Szene: every picture of the Kinect runs through the steps of the system, named so
// that anyone understands them (Vorberechnung, KI-Erkennung, Tracking, Visualisierung), 30 times a
// second. Then the visualization opens up into the wall, where the skeletons appear: mirrored, in
// real size, the walk stretched over the whole wall. Then the fluid starts.

import { Gradient, Line, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeOutCubic, linear, sequence } from '@motion-canvas/core';
import { hsv } from '../lib/math';
import { people } from '../lib/people';
import { SHOTS, begin, setShot, until } from '../lib/shots';
import { cue } from '../lib/sound';
import { C, FONT, MONO } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { KINECT } from '../lib/world';
import { Packets } from '../nodes/Packets';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage } from '../nodes/Stage';
import { WallView } from '../nodes/WallView';
import { Caption, chapterBar } from '../nodes/ui';

const ROW_Y = -120;
const XS = [-800, -480, -160, 160, 480, 800];
const BOX = { w: 232, h: 156 };
const NAMES = ['Kinect', 'Vorberechnung', 'KI-Erkennung', 'Tracking', 'Visualisierung', 'LED-Wand'];
/** the box that opens up into the wall */
const VIS = 4;
const WALL_VIEW = { x: 0, y: -60, w: 1500, h: 500 };
/** smaller while the top view is shown below it */
const WALL_SMALL = { x: 0, y: -175, w: 1260, h: 420 };
const MASK = { w: 560, h: 463, x: 545, y: -30 };

const fmt = (v: number) => v.toFixed(2).replace('.', ',');

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.daten);
  const st = createRef<Stage>();
  const mk = createRef<SensorPanel>();
  const pipe = createRef<Node>();
  const boxes: Rect[] = [];
  const labels: Txt[] = [];
  const arrows: Line[] = [];
  const packets: Packets[] = [];
  const card = createRef<Rect>();
  const latency = createRef<Node>();
  const bracket = createRef<Line>();
  const wall = createRef<WallView>();

  view.add(
    <Stage ref={st} time={T} wallLit={0.55} wallAlpha={0} roomAlpha={0} kinectAlpha={0} cloud={1} colorMask={1} maskGrow={90} bgGrey={1} bgDrop={1} skel={1} />,
  );
  setShot(st(), SHOTS.kinectMaskEnd);
  view.add(<SensorPanel ref={mk} time={T} mode={'mask'} maskGrow={90} room={0} roomTint={1} title={'Masken'} width={MASK.w} height={MASK.h} x={MASK.x} y={MASK.y} />);

  // the chain, with an icon per step
  const figure = (x: number, color: string, arms: [number, number][]) => (
    <Node x={x}>
      <Rect y={-40} width={15} height={15} radius={8} fill={color} />
      <Line points={[[0, -30], [0, 6], [-13, 34], [0, 6], [13, 34]]} stroke={color} lineWidth={4.5} lineCap={'round'} lineJoin={'round'} />
      <Line points={arms} stroke={color} lineWidth={4.5} lineCap={'round'} lineJoin={'round'} />
    </Node>
  );
  const icon = (i: number) => {
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
  };

  view.add(
    <Node ref={pipe}>
      {XS.map((x, i) => (
        <Rect ref={(r: Rect) => boxes.push(r)} x={x} y={ROW_Y} width={BOX.w} height={BOX.h} radius={24} fill={'#0a0f19'} stroke={'rgba(160,180,215,0.55)'} lineWidth={2} opacity={0} scale={0.9}>
          {icon(i)}
        </Rect>
      ))}
      {XS.map((x, i) => (
        <Txt ref={(t: Txt) => labels.push(t)} x={x} y={ROW_Y + BOX.h / 2 + 40} text={NAMES[i]} fontFamily={FONT} fontWeight={600} fontSize={29} fill={C.text} opacity={0} />
      ))}
      {XS.slice(0, -1).map((x, i) => (
        <Line
          ref={(l: Line) => arrows.push(l)}
          points={[[x + BOX.w / 2 + 10, ROW_Y], [XS[i + 1] - BOX.w / 2 - 10, ROW_Y]]}
          stroke={'rgba(200,215,240,0.75)'}
          lineWidth={3}
          endArrow
          arrowSize={12}
          end={0}
        />
      ))}
      {XS.slice(0, -1).map((x, i) => (
        <Packets
          ref={(p: Packets) => packets.push(p)}
          time={T}
          from={[x + BOX.w / 2 + 12, ROW_Y]}
          to={[XS[i + 1] - BOX.w / 2 - 24, ROW_Y]}
          color={i < 2 ? C.sensor : '#29e6ff'}
          count={3}
        />
      ))}
      <Node ref={latency} opacity={0}>
        <Line
          ref={bracket}
          points={[[XS[0] - BOX.w / 2 + 24, ROW_Y + BOX.h / 2 + 76], [XS[0] - BOX.w / 2 + 24, ROW_Y + BOX.h / 2 + 96], [XS[VIS] + BOX.w / 2 - 24, ROW_Y + BOX.h / 2 + 96], [XS[VIS] + BOX.w / 2 - 24, ROW_Y + BOX.h / 2 + 76]]}
          stroke={C.sensor}
          lineWidth={2.5}
          end={0}
        />
        <Txt x={(XS[0] + XS[VIS]) / 2} y={ROW_Y + BOX.h / 2 + 126} text={'Latenz ≈ 10 ms (live)'} fontFamily={FONT} fontWeight={600} fontSize={28} fill={C.sensor} />
      </Node>
      <Rect ref={card} x={480} y={256} width={700} height={176} radius={18} fill={'#0b111c'} stroke={'rgba(41,230,255,0.6)'} lineWidth={2} opacity={0} layout direction={'column'} gap={10} padding={[22, 30]} alignItems={'start'}>
        <Txt text={'Daten nach dem Tracking'} fontFamily={FONT} fontWeight={600} fontSize={25} fill={C.muted} />
        {[1, 2].map((slot) => (
          <Txt
            fontFamily={MONO}
            fontSize={28}
            fill={slot === 1 ? '#29e6ff' : '#ff3fd0'}
            text={() => {
              const p = people(T()).find((q) => q.slot === slot);
              if (!p) return '';
              const h = p.joints[21];
              return `Person ${slot}  Hand ${fmt(h[1])} m hoch, ${fmt(h[2] - KINECT[2])} m weg`;
            }}
          />
        ))}
      </Rect>
    </Node>,
  );
  view.add(<WallView ref={wall} time={T} x={XS[VIS]} y={ROW_Y + 11} width={170} height={56.7} opacity={0} />);
  const cap = new Caption(view);
  yield chapterBar(view, 6);

  // part A: from the sensor to the scene
  cue(T, 'whoosh', 0, { dur: 1.0, gain: 0.3, pan: 0, panTo: 0.7 });
  NAMES.forEach((_, i) => cue(T, 'pop', 0.4 + 0.18 * i, { n: i + 1, pan: XS[i] / 1000 }));
  cue(T, 'data', 1.5, { dur: 3.3 });
  cue(T, 'tick', 2.0, { pan: 0.1 });
  cue(T, 'swish', 2.6, { pan: 0.4, gain: 0.5 });
  yield* all(
    st().opacity(0, 1.0),
    mk().x(MASK.x + 900, 1.0, easeInOutCubic),
    delay(0.4, sequence(0.18, ...boxes.map((b, i) => all(b.opacity(1, 0.5), b.scale(1, 0.5, easeOutCubic), labels[i].opacity(1, 0.5))))),
    delay(0.9, sequence(0.18, ...arrows.map((a) => a.end(1, 0.4, easeOutCubic)))),
    delay(1.3, cap.show('30-mal pro Sekunde läuft jedes Bild durch diese Schritte.')),
    delay(1.5, sequence(0.15, ...packets.map((p) => p.flow(1, 0.4)))),
    delay(2.0, all(latency().opacity(1, 0.4), bracket().end(1, 0.9, easeInOutCubic))),
    delay(2.6, all(card().opacity(1, 0.6), card().y(236, 0.6, easeOutCubic))),
  );
  yield* until(4.6);

  // part B: the scene opens up into the wall
  cue(T, 'whoosh', 0.1, { dur: 1.2, gain: 0.5, pan: 0.5, panTo: 0 });
  yield* all(
    card().opacity(0, 0.5),
    latency().opacity(0, 0.4),
    ...packets.map((p) => p.flow(0, 0.4)),
    ...arrows.map((a) => a.opacity(0, 0.4)),
    ...labels.map((l) => l.opacity(0, 0.4)),
    ...boxes.map((b) => b.opacity(0, 0.5)),
    wall().opacity(1, 0.4),
    delay(0.1, all(wall().x(WALL_SMALL.x, 1.1, easeInOutCubic), wall().y(WALL_SMALL.y, 1.1, easeInOutCubic), wall().width(WALL_SMALL.w, 1.1, easeInOutCubic), wall().height(WALL_SMALL.h, 1.1, easeInOutCubic))),
    delay(0.5, cap.show('Daraus entsteht das Bild auf der Wand.')),
  );
  cue(T, 'pop', 0, { n: 3, gain: 0.7 });
  cue(T, 'tick', 0.4, { pan: -0.2 });
  cue(T, 'swish', 1.2, { pan: 0, gain: 0.4 });
  yield* all(
    wall().skel(1, 0.8),
    wall().ghost(1, 0.8),
    delay(0.4, wall().mirror(1, 0.6)),
    delay(1.2, wall().topView(1, 0.7)),
  );
  yield* until(8.0);
  cue(T, 'fluid', 0);
  yield* all(wall().mirror(0, 0.5), wall().fluid(1, 2.0, linear));
  yield* until(10.0);
  yield* all(wall().topView(0, 0.5), wall().ghost(0, 0.5), wall().skel(0.55, 0.6), cap.hide(0.4));
  // back to the size the next scene starts with
  yield* all(wall().y(WALL_VIEW.y, 0.9, easeInOutCubic), wall().width(WALL_VIEW.w, 0.9, easeInOutCubic), wall().height(WALL_VIEW.h, 0.9, easeInOutCubic));
  yield* until(duration('daten'));
});
