// The look of the Nacht der kreativen Köpfe, at the start of both cuts and at the end of the short
// one: the background of ndkk.de (pale mint, blue and yellow with a halftone screen) and the logo,
// built from its letters (src/lib/ndkk.ts) so they can come in one by one.

import { Gradient, Img, Node, Rect, Txt } from '@motion-canvas/2d';
import { Reference, SignalValue } from '@motion-canvas/core';
import { NDKK_BOX, NDKK_COLORS, NDKK_LETTERS, NDKK_LINE } from '../lib/ndkk';
import { FONT } from '../lib/theme';
import { loopTime } from '../lib/timeline';
import { Halftone } from './Halftone';

/** the background, `width` × `height` */
export function ndkkBackdrop(o: { ref?: Reference<Node>; dots?: Reference<Halftone>; time: SignalValue<number>; width: number; height: number; opacity?: number; reveal?: number }) {
  const C = NDKK_COLORS;
  const W = o.width;
  const H = o.height;
  const glow = { x: 0.35 * W, y: -H / 3, r: 0.7 * W };
  return (
    <Node ref={o.ref} opacity={o.opacity ?? 1}>
      <Rect width={W} height={H} fill={new Gradient({ type: 'linear', from: [0, -H / 2], to: [0, H / 2], stops: [{ offset: 0, color: C.pale }, { offset: 0.5, color: C.mint }, { offset: 1, color: C.blue }] })} />
      <Rect
        width={W}
        height={H}
        fill={new Gradient({ type: 'radial', from: [glow.x, glow.y], to: [glow.x, glow.y], fromRadius: 0, toRadius: glow.r, stops: [{ offset: 0, color: 'rgba(241,237,180,0.85)' }, { offset: 1, color: 'rgba(241,237,180,0)' }] })}
      />
      <Halftone ref={o.dots} width={W} height={H} time={o.time} pitch={16} dotAlpha={0.14} reveal={o.reveal ?? 1} />
    </Node>
  );
}

/** the logo, `width` wide with its top at `top`; its letters and the line below go into `letters` and `line` */
export function ndkkLogo(o: { width: number; top: number; letters?: Img[]; line?: Reference<Img>; opacity?: number }) {
  const s = o.width / NDKK_BOX.w;
  const place = (p: { x: number; y: number; w: number; h: number }) => ({
    x: (p.x - NDKK_BOX.x + p.w / 2) * s - o.width / 2,
    y: o.top + (p.y - NDKK_BOX.y + p.h / 2) * s,
    width: p.w * s,
    height: p.h * s,
  });
  return (
    <Node>
      {NDKK_LETTERS.map((p) => (
        <Img ref={(i: Img) => o.letters?.push(i)} src={p.src} {...place(p)} opacity={o.opacity ?? 1} />
      ))}
      <Img ref={o.line} src={NDKK_LINE.src} {...place(NDKK_LINE)} opacity={o.opacity ?? 1} />
    </Node>
  );
}

/**
 * The first picture of the full cut, and its last: the NDKK and what the installation is. The video
 * starts on it and comes back to it, so it loops; the dots and the line of type drift with the loop
 * clock (timeline.ts, loopTime), so the last frame runs on into the first.
 */
export function ndkkOpening(o: { ref?: Reference<Node>; time: () => number; y?: number }) {
  const t = () => loopTime(o.time());
  return (
    <Node ref={o.ref} y={o.y ?? 0}>
      {ndkkBackdrop({ time: t, width: 1920, height: 1080 })}
      {ndkkLogo({ width: 1100, top: -330 })}
      <Txt text={'Die magische Videowand'} fontFamily={FONT} fontWeight={800} fontSize={104} letterSpacing={-1} fill={NDKK_COLORS.navy} y={() => 250 - 10 * t()} />
    </Node>
  );
}
