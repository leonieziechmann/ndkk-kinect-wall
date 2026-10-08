// Pixel-Art-Spiegel: the people on the LED wall as big pixel tiles.
// One cell = P.cell cm (rounded to whole LEDs). Each cell asks wallPerson() at 4 x 4 points whether a
// person covers it; the front person wins. The skeleton on the wall tells which body part the cell
// shows (hair, skin, shirt, pants, shoes), the person's outfit (PAL, by tracking id) gives the color,
// and the side of the limb facing the light gives three pixel-art tones.
// prev().a remembers the cell: 1 = lit, below 1 = fading afterimage. It gives the hysteresis that
// keeps edge cells from flickering.

const TAPS = 4;
const LIGHT = vec2f(-0.53, -0.85); // light from the upper left (LED px, y down)

const HAIR = 0u;
const SKIN = 1u;
const SHIRT = 2u;
const PANTS = 3u;
const SHOES = 4u;
const HEAD = 5u;   // becomes HAIR or SKIN
const SLEEVE = 6u; // becomes SHIRT or SKIN (outfit)

fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

// LED pixels per meter
fn ppm() -> f32 { return WALL.led.x / max(WALL.size.x, 0.01); }

// cell size in whole LED pixels
fn cellPx() -> f32 { return max(3.0, round(P.cell * 0.01 * ppm())); }

// how much of the cell at o (top left, px) people cover, and who covers most of it
struct Cover { cov: f32, slot: u32, };
fn cover(o: vec2f, c: f32) -> Cover {
  var cov = 0.0;
  var a = 0u;
  var na = 0.0;
  var b = 0u;
  var nb = 0.0;
  for (var j = 0; j < TAPS; j++) {
    for (var i = 0; i < TAPS; i++) {
      let p = o + (vec2f(f32(i), f32(j)) + 0.5) / f32(TAPS) * c;
      let w = wallPerson(p / F.resolution);
      cov += w.x;
      let s = u32(w.z + 0.5);
      if (w.x > 0.25 && s > 0u) {
        if (a == 0u || s == a) { a = s; na += 1.0; } else if (b == 0u || s == b) { b = s; nb += 1.0; }
      }
    }
  }
  return Cover(cov / f32(TAPS * TAPS), select(a, b, nb > na));
}

// a joint of slot s on the LED image (px); z = 0 if not seen
fn jointPx(s: u32, j: u32) -> vec3f {
  let p = personJoint(s, j);
  if (p.w <= 0.0) { return vec3f(0.0); }
  return vec3f(wallPx(wallFromWorld(p.xyz, s)), 1.0);
}

