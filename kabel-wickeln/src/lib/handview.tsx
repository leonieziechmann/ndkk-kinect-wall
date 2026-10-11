// The view of your own hands while coiling (stages 1 and 3): the floor, both forearms behind the
// cable, the cable, both fists on top of it.

import { Node, Rect } from '@motion-canvas/2d';
import { SimpleSignal, createComputed } from '@motion-canvas/core';
import { coiling } from './choreo';
import { Kind, coilLength } from './coil';
import { clamp } from './math';
import { C } from './theme';
import { tints } from './ui';
import { Cable } from '../nodes/Cable';
import { Fist } from '../nodes/Fist';

export const KINDS: Kind[] = ['over', 'under', 'over', 'under', 'over', 'under'];
export const HX = -600;
export const HY = -290;
export const FLOOR = 430;
export const BASE = { hx: HX, hy: HY, fist: 60, loop: 1050, floorY: FLOOR, tail: 110, kinds: KINDS, total: 0 };
BASE.total = coilLength({ ...BASE, done: KINDS.length, form: 0, release: 0 }, 260);
const REST = { x: 420, y: 760 };
const SHOULDER = { x: 520, y: 1100 };

/** the hands and the coil, driven by `p` (see lib/choreo.ts); `handTurn` tilts the right fist (deg) */
export function handView(p: SimpleSignal<number>, opts: { handTurn?: () => number; children?: Node[] } = {}) {
  const state = createComputed(() => coiling(BASE, p(), REST, SHOULDER));
  /** how strongly each loop shows its colour */
  const tintOf = (k: number) => clamp(p() - k - 0.45) * 2.2;
  const node = (
    <Node>
      <Rect y={FLOOR + 6 + 150} width={1920} height={300} fill={C.floor} />
      <Rect y={FLOOR + 6} width={1920} height={2} fill={C.floorLine} />
      <Fist x={HX} y={HY} side={'left'} arm={168} scale={0.8} part={'arm'} />
      <Fist x={() => state().hand.x} y={() => state().hand.y} side={'right'} arm={() => state().hand.arm} scale={0.8} part={'arm'} />
      <Cable geom={() => ({ ...state().coil.geom, tint: tints(state().coil.owner, KINDS, tintOf) })} stripe={0} />
      <Fist x={HX} y={HY} side={'left'} scale={0.8} part={'hand'} />
      <Fist
        x={() => state().hand.x}
        y={() => state().hand.y}
        side={'right'}
        flip={() => state().hand.flip}
        rotation={() => opts.handTurn?.() ?? 0}
        scale={0.8}
        part={'hand'}
      />
      {opts.children ?? []}
    </Node>
  ) as Node;
  return { node, state };
}
