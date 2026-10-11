// Props of the shots, each a THREE.Group standing on the floor (y = 0) at its origin, facing +z,
// built from simple solids merged into one mesh per material (few draw calls):
//   flightCase  black laminate, aluminium edges, ball corners, latches and recessed handles
//   table       a tech table: light top, black steel legs
//   cableCrate  a wire-mesh crate (galvanised wire on a frame)
//   micStand    tripod, tube, clutch, boom with counterweight and a mic clip
//   wheelchair  an active wheelchair: rigid frame, cambered wheels with push rims, castors,
//               sling seat and a low back, no push handles (WHEELCHAIR gives the seat geometry)
//   hangingBar  a horizontal bar on two stands, for cables hanging in the physics stage
// Every function returns a new group with new geometry; World3D.dispose frees it.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const std = (color: string, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
/** matte surfaces (laminate, wood, rubber, fabric): Lambert is cheaper per pixel and looks the same */
const matte = (color: string) => new THREE.MeshLambertMaterial({ color });

/** collects transformed solids per material and merges them */
class Kit {
  private readonly map = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  /** adds geo at position p with rotation (Euler XYZ) r */
  public add(mat: THREE.Material, geo: THREE.BufferGeometry, p: [number, number, number] = [0, 0, 0], r: [number, number, number] = [0, 0, 0]) {
    this.q.setFromEuler(this.e.set(r[0], r[1], r[2]));
    this.m.compose(new THREE.Vector3(p[0], p[1], p[2]), this.q, new THREE.Vector3(1, 1, 1));
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(this.m);
    g.deleteAttribute('uv');
    const list = this.map.get(mat) ?? [];
    list.push(g);
    this.map.set(mat, list);
  }

  /** a cylinder (tube) from a to b */
  public tube(mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 10) {
    const d = new THREE.Vector3().subVectors(b, a);
    const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1, false);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this.add(mat, g);
  }

  public build(name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, list] of this.map) {
      const geo = mergeGeometries(list);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** a rounded box: an extruded rounded rectangle (w × h) of depth d, centred */
function roundedBox(w: number, h: number, d: number, r: number, bevel = 0.002) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.absarc(w / 2 - r, -h / 2 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, h / 2 - r);
  s.absarc(w / 2 - r, h / 2 - r, r, 0, Math.PI / 2, false);
  s.lineTo(-w / 2 + r, h / 2);
  s.absarc(-w / 2 + r, h / 2 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -h / 2 + r);
  s.absarc(-w / 2 + r, -h / 2 + r, r, Math.PI, (3 * Math.PI) / 2, false);
  const g = new THREE.ExtrudeGeometry(s, { depth: d - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 5 });
  return g.translate(0, 0, -(d - 2 * bevel) / 2);
}

export interface CaseOptions {
  width?: number;
  depth?: number;
  height?: number;
}

