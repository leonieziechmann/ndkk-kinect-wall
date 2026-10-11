// The kit every stage is built from, so all scenes look and behave the same:
//
//   - layouts: one full view, or the split screen (own view left, outside view right, 55/45)
//   - captions: one line at the bottom, du-imperative, shown long enough to read
//     (characters / 12 + 1 s, KONZEPT "Text")
//   - Timeline (lib/timeline.ts): scene time ↔ shot time with freezes and slow motion
//   - twoViews: one person in both views of a split screen (the own view hides head and torso,
//     its cheated arms cast no shadows)
//   - small things: tally (ü u ü …), the "Zeitlupe" badge, the clock signal
//
// Pixel layout: the picture is 1920 × 1080 with (0, 0) in the middle.

import { Node, Rect, Txt } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal, ThreadGenerator, createSignal, easeInOutCubic, linear, waitFor } from '@motion-canvas/core';
import * as THREE from 'three';
import { Person3D } from '../people/body3d';
import type { Pose, PersonSpec } from '../people/people';
import { ThreeView, World3D } from '../three/view';
import { C, FONT, OVER, UNDER } from './theme';

// ------------------------------------------------------------------------------------- layout

export const GAP = 24;
export const TOP = -540 + GAP;
/** height of the 3D panels; the band below is for the caption */
export const PANEL_H = 820;
/** where captions sit (centre line), clear of player controls */
export const CAPTION_Y = TOP + PANEL_H + 88;

export interface Split {
  pov: ThreeView;
  ext: ThreeView;
  /** left edge, width of each panel (picture coordinates) */
  povRect: { x: number; w: number };
  extRect: { x: number; w: number };
}

/** a panel title on a plate, top left inside a panel */
export function PanelTitle(props: { text: string; x: number; y?: number }) {
  return (
    <Rect x={props.x} y={props.y ?? TOP + 24} offset={[-1, -1]} padding={[10, 22]} radius={40} fill={C.plate} layout>
      <Txt text={props.text} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>
  );
}

/** the split screen: own view (POV) left, outside view right, with their titles */
export function splitScreen(view: Node, world: World3D, povCam: THREE.Camera, extCam: THREE.Camera, ratio = 0.55): Split {
  const wL = Math.round((1920 - 3 * GAP) * ratio);
  const wR = 1920 - 3 * GAP - wL;
  const xL = -960 + GAP;
  const xR = 960 - GAP - wR;
  const pov = (<ThreeView world={world} camera={povCam} x={xL + wL / 2} y={TOP + PANEL_H / 2} width={wL} height={PANEL_H} radius={28} />) as ThreeView;
  const ext = (<ThreeView world={world} camera={extCam} x={xR + wR / 2} y={TOP + PANEL_H / 2} width={wR} height={PANEL_H} radius={28} />) as ThreeView;
  view.add([pov, ext, <PanelTitle text={'So siehst du es'} x={xL + 24} />, <PanelTitle text={'Von außen'} x={xR + 24} />]);
  return { pov, ext, povRect: { x: xL, w: wL }, extRect: { x: xR, w: wR } };
}

/** one view over the whole width (above the caption band, or the whole picture with `full`) */
export function fullView(view: Node, world: World3D, cam: THREE.Camera, full = false): ThreeView {
  const v = full ? (
    <ThreeView world={world} camera={cam} width={1920} height={1080} />
  ) : (
    <ThreeView world={world} camera={cam} y={TOP + PANEL_H / 2} width={1920 - 2 * GAP} height={PANEL_H} radius={28} />
  );
  view.add(v);
  return v as ThreeView;
}

// ----------------------------------------------------------------------------------- captions

/** seconds a caption must stay to be read: characters / 12 + 1 */
export const readTime = (text: string) => text.length / 12 + 1;

export class Captions {
  public readonly node: Txt;

  public constructor(view: Node, y = CAPTION_Y, size = 46) {
    this.node = (<Txt y={y} text={''} fontFamily={FONT} fontWeight={600} fontSize={size} fill={C.text} opacity={0} />) as Txt;
    view.add(this.node);
  }

