// The coiling world of stages 1 and 3: Noor coils the XLR cable over and under into her left hand,
// seen from her own eyes (POV) and from outside, both cameras on her side of the coil. One World3D
// holds the studio, the baked cable (with halos and plugs), the velcro tie on the plug end, Noor
// twice (outside copy and first-person copy, lib/kit twoViews) and the 180° arrow round the right
// forearm. The part that uses it drives everything through `state` (shot time, cameras, x-ray,
// highlights), so a freeze or a slow motion is only a different shot-time function.
//
// The right hand is glued to the cable: while it holds it (loose fist or closed), its grip frame is
// taken from the baked cable at the material point it holds (position and direction), turned like
// the choreography's hand (palm down, palm up, rolling). So the fist always closes round the cable
// where the cable really is, and the cable leaves the fist in the direction it really runs.

import * as THREE from 'three';
import { BakedRod, Frame, Quat, V3, quatConj, quatMul, quatSlerp } from '../../sim';
import { Coiling, TIE_POINTS, TIE_S } from '../../shots/coiling';
import { NOOR } from '../../people/cast';
import { J, PersonSpec } from '../../people/people';
import { rigPose } from '../../people/rig';
import { eyesOf } from '../../people/body3d';
import { twoViews, viewLayers } from '../../lib/kit';
import { OVER, UNDER } from '../../lib/theme';
import { ArcArrow } from '../../three/arrows';
import { CableMesh, rgba } from '../../three/cable';
import { Orbit, lookFrom, makeCamera, orbit } from '../../three/camera';
import { StrapMesh } from '../../three/strap';
import { Studio } from '../../three/studio';
import { World3D } from '../../three/view';

/** the velcro tie */
const TIE_COLOR = '#74777e';

/** what a coiling shot module exports about its cable (see shots/s1-coil.ts) */
export interface CoilShot {
  coil: Coiling;
  /** cable length per sim node [m] */
  seg: number;
  /** first node of the cable to the floor once loop k is placed */
  floorStart: (k: number) => number;
  /** first and last node of loop k outside the fist */
  loopNodes: (k: number) => [number, number];
}

export interface PovView {
  eye: V3;
  look: V3;
  /** vertical field of view [deg] */
  fov: number;
}

export interface CoilState {
  /** shot time */
  t: () => number;
  /** the outside camera */
  ext: () => Orbit;
  /** the first-person camera */
  pov: () => PovView;
  /** 0 solid … 1 the outside Noor at 30 % (x-ray during freezes) */
  xray: () => number;
  /** loop k's highlight: the cable to the floor glows white, the crossing gets a blue/orange rim */
  glow: () => { k: number; on: number } | null;
  /** progress 0..1 of the 180° arrow round the right forearm, or null (hidden) */
  arrow: () => number | null;
}

