// The city in the middle of the map, seen from above: a futuristic city at night with a few landmarks
// one recognizes at once. Drawn once per layout into a picture at LED resolution, in half blocks
// (S/2 x S/2 LEDs: blocky, but fine enough for shapes); what moves is drawn live in draw.js:
//   - the energy core at the top (where the Kinect stands): neon rings around a glowing core (live:
//     turning ring segments, a pulse), conduits that run down the middle of the avenue (live: light
//     pulses travelling down) and power the energy wall;
//   - maglev streets: dark and glossy, neon lane edges, light nodes; hover gliders with light trails;
//   - landmarks between them: hex towers with a neon edge and a lit spire, a landing pad (a light ring,
//     chevrons pointing in, beacons), an arena (a neon rim, a glowing field), a biodome (a garden under
//     a glass dome with a reflection), office towers with light strips;
//   - every building casts its shadow to the bottom right (the light of the whole map comes from the
//     top left).
// For the game the city is a grid of art pixels (alive or destroyed); the picture shows each living
// one, a destroyed one shows rubble.

export const CITY = { EMPTY: 0, WALL: 1, TOWER: 2, GROUND: 3 };

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const NEON = [
  [0.2, 0.9, 1],
  [1, 0.28, 0.8],
  [0.62, 0.42, 1],
];
const C = {
  ground: [0.018, 0.02, 0.042],
  plating: [0.03, 0.033, 0.065],
  road: [0.03, 0.034, 0.06],
  lane: [0.18, 0.75, 0.9],
  node: [0.75, 0.95, 1],
  shadow: [0.004, 0.004, 0.012],
  metal: [
    [0.11, 0.13, 0.22],
    [0.14, 0.11, 0.22],
    [0.1, 0.15, 0.2],
  ],
  panel: [0.35, 0.65, 0.85],
  garden: [0.02, 0.2, 0.13],
  plant: [0.05, 0.42, 0.3],
  plantLit: [0.2, 0.7, 0.5],
  glass: [0.55, 0.85, 1],
  field: [0.03, 0.2, 0.28],
  fieldLine: [0.4, 0.95, 1],
  core: [0.75, 0.95, 1],
};

/**
 * w x h art px, S LEDs per art px. Returns { base (type per art px), img (rgb per LED, w*S x h*S),
 * lanes (glider lanes in LED px), lights (for the floor: art px, color, radius m, intensity, blink),
 * core ({ x, y, r } in art px), conduit ({ x, y0, y1 } in art px) }.
 */
