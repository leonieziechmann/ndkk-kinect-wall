// Test scene: the rendering kit (src/three) on procedural cables, which deliver the same arrays as
// the simulation (positions and the material frame's d1 per node). Shots:
//   0-1.5  the studio with all props, wide
//   1.5-2  a cable twisted six turns hanging over the bar, a twist arrow growing around it
//   2-4    the plugs on a table (XLR, USB-C, CEE blue and red, plug and coupler each), two macros;
//          a ribbon with one full turn
//   4-5    a coil on the floor: loops outlined blue (über) and orange (unter), the strand to the
//          floor in white, labels with leader lines, a dashed ghost loop, contact shadows
//   5-6    macro: the velcro tie wraps the bundle, passes its eyelet and folds back
//   6-8    split screen 55/45: first person ("So siehst du es") and outside ("Von außen")
//   8-9    the dark stage variant
// Stills: npm run stills -- --project test 1 1.9 3.2 3.7 4.5 5.5 5.95 7 8.5 --scale 1

import { Rect, Txt, makeScene2D } from '@motion-canvas/2d';
import { createSignal, linear } from '@motion-canvas/core';
import * as THREE from 'three';
import { fontsReady } from '../../lib/fonts';
import { C, FONT } from '../../lib/theme';
import type { V3 } from '../../sim/vec';
import { ArcArrow, GhostPath } from '../../three/arrows';
import { CableMesh, paint, rgba } from '../../three/cable';
import { makeCamera, orbit, povCamera } from '../../three/camera';
import { callout, follow } from '../../three/overlay';
import { PlugKind } from '../../three/plugs';
import { cableCrate, flightCase, hangingBar, micStand, table, wheelchair } from '../../three/props';
import { RibbonMesh } from '../../three/ribbon';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

// ---------------------------------------------------------------- procedural cables

/** a dense polyline with a scalar tag per point (loop angle, or -1 on the tails) */
class Path {
  public readonly pts: number[] = [];
  public readonly tags: number[] = [];
  public add(p: V3, tag = -1) {
    this.pts.push(p[0], p[1], p[2]);
    this.tags.push(tag);
  }
  public get last(): V3 {
    const n = this.pts.length;
    return [this.pts[n - 3], this.pts[n - 2], this.pts[n - 1]];
  }
  /** cubic Bézier from the last point via c1, c2 to p3 */
  public bezier(c1: V3, c2: V3, p3: V3, steps = 40) {
    const p0 = this.last;
    for (let i = 1; i <= steps; i++) {
      const u = i / steps, a = (1 - u) ** 3, b = 3 * u * (1 - u) ** 2, c = 3 * u * u * (1 - u), d = u ** 3;
      this.add([0, 1, 2].map((k) => a * p0[k] + b * c1[k] + c * c2[k] + d * p3[k]) as V3);
    }
  }
}

interface Cable {
  pos: Float32Array;
  d1: Float32Array;
  tag: Float32Array;
  n: number;
}

/** resamples a path to nodes `spacing` apart and adds material frames: d1 starts at `up`, is carried along, turned by twist(s) */
function makeCable(path: Path, spacing: number, up: V3, twist: (s: number, L: number) => number = () => 0): Cable {
  const raw = path.pts;
  const m = raw.length / 3;
  const cum = [0];
  for (let i = 1; i < m; i++) cum.push(cum[i - 1] + Math.hypot(raw[i * 3] - raw[i * 3 - 3], raw[i * 3 + 1] - raw[i * 3 - 2], raw[i * 3 + 2] - raw[i * 3 - 1]));
  const L = cum[m - 1];
  const n = Math.max(2, Math.round(L / spacing) + 1);
  const pos = new Float32Array(n * 3), d1 = new Float32Array(n * 3), tag = new Float32Array(n);
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const s = (L * k) / (n - 1);
    while (seg < m - 1 && cum[seg] < s) seg++;
    const f = cum[seg] > cum[seg - 1] ? (s - cum[seg - 1]) / (cum[seg] - cum[seg - 1]) : 0;
    for (let c = 0; c < 3; c++) pos[k * 3 + c] = raw[(seg - 1) * 3 + c] + (raw[seg * 3 + c] - raw[(seg - 1) * 3 + c]) * f;
    tag[k] = path.tags[seg - 1] + (path.tags[seg] - path.tags[seg - 1]) * f;
  }
  // parallel transport of `up`, then the twist
  let nx = up[0], ny = up[1], nz = up[2];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1) * 3, b = Math.min(n - 1, i + 1) * 3;
    let tx = pos[b] - pos[a], ty = pos[b + 1] - pos[a + 1], tz = pos[b + 2] - pos[a + 2];
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const d = nx * tx + ny * ty + nz * tz;
    nx -= d * tx;
    ny -= d * ty;
    nz -= d * tz;
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    const phi = twist((L * i) / (n - 1), L);
    d1[i * 3] = nx * Math.cos(phi) + bx * Math.sin(phi);
    d1[i * 3 + 1] = ny * Math.cos(phi) + by * Math.sin(phi);
    d1[i * 3 + 2] = nz * Math.cos(phi) + bz * Math.sin(phi);
  }
  return { pos, d1, tag, n };
}