/** a flight case: black laminate, aluminium edge profiles and lid seam, ball corners, latches, handles */
export function flightCase(o: CaseOptions = {}): THREE.Group {
  const W = o.width ?? 0.8, D = o.depth ?? 0.6, H = o.height ?? 0.55;
  const kit = new Kit();
  const ply = matte('#333438');
  const alu = std('#b9bdc3', 0.32, 0.5);
  const steel = std('#d6d8dc', 0.22, 0.6);
  const dark = matte('#0c0c0d');
  const e = 0.012; // edge profile half width
  kit.add(ply, new THREE.BoxGeometry(W - 0.004, H - 0.004, D - 0.004), [0, H / 2, 0]);
  // edge profiles along the 12 edges, slightly proud of the faces
  for (const sy of [0, H]) for (const sz of [-1, 1]) kit.add(alu, new THREE.BoxGeometry(W - 0.05, e * 2, e * 2), [0, sy + (sy ? -e + 0.002 : e - 0.002), (sz * D) / 2 - sz * (e - 0.002)]);
  for (const sy of [0, H]) for (const sx of [-1, 1]) kit.add(alu, new THREE.BoxGeometry(e * 2, e * 2, D - 0.05), [(sx * W) / 2 - sx * (e - 0.002), sy + (sy ? -e + 0.002 : e - 0.002), 0]);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.add(alu, new THREE.BoxGeometry(e * 2, H - 0.05, e * 2), [(sx * W) / 2 - sx * (e - 0.002), H / 2, (sz * D) / 2 - sz * (e - 0.002)]);
  // lid seam (tongue and groove profile) all around at 3/4 height
  const ys = H * 0.74;
  for (const sz of [-1, 1]) kit.add(alu, new THREE.BoxGeometry(W - 0.03, 0.022, 0.006), [0, ys, (sz * D) / 2 + sz * 0.001]);
  for (const sx of [-1, 1]) kit.add(alu, new THREE.BoxGeometry(0.006, 0.022, D - 0.03), [(sx * W) / 2 + sx * 0.001, ys, 0]);
  // ball corners
  for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
    kit.add(steel, new THREE.SphereGeometry(0.03, 16, 10), [sx * (W / 2 - 0.012), sy ? H - 0.012 : 0.012, sz * (D / 2 - 0.012)]);
  }
  // butterfly latches over the seam (front and back), recessed handles on the sides
  for (const sz of [-1, 1]) for (const sx of [-0.3, 0.3]) {
    kit.add(steel, roundedBox(0.07, 0.085, 0.008, 0.01), [sx * W, ys, (sz * D) / 2 + sz * 0.005]);
    kit.add(dark, new THREE.CylinderGeometry(0.014, 0.014, 0.006, 16), [sx * W, ys, (sz * D) / 2 + sz * 0.01], [Math.PI / 2, 0, 0]);
  }
  for (const sx of [-1, 1]) {
    kit.add(steel, roundedBox(0.2, 0.11, 0.012, 0.02), [(sx * W) / 2 + sx * 0.003, H * 0.45, 0], [0, Math.PI / 2, 0]);
    kit.add(dark, roundedBox(0.16, 0.07, 0.01, 0.015), [(sx * W) / 2 + sx * 0.006, H * 0.45, 0], [0, Math.PI / 2, 0]);
    kit.tube(steel, v((sx * W) / 2 + sx * 0.012, H * 0.45 + 0.012, -0.06), v((sx * W) / 2 + sx * 0.012, H * 0.45 + 0.012, 0.06), 0.006, 10);
  }
  return kit.build('flightCase');
}

export interface TableOptions {
  width?: number;
  depth?: number;
  height?: number;
  top?: string;
}

/** a tech table: a light top on black steel legs with a frame */
export function table(o: TableOptions = {}): THREE.Group {
  const W = o.width ?? 1.6, D = o.depth ?? 0.75, H = o.height ?? 0.75;
  const kit = new Kit();
  const top = matte(o.top ?? '#dccbb0');
  const edge = matte('#2b2b2d');
  const steel = std('#26272a', 0.45, 0.3);
  kit.add(top, new THREE.BoxGeometry(W, 0.024, D), [0, H - 0.012, 0]);
  kit.add(edge, new THREE.BoxGeometry(W + 0.004, 0.02, D + 0.004), [0, H - 0.0125, 0]);
  const lx = W / 2 - 0.06, lz = D / 2 - 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    kit.add(steel, new THREE.BoxGeometry(0.035, H - 0.024, 0.035), [sx * lx, (H - 0.024) / 2, sz * lz]);
    kit.add(edge, new THREE.CylinderGeometry(0.02, 0.022, 0.012, 12), [sx * lx, 0.006, sz * lz]);
  }
  for (const sz of [-1, 1]) kit.add(steel, new THREE.BoxGeometry(W - 0.12, 0.06, 0.02), [0, H - 0.055, sz * lz]);
  for (const sx of [-1, 1]) kit.add(steel, new THREE.BoxGeometry(0.02, 0.06, D - 0.12), [sx * lx, H - 0.055, 0]);
  return kit.build('table');
}

export interface CrateOptions {
  width?: number;
  depth?: number;
  height?: number;
}

