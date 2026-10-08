// The people as pixel figures in the LED mosaic, and their jumps.
//
// Every person pixel of the tracking result (ctx.kinect.persons, live masks) goes into the room and
// onto the wall with the shared wall core (mirror, the walk stretched over the wall, the body in real
// size, ctx.wall). Then the game scales each figure about its own center so that everybody is the
// same height on the wall ("figH"): a child and a tall adult duck under the same bat. The floor is the
// game's ground line. A cell of the mosaic is covered when enough of it is covered by the person
// (area in m², the same near the sensor or far), and every covered cell gets a body part from the
// nearest bone of the skeleton: hair, skin, shirt, sleeves, pants, shoes.
//
// Jumping: the real hop of a person lifts the body only 10-20 cm. As soon as one is detected (the
// pelvis rises fast above where it stands, or the feet leave the floor) the figure does a game jump:
// a fixed arc, high enough to clear the obstacles on the ground. Ducking needs nothing: the figure
// crouches with the person.

import { PART, outfit } from './art.js';

const FOCAL = 366; // Kinect v2 depth camera, px: a pixel at z m covers (z / FOCAL)² m²
const HIST_MIN = -0.5; // m: height histogram per person, 1 cm bins
const HIST_BINS = 300;
const SLOTS = 17;
const PLAY_HYST = 0.15; // m

// bones for the body parts: [from, to, part]; hands and forearms depend on the outfit
const BONES = [
  ['neck', 'pelvis', PART.SHIRT],
  ['leftShoulder', 'leftHip', PART.SHIRT],
  ['rightShoulder', 'rightHip', PART.SHIRT],
  ['leftShoulder', 'rightShoulder', PART.SHIRT],
  ['leftShoulder', 'leftElbow', PART.SLEEVE],
  ['rightShoulder', 'rightElbow', PART.SLEEVE],
  ['leftElbow', 'leftWrist', -1],
  ['rightElbow', 'rightWrist', -1],
  ['leftWrist', 'leftHand', PART.SKIN],
  ['rightWrist', 'rightHand', PART.SKIN],
  ['leftHip', 'leftKnee', PART.PANTS],
  ['rightHip', 'rightKnee', PART.PANTS],
  ['leftKnee', 'leftAnkle', PART.PANTS],
  ['rightKnee', 'rightAnkle', PART.PANTS],
  ['leftHip', 'rightHip', PART.PANTS],
];
const JOINT_NAMES = [...new Set(BONES.flatMap((b) => [b[0], b[1]]).concat(['head']))];

function median(arr, n) {
  if (!n) return 0;
  const s = Array.from(arr.subarray(0, n)).sort((a, b) => a - b);
  return s[Math.floor(n / 2)];
}

function percentile(arr, n, q) {
  if (!n) return 0;
  const s = Array.from(arr.subarray(0, n)).sort((a, b) => a - b);
  return s[Math.min(n - 1, Math.floor(n * q))];
}

/** a ring of the last n values */
class Ring {
  constructor(n) {
    this.v = new Float32Array(n);
    this.n = 0;
    this.i = 0;
  }
  push(x) {
    this.v[this.i] = x;
    this.i = (this.i + 1) % this.v.length;
    this.n = Math.min(this.n + 1, this.v.length);
  }
  median() {
    return median(this.v, this.n);
  }
  /** pushes x; the standing level: the highest median of the ring, sinking `decay` m/s */
  stand(x, time, decay = 0.003) {
    this.push(x);
    const m = this.median();
    const dt = this.last === undefined ? 0 : Math.max(0, time - this.last);
    this.last = time;
    this.level = this.level === undefined || m > this.level ? m : this.level - decay * dt;
    return this.level;
  }
  pct(q) {
    return percentile(this.v, this.n, q);
  }
}

/** distance from (px, py) to the segment a-b */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ey = ay + dy * t - py;
  return Math.sqrt(ex * ex + ey * ey);
}

