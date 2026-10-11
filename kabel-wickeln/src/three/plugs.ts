// Plugs and connectors at the cable ends: XLR male and female (metal shell, black ribbed boot,
// latch on the female), USB-C (white overmould, metal plug) and CEE (IEC 60309) plugs and couplers
// (blue 230 V with 3 pins, red 400 V with 5 pins; scale 1.3 for 63 A). Bodies of revolution are
// lathed from profiles, details are boxes and cylinders; each material is merged into one mesh.
//
// Local frame of every plug: the cable enters at the origin along +z (the plug points away from
// the cable towards +z); +y is "up" (the latch of the female XLR, the lid hinge of a coupler).
// CableMesh places them with +y along the cable's d2 and +x along d1 (the stripe side).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type PlugKind = 'xlr-male' | 'xlr-female' | 'usb-c' | 'cee-blue' | 'cee-blue-coupler' | 'cee-red' | 'cee-red-coupler';

export interface PlugOptions {
  /** radius of the cable entering the boot (m) */
  cableRadius: number;
  /** size factor of the plug body (1 = real size; the boot always fits the cable) */
  scale?: number;
}

/** [radius, z, sharp]: sharp = 1 makes a crease (the point is doubled so normals do not blend) */
type P = [number, number, (0 | 1)?];

/** a body of revolution around +z from a profile in mm */
function lathe(profile: P[], segments = 40): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (const [r, z, sharp] of profile) {
    pts.push(new THREE.Vector2(r / 1000, z / 1000));
    if (sharp) pts.push(new THREE.Vector2(r / 1000, z / 1000));
  }
  const g = new THREE.LatheGeometry(pts, segments);
  g.rotateX(Math.PI / 2); // lathe axis y → z
  return g;
}

/** a box in mm, centred at (x, y, z) */
function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  return new THREE.BoxGeometry(w / 1000, h / 1000, d / 1000).translate(x / 1000, y / 1000, z / 1000);
}

/** a cylinder along z in mm from z0 to z1 at (x, y) */
function rod(r: number, z0: number, z1: number, x: number, y: number, seg = 12) {
  return new THREE.CylinderGeometry(r / 1000, r / 1000, (z1 - z0) / 1000, seg)
    .rotateX(Math.PI / 2)
    .translate(x / 1000, y / 1000, (z0 + z1) / 2000);
}

