// Text on screen (one short sentence per scene) and the slim progress bar at the bottom.

import { Node, Rect, Txt, View2D } from '@motion-canvas/2d';
import { Reference, all, createRef, easeInCubic, easeOutCubic } from '@motion-canvas/core';
import { C, FONT } from '../lib/theme';

export const CHAPTERS = 8;

export class Caption {
  readonly ref: Reference<Txt> = createRef<Txt>();

  constructor(view: View2D, x = -860, y = 432) {
    view.add(
      <Txt
        ref={this.ref}
        x={x}
        y={y}
        offset={[-1, 1]}
        fontFamily={FONT}
        fontWeight={600}
        fontSize={50}
        lineHeight={62}
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
