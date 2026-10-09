// The people: their silhouettes on the wall (from the masks, exact every frame) and their blades.
//
// Silhouettes: every person pixel of the tracking result goes into the room and onto the wall as the
// wall core maps it (mirrored, the walk stretched over the wall, the body in real size), into a grid of
// art pixels. A cell is covered when enough of it is covered by the person (area in m², the same near
// the sensor and far away). Each cell then gets a piece of the ninja costume from the skeleton
// (ninja.js).
//
// Blades: the hands of the skeleton (ctx.wall.joint: on the wall, in meters). A hand cuts while it got
// far fast: its way over the last WIN s, faster than `cutSpeed`, with this update going the same way.
// That holds through an update in which the live skeleton stalls (it loses fast wrists now and then
// and catches up with the next pose), while a point that jumps out and back gets nowhere and never
// cuts. One that teleports (more than `maxJump` in one update, or faster than `maxSpeed`) starts a new
// blade. The cut is the swept segment between two updates, so a fast hand also cuts what lies between
// two tracking results; when a swipe starts, its way within the window cuts too.
//
// The hands are the raw points of the tracker (p.camera): the smoothed joints lag about 5 cm behind on
// fast arms, and the rule above does not mind a little jitter. With live + exact tracking (the hub,
// persons: { live: true }) the blades run on the live skeletons, and the exact skeletons of the same
// frames, 150-250 ms later, run blades of their own: a swipe that live missed still cuts then (see
// game.js lateCuts), against where the fruit was at that moment.

import { dress, skeletonOf, fakeSkeleton, FAKE_BODY } from './ninja.js';

const FOCAL = 366; // Kinect v2 depth camera, px: a pixel at z m covers (z / FOCAL)² m²
const HANDS = ['leftHand', 'rightHand'];
const WIN = 0.1; // s
export const RES = 2; // cells of the silhouettes per art pixel: 1.2 cm, as fine as the fruit
const EXTRA_HAND = { leftHand: 3, rightHand: 4 }; // index in p.camera.extra (neck, pelvis, head, leftHand, rightHand)

/** a hand of a person on the wall [x, y, z] (m), or null: raw (p.camera) or smoothed */
function hand(wall, person, h, P) {
  const c = person.camera?.extra?.[EXTRA_HAND[h]];
  if (P.rawHands && c) return c[3] >= P.minConf ? wall.fromCamera(c, person.slot) : null;
  const conf = person.confidence?.[h] ?? 1;
  return conf >= P.minConf ? wall.joint(person, h) : null;
}

export class Blade {
  constructor(key, id, slot, col, segKey = key) {
    this.key = key;
    this.segKey = segKey; // the key of its cuts (combos): the exact blade of a hand cuts as its live one
    this.id = id; // person id (null: the mouse, a demo)
    this.slot = slot;
    this.col = col;
    this.pts = []; // { x, y, t, v, cut } wall m, s, m/s
    this.x = null;
    this.y = null;
    this.t = 0;
    this.v = 0;
    this.cutting = false;
    this.seen = 0;
  }

