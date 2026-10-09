// The bodies seen from above, from the person masks: every person pixel of the Kinect (its measured
// depth, every frame, live) goes into the room and onto the map. Nothing here uses the skeleton's
// hands: in live mode their depth is guessed and jumps around. The masks are exact.
//
// Per person:
//   center   the torso (mean of the points between hip and chest height, outliers dropped)
//   arms     up to two arms that stick out of the body: points above 55 % of the body height, more
//            than rMin from the torso, collected in an angle histogram seen from above; a peak with
//            enough points is an arm, its direction the mean angle, its reach the 90th percentile.
//            Followed from frame to frame (smoothed, on after 2 frames, off after 4).
//            The hidden arm (param mirrorArm): one arm stretched out along the shoulders, the other
//            not seen, and the body turned so far (50°+) that the body hides it from the sensor (it
//            would point away from the wall): it is stretched out to the other side too (virtual).
//   skeleton the skeleton as the game reads it (fused()): with persons: { live: true } every joint is
//            the live one, moved towards the exact one the slower it moves (slow = exact, brought to
//            now; fast = live, the exact one is 100-250 ms old). The turn and, with armSource
//            'Skelett', the arms come from it: an arm counts when its hand is above half the body
//            height and more than armMin from the torso (on after 2 results, off after 4); its
//            direction from the shoulder to the hand, seen from above.
//   head     the top of the body seen from above (the points within 22 cm of the highest), smoothed
//   hands    the outermost points to the left and right at hand height (2.5 cm bins with enough
//            points, so single stray pixels do not count), or the tip of an arm; smoothed
//   face     the turn of the body seen from above (rad on the map), from the skeleton's shoulders
//            (turn() below), smoothed and in steps of 360° / TURNS
//   stomp    a jump, at the push-off (the same detection as the scene pixel-jump-run): the median
//            height of the whole mask and the raw pelvis of the skeleton both rise fast enough, and
//            the body would fly at least `jumpRise` above where it stands (height + v² / 2g); not
//            while walking. Raised arms lift the mask but not the pelvis, so they never count.
// The map grid (art px): per cell the slot of the highest point, whether it is an arm, its height.
// Everything shown and hit is drawn `bodyScale` times smaller around the torso (the units should not
// cover the map); the analysis itself works in real meters.

const BINS = 36;
const RB = 28; // reach histogram: 5 cm steps up to 1.4 m
const RSTEP = 0.05;
import { ARM, TURNS, facing } from './pixels.js';

const SLOTS = 17;
const TAU = Math.PI * 2;
const HB = 96; // hand bins: 2.5 cm from -1.2 to 1.2 m beside the torso
const YMIN = -0.5; // height histogram per person: 1 cm bins
const YB = 300;

/** a ring of the last n values; stand(): the standing level, the highest 1 s median, sinking slowly */
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
    const s = Array.from(this.v.subarray(0, this.n)).sort((a, b) => a - b);
    return s[Math.floor(this.n / 2)] ?? 0;
  }
  stand(x, time, decay = 0.003) {
    this.push(x);
    const m = this.median();
    const dt = this.last === undefined ? 0 : Math.max(0, time - this.last);
    this.last = time;
    this.level = this.level === undefined || m > this.level ? m : this.level - decay * dt;
    return this.level;
  }
}

/** one height signal: its standing level, the rise above it, its velocity (lightly smoothed) */
class Signal {
  constructor() {
    this.ring = new Ring(30);
    this.v = 0;
    this.y = null;
    this.t = 0;
  }
  add(y, time) {
    const dt = time - this.t;
    this.v = this.y !== null && dt > 1e-3 && dt < 0.3 ? 0.4 * this.v + 0.6 * ((y - this.y) / dt) : 0;
    this.y = y;
    this.t = time;
    const stand = this.ring.stand(y, time);
    return { stand, rise: y - stand, v: this.v, n: this.ring.n };
  }
}
const HSTEP = 0.025;

