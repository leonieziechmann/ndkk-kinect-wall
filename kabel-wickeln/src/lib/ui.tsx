// Shared pieces of the picture: the stage bar at the top, labels, the card at the end of each stage
// ("Hier kannst du aufhören") and small animation helpers.

import { Circle, Layout, Line, Node, Rect, Txt, TxtProps, View2D } from '@motion-canvas/2d';
import { SignalValue, all, createRef, delay, easeInOutCubic, easeOutBack, easeOutCubic, linear, waitFor } from '@motion-canvas/core';
import { STAGES } from './chapters';
import { fontsReady } from './fonts';
import { C, FONT } from './theme';

export const T = (props: TxtProps) => <Txt fontFamily={FONT} fill={C.text} fontWeight={500} {...props} />;

/** a coloured tag such as "über" or "unter" */
export function Pill(props: { text: string; color: string; size?: number; ref?: (n: Rect) => void } & Partial<Record<'x' | 'y' | 'opacity' | 'scale', SignalValue<number>>>) {
  const size = props.size ?? 34;
  return (
    <Rect
      ref={props.ref}
      x={props.x ?? 0}
      y={props.y ?? 0}
      opacity={props.opacity ?? 1}
      scale={props.scale ?? 1}
      layout
      padding={[size * 0.22, size * 0.62]}
      radius={size}
      fill={props.color}
      shadowColor={'rgba(0,0,0,0.12)'}
      shadowBlur={10}
      shadowOffsetY={3}
    >
      <Txt text={props.text} fontFamily={FONT} fontWeight={700} fontSize={size} fill={'#fff'} />
    </Rect>
  );
}

/** a tick or a cross in a circle (a box of its own size inside a layout) */
export function Mark(props: { good: boolean; size?: number; x?: number; y?: number; opacity?: number; ref?: (n: Node) => void }) {
  const s = props.size ?? 56;
  const color = props.good ? C.good : C.bad;
  return (
    <Rect ref={props.ref} width={s} height={s} x={props.x ?? 0} y={props.y ?? 0} opacity={props.opacity ?? 1}>
      <Circle layout={false} size={s} fill={color} />
      {props.good ? (
        <Line layout={false} points={[[-s * 0.22, 0], [-s * 0.05, s * 0.17], [s * 0.24, -s * 0.18]]} stroke={'#fff'} lineWidth={s * 0.12} lineCap={'round'} lineJoin={'round'} />
      ) : (
        <Line layout={false} points={[[-s * 0.18, -s * 0.18], [s * 0.18, s * 0.18], [0, 0], [s * 0.18, -s * 0.18], [-s * 0.18, s * 0.18]]} stroke={'#fff'} lineWidth={s * 0.12} lineCap={'round'} lineJoin={'round'} />
      )}
    </Rect>
  );
}

/** the bar at the top: where in the video we are (stage 1..5, 0 = before the first) */
export function StageBar(props: { current: number; ref?: (n: Layout) => void; opacity?: number }) {
  return (
    <Layout ref={props.ref} y={-490} layout direction={'row'} alignItems={'center'} gap={18} opacity={props.opacity ?? 1}>
      {STAGES.map((s, i) => {
        const n = i + 1;
        const done = n < props.current;
        const now = n === props.current;
        return (
          <Layout direction={'row'} alignItems={'center'} gap={10}>
            {i > 0 ? <Rect width={36} height={2} fill={done || now ? C.muted : C.faint} marginRight={8} /> : null}
            <Rect width={34} height={34} radius={17} fill={done ? C.good : now ? C.text : null} stroke={done || now ? null : C.faint} lineWidth={2} layout justifyContent={'center'} alignItems={'center'}>
              {done ? (
                <Line points={[[-7, 0], [-2, 5], [7, -5]]} stroke={'#fff'} lineWidth={3.5} lineCap={'round'} lineJoin={'round'} layout={false} />
              ) : (
                <Txt text={`${n}`} fontFamily={FONT} fontWeight={700} fontSize={19} fill={now ? '#fff' : C.faint} />
              )}
            </Rect>
            <Txt text={s.short} fontFamily={FONT} fontWeight={now ? 700 : 500} fontSize={22} fill={now ? C.text : done ? C.muted : C.faint} />
          </Layout>
        );
      })}
    </Layout>
  );
}

/** every scene starts like this: background and fonts */
export function* begin(view: View2D) {
  view.fill(C.bg);
  yield fontsReady();
}

/**
 * The card at the end of a stage: done, you may stop here, or go on with the next stage.
 * Runs `hold` seconds; the next scene starts with the same card (`cardOut`) and fades it away.
 */
export function* stopCard(view: View2D, stage: number, hold = 5.5) {
  const card = createRef<Node>();
  const bar = createRef<Rect>();
  view.add(stopCardNode(stage, card, bar, 0));
  const c = card();
  c.opacity(0);
  c.scale(0.96);
  yield* all(c.opacity(1, 0.6, easeOutCubic), c.scale(1, 0.6, easeOutCubic));
  if (stage < STAGES.length) yield* bar().width(560, hold - 0.6, linear);
  else yield* waitFor(hold - 0.6);
}