  /**
   * A new position (wall m) at time t (s); pushes the segments that cut into `segs`. arrive: when it
   * is shown (exact blades: their frame is older, the woosh starts when it comes in).
   */
  sample(x, y, t, P, segs, arrive = t) {
    this.seen = t;
    if (this.x === null) {
      this.x = x;
      this.y = y;
      this.t = t;
      this.pts.push({ x, y, t, v: 0, cut: false, a: arrive });
      return;
    }
    const dt = t - this.t;
    if (dt <= 1e-4) return;
    const dx = x - this.x;
    const dy = y - this.y;
    const d = Math.hypot(dx, dy);
    if (dt > 0.3 || d > P.maxJump || d / dt > P.maxSpeed) {
      // lost for a while, or a jump of the skeleton: start over here
      this.x = x;
      this.y = y;
      this.t = t;
      this.v = 0;
      this.cutting = false;
      this.pts.length = 0;
      this.pts.push({ x, y, t, v: 0, cut: false, a: arrive });
      return;
    }
    // how far the hand got over the last WIN s: a swipe gets far, also when the skeleton stalls for
    // an update and then catches up; a point that jumps out and back gets nowhere
    const pts = this.pts;
    let r = 0;
    for (let k = pts.length - 1; k >= 0; k--) {
      if (t - pts[k].t >= WIN) {
        r = k;
        break;
      }
    }
    const ref = pts[r];
    const wx = x - ref.x;
    const wy = y - ref.y;
    const wd = Math.hypot(wx, wy);
    const vw = wd / Math.max(t - ref.t, WIN);
    const along = d > 1e-6 && wd > 1e-6 ? (dx * wx + dy * wy) / (d * wd) : 0;
    const was = this.cutting;
    this.cutting = (vw >= P.cutSpeed && along > 0.3) || (was && vw >= P.cutSpeed * 0.6 && along > -0.2);
    if (this.cutting && d > 0.005) {
      const seg = (a, b) => segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, t0: a.t, t1: b.t, v: vw, key: this.segKey, id: this.id, slot: this.slot });
      // the swipe began before this update: its path within the window cuts too
      if (!was) {
        for (let k = r + 1; k < pts.length; k++) {
          seg(pts[k - 1], pts[k]);
          pts[k].cut = true;
        }
      }
      seg(this, { x, y, t });
    }
    this.x = x;
    this.y = y;
    this.t = t;
    this.v = vw;
    pts.push({ x, y, t, v: vw, cut: this.cutting, a: arrive });
  }

  /** forget points older than `keep` s */
  trim(now, keep) {
    let n = 0;
    while (n < this.pts.length - 1 && now - this.pts[n].t > keep) n++;
    if (n) this.pts.splice(0, n);
  }
}

export class People {
  constructor() {
    this.AW = 0;
    this.AH = 0;
    this.blades = new Map();
    this.list = []; // the persons on the wall: { id, slot, col, x, headX, headY, sk (skeleton, wall m), hv (head velocity) }
    this.heads = new Map(); // id -> { x, y, t, vx, vy }: the head's velocity, for the headband
    this.segs = []; // the cutting segments of this frame
    this.lateSegs = []; // the cutting segments of the exact skeletons that came in this frame
    this.exactBlades = new Map();
    this.seqTime = new Map(); // live frame seq -> when it was shown (s): the time of an exact frame
    this.scripts = []; // scripted blades (demo, tests): { key, pts: [[x, y], ...], t0, dur, col }
    this.fake = []; // test players (headless tests): { id, slot, x, headY, hands: [[x, y] | null, [x, y] | null] }
    this.fakeExact = 0; // tests: > 0 feeds the test players' hands again after this many s, as exact skeletons
    this.fakeQueue = [];
    this.lastData = -1;
    this.fresh = false;
    this.ms = { build: 0, dress: 0 }; // per tracking result (smoothed), for tuning
  }

  resize(AW, AH) {
    this.AW = AW;
    this.AH = AH;
    const n = AW * AH;
    this.area = new Float32Array(n);
    this.front = new Uint16Array(n);
    this.cell = new Uint8Array(n); // slot of the front-most person, 0 = nobody
    this.part = new Uint8Array(n); // the piece of the costume (ninja.js PART)
    this.shade = new Uint8Array(n); // its shade (ninja.js SHADE)
    this.tmp = new Uint8Array(n);
    this.any = false;
  }

  /** a scripted blade along the points (wall m) over `dur` s (the demo in the attract mode, tests) */
  script(pts, dur, col = [1, 1, 1], key = `script${Math.random()}`) {
    this.scripts.push({ key, pts, t0: null, dur, col });
  }

