// The coiling world of stages 1 and 3: Noor coils the XLR cable over and under into her left hand
// (a coiling bake: shots/coil-engine.ts). One World3D holds the studio, the baked cable (halos,
// plugs), Noor (one mesh for both views: lib/kit splitPerson, her arms exactly as the bake recorded
// them: CoilReplay), the arc arrow round the right forearm while it turns over for "unter", and the
// velcro tie that closes round the coil at the end. The part drives everything through `state`
// (shot time, cameras, x-ray, highlights), so a freeze or a slow motion is only a different
// shot-time function.

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
  /** the first-person camera looks here (default: below the left hand, the coil) */
  look?: (t: number) => V3;
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
    const arrow = new ArcArrow({ color: UNDER, thickness: 0.0035 });
    this.noor = splitPerson(spec, this.replay.pose(0));

    this.povCam = makeCamera(60);
    viewLayers(this.povCam, 'pov');
    this.extCam = makeCamera(38);
    viewLayers(this.extCam, 'ext');

    const look = state.look ?? ((t: number) => {
      const g = bake.frame('gripL', t).p;
      return [g[0] + 0.14, g[1] - 0.2, g[2] + 0.02] as V3;
    });

    this.world = new World3D(key, () => {
      const t = state.t();
      const pose = this.replay.pose(t);
      this.noor.update(pose);
      this.noor.seeThrough(1 - 0.7 * state.xray());

      bake.frameSample(t, this.pos, this.d1);
      this.cable.update(this.pos, this.d1, n, undefined, this.writeHalo() ? this.halo : undefined);

      // the arc round the right forearm, as far as the hand really turned (the recorded turn)
      const pr = state.arrow();
      arrow.group.visible = pr !== null && pr > 0.01;
      if (pr !== null) {
        const w = pose.joints[J.rightWrist], e = pose.joints[J.rightElbow];
        const mid: V3 = [w[0] + (e[0] - w[0]) * 0.35, w[1] + (e[1] - w[1]) * 0.35, w[2] + (e[2] - w[2]) * 0.35];
        // (supination turns the right forearm clockwise seen from the hand: negative about elbow → wrist)
        arrow.update({ center: mid, axis: sub(w, e), from: [0, 1, 0], radius: 0.058, angle: -GEOM.underTurn, progress: pr });
      }

      // the tie round the coil just outside the index finger (lateral end of the strands in the hand)
      const tv = state.tie();
      tie.group.visible = tv !== null;
      if (tv) {
        const f = bake.frame('gripL', t);
        const s = quatRotate(f.q, [0, 0, 1]);
        const c: V3 = [f.p[0] + s[0] * (GEOM.half + 0.016), f.p[1] + s[1] * (GEOM.half + 0.016), f.p[2] + s[2] * (GEOM.half + 0.016)];
        tie.pose({ center: c, axis: s, start: [0, 1, 0], radius: 0.026, wrap: tv.wrap, fold: tv.fold, droop: 1 - tv.wrap });
      }

      povFollow(this.povCam, (x) => eyesOfRig(spec, this.replay.at(x).rig), look, t, { back: 0.05, up: 0.03, fov: 60, smooth: 0.25 });
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
