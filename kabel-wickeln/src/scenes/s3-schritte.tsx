// Stage 3, step by step: the same coiling as in stage 1, slowly, one step at a time, with what each
// hand does. A round inset shows the loop pulled apart: over, the cable runs across itself; under,
// it runs beneath itself.

import { Circle, Layout, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, createSignal, easeInOutCubic, easeOutBack, easeOutCubic, linear, waitFor } from '@motion-canvas/core';
import { Kind, curlRow } from '../lib/coil';
import { BASE, HX, HY, KINDS, handView } from '../lib/handview';
import { C, FONT } from '../lib/theme';
import { Pill, Spin, StageBar, begin, cardOut, rise, stopCard, tints } from '../lib/ui';
import { Cable } from '../nodes/Cable';

const TX = -150;
const INSET = { x: 560, y: 230, r: 165 };

interface Step {
  title: string;
  color: string;
  text: string;
}

const STEPS: Step[] = [
  { title: 'Ende in die linke Hand', color: C.text, text: 'Den Stecker ein Stück heraushängen lassen.\nDie linke Hand hält nur fest.' },
  { title: 'Kabel greifen', color: C.text, text: 'Mit der rechten Hand am Kabel entlang,\netwa eine Armlänge weit. Daumen oben.' },
  { title: 'Über-Schlaufe', color: C.over, text: 'Hochführen und das Kabel dabei mit den\nFingern leicht nach vorn rollen. Die Schlaufe\nlegt sich von selbst rund in die Hand.' },
  { title: 'Unter-Schlaufe', color: C.under, text: 'Rechte Hand umdrehen, Handfläche nach oben,\nso greifen. Beim Hochführen zurückdrehen:\nDas Kabel läuft unter sich selbst durch.' },
  { title: 'Immer abwechselnd', color: C.text, text: 'Über, unter, über, unter … bis zum Ende.\nAlle Schlaufen etwa gleich groß.' },
  { title: 'Sichern', color: C.text, text: 'Klettband um den Ring. Fertig.\nNicht das Kabel um sich selbst knoten.' },
];

/** one curl as in stage 2, for the inset */
function curl(kind: Kind) {
  const o = { x0: -240, x1: 240, y: -22, kinds: [kind], r: 96, lead: 130 };
  const c = curlRow(o);
  return { pts: c.pts, tint: tints(c.owner, [kind]) };
}

