// The 3D stage: the room with truss, LED wall and Kinect, the Kinect's field of view, the people
// and everything the Kinect makes of them (point cloud, motion, skeletons). Drawn with Canvas 2D
// through our own camera (lib/camera.ts); every element has a signal (0..1) to animate it.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { Camera } from '../lib/camera';
import { FLUID } from '../lib/fluid';
import { depthColor, farDim, flowColor } from '../lib/images';
import { V3, clamp, easeOutBack, hash, hexRgb, hsv, lerp, rgba, smooth } from '../lib/math';
import { BONES, Pose, people } from '../lib/people';
import { SensorFrame, rayX, rayXAt, rayY, rayYAt, sense } from '../lib/sensor';
import { Splatter } from '../lib/splat';
import { C, FONT } from '../lib/theme';
import { FURNITURE, INTR, KINECT, ROOM, TRUSS, WALL, aboveFloor, cabinets, floorZone, fovCorners, segAboveFloor, trussSegments } from '../lib/world';

export interface StageProps extends RectProps {
  time?: SignalValue<number>;
  yaw?: SignalValue<number>;
  pitch?: SignalValue<number>;
  dist?: SignalValue<number>;
  tx?: SignalValue<number>;
  ty?: SignalValue<number>;
  tz?: SignalValue<number>;
  fov?: SignalValue<number>;
  shiftX?: SignalValue<number>;
  shiftY?: SignalValue<number>;
  grid?: SignalValue<number>;
  truss?: SignalValue<number>;
  wall?: SignalValue<number>;
  wallLit?: SignalValue<number>;
  wallAlpha?: SignalValue<number>;
  wallContent?: SignalValue<string>;
  kinect?: SignalValue<number>;
  roomAlpha?: SignalValue<number>;
  frustum?: SignalValue<number>;
  frustumAlpha?: SignalValue<number>;
  zone?: SignalValue<number>;
  pulses?: SignalValue<number>;
  pulseStart?: SignalValue<number>;
  figures?: SignalValue<number>;
  figureColor?: SignalValue<number>;
  silhouette?: SignalValue<number>;
  cloud?: SignalValue<number>;
  cloudFly?: SignalValue<number>;
  flyX?: SignalValue<number>;
  flyY?: SignalValue<number>;
  flyW?: SignalValue<number>;
  flyH?: SignalValue<number>;
  colorFlow?: SignalValue<number>;
  colorMask?: SignalValue<number>;
  maskGrow?: SignalValue<number>;
  bgGrey?: SignalValue<number>;
  bgDrop?: SignalValue<number>;
  streaks?: SignalValue<number>;
  skel?: SignalValue<number>;
  skelFly?: SignalValue<number>;
  ray?: SignalValue<number>;
  rayLink?: SignalValue<number>;
  labels?: SignalValue<number>;
  dims?: SignalValue<number>;
  ping?: SignalValue<number>;
  spill?: SignalValue<number>;
}

const TRUSS_SEGS = trussSegments();
const CABINETS = cabinets();
const LENS: V3 = [KINECT[0], KINECT[1], KINECT[2] + 0.035];
/** the pixel the ray demo picks: on the chest of person 1 */
export const RAY_PIXEL = { slot: 1 };

/** the pixel that becomes a point in the ray demo: on the chest of person 1 */
export function rayTarget(f: SensorFrame): { u: number; v: number; p: V3; d: number } | null {
  const person = f.persons.find((p) => p.slot === RAY_PIXEL.slot);
  if (!person) return null;
  const neck = person.img[17];
  const pelvis = person.img[18];
  if (!neck || !pelvis) return null;
  const u = Math.round(lerp(neck[0], pelvis[0], 0.3));
  const v = Math.round(lerp(neck[1], pelvis[1], 0.3));
  const d = f.depth[v * INTR.w + u];
  if (!(d > 0)) return null;
  return { u, v, d, p: [KINECT[0] + rayX(u) * d, KINECT[1] + rayY(v) * d, KINECT[2] + d] };
}

export class Stage extends Rect {
  @initial(0) @signal() public declare readonly time: SimpleSignal<number, this>;
  @initial(25) @signal() public declare readonly yaw: SimpleSignal<number, this>;
  @initial(15) @signal() public declare readonly pitch: SimpleSignal<number, this>;
  @initial(10) @signal() public declare readonly dist: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly tx: SimpleSignal<number, this>;
  @initial(1.2) @signal() public declare readonly ty: SimpleSignal<number, this>;
  @initial(1.5) @signal() public declare readonly tz: SimpleSignal<number, this>;
  @initial(40) @signal() public declare readonly fov: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly shiftX: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly shiftY: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly grid: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly truss: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly wall: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly wallLit: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly wallAlpha: SimpleSignal<number, this>;
  @initial('idle') @signal() public declare readonly wallContent: SimpleSignal<string, this>;
  @initial(1) @signal() public declare readonly kinect: SimpleSignal<number, this>;
  @initial(0.7) @signal() public declare readonly roomAlpha: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly frustum: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly frustumAlpha: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly zone: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly pulses: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly pulseStart: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly figures: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly figureColor: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly silhouette: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly cloud: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly cloudFly: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly flyX: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly flyY: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly flyW: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly flyH: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly colorFlow: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly colorMask: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly maskGrow: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly bgGrey: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly bgDrop: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly streaks: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly skel: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly skelFly: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly ray: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly rayLink: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly labels: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly dims: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly ping: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly spill: SimpleSignal<number, this>;

