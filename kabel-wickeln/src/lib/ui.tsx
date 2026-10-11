// Shared 2D pieces: the stage bar (full at the top, or a small chip during split screens), ✓/✗
// marks, coloured tags, and the card at the end of each stage ("you may stop here").

import { Circle, Layout, Line, Node, Rect, Txt, View2D } from '@motion-canvas/2d';
import { SignalValue, all, createRef, easeInOutCubic, easeOutCubic, linear, waitFor } from '@motion-canvas/core';
import { STAGES } from './chapters';
import { fontsReady } from './fonts';
import { C, FONT } from './theme';

/** every scene starts like this: background and fonts */
export function* begin(view: View2D) {
  view.fill(C.bg);
  yield fontsReady();
}

/** a coloured tag such as "über" or "unter" */
export function Pill(props: { text: string; color: string; size?: number; ref?: (n: Rect) => void } & Partial<Record<'x' | 'y' | 'opacity' | 'scale', SignalValue<number>>>) {
  const size = props.size ?? 34;
  return (
    <Rect ref={props.ref} x={props.x ?? 0} y={props.y ?? 0} opacity={props.opacity ?? 1} scale={props.scale ?? 1} layout padding={[size * 0.22, size * 0.62]} radius={size} fill={props.color}>
      <Txt text={props.text} fontFamily={FONT} fontWeight={700} fontSize={size} fill={'#fff'} />
    </Rect>
  );
}

/** a tick or a cross in a circle (a box of its own size inside a layout) */
export function Mark(props: { good: boolean; size?: number; x?: number; y?: number; opacity?: SignalValue<number>; ref?: (n: Node) => void }) {
  const s = props.size ?? 56;
  return (
    <Rect ref={props.ref} width={s} height={s} x={props.x ?? 0} y={props.y ?? 0} opacity={props.opacity ?? 1}>
      <Circle layout={false} size={s} fill={props.good ? C.good : C.bad} />
      {props.good ? (
        <Line layout={false} points={[[-s * 0.22, 0], [-s * 0.05, s * 0.17], [s * 0.24, -s * 0.18]]} stroke={'#fff'} lineWidth={s * 0.12} lineCap={'round'} lineJoin={'round'} />
      ) : (
        <Line layout={false} points={[[-s * 0.18, -s * 0.18], [s * 0.18, s * 0.18], [0, 0], [s * 0.18, -s * 0.18], [-s * 0.18, s * 0.18]]} stroke={'#fff'} lineWidth={s * 0.12} lineCap={'round'} lineJoin={'round'} />
      )}
    </Rect>
  );
}

/** the bar at the top: where in the video we are (stage 1..7, 0 = before the first) */
export function StageBar(props: { current: number; ref?: (n: Layout) => void; opacity?: SignalValue<number>; y?: number }) {
  return (
    <Layout ref={props.ref} y={props.y ?? -496} layout direction={'row'} alignItems={'center'} gap={14} opacity={props.opacity ?? 1}>
      {STAGES.map((s, i) => {
        const n = i + 1;
        const done = n < props.current;
        const now = n === props.current;
        return (
          <Layout direction={'row'} alignItems={'center'} gap={9}>
            {i > 0 ? <Rect width={26} height={2} fill={C.faint} marginRight={5} /> : null}
            <Rect width={32} height={32} radius={16} fill={done ? C.good : now ? C.text : null} stroke={done || now ? null : C.muted} lineWidth={2} layout justifyContent={'center'} alignItems={'center'}>
              {done ? (
                <Line points={[[-7, 0], [-2, 5], [7, -5]]} stroke={'#fff'} lineWidth={3.5} lineCap={'round'} lineJoin={'round'} layout={false} />
              ) : (
                <Txt text={`${n}`} fontFamily={FONT} fontWeight={700} fontSize={18} fill={now ? '#fff' : C.muted} />
              )}
            </Rect>
            <Txt text={s.short} fontFamily={FONT} fontWeight={now ? 800 : 500} fontSize={26} fill={now ? C.text : C.muted} />
          </Layout>
        );
      })}
    </Layout>
  );
}

