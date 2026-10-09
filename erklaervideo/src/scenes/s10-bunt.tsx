// 10 · Bunt: the last picture before the video starts over. The whole screen becomes a rainbow flag
// of LED dots, like the Modern Events logo, waving like satin and sparkling. On it, in big white
// type, "Cottbus ist bunt"; then "Cottbus" drifts up and dissolves while "Die Zukunft" comes into
// focus from below, and the flag sparkles up once: "Die Zukunft ist bunt". Then black.

import { Node, Rect, Txt, TxtProps, blur, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInCubic, easeInOutCubic, easeInOutSine, easeOutCubic, linear } from '@motion-canvas/core';
import { begin, until } from '../lib/shots';
import { cue } from '../lib/sound';
import { FONT } from '../lib/theme';
import { SCENES, duration } from '../lib/timeline';
import { LedFlag } from '../nodes/LedFlag';

const LINE1 = -96;
const LINE2 = 96;
const DRIFT = 46;

const TYPE: TxtProps = { fontFamily: FONT, fontWeight: 700, fontSize: 172, letterSpacing: -4 };

/** a line of white type over a soft dark copy of itself, so it reads on every stripe and sheen */
function line(ref: ReturnType<typeof createRef<Node>>, text: string, y: number, startBlur: number) {
  return (
    <Node ref={ref} y={y} opacity={0} filters={[blur(startBlur)]}>
      <Txt {...TYPE} text={text} y={10} fill={'#000000'} opacity={0.55} filters={[blur(48)]} />
      <Txt {...TYPE} text={text} y={5} fill={'#000000'} opacity={0.6} filters={[blur(12)]} />
      <Txt {...TYPE} text={text} fill={'#ffffff'} />
    </Node>
  );
}

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.bunt);
  const local = () => T() - SCENES.bunt;
  const flag = createRef<LedFlag>();
  const cottbus = createRef<Node>();
  const zukunft = createRef<Node>();
  const rest = createRef<Node>();
  const black = createRef<Rect>();

  view.add(<LedFlag ref={flag} width={1920} height={1080} pitch={12} time={local} reveal={0} />);
  view.add(line(cottbus, 'Cottbus', LINE1 + DRIFT * 0.6, 14));
  view.add(line(zukunft, 'Die Zukunft', LINE1 + DRIFT, 16));
  view.add(line(rest, 'ist bunt', LINE2 + DRIFT * 0.6, 14));
  view.add(<Rect ref={black} width={1920} height={1080} fill={'#000'} opacity={0} />);

  /** into focus: fade in, rise, sharpen */
  const focusIn = (n: Node, y: number, d: number) => all(n.opacity(1, d * 0.8, easeOutCubic), n.y(y, d, easeOutCubic), n.filters.blur(0, d, easeOutCubic));

  cue(T, 'ledreveal', 0, { dur: 1.4, n: 64, pan: -0.9, panTo: 0.9, gain: 1.2 });
  cue(T, 'sparkle', 0.4, { dur: duration('bunt') - 0.4 });
  cue(T, 'word', 0.9);
  cue(T, 'word', 1.08, { gain: 0.6 });
  // the glint crosses the middle of the flag at these times (LedFlag: every 4.2 s)
  for (const at of [2.38, 6.58]) cue(T, 'glint', at - 0.3, { pan: -0.8, panTo: 0.8, gain: 0.8 });
  cue(T, 'riser', 4.3 - 1.4, { dur: 1.4 });
  yield* all(flag().reveal(1, 1.4, linear), delay(0.9, focusIn(cottbus(), LINE1, 0.9)), delay(1.08, focusIn(rest(), LINE2, 0.9)));
  // read "Cottbus ist bunt", then the change
  yield* until(4.3);
  cue(T, 'transform', 0);
  cue(T, 'word', 0.28, { gain: 1.1 });
  cue(T, 'bloom', 0.3, { dur: duration('bunt') - 4.6 });
  yield* all(
    cottbus().opacity(0, 0.6, easeInCubic),
    cottbus().y(LINE1 - DRIFT, 0.65, easeInCubic),
    cottbus().filters.blur(16, 0.6, easeInCubic),
    flag().burst(1, 0.5, easeOutCubic),
    delay(0.28, focusIn(zukunft(), LINE1, 0.85)),
  );
  yield* flag().burst(0, 1.2, easeInOutSine);
  yield* until(duration('bunt') - 1.2);
  cue(T, 'black', 0, { dur: 1.1 });
  yield* black().opacity(1, 1.1, easeInOutCubic);
  yield* until(duration('bunt'));
});
