// One synthetic take: the motion's person and cable rendered by the virtual Kinect (sim.ts) frame by
// frame, plus the ground truth in the take format (mocap/FORMAT.md) with an extra `truth` block.
// erzeugen.mjs runs it through Vite (the TypeScript of src/people) and writes the files.

import type { V3 } from '../../src/people/math';
import { cross, madd, norm, sub } from '../../src/people/math';
import type { Pose } from '../../src/people/people';
import { RigTrack } from '../../src/people/rig';
import { buildBody, paletteOf } from '../../src/people/body/styles';
import { MAT, Mesh } from '../../src/people/body/mesh';
import { handJoints } from '../../src/people/body/hand';
import type { Motion } from './motions';
import { H, HIT, HIT_NAMES, Intrinsics, KINECT_V2, Sensor, W, apply, compose, lutOf, mat4, place, project, room } from './sim';

// ---------------------------------------------------------------- the joints

const COCO = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];
const FEET = ['left_big_toe', 'left_small_toe', 'left_heel', 'right_big_toe', 'right_small_toe', 'right_heel'];
const HAND = [
  'wrist', 'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip', 'index_mcp', 'index_pip', 'index_dip', 'index_tip',
  'middle_mcp', 'middle_pip', 'middle_dip', 'middle_tip', 'ring_mcp', 'ring_pip', 'ring_dip', 'ring_tip',
  'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip',
];
const EXTRA = ['pelvis', 'neck', 'head'];

/** the joint list of a take: COCO-17, feet (COCO-WholeBody order), left hand 21, right hand 21, pelvis, neck, head */
export const JOINTS: string[] = [...COCO, ...FEET, ...HAND.map((n) => `left_hand_${n}`), ...HAND.map((n) => `right_hand_${n}`), ...EXTRA];

/** how far behind the visible surface a joint centre may lie and still count as seen (m) */
function tolerance(name: string): number {
  if (name.includes('_hand_')) return 0.035;
  if (/eye|nose|ear/.test(name)) return 0.05;
  if (/toe|heel/.test(name)) return 0.05;
  if (/shoulder|hip|pelvis|neck|head/.test(name)) return 0.16;
  return 0.08;
}
const TOL = JOINTS.map(tolerance);

/** heel, big toe, small toe of a foot, on the shoe's sole (body/styles.ts shoe) */
function footPoints(ankle: V3, fd: V3, q: number, sideSign: number): [V3, V3, V3] {
  const side = norm(cross(fd, [0, 1, 0]));
  const u = norm(cross(side, fd));
  // towards the other foot: + side for the left foot
  const medial: V3 = sideSign < 0 ? side : [-side[0], -side[1], -side[2]];
  const p = (along: number, down: number, med: number) => madd(madd(madd(ankle, fd, along * q), u, -down * q), medial, med * q);
  return [p(0.18, 0.058, 0.012), p(0.145, 0.058, -0.03), p(-0.075, 0.05, 0)];
}

/** all joints of a pose in the rig world (m), JOINTS order */
export function jointsOf(pose: Pose): V3[] {
  const J = pose.joints;
  const b = pose.body;
  const qf = b.k * pose.spec.build.feet;
  const [lbt, lst, lhe] = footPoints(J[15], b.footL, qf, -1);
  const [rbt, rst, rhe] = footPoints(J[16], b.footR, qf, 1);
  const hand = (i: 0 | 1): V3[] => {
    const h = b.hands[i];
    const hj = handJoints(h, i ? 1 : -1);
    return [h.wrist, ...hj.thumb, ...hj.fingers.flatMap((f) => f.p)];
  };
  return [...J.slice(0, 17), lbt, lst, lhe, rbt, rst, rhe, ...hand(0), ...hand(1), J[18], J[17], J[19]];
}

// ---------------------------------------------------------------- infrared albedos

const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * How bright each material is in the Kinect's infrared (850 nm), from its colour: skin reflects a lot
 * whatever its tone, dark fabrics little (black clothes leave holes in the depth), the cable is black
 * rubber.
 */
