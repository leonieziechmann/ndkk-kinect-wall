// The players as ninjas: every cell of a person's silhouette (from the mask, exact every frame) gets a
// piece of the costume from the nearest bone of the skeleton, and a shade from where it lies on that
// limb (a cylinder lit from the top left: volume instead of a flat cut-out). A dark suit with a crossed
// collar and a belt with a knot, a hood with an eye slit, glowing eyes and a headband in the player's
// color, metal guards on the forearms, wraps on the wrists and shins. The tails of the headband and the
// hilt of a sword on the back are drawn behind the body (draw.js).

export const PART = { SUIT: 1, HOOD: 2, SKIN: 3, EYE: 4, BAND: 5, BELT: 6, COLLAR: 7, WRAP: 8, WRAP2: 9, FOOT: 10, PLATE: 11, PANTS: 12 };
/** the shade of a cell: base, lit (towards the light), dark (away from it) */
export const SHADE = { BASE: 0, LIT: 1, DARK: 2 };

// the bones: [from, to, kind]
const K = { TORSO: 0, UPPER: 1, FORE: 2, HAND: 3, THIGH: 4, SHIN: 5, NECK: 6 };
// the radius of each kind of limb (m): how far from the bone its surface turns away from the light
const RADIUS = [0.17, 0.055, 0.05, 0.045, 0.085, 0.065, 0.06];
const BONES = [
  ['neck', 'pelvis', K.TORSO],
  ['leftShoulder', 'leftHip', K.TORSO],
  ['rightShoulder', 'rightHip', K.TORSO],
  ['leftShoulder', 'rightShoulder', K.TORSO],
  ['leftHip', 'rightHip', K.TORSO],
  ['leftShoulder', 'leftElbow', K.UPPER],
  ['rightShoulder', 'rightElbow', K.UPPER],
  ['leftElbow', 'leftWrist', K.FORE],
  ['rightElbow', 'rightWrist', K.FORE],
  ['leftWrist', 'leftHand', K.HAND],
  ['rightWrist', 'rightHand', K.HAND],
  ['leftHip', 'leftKnee', K.THIGH],
  ['rightHip', 'rightKnee', K.THIGH],
  ['leftKnee', 'leftAnkle', K.SHIN],
  ['rightKnee', 'rightAnkle', K.SHIN],
  ['neck', 'head', K.NECK],
];
export const JOINTS = [...new Set(BONES.flatMap((b) => [b[0], b[1]]))];

/** the skeleton of a person on the wall: { name: [x, y] } (m), only the points that are seen */
export function skeletonOf(wall, person) {
  const sk = {};
  for (const n of JOINTS) {
    const j = wall.joint(person, n);
    if (j) sk[n] = [j[0], j[1]];
  }
  return sk;
}

/** a standing figure for the test players: x, head height, hands [[x, y] | null, ...] (wall m) */
export function fakeSkeleton(x, hy, hands = []) {
  const sk = {
    head: [x, hy],
    neck: [x, hy - 0.17],
    leftShoulder: [x - 0.19, hy - 0.25],
    rightShoulder: [x + 0.19, hy - 0.25],
    leftHip: [x - 0.1, hy - 0.8],
    rightHip: [x + 0.1, hy - 0.8],
    pelvis: [x, hy - 0.8],
    leftKnee: [x - 0.11, hy - 1.22],
    rightKnee: [x + 0.11, hy - 1.22],
    leftAnkle: [x - 0.12, 0.08],
    rightAnkle: [x + 0.12, 0.08],
  };
  for (const [k, side] of [
    [0, 'left'],
    [1, 'right'],
  ]) {
    const s = sk[`${side}Shoulder`];
    const h = hands[k] ?? [s[0] + (side === 'left' ? -0.06 : 0.06), hy - 0.85];
    // the elbow bends outwards between shoulder and hand
    const mx = (s[0] + h[0]) / 2;
    const my = (s[1] + h[1]) / 2;
    const dx = h[0] - s[0];
    const dy = h[1] - s[1];
    const l = Math.hypot(dx, dy) || 1;
    const bend = Math.max(0, 0.27 - l / 2) * (side === 'left' ? -1 : 1);
    sk[`${side}Elbow`] = [mx - (dy / l) * bend, my + (dx / l) * bend];
    sk[`${side}Hand`] = h;
    sk[`${side}Wrist`] = [h[0] - (dx / l) * 0.07, h[1] - (dy / l) * 0.07];
  }
  return sk;
}

