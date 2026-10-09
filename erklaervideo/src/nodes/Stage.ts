// The 3D stage: the room with truss, LED wall and Kinect, the Kinect's field of view, the people
// and everything the Kinect makes of them (point cloud, motion, skeletons). Drawn with Canvas 2D
// through our own camera (lib/camera.ts); every element has a signal (0..1) to animate it.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal } from '@motion-canvas/core';
import { clayLook, silhouetteLook } from '../lib/body/looks';
import { FigureRaster } from '../lib/body/raster';
import { BodyStyle, DEFAULT_STYLE, buildBody } from '../lib/body/styles';
import { Camera } from '../lib/camera';
import { ROLES } from '../lib/choreo';
import { FLUID } from '../lib/fluid';
import { depthColor, farDim } from '../lib/images';
import { V3, clamp, easeOutBack, hash, hexRgb, lerp, rgba, smooth } from '../lib/math';
import { BONES, Pose, people } from '../lib/people';
import { SensorFrame, bodyAt, rayX, rayY, sense } from '../lib/sensor';
import { Splatter } from '../lib/splat';
import { testPattern } from '../lib/testpattern';
import { C, FONT } from '../lib/theme';
import { BOX_FACES, FLYBAR, FURNITURE, INTR, KINECT, ROOM, SLINGS, TRUSS, WALL, aboveFloor, boxCorners, cabinets, floorZone, fovCorners, segAboveFloor, trussSegments } from '../lib/world';

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
  kinectAlpha?: SignalValue<number>;
  roomAlpha?: SignalValue<number>;
  frustum?: SignalValue<number>;
  frustumAlpha?: SignalValue<number>;
  zone?: SignalValue<number>;
  pulses?: SignalValue<number>;
  pulseStart?: SignalValue<number>;
  figures?: SignalValue<number>;
  figureColor?: SignalValue<number>;
  bodyStyle?: SignalValue<string>;
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
  textScale?: SignalValue<number>;
}

const TRUSS_SEGS = trussSegments();
const CABINETS = cabinets();
const LENS: V3 = [KINECT[0], KINECT[1], KINECT[2] + 0.035];
/** the pixel the ray demo picks: on the chest of the lead person */
export const RAY_PIXEL = { slot: ROLES.lead };

/** the flight of the depth picture into 3D: far points leave first, the nearest last (cloudFly 0..1) */
export const FLIGHT = { spread: 0.62, dur: 0.32, near: 0.5, range: 4.8 };
/** points farther than this (m) have left the picture at this progress of the flight */
export function flightCut(fly: number) {
  return FLIGHT.near + FLIGHT.range * (1 - fly / FLIGHT.spread);
}

