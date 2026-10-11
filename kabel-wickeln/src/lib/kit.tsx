// The kit every stage is built from, so all scenes look and behave the same:
//
//   - layouts: one full view, or the split screen (own view left, outside view right, 55/45)
//   - captions: one line at the bottom, du-imperative, shown long enough to read
//     (characters / 12 + 1 s, KONZEPT "Text")
//   - Timeline (lib/timeline.ts): scene time ↔ shot time with freezes and slow motion
//   - splitPerson / viewLayers: one person in both views of a split screen: the own view sees only
//     the arms (from the upper arm down), the outside view everything; the whole body casts its
//     shadow in both (an invisible shadow caster, as in games)
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

/**
 * Layers of the split screen. Layer 0: the world and the people's arms (both views); SELF (people/
 * body/mesh.ts): the people's bodies without the arms (outside views only); OUTSIDE: anything else
 * only outside views show; FIRST: anything only the own view shows (e.g. a hint for the viewer).
 */
export const LAYER = { OUTSIDE: 2, FIRST: 3 } as const;

/**
 * One person in both views of a split screen, the same mesh for both: the own view (a camera set up
 * with viewLayers(cam, 'pov')) sees only the arms, from the upper arm down; the outside view sees the
 * whole person. Every part casts its shadow in both views (the shadow map is rendered with a camera
 * that sees every layer), so the own view shows the body's shadow on the floor without the body.
 * Both views show exactly the same arms and hands.
 */
export function splitPerson(spec: PersonSpec, pose: Pose) {
  const person = new Person3D(spec, pose);
  person.material.transparent = true;
  return {
    person,
    update(p: Pose) {
      person.update(p);
    },
    /** fade the person (x-ray during freezes, in both views); 1 = solid */
    seeThrough(alpha: number) {
      person.material.opacity = alpha;
      person.material.depthWrite = alpha > 0.99;
    },
  };
}

/**
 * The older interface of splitPerson, kept for its callers: one person shown with outPose in both
 * views (there are no separate first-person arms any more: povPose is ignored; out and pov are the
 * same Person3D).
 */
export function twoViews(spec: PersonSpec, outPose: Pose, _povPose?: Pose) {
  const sp = splitPerson(spec, outPose);
  return {
    out: sp.person,
    pov: sp.person,
    update(o: Pose, _p?: Pose) {
      sp.update(o);
    },
    seeThrough: sp.seeThrough,
  };
}

/** a camera's layers for the split screen: 'pov' sees the world, the arms and FIRST; 'ext' everything but FIRST */
export function viewLayers(cam: THREE.Camera, which: 'pov' | 'ext') {
  if (which === 'pov') {
    cam.layers.set(0);
    cam.layers.enable(LAYER.FIRST);
  } else {
    cam.layers.enableAll();
    cam.layers.disable(LAYER.FIRST);
  }
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