export class Figure {
  constructor(id, slot, time, fake = false) {
    this.id = id;
    this.slot = slot;
    this.fake = fake;
    this.outfit = outfit(typeof id === 'number' ? id : [...String(id)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) & 0xffff, slot);
    this.born = time;
    this.seen = time;
    this.visible = true;
    this.k = 0; // scale real body -> figure on the wall (0 = not known yet)
    this.cx = 0; // wall x of the body center (m from the left edge)
    this.dist = 3;
    this.heights = new Ring(30); // 1 s at 30 fps: the standing height (Ring.stand)
    this.pelvis = new Ring(30); // the standing level of the pelvis
    this.standH = 0;
    this.realRise = 0; // m on the wall: how far the real body is above where it stands
    this.sig = { pelvisY: 0, pelvisVy: 0, feetY: 0, topY: 0, height: 0, basePelvis: 0 };
    this.grid = null; // part per cell (before the jump lift), see PeopleLayer
    this.bbox = [0, 0, -1, -1]; // c0, r0, c1, r1 (inclusive)
    this.cells = 0;
    this.headCell = null; // [col, row] of the top of the head (before the lift)
    this.air = false; // jumping (game physics)
    this.h = 0; // m above the ground (game physics)
    this.vy = 0; // m/s
    this.g = 9.81;
    this.airJumps = 0;
    this.armed = true; // the next hop may trigger a jump
    this.armedAt = 0;
    this.lift = 0; // m the figure is drawn higher than the person's mask
    this.liftRows = 0;
    this.landed = -1;
    this.jumps = 0;
    // game state
    this.hitAt = -10;
    this.safeUntil = 0;
    this.starUntil = 0;
    this.streak = 0;
    this.coins = 0;
  }

  /**
   * A jump: pushes the figure up with the boost (it reaches jumpHeight in jumpTime / 2 and lands
   * after jumpTime). In the air another hop pushes it up again from where it is: air jumps.
   * lead: s of the jump that already passed when it was detected (only on the ground).
   */
  startJump(time, p, lead = 0) {
    const v0 = (4 * p.jumpHeight) / p.jumpTime;
    this.g = (8 * p.jumpHeight) / (p.jumpTime * p.jumpTime);
    this.airJumps = this.air ? this.airJumps + 1 : 0;
    this.vy = v0;
    if (!this.air && lead > 0) {
      this.h = v0 * lead - 0.5 * this.g * lead * lead;
      this.vy = v0 - this.g * lead;
    }
    this.air = true;
    this.jumps++;
  }

  /** the jump physics: rises, falls, lands; the figure never leaves the wall at the top */
  updateLift(time, dt, L) {
    if (this.air) {
      this.vy -= this.g * dt;
      this.h += this.vy * dt;
      // the ceiling: one cell below the wall's top edge (the top cell may be a raised hand)
      const ceil = this.headCell ? Math.max(0.1, (this.headCell[1] - 1) * L.cellMy + this.realRise) : 1;
      if (this.h > ceil) {
        this.h = ceil;
        if (this.vy > 0) this.vy = 0;
      }
      if (this.h <= 0 && this.vy < 0) {
        this.h = 0;
        this.vy = 0;
        this.air = false;
        this.landed = time;
        this.justLanded = true;
      }
    }
    // the figure rises with the real body already: the jump only adds what is missing
    const lift = Math.max(0, this.h - this.realRise);
    this.lift = lift;
    this.liftRows = Math.round(lift / L.cellMy);
    return this.lift;
  }

  get airborne() {
    return this.air;
  }
}

export class PeopleLayer {
  constructor() {
    this.figures = new Map(); // id -> Figure
    this.list = []; // the figures on the wall now, far to near
    this.area = new Map(); // slot -> Float32Array(GW * GH)
    this.hist = new Uint16Array(SLOTS * HIST_BINS);
    this.key = '';
    this.log = []; // jump signals (debugging and calibration)
    this.logMax = 6000;
    this.entered = [];
    this.jumped = [];
  }