  /**
   * ctx: the scene context, L: layout (art px), P: params, now: real time (s), colorOf(slot)
   */
  update(ctx, L, P, now, colorOf) {
    const wall = ctx.wall;
    const k = ctx.kinect;
    const segs = (this.segs = []);
    this.fresh = Boolean(ctx.persons.fresh && k.persons);
    if (this.fresh) {
      const t0 = performance.now();
      this.build(k.persons, k.rays, ctx.xSign, wall, L, P);
      this.ms.build += (performance.now() - t0 - this.ms.build) * 0.1;
      this.countCells();
      this.lastData = now;
      if (ctx.persons.seq !== null) {
        this.seqTime.set(ctx.persons.seq, now);
        if (this.seqTime.size > 240) this.seqTime.delete(this.seqTime.keys().next().value);
      }
    } else if (this.any && now - this.lastData > 0.5) {
      this.cell.fill(0);
      this.any = false;
    }

    // the persons, their skeletons and their hands
    const list = (this.list = []);
    const skels = new Map();
    for (const q of wall.persons) {
      if (!q.inZone) continue;
      const col = colorOf(q.slot);
      const head = q.person.head ? wall.fromWorld(q.person.head, q.slot) : [q.x, q.y + 0.6];
      const sk = skeletonOf(wall, q.person);
      skels.set(q.slot, sk);
      list.push({ id: q.id, slot: q.slot, col, x: q.x, headX: head[0], headY: head[1], sk, hv: this.headVel(q.id, sk.head ?? head, now) });
      // a track with a skeleton but no body on the wall (a ghost of the tracker) does not cut
      if (!this.fresh || !this.shown(q.slot)) continue;
      for (const h of HANDS) {
        const j = hand(wall, q.person, h, P);
        if (!j) continue;
        const key = `${q.id}:${h}`;
        let b = this.blades.get(key);
        if (!b) this.blades.set(key, (b = new Blade(key, q.id, q.slot, col)));
        b.slot = q.slot;
        b.col = col;
        b.sample(j[0], j[1], now, P, segs);
      }
    }

    // the exact skeletons (live + exact): blades of their own, at the time their frame was live
    const late = (this.lateSegs = []);
    if (ctx.persons.mode === 'both' && P.lateCuts) {
      // the frames of one burst come in together: they are shown one after the other, as a sweep
      let first = null;
      for (const ex of ctx.persons.exactUpdates ?? []) {
        const t = this.seqTime.get(ex.seq);
        if (t === undefined) continue;
        first ??= t;
        const arrive = now + (t - first) * 0.6;
        for (const p of ex) {
          for (const h of HANDS) {
            const j = hand(wall, p, h, P);
            if (!j) continue;
            const key = `exact:${p.id}:${h}`;
            let b = this.exactBlades.get(key);
            if (!b) this.exactBlades.set(key, (b = new Blade(key, p.id, p.slot, colorOf(p.slot), `${p.id}:${h}`)));
            b.slot = p.slot;
            if (t > b.t) b.sample(j[0], j[1], t, P, late, arrive);
          }
        }
      }
      for (const [key, b] of this.exactBlades) {
        b.trim(now, Math.max(2 * WIN, now - b.t + P.wooshLife));
        if (now - b.seen > 1.5) this.exactBlades.delete(key);
      }
    }

    // test players: a figure from a skeleton, the hands as the test moves them
    if (this.fake.length) {
      this.cell.fill(0);
      for (const f of this.fake) {
        const col = colorOf(f.slot);
        const headY = f.headY ?? 1.65;
        const sk = fakeSkeleton(f.x, headY, f.hands ?? []);
        skels.set(f.slot, sk);
        list.push({ id: f.id, slot: f.slot, col, x: f.x, headX: f.x, headY, sk, hv: this.headVel(f.id, sk.head, now) });
        for (const [a, b, r] of FAKE_BODY) this.stampBone(L, sk[a], sk[b], r, f.slot);
        this.stamp(L, f.x, headY, 0.1, 0.12, f.slot);
        f.hands?.forEach((h, k) => {
          if (!h) return;
          const key = `${f.id}:${k}`;
          let b = this.blades.get(key);
          if (!b) this.blades.set(key, (b = new Blade(key, f.id, f.slot, col)));
          b.sample(h[0], h[1], now, P, segs);
          if (this.fakeExact > 0) this.fakeQueue.push([now, key, f.id, f.slot, col, h[0], h[1]]);
        });
      }
      this.any = true;
      this.box = [0, 0, this.AW - 1, this.AH - 1];
      this.lastData = now;
      // the same hands once more, late, as if from the exact skeletons
      while (this.fakeQueue.length && now - this.fakeQueue[0][0] >= this.fakeExact) {
        const [t, key, id, slot, col, x, y] = this.fakeQueue.shift();
        let b = this.exactBlades.get(key);
        if (!b) this.exactBlades.set(key, (b = new Blade(`exact:${key}`, id, slot, col, key)));
        if (t > b.t) b.sample(x, y, t, P, late, now);
        b.trim(now, Math.max(2 * WIN, now - b.t + P.wooshLife));
      }
    }
    this.skels = skels;
    if (this.fake.length) this.countCells();
    if ((this.fresh || this.fake.length) && this.box) {
      const t0 = performance.now();
      dress(this.cell, this.part, this.shade, this.AW, this.box, skels, { ppm: L.ppm * RES, top: L.top });
      this.ms.dress += (performance.now() - t0 - this.ms.dress) * 0.1;
    }

    // the mouse (testing without people): a blade while the button is held
    const wp = wall.pointer;
    if (wp.down && wp.inside) {
      let b = this.blades.get('mouse');
      if (!b) this.blades.set('mouse', (b = new Blade('mouse', null, 0, [1, 1, 1])));
      b.sample(wp.x, wp.y, now, P, segs);
    }

    // scripted blades
    for (let i = this.scripts.length - 1; i >= 0; i--) {
      const s = this.scripts[i];
      if (s.t0 === null) s.t0 = now;
      const u = Math.min(1, (now - s.t0) / s.dur);
      const f = u * (s.pts.length - 1);
      const a = s.pts[Math.min(s.pts.length - 2, Math.floor(f))];
      const c = s.pts[Math.min(s.pts.length - 1, Math.floor(f) + 1)];
      const w = f - Math.min(s.pts.length - 2, Math.floor(f));
      let b = this.blades.get(s.key);
      if (!b) this.blades.set(s.key, (b = new Blade(s.key, null, 0, s.col)));
      b.sample(a[0] + (c[0] - a[0]) * w, a[1] + (c[1] - a[1]) * w, now, P, segs);
      if (u >= 1) this.scripts.splice(i, 1);
    }

    for (const [key, b] of this.blades) {
      b.trim(now, Math.max(P.trail, 2 * WIN));
      if (now - b.seen > 0.6) this.blades.delete(key);
    }
  }