/**
 * A flat coil lying at `c` (bottom of the bundle): `loops` loops of ring radius R; the cable runs
 * once around the round bundle (radius rb) while it goes `loops` times around the ring, so strands
 * cross each other like in a real coil without passing through each other.
 */
function coilPoint(c: V3, R: number, rb: number, r: number, loops: number, theta: number): V3 {
  const psi = theta / loops;
  const rad = R + rb * Math.cos(psi);
  return [c[0] + rad * Math.cos(theta), c[1] + r + rb + rb * Math.sin(psi), c[2] + rad * Math.sin(theta)];
}

const R7 = 0.0042; // a 7 mm XLR cable, a bit thicker so it reads in the wide shot
const CASE = { w: 0.8, d: 0.6, h: 0.55 };
const COIL = { c: [0.3, 0.0015, 0.9] as V3, R: 0.125, loops: 6, rb: R7 * 2.25 };
const TABLE = { x: 1.35, z: -0.35, h: 0.75 };
const BAR = { x: 0.2, z: -1.9, h: 1.35 };

/** a coil on the floor in front of the case: plug end tucked out, the other end leading away */
function floorCoil(): Cable {
  const { c, R, loops, rb } = COIL;
  const p = new Path();
  const start = coilPoint(c, R, rb, R7, loops, 0);
  // tail from the male plug on the floor into the first loop (the cable runs +z at θ = 0)
  p.add([start[0] + 0.1, R7, start[2] - 0.26]);
  p.bezier([start[0] + 0.08, R7, start[2] - 0.12], [start[0], start[1], start[2] - 0.06], start, 30);
  const steps = 72 * loops;
  for (let i = 1; i <= steps; i++) {
    const th = (i / steps) * loops * Math.PI * 2;
    p.add(coilPoint(c, R, rb, R7, loops, th), th);
  }
  // the strand to the floor: away to the right in easy curves
  const e = p.last;
  p.bezier([e[0], e[1], e[2] + 0.1], [e[0] + 0.1, R7, e[2] + 0.12], [e[0] + 0.25, R7, e[2] + 0.02], 30);
  p.bezier([e[0] + 0.45, R7, e[2] - 0.09], [e[0] + 0.55, R7, e[2] + 0.2], [e[0] + 0.8, R7, e[2] + 0.15], 40);
  p.bezier([e[0] + 1.0, R7, e[2] + 0.1], [e[0] + 1.1, R7, e[2] - 0.2], [e[0] + 1.3, R7 + 0.004, e[2] - 0.25], 40);
  return makeCable(p, 0.012, [0, 1, 0]);
}

