// Text on screen (one short sentence per scene) and the slim progress bar at the bottom.

import { Gradient, Node, Rect, Txt, View2D } from '@motion-canvas/2d';
import { Reference, all, createRef, easeInCubic, easeOutCubic } from '@motion-canvas/core';
import { C, FONT } from '../lib/theme';

export const CHAPTERS = 8;

export interface CaptionStyle {
  /** where the text hangs from: its bottom left corner (landscape) or its top middle (portrait) */
  anchor?: 'bottom-left' | 'top';
  fontSize?: number;
  lineHeight?: number;
}

export class Caption {
  readonly ref: Reference<Txt> = createRef<Txt>();

  constructor(view: View2D, x = -860, y = 432, { anchor = 'bottom-left', fontSize = 54, lineHeight = 66 }: CaptionStyle = {}) {
    view.add(
      <Txt
        ref={this.ref}
        x={x}
        y={y}
        offset={anchor === 'top' ? [0, -1] : [-1, 1]}
        textAlign={anchor === 'top' ? 'center' : 'left'}
        fontFamily={FONT}
        fontWeight={anchor === 'top' ? 700 : 600}
        fontSize={fontSize}
        lineHeight={lineHeight}
        fill={C.text}
        opacity={0}
        shadowColor={'rgba(0,0,0,0.85)'}
        shadowBlur={18}
        text={''}
      />,
    );
  }

  *show(text: string, duration = 0.6) {
    const t = this.ref();
    if (t.opacity() > 0) yield* this.hide(0.35);
    t.text(text);
    t.y(t.y() + 24);
    yield* all(t.opacity(1, duration, easeOutCubic), t.y(t.y() - 24, duration, easeOutCubic));
  }

  *hide(duration = 0.5) {
    yield* this.ref().opacity(0, duration, easeInCubic);
  }
}

/** a dark fade from the top of a portrait picture, so the sentence there reads on anything */
export function topShade(view: View2D, width: number, height: number, depth = 640) {
  const stops = [
    { offset: 0, color: 'rgba(5,7,12,0.95)' },
    { offset: 0.45, color: 'rgba(5,7,12,0.85)' },
    { offset: 0.8, color: 'rgba(5,7,12,0.45)' },
    { offset: 1, color: 'rgba(5,7,12,0)' },
  ];
  view.add(<Rect width={width} height={depth} y={-height / 2 + depth / 2} fill={new Gradient({ type: 'linear', from: [0, -depth / 2], to: [0, depth / 2], stops })} />);
}

/** eight short segments at the bottom: done ones dim, the current chapter lights up (fork it with `yield`) */
export function* chapterBar(view: View2D, index: number) {
  const segs: Rect[] = [];
  const w = 54;
  const gap = 12;
  const x0 = -((CHAPTERS - 1) * (w + gap)) / 2;
  view.add(
    <Node y={512}>
      {Array.from({ length: CHAPTERS }, (_, i) => (
        <Rect
          ref={(r: Rect) => segs.push(r)}
          x={x0 + i * (w + gap)}
          width={w}
          height={5}
          radius={3}
          fill={i < index ? 'rgba(220,230,245,0.5)' : 'rgba(220,230,245,0.14)'}
        />
      ))}
    </Node>,
  );
  if (segs[index]) yield* segs[index].fill(C.sensor, 0.8);
}