  /** the figures for this frame; rasterizes the masks when a new tracking result came */
  update(ctx, L, p, time, fakes, dt) {
    const wall = ctx.wall;
    const key = `${L.GW}x${L.GH}`;
    if (key !== this.key) {
      this.key = key;
      this.area.clear();
      for (const f of this.figures.values()) f.grid = null;
    }
    this.entered.length = 0;
    this.jumped.length = 0;
    const fresh = Boolean(ctx.persons?.fresh && ctx.kinect.persons);

    // who is there
    const seen = new Set();
    for (const q of wall.persons) {
      if (!q.inZone) continue;
      let f = this.figures.get(q.id);
      if (!f) {
        f = new Figure(q.id, q.slot, time);
        f.player = false;
        this.figures.set(q.id, f);
      }
      seen.add(q.id);
      f.slot = q.slot;
      f.seen = time;
      f.cx = q.x;
      f.dist = q.dist;
      f.q = q;
      // plays only within the play distance (further away the tracking is too rough): the others
      // stand in the background, smaller and dim. A little hysteresis against flicker at the edge.
      const m = f.player ? PLAY_HYST : -PLAY_HYST;
      const play = q.dist >= p.playNear - m && q.dist <= p.playFar + m;
      if (play && !f.player) {
        f.born = time; // appears as a player
        this.entered.push(f);
      }
      f.player = play;
      if (fresh) this.scale(f, q.person, p, time);
    }
    // test figures (no Kinect): see makeFake()
    for (const fk of fakes) {
      const id = `fake${fk.id}`;
      let f = this.figures.get(id);
      if (!f) {
        f = new Figure(id, fk.slot ?? 1, time, true);
        this.figures.set(id, f);
        this.entered.push(f);
      }
      f.player = !fk.back; // back: stands too far away to play
      seen.add(id);
      f.seen = time;
      f.cx = fk.x;
      f.dist = fk.dist ?? 2.5;
      f.k = 1;
      if (fk.jump) {
        fk.jump = false;
        f.startJump(time, p);
        this.jumped.push(f);
      }
      this.makeFake(f, fk, L, p);
    }
    for (const [id, f] of this.figures) {
      f.visible = seen.has(id);
      if (!f.visible && time - f.seen > 1.5) this.figures.delete(id);
    }

    if (fresh) {
      this.rasterize(ctx, L, p);
      for (const f of this.figures.values()) if (f.visible && !f.fake && f.q) this.signals(f, f.q.person, wall, p, time);
    }

    const list = [];
    for (const f of this.figures.values()) {
      if (!f.visible || !f.grid) continue;
      f.updateLift(time, dt, L);
      list.push(f);
    }
    list.sort((a, b) => b.dist - a.dist);
    this.list = list;
    return list;
  }

  /** the person's scale on the wall: everyone the same height (or everyone scaled alike) */
  scale(f, P, p, time) {
    const h = P.height ?? 0;
    if (h > 0.5) f.standH = f.heights.stand(h, time);
    const standH = Math.min(2.2, Math.max(0.9, f.standH || h || 1.7));
    const kT = (p.sameSize ? p.figH / standH : p.figH / 1.75) * (f.player ? 1 : p.bgScale);
    f.k = f.k ? f.k + (kT - f.k) * 0.08 : kT;
  }

