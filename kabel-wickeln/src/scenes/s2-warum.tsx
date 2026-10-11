// Stage 2, why: every loop turns the cable once around itself. Coiled the same way every time, the
// turns add up; over and under, they cancel. Laid out, the twisted cable throws pigtails and knots,
// the other one lies flat. The yellow stripe printed on the cable shows the twist.

import { Layout, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, createSignal, delay, easeInOutCubic, easeOutCubic, sequence, waitFor } from '@motion-canvas/core';
import { CurlRowOpts, Kind, curlRow, kinkLine, rowTwist } from '../lib/coil';
import { C, FONT } from '../lib/theme';
import { Mark, Spin, StageBar, begin, cardOut, pop, rise, stopCard, tints } from '../lib/ui';
import { Cable } from '../nodes/Cable';

const SAME: Kind[] = ['over', 'over', 'over', 'over', 'over', 'over'];
const ALT: Kind[] = ['over', 'under', 'over', 'under', 'over', 'under'];
const X0 = -520;
const X1 = 860;
const ROW_A = -130;
const ROW_B = 270;
const R = 70;
const LEAD = 40;
const KINKS = [-210, 170, 560];
const turns = (n: number) => {
  const k = Math.round(n);
  return `= ${k} ${Math.abs(k) === 1 ? 'Drehung' : 'Drehungen'}`;
};