/** an open wire-mesh crate */
export function cableCrate(o: CrateOptions = {}): THREE.Group {
  const W = o.width ?? 0.6, D = o.depth ?? 0.4, H = o.height ?? 0.32;
  const kit = new Kit();
  const wire = std('#a9adb2', 0.38, 0.55);
  const step = 0.045;
  const fr = 0.0045, wr = 0.0018;
  const x0 = -W / 2, x1 = W / 2, z0 = -D / 2, z1 = D / 2;
  const yb = 0.012;
  // frame: rims top and bottom, corner posts
  for (const y of [yb, H]) {
    kit.tube(wire, v(x0, y, z0), v(x1, y, z0), fr, 8);
    kit.tube(wire, v(x0, y, z1), v(x1, y, z1), fr, 8);
    kit.tube(wire, v(x0, y, z0), v(x0, y, z1), fr, 8);
    kit.tube(wire, v(x1, y, z0), v(x1, y, z1), fr, 8);
  }
  for (const x of [x0, x1]) for (const z of [z0, z1]) kit.tube(wire, v(x, yb, z), v(x, H, z), fr, 8);
  // mesh: verticals and horizontals on the four sides, a grid on the bottom
  for (let x = x0 + step; x < x1 - step / 2; x += step) {
    kit.tube(wire, v(x, yb, z0), v(x, H, z0), wr, 6);
    kit.tube(wire, v(x, yb, z1), v(x, H, z1), wr, 6);
    kit.tube(wire, v(x, yb, z0), v(x, yb, z1), wr, 6);
  }
  for (let z = z0 + step; z < z1 - step / 2; z += step) {
    kit.tube(wire, v(x0, yb, z), v(x0, H, z), wr, 6);
    kit.tube(wire, v(x1, yb, z), v(x1, H, z), wr, 6);
    kit.tube(wire, v(x0, yb, z), v(x1, yb, z), wr, 6);
  }
  for (let y = yb + step; y < H - step / 2; y += step) {
    kit.tube(wire, v(x0, y, z0 - 0.002), v(x1, y, z0 - 0.002), wr, 6);
    kit.tube(wire, v(x0, y, z1 + 0.002), v(x1, y, z1 + 0.002), wr, 6);
    kit.tube(wire, v(x0 - 0.002, y, z0), v(x0 - 0.002, y, z1), wr, 6);
    kit.tube(wire, v(x1 + 0.002, y, z0), v(x1 + 0.002, y, z1), wr, 6);
  }
  // feet
  for (const x of [x0 + 0.03, x1 - 0.03]) for (const z of [z0 + 0.03, z1 - 0.03]) kit.add(wire, new THREE.CylinderGeometry(0.008, 0.008, yb, 8), [x, yb / 2, z]);
  return kit.build('cableCrate');
}

export interface MicStandOptions {
  height?: number;
  /** boom angle above horizontal (rad); null = no boom */
  boom?: number | null;
}

/** a tripod microphone stand with a boom */
export function micStand(o: MicStandOptions = {}): THREE.Group {
  const H = o.height ?? 1.35;
  const kit = new Kit();
  const black = std('#1b1c1e', 0.42, 0.35);
  const rubber = matte('#0f0f10');
  const chrome = std('#c9ccd0', 0.25, 0.6);
  const hub = 0.3;
  // tripod legs
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const foot = v(Math.sin(a) * 0.36, 0.012, Math.cos(a) * 0.36);
    kit.tube(black, v(Math.sin(a) * 0.02, hub, Math.cos(a) * 0.02), foot, 0.008, 10);
    kit.add(rubber, new THREE.SphereGeometry(0.014, 10, 8), [foot.x, 0.012, foot.z]);
    kit.tube(black, v(Math.sin(a) * 0.2, hub * 0.45, Math.cos(a) * 0.2), v(0, hub + 0.06, 0), 0.004, 8);
  }
  kit.add(black, new THREE.CylinderGeometry(0.022, 0.022, 0.08, 16), [0, hub, 0]);
  kit.tube(black, v(0, hub, 0), v(0, H * 0.72, 0), 0.0125, 14);
  kit.add(black, new THREE.CylinderGeometry(0.018, 0.016, 0.05, 16), [0, H * 0.72, 0]);
  kit.tube(chrome, v(0, H * 0.72, 0), v(0, H, 0), 0.0095, 14);
  if (o.boom !== null) {
    const a = o.boom ?? 0.35;
    kit.add(black, new THREE.SphereGeometry(0.024, 14, 10), [0, H, 0]);
    const dir = v(0, Math.sin(a), Math.cos(a));
    const tip = dir.clone().multiplyScalar(0.55).add(v(0, H, 0));
    const back = dir.clone().multiplyScalar(-0.28).add(v(0, H, 0));
    kit.tube(black, back, tip, 0.008, 10);
    kit.add(black, new THREE.CylinderGeometry(0.028, 0.028, 0.08, 16), [back.x, back.y, back.z], [Math.PI / 2 - a, 0, 0]);
    // mic clip: a short neck and an open ring
    const clip = tip.clone().add(v(0, -0.01, 0.02));
    kit.add(black, new THREE.CylinderGeometry(0.009, 0.009, 0.03, 10), [tip.x, tip.y, tip.z + 0.012], [Math.PI / 2, 0, 0]);
    kit.add(rubber, new THREE.TorusGeometry(0.02, 0.0055, 8, 20, Math.PI * 1.6), [clip.x, clip.y, clip.z + 0.03], [0, 0, Math.PI * 0.7]);
  }
  return kit.build('micStand');
}