/** the small version of the stage bar for split screens: "3/7 · Schritt für Schritt" */
export function StageChip(props: { current: number; x?: number; y?: number; opacity?: SignalValue<number> }) {
  const s = STAGES[props.current - 1];
  return (
    <Rect x={props.x ?? 0} y={props.y ?? -510} layout padding={[6, 18]} radius={24} fill={C.plate} opacity={props.opacity ?? 1}>
      <Txt text={`${props.current}/${STAGES.length} · ${s.short}`} fontFamily={FONT} fontWeight={700} fontSize={24} fill={C.text} />
    </Rect>
  );
}

/** what the stop card says after a stage */
function stopLines(stage: number): [string, string | null] {
  if (stage === 1) return ['Schon mal gewickelt? Dann reicht das.', 'Zum ersten Mal? Weiter bis Stufe 3.'];
  if (stage >= STAGES.length) return ['Das war alles. Viel Spaß beim Wickeln!', null];
  return ['Verstanden? Dann kannst du hier aufhören.', null];
}

/**
 * The card at the end of a stage: done, you may stop here, or go on with the next stage.
 * Runs `hold` seconds; the next scene starts with the same card (`cardOut`) and fades it away.
 */
export function* stopCard(view: View2D, stage: number, hold = 6) {
  const card = createRef<Node>();
  const bar = createRef<Rect>();
  view.add(stopCardNode(stage, card, bar, 0));
  const c = card();
  c.opacity(0);
  c.scale(0.97);
  yield* all(c.opacity(1, 0.6, easeOutCubic), c.scale(1, 0.6, easeOutCubic));
  if (stage < STAGES.length) yield* bar().width(600, hold - 0.6, linear);
  else yield* waitFor(hold - 0.6);
}

/** the next scene opens on the card of the last stage and lets it go */
export function* cardOut(view: View2D, stage: number) {
  const card = createRef<Node>();
  const bar = createRef<Rect>();
  view.add(stopCardNode(stage, card, bar, 600));
  yield* waitFor(0.15);
  yield* all(card().opacity(0, 0.6, easeInOutCubic), card().scale(1.02, 0.6, easeInOutCubic));
  card().remove();
}

function stopCardNode(stage: number, card: ReturnType<typeof createRef<Node>>, bar: ReturnType<typeof createRef<Rect>>, barW: number) {
  const s = STAGES[stage - 1];
  const next = STAGES[stage];
  const [line1, line2] = stopLines(stage);
  return (
    <Node ref={card}>
      <Rect width={1920} height={1080} fill={C.bg} />
      <StageBar current={stage + 1} />
      <Layout layout direction={'column'} alignItems={'center'} gap={26} y={10}>
        <Layout direction={'row'} alignItems={'center'} gap={22}>
          <Rect width={70} height={70} radius={35} fill={C.good} layout justifyContent={'center'} alignItems={'center'}>
            <Line points={[[-15, 0], [-4, 11], [16, -11]]} stroke={'#fff'} lineWidth={7} lineCap={'round'} lineJoin={'round'} layout={false} />
          </Rect>
          <Txt text={`Stufe ${stage}: ${s.title}`} fontFamily={FONT} fontWeight={700} fontSize={52} fill={C.text} />
        </Layout>
        <Layout direction={'row'} alignItems={'center'} gap={18} marginTop={24}>
          <Rect width={34} height={34} radius={5} fill={C.text} />
          <Txt text={line1} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />
        </Layout>
        {line2 ? <Txt text={line2} fontFamily={FONT} fontWeight={600} fontSize={40} fill={C.text} /> : null}
        {next ? (
          <Layout direction={'column'} alignItems={'center'} gap={16} marginTop={30}>
            <Txt text={`Weiter mit Stufe ${stage + 1}: ${next.title}`} fontFamily={FONT} fontWeight={500} fontSize={36} fill={C.muted} />
            <Rect width={600} height={6} radius={3} fill={'#dcd5c8'} layout={false} y={42}>
              <Rect ref={bar} x={-300} offsetX={-1} width={barW} height={6} radius={3} fill={C.muted} />
            </Rect>
          </Layout>
        ) : null}
      </Layout>
    </Node>
  );
}