export default makeScene2D(function* (view) {
  yield* begin(view);
  const p = createSignal(0);
  /** the right fist rolls the cable a little while it lifts an "über" loop */
  const handTurn = () => {
    const k = Math.floor(p());
    const f = p() - k;
    if (KINDS[k] !== 'over' || f < 0.28 || f > 0.82) return 0;
    return 24 * Math.sin((Math.PI * (f - 0.28)) / 0.54);
  };
  const hv = handView(p, { handTurn });
  const hand = () => hv.state().hand;

  const stepNo = createRef<Txt>();
  const title = createRef<Txt>();
  const text = createRef<Txt>();
  const card = createRef<Layout>();
  const inset = createRef<Node>();
  const overCurl = createRef<Node>();
  const underCurl = createRef<Node>();
  const insetPill = createRef<Node>();
  const insetText = createRef<Txt>();
  const tag = createRef<Rect>();
  const tagText = createRef<Txt>();
  const spin = createRef<Node>();
  const spinCcw = createRef<Node>();
  const ring = createRef<Circle>();
  const strap = createRef<Node>();
  const insetKind = createSignal<Kind>('over');

  view.add(hv.node);
  view.add(
    <Node>
      {/* a pulse around the left fist for step 1 */}
      <Circle ref={ring} x={HX} y={HY + 20} size={150} stroke={C.over} lineWidth={6} opacity={0} />
      {/* the strap of step 6, at the bottom of the coil */}
      <Node ref={strap} x={HX} y={HY + BASE.loop / Math.PI + 4} opacity={0}>
        <Rect width={34} height={78} radius={8} fill={'#cf3f37'} stroke={'#8f2420'} lineWidth={3} />
        <Rect width={34} height={14} y={-12} fill={'#a92f29'} />
      </Node>
      {/* a tag that follows the right hand */}
      <Rect
        ref={tag}
        x={() => hand().x + 105}
        y={() => hand().y - 70}
        offsetX={-1}
        layout
        padding={[10, 20]}
        radius={24}
        fill={C.paper}
        stroke={C.faint}
        lineWidth={2}
        opacity={0}
      >
        <Txt ref={tagText} text={'Daumen oben'} fontFamily={FONT} fontWeight={600} fontSize={30} fill={C.text} />
      </Rect>
      <Node x={() => hand().x + 10} y={() => hand().y - 95}>
        <Spin ref={spin} color={C.over} size={64} opacity={0} />
        <Spin ref={spinCcw} color={C.under} size={64} ccw opacity={0} />
      </Node>
    </Node>,
  );
  view.add(
    <Layout ref={card} x={TX} y={-350} offsetX={-1} offsetY={-1} layout direction={'column'} gap={14}>
      <Txt ref={stepNo} text={'Schritt 1 von 6'} fontFamily={FONT} fontWeight={600} fontSize={30} fill={C.muted} />
      <Txt ref={title} text={STEPS[0].title} fontFamily={FONT} fontWeight={800} fontSize={58} fill={C.text} />
      <Txt ref={text} text={STEPS[0].text} fontFamily={FONT} fontWeight={500} fontSize={34} lineHeight={50} fill={C.text} marginTop={6} />
    </Layout>,
  );
  view.add(
    <Node ref={inset} x={INSET.x} y={INSET.y} opacity={0}>
      <Circle size={INSET.r * 2} fill={C.paper} stroke={C.faint} lineWidth={4} />
      <Circle size={INSET.r * 2 - 4} clip>
        <Node ref={overCurl}>
          <Cable geom={curl('over')} thickness={22} halo={C.paper} stripe={0} />
        </Node>
        <Node ref={underCurl} opacity={0}>
          <Cable geom={curl('under')} thickness={22} halo={C.paper} stripe={0} />
        </Node>
      </Circle>
      <Node ref={insetPill} y={INSET.r + 10}>
        <Pill text={'über'} color={C.over} size={30} opacity={() => (insetKind() === 'over' ? 1 : 0)} />
        <Pill text={'unter'} color={C.under} size={30} opacity={() => (insetKind() === 'under' ? 1 : 0)} />
      </Node>
      <Txt
        ref={insetText}
        y={INSET.r + 66}
        text={() => (insetKind() === 'over' ? 'läuft oben drüber' : 'läuft unten durch')}
        fontFamily={FONT}
        fontWeight={500}
        fontSize={28}
        fill={C.muted}
      />
    </Node>,
  );
  view.add(<StageBar current={3} />);
  card().opacity(0);
  strap().scale(0.4);

  const showStep = function* (i: number) {
    if (i > 0) yield* card().opacity(0, 0.3);
    stepNo().text(`Schritt ${i + 1} von ${STEPS.length}`);
    title().text(STEPS[i].title);
    title().fill(STEPS[i].color);
    text().text(STEPS[i].text);
    yield* rise(card(), 0.5, 18);
  };
  const setInset = function* (kind: Kind) {
    if (insetKind() === kind) return;
    insetKind(kind);
    yield* all(overCurl().opacity(kind === 'over' ? 1 : 0, 0.35), underCurl().opacity(kind === 'under' ? 1 : 0, 0.35));
  };
  const showTag = function* (t: string) {
    tagText().text(t);
    yield* tag().opacity(1, 0.3);
  };

  yield* cardOut(view, 2);

  // 1 · the end into the left hand
  yield* showStep(0);
  ring().scale(0.7);
  yield* all(ring().opacity(1, 0.3), ring().scale(1.25, 1.2, easeOutCubic));
  yield* ring().opacity(0, 0.4);
  yield* waitFor(1.6);

  // 2 · take the cable
  yield* showStep(1);
  yield* all(p(0.28, 2.2, easeInOutCubic), waitFor(0.8));
  yield* showTag('Daumen oben');
  yield* waitFor(1.6);

  // 3 · the over loop
  yield* showStep(2);
  yield* all(tag().opacity(0, 0.3), rise(inset(), 0.5));
  yield* waitFor(0.6);
  yield* all(p(0.82, 3.4, easeInOutCubic), spin().opacity(1, 0.4));
  yield* all(spin().opacity(0, 0.3), p(1, 0.8, linear));
  yield* waitFor(2.2);

  // 4 · the under loop: turn the hand over first, slowly
  yield* showStep(3);
  yield* setInset('under');
  yield* waitFor(0.8);
  yield* p(1.27, 2.6, easeInOutCubic);
  yield* showTag('Handfläche oben');
  yield* waitFor(1.6);
  yield* all(tag().opacity(0, 0.3), p(1.82, 3.6, easeInOutCubic), spinCcw().opacity(1, 0.4));
  yield* all(spinCcw().opacity(0, 0.3), p(2, 0.8, linear));
  yield* waitFor(2.2);

  // 5 · on and on
  yield* showStep(4);
  for (let k = 2; k < KINDS.length; k++) {
    yield* all(p(k + 1, 1.7, linear), setInset(KINDS[k]));
  }
  yield* waitFor(1.2);

  // 6 · fasten it
  yield* showStep(5);
  yield* all(inset().opacity(0, 0.4), strap().opacity(1, 0.3), strap().scale(1, 0.5, easeOutBack));
  yield* waitFor(3.4);
  yield* stopCard(view, 3);
});