  readonly cam = new Camera();
  private splat = new Splatter();
  private glowCanvas = document.createElement('canvas');

  public constructor(props?: StageProps) {
    super({ width: 1920, height: 1080, ...props });
  }

  /** the camera as it is now (for overlays in the scenes) */
  camera() {
    const s = this.size();
    this.cam.width = s.x;
    this.cam.height = s.y;
    this.cam.setPose({
      target: [this.tx(), this.ty(), this.tz()],
      yaw: this.yaw(),
      pitch: this.pitch(),
      distance: this.dist(),
      fov: this.fov(),
      shiftX: this.shiftX(),
      shiftY: this.shiftY(),
    });
    return this.cam;
  }

  protected override draw(ctx: CanvasRenderingContext2D) {
    const size = this.size();
    const W = size.x;
    const H = size.y;
    const cam = this.camera();
    const T = this.time();
    ctx.save();
    ctx.beginPath();
    ctx.rect(-W / 2, -H / 2, W, H);
    ctx.clip();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const needSensor = this.cloud() > 0 || this.skel() > 0 || this.streaks() > 0 || this.ray() > 0;
    const frame = needSensor ? sense(T) : null;
    const persons = people(T);

    if (this.grid() > 0) this.drawGrid(ctx, cam);
    if (this.spill() > 0) this.drawSpill(ctx, cam, T);
    if (this.zone() > 0) {
      ctx.save();
      ctx.globalAlpha *= this.frustumAlpha();
      this.drawZone(ctx, cam);
      ctx.restore();
    }
    if (this.roomAlpha() > 0) this.drawRoom(ctx, cam);
    if (this.wallAlpha() > 0) {
      this.drawTruss(ctx, cam);
      this.drawWall(ctx, cam, T);
    }
    if (this.kinect() > 0) this.drawKinect(ctx, cam);
    if (this.frustum() > 0 && this.frustumAlpha() > 0) {
      ctx.save();
      ctx.globalAlpha *= this.frustumAlpha();
      this.drawFrustum(ctx, cam, T);
      ctx.restore();
    }
    if (this.figures() > 0) this.drawFigures(ctx, cam, persons, T);
    if (frame && this.cloud() > 0) this.drawCloud(ctx, cam, frame, W, H);
    if (frame && this.streaks() > 0) this.drawStreaks(ctx, cam, frame);
    if (frame && this.skel() > 0) this.drawSkeletons(ctx, cam, frame);
    if (frame && (this.ray() > 0 || this.rayLink() > 0)) this.drawRay(ctx, cam, frame);
    if (this.labels() > 0 || this.dims() > 0) this.drawLabels(ctx, cam);
    if (this.ping() > 0) this.drawPing(ctx, cam);
    ctx.restore();
    this.drawChildren(ctx);
  }

  // ---------------------------------------------------------------- helpers

  private line(ctx: CanvasRenderingContext2D, cam: Camera, a: V3, b: V3) {
    const s = cam.segment(a, b);
    if (!s) return;
    ctx.moveTo(s[0], s[1]);
    ctx.lineTo(s[2], s[3]);
  }

  private poly(ctx: CanvasRenderingContext2D, cam: Camera, pts: V3[]) {
    let first = true;
    for (const p of pts) {
      const q = cam.project(p);
      if (!q) return false;
      if (first) ctx.moveTo(q[0], q[1]);
      else ctx.lineTo(q[0], q[1]);
      first = false;
    }
    ctx.closePath();
    return true;
  }

  // ---------------------------------------------------------------- room