  /** fade the line in (replacing what was there) */
  public *show(text: string) {
    if (this.node.opacity() > 0) yield* this.node.opacity(0, 0.25);
    this.node.text(text);
    yield* this.node.opacity(1, 0.35);
  }

  public *hide() {
    yield* this.node.opacity(0, 0.3);
  }

  /** show, hold at least the reading time (or `hold`, if longer), hide */
  public *say(text: string, hold = 0) {
    yield* this.show(text);
    yield* waitFor(Math.max(readTime(text), hold));
    yield* this.hide();
  }
}

// ----------------------------------------------------------------------------------- timeline

export { Timeline, swing } from './timeline';
export type { TimeEvent } from './timeline';

/** the scene clock: runs linearly in the background from 0 for `seconds` */
export function clock(seconds: number): { tau: SimpleSignal<number>; run: () => ThreadGenerator } {
  const tau = createSignal(0);
  return { tau, run: () => tau(seconds, seconds, linear) };
}

// ----------------------------------------------------------------------------------- people

/** layers: the outside person (seen only by outside cameras), the own-view person (only by the POV) */
export const LAYER = { OUTSIDE: 2, FIRST: 3 } as const;

/**
 * One person in both views of a split screen. The outside copy is seen by outside cameras and casts
 * the shadows; the own-view copy is seen by the POV camera only, without head, torso and upper
 * arms (layer SELF, which the POV camera does not see) and casts no shadows (its arms are cheated).
 */
export function twoViews(spec: PersonSpec, outPose: Pose, povPose: Pose) {
  const out = new Person3D(spec, outPose);
  const pov = new Person3D(spec, povPose);
  for (const m of out.group.children) m.layers.set(LAYER.OUTSIDE);
  for (const m of pov.group.children) {
    if (m.layers.isEnabled(0)) m.layers.set(LAYER.FIRST);
    m.castShadow = false;
  }
  out.material.transparent = true;
  return {
    out,
    pov,
    update(o: Pose, p: Pose) {
      out.update(o);
      pov.update(p);
    },
    /** fade the outside person (x-ray during freezes); 1 = solid */
    seeThrough(alpha: number) {
      out.material.opacity = alpha;
      out.material.depthWrite = alpha > 0.99;
    },
  };
}

/** set a camera's layers for the split screen: 'pov' sees the own-view person, 'ext' the outside one */
export function viewLayers(cam: THREE.Camera, which: 'pov' | 'ext') {
  cam.layers.set(0);
  cam.layers.enable(which === 'pov' ? LAYER.FIRST : LAYER.OUTSIDE);
}

// ----------------------------------------------------------------------------------- bits

/** a tally of loop kinds at the top right of a panel: ü (blue) / u (orange), lit when placed */
export function tally(view: Node, kinds: ('over' | 'under')[], placed: (k: number) => number, x = 960 - GAP - 24, y = TOP + 24) {
  const box = (<Rect x={x} y={y} offset={[1, -1]} padding={[10, 22]} radius={40} fill={C.plate} layout gap={14} />) as Rect;
  kinds.forEach((k, i) =>
    box.add(<Txt text={k === 'over' ? 'ü' : 'u'} fontFamily={FONT} fontWeight={800} fontSize={40} fill={k === 'over' ? OVER : UNDER} opacity={() => 0.15 + 0.85 * placed(i)} />),
  );
  view.add(box);
  return box;
}

/** the "Zeitlupe" badge, top centre of a panel */
export function slowBadge(view: Node, visible: SignalValue<number>, x = 0, y = TOP + 24) {
  const n = (
    <Rect x={x} y={y} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.text} opacity={visible} layout>
      <Txt text={'Zeitlupe'} fontFamily={FONT} fontWeight={700} fontSize={28} fill={'#fff'} />
    </Rect>
  );
  view.add(n);
  return n as Rect;
}

/** fade a node in and out around a generator */
export function* during(node: Node, task: () => ThreadGenerator) {
  yield* node.opacity(1, 0.35, easeInOutCubic);
  yield* task();
  yield* node.opacity(0, 0.35, easeInOutCubic);
}

