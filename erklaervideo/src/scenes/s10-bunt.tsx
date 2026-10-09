// 10 · Bunt: the last picture before the video starts over. The whole screen becomes a rainbow flag
// of LED dots, like the Modern Events logo, waving a little in the wind. On it, in big white type,
// "Cottbus ist bunt"; then "Die Zukunft" pushes "Cottbus" up and out of its line: "Die Zukunft ist
// bunt". Then black.

import { Node, Rect, Txt, TxtProps, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInOutCubic, easeOutCubic, linear } from '@motion-canvas/core';
import { begin, until } from '../lib/shots';
import { FONT } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { LedFlag } from '../nodes/LedFlag';

/** the first line sits in a slot: what leaves it upwards or enters from below is cut off at its edges */
const SLOT = { y: -102, h: 224 };
const LINE2 = 118;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.bunt);
  const local = () => T() - SCENES.bunt;
  const flag = createRef<LedFlag>();
  const words = createRef<Node>();
  const cottbus = createRef<Txt>();
  const zukunft = createRef<Txt>();
  const rest = createRef<Txt>();
  const black = createRef<Rect>();
  const type: TxtProps = {
    fontFamily: FONT,
    fontWeight: 700,
    fontSize: 172,
    letterSpacing: -4,
    fill: '#ffffff',
    shadowColor: 'rgba(0,0,0,0.6)',
    shadowBlur: 36,
    shadowOffsetY: 8,
  };

  view.add(<LedFlag ref={flag} width={1920} height={1080} pitch={12} time={local} reveal={0} dim={0} />);
  view.add(
    <Node ref={words} opacity={0} y={20}>
      <Rect y={SLOT.y} width={1900} height={SLOT.h} clip>
        <Txt ref={cottbus} {...type} text={'Cottbus'} />
        <Txt ref={zukunft} {...type} text={'Die Zukunft'} y={SLOT.h} />
      </Rect>
      <Txt ref={rest} {...type} text={'ist bunt'} y={LINE2} />
    </Node>,
  );
  view.add(<Rect ref={black} width={1920} height={1080} fill={'#000'} opacity={0} />);

  yield* all(
    flag().reveal(1, 1.4, linear),
    delay(0.8, flag().dim(1, 1.0)),
    delay(1.0, all(words().opacity(1, 0.7, easeOutCubic), words().y(0, 0.8, easeOutCubic))),
  );
  // read "Cottbus ist bunt", then "Die Zukunft" pushes "Cottbus" out
  yield* until(4.4);
  yield* all(cottbus().y(-SLOT.h, 0.9, easeInOutCubic), zukunft().y(0, 0.9, easeInOutCubic));
  yield* until(duration('bunt') - 1.2);
  yield* black().opacity(1, 1.1, easeInOutCubic);
  yield* until(duration('bunt'));
});