function irAlbedos(pal: number[][]): Float32Array {
  const out = new Float32Array(pal.length);
  pal.forEach((c, m) => {
    const l = lum(c);
    let a = 0.2 + 0.55 * l;
    if (m === MAT.skin || m === MAT.nails) a = 0.46 + 0.2 * l;
    else if (m === MAT.hair || m === MAT.hair2 || m === MAT.dye) a = 0.22 + 0.3 * l;
    else if (m === MAT.frame) a = 0.12;
    else if (m === MAT.sole) a = 0.35 + 0.35 * l;
    out[m] = a;
  });
  return out;
}

// ---------------------------------------------------------------- the cable as a tube

/** triangles of a tube (radius r, `sides` around) along a polyline, appended to out (rig world, m) */
function tube(points: V3[], r: number, sides: number, out: number[]) {
  if (points.length < 2) return;
  let prevRing: V3[] | null = null;
  let normal: V3 | null = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const t = norm(sub(b, a));
    // parallel transport of the ring's normal
    let n: V3 = normal ?? (Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    const d = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
    n = norm([n[0] - d * t[0], n[1] - d * t[1], n[2] - d * t[2]]);
    normal = n;
    const bn = cross(t, n);
    const ring: V3[] = [];
    for (let s = 0; s < sides; s++) {
      const ang = (2 * Math.PI * s) / sides;
      const c = Math.cos(ang) * r;
      const sn = Math.sin(ang) * r;
      const p = points[i];
      ring.push([p[0] + n[0] * c + bn[0] * sn, p[1] + n[1] * c + bn[1] * sn, p[2] + n[2] * c + bn[2] * sn]);
    }
    if (prevRing) {
      for (let s = 0; s < sides; s++) {
        const s1 = (s + 1) % sides;
        out.push(...prevRing[s], ...ring[s], ...ring[s1], ...prevRing[s], ...ring[s1], ...prevRing[s1]);
      }
    }
    prevRing = ring;
  }
}

