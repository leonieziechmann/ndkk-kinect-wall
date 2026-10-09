// 10 · Bunt: the last picture before the video starts over: a rainbow flag rolls out and waves,
// below it "Die Zukunft ist bunt" and "Cottbus ist bunt", the word "bunt" in the colors of the flag.
// Then black.

import { Gradient, Layout, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeOutCubic, linear } from '@motion-canvas/core';
import { begin, until } from '../lib/shots';
import { FONT } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { RainbowFlag } from '../nodes/RainbowFlag';

/** the flag's colors, a little brighter for type on black */
const BRIGHT = ['#ff3b3b', '#ff9b21', '#ffe11f', '#2fd35a', '#3d8bff', '#b45cff'];
const SIZE = 92;

/** "bunt" in the colors of the flag, from left to right */
function rainbowText(width: number) {
  return new Gradient({
    type: 'linear',
    from: [-width / 2, 0],
    to: [width / 2, 0],
    stops: BRIGHT.map((color, i) => ({ offset: i / (BRIGHT.length - 1), color })),
  });
}

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.bunt);
  const local = () => T() - SCENES.bunt;
  const content = createRef<Node>();
  const flag = createRef<RainbowFlag>();
  const line1 = createRef<Layout>();
  const line2 = createRef<Layout>();
  const black = createRef<Rect>();

  const line = (ref: ReturnType<typeof createRef<Layout>>, y: number, text: string) => (
    <Layout ref={ref} y={y} direction={'row'} alignItems={'baseline'} layout opacity={0}>
      <Txt text={`${text} `} fontFamily={FONT} fontWeight={700} fontSize={SIZE} letterSpacing={-1.5} fill={'#ffffff'} />
      <Txt text={'bunt'} fontFamily={FONT} fontWeight={700} fontSize={SIZE} letterSpacing={-1.5} fill={rainbowText(SIZE * 2.15)} />
    </Layout>
  );

  view.add(
    <Node ref={content}>
      <RainbowFlag ref={flag} x={18} y={-160} width={560} height={350} time={local} unfurl={0} pole={0} />
      {line(line1, 150, 'Die Zukunft ist')}
      {line(line2, 262, 'Cottbus ist')}
    </Node>,
  );
  view.add(<Rect ref={black} width={1920} height={1080} fill={'#000'} opacity={0} />);

  const rise = (node: Layout, d: number) => {
    const y = node.y();
    node.y(y + 22);
    return all(node.opacity(1, d, easeOutCubic), node.y(y, d, easeOutCubic));
  };

  yield content().scale(1.03, duration('bunt'), linear);
  yield* all(
    delay(0.2, flag().pole(1, 0.5, easeOutCubic)),
    delay(0.4, flag().unfurl(1, 1.4, easeInOutCubic)),
    delay(1.2, rise(line1(), 0.7)),
    delay(1.8, rise(line2(), 0.7)),
  );
  yield* until(duration('bunt') - 1.2);
  yield* black().opacity(1, 1.1, easeInOutCubic);
  yield* until(duration('bunt'));
});