export class Bodies {
  constructor() {
    this.cache = new Float32Array(512 * 424 * 4);
    this.state = new Map(); // per person id
    this.persons = [];
    this.w = 0;
    this.h = 0;
    this.hist = new Float32Array(SLOTS * BINS);
    this.rhist = new Uint16Array(SLOTS * BINS * RB);
    this.hcount = new Uint16Array(SLOTS * HB);
    this.hz = new Float32Array(SLOTS * HB);
    this.yhist = new Uint16Array(SLOTS * YB);
    this.ycount = new Uint32Array(SLOTS);
    this.lastResult = -1;
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.slot = new Uint8Array(w * h);
    this.kind = new Uint8Array(w * h); // 1 body, 2 arm
    this.height = new Uint8Array(w * h); // cm
  }

  clear() {
    this.slot?.fill(0);
    this.kind?.fill(0);
    this.height?.fill(0);
  }

  slotAt(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.slot[y * this.w + x];
  }

  kindAt(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.kind[y * this.w + x];
  }

  /** the top-down figure of a person into the grid: shoulders and head (body), stretched-out arms */
  stampFigure(p, L, P) {
    const [cx, cy] = p.center;
    const rx = 6.5; // the figure sprite (pixels.js PERSON): 26 x 13 half px = 13 x 6.5 art px
    const ry = 3.3;
    const { f, r } = facing(p.face);
    for (let y = -rx; y <= rx; y++) {
      for (let x = -rx; x <= rx; x++) {
        const u = x * r[0] + y * r[1];
        const v = x * f[0] + y * f[1];
        if ((u / rx) ** 2 + (v / ry) ** 2 <= 1) this.stamp(cx + x, cy + y, p.slot, 1, 150);
      }
    }
    for (const a of p.arms) {
      const [sx, sy] = a.from;
      const n = Math.ceil(Math.hypot(a.tip[0] - sx, a.tip[1] - sy));
      for (let i = 0; i <= n; i++) {
        const x = sx + ((a.tip[0] - sx) * i) / Math.max(1, n);
        const y = sy + ((a.tip[1] - sy) * i) / Math.max(1, n);
        this.stamp(x, y, p.slot, 2, 140);
        this.stamp(x, y + 1, p.slot, 2, 140);
      }
    }
  }