/** a cable draped over the bar, twisted six turns: the stripe spirals */
function hangingCable(swing: number): Cable {
  const p = new Path();
  const rb = 0.015 + R7;
  const x = BAR.x;
  const zf = BAR.z + rb;
  p.add([x - 0.35, R7, BAR.z + 0.55]);
  p.bezier([x - 0.15, R7, BAR.z + 0.45], [x, R7, zf + 0.1], [x, 0.18, zf], 30);
  p.bezier([x, 0.5, zf], [x, 1.0, zf], [x, BAR.h, zf], 40);
  for (let i = 1; i <= 24; i++) {
    const a = (i / 24) * Math.PI;
    p.add([x, BAR.h + Math.sin(a) * rb, BAR.z + Math.cos(a) * rb]);
  }
  const zb = BAR.z - rb;
  p.bezier([x, BAR.h - 0.3, zb], [x + swing * 0.3, 0.75, zb - swing * 0.1], [x + swing, 0.42, zb - swing * 0.3], 40);
  return makeCable(p, 0.012, [1, 0, 0], (s, L) => (s > 0.6 ? (Math.PI * 2 * 6 * (s - 0.6)) / (L - 0.6) : 0));
}

/** a short cable on the table in a U, plugs on both ends pointing to the front */
function uCable(x: number, z: number, r: number, plugR: number, width: number): Cable {
  const p = new Path();
  const y = TABLE.h + r;
  const yp = TABLE.h + plugR;
  p.add([x - width / 2, yp, z]);
  p.bezier([x - width / 2, yp, z - 0.03], [x - width / 2, y, z - 0.06], [x - width / 2, y, z - 0.12], 12);
  p.bezier([x - width / 2, y, z - 0.3], [x + width / 2, y, z - 0.3], [x + width / 2, y, z - 0.12], 40);
  p.bezier([x + width / 2, y, z - 0.06], [x + width / 2, yp, z - 0.03], [x + width / 2, yp, z], 12);
  return makeCable(p, 0.01, [0, 1, 0]);
}

/** a cable in the crate */
function crateCoil(cx: number, cz: number): Cable {
  const p = new Path();
  const c: V3 = [cx, 0.016, cz];
  for (let i = 0; i <= 72 * 5; i++) {
    const th = (i / 72) * Math.PI * 2;
    p.add(coilPoint(c, 0.13, R7 * 2, R7, 5, th), th);
  }
  return makeCable(p, 0.014, [0, 1, 0]);
}

// ---------------------------------------------------------------- the scene