  /**
   * The jump detection (once per tracking result). Measured on final-solo in live mode: a real jump
   * lifts the pelvis 10-50 cm above where it stands, at over 0.5 m/s; jumping jacks lift it 5-9 cm.
   * Bobbing knees and standing up from a crouch bring it back to the standing level and hardly above
   * (standing up reaches 2 m/s, so the speed alone says nothing). The standing level is the highest
   * 1 s median of the last seconds and sinks only 3 mm/s: it stays put while someone crouches.
   */
  signals(f, P, wall, p, time) {
    const m = wall.room.matrix;
    const s = f.sig;
    s.height = P.height ?? 0;
    const pel = P.room?.joints?.pelvis;
    const mv = P.motion?.pelvis;
    let jumped = false;
    if (pel) {
      s.pelvisY = pel[1];
      s.pelvisVy = mv ? m[1] * mv[0] + m[5] * mv[1] + m[9] * mv[2] : 0;
      s.basePelvis = f.pelvis.stand(s.pelvisY, time);
      const rise = s.pelvisY - s.basePelvis;
      f.realRise = Math.max(0, rise) * f.k;
      // every hop counts, also in the air (air jumps). One hop triggers once: the next one needs
      // the pelvis to have stopped rising first.
      if (f.player && f.alive !== false && f.armed && time - f.born > 1 && f.pelvis.n >= 20 && s.pelvisVy > p.jumpVy && rise > p.jumpRise) {
        f.startJump(time, p, p.jumpLead);
        f.armed = false;
        f.armedAt = time;
        this.jumped.push(f);
        jumped = true;
      } else if (!f.armed && time - f.armedAt > p.jumpRest && (s.pelvisVy < 0.05 || rise < p.jumpRise * 0.5)) f.armed = true;
    } else f.realRise = 0;
    if (this.log.length < this.logMax) {
      this.log.push([+time.toFixed(3), f.id, +s.pelvisY.toFixed(3), +s.pelvisVy.toFixed(3), +s.feetY.toFixed(3), +s.topY.toFixed(3), +s.height.toFixed(3), +s.basePelvis.toFixed(3), 0, jumped ? 1 : 0]);
    }
  }

