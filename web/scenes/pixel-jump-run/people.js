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
// m: a person's lowest point must have come this near the floor once. The tracker sometimes splits
// off body parts (raised arms, the upper body) as persons of their own for a few seconds: they
// float (lowest point 0.6-1.6 m) and are no people. Someone close to the sensor (0.8 m) shows
// down to about 0.4 m, everyone else down to the floor.
const GROUND_MAX = 0.45;
// the jump (see Figure.startJump, Figure.carry)
const V_SMALL = 1; // m/s: the takeoff of a small hop (measured 0.7-1.5, median 1.2); below it jumpHeight
const TA_MIN = 0.12; // s: the fastest rise (an obstacle is already close)
const TA_MAX = 0.45; // s: the slowest rise
const G_MIN = 0.5; // carried over an obstacle the figure may fall this much slower (× the jump's gravity)

/** the figure's gravity (m/s²): a small hop (jumpHeight m) lasts jumpTime s */
export function jumpGravity(p) {
  const T = Math.max(0.2, p.jumpTime);
  return (8 * p.jumpHeight) / (T * T);
}

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

/**
 * One height signal of a person: its velocity and its standing level. The standing level is a
 * percentile of the values of the last `win` seconds in which the signal stood still (|v| < 0.25
 * m/s). Not the highest median with a slow decay (the first try): that one got stuck up to 30 cm
 * too high after a few hops in a row or with the arms up, and for a minute no small hop counted.
 * A high percentile over 8 s keeps the level while someone crouches for a few seconds.
 */
class Signal {
  constructor(win = 8, pct = 0.8) {
    this.win = win;
    this.pct = pct;
    this.hist = []; // [time, value] of the still moments
    this.stand = null;
    this.v = 0;
    this.y = null;
    this.t = 0;
    this.n = 0;
  }