  /** a cell of a test player or the mouse */
  stamp(x, y, slot, kind, cm) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const c = y * this.w + x;
    if (cm < this.height[c]) return;
    this.slot[c] = slot;
    this.kind[c] = kind;
    this.height[c] = cm;
  }

  /**
   * One person tracking result -> the grid and this.persons. L: the map (main.js), P: the params,
   * time: game time (s). Keeps the last result between Kinect frames.
   */
  update(ctx, L, P, time) {
    const k = ctx.kinect;
    const R = k.persons;
    const wall = ctx.wall;
    if (!R || !k.rays) {
      this.persons = [];
      this.clear();
      return;
    }
    if (!ctx.persons.fresh && this.lastResult === R.seq) {
      for (const p of this.persons) p.stomp = false;
      return;
    }
    this.lastResult = R.seq;
    this.clear();

    const S = wall.setup;
    const m = wall.room.matrix;
    const side = wall.side;
    const xSign = ctx.xSign;
    const perPerson = S.map.apply === 'person';
    const cx0 = S.size.w / 2 + S.sensor.x;
    const { near, far } = S.zone;
    const rays = k.rays;
    const { indices, labels, depth } = R;

    // live + exact (persons: { live: true }): the newest exact skeletons and the live ones of that same
    // frame, to see what live got wrong then (fused())
    const view = ctx.persons;
    const exact = view.mode === 'both' ? view.exact : null;
    const liveThen = exact ? view.liveAt?.(exact.seq) : null;
    this.exactShare = 0;

    // who is who: the visible persons in the zone, by slot
    const info = new Array(SLOTS).fill(null);
    for (const q of wall.persons) {
      if (!q.inZone || q.slot < 1 || q.slot >= SLOTS) continue;
      let st = this.state.get(q.id);
      if (!st) {
        st = { H: q.person.height > 0.8 ? q.person.height : 1.7, body: new Signal(), pelvis: new Signal(), armed: true, armedAt: 0, born: time, walks: [], stompAt: -9, arms: [], seen: time, face: L.wallFace, faceQ: null, faceAt: time };
        this.state.set(q.id, st);
      }
      st.seen = time;
      info[q.slot] = { q, st, n: 0, sx: 0, sz: 0, top: 0, cx: q.x, cz: q.z, hx: 0, hzs: 0, hn: 0 };
    }

    // pass 1: every person pixel into the room and onto the wall's x; the torso band per slot
    const cache = this.cache;
    let n = 0;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j];
      const s = labels[i];
      const inf = info[s];
      if (!inf) continue;
      const mm = depth[i];
      if (mm < 100) continue;
      const z = mm * 0.001;
      const wx = xSign * rays[2 * i] * z;
      const wy = -rays[2 * i + 1] * z;
      const rz = m[2] * wx + m[6] * wy + m[10] * z + m[14];
      if (rz < near - 0.3 || rz > far + 0.3) continue;
      const rx = m[0] * wx + m[4] * wy + m[8] * z + m[12];
      const ry = m[1] * wx + m[5] * wy + m[9] * z + m[13];
      const lat = side * rx;
      const x = perPerson && wall.visible[s] ? cx0 + lat + wall.shift[s] : cx0 + lat * wall.k(lat, rz);
      const zw = S.sensor.front + rz;
      const o = n * 4;
      cache[o] = x;
      cache[o + 1] = ry;
      cache[o + 2] = zw;
      cache[o + 3] = s;
      n++;
      const H = inf.st.H;
      if (ry > 0.35 * H && ry < 0.68 * H) {
        inf.n++;
        inf.sx += x;
        inf.sz += zw;
      }
    }
    // the torso: mean of the band, then again without what lies more than 35 cm from it
    for (const inf of info) {
      if (!inf || inf.n < 20) continue;
      inf.cx = inf.sx / inf.n;
      inf.cz = inf.sz / inf.n;
      inf.n2 = 0;
      inf.sx = 0;
      inf.sz = 0;
    }
    for (let j = 0; j < n; j++) {
      const o = j * 4;
      const inf = info[cache[o + 3]];
      if (!inf || inf.n < 20) continue;
      const H = inf.st.H;
      const ry = cache[o + 1];
      if (ry <= 0.35 * H || ry >= 0.68 * H) continue;
      const dx = cache[o] - inf.cx;
      const dz = cache[o + 2] - inf.cz;
      if (dx * dx + dz * dz > 0.35 * 0.35) continue;
      inf.n2++;
      inf.sx += cache[o];
      inf.sz += cache[o + 2];
    }
    for (const inf of info) {
      if (!inf || !(inf.n2 >= 10)) continue;
      inf.cx = inf.sx / inf.n2;
      inf.cz = inf.sz / inf.n2;
    }

    // pass 2: arms (angle histogram), head height, jump signal, the map grid
    const hist = this.hist;
    const rhist = this.rhist;
    hist.fill(0);
    rhist.fill(0);
    const { hcount, hz, yhist, ycount } = this;
    hcount.fill(0);
    hz.fill(0);
    yhist.fill(0);
    ycount.fill(0);
    const rMin = P.armMin;
    const ks = P.bodyScale;
    const { sx, sy, up, zTop, zBot } = L;
    const W = this.w;
    const Hh = this.h;
    for (let j = 0; j < n; j++) {
      const o = j * 4;
      const s = cache[o + 3];
      const inf = info[s];
      if (!inf) continue;
      const x = cache[o];
      const ry = cache[o + 1];
      const zw = cache[o + 2];
      const H = inf.st.H;
      const dx = x - inf.cx;
      const dz = zw - inf.cz; // + = farther from the wall
      const r = Math.hypot(dx, dz);
      if (r < 0.35 && ry > H - 0.22) {
        inf.hx += x;
        inf.hzs += zw;
        inf.hn++;
      }
      if (r > 0.18 && ry > 0.3 * H && ry < H + 0.45) {
        const hb = Math.floor((dx + 1.2) / HSTEP);
        if (hb >= 0 && hb < HB) {
          hcount[s * HB + hb]++;
          hz[s * HB + hb] += zw;
        }
      }
      if (r < 0.3 && ry > inf.top) inf.top = ry;
      const yb = Math.floor((ry - YMIN) * 100);
      if (yb >= 0 && yb < YB) {
        yhist[s * YB + yb]++;
        ycount[s]++;
      }
      // an arm: high enough, away from the torso, not behind it (the sensor cannot see behind a
      // body: points there are mixed pixels at the edges)
      const arm = ry > 0.55 * H && ry < H + 0.45 && r > rMin && dz < 0.25;
      if (arm) {
        const a = Math.atan2(dz, dx);
        const b = Math.floor(((a + Math.PI) / TAU) * BINS) % BINS;
        hist[s * BINS + b]++;
        rhist[(s * BINS + b) * RB + Math.min(RB - 1, Math.floor(r / RSTEP))]++;
      }
      // the grid: the highest point per cell
      const xs = inf.cx + dx * ks;
      const zs = inf.cz + dz * ks;
      const gx = Math.floor(xs * sx);
      const gy = Math.floor(up ? (zs - zTop) * sy : (zBot - zs) * sy);
      if (gx < 0 || gy < 0 || gx >= W || gy >= Hh) continue;
      const c = gy * W + gx;
      const cm = Math.max(1, Math.min(255, Math.round(ry * 100)));
      if (cm >= this.height[c]) {
        this.height[c] = cm;
        this.slot[c] = s;
        this.kind[c] = arm ? 2 : 1;
      }
    }

    // per person: arms, stomps
    const out = [];
    for (let s = 1; s < SLOTS; s++) {
      const inf = info[s];
      if (!inf) continue;
      const { q, st } = inf;
      // standing height: follows the head slowly, ignores hands above it
      if (inf.top > 0.8 && Math.abs(inf.top - st.H) < 0.25) st.H += (inf.top - st.H) * 0.05;
      const dist = Math.max(0.5, q.dist);
      const minPts = Math.min(150, Math.max(25, 300 / (dist * dist)));
      const found = peaks(hist, rhist, s, minPts, rMin + 0.12);
      trackArms(st, found);
      // a jump at the push-off (see the top of this file)
      let stomp = false;
      if (ycount[s] > 100) {
        let acc = 0;
        let med = 0;
        for (let b = 0; b < YB; b++) {
          acc += yhist[s * YB + b];
          if (acc >= ycount[s] / 2) {
            med = YMIN + (b + 0.5) / 100;
            break;
          }
        }
        const body = st.body.add(med, time);
        // the raw pelvis (not the smoothed one, which lags)
        const raw = q.person.camera?.extra?.[1];
        let pelv = null;
        if (raw && raw[3] > 0) {
          const wx = (ctx.xSign * raw[0]) / 1000;
          const wy = -raw[1] / 1000;
          const wz = raw[2] / 1000;
          pelv = st.pelvis.add(m[1] * wx + m[5] * wy + m[9] * wz + m[13], time);
        }
        // walking: the fastest of the last 0.3 s over the floor
        const vel = q.person.velocity;
        st.walks.push([time, vel ? Math.hypot(vel[0], vel[2]) : 0]);
        while (st.walks.length && time - st.walks[0][0] > 0.3) st.walks.shift();
        const walking = Math.max(0, ...st.walks.map((w) => w[1]));
        const flies = body.rise > -P.jumpDip && body.rise + (body.v * body.v) / 19.62 > P.jumpRise;
        const pelvisUp = !pelv || pelv.v > P.jumpVy2;
        if (st.armed && time - st.born > 1 && body.n >= 20 && body.v > P.jumpVy && pelvisUp && flies && walking < P.walkGate) {
          st.armed = false;
          st.armedAt = time;
          if (time - st.stompAt > 0.4) {
            stomp = true;
            st.stompAt = time;
          }
        } else if (!st.armed && time - st.armedAt > 0.15 && (body.v < 0.05 || body.rise < P.jumpRise * 0.35)) st.armed = true;
      }
      const center = L.map(inf.cx, inf.cz);
      const sk = fused(q.person, exact, liveThen, P);
      this.exactShare = Math.max(this.exactShare, sk.exactShare ?? 0);
      const face = P.turn ? turn(st, sk, m, side, L, time) : L.wallFace;
      const { r: across } = facing(face);
      const shrink = (m) => (m ? L.map(inf.cx + (m[0] - inf.cx) * ks, inf.cz + (m[1] - inf.cz) * ks) : null);
      // head and hands seen from above, smoothed (they are only shown, nothing is aimed with them)
      const ema = (old, v, a) => (old && v ? [old[0] + (v[0] - old[0]) * a, old[1] + (v[1] - old[1]) * a] : v);
      st.head = ema(st.head, inf.hn > 8 ? [inf.hx / inf.hn, inf.hzs / inf.hn] : null, 0.6);
      const handMin = Math.max(3, 30 / (dist * dist));
      const hand = (from, step, sign) => {
        for (let b = from; b >= 0 && b < HB; b += step) {
          const c = hcount[s * HB + b];
          if (c < handMin) continue;
          const dx = (b + 0.5) * HSTEP - 1.2;
          return sign * dx > 0.15 ? [inf.cx + dx, hz[s * HB + b] / c] : null;
        }
        return null;
      };
      const hl = hand(0, 1, -1);
      const hr = hand(HB - 1, -1, 1);
      st.hands = [ema(st.hands?.[0], hl, 0.5), ema(st.hands?.[1], hr, 0.5)];
      // a skeleton point -> wall x, height, z (as the mask pixels above)
      const toWall = (w) => {
        const rx = m[0] * w[0] + m[4] * w[1] + m[8] * w[2] + m[12];
        const ry = m[1] * w[0] + m[5] * w[1] + m[9] * w[2] + m[13];
        const rz = m[2] * w[0] + m[6] * w[1] + m[10] * w[2] + m[14];
        const lat = side * rx;
        return [perPerson && wall.visible[s] ? cx0 + lat + wall.shift[s] : cx0 + lat * wall.k(lat, rz), ry, S.sensor.front + rz];
      };
      const seen = P.armSource === 'Maske' ? st.arms.filter((a) => a.on) : skeletonArms(st, sk, toWall, inf, P);
      const arms = [...seen, ...hiddenArm(seen, st, P, time)]
        .map((a) => {
          const dx = Math.cos(a.ang) * sx;
          const dy = Math.sin(a.ang) * sy * (up ? 1 : -1);
          const d = Math.hypot(dx, dy) || 1;
          const dir = [dx / d, dy / d];
          // drawn as figures: the arm in the figure's proportions (from the shoulder, longer the
          // more it is stretched); as silhouettes: where it really is (scaled like the body)
          let tip;
          let from = center;
          if (P.look !== 'Silhouette') {
            // the shoulder on the arm's side of the turned figure (kept while the arm is up)
            const d = dir[0] * across[0] + dir[1] * across[1];
            if (!a.side || (Math.abs(d) > 0.35 && Math.sign(d) !== a.side)) a.side = d < 0 ? -1 : 1;
            from = [center[0] + a.side * ARM.shoulder * across[0], center[1] + a.side * ARM.shoulder * across[1]];
            const reach = ARM.reach * Math.min(1, Math.max(0.35, (a.len - 0.3) / 0.4));
            tip = [from[0] + dir[0] * reach, from[1] + dir[1] * reach];
          } else tip = L.map(inf.cx + Math.cos(a.ang) * a.len * ks, inf.cz + Math.sin(a.ang) * a.len * ks);
          return { id: a.id, tip, dir, len: a.len, from, virtual: !!a.virtual };
        });
      // an arm that points: its hand is at the tip
      const hands = st.hands.map(shrink);
      for (const a of arms) hands[a.dir[0] < 0 ? 0 : 1] = a.tip;
      out.push({ id: q.id, slot: s, q, center, cz: inf.cz, H: st.H, arms, stomp, head: shrink(st.head), hands, face, exactShare: sk.exactShare ?? 0 });
    }
    for (const [id, st] of this.state) if (time - st.seen > 3) this.state.delete(id);
    this.persons = out;
    // drawn as top-down figures (main.js, draw.js): what can be hit is the figure, not the mask
    if (P.look !== 'Silhouette') {
      this.clear();
      for (const p of out) this.stampFigure(p, L, P);
    }
  }
}

