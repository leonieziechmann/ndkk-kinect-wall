// 7 · Daten an die Szene: the people become data (skeletons, 30 times a second) that travel from the
// Kinect through the computer to the scene; the scene opens up into the wall, where the skeletons
// appear: mirrored, in real size, the walk stretched over the whole wall. Then the fluid starts.

import { Gradient, Line, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeOutCubic, linear, sequence } from '@motion-canvas/core';
import { hsv } from '../lib/math';
import { people } from '../lib/people';
import { SHOTS, begin, setShot, until } from '../lib/shots';
import { C, FONT, MONO } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { KINECT } from '../lib/world';
import { Packets } from '../nodes/Packets';
import { SensorPanel } from '../nodes/SensorPanel';
import { Stage } from '../nodes/Stage';
import { WallView } from '../nodes/WallView';
import { Caption, chapterBar } from '../nodes/ui';

const ROW_Y = -150;
const XS = [-690, -230, 230, 690];
const BOX = { w: 300, h: 190 };
const NAMES = ['Kinect', 'Computer', 'Szene', 'LED-Wand'];
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
  const wall = createRef<WallView>();

  view.add(
    <Stage ref={st} time={T} wallContent={'idle'} wallLit={0.7} wallAlpha={0.12} roomAlpha={0} cloud={1} colorMask={1} maskGrow={90} bgGrey={1} bgDrop={1} skel={1} />,
  );
  setShot(st(), SHOTS.masksEnd);
  view.add(<SensorPanel ref={mk} time={T} mode={'mask'} maskGrow={90} room={0} roomTint={1} title={'Masken'} width={MASK.w} height={MASK.h} x={MASK.x} y={MASK.y} />);

  // the chain: Kinect → computer → scene → wall
  const icon = (i: number) => {
    switch (i) {
      case 0:
        return (
          <Node>
            <Rect width={180} height={44} radius={10} fill={'#121826'} stroke={C.line} lineWidth={2} />
            <Rect x={-36} width={20} height={20} radius={10} fill={C.sensor} />
            <Rect x={36} width={16} height={16} radius={8} fill={C.ir} />
            <Line points={[[0, 22], [0, 62]]} stroke={C.truss} lineWidth={4} />
          </Node>
        );
      case 1:
        return (
          <Node y={-6}>
            <Rect width={190} height={118} radius={10} fill={'#0d1320'} stroke={C.line} lineWidth={2} />
            <Line points={[[-30, 70], [30, 70]]} stroke={C.line} lineWidth={4} />
            <Line points={[[-14, -38], [-14, 4], [-36, 30], [-14, 4], [8, 30]]} stroke={'#29e6ff'} lineWidth={5} lineCap={'round'} lineJoin={'round'} />
            <Line points={[[-40, -22], [-14, -26], [12, -40]]} stroke={'#29e6ff'} lineWidth={5} lineCap={'round'} lineJoin={'round'} />
            <Rect x={-14} y={-46} width={16} height={16} radius={8} fill={'#29e6ff'} />
            <Line points={[[44, -30], [44, 22]]} stroke={'#ff3fd0'} lineWidth={5} lineCap={'round'} />
            <Line points={[[28, -10], [44, -18], [62, -36]]} stroke={'#ff3fd0'} lineWidth={5} lineCap={'round'} lineJoin={'round'} />
            <Rect x={44} y={-40} width={14} height={14} radius={7} fill={'#ff3fd0'} />
          </Node>
        );
      case 2:
        return (
          <Node>
            <Rect width={200} height={130} radius={12} fill={'#0d1320'} stroke={C.line} lineWidth={2} clip>
              <Rect y={-52} width={200} height={26} fill={'#1a2233'} />
              <Rect
                y={13}
                width={200}
                height={104}
                fill={new Gradient({ type: 'linear', from: [-100, 0], to: [100, 0], stops: [{ offset: 0, color: '#1b2a8f' }, { offset: 0.5, color: '#7a2bb0' }, { offset: 1, color: '#e0367f' }] })}
              />
            </Rect>
            {[-84, -70, -56].map((x) => (
              <Rect x={x} y={-52} width={8} height={8} radius={4} fill={'#8592aa'} />
            ))}
          </Node>
        );
      default:
        return (
          <Node>
            {Array.from({ length: 48 }, (_, k) => {
              const c = k % 12;
              const r = Math.floor(k / 12);
              const [cr, cg, cb] = hsv(c / 12, 0.6, 0.85 - r * 0.12);
              return <Rect x={-88 + c * 16} y={-24 + r * 16} width={14} height={14} radius={2} fill={`rgb(${Math.round(cr * 255)},${Math.round(cg * 255)},${Math.round(cb * 255)})`} />;
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
        <Txt ref={(t: Txt) => labels.push(t)} x={x} y={ROW_Y + BOX.h / 2 + 46} text={NAMES[i]} fontFamily={FONT} fontWeight={600} fontSize={34} fill={C.text} opacity={0} />
      ))}
      {XS.slice(0, 3).map((x, i) => (
        <Line
          ref={(l: Line) => arrows.push(l)}
          points={[[x + BOX.w / 2 + 14, ROW_Y], [XS[i + 1] - BOX.w / 2 - 14, ROW_Y]]}
          stroke={'rgba(200,215,240,0.75)'}
          lineWidth={3}
          endArrow
          arrowSize={14}
          end={0}
        />
      ))}
      {XS.slice(0, 3).map((x, i) => (
        <Packets
          ref={(p: Packets) => packets.push(p)}
          time={T}
          from={[x + BOX.w / 2 + 18, ROW_Y]}
          to={[XS[i + 1] - BOX.w / 2 - 30, ROW_Y]}
          color={i === 0 ? C.sensor : '#29e6ff'}
          count={i === 0 ? 7 : 5}
        />
      ))}
      <Rect ref={card} x={0} y={140} width={760} height={190} radius={18} fill={'#0b111c'} stroke={'rgba(41,230,255,0.6)'} lineWidth={2} opacity={0} layout direction={'column'} gap={10} padding={[24, 32]} alignItems={'start'}>
        <Txt text={'Datenpaket · alle 33 ms'} fontFamily={FONT} fontWeight={600} fontSize={26} fill={C.muted} />
        {[1, 2].map((slot) => (
          <Txt
            fontFamily={MONO}
            fontSize={30}
            fill={slot === 1 ? '#29e6ff' : '#ff3fd0'}
            text={() => {
              const p = people(T()).find((q) => q.slot === slot);
              if (!p) return '';
              const h = p.joints[21];
              return `Person ${slot}  Hand  x ${fmt(h[0] - KINECT[0])}  y ${fmt(h[1])}  z ${fmt(h[2] - KINECT[2])} m`;
            }}
          />
        ))}
      </Rect>
    </Node>,
  );
  view.add(<WallView ref={wall} time={T} x={XS[2]} y={ROW_Y} width={200} height={66.7} opacity={0} />);
  const cap = new Caption(view);
  yield chapterBar(view, 6);

  // part A: from the sensor to the scene
  yield* all(
    st().opacity(0, 1.0),
    mk().x(MASK.x + 900, 1.0, easeInOutCubic),
    delay(0.4, sequence(0.25, ...boxes.map((b, i) => all(b.opacity(1, 0.5), b.scale(1, 0.5, easeOutCubic), labels[i].opacity(1, 0.5))))),
    delay(1.0, sequence(0.25, ...arrows.map((a) => a.end(1, 0.5, easeOutCubic)))),
    delay(1.3, cap.show('30-mal pro Sekunde gehen die Daten an die Szene.')),
    delay(1.6, sequence(0.2, ...packets.map((p) => p.flow(1, 0.4)))),
    delay(2.2, all(card().opacity(1, 0.6), card().y(120, 0.6, easeOutCubic))),
  );
  yield* until(5.0);

  // part B: the scene opens up into the wall
  yield* all(
    card().opacity(0, 0.5),
    ...packets.map((p) => p.flow(0, 0.4)),
    ...arrows.map((a) => a.opacity(0, 0.4)),
    ...labels.map((l) => l.opacity(0, 0.4)),
    ...boxes.map((b) => b.opacity(0, 0.5)),
    wall().opacity(1, 0.4),
    delay(0.1, all(wall().x(WALL_SMALL.x, 1.1, easeInOutCubic), wall().y(WALL_SMALL.y, 1.1, easeInOutCubic), wall().width(WALL_SMALL.w, 1.1, easeInOutCubic), wall().height(WALL_SMALL.h, 1.1, easeInOutCubic))),
    delay(0.5, cap.show('Daraus malt die Szene das Bild auf der Wand.')),
  );
  yield* all(
    wall().skel(1, 0.8),
    wall().ghost(1, 0.8),
    delay(0.4, wall().mirror(1, 0.6)),
    delay(1.2, wall().topView(1, 0.7)),
  );
  yield* until(8.4);
  yield* all(wall().mirror(0, 0.5), wall().fluid(1, 2.0, linear));
  yield* until(10.5);
  yield* all(wall().topView(0, 0.5), wall().ghost(0, 0.5), wall().skel(0.55, 0.6), cap.hide(0.4));
  // back to the size the next scene starts with
  yield* all(wall().y(WALL_VIEW.y, 0.9, easeInOutCubic), wall().width(WALL_VIEW.w, 0.9, easeInOutCubic), wall().height(WALL_VIEW.h, 0.9, easeInOutCubic));
  yield* until(duration('daten'));
});