  private drawGrid(ctx: CanvasRenderingContext2D, cam: Camera) {
    const p = this.grid();
    const reach = 1.5 + p * 7.5;
    ctx.lineWidth = 1.2;
    for (let i = -10; i <= 10; i++) {
      const x = i * 0.5;
      for (const along of [0, 1]) {
        const a: V3 = along ? [-5, 0, x + 2.5] : [x, 0, -1.2];
        const b: V3 = along ? [5, 0, x + 2.5] : [x, 0, 6.2];
        const d = along ? Math.abs(x + 2.5 - 2) : Math.abs(x);
        const alpha = clamp((reach - d) / 1.5) * (Number.isInteger(x) ? 1 : 0.55);
        if (alpha <= 0) continue;
        // the line grows from its middle
        const k = clamp((reach - d) / 4);
        const m: V3 = [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2];
        const a2: V3 = [lerp(m[0], a[0], k), 0, lerp(m[2], a[2], k)];
        const b2: V3 = [lerp(m[0], b[0], k), 0, lerp(m[2], b[2], k)];
        ctx.strokeStyle = rgba(hexRgb(Number.isInteger(x) ? C.gridHi : C.grid), alpha * 0.9);
        ctx.beginPath();
        this.line(ctx, cam, a2, b2);
        ctx.stroke();
      }
    }
  }