/**
 * The turn of a body seen from above (rad on the map), from the skeleton: the line from the left to
 * the right shoulder on the floor (wall x, z). Facing the wall, it points to the audience's right; the
 * body faces 90° to its left. (Offline on the multi recordings: 6° median error for people walking
 * towards the sensor.) A shoulder line shorter than 8 cm (seen exactly from the side) or longer than
 * 60 cm (a depth outlier) keeps the last turn. The face settles front or back if the pose mixed up
 * left and right: a visible face looks towards the sensor, a back without a face away from it.
 * Smoothed, then held in steps of 360° / TURNS until it is almost a step away (no flicker).
 */
function turn(st, person, m, side, L, time) {
  const J = person.joints;
  const C = person.confidence;
  const dt = Math.min(0.5, Math.max(0, time - st.faceAt));
  st.faceAt = time;
  const ls = J?.leftShoulder;
  const rs = J?.rightShoulder;
  if (ls && rs && C.leftShoulder > 0.3 && C.rightShoulder > 0.3) {
    const toWall = (w) => [side * (m[0] * w[0] + m[4] * w[1] + m[8] * w[2] + m[12]), m[2] * w[0] + m[6] * w[1] + m[10] * w[2] + m[14]];
    const l = toWall(ls);
    const r = toWall(rs);
    let a = r[0] - l[0];
    let b = r[1] - l[1];
    const len = Math.hypot(a, b);
    const eyes = Math.max(C.leftEye ?? 0, C.rightEye ?? 0);
    const face = (C.nose ?? 0) > 0.5 && eyes > 0.5;
    const back = (C.nose ?? 0) < 0.2 && eyes < 0.2 && Math.min(C.leftShoulder, C.rightShoulder) > 0.5;
    if ((face && a < -0.1) || (back && a > 0.1)) {
      a = -a;
      b = -b;
    }
    if (len > 0.08 && len < 0.6) {
      // the line to the right shoulder (wall x, z), smoothed: the hidden arm needs it
      const k = 1 - Math.exp(-dt / 0.2);
      const rn = [a / len, b / len];
      st.right = st.right ? [st.right[0] + (rn[0] - st.right[0]) * k, st.right[1] + (rn[1] - st.right[1]) * k] : rn;
      const n = Math.hypot(st.right[0], st.right[1]) || 1;
      st.right = [st.right[0] / n, st.right[1] / n];
      st.rightAt = time;
      // facing: the shoulder line turned by -90° seen from above (wall x to the right, z away from
      // it), at its real angle (the map is wider than deep: scaled, small turns would look bigger)
      const phi = Math.atan2((L.up ? 1 : -1) * -a, b);
      st.face = wrap(st.face + wrap(phi - st.face) * (1 - Math.exp(-dt / 0.25)));
    }
  }
  const step = TAU / TURNS;
  if (st.faceQ === null || Math.abs(wrap(st.face - st.faceQ * step)) > 0.9 * step) st.faceQ = Math.round(st.face / step);
  return wrap(st.faceQ * step);
}

