// Title: what this is about, and how it is built: from the overview down to the details, and you
// may stop as soon as you have it. A cable draws itself in curls underneath, over and under.

import { Layout, Node, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, createSignal, delay, easeInOutCubic, easeOutBack, waitFor } from '@motion-canvas/core';
import { Kind, curlRow } from '../lib/coil';
import { P3 } from '../lib/geom';
import { clamp } from '../lib/math';
import { C, FONT } from '../lib/theme';
import { Pill, StageBar, Words, begin, rise, tints } from '../lib/ui';
import { Cable } from '../nodes/Cable';

const KINDS: Kind[] = ['over', 'under', 'over', 'under', 'over', 'under', 'over'];

/** how far along the cable (0..1) the lowest point near x is */
function bottomOf(pts: P3[], x: number, half: number) {
  let best = 0;
  for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i][0] - x) < half && pts[i][1] > pts[best][1]) best = i;
  return best / Math.max(1, pts.length - 1);
}

export default makeScene2D(function* (view) {
  yield* begin(view);
  const title = createRef<Txt>();
  const sub = createRef<Layout>();
  const line1 = createRef<Txt>();
  const line2 = createRef<Txt>();
  const bar0 = createRef<Layout>();
  const bar1 = createRef<Layout>();
  const group = createRef<Node>();
  const trim = createSignal(0);
  const row = curlRow({ x0: -760, x1: 760, y: 150, kinds: KINDS, r: 62, lead: 70 });
  const pills: Node[] = [];

  view.add(
    <Node ref={group}>
      <Txt ref={title} y={-250} text={'Kabel richtig aufwickeln'} fontFamily={FONT} fontWeight={800} fontSize={104} fill={C.text} letterSpacing={-2} />
      <Words
        ref={sub}
        y={-140}
        size={56}
        weight={600}
        parts={[
          ['Die ', C.muted],
          ['Over', C.over],
          ['-', C.muted],
          ['Under', C.under],
          ['-Methode', C.muted],
        ]}
      />
      <Cable geom={{ pts: row.pts, tint: tints(row.owner, KINDS) }} trim={trim} stripe={0} />
      {row.centres.map((c, i) => {
        // shows up when the drawn cable reaches the bottom of its curl
        const at = bottomOf(row.pts, c.x, 120);
        const k = () => clamp((trim() - at) * 14);
        return (
          <Pill ref={(n) => pills.push(n)} x={c.x} y={c.y + 118} text={c.kind === 'over' ? 'über' : 'unter'} color={c.kind === 'over' ? C.over : C.under} size={26} opacity={k} scale={() => 0.7 + 0.3 * easeOutBack(k())} />
        );
      })}
      <Txt ref={line1} y={360} text={'Erst der Überblick, dann wird es immer genauer.'} fontFamily={FONT} fontWeight={600} fontSize={42} fill={C.text} opacity={0} />
      <Txt ref={line2} y={420} text={'Sobald du es verstanden hast, kannst du ausmachen.'} fontFamily={FONT} fontWeight={500} fontSize={36} fill={C.muted} opacity={0} />
    </Node>,
  );
  view.add(<StageBar ref={bar0} current={0} opacity={0} />);
  view.add(<StageBar ref={bar1} current={1} opacity={0} />);
  title().opacity(0);
  sub().opacity(0);

  yield* waitFor(0.3);
  yield* all(
    rise(title(), 0.8, 30),
    delay(0.35, rise(sub(), 0.8, 24)),
    delay(
      0.6,
      trim(1, 2.6, easeInOutCubic),
    ),
  );
  yield* rise(line1(), 0.6);
  yield* waitFor(0.4);
  yield* all(rise(line2(), 0.6), bar0().opacity(1, 0.8));
  yield* waitFor(2.6);
  // on to stage 1
  yield* all(group().opacity(0, 0.7, easeInOutCubic), bar0().opacity(0, 0.7), bar1().opacity(1, 0.7));
});
