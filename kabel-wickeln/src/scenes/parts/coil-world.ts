// The coiling world of stages 1 and 3: Noor coils the XLR cable over and under into her left hand
// (a coiling bake: shots/coil-engine.ts). One World3D holds the studio, the baked cable (halos,
// plugs), Noor (one mesh for both views: lib/kit splitPerson, her arms and hands exactly as the bake
// recorded them: CoilReplay, the fist's radius included), the arc arrow round the right wrist while
// it turns over for "unter" (5 cm round it, as far as the hand really turned), and the velcro tie
// that closes round the coil next to her fist (the medial side: her thumb lies along the lateral
// one). The part drives everything through `state` (shot time, cameras, x-ray, highlights), so a
// freeze or a slow motion is only a different shot-time function.

import * as THREE from 'three';
import { BakedRod, V3, quatRotate } from '../../sim';
import { CoilReplay } from '../../shots/coil-engine';
import { CoilPlan, GEOM, LoopBeat, beats } from '../../shots/coiling';
import { NOOR } from '../../people/cast';
import { J, PersonSpec } from '../../people/people';
import { eyesOfRig } from '../../people/rig';
import { splitPerson, viewLayers } from '../../lib/kit';
import { OVER, UNDER } from '../../lib/theme';
import { ArcArrow } from '../../three/arrows';
import { CableMesh, rgba } from '../../three/cable';
import { Orbit, makeCamera, orbit, povFollow } from '../../three/camera';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { World3D } from '../../three/view';

/** the velcro tie: grey, so it reads against the black cable */
const TIE_COLOR = '#74777e';