// the body part nearest to a point: part, offset from the bone's axis (in radii), distance to its skin
struct Part { part: u32, n: vec2f, best: f32, };
fn bone(acc: ptr<function, Part>, p: vec2f, a: vec3f, b: vec3f, r: f32, part: u32) {
  if (a.z <= 0.0 || b.z <= 0.0) { return; }
  let ab = b.xy - a.xy;
  let t = clamp(dot(p - a.xy, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  let off = p - a.xy - ab * t;
  let d = length(off) - r;
  if (d < (*acc).best) {
    (*acc).best = d;
    (*acc).part = part;
    (*acc).n = off / r;
  }
}

fn bodyPart(s: u32, p: vec2f) -> Part {
  let m = ppm();
  var acc = Part(SHIRT, vec2f(0.0), 1e9);
  let head = jointPx(s, J_HEAD);
  let neck = jointPx(s, J_NECK);
  let pelvis = jointPx(s, J_PELVIS);
  let waist = vec3f(mix(neck.xy, pelvis.xy, 0.82), min(neck.z, pelvis.z));
  let ls = jointPx(s, J_LEFT_SHOULDER);
  let rs = jointPx(s, J_RIGHT_SHOULDER);
  let le = jointPx(s, J_LEFT_ELBOW);
  let re = jointPx(s, J_RIGHT_ELBOW);
  let lw = jointPx(s, J_LEFT_WRIST);
  let rw = jointPx(s, J_RIGHT_WRIST);
  let lh = jointPx(s, J_LEFT_HAND);
  let rh = jointPx(s, J_RIGHT_HAND);
  let lhip = jointPx(s, J_LEFT_HIP);
  let rhip = jointPx(s, J_RIGHT_HIP);
  let lk = jointPx(s, J_LEFT_KNEE);
  let rk = jointPx(s, J_RIGHT_KNEE);
  let la = jointPx(s, J_LEFT_ANKLE);
  let ra = jointPx(s, J_RIGHT_ANKLE);

  bone(&acc, p, head, head, 0.11 * m, HEAD);
  bone(&acc, p, neck, head, 0.05 * m, SKIN);
  bone(&acc, p, neck, waist, 0.15 * m, SHIRT);
  bone(&acc, p, ls, rs, 0.06 * m, SHIRT);
  bone(&acc, p, lhip, rhip, 0.09 * m, PANTS);
  bone(&acc, p, ls, le, 0.06 * m, SHIRT);
  bone(&acc, p, rs, re, 0.06 * m, SHIRT);
  bone(&acc, p, le, lw, 0.05 * m, SLEEVE);
  bone(&acc, p, re, rw, 0.05 * m, SLEEVE);
  bone(&acc, p, lw, lh, 0.055 * m, SKIN);
  bone(&acc, p, rw, rh, 0.055 * m, SKIN);
  bone(&acc, p, lhip, lk, 0.08 * m, PANTS);
  bone(&acc, p, rhip, rk, 0.08 * m, PANTS);
  bone(&acc, p, lk, la, 0.065 * m, PANTS);
  bone(&acc, p, rk, ra, 0.065 * m, PANTS);
  bone(&acc, p, la, la, 0.07 * m, SHOES);
  bone(&acc, p, ra, ra, 0.07 * m, SHOES);

  if (acc.best > 1e8) {
    // no skeleton (yet): by height, as a fraction of the person's height
    let h = max(personInfo(s).z, 1.0);
    let y = (wallAt(p / F.resolution).y - WALL.lift) / max(WALL.scaleY, 0.01);
    let f = y / h;
    acc.part = select(select(select(select(SHOES, PANTS, f > 0.06), SHIRT, f > 0.48), SKIN, f > 0.84), HAIR, f > 0.92);
    acc.n = vec2f(0.0);
  }
  if (acc.part == HEAD) { acc.part = select(SKIN, HAIR, p.y < head.y - 0.01 * m); }
  // below an ankle: the shoe
  if (acc.part == PANTS) {
    let footL = la.z > 0.0 && p.y > la.y - 0.02 * m && abs(p.x - la.x) < 0.12 * m;
    let footR = ra.z > 0.0 && p.y > ra.y - 0.02 * m && abs(p.x - ra.x) < 0.12 * m;
    if (footL || footR) { acc.part = SHOES; }
  }
  return acc;
}

// three tones: highlight on the side facing the light, shadow (shifted towards violet) on the other
fn tone(c: vec3f, n: vec2f, jitter: f32) -> vec3f {
  let l = dot(n / max(1.0, length(n)), LIGHT) + jitter;
  var t = c;
  if (l > 0.45) {
    t = mix(c, vec3f(1.0, 0.97, 0.9), 0.3);
  } else if (l < -0.45) {
    t = c * vec3f(0.72, 0.66, 0.86) + vec3f(0.02, 0.0, 0.05);
  }
  return max(mix(c, t, P.relief), vec3f(0.0));
}

fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let c = cellPx();
  let n = floor(F.resolution / c);
  let origin = floor((F.resolution - n * c) * 0.5); // the grid centered on the wall
  let idx = floor((pos - origin) / c);
  let o = origin + idx * c; // the cell's top left corner (px)
  let center = o + 0.5 * c;

  // the tile: a rounded square, edges on whole LEDs
  let gap = round(P.gap * c);
  let half = 0.5 * (c - gap);
  let lp = pos - o - vec2f(floor(gap * 0.5) + half);
  let rad = P.corner * half;
  let q = abs(lp) - vec2f(half - rad);
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rad;
  let tile = saturate(0.5 - d);

  // background: dim grid, a few tiles glimmer now and then
  let h = hash2(idx + 17.0);
  let h2 = hash2(idx * 1.37 + 3.1);
  let glim = pow(max(0.0, sin(F.time * (0.4 + 0.8 * h2) + h * 40.0)), 30.0) * P.twinkle;
  var col = P.bg * P.grid * (0.5 + 0.5 * h + 1.6 * glim);
  var state = 0.0;

  let cv = cover(o, c);
  let was = prev(center / F.resolution);
  let wasLit = was.a > 0.999;
  let lit = cv.slot > 0u && (cv.cov > P.fill || (wasLit && cv.cov > P.fill * 0.55));
  if (lit) {
    let outfit = u32(personInfo(cv.slot).y + 0.5) % PAL_COUNT;
    let part = bodyPart(cv.slot, center);
    var k = part.part;
    if (k == SLEEVE) { k = select(SHIRT, SKIN, SLEEVE_SKIN[outfit] > 0.5); }
    col = tone(PAL[outfit * 5u + k], part.n, (h - 0.5) * 0.1);
    state = 1.0;
  } else if (was.a > 0.01) {
    // afterimage: the cell's last color fades into the grid
    let decay = pow(P.trail, F.dt * 30.0);
    state = select(was.a, 1.0, wasLit) * decay;
    col = mix(col, was.rgb, decay);
  }
  var out = col * tile;
  if (P.debug > 0.5) { out = mix(out, vec3f(1.0), debugSkeleton(pos)); }
  return vec4f(out, select(0.0, state, state > 0.01));
}

// test view: the skeletons as the wall mapping puts them (thin white lines)
fn debugSkeleton(p: vec2f) -> f32 {
  var d = 1e6;
  for (var s = 1u; s <= PERSON_SLOTS; s++) {
    if (!personVisible(s)) { continue; }
    for (var b = 0u; b < BONE_COUNT; b++) {
      let a = jointPx(s, BONES[b].x);
      let c = jointPx(s, BONES[b].y);
      if (a.z > 0.0 && c.z > 0.0) { d = min(d, segmentDist(p, a.xy, c.xy)); }
    }
  }
  return saturate(1.5 - d);
}