/** seat geometry of wheelchair() for the sitting rig: heights and the seat's front edge (m) */
export const WHEELCHAIR = {
  seatHeight: 0.5,
  seatFront: 0.22,
  seatBack: -0.2,
  seatWidth: 0.4,
  backTop: 0.82,
  wheelRadius: 0.3,
  /** forward foot rest bar */
  footrest: { y: 0.1, z: 0.42 },
};

export interface WheelchairOptions {
  frame?: string;
  seat?: string;
  /** camber of the big wheels (rad) */
  camber?: number;
}

/** an active wheelchair (rigid frame, no push handles), origin on the floor under the seat, facing +z */
export function wheelchair(o: WheelchairOptions = {}): THREE.Group {
  const kit = new Kit();
  const frame = std(o.frame ?? '#2f3236', 0.35, 0.45);
  const tyre = matte('#1a1a1b');
  const rim = std('#b7bbc1', 0.3, 0.55);
  const fabric = matte(o.seat ?? '#222326');
  const camber = o.camber ?? 0.05;
  const S = WHEELCHAIR;
  const R = S.wheelRadius;
  const halfW = S.seatWidth / 2;
  const axleZ = -0.12;
  // big wheels: tyre, rim, push rim, spokes, hub; top tilted inwards (camber)
  for (const sx of [-1, 1]) {
    const cx = sx * (halfW + 0.07);
    // built in the xy plane around the axle (z), turned to roll along z, tilted by the camber
    const wheel = (g: THREE.BufferGeometry, mat: THREE.Material, off = 0) => {
      g.translate(0, 0, off).rotateY(Math.PI / 2).rotateZ(sx * camber);
      kit.add(mat, g, [cx, R, axleZ]);
    };
    wheel(new THREE.TorusGeometry(R - 0.014, 0.014, 10, 64), tyre);
    wheel(new THREE.TorusGeometry(R - 0.032, 0.007, 6, 64), rim);
    wheel(new THREE.TorusGeometry(R - 0.045, 0.0065, 8, 64), rim, sx * 0.035);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      wheel(new THREE.CylinderGeometry(0.0035, 0.0035, 0.03, 6).rotateX(Math.PI / 2).translate(Math.cos(a) * (R - 0.045), Math.sin(a) * (R - 0.045), sx * 0.018), rim);
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const len = R - 0.04;
      wheel(new THREE.CylinderGeometry(0.0013, 0.0013, len, 4).translate(0, len / 2, (i % 2 ? 1 : -1) * 0.012).rotateZ(a), rim);
    }
    wheel(new THREE.CylinderGeometry(0.022, 0.022, 0.06, 16).rotateX(Math.PI / 2), frame);
    // side frame: from the axle forward, the front tube down to the foot rest, the back post
    const fx = sx * (halfW - 0.01);
    const seatY = S.seatHeight - 0.03;
    const knee = v(fx, seatY, S.seatFront - 0.02);
    const foot = v(sx * (halfW - 0.06), S.footrest.y, S.footrest.z - 0.04);
    kit.tube(frame, v(fx, R, axleZ), knee, 0.012, 10);
    kit.tube(frame, v(fx, seatY, S.seatBack), knee, 0.012, 10);
    kit.tube(frame, knee, foot, 0.012, 10);
    kit.tube(frame, v(fx, R, axleZ), v(fx, seatY, S.seatBack), 0.011, 10);
    kit.tube(frame, v(fx, seatY, S.seatBack), v(fx, S.backTop, S.seatBack - 0.05), 0.011, 10);
    // castor: a housing on the front tube, a trailing fork and a small wheel
    const hub = knee.clone().lerp(foot, 0.45);
    kit.add(frame, new THREE.CylinderGeometry(0.016, 0.016, 0.045, 12), [hub.x, hub.y, hub.z]);
    const axle = v(hub.x, 0.05, hub.z - 0.035);
    kit.tube(frame, v(hub.x, hub.y - 0.02, hub.z), v(hub.x, 0.09, hub.z), 0.007, 8);
    kit.tube(frame, v(hub.x, 0.09, hub.z), axle, 0.006, 8);
    kit.add(tyre, new THREE.CylinderGeometry(0.05, 0.05, 0.025, 20), [axle.x, axle.y, axle.z], [0, 0, Math.PI / 2]);
    kit.add(rim, new THREE.CylinderGeometry(0.02, 0.02, 0.027, 12), [axle.x, axle.y, axle.z], [0, 0, Math.PI / 2]);
  }
  // cross bars, foot rest, axle tube
  kit.tube(frame, v(-(halfW - 0.06), S.footrest.y, S.footrest.z - 0.04), v(halfW - 0.06, S.footrest.y, S.footrest.z - 0.04), 0.013, 10);
  kit.tube(frame, v(-(halfW + 0.03), R, axleZ), v(halfW + 0.03, R, axleZ), 0.012, 10);
  kit.tube(frame, v(-(halfW - 0.01), S.backTop - 0.02, S.seatBack - 0.045), v(halfW - 0.01, S.backTop - 0.02, S.seatBack - 0.045), 0.009, 10);
  // sling seat and low back
  kit.add(fabric, new THREE.BoxGeometry(S.seatWidth - 0.01, 0.025, S.seatFront - S.seatBack), [0, S.seatHeight - 0.015, (S.seatFront + S.seatBack) / 2]);
  kit.add(fabric, new THREE.BoxGeometry(S.seatWidth - 0.01, S.backTop - S.seatHeight - 0.06, 0.02), [0, (S.backTop + S.seatHeight) / 2 - 0.01, S.seatBack - 0.035], [-0.12, 0, 0]);
  return kit.build('wheelchair');
}

