// Stage 4, details and mistakes: never pull an end through the coil (knots), a loop that twists
// into an eight was turned the wrong way, not around hand and elbow, thick cables go down in
// figure eights, and three small things to finish.

import { Layout, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, createSignal, delay, easeInOutCubic, easeOutCubic, linear, sequence, waitFor } from '@motion-canvas/core';
import { rollOut, rollRing } from '../lib/coil';
import { P3, Path3, STEP, resample } from '../lib/geom';
import { TAU } from '../lib/math';
import { elbowWrap, figureEights, knottedLine, loopOrEight } from '../lib/shapes';
import { C, FONT } from '../lib/theme';
import { Mark, StageBar, begin, cardOut, rise, stopCard } from '../lib/ui';
import { Cable } from '../nodes/Cable';
import { Fist } from '../nodes/Fist';

const TIPS = 5;

/** a coil lying on the floor, seen from above: loops with a little wobble, the end hangs out */
function coilFromAbove(cx: number, cy: number, R: number, loops: number, tail: P3[]): P3[] {
  const p = new Path3(cx + R + 110, cy + R * 0.95);
  p.cubic(cx + R + 50, cy + R * 0.95, cx + R, cy + R * 0.55, cx + R, cy);
  const n = loops * 200;
  for (let i = 1; i <= n; i++) {
    const t = (TAU * loops * i) / n;
    const k = t / TAU;
    const r = R * (1 - 0.05 * Math.sin(k * 2.3 + 0.5) - 0.03 * Math.cos(k * 4.1));
    p.pts.push([cx + r * Math.cos(-t) + 4 * Math.sin(k * 1.7), cy + r * Math.sin(-t), 0]);
  }
  p.append(tail);
  return resample(p.pts, STEP);
}