/** d1 (first column) of a rotation */
const colX = (q: Quat): V3 => {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
};
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** rotation with columns d1, d2 = d3 × d1, d3 (d1 made perpendicular to d3) */
function frameQuat(d3: V3, d1in: V3): Quat {
  const t = norm(d3);
  const k = d1in[0] * t[0] + d1in[1] * t[1] + d1in[2] * t[2];
  const d1 = norm([d1in[0] - k * t[0], d1in[1] - k * t[1], d1in[2] - k * t[2]]);
  const d2: V3 = [t[1] * d1[2] - t[2] * d1[1], t[2] * d1[0] - t[0] * d1[2], t[0] * d1[1] - t[1] * d1[0]];
  // matrix → quaternion
  const m00 = d1[0], m11 = d2[1], m22 = t[2];
  const tr = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (d2[2] - t[1]) / s; y = (t[0] - d1[2]) / s; z = (d1[1] - d2[0]) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (d2[2] - t[1]) / s; x = 0.25 * s; y = (d2[0] + d1[1]) / s; z = (t[0] + d1[2]) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (t[0] - d1[2]) / s; x = (d2[0] + d1[1]) / s; y = 0.25 * s; z = (t[1] + d2[2]) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (d1[1] - d2[0]) / s; x = (t[0] + d1[2]) / s; y = (t[1] + d2[2]) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

/**
 * The first-person camera: from her eyes (outside pose at the start), `down` lower, `forward` further
 * toward the look point and `right` to her right, looking at `look`.
 */
export function povFrom(coil: Coiling, forward: number, down: number, right: number, look: V3, fov: number, spec: PersonSpec = NOOR): PovView {
  const e = eyesOf(rigPose(spec, coil.rig(spec, 0, false))).p;
  const f = norm([look[0] - e[0], 0, look[2] - e[2]]);
  const r: V3 = [-f[2], 0, f[0]];
  return { eye: [e[0] + f[0] * forward + r[0] * right, e[1] - down, e[2] + f[2] * forward + r[2] * right], look, fov };
}

export class CoilWorld {
  public readonly world: World3D;
  public readonly povCam: THREE.PerspectiveCamera;
  public readonly extCam: THREE.PerspectiveCamera;
  public readonly cable: CableMesh;
  public readonly noor: ReturnType<typeof twoViews>;
  public readonly n: number;
  /** where the cable to the floor crosses each loop: node indices (from the bake's checks; -1 = none) */
  public readonly cross: { loop: number; floor: number }[];
  private readonly pos: Float32Array;
  private readonly d1: Float32Array;
  private readonly halo: Float32Array;

  public constructor(
    key: string,
    public readonly bake: BakedRod,
    public readonly shot: CoilShot,
    public readonly state: CoilState,
    public readonly spec: PersonSpec = NOOR,
  ) {
    const coil = shot.coil;
    const n = (this.n = bake.n);
    this.pos = new Float32Array(3 * n);
    this.d1 = new Float32Array(3 * n);
    this.halo = new Float32Array(4 * n);
    this.cross = coil.beats.map((b) => ({ loop: Math.round(bake.track(`crossLoop${b.k}`, bake.duration)), floor: Math.round(bake.track(`crossFloor${b.k}`, bake.duration)) }));

    this.cable = new CableMesh({ maxNodes: n, radius: bake.radius, plugStart: 'xlr-male', plugEnd: 'xlr-female', haloPx: 7, haloMax: 1.2 });
    // the velcro tie on the plug end: a ring through its eyelet round the cable; its tail hangs down
    // and, after the last loop, wraps round the ring where the hand holds it (coiling.ts tiePath)
    const tieR = bake.radius + 0.0006;
    // (grey, so it reads against the black cable)
    const tie = new StrapMesh({ color: TIE_COLOR, length: 2 * Math.PI * tieR + 0.003 });
    const tail = new StrapMesh({ color: TIE_COLOR, width: 0.022, maxPoints: TIE_POINTS });
    tail.eyelet.visible = false;
    const tailPath = new Float32Array(TIE_POINTS * 3);
    const tieAxis = coil.tieGeom().axis;
    const arrow = new ArcArrow({ color: UNDER, thickness: 0.0035 });

    const pose = (t: number, pov: boolean) => rigPose(spec, coil.rig(spec, t, pov, this.rightGrip(t)));
    this.noor = twoViews(spec, pose(0, false), pose(0, true));

    this.povCam = makeCamera(50);
    viewLayers(this.povCam, 'pov');
    this.extCam = makeCamera(40);
    viewLayers(this.extCam, 'ext');

    const tieNode = Math.round(TIE_S / shot.seg);
    this.world = new World3D(key, () => {
      const t = state.t();
      const outPose = pose(t, false);
      this.noor.update(outPose, pose(t, true));
      this.noor.seeThrough(1 - 0.7 * state.xray());

      bake.frameSample(t, this.pos, this.d1);
      this.cable.update(this.pos, this.d1, n, undefined, this.writeHalo() ? this.halo : undefined);

      // the tie
      const a = this.node(tieNode - 1, t), b = this.node(tieNode + 1, t), c = this.node(tieNode, t);
      tie.pose({ center: c, axis: [b[0] - a[0], b[1] - a[1], b[2] - a[2]], start: coil.n, radius: tieR, wrap: 1, fold: 0 });
      coil.tiePath(t, tailPath);
      tail.update(tailPath, TIE_POINTS, tieAxis);

      // the 180° arrow round the right forearm while the hand turns over
      const pr = state.arrow();
      arrow.group.visible = pr !== null;
      if (pr !== null) {
        const w = outPose.joints[J.rightWrist], e = outPose.joints[J.rightElbow];
        const mid: V3 = [w[0] + (e[0] - w[0]) * 0.3, w[1] + (e[1] - w[1]) * 0.3, w[2] + (e[2] - w[2]) * 0.3];
        arrow.update({ center: mid, axis: [w[0] - e[0], w[1] - e[1], w[2] - e[2]], from: [0, 1, 0], radius: 0.055, angle: -Math.PI, progress: pr });
      }

      const pv = state.pov();
      lookFrom(this.povCam, pv.eye, pv.look, pv.fov);
      orbit(this.extCam, state.ext());
    });
    const scene = this.world.scene;
    new Studio(scene, { focus: coil.at(0.15, -0.5, 0.1), focusRadius: 0.9 });
    scene.add(this.cable.group, tie.group, tail.group, arrow.group, this.noor.out.group, this.noor.pov.group);
  }

  /** position of node i at shot time t */
  public node(i: number, t: number, out: V3 = [0, 0, 0]): V3 {
    return this.bake.nodeAt(t, Math.max(0, Math.min(this.n - 1, i)), out);
  }

  /** the cable's point at material coordinate s (m from the male plug) */
  public at(s: number, t: number): V3 {
    const f = s / this.shot.seg;
    const i = Math.max(0, Math.min(this.n - 2, Math.floor(f)));
    const u = Math.max(0, Math.min(1, f - i));
    const a = this.node(i, t), b = this.node(i + 1, t);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }

  /** the crossing of loop k (where its label points), or the loop's lowest node if none was found */
  public crossPoint(k: number, t: number): V3 {
    const c = this.cross[k - 1];
    if (c.loop >= 0) return this.node(c.loop, t);
    const [l0, l1] = this.shot.loopNodes(k);
    return this.node(Math.round((l0 + l1) / 2), t);
  }

  /**
   * The right hand's grip frame at t: the choreography's while it holds nothing, glued to the
   * baked cable (position and direction at the material point it holds) while it holds it.
   */
  public rightGrip(t: number): Frame {
    const coil = this.shot.coil;
    const r = coil.right(t);
    const b = coil.beats[r.loop];
    // how firmly the hand is on the cable: the loose fist's grip, the closed fist, fading after letting go
    let w = r.holds === 'grip' ? 1 : r.holds === 'sleeve' ? r.sleeve : 0;
    if (r.holds === 'none' && t >= b.tOpen && t < b.tOpen + 0.3) w = 1 - (t - b.tOpen) / 0.3;
    if (w <= 0) return r.hand;
    const s = r.s;
    const p = this.at(s, t);
    const ahead = this.at(s + 0.025, t), behind = this.at(s - 0.025, t);
    const along: V3 = [ahead[0] - behind[0], ahead[1] - behind[1], ahead[2] - behind[2]];
    // the choreography's cable frame, turned onto the real cable; the hand keeps its turn relative to it
    const qc = frameQuat(along, colX(r.cable.q));
    const rel = quatMul(quatConj(r.cable.q), r.hand.q);
    const glued: Frame = { p, q: quatMul(qc, rel) };
    if (w >= 1) return glued;
    const hp = r.hand.p;
    return { p: [hp[0] + (p[0] - hp[0]) * w, hp[1] + (p[1] - hp[1]) * w, hp[2] + (p[2] - hp[2]) * w], q: quatSlerp(r.hand.q, glued.q, w) };
  }

  /** writes the halos of the current highlight; false when there is none */
  private writeHalo() {
    const g = this.state.glow();
    if (!g || g.on <= 0) return false;
    const halo = this.halo;
    halo.fill(0);
    const k = g.k;
    const white = rgba('#ffffff', 0.95 * g.on);
    for (let i = this.shot.floorStart(k) + 1; i < this.n; i++) halo.set(white, 4 * i);
    const c = this.cross[k - 1];
    if (c.loop >= 0) {
      const rim = rgba(this.shot.coil.kinds[k - 1] === 'over' ? OVER : UNDER, g.on);
      const [l0, l1] = this.shot.loopNodes(k);
      for (let i = Math.max(l0, c.loop - 7); i <= Math.min(l1, c.loop + 7); i++) halo.set(rim, 4 * i);
    }
    return true;
  }
}