export interface CoilState {
  /** shot time */
  t: () => number;
  /** the outside camera */
  ext: () => Orbit;
  /** the first-person camera looks here (default: between the hands and below them: both hands, the coil, the right hip) */
  look?: (t: number) => V3;
  /** the first-person camera's field of view (default 70°) */
  povFov?: number;
  /** 0 solid … 1 Noor at 30 % (x-ray during freezes) */
  xray: () => number;
  /** loop k's highlight: the cable to the floor glows white, the crossing gets a blue/orange rim */
  glow: () => { k: number; on: number } | null;
  /** the arc round the right forearm (how far it is drawn, 0..1), or null */
  arrow: () => number | null;
  /** the tie: wrap 0..1 then fold 0..1; null = not there yet */
  tie: () => { wrap: number; fold: number } | null;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class CoilWorld {
  readonly world: World3D;
  readonly povCam: THREE.PerspectiveCamera;
  readonly extCam: THREE.PerspectiveCamera;
  readonly cable: CableMesh;
  readonly noor: ReturnType<typeof splitPerson>;
  readonly replay: CoilReplay;
  readonly bs: LoopBeat[];
  readonly n: number;
  /** cable per node [m] */
  readonly seg: number;
  /** material at the left hand's medial edge: [0] the plug strand, [k] after loop k */
  readonly sEdge: number[];
  /** where the cable to the floor crosses loop k (node of the loop, node of the floor cable), found at the freeze */
  private readonly cross = new Map<number, { loop: number; floor: number; depth: number }>();
  private readonly pos: Float32Array;
  private readonly d1: Float32Array;
  private readonly halo: Float32Array;

  constructor(
    key: string,
    readonly bake: BakedRod,
    readonly plan: CoilPlan,
    readonly state: CoilState,
    readonly spec: PersonSpec = NOOR,
  ) {
    const n = (this.n = bake.n);
    this.bs = beats(plan);
    this.seg = bake.track('seg', 0) || 0.0075;
    this.sEdge = [bake.track('edge', 0), ...this.bs.map((b) => bake.track('edge', Math.min(bake.duration, b.t1 + 0.05)))];
    this.pos = new Float32Array(3 * n);
    this.d1 = new Float32Array(3 * n);
    this.halo = new Float32Array(4 * n);
    this.replay = new CoilReplay(bake, spec);

    this.cable = new CableMesh({ maxNodes: n, radius: bake.radius, plugStart: 'xlr-male', plugEnd: 'xlr-female', haloPx: 7, haloMax: 1.2 });
    const tie = new StrapMesh({ color: TIE_COLOR, inner: '#666a71', length: 0.25 });
    const arrow = new ArcArrow({ color: UNDER, thickness: 0.005 });
    this.noor = splitPerson(spec, this.replay.pose(0));

    this.povCam = makeCamera(60);
    viewLayers(this.povCam, 'pov');
    this.extCam = makeCamera(38);
    viewLayers(this.extCam, 'ext');

    const look = state.look ?? ((t: number) => {
      const g = bake.frame('gripL', t).p, r = bake.frame('gripR', t).p;
      // (between and below the hands, nearer the left one: the coil hanging from it, and the right
      // hand also out at the hip)
      return [g[0] + 0.4 * (r[0] - g[0]) + 0.04, Math.min(g[1], r[1]) - 0.24, g[2] + 0.4 * (r[2] - g[2]) - 0.06] as V3;
    });

    this.world = new World3D(key, () => {
      const t = state.t();
      const pose = this.replay.pose(t);
      this.noor.update(pose);
      this.noor.seeThrough(1 - 0.7 * state.xray());

      bake.frameSample(t, this.pos, this.d1);
      this.cable.update(this.pos, this.d1, n, undefined, this.writeHalo() ? this.halo : undefined);

      // the arc round the right wrist (5 cm round it, just behind the joint), as far as the hand really
      // turned (the recorded turn)
      const pr = state.arrow();
      arrow.group.visible = pr !== null && pr > 0.01;
      if (pr !== null) {
        const w = pose.joints[J.rightWrist], e = pose.joints[J.rightElbow];
        const fa = sub(w, e), l = Math.hypot(fa[0], fa[1], fa[2]) || 1;
        const mid: V3 = [w[0] - (fa[0] / l) * 0.03, w[1] - (fa[1] / l) * 0.03, w[2] - (fa[2] / l) * 0.03];
        // (supination turns the right forearm clockwise seen from the hand: negative about elbow → wrist)
        arrow.update({ center: mid, axis: fa, from: [0, 1, 0], radius: 0.055, angle: -GEOM.underTurn, progress: pr });
      }

      // the tie round the coil next to the fist, on its medial side (the thumb lies along the lateral one)
      const tv = state.tie();
      tie.group.visible = tv !== null;
      if (tv) {
        const f = bake.frame('gripL', t);
        const s = quatRotate(f.q, [0, 0, 1]);
        const off = -(GEOM.half - 0.004);
        const c: V3 = [f.p[0] + s[0] * off, f.p[1] + s[1] * off, f.p[2] + s[2] * off];
        tie.pose({ center: c, axis: s, start: [0, 1, 0], radius: (this.replay.at(t).rig.hands[0]?.radius ?? 0.022) + 0.005, wrap: tv.wrap, fold: tv.fold, droop: 1 - tv.wrap });
      }

      povFollow(this.povCam, (x) => eyesOfRig(spec, this.replay.at(x).rig), look, t, { back: 0.05, up: 0.03, fov: state.povFov ?? 70, smooth: 0.3 });
      orbit(this.extCam, state.ext());
    });
    const scene = this.world.scene;
    new Studio(scene, { focus: [0.1, 0.6, -0.25], focusRadius: 1.0 });
    scene.add(this.cable.group, tie.group, arrow.group, this.noor.person.group);
  }

  /** node index of material s */
  node(s: number): number {
    return Math.max(0, Math.min(this.n - 1, Math.round(s / this.seg)));
  }

  /** position of node i at shot time t */
  at(i: number, t: number, out: V3 = [0, 0, 0]): V3 {
    return this.bake.nodeAt(t, Math.max(0, Math.min(this.n - 1, i)), out);
  }

  /** loop k's free part (outside the hand): first and last node */
  loopNodes(k: number): [number, number] {
    return [this.node(this.sEdge[k - 1]) + 1, this.node(this.sEdge[k] - 2 * GEOM.half) - 1];
  }

  /** first node of the cable to the floor once loop k is laid */
  floorStart(k: number): number {
    return this.node(this.sEdge[k]) + 2;
  }

  /**
   * Where the cable to the floor crosses loop k at shot time t, seen along the coil's axis N (the
   * crossing the labels point at) and which is in front: depth = floor − loop along N (− = on
   * Noor's side of the loop: "über"; + = behind it: "unter"). Found once, then followed by node.
   */
  crossing(k: number, t: number): { loop: number; floor: number; depth: number } | null {
    const c = this.cross.get(k);
    if (c) return c;
    const [a, b] = this.loopNodes(k);
    const f0 = this.floorStart(k), f1 = Math.min(this.n - 2, this.node(this.sEdge[k] + 0.7));
    const A = GEOM.A, N = GEOM.N;
    const P = (i: number) => {
      const p = this.at(i, t);
      return [dot(p, A), p[1], dot(p, N)];
    };
    let best: { loop: number; floor: number; depth: number } | null = null;
    for (let i = f0; i < f1; i++) {
      const p = P(i), q = P(i + 1);
      for (let j = a; j < b; j++) {
        const u = P(j), v = P(j + 1);
        const d = (q[0] - p[0]) * (v[1] - u[1]) - (q[1] - p[1]) * (v[0] - u[0]);
        if (Math.abs(d) < 1e-12) continue;
        const s = ((u[0] - p[0]) * (v[1] - u[1]) - (u[1] - p[1]) * (v[0] - u[0])) / d;
        const w = ((u[0] - p[0]) * (q[1] - p[1]) - (u[1] - p[1]) * (q[0] - p[0])) / d;
        if (s < 0 || s > 1 || w < 0 || w > 1) continue;
        const depth = p[2] + (q[2] - p[2]) * s - (u[2] + (v[2] - u[2]) * w);
        // the lowest crossing (the one below the hand, clear of the fingers)
        const cand = { loop: w < 0.5 ? j : j + 1, floor: s < 0.5 ? i : i + 1, depth };
        if (!best || u[1] < P(best.loop)[1]) best = cand;
      }
    }
    if (best) this.cross.set(k, best);
    return best;
  }

  /** a point on the cable to the floor just past where it crosses loop k (where the labels point), or null */
  floorPoint(k: number, t: number): V3 | null {
    const c = this.cross.get(k);
    return c ? this.at(c.floor + 3, t) : null;
  }

  /** the crossing point of loop k (its loop node), or the loop's lowest point when none was found */
  crossPoint(k: number, t: number): V3 {
    const c = this.cross.get(k);
    if (c) return this.at(c.loop, t);
    const [a, b] = this.loopNodes(k);
    let lo = a, y = Infinity;
    for (let i = a; i <= b; i++) {
      const p = this.at(i, t);
      if (p[1] < y) { y = p[1]; lo = i; }
    }
    return this.at(lo, t);
  }

  /**
   * Does the finished ring lie round and flat at shot time t? Every loop (its free part) round in its
   * own plane (width / height ≥ 0.6), flat (rms distance from its best-fit plane < 1.5 cm) and
   * parallel to the others (plane within 25° of the coil's axis N). Measured on the baked cable.
   */
  ringCheck(t: number): { ok: boolean; loops: { aspect: number; thickness: number; angle: number }[] } {
    const loops = this.bs.map((b) => {
      const [a, e] = this.loopNodes(b.k);
      const P: V3[] = [];
      for (let i = a; i <= e; i++) P.push(this.at(i, t));
      const m: V3 = [0, 0, 0];
      for (const p of P) for (let c = 0; c < 3; c++) m[c] += p[c] / P.length;
      const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const p of P) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += ((p[r] - m[r]) * (p[c] - m[c])) / P.length;
      // the plane's normal: the smallest principal axis (power iteration on trace·I − C)
      const tr = C[0][0] + C[1][1] + C[2][2];
      let v: V3 = [GEOM.N[0], GEOM.N[1], GEOM.N[2]];
      for (let it = 0; it < 100; it++) {
        const w: V3 = [0, 1, 2].map((r) => (tr - C[r][r]) * v[r] - C[r].reduce((s, x, c) => s + (c === r ? 0 : x * v[c]), 0)) as V3;
        const l = Math.hypot(w[0], w[1], w[2]) || 1;
        v = [w[0] / l, w[1] / l, w[2] / l];
      }
      const lam = [0, 1, 2].reduce((s, r) => s + v[r] * (C[r][0] * v[0] + C[r][1] * v[1] + C[r][2] * v[2]), 0);
      // width (across, horizontal in the plane) and height (vertical in the plane)
      const across = [v[2], 0, -v[0]] as V3, al = Math.hypot(across[0], across[2]) || 1;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of P) {
        const x = (p[0] * across[0] + p[2] * across[2]) / al;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
      }
      const top = Math.max(y1, this.bake.frame('gripL', t).p[1]);
      return { aspect: (x1 - x0) / Math.max(1e-6, top - y0), thickness: Math.sqrt(Math.max(0, lam)), angle: Math.acos(Math.min(1, Math.abs(dot(v, GEOM.N)))) };
    });
    return { ok: loops.every((l) => l.aspect >= 0.6 && l.thickness < 0.015 && l.angle < (25 * Math.PI) / 180), loops };
  }

  /** writes the halos of the current highlight; false when there is none */
  private writeHalo() {
    const g = this.state.glow();
    if (!g || g.on <= 0) return false;
    const halo = this.halo;
    halo.fill(0);
    const k = g.k;
    const white = rgba('#ffffff', 0.95 * g.on);
    for (let i = this.floorStart(k); i < this.n; i++) halo.set(white, 4 * i);
    const c = this.cross.get(k);
    if (c) {
      const rim = rgba(this.plan.kinds[k - 1] === 'over' ? OVER : UNDER, g.on);
      const [l0, l1] = this.loopNodes(k);
      for (let i = Math.max(l0, c.loop - 7); i <= Math.min(l1, c.loop + 7); i++) halo.set(rim, 4 * i);
    }
    return true;
  }
}