/** the pixel that becomes a point in the ray demo: on the chest of the lead person */
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
  @initial('test') @signal() public declare readonly wallContent: SimpleSignal<string, this>;
  @initial(1) @signal() public declare readonly kinect: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly kinectAlpha: SimpleSignal<number, this>;
  @initial(0.7) @signal() public declare readonly roomAlpha: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly frustum: SimpleSignal<number, this>;
  @initial(1) @signal() public declare readonly frustumAlpha: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly zone: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly pulses: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly pulseStart: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly figures: SimpleSignal<number, this>;
  @initial(0) @signal() public declare readonly figureColor: SimpleSignal<number, this>;
  /** the look of the bodies (body/styles.ts) */
  @initial(DEFAULT_STYLE) @signal() public declare readonly bodyStyle: SimpleSignal<string, this>;
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
  /** size of the labels (1 = for 1080p landscape; larger for a phone screen) */
  @initial(1) @signal() public declare readonly textScale: SimpleSignal<number, this>;

  readonly cam = new Camera();
  private splat = new Splatter();
  private raster = new FigureRaster();
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
    const frame = needSensor ? sense(T, this.bodyStyle() as BodyStyle) : null;
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
    if (this.figures() > 0) this.drawFigures(ctx, cam, persons, T, W, H);
    if (frame && this.cloud() > 0) this.drawCloud(ctx, cam, frame, W, H);
    if (frame && this.streaks() > 0) this.drawTrails(ctx, cam, frame);
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

  /** a solid box: faces sorted back to front, filled, with edges */
  private drawBox(ctx: CanvasRenderingContext2D, cam: Camera, c: V3[], fill: [number, number, number], edge: [number, number, number], alpha: number) {
    const faces = BOX_FACES.map((f) => ({ f, d: f.reduce((sum, i) => sum + cam.view(c[i])[2], 0) / 4 })).sort((a, b) => b.d - a.d);
    for (const { f } of faces) {
      ctx.beginPath();
      if (!this.poly(ctx, cam, f.map((i) => c[i]))) continue;
      ctx.fillStyle = rgba(fill, alpha);
      ctx.fill();
      ctx.strokeStyle = rgba(edge, alpha);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  /** a tube: dark outline, metal body, a light stripe on top; width from its distance */
  private tube(ctx: CanvasRenderingContext2D, s: [number, number, number, number], w: number, alpha: number, body: [number, number, number]) {
    ctx.beginPath();
    ctx.moveTo(s[0], s[1]);
    ctx.lineTo(s[2], s[3]);
    ctx.strokeStyle = rgba([0.06, 0.07, 0.09], alpha);
    ctx.lineWidth = w + 2;
    ctx.stroke();
    ctx.strokeStyle = rgba(body, alpha);
    ctx.lineWidth = w;
    ctx.stroke();
    ctx.strokeStyle = rgba([0.96, 0.97, 0.99], 0.55 * alpha);
    ctx.lineWidth = Math.max(0.6, w * 0.28);
    ctx.stroke();
  }

  private drawTruss(ctx: CanvasRenderingContext2D, cam: Camera) {
    const p = this.truss();
    if (p <= 0) return;
    const alpha = this.wallAlpha();
    const h = TRUSS.size / 2;
    // base plates
    for (const [ti, x0] of [-TRUSS.x, TRUSS.x].entries()) {
      const a = clamp((p - ti * 0.08) * 12) * alpha;
      if (a <= 0) continue;
      this.drawBox(ctx, cam, boxCorners([x0 - 0.3, 0, TRUSS.z - 0.3], [x0 + 0.3, 0.012, TRUSS.z + 0.3]), [0.16, 0.18, 0.21], [0.5, 0.55, 0.62], a);
    }
    // tubes, far ones first
    const items: { s: [number, number, number, number]; z: number; w: number }[] = [];
    for (const seg of TRUSS_SEGS) {
      if (seg.at > p) continue;
      const sc = cam.segment(seg.a, seg.b);
      if (!sc) continue;
      const z = cam.view([(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, (seg.a[2] + seg.b[2]) / 2])[2];
      items.push({ s: sc, z, w: Math.max(1.2, (seg.d * cam.focal) / Math.max(0.2, z)) });
    }
    items.sort((a, b) => b.z - a.z);
    ctx.lineCap = 'round';
    const body: [number, number, number] = [0.68, 0.71, 0.76];
    for (const it of items) this.tube(ctx, it.s, it.w, 0.95 * alpha, body);
    // corner blocks where towers and beam meet
    const blocks = clamp((p - 0.6) * 10) * alpha;
    if (blocks > 0) {
      for (const x0 of [-TRUSS.x, TRUSS.x]) {
        const e = 0.02;
        this.drawBox(ctx, cam, boxCorners([x0 - h - e, TRUSS.height - 2 * h - e, TRUSS.z - h - e], [x0 + h + e, TRUSS.height + e, TRUSS.z + h + e]), [0.22, 0.24, 0.28], [0.72, 0.76, 0.82], blocks);
      }
    }
  }

  /** the flying bar on top of the wall and the round slings that hang it from the truss */
  private drawRigging(ctx: CanvasRenderingContext2D, cam: Camera, alpha: number) {
    const p = clamp(this.wall() / 0.08);
    if (p <= 0) return;
    const dy = (1 - easeOutBack(p)) * 0.4;
    const a = clamp(p * 3) * alpha;
    const h = TRUSS.size / 2;
    const chordY = TRUSS.height - 2 * h;
    const sling: [number, number, number] = [0.52, 0.32, 0.78];
    ctx.lineCap = 'round';
    for (const x of SLINGS) {
      const shackle: V3 = [x, FLYBAR.y1 + dy + 0.03, (FLYBAR.z0 + FLYBAR.z1) / 2];
      for (const z of [TRUSS.z - h, TRUSS.z + h]) {
        const sc = cam.segment(shackle, [x, chordY - 0.02, z]);
        if (!sc) continue;
        const zz = cam.view(shackle)[2];
        this.tube(ctx, sc, Math.max(1.5, (0.035 * cam.focal) / Math.max(0.2, zz)), a, sling);
      }
      // the sling around the bottom chords
      const wrap = cam.segment([x, chordY - 0.035, TRUSS.z - h - 0.03], [x, chordY - 0.035, TRUSS.z + h + 0.03]);
      if (wrap) this.tube(ctx, wrap, Math.max(1.5, (0.035 * cam.focal) / Math.max(0.2, cam.view(shackle)[2])), a, sling);
      // shackle
      const sp = cam.project(shackle);
      if (sp) {
        ctx.strokeStyle = rgba([0.85, 0.87, 0.9], a);
        ctx.lineWidth = Math.max(1.2, (0.012 * cam.focal) / sp[2]);
        ctx.beginPath();
        ctx.arc(sp[0], sp[1], Math.max(2, (0.025 * cam.focal) / sp[2]), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    this.drawBox(ctx, cam, boxCorners([FLYBAR.x0, FLYBAR.y0 + dy, FLYBAR.z0], [FLYBAR.x1, FLYBAR.y1 + dy, FLYBAR.z1]), [0.1, 0.11, 0.14], [0.45, 0.5, 0.58], a);
  }

  private cabinetProgress(order: number) {
    // the flying bar comes first (wall 0..0.08), then the panels column by column
    const start = 0.08 + (order / CABINETS.length) * 0.74;
    return clamp((this.wall() - start) / 0.18);
  }

  private drawWall(ctx: CanvasRenderingContext2D, cam: Camera, T: number) {
    const alpha = this.wallAlpha();
    const lit = this.wallLit();
    const content = this.wallContent();
    this.drawRigging(ctx, cam, alpha);
    const pattern = content === 'test' && lit > 0 ? testPattern() : null;
    for (const cab of CABINETS) {
      const p = this.cabinetProgress(cab.order);
      if (p <= 0) continue;
      const dy = (1 - easeOutBack(p)) * 0.6;
      const pts = cab.corners.map((c): V3 => [c[0], c[1] + dy, c[2]]);
      const a = clamp(p * 3) * alpha;
      ctx.beginPath();
      if (!this.poly(ctx, cam, pts)) continue;
      ctx.fillStyle = rgba(hexRgb(C.cabinet), a);
      ctx.fill();
      if (pattern) {
        // each panel brings its part of the test image and lights up once it hangs
        const on = clamp((p - 0.7) / 0.3) * lit * alpha;
        const sw = pattern.width / WALL.cols;
        const sh = pattern.height / WALL.rows;
        if (on > 0) this.drawQuadImage(ctx, cam, pattern, cab.col * sw, cab.row * sh, sw, sh, pts, 2, 4, on);
      } else if (lit > 0 && content === 'idle') {
        const u = (cab.col + 0.5) / WALL.cols;
        const v = (cab.row + 0.5) / WALL.rows;
        const w = 0.5 + 0.5 * Math.sin(T * 0.6 + u * 4 - v * 2);
        const c: [number, number, number] = [0.1 + 0.18 * w * u, 0.09 + 0.05 * w, 0.32 + 0.12 * w * (1 - u)];
        ctx.fillStyle = rgba(c, lit * a);
        ctx.fill();
      }
      ctx.beginPath();
      this.poly(ctx, cam, pts);
      ctx.strokeStyle = rgba(hexRgb(C.cabinetEdge), a * (content === 'fluid' ? 0.6 : 1));
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (lit > 0 && content === 'fluid') this.drawWallImage(ctx, cam, FLUID.at(T).image(), lit * alpha);
  }

  /** part of an image on a 3D quad (TL, TR, BR, BL), in nx × ny small affine cells (close to perspective) */
  private drawQuadImage(ctx: CanvasRenderingContext2D, cam: Camera, img: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, q: V3[], nx: number, ny: number, alpha: number) {
    const at = (u: number, v: number): V3 => {
      const t: V3 = [lerp(q[0][0], q[1][0], u), lerp(q[0][1], q[1][1], u), lerp(q[0][2], q[1][2], u)];
      const b: V3 = [lerp(q[3][0], q[2][0], u), lerp(q[3][1], q[2][1], u), lerp(q[3][2], q[2][2], u)];
      return [lerp(t[0], b[0], v), lerp(t[1], b[1], v), lerp(t[2], b[2], v)];
    };
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const e = 0.012;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = cam.project(at(i / nx, j / ny));
        const b = cam.project(at((i + 1) / nx, j / ny));
        const c = cam.project(at(i / nx, (j + 1) / ny));
        if (!a || !b || !c) continue;
        ctx.save();
        ctx.transform(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1], a[0], a[1]);
        ctx.drawImage(img, sx + (i * sw) / nx, sy + (j * sh) / ny, sw / nx, sh / ny, -e, -e, 1 + 2 * e, 1 + 2 * e);
        ctx.restore();
      }
    }
    ctx.restore();
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
    const standP = clamp(this.kinect() * 2);
    const bodyP = clamp(this.kinect() * 2 - 1);
    const fade = this.kinectAlpha();
    const [kx, ky, kz] = KINECT;
    // photo/video tripod: three legs from the floor meet under the head, a short center column,
    // a pan head with its handle pointing back towards the wall
    const top = ky - 0.075;
    const metal = hexRgb(C.truss);
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
      const foot: V3 = [kx + Math.cos(a) * 0.36, 0, kz + Math.sin(a) * 0.36];
      const hip: V3 = [kx + Math.cos(a) * 0.045, top, kz + Math.sin(a) * 0.045];
      const knee: V3 = [lerp(foot[0], hip[0], 0.45), lerp(foot[1], hip[1], 0.45), lerp(foot[2], hip[2], 0.45)];
      const reach: V3 = [lerp(foot[0], hip[0], standP), lerp(foot[1], hip[1], standP), lerp(foot[2], hip[2], standP)];
      ctx.strokeStyle = rgba(metal, 0.95 * standP * fade);
      ctx.lineWidth = 2;
      ctx.beginPath();
      this.line(ctx, cam, foot, standP < 0.45 ? reach : knee);
      ctx.stroke();
      if (standP > 0.45) {
        ctx.lineWidth = 3.4;
        ctx.beginPath();
        this.line(ctx, cam, knee, reach);
        ctx.stroke();
      }
    }
    if (standP >= 1) {
      ctx.strokeStyle = rgba(metal, 0.95 * fade);
      ctx.lineWidth = 4;
      ctx.beginPath();
      this.line(ctx, cam, [kx, top, kz], [kx, ky - 0.035, kz]);
      ctx.stroke();
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      this.line(ctx, cam, [kx, ky - 0.04, kz - 0.02], [kx + 0.03, top - 0.05, kz - 0.3]);
      ctx.stroke();
    }
    if (bodyP <= 0 || fade <= 0) return;
    // the body drops onto the tripod
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
      ctx.fillStyle = rgba([0.07, 0.08, 0.1], bodyP * fade);
      ctx.fill();
      ctx.strokeStyle = rgba(hexRgb(C.line), 0.85 * bodyP * fade);
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    // lens and infrared emitter on the front (towards the audience)
    const lens = cam.project([kx - 0.03, y, kz + hd + 0.002]);
    const emitter = cam.project([kx + 0.035, y, kz + hd + 0.002]);
    if (lens && emitter) {
      const r = Math.max(2, cam.ppm(lens[2]) * 0.012);
      ctx.fillStyle = rgba(hexRgb(C.sensor), bodyP * fade);
      ctx.beginPath();
      ctx.arc(lens[0], lens[1], r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(hexRgb(C.ir), bodyP * fade);
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

  private drawFigures(ctx: CanvasRenderingContext2D, cam: Camera, list: Pose[], T: number, W: number, H: number) {
    const alpha = this.figures();
    const colorK = this.figureColor();
    const sil = this.silhouette();
    const style = this.bodyStyle() as BodyStyle;
    const m = ctx.getTransform();
    const scale = Math.max(0.25, Math.hypot(m.a, m.b));
    const bodies = list.map((p) => ({ p, mesh: buildBody(p, style) }));
    // the part of the screen the bodies cover
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const out = [0, 0, 0];
    for (const { mesh } of bodies) {
      const P = mesh.pos;
      for (let i = 0; i < P.length; i += 3) {
        if (!cam.projectInto(P[i], P[i + 1], P[i + 2], out)) continue;
        if (out[0] < x0) x0 = out[0];
        if (out[0] > x1) x1 = out[0];
        if (out[1] < y0) y0 = out[1];
        if (out[1] > y1) y1 = out[1];
      }
    }
    x0 = Math.max(-W / 2, Math.floor(x0 - 4));
    y0 = Math.max(-H / 2, Math.floor(y0 - 4));
    x1 = Math.min(W / 2, Math.ceil(x1 + 4));
    y1 = Math.min(H / 2, Math.ceil(y1 + 4));
    if (!(x1 > x0 && y1 > y0)) return;
    if (sil <= 0) this.drawContactShadows(ctx, cam, list, alpha);
    // twice the resolution for smooth edges
    const k = scale * 2;
    const r = this.raster;
    r.begin(x0, y0, x1, y1, k);
    for (const { p, mesh } of bodies) {
      const tint = this.pulseHit(p.center[2] - KINECT[2], T);
      r.add(mesh, cam, sil > 0 ? silhouetteLook(p) : clayLook(p, { colorK, tint }));
    }
    const img = r.end(cam);
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x0, y0, r.w / k, r.h / k);
    ctx.restore();
  }

  /** a soft shadow on the floor under each person, so they stand on the ground */
  private drawContactShadows(ctx: CanvasRenderingContext2D, cam: Camera, list: Pose[], alpha: number) {
    for (const p of list) {
      const J = p.joints;
      const c: V3 = [(J[15][0] + J[16][0] + J[18][0]) / 3, 0.002, (J[15][2] + J[16][2] + J[18][2]) / 3];
      const q = cam.project(c);
      if (!q) continue;
      let rx = 1;
      let ry = 1;
      for (const d of [[0.34, 0, 0], [0, 0, 0.3], [-0.34, 0, 0], [0, 0, -0.3]] as V3[]) {
        const e = cam.project([c[0] + d[0], c[1], c[2] + d[2]]);
        if (!e) continue;
        rx = Math.max(rx, Math.abs(e[0] - q[0]));
        ry = Math.max(ry, Math.abs(e[1] - q[1]));
      }
      ctx.save();
      ctx.translate(q[0], q[1]);
      ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, `rgba(0,0,0,${0.55 * alpha})`);
      g.addColorStop(0.5, `rgba(0,0,0,${0.3 * alpha})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
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
          const farness = clamp((d - FLIGHT.near) / FLIGHT.range);
          const delay = (1 - farness) * FLIGHT.spread + hash(u, v, 3) * 0.04;
          const q = clamp((fly - delay) / FLIGHT.dur);
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
          const k = clamp((m2 - 0.12) / 0.8) * flowK;
          const dim = 1 - 0.8 * flowK;
          r = lerp(r * dim, 0.45 + 0.2 * r, k * 0.85);
          g = lerp(g * dim, 0.72 + 0.15 * g, k * 0.85);
          b = lerp(b * dim, 0.95, k * 0.85);
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

  /**
   * Motion trails: surface points of the people followed back through the last frames. A point keeps
   * its place on the body (the same spot on the same triangle of the mesh), so the trail is the real
   * path it took, as an optical flow over several frames shows it.
   */
  private drawTrails(ctx: CanvasRenderingContext2D, cam: Camera, f: SensorFrame) {
    const alpha = this.streaks();
    const K = 12;
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    const out = [0, 0, 0];
    const step = 7;
    const pts: V3[] = [];
    for (let v = 2; v < INTR.h; v += step) {
      for (let u = 2; u < INTR.w; u += step) {
        const i = v * INTR.w + u;
        const pi = f.who[i];
        const d = f.depth[i];
        if (pi < 0 || d <= 0) continue;
        const slot = f.now[pi].slot;
        const mesh = f.meshes[pi];
        const t = f.tri[i];
        const l0 = f.bary[i * 2];
        const l1 = f.bary[i * 2 + 1];
        const l2 = 1 - l0 - l1;
        const ia = mesh.tri[t * 3] * 3;
        const ib = mesh.tri[t * 3 + 1] * 3;
        const ic = mesh.tri[t * 3 + 2] * 3;
        pts.length = 0;
        pts.push([KINECT[0] + rayX(u) * d, KINECT[1] + rayY(v) * d, KINECT[2] + d]);
        let len = 0;
        for (let k = 1; k <= K; k++) {
          const q = bodyAt(slot, f.seq - k, f.style);
          if (!q) break;
          const Q = q.pos;
          const Pk: V3 = [
            Q[ia] * l0 + Q[ib] * l1 + Q[ic] * l2,
            Q[ia + 1] * l0 + Q[ib + 1] * l1 + Q[ic + 1] * l2,
            Q[ia + 2] * l0 + Q[ib + 2] * l1 + Q[ic + 2] * l2,
          ];
          const last = pts[pts.length - 1];
          len += Math.hypot(Pk[0] - last[0], Pk[1] - last[1], Pk[2] - last[2]);
          pts.push(Pk);
        }
        if (len < 0.06 || pts.length < 3) continue;
        // newest third bright, then fading towards the tail
        let prev: number[] | null = null;
        for (let k = 0; k < pts.length; k++) {
          if (!cam.projectInto(pts[k][0], pts[k][1], pts[k][2], out)) {
            prev = null;
            continue;
          }
          if (prev) {
            const path = paths[Math.min(2, Math.floor((k - 1) / (K / 3)))];
            path.moveTo(prev[0], prev[1]);
            path.lineTo(out[0], out[1]);
          }
          prev = [out[0], out[1]];
        }
      }
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    const tint = hexRgb(C.sensor);
    const alphas = [0.75, 0.34, 0.12];
    for (let n = 2; n >= 0; n--) {
      ctx.strokeStyle = rgba([lerp(tint[0], 1, 0.5), lerp(tint[1], 1, 0.5), 1], alphas[n] * alpha);
      ctx.lineWidth = n === 0 ? 2.4 : 1.8;
      ctx.stroke(paths[n]);
    }
    ctx.strokeStyle = rgba(tint, 0.14 * alpha);
    ctx.lineWidth = 7;
    ctx.stroke(paths[0]);
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
      this.tag(ctx, label, mx, my - 26 * this.textScale(), smooth(0.6, 0.9, r), sensor);
    }
  }

  // ---------------------------------------------------------------- labels

  private tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, a: number, color: [number, number, number]) {
    if (a <= 0) return;
    const k = this.textScale();
    ctx.save();
    ctx.font = `600 ${26 * k}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 26 * k;
    ctx.fillStyle = `rgba(5,7,12,${0.82 * a})`;
    ctx.strokeStyle = rgba(color, 0.9 * a);
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 21 * k, w, 42 * k, 21 * k);
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
    // portrait: the left tower is at the edge of the picture, so the label goes to the top of the right one
    if (this.size().y > this.size().x) this.callout(ctx, cam, [TRUSS.x, 3.0, TRUSS.z], -60, -170, 'Truss', clamp(labels * 3 - 0.6), white);
    else this.callout(ctx, cam, [-TRUSS.x, 2.2, TRUSS.z], -70, -120, 'Truss', clamp(labels * 3 - 0.6), white);
    this.callout(ctx, cam, [KINECT[0], KINECT[1] + 0.04, KINECT[2]], 90, 150, 'Kinect', clamp(labels * 3 - 1.2), hexRgb(C.sensor));
  }
}