  /** adds a value (0/null: nothing measured); returns { stand, rise, v, y } or null */
  add(y, time) {
    if (!y) return null;
    const dt = time - this.t;
    // velocity by finite difference, lightly smoothed; a gap in the results starts over
    this.v = this.y !== null && dt > 1e-3 && dt < 0.3 ? 0.4 * this.v + 0.6 * ((y - this.y) / dt) : 0;
    this.y = y;
    this.t = time;
    this.n++;
    if (Math.abs(this.v) < 0.25) this.hist.push([time, y]);
    while (this.hist.length && time - this.hist[0][0] > this.win) this.hist.shift();
    if (this.hist.length >= 8) {
      const s = this.hist.map((h) => h[1]).sort((a, b) => a - b);
      this.stand = s[Math.min(s.length - 1, Math.floor(s.length * this.pct))];
    } else if (this.stand === null) this.stand = y;
    return { stand: this.stand, rise: y - this.stand, v: this.v, y };
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
    this.grounded = fake; // touched the floor once (GROUND_MAX): before that, no person
    this.outfit = outfit(typeof id === 'number' ? id : [...String(id)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) & 0xffff, slot);
    this.born = time;
    this.seen = time;
    this.visible = true;
    this.k = 0; // scale real body -> figure on the wall (0 = not known yet)
    this.cx = 0; // wall x of the body center (m from the left edge)
    this.dist = 3;
    this.heights = new Signal(8, 0.8); // the standing height (top of the head)
    // the jump signals (see signals()): the mask's median and mean height, its feet, the raw pelvis
    this.track = { body: new Signal(8, 0.8), mean: new Signal(8, 0.8), feet: new Signal(4, 0.5), pelvis: new Signal(8, 0.8) };
    this.candidate = -9; // when the push-off of a possible jump was seen
    this.candV = 0; // the fastest rise of the body since then (m/s)
    this.standH = 0;
    this.realRise = 0; // m on the wall: how far the real body is above where it stands
    this.sig = { pelvisY: 0, pelvisVy: 0, feetY: 0, medY: 0, meanY: 0, topY: 0, height: 0, base: 0 };
    this.grid = null; // part per cell (before the jump lift), see PeopleLayer
    this.bbox = [0, 0, -1, -1]; // c0, r0, c1, r1 (inclusive)
    this.cells = 0;
    this.headCell = null; // [col, row] of the top of the head (before the lift)
    this.air = false; // jumping (game physics)
    this.h = 0; // m above the ground (game physics)
    this.jump = null; // the running jump (startJump)
    this.instant = 1; // the instant lift (param `instant`), see updateLift
    this.headroom = 0.1; // m the head may rise beyond the wall's top (param `headroom`)
    this.headTop = null; // m above the ground: the top of the head (before the lift)
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
   * A jump: an arc, as high as the person jumped. A small hop (takeoff V_SMALL m/s or slower) goes
   * jumpHeight m up and lasts jumpTime s, a strong one (jumpStrong m/s) jumpHeightMax m; in between
   * by the takeoff speed `v` (the fastest rise of the body since the push-off). Rising it slows down,
   * falling it speeds up with the same gravity (jumpGravity). The game then stretches the jump over
   * the obstacle that comes (carry). In the air another hop starts again from where the figure is:
   * air jumps. lead: s of the jump that already passed when it was detected (only on the ground).
   */
  startJump(time, p, lead = 0, v = 0) {
    const strong = Math.max(V_SMALL + 0.1, p.jumpStrong);
    const s = Math.min(1, Math.max(0, (v - V_SMALL) / (strong - V_SMALL)));
    const H = p.jumpHeight + Math.max(0, p.jumpHeightMax - p.jumpHeight) * s;
    const g = jumpGravity(p);
    this.airJumps = this.air ? this.airJumps + 1 : 0;
    // takes off from where the figure is drawn now (the instant lift may have raised it already)
    const from = this.air ? this.h : Math.max(this.h, this.realRise * this.instant);
    this.jump = { t0: time - (this.air ? 0 : lead), from, apex: from + H, ta: Math.sqrt((2 * H) / g), g, carried: 0 };
    this.air = true;
    this.jumps++;
  }

  /**
   * Carries the running jump over an obstacle: the figure is at least `clear` m up from `a` to `b` s
   * from now (Game.carry: while the obstacle passes below). Planned again from where the figure is
   * now: the rise time that needs the lowest top (the top over the middle of the obstacle, rising in
   * TA_MIN-TA_MAX s), never lower than the hop itself. At most `p.assistMax` m above the obstacle; if
   * that is not enough (jumped much too early), it falls a little slower (G_MIN), and then it lands
   * on the obstacle after all.
   */
  carry(time, a, b, clear, p) {
    const j = this.jump;
    if (!j) return;
    const from = this.h;
    const g = j.g;
    const own = Math.max(j.apex, from); // the hop's own top
    let best = null;
    for (let ta = TA_MIN; ta <= TA_MAX + 1e-6; ta += 0.01) {
      if (a < TA_MIN && ta > TA_MIN) break; // the obstacle is close: up as fast as possible
      let apex = Math.max(own, clear + 0.02);
      if (b > ta) apex = Math.max(apex, clear + (g * (b - ta) ** 2) / 2); // still up when it has passed
      if (a > 0 && a < ta) {
        const u = a / ta; // already up when it comes
        apex = Math.max(apex, from + (clear - from) / (u * (2 - u)));
      }
      if (!best || apex < best.apex - 1e-4) best = { ta, apex };
    }
    const cap = Math.max(own, clear + p.assistMax);
    let gDown = g;
    if (best.apex > cap) {
      best.apex = cap;
      if (b > best.ta) gDown = Math.min(g, Math.max(g * G_MIN, (2 * (cap - clear)) / (b - best.ta) ** 2));
    }
    this.jump = { t0: time, from, apex: best.apex, ta: best.ta, g: gDown, carried: j.carried + 1 };
  }

  /** the jump's height at `time`: up (slowing down), down (speeding up), land; the head stays (about) on the wall */
  updateLift(time, dt, L) {
    if (this.air && this.jump) {
      const j = this.jump;
      // the ceiling: the head may rise `headroom` m beyond the wall's top edge (raised hands may go
      // further out; they used to be the ceiling, and a hop with the arms up stayed tiny)
      const wallTop = L.groundRow * L.cellMy;
      const head = this.headTop ?? (this.headCell ? (L.groundRow - this.headCell[1]) * L.cellMy : 1.2);
      const ceil = Math.max(0.1, wallTop + this.headroom - head + this.realRise);
      const t = time - j.t0;
      let h;
      if (t < j.ta) {
        const u = t / j.ta;
        h = j.from + (j.apex - j.from) * u * (2 - u);
      } else h = j.apex - (j.g * (t - j.ta) ** 2) / 2;
      if (t >= j.ta && h <= 0) {
        this.h = 0;
        this.air = false;
        this.jump = null;
        this.landed = time;
        this.justLanded = true;
      } else this.h = Math.min(h, Math.max(ceil, j.from));
    }
    // the figure rises with the real body already (its mask); `instant` lifts it more at once,
    // before the jump is detected; the jump only adds what is missing
    const lift = Math.max(0, Math.max(this.h, this.realRise * this.instant) - this.realRise);
    this.lift = lift;
    this.maxLift = Math.max(this.maxLift ?? 0, this.h); // for tests
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
    this.logMax = 30000; // 2-3 loops of a calibration recording, with short-lived ghost persons
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
      const play = f.grounded && q.dist >= p.playNear - m && q.dist <= p.playFar + m;
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
      this.seq = ctx.kinect.persons.seq; // the frame number (logged: aligns the log with a recording)
      this.rasterize(ctx, L, p);
      for (const f of this.figures.values()) if (f.visible && !f.fake && f.q) this.signals(f, f.q.person, wall, p, time);
    }

    const list = [];
    for (const f of this.figures.values()) {
      if (!f.visible || !f.grid || !f.grounded) continue;
      f.instant = p.instant;
      f.headroom = p.headroom;
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
    if (h > 0.5) f.standH = f.heights.add(h, time).stand;
    const standH = Math.min(2.2, Math.max(0.9, f.standH || h || 1.7));
    const kT = (p.sameSize ? p.figH / standH : p.figH / 1.75) * (f.player ? 1 : p.bgScale);
    f.k = f.k ? f.k + (kT - f.k) * 0.08 : kT;
  }

  /**
   * The jump detection, once per tracking result. Calibrated on two recordings of the user at home
   * (hops-2026-10-08: hops on cue, small, normal, high, several in a row; nohops-2026-10-08: squats,
   * ducking, tiptoes, arms, bobbing knees, steps, bending, crouching, standing up fast, walking),
   * replayed through this scene in live mode. Process and numbers: calibrate/README.md.
   *
   * Everything comes from the person's mask (every frame, exact, not smoothed, independent of the
   * pose model, whose skeleton gets rough when the GPU is busy):
   * 1. Push-off: the median height of the mask moves up fast enough near where it stands that the
   *    body would fly (height + v^2 / 2g above the standing level), and the mask's mean rises too.
   * 2. Confirmed within 0.35 s by the feet (lowest 3 % of the mask) leaving the floor by 2 cm, with
   *    the body 6 cm above its standing level. Every real hop lifts the feet (3-34 cm); ducking,
   *    squats, crouching and raised arms do not (at most 1-3 cm).
   * 3. The skeleton's raw pelvis may veto: when it stays below 3 cm above its standing level, it
   *    was the arms that lifted the mask.
   * Result: 31 of 34 hops with a free GPU (all 10 small ones), 29 of 33 with a busy one; 0.03-0.10 s
   * after the takeoff (median); 1.7-2.5 false jumps per 72 s of moves that are no hops.
   */
  signals(f, P, wall, p, time) {
    const m = wall.room.matrix;
    const s = f.sig;
    s.height = P.height ?? 0;
    const pel = P.room?.joints?.pelvis;
    const mv = P.motion?.pelvis;
    if (pel) {
      s.pelvisY = pel[1];
      s.pelvisVy = mv ? m[1] * mv[0] + m[5] * mv[1] + m[9] * mv[2] : 0;
    }
    // the raw pelvis in the room (the smoothed one lags 0.1-0.2 s)
    const raw = P.camera?.extra?.[1];
    s.rawY = 0;
    if (raw && raw[3] > 0) {
      const wx = (wall.xSign * raw[0]) / 1000;
      const wy = -raw[1] / 1000;
      const wz = raw[2] / 1000;
      s.rawY = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
    }
    // how fast the person moves over the floor (walking): the most of the last 0.3 s
    const vel = P.velocity;
    s.walk = vel ? Math.hypot(vel[0], vel[2]) : 0;
    const walks = (f.walks ??= []);
    walks.push([time, s.walk]);
    while (walks.length && time - walks[0][0] > 0.3) walks.shift();
    const walking = Math.max(...walks.map((w) => w[1]));

    const body = f.track.body.add(s.medY, time);
    const mean = f.track.mean.add(s.meanY, time);
    const feet = f.track.feet.add(s.feetY, time);
    const pelv = s.rawY ? f.track.pelvis.add(s.rawY, time) : null;
    let jumped = false;
    if (body) {
      s.base = body.stand;
      // the figure's own rise: the smaller of mask and pelvis (raised arms lift only the mask)
      f.realRise = Math.max(0, Math.min(body.rise, pelv ? pelv.rise : body.rise)) * f.k;
      const flies = body.rise > -p.jumpDip && body.rise + (body.v * body.v) / 19.62 > p.jumpRise;
      if (body.v > p.jumpVy && (!mean || mean.v > p.jumpVy2) && flies && walking < p.walkGate) {
        f.candV = time - f.candidate < 0.35 ? Math.max(f.candV, body.v) : body.v; // the takeoff speed
        f.candidate = time;
      }
      const feetUp = !feet || feet.rise > p.feetUp;
      const pelvisOk = !pelv || pelv.rise > p.pelvisMin;
      const can = f.player && f.alive !== false && f.armed && time - f.born > 1 && f.track.body.n >= 20;
      // every hop counts, also in the air (air jumps). One hop fires once: the next one needs the
      // body to have stopped rising first.
      if (can && time - f.candidate < 0.35 && feetUp && body.rise > p.minRise && pelvisOk) {
        f.startJump(time, p, p.jumpLead, Math.max(f.candV, body.v));
        f.armed = false;
        f.armedAt = time;
        f.candidate = -9;
        this.jumped.push(f);
        jumped = true;
      } else if (!f.armed && time - f.armedAt > p.jumpRest && (body.v < 0.05 || body.rise < p.jumpRise * 0.35)) f.armed = true;
    } else f.realRise = 0;
    if (this.log.length < this.logMax) {
      this.log.push([+time.toFixed(3), f.id, +s.pelvisY.toFixed(3), +s.pelvisVy.toFixed(3), +s.feetY.toFixed(3), +s.topY.toFixed(3), +s.height.toFixed(3), +(s.base ?? 0).toFixed(3), +(f.track.body.v ?? 0).toFixed(3), jumped ? 1 : 0, +(s.meanY ?? 0).toFixed(3), +(s.medY ?? 0).toFixed(3), +s.rawY.toFixed(3), +(s.p10 ?? 0).toFixed(3), +(s.p25 ?? 0).toFixed(3), +s.walk.toFixed(2), this.seq ?? -1]);
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
    const sumY = new Float64Array(SLOTS);
    const cntY = new Uint32Array(SLOTS);

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
      sumY[s] += ry;
      cntY[s]++;
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
      // percentiles of the height of all the person's pixels, interpolated inside the 1 cm bins
      const qs = [0.03, 0.1, 0.25, 0.5, 0.99];
      const at = qs.map(() => -1);
      let acc = 0;
      for (let b = 0; b < HIST_BINS; b++) {
        const c = hist[s * HIST_BINS + b];
        const before = acc;
        acc += c;
        for (let k = 0; k < qs.length; k++) if (at[k] < 0 && acc >= total * qs[k]) at[k] = b + (c ? (total * qs[k] - before) / c : 0.5);
      }
      f.sig.feetY = HIST_MIN + at[0] / 100;
      if (f.sig.feetY < GROUND_MAX) f.grounded = true;
      f.sig.p10 = HIST_MIN + at[1] / 100;
      f.sig.p25 = HIST_MIN + at[2] / 100;
      f.sig.medY = HIST_MIN + at[3] / 100;
      const hi = Math.floor(at[4]);
      f.sig.topY = HIST_MIN + hi / 100;
      f.sig.meanY = cntY[s] ? sumY[s] / cntY[s] : 0;
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
    // the top of the head (the skeleton's head, else the figure's top: then raised hands count)
    f.headTop = head ? head[1] + headR : count ? (L.groundRow - topRow) * L.cellMy : null;
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
    f.headTop = H;
  }
}