/** up to two arms in the angle histogram of slot s: [{ ang, len, n }] */
function peaks(hist, rhist, s, minPts, minLen) {
  const o = s * BINS;
  const sm = new Float32Array(BINS);
  for (let b = 0; b < BINS; b++) sm[b] = hist[o + ((b + BINS - 1) % BINS)] + 2 * hist[o + b] + hist[o + ((b + 1) % BINS)];
  const cands = [];
  for (let b = 0; b < BINS; b++) {
    const v = sm[b];
    if (v < minPts * 2 || v < sm[(b + BINS - 1) % BINS] || v < sm[(b + 1) % BINS]) continue;
    cands.push(b);
  }
  cands.sort((a, b) => sm[b] - sm[a]);
  const res = [];
  for (const b of cands) {
    if (res.length >= 2) break;
    if (res.some((r) => Math.abs(angDiff(r.bin, b) * (TAU / BINS)) < 0.9)) continue;
    // mean angle and the 90th percentile of the reach over the peak and its neighbours
    let cs = 0;
    let sn = 0;
    let cnt = 0;
    const rh = new Uint32Array(RB);
    for (let d = -1; d <= 1; d++) {
      const bb = (b + d + BINS) % BINS;
      const c = hist[o + bb];
      const a = ((bb + 0.5) / BINS) * TAU - Math.PI;
      cs += Math.cos(a) * c;
      sn += Math.sin(a) * c;
      cnt += c;
      for (let r = 0; r < RB; r++) rh[r] += rhist[(o + bb) * RB + r];
    }
    let acc = 0;
    let len = 0;
    for (let r = 0; r < RB; r++) {
      acc += rh[r];
      if (acc >= 0.9 * cnt) {
        len = (r + 1) * RSTEP;
        break;
      }
    }
    if (len < minLen) continue;
    res.push({ bin: b, ang: Math.atan2(sn, cs), len, n: cnt });
  }
  return res;
}