/** the next scene opens on the card of the last stage and lets it go */
export function* cardOut(view: View2D, stage: number) {
  const card = createRef<Node>();
  const bar = createRef<Rect>();
  view.add(stopCardNode(stage, card, bar, 560));
  yield* waitFor(0.15);
  yield* all(card().opacity(0, 0.6, easeInOutCubic), card().scale(1.03, 0.6, easeInOutCubic));
  card().remove();
}

function stopCardNode(stage: number, card: ReturnType<typeof createRef<Node>>, bar: ReturnType<typeof createRef<Rect>>, barW: number) {
  const s = STAGES[stage - 1];
  const next = STAGES[stage];
  return (
    <Node ref={card}>
      <Rect width={1920} height={1080} fill={C.bg} />
      <StageBar current={stage + 1} />
      <Layout layout direction={'column'} alignItems={'center'} gap={26} y={10}>
        <Layout direction={'row'} alignItems={'center'} gap={22}>
          <Rect width={70} height={70} radius={35} fill={C.good} layout justifyContent={'center'} alignItems={'center'}>
            <Line points={[[-15, 0], [-4, 11], [16, -11]]} stroke={'#fff'} lineWidth={7} lineCap={'round'} lineJoin={'round'} layout={false} />
          </Rect>
          <Txt text={`Stufe ${stage}: ${s.title}`} fontFamily={FONT} fontWeight={700} fontSize={50} fill={C.text} />
        </Layout>
        <Layout direction={'row'} alignItems={'center'} gap={18} marginTop={24}>
          <Rect width={34} height={34} radius={5} fill={C.text} />
          <Txt text={next ? 'Verstanden? Dann kannst du hier aufhören.' : 'Das war alles. Viel Spaß beim Wickeln!'} fontFamily={FONT} fontWeight={600} fontSize={44} fill={C.text} />
        </Layout>
        {next ? (
          <Layout direction={'column'} alignItems={'center'} gap={16} marginTop={36}>
            <Txt text={`Weiter mit Stufe ${stage + 1}: ${next.title}`} fontFamily={FONT} fontWeight={500} fontSize={34} fill={C.muted} />
            <Rect width={560} height={6} radius={3} fill={C.floor} layout={false} y={40}>
              <Rect ref={bar} x={-280} offsetX={-1} width={barW} height={6} radius={3} fill={C.muted} />
            </Rect>
          </Layout>
        ) : null}
      </Layout>
    </Node>
  );
}

/** fade and rise a node into place */
export function rise(node: Node, d = 0.6, dy = 24) {
  const y = node.y();
  node.y(y + dy);
  node.opacity(0);
  return all(node.opacity(1, d, easeOutCubic), node.y(y, d, easeOutCubic));
}

/** pop a node in (scale from 0.6 with a little overshoot) */
export function pop(node: Node, d = 0.45) {
  node.scale(0.6);
  node.opacity(0);
  return all(node.opacity(1, d * 0.6, easeOutCubic), node.scale(1, d, easeOutBack));
}

export function fadeOut(node: Node, d = 0.4) {
  return node.opacity(0, d, easeInOutCubic);
}

export { delay };

/** a line of text in pieces of different colour: [['abwechselnd ', C.text], ['über', C.over]] */
export function Words(props: { parts: [string, string][]; size: number; weight?: number; x?: number; y?: number; offsetX?: number; opacity?: number; ref?: (n: Layout) => void }) {
  return (
    <Layout ref={props.ref} layout direction={'row'} x={props.x ?? 0} y={props.y ?? 0} offsetX={props.offsetX ?? 0} opacity={props.opacity ?? 1}>
      {props.parts.map(([t, c]) => (
        // a layout trims ordinary spaces at the edges of each piece
        <Txt text={t.replace(/ /g, '\u00a0')} fontFamily={FONT} fontWeight={props.weight ?? 700} fontSize={props.size} fill={c} />
      ))}
    </Layout>
  );
}

/** tint per point: the loop's colour where `owner` names a loop */
export function tints(owner: number[], kinds: ('over' | 'under')[], on: (k: number) => number = () => 1): (string | null)[] {
  const cache = new Map<string, string>();
  return owner.map((k) => {
    if (k < 0 || k >= kinds.length) return null;
    const a = on(k);
    if (a <= 0.01) return null;
    const key = `${k}:${a.toFixed(2)}`;
    let c = cache.get(key);
    if (!c) {
      c = mixHex(C.cable, kinds[k] === 'over' ? C.overCable : C.underCable, a);
      cache.set(key, c);
    }
    return c;
  });
}

function mixHex(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (v: number, s: number) => (v >> s) & 255;
  const m = (s: number) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * Math.min(1, Math.max(0, t)));
  return `rgb(${m(16)},${m(8)},${m(0)})`;
}

/** a round arrow: one turn of the cable, clockwise (+1) or counterclockwise (−1) */
export function Spin(props: { ccw?: boolean; color: string; size?: number; x?: number; y?: number; opacity?: number; ref?: (n: Node) => void }) {
  const s = props.size ?? 40;
  return (
    <Node ref={props.ref} x={props.x ?? 0} y={props.y ?? 0} opacity={props.opacity ?? 1}>
      <Circle
        size={s}
        stroke={props.color}
        lineWidth={s * 0.13}
        startAngle={props.ccw ? 330 : -150}
        endAngle={props.ccw ? 30 : 150}
        counterclockwise={props.ccw}
        endArrow
        arrowSize={s * 0.26}
        lineCap={'round'}
      />
    </Node>
  );
}
