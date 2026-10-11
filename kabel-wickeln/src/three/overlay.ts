// 2D overlays on 3D views: where a 3D point appears in a ThreeView, in Motion Canvas coordinates,
// and labels that point at it.
//
//   project / toView   a 3D point → coordinates in the scene's root view (or any node's space), plus
//                      a visibility 0..1 that fades the label when the point leaves the frame or
//                      goes behind the camera
//   callout            a label on a solid plate at a fixed screen position, with a leader line (and
//                      a dot or arrowhead) to the 3D point; fades with the point's visibility.
//                      Pass a function as `at` (e.g. follow()) for a label that moves with the point.
//
// Everything is computed in signals: it reads the world's update (world.sync), so labels follow the
// cameras and cables of the current frame. Add callouts to the root view (or pass `space`).

import { Circle, Line, Node, Rect, Txt } from '@motion-canvas/2d';
import { PossibleVector2, SignalValue, Vector2, createComputed, unwrap } from '@motion-canvas/core';
import * as THREE from 'three';
import type { V3 } from '../sim/vec';
import { ThreeView } from './view';

export interface Projected {
  /** position in the target space (Motion Canvas px) */
  x: number;
  y: number;
  /** distance in front of the camera (m); negative = behind */
  depth: number;
  /** 1 well inside the frame, fading to 0 within `margin` px of the edge, 0 outside or behind */
  vis: number;
}

const tmp = new THREE.Vector3();

/**
 * Projects a 3D point through the view's camera into the coordinates of `space` (default: the
 * root view, where x and y run from the centre of the picture). `margin` is the fade band in px.
 */
export function project(view: ThreeView, p: V3 | THREE.Vector3, space?: Node, margin = 60): Projected {
  view.world.sync(); // this frame's cameras and meshes
  const size = view.size();
  const w = size.x, h = size.y;
  const cam = view.camera;
  cam.updateMatrixWorld();
  if (Array.isArray(p)) tmp.set(p[0], p[1], p[2]);
  else tmp.copy(p);
  tmp.applyMatrix4(cam.matrixWorldInverse);
  const depth = -tmp.z;
  let lx: number, ly: number;
  if (cam instanceof THREE.PerspectiveCamera) {
    const f = 1 / Math.tan(THREE.MathUtils.degToRad(cam.getEffectiveFOV()) / 2);
    const aspect = w / h;
    const z = Math.max(depth, 1e-6);
    lx = ((tmp.x * f) / aspect / z) * (w / 2);
    ly = -((tmp.y * f) / z) * (h / 2);
  } else {
    tmp.applyMatrix4(cam.projectionMatrix);
    lx = tmp.x * (w / 2);
    ly = -tmp.y * (h / 2);
  }
  const inside = Math.min(w / 2 - Math.abs(lx), h / 2 - Math.abs(ly));
  const u = depth <= 0.01 ? 0 : Math.max(0, Math.min(1, inside / margin));
  const vis = u * u * (3 - 2 * u);
  // the view's local space → the target space
  const root = space ?? view.view();
  const m = root.worldToLocal().multiply(view.localToWorld());
  const q = new Vector2(lx, ly).transformAsPoint(m);
  return { x: q.x, y: q.y, depth, vis };
}

/** the point's position in the root view (or `space`) */
export function toView(view: ThreeView, p: V3 | THREE.Vector3, space?: Node): Vector2 {
  const r = project(view, p, space);
  return new Vector2(r.x, r.y);
}

/** a position that moves with a 3D point, offset in px: for `at` of a callout that follows */
export function follow(view: ThreeView, target: () => V3, offset: PossibleVector2 = 0): () => Vector2 {
  const o = new Vector2(offset);
  return () => toView(view, target()).add(o);
}

export interface CalloutOptions {
  view: ThreeView;
  /** the 3D point the label refers to (read every frame) */
  target: () => V3;
  /** where the plate's centre stands, in root-view px (fixed, or a function) */
  at: SignalValue<PossibleVector2>;
  text: SignalValue<string>;
  /** plate colour; the text is white on colours, dark on white */
  color?: string;
  textColor?: string;
  /** font size (px, ≥ 32 for in-picture labels) */
  size?: number;
  /** arrowhead at the point instead of a dot */
  arrow?: boolean;
  /** leader line colour (default: the plate colour, or dark grey on white plates) */
  lineColor?: string;
  opacity?: SignalValue<number>;
}

/**
 * A label at a fixed place with a leader line to a 3D point. Returns the node to add to the root
 * view; animate its opacity to show and hide it (the visibility of the point is applied inside).
 */
export function callout(o: CalloutOptions): Node {
  const size = o.size ?? 34;
  const light = (o.color ?? '#ffffff').toLowerCase() === '#ffffff';
  const fill = o.color ?? '#ffffff';
  const ink = o.textColor ?? (light ? '#1d232d' : '#ffffff');
  const lineColor = o.lineColor ?? (light ? '#1d232d' : fill);
  const proj = createComputed(() => project(o.view, o.target()));
  const at = createComputed(() => new Vector2(unwrap(o.at)));

  const plate = new Rect({
    layout: true,
    padding: [size * 0.26, size * 0.6],
    radius: size * 0.42,
    fill,
    shadowColor: 'rgba(0,0,0,0.16)',
    shadowBlur: 14,
    shadowOffsetY: 4,
    position: at,
  });
  plate.add(new Txt({ text: o.text, fontFamily: 'Inter', fontWeight: 700, fontSize: size, fill: ink }));

  /** where the leader leaves the plate: the ray from its centre to the point, cut at its border */
  const start = createComputed(() => {
    const c = at();
    const p = proj();
    const s = plate.size();
    const dx = p.x - c.x, dy = p.y - c.y;
    const k = Math.min(Math.abs(dx) > 1e-6 ? s.x / 2 / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? s.y / 2 / Math.abs(dy) : Infinity, 1);
    return new Vector2(c.x + dx * k, c.y + dy * k);
  });
  /** the leader stops a little before the point, so the point itself stays visible */
  const end = createComputed(() => {
    const p = proj();
    const a = start();
    const d = new Vector2(p.x - a.x, p.y - a.y);
    const l = d.magnitude;
    const gap = o.arrow ? 10 : 0;
    return l > gap ? new Vector2(p.x - (d.x / l) * gap, p.y - (d.y / l) * gap) : a;
  });

  const inner = new Node({ opacity: () => proj().vis });
  inner.add(
    new Line({
      points: () => [start(), end()],
      stroke: lineColor,
      lineWidth: 4,
      lineCap: 'round',
      endArrow: o.arrow ?? false,
      arrowSize: 16,
    }),
  );
  if (!o.arrow) {
    inner.add(new Circle({ size: 16, fill: lineColor, stroke: '#ffffff', lineWidth: 3, position: () => new Vector2(proj().x, proj().y) }));
  }
  inner.add(plate);
  const outer = new Node({ opacity: o.opacity ?? 1 });
  outer.add(inner);
  return outer;
}
