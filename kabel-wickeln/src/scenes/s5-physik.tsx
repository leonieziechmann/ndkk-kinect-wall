// Stage 5, for the curious: where the twist comes from. A band (yellow on top) with one loop: pull
// the ends apart and the loop turns into one full twist; an "unter" loop twists the other way.
// Loops and twists turn into each other, their sum stays the same (Călugăreanu's theorem, the same
// rule that governs how DNA coils). Then the sums of both ways of coiling.

import { Layout, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, createSignal, easeInOutCubic, waitFor } from '@motion-canvas/core';
import { CurlRowOpts, Kind, curlRow, rowTwist } from '../lib/coil';
import { C, FONT } from '../lib/theme';
import { Pill, Spin, StageBar, Words, begin, cardOut, pop, rise, stopCard } from '../lib/ui';
import { Ribbon } from '../nodes/Ribbon';

const ROW_A = -110;
const ROW_B = 210;

function band(kind: Kind, y: number, open: number) {
  const spread = 140 * open;
  const o: CurlRowOpts = { x0: -560 - spread, x1: 560 + spread, y, kinds: [kind], r: 120, lead: 420 + spread, open };
  const c = curlRow(o);
  // the turn spreads over more than the curl itself, so that it is easy to see
  return { pts: c.pts, phi: c.pts.map((p) => rowTwist(o, p[0], open, 2.4)) };
}

export default makeScene2D(function* (view) {
  yield* begin(view);
  const openA = createSignal(0);
  const openB = createSignal(0);
  const head = createRef<Txt>();
  const sub = createRef<Txt>();
  const capA = createRef<Txt>();
  const capB = createRef<Txt>();
  const pillA = createRef<Node>();
  const pillB = createRef<Node>();
  const bands = createRef<Node>();
  const rule = createRef<Layout>();
  const sums = createRef<Layout>();
  const ribbonA = createRef<Ribbon>();
  const ribbonB = createRef<Ribbon>();
  const spinA = createRef<Node>();
  const spinB = createRef<Node>();

  view.add(
    <Node>
      <Txt ref={head} y={-380} text={'Woher kommt die Drehung?'} fontFamily={FONT} fontWeight={800} fontSize={60} fill={C.text} opacity={0} />
      <Txt ref={sub} y={-305} text={'Stell dir das Kabel als Band vor: oben gelb, unten dunkel.'} fontFamily={FONT} fontWeight={500} fontSize={36} fill={C.muted} opacity={0} />
      <Node ref={bands}>
        <Ribbon ref={ribbonA} geom={() => band('over', ROW_A, openA())} breadth={46} opacity={0} />
        <Ribbon ref={ribbonB} geom={() => band('under', ROW_B, openB())} breadth={46} opacity={0} />
        <Node ref={pillA} x={-760} y={ROW_A - 60} opacity={0}>
          <Pill text={'über'} color={C.over} size={32} />
        </Node>
        <Node ref={pillB} x={-760} y={ROW_B - 60} opacity={0}>
          <Pill text={'unter'} color={C.under} size={32} />
        </Node>
        <Spin ref={spinA} x={0} y={ROW_A - 85} color={C.over} size={56} opacity={0} />
        <Spin ref={spinB} x={0} y={ROW_B - 85} color={C.under} size={56} ccw opacity={0} />
        <Txt ref={capA} y={ROW_A + 80} text={'Enden auseinanderziehen: Aus der Schlaufe wird eine ganze Drehung.'} fontFamily={FONT} fontWeight={600} fontSize={36} fill={C.text} opacity={0} />
        <Txt ref={capB} y={ROW_B + 80} text={'Die Unter-Schlaufe dreht genau andersherum.'} fontFamily={FONT} fontWeight={600} fontSize={36} fill={C.text} opacity={0} />
      </Node>
      <Layout ref={rule} y={-20} layout direction={'column'} alignItems={'center'} gap={18} opacity={0}>
        <Txt text={'Schlaufen und Drehungen verwandeln sich ineinander.'} fontFamily={FONT} fontWeight={700} fontSize={46} fill={C.text} />
        <Txt text={'Zusammengezählt bleibt es immer gleich viel.'} fontFamily={FONT} fontWeight={700} fontSize={46} fill={C.text} />
        <Rect width={900} height={2} fill={C.faint} marginTop={16} marginBottom={8} />
        <Txt text={'Mathematisch: Verschlingungszahl = Verdrillung + Windung'} fontFamily={FONT} fontWeight={500} fontSize={32} fill={C.muted} />
        <Txt text={'(Satz von Călugăreanu – derselbe Satz beschreibt, wie sich DNA verdrillt)'} fontFamily={FONT} fontWeight={500} fontSize={30} fill={C.muted} />
      </Layout>
      <Layout ref={sums} y={10} layout direction={'column'} alignItems={'start'} gap={40} opacity={0}>
        <Words
          size={48}
          parts={[
            ['Immer gleich:   ', C.text],
            ['1 + 1 + 1 + 1 + 1 + 1', C.over],
            [' = 6 Drehungen', C.bad],
          ]}
        />
        <Words
          size={48}
          parts={[
            ['Over-Under:   ', C.text],
            ['1 ', C.over],
            ['− 1 ', C.under],
            ['+ 1 ', C.over],
            ['− 1 ', C.under],
            ['+ 1 ', C.over],
            ['− 1', C.under],
            [' = 0', C.good],
          ]}
        />
      </Layout>
    </Node>,
  );
  view.add(<StageBar current={5} />);
  yield* cardOut(view, 4);

  yield* rise(head(), 0.6);
  yield* rise(sub(), 0.5);
  yield* all(ribbonA().opacity(1, 0.6), rise(pillA(), 0.5));
  yield* waitFor(1.0);
  yield* openA(1, 3.0, easeInOutCubic);
  yield* all(rise(capA(), 0.5), pop(spinA()));
  yield* waitFor(1.6);
  yield* all(ribbonB().opacity(1, 0.6), rise(pillB(), 0.5));
  yield* waitFor(0.6);
  yield* openB(1, 3.0, easeInOutCubic);
  yield* all(rise(capB(), 0.5), pop(spinB()));
  yield* waitFor(2.4);

  // the rule
  yield* all(bands().opacity(0, 0.5), sub().opacity(0, 0.5));
  yield* rise(rule(), 0.6);
  yield* waitFor(5.0);
  yield* rule().opacity(0, 0.5);
  yield* head().opacity(0, 0.3);
  head().text('Darum Over-Under');
  yield* all(head().opacity(1, 0.4), rise(sums(), 0.6));
  yield* waitFor(4.2);
  yield* stopCard(view, 5, 6);
});