export default makeScene2D(function* (view) {
  yield* begin(view);
  const tipNo = createRef<Txt>();
  const head = createRef<Txt>();
  const top = createRef<Layout>();
  view.add(
    <Layout ref={top} y={-390} layout direction={'column'} alignItems={'center'} gap={10} opacity={0}>
      <Txt ref={tipNo} text={'Tipp 1 von 5'} fontFamily={FONT} fontWeight={600} fontSize={30} fill={C.muted} />
      <Txt ref={head} text={''} fontFamily={FONT} fontWeight={800} fontSize={54} fill={C.text} />
    </Layout>,
  );
  view.add(<StageBar current={4} />);
  const setTip = function* (i: number, title: string) {
    if (i > 1) yield* top().opacity(0, 0.3);
    tipNo().text(`Tipp ${i} von ${TIPS}`);
    head().text(title);
    yield* rise(top(), 0.5, 16);
  };
  yield* cardOut(view, 3);

  // ------------------------------------------------------------ 1 · never pull an end through
  {
    const g = createRef<Node>();
    const thread = createSignal(0);
    const knots = createSignal(0);
    const good = createSignal(0);
    const wrongLabel = createRef<Layout>();
    const rightLabel = createRef<Layout>();
    const note = createRef<Txt>();
    // the free end, threaded through the middle of the coil (thread 0..1): over the right side of
    // the ring, down through the hole, out under the left side
    const CX = -560;
    const CY = 10;
    const RR = 150;
    const coilAlpha = createSignal(1);
    const tail = (): P3[] => {
      const t = thread();
      const ex = CX + RR + 230 - (2 * RR + 430) * t;
      const ey = CY - 90 + 140 * t;
      const q = new Path3(CX + RR, CY);
      q.cubic(CX + RR, CY - 90, ex + 160, ey - 40, ex, ey);
      return q.pts.map(([x, y]) => [x, y, x > CX ? 40 : -40] as P3);
    };
    view.add(
      <Node ref={g}>
        <Layout ref={wrongLabel} x={-860} y={-230} offsetX={-1} layout direction={'row'} alignItems={'center'} gap={16} opacity={0}>
          <Mark good={false} size={46} />
          <Txt text={'Ende durch den Ring gezogen'} fontFamily={FONT} fontWeight={700} fontSize={38} fill={C.text} />
        </Layout>
        <Cable geom={() => ({ pts: coilFromAbove(CX, CY, RR, 6, tail()), plugEnd: true })} thickness={16} stripe={0} opacity={coilAlpha} />
        <Cable geom={() => ({ pts: knottedLine(-860, 860, -40, [-430, 0, 430], knots(), 17), plugEnd: true, plugStart: true })} thickness={16} stripe={0} opacity={() => 1 - coilAlpha()} />
        <Txt ref={note} y={110} text={'Jede zweite Schlaufe wird zum Knoten.'} fontFamily={FONT} fontWeight={600} fontSize={40} fill={C.bad} opacity={0} />
        <Layout ref={rightLabel} x={-860} y={220} offsetX={-1} layout direction={'row'} alignItems={'center'} gap={16} opacity={0}>
          <Mark good size={46} />
          <Txt text={'Ende festhalten, Ring abrollen lassen – beide Enden bleiben außen.'} fontFamily={FONT} fontWeight={700} fontSize={38} fill={C.text} />
        </Layout>
        <Node x={-820} y={430} scale={0.42} opacity={() => Math.min(1, good() * 4)}>
          <Rect x={1990} y={130} width={4400} height={260} fill={C.floor} />
          <Fist x={0} y={-70} side={'right'} arm={62} scale={0.8} part={'arm'} />
          <Cable geom={() => rollOut({ x0: 0, floorY: 0, R: 160, total: 4200, laid: good() * rollRing({ x0: 0, floorY: 0, R: 160, total: 4200, laid: 0 }).max })} thickness={30} stripe={0} />
          <Fist x={0} y={-70} side={'right'} scale={0.8} part={'hand'} />
        </Node>
      </Node>,
    );
    yield* setTip(1, 'Beim Abwickeln: nie ein Ende durch den Ring ziehen');
    yield* rise(wrongLabel(), 0.5);
    yield* thread(1, 2.4, easeInOutCubic);
    yield* waitFor(0.5);
    // laid out: the knots pull tight
    yield* coilAlpha(0, 0.6);
    yield* knots(1, 1.8, easeOutCubic);
    yield* rise(note(), 0.5);
    yield* waitFor(1.4);
    yield* rise(rightLabel(), 0.5);
    yield* good(1, 3.2, (t) => 1 - Math.pow(1 - t, 2));
    yield* waitFor(2.0);
    yield* g().opacity(0, 0.5);
    g().remove();
  }

  // ------------------------------------------------------------ 2 · the eight
  {
    const g = createRef<Node>();
    const eight = createSignal(0);
    const left = createRef<Layout>();
    const right = createRef<Layout>();
    const note = createRef<Txt>();
    view.add(
      <Node ref={g}>
        <Cable geom={() => ({ pts: loopOrEight(-420, -170, 150, eight()) })} thickness={20} stripe={0} />
        <Cable geom={{ pts: loopOrEight(420, -170, 150, 0) }} thickness={20} stripe={0} />
        <Fist x={-420} y={-176} side={'left'} scale={0.7} part={'hand'} />
        <Fist x={420} y={-176} side={'left'} scale={0.7} part={'hand'} />
        <Layout ref={left} x={-420} y={330} layout direction={'column'} alignItems={'center'} gap={8} opacity={0}>
          <Layout direction={'row'} gap={14} alignItems={'center'}>
            <Mark good={false} size={42} />
            <Txt text={'verdreht sich zur Acht'} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
          </Layout>
          <Txt text={'falsch herum gedreht'} fontFamily={FONT} fontWeight={500} fontSize={30} fill={C.muted} />
        </Layout>
        <Layout ref={right} x={420} y={330} layout direction={'column'} alignItems={'center'} gap={8} opacity={0}>
          <Layout direction={'row'} gap={14} alignItems={'center'}>
            <Mark good size={42} />
            <Txt text={'liegt flach und rund'} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
          </Layout>
          <Txt text={'richtig herum'} fontFamily={FONT} fontWeight={500} fontSize={30} fill={C.muted} />
        </Layout>
        <Txt ref={note} y={455} text={'Nicht erzwingen: Lass das Kabel locker, es zeigt dir die Richtung.'} fontFamily={FONT} fontWeight={600} fontSize={36} fill={C.text} opacity={0} />
      </Node>,
    );
    yield* setTip(2, 'Die Schlaufe will zur Acht? Dann falsch herum gedreht');
    yield* waitFor(0.5);
    yield* all(eight(1, 2.0, easeInOutCubic), delay(0.8, rise(left(), 0.5)), delay(1.2, rise(right(), 0.5)));
    yield* waitFor(0.6);
    yield* rise(note(), 0.5);
    yield* waitFor(2.6);
    yield* g().opacity(0, 0.5);
    g().remove();
  }

  // ------------------------------------------------------------ 3 · not around the elbow
  {
    const g = createRef<Node>();
    const wrap = createSignal(0);
    const note = createRef<Layout>();
    const parts = elbowWrap(-470, 330, 40, 5, 210);
    const shown = (list: P3[][]) => () => {
      const k = wrap() * list.length;
      return list.slice(0, Math.ceil(k));
    };
    view.add(
      <Node ref={g}>
        {parts.back.map((pts, i) => (
          <Cable geom={{ pts }} thickness={16} stripe={0} opacity={() => (shown(parts.back)().length > i ? 1 : 0)} />
        ))}
        <Fist x={-470} y={40} side={'left'} arm={2} scale={0.95} part={'arm'} />
        <Fist x={-470} y={40} side={'left'} scale={0.95} part={'hand'} rotation={-90} />
        {parts.front.map((pts, i) => (
          <Cable geom={{ pts }} thickness={16} stripe={0} opacity={() => (shown(parts.front)().length > i ? 1 : 0)} />
        ))}
        <Layout ref={note} y={300} layout direction={'row'} gap={16} alignItems={'center'} opacity={0}>
          <Mark good={false} size={46} />
          <Txt text={'Jede Schlaufe verdreht das Kabel, und es wird gedehnt.'} fontFamily={FONT} fontWeight={600} fontSize={38} fill={C.text} />
        </Layout>
      </Node>,
    );
    yield* setTip(3, 'Nicht um Hand und Ellenbogen wickeln');
    yield* wrap(1, 2.0, linear);
    yield* rise(note(), 0.5);
    yield* waitFor(3.0);
    yield* g().opacity(0, 0.5);
    g().remove();
  }

  // ------------------------------------------------------------ 4 · thick cables: figure eights
  {
    const g = createRef<Node>();
    const trim = createSignal(0);
    const note = createRef<Txt>();
    const pts = figureEights(0, 30, 330, 300, 4);
    view.add(
      <Node ref={g}>
        <Rect y={30} width={1300} height={560} radius={30} fill={C.floor} />
        <Cable geom={{ pts, plugStart: true, plugEnd: true }} thickness={30} stripe={0} trim={trim} halo={C.floor} />
        <Txt ref={note} y={385} text={'Gleiches Prinzip: Jede Acht hat eine Schlaufe rechts- und eine linksherum.'} fontFamily={FONT} fontWeight={600} fontSize={36} fill={C.text} opacity={0} />
      </Node>,
    );
    yield* setTip(4, 'Dicke Kabel: in Achten auf den Boden legen');
    yield* trim(1, 4.0, easeInOutCubic);
    yield* rise(note(), 0.5);
    yield* waitFor(3.0);
    yield* g().opacity(0, 0.5);
    g().remove();
  }

  // ------------------------------------------------------------ 5 · small things
  {
    const g = createRef<Layout>();
    const rows: Node[] = [];
    const items = [
      ['Schlaufen etwa gleich groß und nicht zu eng.', 'Ein enger Knick schadet den Adern im Kabel.'],
      ['Mit Klettband sichern.', 'Nicht das Kabel um sich selbst knoten.'],
      ['Linkshänder: alles spiegelverkehrt.', 'Das Prinzip bleibt dasselbe.'],
    ];
    view.add(
      <Layout ref={g} y={40} layout direction={'column'} gap={44}>
        {items.map(([a, b]) => (
          <Layout ref={(n) => rows.push(n)} direction={'row'} gap={26} alignItems={'center'} opacity={0}>
            <Mark good size={54} />
            <Layout direction={'column'} gap={6}>
              <Txt text={a} fontFamily={FONT} fontWeight={700} fontSize={44} fill={C.text} />
              <Txt text={b} fontFamily={FONT} fontWeight={500} fontSize={34} fill={C.muted} />
            </Layout>
          </Layout>
        ))}
      </Layout>,
    );
    yield* setTip(5, 'Noch drei Kleinigkeiten');
    yield* sequence(1.1, ...rows.map((r) => rise(r, 0.5)));
    yield* waitFor(3.2);
  }
  yield* stopCard(view, 4);
});