export default makeScene2D(function* (view) {
  view.fill(C.bg);
  yield fontsReady();
  const t = createSignal(0);

  // ---------------------------------------------------------------- the light world
  const coil = floorCoil();
  const coilMesh = new CableMesh({ maxNodes: coil.n, radius: R7, plugStart: 'xlr-male', plugEnd: 'xlr-female' });
  const halo = new Float32Array(coil.n * 4);
  // loop k spans the loop angles [2πk, 2π(k+1)); the tails have angle -1
  const loop = (i: number) => (coil.tag[i] < 0 ? -1 : Math.floor(coil.tag[i] / (Math.PI * 2)));
  for (let i = 0; i < coil.n; i++) {
    if (loop(i) === 3) halo.set(rgba('#2a6cc4'), i * 4);
    else if (loop(i) === 4) halo.set(rgba('#b85000'), i * 4);
    else if (loop(i) < 0 && i > coil.n / 2) halo.set(rgba('#ffffff', 0.9), i * 4);
  }

  const crate = crateCoil(-1.25, 0.25);
  const crateMesh = new CableMesh({ maxNodes: crate.n, radius: R7, plugStart: 'xlr-female', plugEnd: 'xlr-male' });
  const tint = new Float32Array(crate.n * 4);
  paint(tint, Math.round(crate.n * 0.4), Math.round(crate.n * 0.6), rgba('#8a6a2a', 0.6));
  crateMesh.update(crate.pos, crate.d1, crate.n, tint);

  const hang0 = hangingCable(0);
  const hangMesh = new CableMesh({ maxNodes: hang0.n + 8, radius: R7, plugEnd: 'xlr-female' });

  // short cables on the table, one per plug pair
  const pairs: [PlugKind, PlugKind, number, number, string, number][] = [
    ['xlr-male', 'xlr-female', R7, 0.0095, '#1d1f23', 0.07],
    ['usb-c', 'usb-c', 0.0022, 0.004, '#ecebe7', 0.05],
    ['cee-blue', 'cee-blue-coupler', 0.0068, 0.034, '#202226', 0.1],
    ['cee-red', 'cee-red-coupler', 0.008, 0.034, '#202226', 0.1],
  ];
  const tableCables = pairs.map(([a, b, r, pr, jacket, w], i) => {
    const cab = uCable(TABLE.x - 0.5 + i * 0.27 + (i > 1 ? 0.04 * (i - 1) : 0), TABLE.z + 0.27, r, pr, w);
    // a white cable gets a stripe with a dark edge; the others a plain yellow stripe
    const mesh = new CableMesh({ maxNodes: cab.n, radius: r, jacket, plugStart: a, plugEnd: b, stripeEdge: i === 1 ? '#3a3d44' : null, ground: TABLE.h });
    mesh.update(cab.pos, cab.d1, cab.n);
    return mesh;
  });

  // a ribbon on the table with one full turn in a raised arch
  const ribbon = new RibbonMesh({ maxNodes: 80, width: 0.025, thickness: 0.002 });
  {
    const n = 80;
    const pos = new Float32Array(n * 3), d1 = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const x = TABLE.x - 0.55 + u * 0.95;
      const arch = Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.25) / 0.5))) ** 2;
      pos.set([x, TABLE.h + 0.001 + arch * 0.06, TABLE.z - 0.22 + 0.03 * Math.sin(u * 5)], i * 3);
      const phi = Math.PI * 2 * Math.min(1, Math.max(0, (u - 0.3) / 0.4));
      // across the band: -z turned by phi about x (the band runs along x)
      d1.set([0, -Math.sin(phi), -Math.cos(phi)], i * 3);
    }
    ribbon.update(pos, d1, n);
  }

  // a velcro tie around the coil bundle, one on the cable next to the plug
  const strap = new StrapMesh({ color: '#1e1f22' });
  const plugTie = new StrapMesh({ color: '#1e1f22' });
  const tieAt = Math.PI * 0.5;
  const tieCenter: V3 = [COIL.c[0] + COIL.R * Math.cos(tieAt), COIL.c[1] + R7 + COIL.rb + 0.0025, COIL.c[2] + COIL.R * Math.sin(tieAt)];
  const tieAxis: V3 = [-Math.sin(tieAt), 0, Math.cos(tieAt)];
  const node = (c: Cable, i: number): V3 => [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]];
  const [a8, a10] = [node(coil, 8), node(coil, 10)];
  plugTie.pose({ center: node(coil, 9), axis: [a10[0] - a8[0], a10[1] - a8[1], a10[2] - a8[2]], start: [0, 1, 0], radius: R7, wrap: 1, fold: 0, droop: 0.5 });

  const ghost = new GhostPath({ maxPoints: 97, radius: 0.0025 });
  {
    const pts = new Float32Array(97 * 3);
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.set([COIL.c[0] + 0.17 * Math.cos(a), COIL.c[1] + 0.03, COIL.c[2] + 0.17 * Math.sin(a)], i * 3);
    }
    ghost.update(pts, 97);
  }
  const twistArrow = new ArcArrow({ color: '#2a6cc4', thickness: 0.0035 });

  const caseProp = flightCase({ width: CASE.w, depth: CASE.d, height: CASE.h });
  const tableProp = table();
  tableProp.position.set(TABLE.x, 0, TABLE.z);
  const crateProp = cableCrate();
  crateProp.position.set(-1.25, 0, 0.25);
  const stand = micStand();
  stand.position.set(-0.85, 0, -1.2);
  stand.rotation.y = 0.6;
  const chair = wheelchair();
  chair.position.set(-1.9, 0, -0.75);
  chair.rotation.y = 0.9;
  const bar = hangingBar({ height: BAR.h });
  bar.position.set(BAR.x, 0, BAR.z);

  const wide = makeCamera(32);
  const close = makeCamera(30);
  const pov = makeCamera(62);
  const ext = makeCamera(34);

  const world = new World3D('test-render', () => {
    const tt = t();
    ghost.mesh.visible = tt >= 4;
    // the hanging cable swings a little: a per-frame tube rebuild (the procedural cable allocates;
    // BakedRod.frameSample writes into the caller's arrays)
    const h = hangingCable(0.06 * Math.sin(tt * 2.2));
    hangMesh.update(h.pos, h.d1, h.n);
    // the twist arrow around the hanging cable grows during its macro
    twistArrow.update({ center: [BAR.x, 0.8, BAR.z - 0.015 - R7], axis: [0, -1, 0], from: [0, 0, 1], radius: 0.028, angle: Math.PI * 1.5, progress: Math.min(1, Math.max(0, (tt - 1.5) / 0.3)) });
    // the tie closes between 5.0 and 5.9 s
    const wrap = Math.min(1, Math.max(0, (tt - 5.0) / 0.4));
    const fold = Math.min(1, Math.max(0, (tt - 5.4) / 0.5));
    strap.pose({ center: tieCenter, axis: tieAxis, start: [0, 1, 0], radius: COIL.rb + R7 + 0.001, wrap, fold, droop: 0.3 });
    coilMesh.update(coil.pos, coil.d1, coil.n, undefined, tt >= 4 ? halo : undefined);

    if (tt < 1.5) {
      studio.focus([0, 0.5, -0.4], 2.6);
      orbit(wide, { target: [0.1, 0.55, -0.35], yaw: 0.25 + 0.12 * tt, pitch: 0.36, dist: 5.6, fov: 32 });
    } else if (tt < 2) {
      studio.focus([BAR.x, 0.8, BAR.z], 0.8);
      orbit(wide, { target: [BAR.x, 0.84, BAR.z - 0.02], yaw: Math.PI - 0.3, pitch: 0.35, dist: 0.5, fov: 32 });
    } else if (tt < 4) {
      studio.focus([TABLE.x, TABLE.h, TABLE.z], 0.9);
      // the table, then macros of the XLR and USB-C plugs and of the CEE plugs
      if (tt < 3) orbit(close, { target: [TABLE.x - 0.08, TABLE.h + 0.02, TABLE.z + 0.12], yaw: 0.05 + 0.1 * (tt - 2), pitch: 0.62, dist: 1.25, fov: 30 });
      else if (tt < 3.5) orbit(close, { target: [TABLE.x - 0.4, TABLE.h + 0.01, TABLE.z + 0.27], yaw: 0.5, pitch: 0.42, dist: 0.42, fov: 30 });
      else orbit(close, { target: [TABLE.x + 0.15, TABLE.h + 0.03, TABLE.z + 0.27], yaw: 0.35, pitch: 0.38, dist: 0.62, fov: 30 });
    } else {
      studio.focus(COIL.c, 0.8);
      if (tt < 5) orbit(close, { target: [COIL.c[0] + 0.03, 0.02, COIL.c[2]], yaw: 0.35 + 0.05 * (tt - 4), pitch: 0.66, dist: 0.8, fov: 30 });
      else orbit(close, { target: tieCenter, yaw: 0.75 + 0.2 * (tt - 5), pitch: 0.42, dist: 0.3, fov: 30 });
    }
    povCamera(pov, [COIL.c[0], 1.6, COIL.c[2] + 0.55], [COIL.c[0], 0, COIL.c[2] - 0.05], { forward: 0.1, down: 0.08, fov: 38 });
    orbit(ext, { target: [COIL.c[0] + 0.1, 0.25, COIL.c[2] - 0.3], yaw: 0.95, pitch: 0.35, dist: 2.6, fov: 34 });
  });
  const scene = world.scene;
  const studio = new Studio(scene);
  scene.add(
    coilMesh.group,
    crateMesh.group,
    hangMesh.group,
    ...tableCables.map((c) => c.group),
    ribbon.mesh,
    strap.group,
    plugTie.group,
    ghost.mesh,
    twistArrow.group,
    caseProp,
    tableProp,
    crateProp,
    stand,
    chair,
    bar,
  );

  // ---------------------------------------------------------------- the dark stage world
  const stageCoil = new CableMesh({ maxNodes: coil.n, radius: R7, plugStart: 'xlr-male', plugEnd: 'xlr-female' });
  const stageCam = makeCamera(30);
  const stageWorld = new World3D('test-render-stage', () => {
    stageCoil.update(coil.pos, coil.d1, coil.n);
    orbit(stageCam, { target: [0, 0.4, 0.2], yaw: 0.5 + 0.1 * t(), pitch: 0.38, dist: 3.4, fov: 32 });
  });
  new Studio(stageWorld.scene, { variant: 'stage', focus: [-0.3, 0.5, -0.3], focusRadius: 1.8 });
  const stageCase = flightCase({ width: CASE.w, depth: CASE.d, height: CASE.h });
  const stageStand = micStand();
  stageStand.position.set(-0.9, 0, -0.9);
  const stageCrate = cableCrate();
  stageCrate.position.set(-1.2, 0, 0.3);
  stageWorld.scene.add(stageCoil.group, stageCase, stageStand, stageCrate);

  // ---------------------------------------------------------------- 2D
  const full = <ThreeView world={world} camera={wide} width={1920} height={1080} />;
  view.add(full);
  yield* t(2, 2, linear);

  full.remove();
  const plugs = <ThreeView world={world} camera={close} width={1920} height={1080} />;
  view.add(plugs);
  yield* t(4, 2, linear);

  // close-up of the coil with labels
  plugs.remove();
  const closeView = (<ThreeView world={world} camera={close} width={1920} height={1080} />) as ThreeView;
  view.add(closeView);
  const coilPt = (th: number) => coilPoint(COIL.c, COIL.R, COIL.rb, R7, COIL.loops, th);
  const labels = [
    callout({ view: closeView, target: () => coilPt(Math.PI * 2 * 3 + Math.PI * 1.05), at: [-640, -260], text: 'über', color: '#2a6cc4' }),
    callout({ view: closeView, target: () => coilPt(Math.PI * 2 * 4 + 0.15), at: [640, -300], text: 'unter', color: '#b85000' }),
    callout({ view: closeView, target: () => node(coil, coil.n - 70), at: [620, 330], text: 'Kabel zum Boden' }),
    callout({ view: closeView, target: () => tieCenter, at: follow(closeView, () => tieCenter, [-420, 260]), text: 'Klettband', arrow: true }),
  ];
  view.add(labels);
  yield* t(5, 1, linear);
  for (const l of labels) l.remove();
  yield* t(6, 1, linear);

  // split screen 55/45
  closeView.remove();
  const gap = 24;
  const wL = Math.round((1920 - 3 * gap) * 0.55);
  const wR = 1920 - 3 * gap - wL;
  const top = -540 + gap;
  const hP = 820;
  const left = (<ThreeView world={world} camera={pov} x={-960 + gap + wL / 2} y={top + hP / 2} width={wL} height={hP} radius={28} />) as ThreeView;
  const right = (<ThreeView world={world} camera={ext} x={960 - gap - wR / 2} y={top + hP / 2} width={wR} height={hP} radius={28} />) as ThreeView;
  const title = (text: string, x: number) => (
    <Rect x={x} y={top + 24} offset={[-1, -1]} padding={[10, 22]} radius={40} fill={'#ffffffe6'} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>
  );
  const split = [
    left,
    right,
    title('So siehst du es', -960 + gap + 24),
    title('Von außen', 960 - gap - wR + 24),
    callout({ view: left, target: () => coilPt(Math.PI * 2 * 3 + Math.PI * 1.05), at: [-800, -200], text: 'über', color: '#2a6cc4' }),
    callout({ view: left, target: () => coilPt(Math.PI * 2 * 4 + 0.15), at: [-80, -260], text: 'unter', color: '#b85000' }),
    callout({ view: right, target: () => node(coil, coil.n - 40), at: [520, 280], text: 'Kabel zum Boden' }),
    <Txt text={'Leg Schlaufen in die linke Hand – abwechselnd über und unter.'} y={top + hP + 90} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />,
  ];
  view.add(split);
  yield* t(8, 2, linear);

  // the dark stage
  for (const n of split) n.remove();
  view.add(<ThreeView world={stageWorld} camera={stageCam} width={1920} height={1080} />);
  yield* t(9, 1, linear);
});