  /** person pixels -> cells per figure, then the body parts */
  rasterize(ctx, L, p) {
    const wall = ctx.wall;
    const kp = ctx.kinect.persons;
    const rays = ctx.kinect.rays;
    if (!kp || !rays) return;
    const S = wall.setup;
    const m = wall.room.matrix;
    const side = wall.side;
    const xSign = ctx.xSign;
    const perPerson = S.map.apply === 'person';
    const center = S.size.w / 2 + S.sensor.x;
    const { near, far } = S.zone;
    const { GW, GH } = L;
    const n = GW * GH;

    const bySlot = new Array(SLOTS).fill(null);
    for (const f of this.figures.values()) if (f.visible && !f.fake && f.slot > 0 && f.slot < SLOTS && f.k) bySlot[f.slot] = f;
    const area = [];
    for (let s = 0; s < SLOTS; s++) {
      if (!bySlot[s]) {
        area.push(null);
        continue;
      }
      let a = this.area.get(s);
      if (!a || a.length !== n) {
        a = new Float32Array(n);
        this.area.set(s, a);
      } else a.fill(0);
      area.push(a);
    }
    const hist = this.hist;
    hist.fill(0);

    const shift = wall.shift;
    const invF2 = 1 / (FOCAL * FOCAL);
    const { indices, labels, depth } = kp;
    const pxX = L.pxX / L.cellPx;
    const oxC = L.ox / L.cellPx;
    const rowTop = L.groundRow - 1;
    const invCy = 1 / L.cellMy;
    const wide = p.wide;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j];
      const s = labels[i];
      const f = bySlot[s];
      if (!f) continue;
      const mm = depth[i];
      if (mm < 100) continue;
      const z = mm * 0.001;
      const wx = xSign * rays[2 * i] * z;
      const wy = -rays[2 * i + 1] * z;
      const rz = m[2] * wx + m[6] * wy + m[10] * z + m[14];
      if (rz < near || rz > far) continue;
      const rx = m[0] * wx + m[4] * wy + m[8] * z + m[12];
      const ry = m[1] * wx + m[5] * wy + m[9] * z + m[13];
      const hb = Math.floor((ry - HIST_MIN) * 100);
      if (hb >= 0 && hb < HIST_BINS) hist[s * HIST_BINS + hb]++;
      const lat = side * rx;
      const x = center + (perPerson ? lat + shift[s] : lat * wall.k(lat, rz));
      const k = f.k;
      const gx = f.cx + (x - f.cx) * k * wide;
      const gy = ry * k;
      const col = Math.floor(gx * pxX - oxC);
      const row = rowTop - Math.floor(gy * invCy);
      if (col < 0 || col >= GW || row < 0 || row >= GH) continue;
      area[s][row * GW + col] += z * z * invF2 * k * k * wide;
    }

    // feet and top of each person from the height histogram (robust percentiles)
    for (let s = 1; s < SLOTS; s++) {
      const f = bySlot[s];
      if (!f) continue;
      let total = 0;
      for (let b = 0; b < HIST_BINS; b++) total += hist[s * HIST_BINS + b];
      if (total < 50) continue;
      let acc = 0;
      let lo = -1;
      let hi = -1;
      for (let b = 0; b < HIST_BINS; b++) {
        acc += hist[s * HIST_BINS + b];
        if (lo < 0 && acc >= total * 0.03) lo = b;
        if (hi < 0 && acc >= total * 0.99) hi = b;
      }
      f.sig.feetY = HIST_MIN + lo / 100;
      f.sig.topY = HIST_MIN + hi / 100;
    }

    const need = p.fill * L.cellMx * L.cellMy;
    for (let s = 1; s < SLOTS; s++) {
      const f = bySlot[s];
      if (!f) continue;
      this.parts(f, area[s], need, wall, L, p);
    }
  }

  /** covered cells of one figure -> body parts (f.grid, f.bbox) */
  parts(f, a, need, wall, L, p) {
    const { GW, GH } = L;
    const n = GW * GH;
    if (!f.grid || f.grid.length !== n) f.grid = new Uint8Array(n);
    const g = f.grid;
    g.fill(0);
    let c0 = GW;
    let r0 = GH;
    let c1 = -1;
    let r1 = -1;
    for (let c = 0; c < n; c++) {
      if (a[c] < need) continue;
      g[c] = 1;
      const x = c % GW;
      const y = (c - x) / GW;
      if (x < c0) c0 = x;
      if (x > c1) c1 = x;
      if (y < r0) r0 = y;
      if (y > r1) r1 = y;
    }
    f.bbox = [c0, r0, c1, r1];
    if (c1 < 0) {
      f.cells = 0;
      return;
    }
    // close single holes, drop lone cells (4 neighbours)
    const at = (x, y) => (x >= 0 && y >= 0 && x < GW && y < GH ? g[y * GW + x] : 0);
    for (let y = r0; y <= r1; y++) {
      for (let x = c0; x <= c1; x++) {
        const nb = (at(x - 1, y) ? 1 : 0) + (at(x + 1, y) ? 1 : 0) + (at(x, y - 1) ? 1 : 0) + (at(x, y + 1) ? 1 : 0);
        const c = y * GW + x;
        if (!g[c] && nb >= 3) g[c] = 2;
        else if (g[c] === 1 && nb === 0 && a[c] < need * 2.5) g[c] = 0;
      }
    }

    // the skeleton in game meters
    const P = f.q?.person;
    const J = {};
    const room = P?.room?.joints;
    const tmp = [0, 0, 0];
    if (room) {
      for (const name of JOINT_NAMES) {
        const r = room[name];
        if (!r) continue;
        wall.fromRoom(r, f.slot, tmp);
        J[name] = [f.cx + (tmp[0] - f.cx) * f.k * p.wide, r[1] * f.k];
      }
    }
    const segs = [];
    const fore = f.outfit.longSleeves ? PART.SLEEVE : PART.SKIN;
    for (const [a1, b1, part] of BONES) {
      if (J[a1] && J[b1]) segs.push([J[a1][0], J[a1][1], J[b1][0], J[b1][1], part < 0 ? fore : part]);
    }
    f.segs = segs;
    const head = J.head;
    const headR = 0.11 * f.k; // a head is about 22 cm tall
    const shoesY = L.cellMy * 1.05;
    let count = 0;
    let topRow = GH;
    let topCol = 0;
    for (let y = r0; y <= r1; y++) {
      const gy = (L.groundRow - 1 - y + 0.5) * L.cellMy;
      for (let x = c0; x <= c1; x++) {
        const c = y * GW + x;
        if (!g[c]) continue;
        count++;
        if (y < topRow) {
          topRow = y;
          topCol = x;
        }
        const gx = ((x + 0.5) * L.cellPx + L.ox) / L.pxX;
        let best = 1e9;
        let part = PART.SHIRT;
        for (const sg of segs) {
          const d = segDist(gx, gy, sg[0], sg[1], sg[2], sg[3]);
          if (d < best) {
            best = d;
            part = sg[4];
          }
        }
        if (head) {
          const dh = Math.hypot(gx - head[0], gy - head[1]) - headR;
          if (dh < best && gy > (J.neck ? J.neck[1] : -1)) {
            part = gy > head[1] + headR * 0.15 ? PART.HAIR : PART.SKIN;
          }
        } else if (!segs.length && y <= r0 + 2) part = PART.HAIR;
        if (part === PART.PANTS && gy < shoesY) part = PART.SHOES;
        g[c] = part;
      }
    }
    f.cells = count;
    f.headCell = count ? [topCol, topRow] : null;
  }

  /** a test figure without the Kinect: { x (m), h (m, real), crouch 0..1, arms: 'up' | 'side' | '' } */
  makeFake(f, fk, L, p) {
    const { GW, GH } = L;
    const n = GW * GH;
    if (!f.grid || f.grid.length !== n) f.grid = new Uint8Array(n);
    const g = f.grid;
    g.fill(0);
    const sc = fk.back ? p.bgScale : 1;
    const H = p.figH * sc * (1 - 0.42 * (fk.crouch ?? 0));
    const W = p.figH * sc * p.wide;
    const cx = fk.x;
    const put = (x0, x1, y0, y1, part) => {
      for (let gy = y0; gy < y1; gy += L.cellMy * 0.5) {
        for (let gx = x0; gx < x1; gx += L.cellMx * 0.5) {
          const col = Math.floor((gx * L.pxX - L.ox) / L.cellPx);
          const row = L.groundRow - 1 - Math.floor(gy / L.cellMy);
          if (col >= 0 && col < GW && row >= 0 && row < GH) g[row * GW + col] = part;
        }
      }
    };
    put(cx - 0.11 * W, cx - 0.02 * W, 0, 0.06 * H, PART.SHOES);
    put(cx + 0.02 * W, cx + 0.11 * W, 0, 0.06 * H, PART.SHOES);
    put(cx - 0.11 * W, cx - 0.02 * W, 0.06 * H, 0.5 * H, PART.PANTS);
    put(cx + 0.02 * W, cx + 0.11 * W, 0.06 * H, 0.5 * H, PART.PANTS);
    put(cx - 0.12 * W, cx + 0.12 * W, 0.48 * H, 0.82 * H, PART.SHIRT);
    if (fk.arms === 'up') {
      put(cx - 0.2 * W, cx - 0.13 * W, 0.75 * H, 1.15 * H, PART.SLEEVE);
      put(cx + 0.13 * W, cx + 0.2 * W, 0.75 * H, 1.15 * H, PART.SLEEVE);
    } else if (fk.arms === 'side') {
      put(cx - 0.45 * W, cx - 0.12 * W, 0.74 * H, 0.8 * H, PART.SLEEVE);
      put(cx + 0.12 * W, cx + 0.45 * W, 0.74 * H, 0.8 * H, PART.SLEEVE);
    } else {
      put(cx - 0.18 * W, cx - 0.12 * W, 0.45 * H, 0.8 * H, PART.SLEEVE);
      put(cx + 0.12 * W, cx + 0.18 * W, 0.45 * H, 0.8 * H, PART.SLEEVE);
    }
    put(cx - 0.07 * W, cx + 0.07 * W, 0.82 * H, 0.94 * H, PART.SKIN);
    put(cx - 0.075 * W, cx + 0.075 * W, 0.94 * H, 1.0 * H, PART.HAIR);
    let c0 = GW;
    let r0 = GH;
    let c1 = -1;
    let r1 = -1;
    let count = 0;
    let top = null;
    for (let c = 0; c < n; c++) {
      if (!g[c]) continue;
      const x = c % GW;
      const y = (c - x) / GW;
      count++;
      if (x < c0) c0 = x;
      if (x > c1) c1 = x;
      if (y < r0) {
        r0 = y;
        top = [x, y];
      }
      if (y > r1) r1 = y;
    }
    f.bbox = [c0, r0, c1, r1];
    f.cells = count;
    f.headCell = top;
  }
}
