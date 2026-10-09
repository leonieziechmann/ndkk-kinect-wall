// Social 9 · NDKK: the last picture of the Reel, in the look of ndkk.de (navy on pale mint, blue and
// yellow, a halftone screen): the logo of the Nacht der kreativen Köpfe builds up letter by letter,
// then where to find the wall: Station Ludwig-Leichhardt-Gymnasium (spelled as on ndkk.de). Then
// black, and the Reel starts over.

import { Img, Node, Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { all, createRef, delay, easeInCubic, easeInOutCubic, easeOutBack, easeOutCubic, linear, sequence } from '@motion-canvas/core';
import { NDKK_COLORS } from '../../lib/ndkk';
import { P } from '../../lib/portrait';
import { begin, until } from '../../lib/shots';
import { cue } from '../../lib/sound';
import { FONT } from '../../lib/theme';
import { SCENES, duration } from '../../lib/timeline';
import { Halftone } from '../../nodes/Halftone';
import { LucideIcon } from '../../nodes/LucideIcon';
import { ndkkBackdrop, ndkkLogo } from '../../nodes/ndkk';

/** the logo 900 px wide, its top here */
const LOGO_W = 900;
const LOGO_TOP = -360;
const STATION_Y = 150;

export default makeScene2D(function* (view) {
  const T = yield* begin(view, SCENES.abspann);
  const local = () => T() - SCENES.abspann;
  const bg = createRef<Node>();
  const dots = createRef<Halftone>();
  const letters: Img[] = [];
  const line = createRef<Img>();
  const station = createRef<Rect>();
  const black = createRef<Rect>();
  const C = NDKK_COLORS;

  view.add(ndkkBackdrop({ ref: bg, dots, time: local, width: P.w, height: P.h, opacity: 0, reveal: 0 }));
  view.add(ndkkLogo({ width: LOGO_W, top: LOGO_TOP, letters, line, opacity: 0 }));
  view.add(
    <Rect
      ref={station}
      y={STATION_Y}
      radius={16}
      fill={C.navy}
      padding={[30, 44]}
      layout
      direction={'column'}
      alignItems={'center'}
      gap={8}
      shadowColor={'rgba(0,38,71,0.35)'}
      shadowBlur={40}
      shadowOffsetY={12}
      opacity={0}
      scale={0.9}
    >
      <Rect layout direction={'row'} alignItems={'center'} gap={12}>
        <LucideIcon icon={'map-pin'} iconColor={C.yellow} iconWidth={2.2} width={34} height={34} />
        <Txt text={'STATION'} fontFamily={FONT} fontWeight={700} fontSize={32} letterSpacing={6} fill={C.yellow} />
      </Rect>
      <Txt text={'Ludwig-Leichhardt-Gymnasium'} fontFamily={FONT} fontWeight={700} fontSize={50} fill={'#ffffff'} />
    </Rect>,
  );
  view.add(<Rect ref={black} width={P.w} height={P.h} fill={'#000'} opacity={0} />);

  // the letters rise into place one after the other, the curly K last with a little swing
  const rise = (i: Img, k: number) => {
    const y = i.y();
    i.y(y + 60);
    i.rotation(k === 2 ? -8 : 0);
    return all(i.opacity(1, 0.35, easeOutCubic), i.y(y, 0.55, easeOutBack), i.rotation(0, 0.7, easeOutBack));
  };
  const lineY = line().y();
  line().y(lineY + 24);

  cue(T, 'ledreveal', 0.05, { dur: 0.6, n: 20, pan: -0.6, panTo: 0.6, gain: 0.7 });
  cue(T, 'title', 0.45);
  cue(T, 'word', 1.0, { gain: 0.9 });
  cue(T, 'pop', 1.55, { n: 4, gain: 0.8 });
  cue(T, 'chord', 1.65);
  yield* all(
    bg().opacity(1, 0.35, easeOutCubic),
    dots().reveal(1, 1.2, linear),
    delay(0.25, sequence(0.09, ...letters.map((l, k) => rise(l, k)))),
    delay(0.95, all(line().opacity(1, 0.5, easeOutCubic), line().y(lineY, 0.6, easeOutCubic))),
    delay(1.55, all(station().opacity(1, 0.45, easeOutCubic), station().scale(1, 0.6, easeOutBack))),
  );
  yield* until(duration('abspann') - 0.6);
  cue(T, 'black', 0, { dur: 0.6 });
  yield* all(black().opacity(1, 0.6, easeInCubic), station().y(STATION_Y - 10, 0.6, easeInOutCubic));
  yield* until(duration('abspann'));
});