  private drawRoom(ctx: CanvasRenderingContext2D, cam: Camera) {
    const a = this.roomAlpha() * (1 - this.bgDrop());
    if (a <= 0) return;
    ctx.strokeStyle = rgba(hexRgb(C.room), 0.55 * a);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    // the back of the room behind the audience
    const s = ROOM.side;
    const b = ROOM.back;
    const h = ROOM.ceiling;
    this.line(ctx, cam, [-s, 0, b], [s, 0, b]);
    this.line(ctx, cam, [-s, 0, b], [-s, h, b]);
    this.line(ctx, cam, [s, 0, b], [s, h, b]);
    for (const box of FURNITURE) {
      const [x0, y0, z0] = box.min;
      const [x1, y1, z1] = box.max;
      const c: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) this.line(ctx, cam, c[i], c[j]);
    }
    ctx.stroke();
  }

  private drawTruss(ctx: CanvasRenderingContext2D, cam: Camera) {
    const p = this.truss();
    if (p <= 0) return;
    const alpha = this.wallAlpha();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = rgba(hexRgb(C.truss), 0.85 * alpha);
    ctx.beginPath();
    for (const s of TRUSS_SEGS) {
      if (s.at > p) continue;
      this.line(ctx, cam, s.a, s.b);
    }
    ctx.stroke();
  }

  private cabinetProgress(order: number) {
    const start = (order / CABINETS.length) * 0.8;
    return clamp((this.wall() - start) / 0.2);
  }

  private drawWall(ctx: CanvasRenderingContext2D, cam: Camera, T: number) {
    const alpha = this.wallAlpha();
    const lit = this.wallLit();
    const content = this.wallContent();
    // chains from the beam to the wall
    const top = WALL.bottom + WALL.h;
    const beam = TRUSS.height - TRUSS.size;
    const chains = clamp(this.wall() * 8);
    if (chains > 0) {
      ctx.strokeStyle = rgba(hexRgb(C.truss), 0.7 * alpha * chains);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const x = -WALL.w / 2 + (i * WALL.w) / 6;
        this.line(ctx, cam, [x, top, 0], [x, lerp(top, beam, 1), 0]);
      }
      ctx.stroke();
    }
    for (const cab of CABINETS) {
      const p = this.cabinetProgress(cab.order);
      if (p <= 0) continue;
      const dy = (1 - easeOutBack(p)) * 0.6;
      const pts = cab.corners.map((c): V3 => [c[0], c[1] + dy, c[2]]);
      const a = clamp(p * 3) * alpha;
      ctx.beginPath();
      if (!this.poly(ctx, cam, pts)) continue;
      let fill = hexRgb(C.cabinet);
      if (lit > 0 && content === 'test') {
        const c = hsv(cab.col / WALL.cols, 0.55, 0.35 + 0.55 * (1 - cab.row / WALL.rows));
        const flash = clamp(1 - Math.abs(lit * 1.4 - 0.2 - cab.order / CABINETS.length) * 3);
        fill = [lerp(fill[0], c[0], lit) + flash * 0.3, lerp(fill[1], c[1], lit) + flash * 0.3, lerp(fill[2], c[2], lit) + flash * 0.3];
      } else if (lit > 0 && content === 'idle') {
        const u = (cab.col + 0.5) / WALL.cols;
        const v = (cab.row + 0.5) / WALL.rows;
        const w = 0.5 + 0.5 * Math.sin(T * 0.6 + u * 4 - v * 2);
        const c: [number, number, number] = [0.1 + 0.18 * w * u, 0.09 + 0.05 * w, 0.32 + 0.12 * w * (1 - u)];
        fill = [lerp(fill[0], c[0], lit), lerp(fill[1], c[1], lit), lerp(fill[2], c[2], lit)];
      }
      ctx.fillStyle = rgba(fill, a);
      ctx.fill();
      ctx.strokeStyle = rgba(hexRgb(C.cabinetEdge), a * (content === 'fluid' ? 0.6 : 1));
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (lit > 0 && content === 'fluid') this.drawWallImage(ctx, cam, FLUID.at(T).image(), lit * alpha);
  }

  /** an image on the wall rectangle (affine: exact when the camera looks straight at the wall) */
  private drawWallImage(ctx: CanvasRenderingContext2D, cam: Camera, img: CanvasImageSource, alpha: number) {
    const top = WALL.bottom + WALL.h;
    const tl = cam.project([-WALL.w / 2, top, 0.001]);
    const tr = cam.project([WALL.w / 2, top, 0.001]);
    const bl = cam.project([-WALL.w / 2, WALL.bottom, 0.001]);
    if (!tl || !tr || !bl) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.transform(tr[0] - tl[0], tr[1] - tl[1], bl[0] - tl[0], bl[1] - tl[1], tl[0], tl[1]);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, 1, 1);
    ctx.restore();
    // the seams between the cabinets
    ctx.strokeStyle = `rgba(0,0,0,${0.45 * alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < WALL.cols; c++) {
      const x = -WALL.w / 2 + (c * WALL.w) / WALL.cols;
      this.line(ctx, cam, [x, WALL.bottom, 0.002], [x, top, 0.002]);
    }
    for (let r = 1; r < WALL.rows; r++) {
      const y = WALL.bottom + (r * WALL.h) / WALL.rows;
      this.line(ctx, cam, [-WALL.w / 2, y, 0.002], [WALL.w / 2, y, 0.002]);
    }
    ctx.stroke();
  }

  /** the wall's light on the floor in front of it */
  private drawSpill(ctx: CanvasRenderingContext2D, cam: Camera, T: number) {
    const img = FLUID.at(T).image();
    const a = cam.project([-WALL.w / 2 - 0.4, 0, 0.1]);
    const b = cam.project([WALL.w / 2 + 0.4, 0, 0.1]);
    const c = cam.project([-WALL.w / 2 - 0.4, 0, 3.2]);
    if (!a || !b || !c) return;
    ctx.save();
    ctx.globalAlpha *= this.spill() * 0.55;
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(18px)';
    ctx.transform(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1], a[0], a[1]);
    ctx.drawImage(img, 0, 0, img.width, img.height * 0.5, 0, 1, 1, -1);
    ctx.restore();
  }

  // ---------------------------------------------------------------- Kinect

  private drawKinect(ctx: CanvasRenderingContext2D, cam: Camera) {
    const p = this.kinect();
    const standP = clamp(p * 2);
    const bodyP = clamp(p * 2 - 1);
    const [kx, ky, kz] = KINECT;
    // stand: pole and three legs
    ctx.strokeStyle = rgba(hexRgb(C.truss), 0.9 * standP);
    ctx.lineWidth = 2;
    ctx.beginPath();
    const poleTop = (ky - 0.05) * standP;
    this.line(ctx, cam, [kx, 0.3 * Math.min(1, standP * 2), kz], [kx, poleTop, kz]);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      const r = 0.24 * standP;
      this.line(ctx, cam, [kx, 0.3 * standP, kz], [kx + Math.cos(a) * r, 0, kz + Math.sin(a) * r]);
    }
    ctx.stroke();
    if (bodyP <= 0) return;
    // the body drops onto the stand
    const drop = (1 - easeOutBack(bodyP)) * 0.5;
    const hw = 0.125;
    const hh = 0.033;
    const hd = 0.033;
    const y = ky + drop;
    const c: V3[] = [
      [kx - hw, y - hh, kz - hd], [kx + hw, y - hh, kz - hd], [kx + hw, y + hh, kz - hd], [kx - hw, y + hh, kz - hd],
      [kx - hw, y - hh, kz + hd], [kx + hw, y - hh, kz + hd], [kx + hw, y + hh, kz + hd], [kx - hw, y + hh, kz + hd],
    ];
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
    const sorted = faces
      .map((f) => ({ f, d: f.reduce((s, i) => s + (cam.view(c[i])[2] ?? 0), 0) / 4 }))
      .sort((a, b) => b.d - a.d);
    for (const { f } of sorted) {
      ctx.beginPath();
      if (!this.poly(ctx, cam, f.map((i) => c[i]))) continue;
      ctx.fillStyle = rgba([0.07, 0.08, 0.1], bodyP);
      ctx.fill();
      ctx.strokeStyle = rgba(hexRgb(C.line), 0.85 * bodyP);
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    // lens and infrared emitter on the front (towards the audience)
    const lens = cam.project([kx - 0.03, y, kz + hd + 0.002]);
    const emitter = cam.project([kx + 0.035, y, kz + hd + 0.002]);
    if (lens && emitter) {
      const r = Math.max(2, cam.ppm(lens[2]) * 0.012);
      ctx.fillStyle = rgba(hexRgb(C.sensor), bodyP);
      ctx.beginPath();
      ctx.arc(lens[0], lens[1], r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(hexRgb(C.ir), bodyP);
      ctx.beginPath();
      ctx.arc(emitter[0], emitter[1], r * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPing(ctx: CanvasRenderingContext2D, cam: Camera) {
    const p = this.ping();
    const k = cam.project(KINECT);
    if (!k || p <= 0 || p >= 1) return;
    ctx.strokeStyle = rgba(hexRgb(C.sensor), (1 - p) * 0.9);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(k[0], k[1], 12 + p * 90, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- field of view

  private drawFrustum(ctx: CanvasRenderingContext2D, cam: Camera, T: number) {
    const p = this.frustum();
    const d = Math.max(0.01, INTR.far * p);
    const far = fovCorners(d);
    const sensor = hexRgb(C.sensor);
    // faint faces, cut at the floor
    ctx.fillStyle = rgba(sensor, 0.045 * p);
    for (let i = 0; i < 4; i++) {
      const face = aboveFloor([LENS, far[i], far[(i + 1) % 4]]);
      ctx.beginPath();
      if (face.length > 2 && this.poly(ctx, cam, face)) ctx.fill();
    }
    // edges, near and far rectangle
    const near = fovCorners(INTR.near);
    for (const [width, alpha] of [[6, 0.12], [1.6, 0.9]]) {
      ctx.strokeStyle = rgba(sensor, alpha * Math.min(1, p * 3));
      ctx.lineWidth = width;
      ctx.beginPath();
      const seg = (a: V3, b: V3) => {
        const s2 = segAboveFloor(a, b);
        if (s2) this.line(ctx, cam, s2[0], s2[1]);
      };
      for (const c of far) seg(LENS, c);
      for (let i = 0; i < 4; i++) seg(far[i], far[(i + 1) % 4]);
      if (d > INTR.near) for (let i = 0; i < 4; i++) seg(near[i], near[(i + 1) % 4]);
      ctx.stroke();
    }
    // infrared pulses running out of the sensor
    const pulses = this.pulses();
    if (pulses > 0) {
      const t = T - this.pulseStart();
      const ir = hexRgb(C.ir);
      for (let k = 0; k < 4; k++) {
        const s = t * 1.1 - k * 0.55;
        if (s < 0) continue;
        const dd = INTR.near + ((s * 2.2) % 4.4);
        if (dd > d) continue;
        const fade = (1 - (dd - INTR.near) / 4.4) * pulses;
        const q = aboveFloor(fovCorners(dd));
        ctx.fillStyle = rgba(ir, 0.07 * fade);
        ctx.strokeStyle = rgba(ir, 0.75 * fade);
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (q.length > 2 && this.poly(ctx, cam, q)) {
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  private drawZone(ctx: CanvasRenderingContext2D, cam: Camera) {
    const p = this.zone();
    const z = floorZone();
    ctx.fillStyle = rgba(hexRgb(C.sensor), 0.1 * p);
    ctx.strokeStyle = rgba(hexRgb(C.sensor), 0.5 * p);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (this.poly(ctx, cam, z)) {
      ctx.fill();
      ctx.stroke();
    }
  }

  /** how strongly an infrared pulse lights up something at distance d right now */
  private pulseHit(d: number, T: number) {
    const pulses = this.pulses();
    if (pulses <= 0) return 0;
    const t = T - this.pulseStart();
    let best = 0;
    for (let k = 0; k < 4; k++) {
      const s = t * 1.1 - k * 0.55;
      if (s < 0) continue;
      const dd = INTR.near + ((s * 2.2) % 4.4);
      best = Math.max(best, clamp(1 - Math.abs(dd - d) / 0.35));
    }
    return best * pulses;
  }

  // ---------------------------------------------------------------- people

  private drawFigures(ctx: CanvasRenderingContext2D, cam: Camera, list: Pose[], T: number) {
    const alpha = this.figures();
    const colorK = this.figureColor();
    const sil = this.silhouette();
    const base = hexRgb(C.figure);
    const ir = hexRgb(C.ir);
    const sorted = list
      .map((p) => ({ p, d: cam.view(p.center)[2] }))
      .filter((e) => e.d > 0.1)
      .sort((a, b) => b.d - a.d);
    for (const { p } of sorted) {
      const hit = this.pulseHit(p.center[2] - KINECT[2], T);
      let fill: [number, number, number] = [lerp(base[0], p.color[0], colorK), lerp(base[1], p.color[1], colorK), lerp(base[2], p.color[2], colorK)];
      fill = [lerp(fill[0], ir[0], hit), lerp(fill[1], ir[1], hit), lerp(fill[2], ir[2], hit)];
      const caps = p.capsules
        .map((c) => {
          const a = cam.project(c.a);
          const b = cam.project(c.b);
          if (!a || !b) return null;
          const w = (2 * c.r * cam.focal) / ((a[2] + b[2]) / 2);
          return { a, b, w };
        })
        .filter((c): c is { a: V3; b: V3; w: number } => c !== null);
      const pass = (extra: number, style: string) => {
        ctx.strokeStyle = style;
        for (const c of caps) {
          ctx.lineWidth = c.w + extra;
          ctx.beginPath();
          ctx.moveTo(c.a[0], c.a[1]);
          ctx.lineTo(c.b[0] + 0.01, c.b[1]);
          ctx.stroke();
        }
      };
      if (sil > 0) {
        // dark silhouettes with a colored rim (lit by the wall)
        pass(5, rgba(p.color, 0.85 * alpha * sil));
        pass(0, rgba([0.02, 0.025, 0.04], alpha));
      } else {
        pass(3, rgba(fill, 0.95 * alpha));
        pass(-1.5, rgba([fill[0] * 0.22, fill[1] * 0.22, fill[2] * 0.25], 0.92 * alpha));
      }
    }
  }

  // ---------------------------------------------------------------- point cloud

  private drawCloud(ctx: CanvasRenderingContext2D, cam: Camera, f: SensorFrame, W: number, H: number) {
    const m = ctx.getTransform();
    const scale = Math.max(0.25, Math.hypot(m.a, m.b));
    const alpha = this.cloud();
    const fly = this.cloudFly();
    const flowK = this.colorFlow();
    const maskK = this.colorMask();
    const grow = this.maskGrow();
    const grey = this.bgGrey();
    const drop = this.bgDrop();
    const fx = this.flyX();
    const fy = this.flyY();
    const fw = this.flyW();
    const fh = this.flyH();
    const sp = this.splat;
    sp.begin(W * scale, H * scale);
    const step = 2;
    const colors = new Map(f.persons.map((p) => [p.slot, p.color]));
    const col = [0, 0, 0];
    const out = [0, 0, 0];
    const kx = KINECT[0];
    const ky = KINECT[1];
    const kz = KINECT[2];
    for (let v = 0; v < INTR.h; v += step) {
      const ry = rayY(v);
      for (let u = 0; u < INTR.w; u += step) {
        const i = v * INTR.w + u;
        const d = f.depth[i];
        if (d <= 0) continue;
        const slot = f.label[i];
        let px = kx + rayX(u) * d;
        let py = ky + ry * d;
        const pz = kz + d;
        let a = alpha;
        // the room drops away
        if (!slot && drop > 0) {
          const delay = hash(i, 17) * 0.45;
          const q = clamp((drop - delay) / 0.55);
          py -= 2.4 * q * q;
          a *= 1 - q;
          if (a <= 0.01) continue;
        }
        if (!cam.projectInto(px, py, pz, out)) continue;
        let sx = out[0];
        let sy = out[1];
        const vz = out[2];
        let size = Math.max(1.6, (1.25 * step * d * cam.focal) / (INTR.f * vz));
        if (fly < 1) {
          const delay = hash(u, v, 3) * 0.5;
          const q = clamp((fly - delay) / 0.5);
          const e = q * q * (3 - 2 * q);
          const ix = fx + (u / INTR.w - 0.5) * fw;
          const iy = fy + (v / INTR.h - 0.5) * fh;
          sx = lerp(ix, sx, e);
          sy = lerp(iy, sy, e);
          size = lerp((fw / INTR.w) * step * 1.05, size, e);
          if (q <= 0) a *= 0.0;
        }
        depthColor(d, col);
        const far = farDim(d);
        let r = col[0] * far;
        let g = col[1] * far;
        let b = col[2] * far;
        if (flowK > 0) {
          const m2 = Math.hypot(f.flowU[i], f.flowV[i]);
          const k = clamp((m2 - 0.15) / 1.2) * flowK;
          const dim = 1 - 0.82 * flowK;
          r *= dim;
          g *= dim;
          b *= dim;
          if (k > 0) {
            const c = flowColor(f.flowU[i], f.flowV[i]);
            r = lerp(r, c[0], k);
            g = lerp(g, c[1], k);
            b = lerp(b, c[2], k);
          }
        }
        if (maskK > 0) {
          let tr = slot ? 0.5 : 0.2 * far;
          let tg = slot ? 0.53 : 0.23 * far;
          let tb = slot ? 0.6 : 0.3 * far;
          if (slot && f.boneDist[i] <= grow) {
            const c = colors.get(slot) ?? [1, 1, 1];
            const k = 0.55 + 0.45 * f.ir[i];
            tr = c[0] * k;
            tg = c[1] * k;
            tb = c[2] * k;
          } else if (!slot) {
            const k = 1 - 0.45 * grey;
            tr *= k;
            tg *= k;
            tb *= k;
          }
          r = lerp(r, tr, maskK);
          g = lerp(g, tg, maskK);
          b = lerp(b, tb, maskK);
        }
        sp.point((sx + W / 2) * scale, (sy + H / 2) * scale, vz, size * scale, r, g, b, a);
      }
    }
    const img = sp.end();
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, -W / 2, -H / 2, W, H);
    // glow
    const g = this.glowCanvas;
    const gw = Math.round(img.width / 4);
    const gh = Math.round(img.height / 4);
    if (g.width !== gw || g.height !== gh) {
      g.width = gw;
      g.height = gh;
    }
    const gc = g.getContext('2d') as CanvasRenderingContext2D;
    gc.clearRect(0, 0, gw, gh);
    gc.filter = 'blur(3px)';
    gc.drawImage(img, 0, 0, gw, gh);
    gc.filter = 'none';
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha *= 0.35;
    ctx.drawImage(g, -W / 2, -H / 2, W, H);
    ctx.restore();
  }

  private drawStreaks(ctx: CanvasRenderingContext2D, cam: Camera, f: SensorFrame) {
    const alpha = this.streaks();
    const bins: Path2D[] = Array.from({ length: 12 }, () => new Path2D());
    const out = [0, 0, 0];
    const out2 = [0, 0, 0];
    const len = 5;
    for (let v = 0; v < INTR.h; v += 3) {
      for (let u = 0; u < INTR.w; u += 3) {
        const i = v * INTR.w + u;
        if (!f.label[i]) continue;
        const d = f.depth[i];
        if (d <= 0) continue;
        const fu = f.flowU[i];
        const fv = f.flowV[i];
        const m = Math.hypot(fu, fv);
        if (m < 0.35) continue;
        const x = KINECT[0] + rayX(u) * d;
        const y = KINECT[1] + rayY(v) * d;
        const z = KINECT[2] + d;
        const pu = u - fu * len;
        const pv = v - fv * len;
        const x0 = KINECT[0] + rayXAt(pu) * d;
        const y0 = KINECT[1] + rayYAt(pv) * d;
        if (!cam.projectInto(x, y, z, out) || !cam.projectInto(x0, y0, z, out2)) continue;
        const h = (Math.atan2(-fv, fu) / (2 * Math.PI) + 1) % 1;
        const bin = bins[Math.floor(h * 12) % 12];
        bin.moveTo(out2[0], out2[1]);
        bin.lineTo(out[0], out[1]);
      }
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    for (let b = 0; b < 12; b++) {
      const c = hsv((b + 0.5) / 12, 0.85, 1);
      ctx.strokeStyle = rgba(c, 0.85 * alpha);
      ctx.lineWidth = 2.2;
      ctx.stroke(bins[b]);
    }
    ctx.restore();
  }

  private drawSkeletons(ctx: CanvasRenderingContext2D, cam: Camera, f: SensorFrame) {
    const alpha = this.skel();
    const fly = this.skelFly();
    const fx = this.flyX();
    const fy = this.flyY();
    const fw = this.flyW();
    const fh = this.flyH();
    for (const p of f.persons) {
      const pts = p.pose.joints.map((j, k) => {
        const q = cam.project(j);
        if (!q) return null;
        if (fly >= 1) return q;
        const im = p.img[k];
        if (!im) return q;
        const e = smooth(0, 1, fly);
        return [lerp(fx + (im[0] / INTR.w - 0.5) * fw, q[0], e), lerp(fy + (im[1] / INTR.h - 0.5) * fh, q[1], e), q[2]] as V3;
      });
      for (const [width, a] of [[9, 0.22], [3.2, 1]]) {
        ctx.strokeStyle = rgba(p.color, a * alpha);
        ctx.lineWidth = width;
        ctx.beginPath();
        for (const [i, j] of BONES) {
          const a2 = pts[i];
          const b2 = pts[j];
          if (!a2 || !b2) continue;
          ctx.moveTo(a2[0], a2[1]);
          ctx.lineTo(b2[0], b2[1]);
        }
        ctx.stroke();
      }
      ctx.fillStyle = rgba([1, 1, 1], alpha);
      for (const q of pts.slice(0, 17)) {
        if (!q) continue;
        ctx.beginPath();
        ctx.arc(q[0], q[1], 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawRay(ctx: CanvasRenderingContext2D, cam: Camera, f: SensorFrame) {
    const t = rayTarget(f);
    if (!t) return;
    const lens = cam.project(LENS);
    const hit = cam.project(t.p);
    if (!lens || !hit) return;
    const link = this.rayLink();
    const sensor = hexRgb(C.sensor);
    if (link > 0 && this.flyW() > 0) {
      // from the pixel in the depth image to the lens
      const ix = this.flyX() + ((t.u + 0.5) / INTR.w - 0.5) * this.flyW();
      const iy = this.flyY() + ((t.v + 0.5) / INTR.h - 0.5) * this.flyH();
      ctx.save();
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = rgba([1, 1, 1], 0.75 * link);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ix, iy);
      ctx.lineTo(lerp(ix, lens[0], link), lerp(iy, lens[1], link));
      ctx.stroke();
      ctx.restore();
    }
    const r = this.ray();
    if (r <= 0) return;
    const e = smooth(0, 0.6, r);
    const end: V3 = [lerp(lens[0], hit[0], e), lerp(lens[1], hit[1], e), 0];
    for (const [width, a] of [[10, 0.2], [3, 1]]) {
      ctx.strokeStyle = rgba(sensor, a);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(lens[0], lens[1]);
      ctx.lineTo(end[0], end[1]);
      ctx.stroke();
    }
    const pop = smooth(0.55, 0.8, r);
    if (pop > 0) {
      ctx.fillStyle = rgba([1, 1, 1], pop);
      ctx.beginPath();
      ctx.arc(hit[0], hit[1], 7 * pop, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba([1, 1, 1], 0.5 * pop);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hit[0], hit[1], 7 + 18 * smooth(0.55, 1, r), 0, Math.PI * 2);
      ctx.stroke();
      const label = `${t.d.toFixed(2).replace('.', ',')} m`;
      const mx = (lens[0] + hit[0]) / 2;
      const my = (lens[1] + hit[1]) / 2;
      this.tag(ctx, label, mx, my - 26, smooth(0.6, 0.9, r), sensor);
    }
  }

  // ---------------------------------------------------------------- labels

  private tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, a: number, color: [number, number, number]) {
    if (a <= 0) return;
    ctx.save();
    ctx.font = `600 26px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 26;
    ctx.fillStyle = `rgba(5,7,12,${0.82 * a})`;
    ctx.strokeStyle = rgba(color, 0.9 * a);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 21, w, 42, 21);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rgba([0.95, 0.96, 0.98], a);
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  private callout(ctx: CanvasRenderingContext2D, cam: Camera, anchor: V3, dx: number, dy: number, text: string, a: number, color: [number, number, number]) {
    const p = cam.project(anchor);
    if (!p || a <= 0) return;
    const e = smooth(0, 1, a);
    ctx.strokeStyle = rgba(color, 0.8 * e);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[0] + dx * e, p[1] + dy * e);
    ctx.stroke();
    ctx.fillStyle = rgba(color, e);
    ctx.beginPath();
    ctx.arc(p[0], p[1], 4, 0, Math.PI * 2);
    ctx.fill();
    this.tag(ctx, text, p[0] + dx, p[1] + dy + (dy < 0 ? -18 : 18), smooth(0.4, 1, a), color);
  }

  private dimension(ctx: CanvasRenderingContext2D, cam: Camera, a: V3, b: V3, tick: V3, text: string, p: number) {
    if (p <= 0) return;
    const e = smooth(0, 1, p);
    const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const a2: V3 = [lerp(m[0], a[0], e), lerp(m[1], a[1], e), lerp(m[2], a[2], e)];
    const b2: V3 = [lerp(m[0], b[0], e), lerp(m[1], b[1], e), lerp(m[2], b[2], e)];
    ctx.strokeStyle = rgba([0.85, 0.88, 0.95], 0.8 * e);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this.line(ctx, cam, a2, b2);
    for (const q of [a2, b2]) this.line(ctx, cam, [q[0] - tick[0], q[1] - tick[1], q[2] - tick[2]], [q[0] + tick[0], q[1] + tick[1], q[2] + tick[2]]);
    ctx.stroke();
    const c = cam.project(m);
    if (c) this.tag(ctx, text, c[0], c[1], smooth(0.5, 1, p), [0.85, 0.88, 0.95]);
  }

  private drawLabels(ctx: CanvasRenderingContext2D, cam: Camera) {
    const dims = this.dims();
    const labels = this.labels();
    const top = WALL.bottom + WALL.h;
    this.dimension(ctx, cam, [-WALL.w / 2, top + 0.14, 0.12], [WALL.w / 2, top + 0.14, 0.12], [0, 0.06, 0], '6 m', dims);
    this.dimension(ctx, cam, [WALL.w / 2 - 0.15, WALL.bottom, 0.12], [WALL.w / 2 - 0.15, top, 0.12], [0.06, 0, 0], '2 m', clamp(dims * 1.3 - 0.3));
    const white: [number, number, number] = [0.92, 0.94, 0.98];
    this.callout(ctx, cam, [-1.6, WALL.bottom + 1.3, 0.02], -40, -250, 'LED-Wand', clamp(labels * 3), white);
    this.callout(ctx, cam, [-TRUSS.x, 2.2, TRUSS.z], -70, -120, 'Truss', clamp(labels * 3 - 0.6), white);
    this.callout(ctx, cam, [KINECT[0], KINECT[1] + 0.04, KINECT[2]], 90, 150, 'Kinect', clamp(labels * 3 - 1.2), hexRgb(C.sensor));
  }
}