export default makeScene2D(function* (view) {
  yield* begin(view);
  const trim = createSignal(0);
  const open = createSignal(0);
  const relax = createSignal(0);
  const kink = createSignal(0);
  const stripe = createSignal(0);
  const countA = createSignal(0);
  const countB = createSignal(0);

  const rowA = (): CurlRowOpts => ({ x0: X0, x1: X1, y: ROW_A, kinds: SAME, r: R, lead: LEAD, open: open() });
  const rowB = (): CurlRowOpts => ({ x0: X0, x1: X1, y: ROW_B, kinds: ALT, r: R, lead: LEAD, open: open() });
  const geomA = () => {
    const o = rowA();
    if (kink() > 0) {
      const pts = kinkLine(X0, X1, ROW_A - 0, KINKS, kink());
      return { pts, phi: pts.map((p) => rowTwist(o, p[0], 1)) };
    }
    const c = curlRow(o);
    return { pts: c.pts, phi: c.pts.map((p) => rowTwist(o, p[0], open())), tint: tints(c.owner, SAME, () => 1 - open()) };
  };
  const geomB = () => {
    const o = rowB();
    const c = curlRow(o);
    return { pts: c.pts, phi: c.pts.map((p) => rowTwist(o, p[0], open() * (1 - relax()))), tint: tints(c.owner, ALT, () => 1 - open()) };
  };
  // the curls of the rows when they are drawn in: where each one sits
  const centresA = curlRow(rowA()).centres;
  const centresB = curlRow(rowB()).centres;

  const head = createRef<Txt>();
  const head2 = createRef<Txt>();
  const head3 = createRef<Txt>();
  const labelA = createRef<Layout>();
  const labelB = createRef<Layout>();
  const spinsA: Node[] = [];
  const spinsB: Node[] = [];
  const sumA = createRef<Txt>();
  const sumB = createRef<Txt>();
  const verdictA = createRef<Layout>();
  const verdictB = createRef<Layout>();
  const legend = createRef<Layout>();
  const rows = createRef<Node>();

  view.add(
    <Node>
      <Txt ref={head} y={-372} text={'Jede Schlaufe dreht das Kabel einmal um sich selbst.'} fontFamily={FONT} fontWeight={700} fontSize={52} fill={C.text} opacity={0} />
      <Txt ref={head2} y={-372} text={'Beim Auslegen kommen die Drehungen wieder heraus.'} fontFamily={FONT} fontWeight={700} fontSize={52} fill={C.text} opacity={0} />
      <Txt ref={head3} y={-372} text={'Darum abwechselnd: Die Drehungen heben sich auf.'} fontFamily={FONT} fontWeight={700} fontSize={52} fill={C.text} opacity={0} />
      <Node ref={rows}>
        <Layout ref={labelA} x={-860} y={ROW_A - 30} offsetX={-1} layout direction={'column'} gap={8} opacity={0}>
          <Txt text={'Immer gleich'} fontFamily={FONT} fontWeight={700} fontSize={40} fill={C.text} />
          <Txt text={'herum gewickelt'} fontFamily={FONT} fontWeight={500} fontSize={32} fill={C.muted} />
        </Layout>
        <Layout ref={labelB} x={-860} y={ROW_B - 30} offsetX={-1} layout direction={'column'} gap={8} opacity={0}>
          <Txt text={'Over-Under'} fontFamily={FONT} fontWeight={700} fontSize={40} fill={C.text} />
          <Txt text={'über, unter, über …'} fontFamily={FONT} fontWeight={500} fontSize={32} fill={C.muted} />
        </Layout>
        <Cable geom={geomA} thickness={20} trim={trim} stripe={stripe} />
        <Cable geom={geomB} thickness={20} trim={trim} stripe={stripe} />
        {centresA.map((c) => (
          <Spin ref={(n) => spinsA.push(n)} x={c.x} y={ROW_A - R - 70} color={C.over} size={42} opacity={0} />
        ))}
        {centresB.map((c) => (
          <Spin ref={(n) => spinsB.push(n)} x={c.x} y={ROW_B - R - 70} color={c.kind === 'over' ? C.over : C.under} ccw={c.kind === 'under'} size={42} opacity={0} />
        ))}
        <Txt ref={sumA} x={-860} y={ROW_A + 70} offsetX={-1} text={() => turns(countA())} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.bad} opacity={0} />
        <Txt ref={sumB} x={-860} y={ROW_B + 70} offsetX={-1} text={() => turns(countB())} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.good} opacity={0} />
        <Layout ref={verdictA} x={X0 + 40} y={ROW_A + 110} offsetX={-1} layout direction={'row'} alignItems={'center'} gap={16} opacity={0}>
          <Mark good={false} size={44} />
          <Txt text={'verdreht: Kringel, Knoten, Kabelbruch innen'} fontFamily={FONT} fontWeight={600} fontSize={36} fill={C.text} />
        </Layout>
        <Layout ref={verdictB} x={X0 + 40} y={ROW_B + 110} offsetX={-1} layout direction={'row'} alignItems={'center'} gap={16} opacity={0}>
          <Mark good size={44} />
          <Txt text={'liegt flach, hält länger'} fontFamily={FONT} fontWeight={600} fontSize={36} fill={C.text} />
        </Layout>
        <Layout ref={legend} x={X1} y={-290} offsetX={1} layout direction={'row'} alignItems={'center'} gap={14} opacity={0}>
          <Rect width={70} height={20} radius={10} fill={C.cable} layout justifyContent={'center'} alignItems={'center'}>
            <Rect width={56} height={4} radius={2} fill={C.stripe} />
          </Rect>
          <Txt text={'gelber Streifen auf dem Kabel = zeigt die Drehung'} fontFamily={FONT} fontWeight={500} fontSize={28} fill={C.muted} />
        </Layout>
      </Node>
    </Node>,
  );
  view.add(<StageBar current={2} />);
  yield* cardOut(view, 1);

  yield* rise(head(), 0.6);
  yield* all(rise(labelA(), 0.5), delay(0.2, rise(labelB(), 0.5)));
  // the loops one by one, each with its turn; the sums count along
  const n = SAME.length;
  const draw = 4.2;
  yield* all(
    trim(1, draw, easeInOutCubic),
    sequence(
      draw / n,
      waitFor(0.35),
      ...Array.from({ length: n }, (_, k) =>
        all(
          pop(spinsA[k]),
          pop(spinsB[k]),
          countA(k + 1, 0.3),
          countB(ALT.slice(0, k + 1).reduce((s, x) => s + (x === 'over' ? 1 : -1), 0), 0.3),
          k === 0 ? all(rise(sumA(), 0.4), rise(sumB(), 0.4)) : waitFor(0),
        ),
      ),
    ),
  );
  yield* waitFor(1.6);

  // laid out: the curls open, the turns come out as twist
  yield* all(head().opacity(0, 0.4), rise(head2(), 0.6), ...spinsA.map((s) => s.opacity(0, 0.4)), ...spinsB.map((s) => s.opacity(0, 0.4)));
  yield* all(stripe(1, 0.6), rise(legend(), 0.6));
  yield* waitFor(0.6);
  yield* open(1, 2.4, easeInOutCubic);
  yield* waitFor(0.4);
  // the twisted one throws pigtails; on the other one the turns cancel
  yield* all(kink(1, 1.4, easeOutCubic), relax(1, 1.8, easeInOutCubic));
  yield* all(rise(verdictA(), 0.5), delay(0.4, rise(verdictB(), 0.5)));
  yield* waitFor(1.4);
  yield* head2().opacity(0, 0.4);
  yield* rise(head3(), 0.6);
  yield* waitFor(3.2);
  yield* stopCard(view, 2);
});