/** collects geometry per material and merges it: one draw call per material */
class Parts {
  private readonly map = new Map<THREE.Material, THREE.BufferGeometry[]>();
  public add(mat: THREE.Material, ...geos: THREE.BufferGeometry[]) {
    const list = this.map.get(mat) ?? [];
    for (const g of geos) {
      const flat = g.index ? g.toNonIndexed() : g;
      flat.deleteAttribute('uv');
      list.push(flat);
    }
    this.map.set(mat, list);
  }
  public build(scale: number): THREE.Group {
    const group = new THREE.Group();
    for (const [mat, list] of this.map) {
      const geo = mergeGeometries(list);
      if (!geo) continue;
      geo.scale(scale, scale, scale);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

const std = (color: string, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

/** a ribbed rubber boot from the cable (radius cr, mm) to radius r1 at z = len */
function boot(cr: number, r1: number, len: number, ribs: number): P[] {
  const out: P[] = [[cr * 0.9, 0, 1], [cr + 0.9, 0, 1]];
  const steps = ribs * 4;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const r = cr + 0.9 + (r1 - cr - 0.9) * Math.pow(u, 0.8);
    // shallow grooves in the back two thirds
    const groove = u < 0.7 && i % 4 === 2 ? -0.45 : 0;
    out.push([r + groove, u * len]);
  }
  return out;
}

function xlr(male: boolean, cr: number): Parts {
  const parts = new Parts();
  const rubber = std('#18191b', 0.62);
  const metal = std('#c3c6cb', 0.3, 0.55);
  const insert = std('#232427', 0.55);
  // boot to the chuck ring
  parts.add(rubber, lathe([...boot(cr, 8.1, 30, 5), [8.6, 30.5, 1], [8.6, 34, 1], [7, 34, 1]]));
  // metal shell
  const front = male ? 77 : 72;
  parts.add(
    metal,
    lathe([
      [8.4, 33.5, 1],
      [9.1, 34.2],
      [9.5, 35.6, 1],
      [9.5, front - 0.8],
      [9.2, front, 1],
      [male ? 8.7 : 8.8, front, 1],
      [male ? 8.7 : 8.8, male ? 64 : front - 0.6, 1],
      [0.5, male ? 64 : front - 0.6],
    ]),
  );
  const pins: [number, number][] = [[-4.3, 1.6], [4.3, 1.6], [0, -4.1]];
  if (male) {
    // the insert deep in the sleeve, three pins standing out of it
    const pin = std('#d8c27a', 0.28, 0.7);
    parts.add(insert, lathe([[8.7, 64.4, 1], [0, 64.4]]));
    for (const [x, y] of pins) {
      parts.add(pin, rod(0.8, 64, 75, x, y, 10), new THREE.SphereGeometry(0.0008, 10, 6).translate(x / 1000, y / 1000, 0.075));
    }
  } else {
    // a lighter insert flush with the front, three holes, the latch on top
    const face = std('#55585f', 0.6);
    const hole = std('#050505', 0.9);
    parts.add(face, lathe([[8.8, front - 0.5, 1], [0, front - 0.5]]));
    for (const [x, y] of pins) parts.add(hole, rod(1.3, front - 0.6, front - 0.3, x, y, 14));
    parts.add(metal, box(6.2, 2.2, 13, 0, 9.6, front - 9));
    parts.add(insert, box(4.6, 1.2, 6.5, 0, 10.9, front - 7.5));
  }
  return parts;
}

function usbC(cr: number): Parts {
  const parts = new Parts();
  const white = std('#f1f0ec', 0.45);
  const metal = std('#c9ccd1', 0.28, 0.6);
  const dark = std('#121315', 0.7);
  parts.add(white, lathe([[cr * 0.9, 0, 1], [cr + 0.6, 0, 1], [cr + 0.9, 4], [3.6, 9], [4.2, 11]]));
  // overmould: a rounded block 12 × 6.4 mm, 18 mm long
  const shape = new THREE.Shape();
  const rr = (s: THREE.Shape | THREE.Path, w: number, h: number, r: number) => {
    s.moveTo(-w / 2 + r, -h / 2);
    s.lineTo(w / 2 - r, -h / 2);
    s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    s.lineTo(w / 2, h / 2 - r);
    s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    s.lineTo(-w / 2 + r, h / 2);
    s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    s.lineTo(-w / 2, -h / 2 + r);
    s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  };
  rr(shape, 10.4, 4.8, 2.2);
  const body = new THREE.ExtrudeGeometry(shape, { depth: 16.4, bevelEnabled: true, bevelThickness: 0.8, bevelSize: 0.8, bevelSegments: 3, curveSegments: 6 });
  body.translate(0, 0, 9.8);
  parts.add(white, body.scale(0.001, 0.001, 0.001));
  // the plug: a stadium 8.3 × 2.5 mm, 6.6 mm long, dark opening in front
  const stadium = (w: number, h: number) => {
    const s = new THREE.Shape();
    const r = h / 2;
    s.moveTo(-w / 2 + r, -r);
    s.lineTo(w / 2 - r, -r);
    s.absarc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
    s.lineTo(-w / 2 + r, r);
    s.absarc(-w / 2 + r, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
    return s;
  };
  const plug = new THREE.ExtrudeGeometry(stadium(8.3, 2.5), { depth: 6.8, bevelEnabled: false, curveSegments: 8 });
  parts.add(metal, plug.translate(0, 0, 27).scale(0.001, 0.001, 0.001));
  const mouth = new THREE.ExtrudeGeometry(stadium(7.3, 1.6), { depth: 0.2, bevelEnabled: false, curveSegments: 8 });
  parts.add(dark, mouth.translate(0, 0, 33.75).scale(0.001, 0.001, 0.001));
  return parts;
}

function cee(color: string, pins: number, coupler: boolean, cr: number): Parts {
  const parts = new Parts();
  const body = std(color, 0.5);
  const dark = std(new THREE.Color(color).multiplyScalar(0.55).getStyle(), 0.6);
  const brass = std('#cfae5a', 0.3, 0.65);
  const insert = std('#e9e6df', 0.6);
  // cable gland (ribbed nut) and grip
  const gland: P[] = [[cr * 0.9, 0, 1], [cr + 1.2, 0, 1]];
  for (let i = 1; i <= 10; i++) gland.push([cr + 1.2 + (13 - cr - 1.2) * (i / 10) + (i % 2 ? 0.6 : 0), i * 2.2]);
  parts.add(dark, lathe(gland, 36));
  if (!coupler) {
    parts.add(
      body,
      lathe([
        [12, 21, 1],
        [19, 24],
        [26, 30],
        [27.5, 40],
        [27, 56],
        [28.5, 64, 1],
        [31.5, 66, 1],
        [31.5, 71, 1],
        [24, 72, 1],
        [23.5, 73],
        [23.5, 105, 1],
        [21.5, 105, 1],
        [21.5, 82, 1],
        [0, 82],
      ]),
    );
    // axial grip ribs and the key nose on the sleeve (at 6 o'clock, beside the earth pin)
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.31;
      parts.add(body, box(3, 3, 26, 0, 0, 0).rotateZ(-a).translate(Math.sin(a) * 0.0272, Math.cos(a) * 0.0272, 0.047));
    }
    parts.add(body, box(4.4, 2.6, 30, 0, -24.5, 89));
    parts.add(insert, lathe([[21.5, 82.3, 1], [0, 82.3]]));
    // pins on a circle; earth (thicker) at 6 o'clock
    for (let i = 0; i < pins; i++) {
      const a = Math.PI + (i * Math.PI * 2) / pins;
      const earth = i === 0;
      parts.add(brass, rod(earth ? 2.9 : 2.4, 82, 101, Math.sin(a) * 13.5, Math.cos(a) * 13.5, 12));
    }
  } else {
    parts.add(
      body,
      lathe([
        [12, 21, 1],
        [19, 24],
        [26, 30],
        [27.5, 42],
        [27, 54],
        [30, 60, 1],
        [34, 63, 1],
        [34, 108],
        [33, 109, 1],
        [0, 109],
      ]),
    );
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.31;
      parts.add(body, box(3, 3, 22, 0, 0, 0).rotateZ(-a).translate(Math.sin(a) * 0.0272, Math.cos(a) * 0.0272, 0.044));
    }
    // the spring lid: a cap over the face, hinged on top, a latch tongue at the bottom
    parts.add(dark, lathe([[34.6, 106, 1], [35, 107], [35, 112.5], [33.6, 115.5], [30, 118], [22, 119.6], [10, 120.4], [0, 120.6]], 40));
    parts.add(dark, box(20, 7, 12, 0, 36, 108), new THREE.CylinderGeometry(0.0034, 0.0034, 0.024, 12).rotateZ(Math.PI / 2).translate(0, 0.0375, 0.112));
    parts.add(dark, box(12, 5, 9, 0, -35.5, 110));
    // a white ring between body and lid reads as the seal
    parts.add(insert, lathe([[34.2, 104.8, 1], [34.5, 105.2], [34.5, 106.3], [34.2, 106.6, 1]], 40));
  }
  return parts;
}

/** a plug as a group in its local frame (see the file header) */
export function makePlug(kind: PlugKind, o: PlugOptions): THREE.Group {
  const cr = o.cableRadius * 1000;
  const scale = o.scale ?? 1;
  // the boot follows the cable, the body keeps its size: build the boot at cr / scale
  const c = cr / scale;
  let parts: Parts;
  switch (kind) {
    case 'xlr-male':
      parts = xlr(true, c);
      break;
    case 'xlr-female':
      parts = xlr(false, c);
      break;
    case 'usb-c':
      parts = usbC(c);
      break;
    case 'cee-blue':
      parts = cee('#2a6db5', 3, false, c);
      break;
    case 'cee-blue-coupler':
      parts = cee('#2a6db5', 3, true, c);
      break;
    case 'cee-red':
      parts = cee('#c4282c', 5, false, c);
      break;
    case 'cee-red-coupler':
      parts = cee('#c4282c', 5, true, c);
      break;
  }
  const g = parts.build(scale);
  g.name = kind;
  return g;
}

/** length of a plug along +z (m), for placing it so its tip lands somewhere */
export function plugLength(kind: PlugKind, scale = 1): number {
  const mm: Record<PlugKind, number> = {
    'xlr-male': 77,
    'xlr-female': 72,
    'usb-c': 34,
    'cee-blue': 105,
    'cee-blue-coupler': 121,
    'cee-red': 105,
    'cee-red-coupler': 121,
  };
  return (mm[kind] / 1000) * scale;
}