/** the body of a test figure: [from, to, radius] (m) */
export const FAKE_BODY = [
  ['neck', 'pelvis', 0.16],
  ['leftShoulder', 'rightShoulder', 0.06],
  ['leftHip', 'rightHip', 0.08],
  ['leftShoulder', 'leftElbow', 0.05],
  ['rightShoulder', 'rightElbow', 0.05],
  ['leftElbow', 'leftWrist', 0.045],
  ['rightElbow', 'rightWrist', 0.045],
  ['leftWrist', 'leftHand', 0.04],
  ['rightWrist', 'rightHand', 0.04],
  ['leftHip', 'leftKnee', 0.08],
  ['rightHip', 'rightKnee', 0.08],
  ['leftKnee', 'leftAnkle', 0.06],
  ['rightKnee', 'rightAnkle', 0.06],
  ['neck', 'head', 0.05],
];

/** the bones of a skeleton as flat segments [ax, ay, bx, by, kind, length] */
function segments(sk) {
  const out = [];
  for (const [a, b, k] of BONES) {
    const p = sk[a];
    const q = sk[b];
    if (p && q) out.push([p[0], p[1], q[0], q[1], k, Math.hypot(q[0] - p[0], q[1] - p[1]) || 1e-6]);
  }
  return out;
}

/**
 * The costume for every covered cell: cell (slots, AW wide), part and shade (out), box ([x0, y0, x1,
 * y1]: where the people are), skels (slot -> skeleton), L ({ ppm: cells per m, top }). Cells of a
 * person without a skeleton are all suit.
 */
export function dress(cell, part, shade, AW, box, skels, L) {
  const prep = new Map();
  for (const [slot, sk] of skels) {
    const segs = segments(sk);
    const pelvisY = sk.pelvis?.[1] ?? (sk.leftHip && sk.rightHip ? (sk.leftHip[1] + sk.rightHip[1]) / 2 : null);
    // the crossed collar: from beside the neck down to the chest
    let collar = null;
    if (sk.neck && sk.leftShoulder && sk.rightShoulder && pelvisY !== null) {
      const chest = [sk.neck[0], sk.neck[1] - (sk.neck[1] - pelvisY) * 0.32];
      const l = [sk.neck[0] + (sk.leftShoulder[0] - sk.neck[0]) * 0.45, sk.neck[1] + (sk.leftShoulder[1] - sk.neck[1]) * 0.45];
      const r = [sk.neck[0] + (sk.rightShoulder[0] - sk.neck[0]) * 0.45, sk.neck[1] + (sk.rightShoulder[1] - sk.neck[1]) * 0.45];
      collar = [l, r].map((a) => [a[0], a[1], chest[0], chest[1], 0, Math.hypot(chest[0] - a[0], chest[1] - a[1]) || 1e-6]);
    }
    const spine = sk.neck && sk.pelvis ? [sk.neck[0], sk.neck[1], sk.pelvis[0], sk.pelvis[1], K.TORSO, Math.hypot(sk.pelvis[0] - sk.neck[0], sk.pelvis[1] - sk.neck[1]) || 1e-6] : null;
    prep.set(slot, { sk, segs, pelvisY, collar, spine });
  }
  // the body in blocks of 2 x 2 cells (the bones are the costly part, and 2 cells are plenty for the
  // suit, the wraps and the shading); the fine things (the head with its eye slit, the belt knot) per cell
  const inv = 1 / L.ppm;
  const AH = cell.length / AW;
  for (let by = box[1]; by <= box[3]; by += 2) {
    for (let bx = box[0]; bx <= box[2]; bx += 2) {
      let done = 0;
      let bodyPart = 0;
      let bodyShade = 0;
      for (let k = 0; k < 4; k++) {
        const cx = bx + (k & 1);
        const cy = by + (k >> 1);
        if (cx > box[2] || cy > box[3] || cy >= AH) continue;
        const c = cy * AW + cx;
        const s = cell[c];
        if (!s) continue;
        const pp = prep.get(s);
        if (!pp) {
          part[c] = PART.SUIT;
          shade[c] = SHADE.BASE;
          continue;
        }
        const fine = classifyFine(pp, (cx + 0.5) * inv, L.top - (cy + 0.5) * inv);
        if (fine) {
          part[c] = fine;
          shade[c] = OUT[3];
          continue;
        }
        if (done !== s) {
          done = s;
          bodyPart = classify(pp, (bx + 1) * inv, L.top - (by + 1) * inv);
          bodyShade = OUT[3];
        }
        part[c] = bodyPart;
        shade[c] = bodyShade;
      }
    }
  }
}