/** a polyline resampled to points about `step` apart (keeps the ends) */
function resample(points: V3[], step: number): V3[] {
  const out: V3[] = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
    if (acc >= step || i === points.length - 1) {
      out.push(points[i]);
      acc = 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- one take

export interface GenOptions {
  fps?: number;
  /** length (default: the motion's) */
  seconds?: number;
  ss?: number;
  noise?: number;
  flying?: number;
  seed?: number;
  /** false: no lens distortion (k = p = 0) */
  distortion?: boolean;
  /** fraction of frames lost as in a recording with gaps (sequence numbers skip) */
  drop?: number;
  /** infrared albedo of the black cable */
  cableIr?: number;
  /** cable radius, m (Sommer SC-Stage 22: 6.4 mm diameter) */
  cableR?: number;
  /** µs since 1970 of the first frame */
  startUs?: number;
}

export interface Frame {
  index: number;
  seq: number;
  timeUs: number;
  depth: Uint16Array;
  ir: Uint8Array;
}

export interface Generated {
  info: Record<string, unknown>;
  lut: Float32Array;
  truth: Record<string, unknown>;
  stats: Record<string, unknown>;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Renders the motion frame by frame (onFrame gets each recorded frame in order) and returns the
 * recording's header (info JSON, LUT) and the ground truth.
 */
export function generate(m: Motion, o: GenOptions, onFrame: (f: Frame) => void, onHeader: (info: Record<string, unknown>, lut: Float32Array) => void): Generated {
  const fps = o.fps ?? 30;
  const seconds = o.seconds ?? m.seconds;
  const n = Math.round(seconds * fps);
  const k: Intrinsics = o.distortion === false ? { ...KINECT_V2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 } : KINECT_V2;
  const pl = place(m.setup);
  const big = m.setup.id === 'D';
  const planes = room(m.setup.distance_m, m.setup.wall_m, big ? { halfWidth: 4.5, ceiling: 3.6 } : {});
  const sensor = new Sensor(k, pl.camToWorld, planes, { ss: o.ss ?? 3, noise: o.noise ?? 1, flying: o.flying ?? 0.3, seed: o.seed ?? 1 });
  const rigToCam = compose(pl.worldToCam, pl.rigToWorld);
  const lut = lutOf(k);
  const startUs = o.startUs ?? Date.UTC(2026, 9, 12, 10, 0, 0) * 1000;
  const params = { width: W, height: H, fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, k1: k.k1, k2: k.k2, k3: k.k3, p1: k.p1, p2: k.p2, serial: 'SYNTHETIC', firmware: 'kinect-sim' };
  const info = {
    params,
    recorded_at_us: startUs,
    source_url: 'synthetic',
    hub_source: { kind: 'synthetic-render', note: 'kabel-wickeln/mocap/synthetic (keine Kinect)' },
    recorder: 'kabel-wickeln/mocap/synthetic/erzeugen.mjs',
    depth: 'u16 mm per pixel (rendered, with sensor noise)',
    ir: 'u8 per pixel (rendered, the hub\'s sqrt tone mapping)',
    synthetic: {
      motion: m.name, shot: m.shot, role: m.role, person: m.spec.name, setup: m.setup, truth: `${m.name}.truth.json.gz`,
      options: { fps, seconds, ss: o.ss ?? 3, noise: o.noise ?? 1, flying: o.flying ?? 0.3, seed: o.seed ?? 1, distortion: o.distortion !== false, drop: o.drop ?? 0 },
    },
  };
  onHeader(info, lut);

  const track = new RigTrack(m.spec, (t) => m.rigAt(t), 0, 60);
  const mesh = new Mesh();
  const pal = paletteOf(m.spec);
  const albedoOfMat = irAlbedos(pal);
  let bodyTris = new Float32Array(0);
  let bodyAlb = new Float32Array(0);
  let bodyIds = new Uint8Array(0);
  const cableIr = o.cableIr ?? 0.1;
  const cableR = o.cableR ?? 0.0032;
  const depth = new Uint16Array(W * H);
  const ir = new Uint8Array(W * H);
  const dropRng = new (class {
    s = (o.seed ?? 1) * 7919 + 13;
    next() {
      this.s = (this.s * 1103515245 + 12345) % 2147483648;
      return this.s / 2147483648;
    }
  })();

  const J = JOINTS.length;
  const T: number[] = [];
  const pos: number[][] = [];
  const conf: number[][] = [];
  const how: string[] = [];
  const cable: { pts: number[]; conf: number }[][] = [];
  const uv: number[][] = [];
  const zcam: number[][] = [];
  const zsurf: number[][] = [];
  const hit: string[] = [];
  const vis: string[] = [];
  const reach: number[] = [];
  const visCount = new Array<number>(J).fill(0);
  const hitChar = ['-', 'f', 'w', 's', 'c', 'p', 'k'];
  let seq = 0;
  let kept = 0;
  const t0 = performance.now();

  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const lost = i > 0 && i < n - 1 && (o.drop ?? 0) > 0 && dropRng.next() < (o.drop ?? 0);
    seq++;
    if (lost) continue;
    const pose = track.pose(t);
    buildBody(pose, mesh);
    const nt = mesh.tri.length / 3;
    if (bodyTris.length !== nt * 9) {
      bodyTris = new Float32Array(nt * 9);
      bodyAlb = new Float32Array(nt);
      bodyIds = new Uint8Array(nt).fill(HIT.person);
      for (let f = 0; f < nt; f++) bodyAlb[f] = albedoOfMat[mesh.mat[f]];
    }
    for (let f = 0; f < nt; f++) {
      for (let v = 0; v < 3; v++) {
        const a = mesh.tri[f * 3 + v] * 3;
        const c = apply(rigToCam, [mesh.pos[a], mesh.pos[a + 1], mesh.pos[a + 2]]);
        bodyTris[f * 9 + v * 3] = c[0];
        bodyTris[f * 9 + v * 3 + 1] = c[1];
        bodyTris[f * 9 + v * 3 + 2] = c[2];
      }
    }
    sensor.clear();
    sensor.draw(bodyTris, nt, bodyAlb, bodyIds);
    // the cable
    const lines = m.cable ? m.cable(t, pose) : [];
    const frameCable: { pts: number[]; conf: number }[] = [];
    for (const line of lines) {
      const tri: number[] = [];
      tube(line, cableR, 6, tri);
      const nc = tri.length / 9;
      const ct = new Float32Array(tri.length);
      for (let v = 0; v < tri.length; v += 3) {
        const c = apply(rigToCam, [tri[v], tri[v + 1], tri[v + 2]]);
        ct[v] = c[0];
        ct[v + 1] = c[1];
        ct[v + 2] = c[2];
      }
      sensor.draw(ct, nc, new Float32Array(nc).fill(cableIr), new Uint8Array(nc).fill(HIT.cable));
      const pts: number[] = [];
      for (const p of resample(line, 0.02)) pts.push(...apply(pl.rigToWorld, p).map((x) => Math.round(x * 1000)));
      frameCable.push({ pts, conf: 100 });
    }
    // the ground truth, before the noise
    const js = jointsOf(pose);
    const fp: number[] = [];
    const fuv: number[] = [];
    const fz: number[] = [];
    const fs: number[] = [];
    let fh = '';
    let fv = '';
    js.forEach((p, j) => {
      const w = apply(pl.rigToWorld, p);
      fp.push(Math.round(w[0] * 1000), Math.round(w[1] * 1000), Math.round(w[2] * 1000));
      const c = apply(rigToCam, p);
      const [u, v] = c[2] > 0.2 ? project(k, c[0], c[1], c[2]) : [-1, -1];
      const inside = u >= -0.5 && u < W - 0.5 && v >= -0.5 && v < H - 0.5;
      fuv.push(r1(u), r1(v));
      fz.push(Math.round(c[2] * 1000));
      const s = inside ? sensor.at(u, v) : { z: 0, id: HIT.none };
      fs.push(Math.round(s.z));
      fh += inside ? hitChar[s.id] : '-';
      const seen = inside && s.z >= c[2] * 1000 - TOL[j] * 1000;
      fv += !inside ? 'x' : seen ? 'v' : 'o';
      if (seen) visCount[j]++;
    });
    const arms = pose.body.arms;
    reach.push(Math.max(arms?.[0].report.posError ?? 0, arms?.[1].report.posError ?? 0));
    sensor.measure(depth, ir);
    const timeUs = startUs + Math.round((t * 1e6));
    onFrame({ index: kept, seq, timeUs, depth, ir });
    T.push(+t.toFixed(6));
    pos.push(fp);
    conf.push(new Array<number>(J).fill(100));
    how.push('T'.repeat(J));
    cable.push(frameCable);
    uv.push(fuv);
    zcam.push(fz);
    zsurf.push(fs);
    hit.push(fh);
    vis.push(fv);
    kept++;
  }
  const wallSeconds = (performance.now() - t0) / 1000;

  const camToWorldMm = mat4(pl.camToWorld, 1000);
  const R = pl.camToWorld.R;
  // the floor in CAMERA coordinates: height above it = normal · p + d (mm)
  const floorN = [R[3], R[4], R[5]];
  const uniform = kept === n;
  const truth = {
    format: 'kabel-wickeln-take',
    version: 1,
    kind: 'truth',
    shot: m.shot,
    take: 1,
    source: `${m.name}.k2rec`,
    recorded_at: new Date(startUs / 1000).toISOString(),
    setup: m.setup.id,
    kinect: { height_m: m.setup.height_m, distance_m: m.setup.distance_m, yaw_deg: m.setup.yaw_deg, pitch_deg: m.setup.pitch_deg, note: m.setup.note },
    fps,
    frames: kept,
    t: uniform ? { t0: 0, dt: 1 / fps } : T,
    camera: {
      width: W, height: H, fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, k1: k.k1, k2: k.k2, k3: k.k3, p1: k.p1, p2: k.p2,
      mirrored: true,
      frame: 'CAMERA: unmirrored depth camera, mm; x right as seen from the sensor looking into the scene, y down, z forward. Hub pixel (u, v) with depth z: hub point (lut.x*z, lut.y*z, z), CAMERA point (-lut.x*z, lut.y*z, z).',
    },
    floor: { normal: floorN.map((x) => +x.toFixed(6)), d_mm: Math.round(m.setup.height_m * 1000), rms_mm: 0, frame: 'CAMERA; height above the floor of a CAMERA point p (mm) = normal·p + d_mm' },
    world: {
      frame: 'WORLD: mm, y up, floor y = 0, origin on the floor below the sensor, +z horizontal from the person towards the sensor (the camera looks along -z), x = y × z (right as seen from the sensor). A person facing the sensor faces +z, its left hand is on +x.',
      cam_to_world: camToWorldMm.map((x) => +x.toFixed(6)),
      sensor_mm: [0, Math.round(m.setup.height_m * 1000), 0],
      mark_mm: pl.mark.map((x) => Math.round(x * 1000)),
    },
    joints: JOINTS,
    pos,
    conf,
    how,
    cable,
    quality: {
      joints: Object.fromEntries(JOINTS.map((name, j) => [name, { conf: 1, depth_hits: +(visCount[j] / kept).toFixed(3), jitter_mm: 0 }])),
      note: 'ground truth: conf 1, jitter 0; depth_hits = fraction of frames in which the joint is seen (not hidden, in the picture)',
    },
    markers: { clap: m.markers.clap, start: m.markers.start, end: m.markers.end },
    truth: {
      motion: m.name,
      about: m.about,
      preview_s: m.previews,
      person: { name: m.spec.name, height_m: m.spec.height },
      how: 'T = ground truth (the rig\'s joint, never measured)',
      rig_to_world: mat4(pl.rigToWorld, 1000).map((x) => +x.toFixed(6)),
      rig_frame: 'rig world of src/people: m, y up, the person on the mark at the origin facing -z',
      joint_centres: 'positions are joint centres inside the body (the rig\'s skeleton), not points on the skin',
      uv: 'per frame: u, v per joint (hub pixels, mirrored image, with lens distortion; -1 behind the sensor)',
      uv_values: uv,
      zcam_mm: zcam,
      zsurf: 'per frame: the depth (mm) of the first surface the sensor sees at the joint\'s pixel, before noise',
      zsurf_mm: zsurf,
      hit: 'per frame, one character per joint: what the sensor sees at its pixel: p person, k cable, f floor, w wall, s side wall, c ceiling, - outside the picture',
      hit_codes: hit,
      visible: 'per frame, one character per joint: v seen (the surface at its pixel is at most the joint\'s tolerance in front of it), o hidden, x outside the picture',
      tolerance_mm: Object.fromEntries(JOINTS.map((name, j) => [name, Math.round(TOL[j] * 1000)])),
      visible_codes: vis,
      ik_pos_error_max_mm: Math.round(Math.max(...reach) * 1000),
      room: planes.map((q) => ({ what: HIT_NAMES[q.id], normal: q.n, c_mm: Math.round(q.c * 1000), ir_albedo: q.albedo })),
      room_frame: 'WORLD; inside the room where normal·p < c_mm (normal points out)',
      wall_m: m.setup.wall_m,
      sensor_model: { noise: o.noise ?? 1, flying: o.flying ?? 0.3, ss: o.ss ?? 3, range_mm: [500, 4500], cable_ir_albedo: cableIr, cable_radius_mm: cableR * 1000 },
      hit_names: HIT_NAMES,
    },
  };
  return {
    info,
    lut,
    truth,
    stats: { frames: kept, seconds, wallSeconds: +wallSeconds.toFixed(1), msPerFrame: Math.round((wallSeconds * 1000) / Math.max(1, kept)), ikPosErrorMaxMm: Math.round(Math.max(...reach) * 1000) },
  };
}