export function buildCity(w, h, S) {
  const q = Math.max(1, Math.floor(S / 2)); // LEDs per half block
  const W = w * S;
  const H = h * S;
  const gw = Math.floor(W / q); // the picture in half blocks
  const gh = Math.floor(H / q);
  const img = new Float32Array(W * H * 3);
  const base = new Uint8Array(w * h).fill(CITY.GROUND);
  const lights = [];
  const lanes = [];

  // ---- drawing in half blocks
  const cell = (x, y, c) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= gw || y >= gh) return;
    for (let j = 0; j < q; j++) {
      for (let i = 0; i < q; i++) {
        const k = ((y * q + j) * W + x * q + i) * 3;
        img[k] = c[0];
        img[k + 1] = c[1];
        img[k + 2] = c[2];
      }
    }
  };
  const rect = (x, y, rw, rh, c) => {
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) cell(x + i, y + j, c);
  };
  const ellipse = (cx, cy, rx, ry, c, ring = 0) => {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
        if (d > 1) continue;
        if (ring && d < (1 - ring / Math.min(rx, ry)) ** 2) continue;
        cell(x, y, c);
      }
    }
  };
  /** a pointy-top hexagon, filled (or only its outline, `ring` half blocks wide) */
  const hexagon = (cx, cy, r, c, ring = 0) => {
    const inside = (x, y, rr) => {
      const u = Math.abs(x) / (rr * 0.866);
      const v = Math.abs(y) / rr;
      return u <= 1 && v <= 1 - u * 0.5;
    };
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (!inside(dx, dy, r)) continue;
        if (ring && inside(dx, dy, r - ring)) continue;
        cell(x, y, c);
      }
    }
  };
  const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const toArt = (x, y) => [(x * q) / S, (y * q) / S];
  const light = (x, y, col, r, i, blink = 0) => {
    const [ax, ay] = toArt(x, y);
    lights.push({ x: ax, y: ay, col, r, i, blink });
  };

  // ---- the ground: dark plating in big tiles (no fine pattern)
  rect(0, 0, gw, gh, C.ground);
  for (let y = 0; y < gh; y += 12) for (let x = (y / 12) % 2 ? 0 : 6; x < gw; x += 12) rect(x, y, 6, 6, C.plating);
  const inner0 = Math.ceil(S / q);
  const inner1 = gw - Math.ceil(S / q);
  const cx = Math.floor(gw / 2);
  const roadW = Math.max(6, Math.round(gw * 0.16));
  const r0 = cx - Math.floor(roadW / 2);
  const r1 = r0 + roadW;
  const top = Math.round(Math.min(gh * 0.17, gw * 0.62));

  // ---- the energy core: rings around a glowing center, on a dark platform
  const dr = Math.min((inner1 - inner0) / 2 - 2, top / 2 - 1);
  const dcy = top / 2;
  ellipse(cx + 1.5, dcy + 1.5, dr, dr, C.shadow);
  ellipse(cx, dcy, dr, dr, scale(C.metal[0], 0.9));
  ellipse(cx, dcy, dr, dr, NEON[0], 1);
  ellipse(cx, dcy, dr * 0.7, dr * 0.7, scale(NEON[2], 0.7), 1);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    for (let r = dr * 0.35; r < dr * 0.7; r += 0.7) cell(cx + Math.cos(a) * r, dcy + Math.sin(a) * r, scale(NEON[0], 0.45));
  }
  ellipse(cx, dcy, dr * 0.3, dr * 0.3, C.core);
  light(cx, dcy, NEON[0], 0.8, 0.7);

  // ---- maglev streets: the avenue, cross streets, neon lane edges, light nodes
  rect(r0, top, roadW, gh - top, C.road);
  rect(r0, top, 1, gh - top, C.lane);
  rect(r1 - 1, top, 1, gh - top, C.lane);
  rect(cx - 0.5, top, 1, gh - top, scale(NEON[0], 0.35)); // the conduit (pulses live)
  const crossH = Math.max(4, Math.round(roadW * 0.6));
  const streets = [];
  const nBlocks = Math.max(2, Math.round((gh - top) / Math.max(30, gw * 0.9)));
  const blockH = (gh - top - crossH * (nBlocks - 1)) / nBlocks;
  for (let k = 1; k < nBlocks; k++) {
    const y = Math.round(top + k * blockH + (k - 1) * crossH);
    streets.push(y);
    rect(inner0, y, inner1 - inner0, crossH, C.road);
    rect(inner0, y, inner1 - inner0, 1, scale(C.lane, 0.8));
    rect(inner0, y + crossH - 1, inner1 - inner0, 1, scale(C.lane, 0.8));
  }
  for (let y = top + 6; y < gh; y += 14) {
    cell(r0 - 1, y, C.node);
    cell(r1, y + 7, C.node);
  }
  for (let y = top + 6; y < gh; y += 42) light(r0 - 1, y, NEON[0], 0.3, 0.45);
  lanes.push({ vertical: true, at: (cx - roadW / 4) * q, dir: -1, from: top * q, to: H });
  lanes.push({ vertical: true, at: (cx + roadW / 4) * q, dir: 1, from: top * q, to: H });
  streets.forEach((y, i) => lanes.push({ vertical: false, at: (y + crossH / 2) * q, dir: i % 2 ? 1 : -1, from: inner0 * q, to: inner1 * q }));

  // ---- the landmarks
  /** a tower with a hexagonal roof, a neon edge, a lit spire */
  const hexTower = (x, y, bw, bh) => {
    const r = Math.min(bw, bh) / 2 - 1;
    const tcx = x + bw / 2;
    const tcy = y + bh / 2;
    const neon = pick(NEON);
    hexagon(tcx + 2, tcy + 2, r, C.shadow);
    hexagon(tcx, tcy, r, pick(C.metal));
    hexagon(tcx, tcy, r, neon, 1);
    hexagon(tcx, tcy, r * 0.55, scale(pick(C.metal), 1.4));
    hexagon(tcx, tcy, r * 0.55, scale(neon, 0.6), 1);
    ellipse(tcx, tcy, 1.2, 1.2, C.core);
    light(tcx, tcy, neon, 0.35, 0.6, 1);
  };
  /** a landing pad: a light ring, chevrons pointing in, beacons at the corners */
  const pad = (x, y, bw, bh) => {
    rect(x + 3, y + 3, bw, bh, C.shadow);
    rect(x, y, bw, bh, scale(C.metal[0], 1.2));
    rect(x, y, bw, 1, scale(C.metal[0], 2));
    rect(x, y, 1, bh, scale(C.metal[0], 1.7));
    const r = Math.min(bw, bh) / 2 - 1.5;
    const pcx = x + bw / 2;
    const pcy = y + bh / 2;
    ellipse(pcx, pcy, r, r, NEON[0], 1);
    ellipse(pcx, pcy, r * 0.35, r * 0.35, scale(NEON[0], 0.6), 1);
    // chevrons from four sides
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      for (let k = -1; k <= 1; k++) {
        const along = r * 0.62 - Math.abs(k);
        cell(pcx + dx * along + dy * k, pcy + dy * along + dx * k, NEON[1]);
      }
    }
    for (const [lx, ly] of [
      [x, y],
      [x + bw - 1, y],
      [x, y + bh - 1],
      [x + bw - 1, y + bh - 1],
    ]) {
      cell(lx, ly, NEON[1]);
      light(lx, ly, NEON[1], 0.25, 0.8, 1);
    }
  };
  /** an arena: a neon rim, a glowing field with its middle line and circle, pylons */
  const arena = (x, y, bw, bh) => {
    const scx = x + bw / 2;
    const scy = y + bh / 2;
    ellipse(scx + 2, scy + 2, bw / 2, bh / 2, C.shadow);
    ellipse(scx, scy, bw / 2, bh / 2, pick(C.metal));
    ellipse(scx, scy, bw / 2, bh / 2, NEON[1], 1);
    const fw = bw / 2 - 3;
    const fh = bh / 2 - 3;
    ellipse(scx, scy, fw, fh, C.field);
    ellipse(scx, scy, fw, fh, scale(C.fieldLine, 0.6), 1);
    rect(scx - fw * 0.8, scy - 0.5, fw * 1.6, 1, C.fieldLine);
    ellipse(scx, scy, Math.max(1.5, fh * 0.35), Math.max(1.5, fh * 0.35), C.fieldLine, 1);
    for (const [lx, ly] of [
      [x + 1, y + 1],
      [x + bw - 2, y + 1],
      [x + 1, y + bh - 2],
      [x + bw - 2, y + bh - 2],
    ]) {
      cell(lx, ly, C.node);
      light(lx, ly, [0.7, 0.9, 1], 0.4, 0.55);
    }
    light(scx, scy, C.fieldLine, 0.6, 0.35);
  };
  /** a biodome: a garden under a glass dome, its reflection at the top left */
  const biodome = (x, y, bw, bh) => {
    const r = Math.min(bw, bh) / 2 - 0.5;
    const dcx = x + bw / 2;
    const dcy2 = y + bh / 2;
    ellipse(dcx + 2, dcy2 + 2, r, r, C.shadow);
    ellipse(dcx, dcy2, r, r, C.garden);
    for (let k = 0; k < Math.round(r * r * 0.25); k++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * (r - 2.5);
      const tx = dcx + Math.cos(a) * d;
      const ty = dcy2 + Math.sin(a) * d;
      const tr = rand(1.2, 2.2);
      ellipse(tx, ty, tr, tr, C.plant);
      ellipse(tx - tr * 0.35, ty - tr * 0.35, tr * 0.45, tr * 0.45, C.plantLit);
    }
    ellipse(dcx, dcy2, r * 0.3, r * 0.2, scale(NEON[0], 0.5)); // a pool
    ellipse(dcx, dcy2, r, r, scale(C.glass, 0.8), 1);
    // the reflection: an arc at the top left
    for (let a = Math.PI * 1.05; a < Math.PI * 1.45; a += 0.08) cell(dcx + Math.cos(a) * (r - 1.5), dcy2 + Math.sin(a) * (r - 1.5), C.glass);
    light(dcx, dcy2, C.plantLit, 0.5, 0.3);
  };
  /** office towers: dark metal, a neon strip along one edge, light panels on the roof */
  const offices = (x, y, bw, bh) => {
    const n = bh > bw * 1.2 ? 2 : 1;
    const gap = 2;
    const each = (bh - gap * (n - 1)) / n;
    for (let k = 0; k < n; k++) {
      const by = y + k * (each + gap) + 1;
      const tw = Math.max(3, bw - 4);
      const th = Math.max(3, Math.floor(each) - 3);
      const tx = x + 1;
      const hgt = Math.random() < 0.5 ? 2 : 3;
      const metal = pick(C.metal);
      const neon = pick(NEON);
      rect(tx + hgt, by + hgt, tw, th, C.shadow);
      rect(tx, by, tw, th, metal);
      rect(tx, by, tw, 1, scale(metal, 1.8));
      rect(tx, by, 1, th, scale(metal, 1.5));
      rect(tx + tw - 1, by, 1, th, neon);
      if (tw > 5 && th > 4) {
        rect(tx + 2, by + 2, Math.min(3, tw - 4), 1, C.panel);
        rect(tx + 2, by + th - 3, Math.min(3, tw - 4), 1, scale(C.panel, 0.7));
      }
    }
  };
  const kinds = ['pad', 'offices', 'biodome', 'arena', 'hexTower', 'offices', 'biodome', 'hexTower'];
  let n = 0;
  const rows = [top, ...streets.map((y) => y + crossH)];
  for (let r = 0; r < rows.length; r++) {
    const y0 = rows[r] + 2;
    const y1 = (r + 1 < rows.length ? streets[r] : gh) - 2;
    for (const [x0, x1] of [
      [inner0 + 2, r0 - 2],
      [r1 + 2, inner1 - 2],
    ]) {
      const bw = x1 - x0;
      const bh = y1 - y0;
      if (bw < 4 || bh < 4) continue;
      const kind = kinds[n++ % kinds.length];
      const sq = Math.min(bw - 3, bh - 3);
      if (kind === 'pad') pad(x0 + 1, y0 + 1, sq, sq);
      else if (kind === 'arena') arena(x0, y0, bw, Math.min(bh, bw * 1.5));
      else if (kind === 'biodome') biodome(x0, y0, bw, Math.min(bh, bw));
      else if (kind === 'hexTower') hexTower(x0, y0, bw, Math.min(bh, bw));
      else offices(x0, y0, bw, bh);
    }
  }

  // ---- the energy wall with its towers (drawn live, see draw.js; only marked here)
  for (let y = 0; y < h; y++) {
    base[y * w] = CITY.WALL;
    base[y * w + w - 1] = CITY.WALL;
  }
  for (let y = 4; y < h - 3; y += 13) {
    for (let j = 0; j < 3; j++) {
      base[(y + j) * w] = CITY.TOWER;
      base[(y + j) * w + w - 1] = CITY.TOWER;
    }
  }
  const [corex, corey] = toArt(cx, dcy);
  const [condx, cond0] = toArt(cx, top);
  return { base, img, lanes, lights, W, H, core: { x: corex, y: corey, r: (dr * q) / S }, conduit: { x: condx, y0: cond0, y1: h } };
}