// results of the helpers below (a typed array: module-level `let`s are slow in hot code):
// [0] where along the segment segDist2() found the nearest point, [1], [2] the offset of the point
// from that nearest point (m), [3] the shade classify() found
const OUT = new Float64Array(4);
/** squared distance from (px, py) to segment s ([ax, ay, bx, by, kind, length]) */
function segDist2(px, py, s) {
  const dx = s[2] - s[0];
  const dy = s[3] - s[1];
  let u = ((px - s[0]) * dx + (py - s[1]) * dy) / (s[5] * s[5]);
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  OUT[0] = u;
  const ox = px - s[0] - dx * u;
  const oy = py - s[1] - dy * u;
  OUT[1] = ox;
  OUT[2] = oy;
  return ox * ox + oy * oy;
}

/** light from the top left on a cylinder: the offset from the bone (m) over the radius */
function shadeOf(ox, oy, r) {
  const l = (-0.62 * ox + 0.55 * oy) / r;
  return l > 0.28 ? SHADE.LIT : l < -0.32 ? SHADE.DARK : SHADE.BASE;
}

/** the fine things at one cell: the head (hood, headband, eye slit, eyes), the belt knot; else 0 */
function classifyFine(pp, x, y) {
  const sk = pp.sk;
  const h = sk.head;
  // the head: hood, the headband over the eye slit
  if (h && y > (sk.neck?.[1] ?? h[1] - 0.15) - 0.005 && (x - h[0]) ** 2 + ((y - h[1]) * 0.9) ** 2 < 0.0225) {
    const dy = y - h[1];
    const dx = Math.abs(x - h[0]);
    OUT[3] = shadeOf(x - h[0], dy, 0.11);
    if (dy > 0.042 && dy < 0.088) return PART.BAND;
    if (dy > -0.012 && dy <= 0.042 && dx < 0.072) {
      if (dy > 0.002 && dy < 0.026 && Math.abs(dx - 0.034) < 0.011) return PART.EYE;
      return PART.SKIN;
    }
    return PART.HOOD;
  }
  // the knot of the belt: two ends hanging in front
  if (pp.pelvisY !== null && sk.pelvis && y < pp.pelvisY - 0.01 && y > pp.pelvisY - 0.1 && Math.abs(x - sk.pelvis[0] + 0.03 + (pp.pelvisY - y) * 0.15) < 0.014) {
    OUT[3] = SHADE.BASE;
    return PART.BELT;
  }
  return 0;
}

/** the costume of the body at (x, y): the piece of the nearest bone */
function classify(pp, x, y) {
  const { sk, segs } = pp;
  let best = 1e9;
  let bs = null;
  let bu = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const d = segDist2(x, y, s);
    if (d < best) {
      best = d;
      bs = s;
      bu = OUT[0];
    }
  }
  if (!bs) return PART.SUIT;
  // the shade: from the spine for the body, else from the nearest bone
  if (bs[4] === K.TORSO && pp.spine) {
    segDist2(x, y, pp.spine);
    OUT[3] = shadeOf(OUT[1], OUT[2], RADIUS[K.TORSO]);
  } else {
    segDist2(x, y, bs);
    OUT[3] = shadeOf(OUT[1], OUT[2], RADIUS[bs[4]]);
  }
  switch (bs[4]) {
    case K.TORSO: {
      if (pp.pelvisY !== null && Math.abs(y - pp.pelvisY - 0.02) < 0.035) return PART.BELT;
      if (pp.collar && (segDist2(x, y, pp.collar[0]) < 0.017 ** 2 || segDist2(x, y, pp.collar[1]) < 0.017 ** 2)) return PART.COLLAR;
      return PART.SUIT;
    }
    case K.FORE:
      return bu > 0.88 ? PART.WRAP : bu > 0.5 ? PART.PLATE : PART.SUIT;
    case K.THIGH:
      return PART.PANTS;
    case K.HAND:
      return PART.WRAP;
    case K.SHIN: {
      if (bu > 0.97 || (sk.leftAnkle && sk.rightAnkle && y < Math.max(sk.leftAnkle[1], sk.rightAnkle[1]) - 0.01)) return PART.FOOT;
      // diagonal wraps along the shin
      const along = bu * bs[5];
      const ux = (bs[2] - bs[0]) / bs[5];
      const uy = (bs[3] - bs[1]) / bs[5];
      const across = (x - bs[0]) * -uy + (y - bs[1]) * ux;
      if (bu < 0.15) return PART.SUIT;
      return Math.floor((along + across * 0.7) / 0.032) % 2 === 0 ? PART.WRAP : PART.WRAP2;
    }
    case K.NECK:
      return PART.HOOD;
    default:
      return PART.SUIT;
  }
}