function angDiff(a, b) {
  let d = a - b;
  while (d > BINS / 2) d -= BINS;
  while (d < -BINS / 2) d += BINS;
  return d;
}

function wrap(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

const SKELETON = ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHand', 'rightHand'];
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / Math.max(1e-6, b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The skeleton as the game reads it: { joints, confidence, exactShare }. Per joint of SKELETON the
 * live point, moved by what live got wrong in the newest exact frame (exact minus live of that frame),
 * fully below `exactBelow` m/s, not at all above `liveAbove`: slow = exact (brought to now), fast =
 * live. Without exact data (or exactSlow off): the live person. exactShare: the part of the joints
 * taken from exact (0..1).
 */
function fused(p, exact, liveThen, P) {
  const e = P.exactSlow && exact ? exact.byId(p.id) : null;
  if (!e) return p;
  const l = liveThen?.byId(p.id);
  const joints = { ...p.joints };
  const confidence = { ...p.confidence };
  let share = 0;
  for (const name of SKELETON) {
    const now = p.joints[name];
    const ex = e.joints[name];
    if (!now || !ex) continue;
    const v = p.motion?.[name] ? Math.hypot(...p.motion[name]) : 0;
    const w = 1 - smoothstep(P.exactBelow, P.liveAbove, v);
    share += w / SKELETON.length;
    if (w <= 0) continue;
    const then = l?.joints[name];
    joints[name] = then ? now.map((x, i) => x + w * (ex[i] - then[i])) : now.map((x, i) => x + w * (ex[i] - x));
    if (w > 0.5) confidence[name] = e.confidence[name] ?? confidence[name];
  }
  return { joints, confidence, exactShare: share };
}

/**
 * The arms from the skeleton (armSource 'Skelett'): per side the hand (or the wrist) above half the
 * body height and more than armMin from the torso (a bit less to stay on); its direction from the
 * shoulder to the hand seen from above. On after 2 results in a row, off after 4; an id per time up.
 */
function skeletonArms(st, sk, toWall, inf, P) {
  const J = sk.joints;
  const C = sk.confidence;
  st.sk ??= {};
  const res = [];
  for (const [key, sh, wr, hd] of [
    ['L', 'leftShoulder', 'leftWrist', 'leftHand'],
    ['R', 'rightShoulder', 'rightWrist', 'rightHand'],
  ]) {
    let arm = st.sk[key];
    let want = null;
    const tipW = (C[wr] ?? 0) > 0.25 ? (J[hd] ?? J[wr]) : null;
    if (tipW && J[sh]) {
      const t = toWall(tipW);
      const s0 = toWall(J[sh]);
      const len = Math.hypot(t[0] - inf.cx, t[2] - inf.cz);
      if (t[1] > 0.5 * st.H && len > P.armMin - (arm?.on ? 0.05 : 0)) {
        let dx = t[0] - s0[0];
        let dz = t[2] - s0[2];
        if (Math.hypot(dx, dz) < 0.1) {
          dx = t[0] - inf.cx;
          dz = t[2] - inf.cz;
        }
        want = { ang: Math.atan2(dz, dx), len };
      }
    }
    if (want) {
      if (!arm) arm = st.sk[key] = { id: armIds++, ang: want.ang, len: want.len, hits: 0, miss: 0, on: false };
      arm.ang = want.ang;
      arm.len = want.len;
      arm.miss = 0;
      if (++arm.hits >= 2) arm.on = true;
    } else if (arm) {
      arm.hits = 0;
      if (++arm.miss >= 4) st.sk[key] = arm = null;
    }
    if (arm?.on) res.push(arm);
  }
  return res;
}

/**
 * The arm the sensor cannot see (see the top of this file): [] or [the virtual arm]. On after 2 frames
 * in a row, off after 4, its direction smoothed; it keeps its id while the visible arm stays.
 */
function hiddenArm(real, st, P, time) {
  let want = null;
  if (P.mirrorArm && real.length === 1 && st.right && time - st.rightAt < 0.5) {
    const a = real[0];
    const along = Math.cos(a.ang) * st.right[0] + Math.sin(a.ang) * st.right[1];
    const v = [-Math.sign(along) * st.right[0], -Math.sign(along) * st.right[1]];
    // stretched out along the shoulders (within 30°), the body turned by 50° or more, so the other
    // side lies behind it (a hand pointing ahead turns the shoulders a little: that is no reason)
    if (Math.abs(along) > 0.87 && a.len > P.armMin + 0.15 && v[1] > 0.77) want = { of: a, ang: Math.atan2(v[1], v[0]) };
  }
  let h = st.hidden;
  if (want) {
    if (!h || h.of !== want.of) h = st.hidden = { id: -want.of.id, of: want.of, ang: want.ang, len: want.of.len, hits: 0, miss: 0, on: false, virtual: true };
    h.ang = wrap(h.ang + wrap(want.ang - h.ang) * 0.5);
    h.len = want.of.len;
    h.miss = 0;
    if (++h.hits >= 2) h.on = true;
  } else if (h) {
    h.hits = 0;
    if (++h.miss >= 4) st.hidden = h = null;
  }
  return h?.on ? [h] : [];
}

let armIds = 1;
/** follows the arms from frame to frame: matched by angle, smoothed, with hysteresis */
function trackArms(st, found) {
  const used = new Set();
  for (const a of st.arms) {
    let best = null;
    let bd = 0.7; // rad
    for (const f of found) {
      if (used.has(f)) continue;
      const d = Math.abs(wrap(f.ang - a.ang));
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    if (best) {
      used.add(best);
      a.ang = wrap(a.ang + wrap(best.ang - a.ang) * 0.55);
      a.len += (best.len - a.len) * 0.5;
      a.hits++;
      a.miss = 0;
      if (a.hits >= 2) a.on = true;
    } else {
      a.miss++;
      a.hits = 0;
      if (a.miss >= 4) a.on = false;
    }
  }
  st.arms = st.arms.filter((a) => a.miss < 6);
  for (const f of found) {
    if (used.has(f) || st.arms.length >= 2) continue;
    st.arms.push({ id: armIds++, ang: f.ang, len: f.len, hits: 1, miss: 0, on: false });
  }
}

// for tests
export { fused, skeletonArms };