  /** how many cells each slot covers (a track with a skeleton but no body on the wall shows nothing) */
  countCells() {
    const count = (this.count ??= new Uint32Array(256));
    count.fill(0);
    if (!this.box || !this.any) return;
    const [x0, y0, x1, y1] = this.box;
    for (let y = y0; y <= y1; y++) for (let c = y * this.AW + x0; c <= y * this.AW + x1; c++) count[this.cell[c]]++;
  }

  /** whether the person of `slot` has a body on the wall */
  shown(slot) {
    return (this.count?.[slot] ?? 0) >= 150;
  }

  /** the head's velocity (smoothed, m/s) of person `id` */
  headVel(id, head, now) {
    let h = this.heads.get(id);
    if (!h) this.heads.set(id, (h = { x: head[0], y: head[1], t: now, vx: 0, vy: 0 }));
    const dt = now - h.t;
    if (dt > 1e-3) {
      const k = 1 - Math.exp(-dt / 0.15);
      h.vx += ((head[0] - h.x) / dt - h.vx) * k;
      h.vy += ((head[1] - h.y) / dt - h.vy) * k;
      if (dt > 0.5) h.vx = h.vy = 0;
      h.x = head[0];
      h.y = head[1];
      h.t = now;
    }
    if (this.heads.size > 64) this.heads.delete(this.heads.keys().next().value);
    return [h.vx, h.vy];
  }