export interface BarOptions {
  /** bar length between the stands (m) */
  length?: number;
  /** height of the bar's axis (m) */
  height?: number;
  /** bar radius (m) */
  radius?: number;
}

/** a horizontal round bar on two stands with round base plates (bar along x) */
export function hangingBar(o: BarOptions = {}): THREE.Group {
  const L = o.length ?? 1.6, H = o.height ?? 1.4, r = o.radius ?? 0.015;
  const kit = new Kit();
  const alu = std('#c4c8ce', 0.3, 0.5);
  const black = std('#1d1e21', 0.5, 0.3);
  for (const sx of [-1, 1]) {
    const x = (sx * L) / 2;
    kit.add(black, new THREE.CylinderGeometry(0.17, 0.18, 0.018, 32), [x, 0.009, 0]);
    kit.tube(black, v(x, 0.018, 0), v(x, H + 0.03, 0), 0.02, 16);
    kit.add(black, new THREE.BoxGeometry(0.06, 0.07, 0.06), [x, H, 0]);
    kit.add(alu, new THREE.CylinderGeometry(0.008, 0.008, 0.05, 10), [x, H, 0.045], [Math.PI / 2, 0, 0]);
  }
  kit.tube(alu, v(-L / 2 - 0.05, H, 0), v(L / 2 + 0.05, H, 0), r, 20);
  return kit.build('hangingBar');
}
