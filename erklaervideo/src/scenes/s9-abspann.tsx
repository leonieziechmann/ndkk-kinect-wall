// 9 · Abspann: out of the black the page splits in two. Left Modern Events, who provided the LED wall
// and rent it out and look after it: their logo as the LED dot panel of their wall ad (web/scenes/
// modern-events), white and yellow type. Right Leonie Ziechmann (concept, implementation, this video)
// on the contact card of the Betula look (web/scenes/leonie-ziechmann): white card, Inter, green
// accent, mail and phone. Golden specks drift behind the card, a glint runs over the logo. Then back
// to black, and the video starts over.

import { Circle, Layout, Line, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeOutCubic, linear, sequence } from '@motion-canvas/core';
import { hash } from '../lib/math';
import { begin, until } from '../lib/shots';
import { FONT } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { LedLogo } from '../nodes/LedLogo';
import { LucideIcon } from '../nodes/LucideIcon';

/** Betula, light theme (web/scenes/leonie-ziechmann/layout.js) */
const BETULA = { panel: '#ffffff', text: '#10151f', text2: '#4b5565', line: 'rgba(15, 23, 42, 0.15)', accent: '#4e7755', accentInk: '#3b6342' };
/** the yellow of the buttons on modern-events.de (web/scenes/modern-events/overlay.js) */
const ME_YELLOW = '#fbbf24';

const LEFT = -470;
const RIGHT = 470;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.abspann);
  const local = () => T() - SCENES.abspann;
  const content = createRef<Node>();
  const divider = createRef<Line>();
  const meHead = createRef<Layout>();
  const logo = createRef<LedLogo>();
  const meLine1 = createRef<Txt>();
  const meLine2 = createRef<Txt>();
  const card = createRef<Rect>();
  const cardRows: Node[] = [];
  const specks = createRef<Node>();
  const black = createRef<Rect>();

  view.add(
    <Node ref={content}>
      {/* golden specks drifting up behind the card, like the lights in the birch wood */}
      <Node ref={specks} opacity={0}>
        {Array.from({ length: 22 }, (_, i) => {
          const sx = 70 + hash(i, 1) * 820;
          const speed = 18 + hash(i, 2) * 26;
          const r = 2 + hash(i, 3) * 3.5;
          return (
            <Circle
              size={r * 2}
              fill={'#f7d27a'}
              x={() => sx + 14 * Math.sin(local() * 0.7 + i)}
              y={() => 520 - ((hash(i, 4) * 1040 + local() * speed) % 1040)}
              opacity={() => 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(local() * (1.1 + hash(i, 5)) + i * 2.1))}
              shadowColor={'rgba(247,210,122,0.9)'}
              shadowBlur={10}
            />
          );
        })}
      </Node>
      <Line ref={divider} points={[[0, -330], [0, 330]]} stroke={'rgba(160,180,210,0.35)'} lineWidth={2} start={0.5} end={0.5} />

      {/* left: Modern Events */}
      <Layout ref={meHead} x={LEFT} y={-176} direction={'row'} alignItems={'center'} gap={14} layout opacity={0}>
        <Circle size={12} fill={ME_YELLOW} />
        <Txt text={'LED-WAND'} fontFamily={FONT} fontWeight={600} fontSize={24} letterSpacing={4} fill={ME_YELLOW} />
      </Layout>
      <LedLogo ref={logo} x={LEFT} y={-40} width={784} height={176} pitch={8} reveal={0} time={local} />
      <Txt ref={meLine1} x={LEFT} y={118} text={'Verleih und Betreuung'} fontFamily={FONT} fontWeight={700} fontSize={50} fill={'#ffffff'} opacity={0} />
      <Txt ref={meLine2} x={LEFT} y={182} text={'modern-events.de'} fontFamily={FONT} fontWeight={600} fontSize={36} fill={ME_YELLOW} opacity={0} />

      {/* right: Leonie Ziechmann on the Betula card */}
      <Rect
        ref={card}
        x={RIGHT}
        y={18}
        layout
        direction={'column'}
        alignItems={'start'}
        gap={16}
        padding={[46, 56, 50, 56]}
        radius={22}
        fill={BETULA.panel}
        shadowColor={'rgba(0,0,0,0.55)'}
        shadowBlur={60}
        shadowOffsetY={22}
        opacity={0}
      >
        <Layout ref={(n: Layout) => cardRows.push(n)} direction={'row'} alignItems={'center'} gap={12} opacity={0}>
          <Circle size={10} fill={BETULA.accent} />
          <Txt text={'KONZEPT · UMSETZUNG · ERKLÄRUNG'} fontFamily={FONT} fontWeight={600} fontSize={21} letterSpacing={2.4} fill={BETULA.accentInk} />
        </Layout>
        <Txt ref={(n: Txt) => cardRows.push(n)} text={'Leonie Ziechmann'} fontFamily={FONT} fontWeight={600} fontSize={70} letterSpacing={-2.2} fill={BETULA.text} opacity={0} />
        <Rect ref={(n: Rect) => cardRows.push(n)} width={'100%'} height={2} fill={BETULA.line} opacity={0} marginTop={6} marginBottom={4} />
        <Txt ref={(n: Txt) => cardRows.push(n)} text={'Anfragen'} fontFamily={FONT} fontWeight={500} fontSize={24} fill={BETULA.text2} opacity={0} />
        <Layout ref={(n: Layout) => cardRows.push(n)} direction={'row'} alignItems={'center'} gap={16} opacity={0}>
          <LucideIcon icon={'mail'} width={32} height={32} iconColor={BETULA.accent} />
          <Txt text={'info@leonieziechmann.de'} fontFamily={FONT} fontWeight={500} fontSize={36} letterSpacing={-0.4} fill={BETULA.text} />
        </Layout>
        <Layout ref={(n: Layout) => cardRows.push(n)} direction={'row'} alignItems={'center'} gap={16} opacity={0}>
          <LucideIcon icon={'phone'} width={32} height={32} iconColor={BETULA.accent} />
          <Txt text={'+49 171 2077119'} fontFamily={FONT} fontWeight={500} fontSize={36} letterSpacing={-0.4} fill={BETULA.text} />
        </Layout>
      </Rect>
    </Node>,
  );
  view.add(<Rect ref={black} width={1920} height={1080} fill={'#000'} opacity={0} />);

  const rise = (node: Node, dy: number, d: number, fade = d) => {
    const y = node.y();
    node.y(y + dy);
    return all(node.opacity(1, fade, easeOutCubic), node.y(y, d, easeOutCubic));
  };

  // the composition drifts a little closer the whole time
  yield content().scale(1.035, duration('abspann'), linear);
  yield* all(
    delay(0.25, all(divider().start(0, 1.0, easeInOutCubic), divider().end(1, 1.0, easeInOutCubic))),
    delay(0.5, rise(meHead(), 14, 0.6)),
    delay(0.6, logo().reveal(1, 1.7, linear)),
    delay(1.7, rise(meLine1(), 18, 0.6)),
    delay(1.95, rise(meLine2(), 18, 0.6)),
    delay(0.9, rise(card(), 46, 0.9, 0.4)),
    delay(1.3, sequence(0.16, ...cardRows.map((n) => n.opacity(1, 0.5, easeOutCubic)))),
    delay(1.2, specks().opacity(1, 1.5)),
  );
  yield* until(duration('abspann') - 1.2);
  yield* black().opacity(1, 1.1, easeInOutCubic);
  yield* until(duration('abspann'));
});
