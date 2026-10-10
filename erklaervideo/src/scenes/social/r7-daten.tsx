// Social 7 · Der Weg der Daten (portrait, quick): the steps every picture runs through, top to bottom,
// 30 times a second; then "Visualisierung" opens up into the wall: the skeletons, mirrored, the
// walk stretched (top view below), and the fluid starts.

import { Line, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeOutCubic, linear, sequence } from '@motion-canvas/core';
import { CAPTION, MASK, P, WALL_P } from '../../lib/portrait';
import { SOCIAL_SHOTS, begin, setShot, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { C, FONT } from '../../lib/theme';
import { SCENES, duration } from '../../lib/timeline';
import { Packets } from '../../nodes/Packets';
import { NAMES, pipelineIcon } from '../../nodes/pipeline';
import { SensorPanel } from '../../nodes/SensorPanel';
import { Stage } from '../../nodes/Stage';
import { WallView } from '../../nodes/WallView';
import { Caption, topShade } from '../../nodes/ui';

/** the icons are drawn for 232 × 156; here a bit smaller, one below the other */
const K = 0.72;
const BOX = { w: 232 * K, h: 156 * K };
const X = -250;
const YS = [-400, -240, -80, 80, 240, 400];
const LABEL_X = X + BOX.w / 2 + 34;
/** the box that opens up into the wall */
const VIS = 4;
const BRACKET_X = 330;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.daten);
  const st = createRef<Stage>();
  const mk = createRef<SensorPanel>();
  const boxes: Rect[] = [];
  const labels: Txt[] = [];
  const arrows: Line[] = [];
  const packets: Packets[] = [];
  const latency = createRef<Node>();
  const bracket = createRef<Line>();
  const wall = createRef<WallView>();

  view.add(
    <Stage
      ref={st}
      time={T}
      width={P.w}
      height={P.h}
      textScale={P.text}
      wallLit={0.55}
      wallAlpha={0}
      roomAlpha={0}
      kinectAlpha={0}
      cloud={1}
      colorMask={1}
      maskGrow={90}
      bgGrey={1}
      bgDrop={1}
      skel={1}
    />,
  );
  setShot(st(), SOCIAL_SHOTS.kinectMaskEnd);
  topShade(view, P.w, P.h);
  view.add(<SensorPanel ref={mk} time={T} mode={'mask'} maskGrow={90} room={0} roomTint={1} title={'Masken'} width={MASK.w} height={MASK.h} x={MASK.x} y={MASK.y} textScale={P.text} />);

  view.add(
    <Node>
      {YS.map((y) => (
        <Rect ref={(r: Rect) => boxes.push(r)} x={X} y={y} width={BOX.w} height={BOX.h} radius={22} fill={'#0a0f19'} stroke={'rgba(160,180,215,0.55)'} lineWidth={2} opacity={0} scale={0.9}>
          <Node scale={K}>{pipelineIcon(YS.indexOf(y))}</Node>
        </Rect>
      ))}
      {YS.map((y, i) => (
        <Txt ref={(t: Txt) => labels.push(t)} x={LABEL_X} y={y} offset={[-1, 0]} text={NAMES[i]} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} opacity={0} />
      ))}
      {YS.slice(0, -1).map((y, i) => (
        <Line ref={(l: Line) => arrows.push(l)} points={[[X, y + BOX.h / 2 + 6], [X, YS[i + 1] - BOX.h / 2 - 6]]} stroke={'rgba(200,215,240,0.75)'} lineWidth={3} endArrow arrowSize={11} end={0} />
      ))}
      {YS.slice(0, -1).map((y, i) => (
        <Packets ref={(p: Packets) => packets.push(p)} time={T} from={[X, y + BOX.h / 2 + 8]} to={[X, YS[i + 1] - BOX.h / 2 - 18]} color={i < 2 ? C.sensor : '#29e6ff'} count={2} />
      ))}
      <Node ref={latency} opacity={0}>
        <Line
          ref={bracket}
          points={[[BRACKET_X - 20, YS[0] - BOX.h / 2 + 10], [BRACKET_X, YS[0] - BOX.h / 2 + 10], [BRACKET_X, YS[VIS] + BOX.h / 2 - 10], [BRACKET_X - 20, YS[VIS] + BOX.h / 2 - 10]]}
          stroke={C.sensor}
          lineWidth={3}
          end={0}
        />
        <Txt x={BRACKET_X + 26} y={(YS[0] + YS[VIS]) / 2} offset={[-1, 0]} text={'Latenz\n≈ 10 ms'} fontFamily={FONT} fontWeight={700} fontSize={40} lineHeight={50} fill={C.sensor} />
      </Node>
    </Node>,
  );
  view.add(
    <WallView ref={wall} time={T} x={X} y={YS[VIS] + 11 * K} width={170 * K} height={(170 * K) / 3} opacity={0} textScale={P.text} topScale={100} topLabelBelow={1} />,
  );
  const cap = new Caption(view, CAPTION.x, CAPTION.y, CAPTION.style);

  // part A: from the sensor to the scene
  NAMES.forEach((_, i) => cue(T, 'pop', 0.3 + 0.12 * i, { n: i + 1, pan: -0.3 }));
  cue(T, 'data', 1.0, { dur: 2.4 });
  cue(T, 'tick', 1.5, { pan: 0.4 });
  yield* all(
    st().opacity(0, 0.8),
    mk().y(MASK.y + MASK.out, 0.8, easeInOutCubic),
    delay(0.3, sequence(0.12, ...boxes.map((b, i) => all(b.opacity(1, 0.4), b.scale(1, 0.4, easeOutCubic), labels[i].opacity(1, 0.4))))),
    delay(0.6, sequence(0.12, ...arrows.map((a) => a.end(1, 0.3, easeOutCubic)))),
    delay(0.8, cap.show('30-mal pro Sekunde läuft\njedes Bild hier durch.')),
    delay(1.0, sequence(0.1, ...packets.map((p) => p.flow(1, 0.4)))),
    delay(1.5, all(latency().opacity(1, 0.4), bracket().end(1, 0.7, easeInOutCubic))),
  );
  yield* until(3.4);

  // part B: "Visualisierung" opens up into the wall
  yield* all(
    latency().opacity(0, 0.3),
    ...packets.map((p) => p.flow(0, 0.3)),
    ...arrows.map((a) => a.opacity(0, 0.3)),
    ...labels.map((l) => l.opacity(0, 0.3)),
    ...boxes.map((b) => b.opacity(0, 0.4)),
    wall().opacity(1, 0.3),
    delay(0.1, all(wall().x(WALL_P.x, 1.0, easeInOutCubic), wall().y(WALL_P.y, 1.0, easeInOutCubic), wall().width(WALL_P.w, 1.0, easeInOutCubic), wall().height(WALL_P.h, 1.0, easeInOutCubic))),
    delay(0.4, cap.show('Daraus entsteht das\nBild auf der Wand.')),
  );
  cue(T, 'pop', 0, { n: 3, gain: 0.7 });
  cue(T, 'tick', 0.3, { pan: -0.2 });
  yield* all(wall().skel(1, 0.6), wall().ghost(1, 0.6), delay(0.3, wall().mirror(1, 0.5)), delay(0.6, wall().topView(1, 0.6)));
  yield* until(6.0);
  cue(T, 'fluid', 0);
  yield* all(wall().mirror(0, 0.4), wall().fluid(1, 1.2, linear));
  yield* all(wall().topView(0, 0.4), wall().ghost(0, 0.4), wall().skel(0.55, 0.5), cap.hide(0.4));
  yield* until(duration('daten'));
});
