// Stage 1, the overview: loops into the left hand, one over, one under, again and again. Then the
// coil is thrown out and the cable lies flat. If that is enough, stop here.

import { Layout, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, createSignal, delay, easeInOutCubic, easeOutCubic, linear, waitFor } from '@motion-canvas/core';
import { rollOut, rollRing } from '../lib/coil';
import { BASE, FLOOR, KINDS, handView } from '../lib/handview';
import { clamp } from '../lib/math';
import { C, FONT } from '../lib/theme';
import { Mark, Pill, StageBar, Words, begin, rise, stopCard } from '../lib/ui';
import { Cable } from '../nodes/Cable';
import { Fist } from '../nodes/Fist';

const TEXT_X = -130;

export default makeScene2D(function* (view) {
  yield* begin(view);
  const p = createSignal(0);
  const view1 = handView(p);
  const hands = createRef<Node>();
  const head1 = createRef<Txt>();
  const head2 = createRef<Layout>();
  const note = createRef<Txt>();
  const done = createRef<Txt>();
  const pills: Node[] = [];

  view.add(
    <Node ref={hands}>{view1.node}</Node>,
  );
  view.add(
    <Node>
      <Txt ref={head1} x={TEXT_X} y={-330} offsetX={-1} text={'Schlaufen in die linke Hand legen,'} fontFamily={FONT} fontWeight={700} fontSize={52} fill={C.text} opacity={0} />
      <Words
        ref={head2}
        x={TEXT_X}
        y={-258}
        offsetX={-1}
        size={52}
        parts={[
          ['abwechselnd ', C.text],
          ['über', C.over],
          [' und ', C.text],
          ['unter', C.under],
          ['.', C.text],
        ]}
        opacity={0}
      />
      {KINDS.map((k, i) => (
        <Pill ref={(n) => pills.push(n)} x={TEXT_X + 70 + i * 142} y={-140} text={k === 'over' ? 'über' : 'unter'} color={k === 'over' ? C.over : C.under} size={32} opacity={0} />
      ))}
      <Txt ref={note} x={TEXT_X} y={-50} offsetX={-1} text={'Für »unter« dreht die rechte Hand um.'} fontFamily={FONT} fontWeight={500} fontSize={38} fill={C.muted} opacity={0} />
      <Txt ref={done} x={TEXT_X} y={40} offsetX={-1} text={'Fertig ist ein Ring,\nder sich nicht verdreht.'} lineHeight={60} fontFamily={FONT} fontWeight={600} fontSize={44} fill={C.text} opacity={0} />
    </Node>,
  );
  view.add(<StageBar current={1} />);

  // the pills light up when their loop is in the hand
  const pillAt = (i: number) => {
    const n = pills[i];
    n.scale(0.6);
    return all(n.opacity(1, 0.25), n.scale(1, 0.4, easeOutCubic));
  };

  yield* rise(head1(), 0.6);
  // the first two loops slowly, then quicker
  const loops = function* () {
    for (let k = 0; k < KINDS.length; k++) {
      const d = k < 2 ? 2.4 : 1.5;
      yield* all(p(k + 1, d, linear), delay(d * 0.86, pillAt(k)));
    }
  };
  yield* all(loops(), delay(0.7, rise(head2(), 0.6)), delay(4.6, rise(note(), 0.6)));
  yield* rise(done(), 0.6);
  yield* waitFor(1.4);

  // ------------------------------------------------------------------ throw it out
  // the camera follows the rolling ring, then steps back to show the whole cable
  const ZOOM = 0.5;
  const zoom = createSignal(ZOOM);
  const laid = createSignal(0);
  const back = createSignal(0);
  const roll = createRef<Node>();
  const head3 = createRef<Txt>();
  const flat = createRef<Layout>();
  const R = BASE.loop / (2 * Math.PI);
  const ring = (l: number) => rollRing({ x0: 0, floorY: 0, R, total: BASE.total, laid: l });
  const camX = () => {
    const follow = Math.min(-700, 330 - ring(laid()).x * ZOOM);
    return follow + (-860 - follow) * back();
  };
  view.add(
    <Node ref={roll} opacity={0}>
      <Rect y={FLOOR + 6 + 150} width={1920} height={300} fill={C.floor} />
      <Rect y={FLOOR + 6} width={1920} height={2} fill={C.floorLine} />
      <Node x={camX} y={FLOOR} scale={zoom}>
        <Fist x={0} y={-70} side={'right'} arm={62} scale={0.8} part={'arm'} />
        <Cable geom={() => rollOut({ x0: 0, floorY: 0, R, total: BASE.total, laid: laid() })} thickness={() => Math.max(20, 8 / zoom())} stripe={0} />
        <Fist x={0} y={-70} side={'right'} scale={0.8} part={'hand'} />
      </Node>
      <Txt ref={head3} x={0} y={-330} text={'Zum Auslegen: Ende festhalten, Ring werfen.'} fontFamily={FONT} fontWeight={700} fontSize={56} fill={C.text} opacity={0} />
      <Layout ref={flat} y={-200} layout direction={'row'} alignItems={'center'} gap={20} opacity={0}>
        <Mark good size={52} />
        <Txt text={'Das Kabel liegt glatt. Keine Kringel, keine Knoten.'} fontFamily={FONT} fontWeight={600} fontSize={42} fill={C.text} />
      </Layout>
    </Node>,
  );
  // the hand view goes, the floor view comes
  const words = [head1(), head2(), note(), done(), ...pills];
  yield* all(hands().opacity(0, 0.6), ...words.map((w) => w.opacity(0, 0.5)), roll().opacity(1, 0.6));
  yield* rise(head3(), 0.6);
  yield* waitFor(0.5);
  yield* laid(ring(0).max, 4.6, (t) => 1 - Math.pow(1 - t, 2.2));
  yield* all(back(1, 1.6, easeInOutCubic), zoom(1650 / BASE.total, 1.6, easeInOutCubic));
  yield* rise(flat(), 0.6);
  yield* waitFor(2.4);
  yield* stopCard(view, 1);
});