  /** a bone of a test figure: a capsule of cells */
  stampBone(L, a, b, r, slot) {
    if (!a || !b) return;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (r * 0.5)));
    for (let k = 0; k <= n; k++) this.stamp(L, a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, r, r, slot);
  }

  /** an ellipse of cells (wall m) for the test players */
  stamp(L, x, y, rx, ry, slot) {
    const ppm = L.ppm * RES;
    const cx = x * ppm;
    const cy = (L.top - y) * ppm;
    for (let j = Math.floor(cy - ry * ppm); j <= cy + ry * ppm; j++) {
      for (let i = Math.floor(cx - rx * ppm); i <= cx + rx * ppm; i++) {
        if (i < 0 || j < 0 || i >= this.AW || j >= this.AH) continue;
        if (((i + 0.5 - cx) / (rx * ppm)) ** 2 + ((j + 0.5 - cy) / (ry * ppm)) ** 2 <= 1) this.cell[j * this.AW + i] = slot;
      }
    }
  }

  /** the masks -> the cells of the wall (art px) */
  build(persons, rays, xSign, wall, L, P) {
    const { AW, AH, area, front, cell, tmp } = this;
    area.fill(0);
    front.fill(0xffff);
    cell.fill(0);
    const S = wall.setup;
    const m = wall.room.matrix;
    const perPerson = wall.projection.apply === 'person';
    const top = S.bottom + S.size.h;
    const { near, far } = wall.zone; // the projection's zone, room z (m from the sensor)
    const ppm = L.ppm * RES;
    const { indices, labels, depth } = persons;
    // only the box around the people is worked on afterwards
    let bx0 = AW;
    let by0 = AH;
    let bx1 = -1;
    let by1 = -1;
    for (let n = 0; n < indices.length; n++) {
      const i = indices[n];
      const mm = depth[i];
      if (mm < 100) continue;
      const z = mm * 0.001;
      const wx = xSign * rays[2 * i] * z;
      const wy = -rays[2 * i + 1] * z;
      const rz = m[2] * wx + m[6] * wy + m[10] * z + m[14];
      if (rz < near || rz > far) continue;
      const rx = m[0] * wx + m[4] * wy + m[8] * z + m[12];
      const ry = m[1] * wx + m[5] * wy + m[9] * z + m[13];
      const s = labels[i];
      // the scene's projection: the body around the person's place (its size × scale), or every point
      const ax = Math.floor(wall.roomX(rx, rz, s) * ppm);
      const ay = Math.floor((top - wall.roomY(ry, s)) * ppm);
      if (ax < 0 || ax >= AW || ay < 0 || ay >= AH) continue;
      const c = ay * AW + ax;
      const f = (z / FOCAL) * (perPerson && wall.visible[s] ? wall.scale[s] : 1);
      area[c] += f * f;
      if (ax < bx0) bx0 = ax;
      if (ax > bx1) bx1 = ax;
      if (ay < by0) by0 = ay;
      if (ay > by1) by1 = ay;
      if (mm < front[c]) {
        front[c] = mm;
        tmp[c] = s;
      }
    }
    const need = P.cover / (ppm * ppm);
    let any = false;
    this.box = null;
    if (bx1 < 0) {
      this.any = false;
      return;
    }
    bx0 = Math.max(1, bx0 - 1);
    by0 = Math.max(1, by0 - 1);
    bx1 = Math.min(AW - 2, bx1 + 1);
    by1 = Math.min(AH - 2, by1 + 1);
    this.box = [bx0 - 1, by0 - 1, bx1 + 1, by1 + 1];
    for (let y = by0 - 1; y <= by1 + 1; y++) {
      for (let c = y * AW + bx0 - 1; c <= y * AW + bx1 + 1; c++) {
        if (area[c] >= need) {
          cell[c] = tmp[c];
          any = true;
        }
      }
    }
    // close single holes, drop single specks
    tmp.set(cell);
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const c = y * AW + x;
        let n = 0;
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const v = tmp[c + dy * AW + dx];
            if ((dx || dy) && v) {
              n++;
              s = v;
            }
          }
        }
        if (!tmp[c] && n >= 6) cell[c] = s;
        else if (tmp[c] && n <= 1) cell[c] = 0;
      }
    }
    tmp.fill(0);
    this.any = any;
  }
}
