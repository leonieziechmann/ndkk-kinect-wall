// Pixel-Art-Spiegel: the people on the LED wall as big pixel tiles.
// One cell = P.cell cm (rounded to whole LEDs). Each cell asks wallPerson() at 3 x 3 points whether a
// person covers it; the front person wins. The skeleton on the wall tells which body part the cell
// shows (hair, skin, shirt, pants, shoes), the person's outfit (PAL, by tracking id) gives the color,
// and the side of the limb facing the light gives three pixel-art tones.
// Depth layers: every person stands on one of three layers by their distance from the sensor. The
// front layer has coarse tiles, the back layer fine ones (same colors); front layers cover back layers.
// State for the next frame lives in prev().a (see stateAt and slotLayer).

const TAPS = 3;
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

// how much of the cell at o (top left, px) the people of one depth layer cover, and who covers most
// of it; layerOf: the layer of every slot this frame
struct Cover { cov: f32, slot: u32, };
fn cover(o: vec2f, c: f32, layer: u32, layerOf: ptr<function, array<u32, 17>>) -> Cover {
  var cov = 0.0;
  var a = 0u;
  var na = 0.0;
  var b = 0u;
  var nb = 0.0;
  for (var j = 0; j < TAPS; j++) {
    for (var i = 0; i < TAPS; i++) {
      let p = o + (vec2f(f32(i), f32(j)) + 0.5) / f32(TAPS) * c;
      let w = wallPerson(p / F.resolution);
      let s = min(u32(w.z + 0.5), 16u);
      if (s == 0u || (*layerOf)[s] == layer) { cov += w.x; } // s = 0: the soft edge of somebody
      if (w.x > 0.25 && s > 0u && (*layerOf)[s] == layer) {
        if (a == 0u || s == a) { a = s; na += 1.0; } else if (b == 0u || s == b) { b = s; nb += 1.0; }
      }
    }
  }
  return Cover(cov / f32(TAPS * TAPS), select(a, b, nb > na));
}

// one cell of a square grid of size c (LED px), centered on the wall: its top left corner, its index,
// and the rounded tile inside it (0..1, edges on whole LEDs)
struct Tile { o: vec2f, idx: vec2f, mask: f32, };
fn tileAt(pos: vec2f, c: f32) -> Tile {
  let n = floor(F.resolution / c);
  let origin = floor((F.resolution - n * c) * 0.5);
  let idx = floor((pos - origin) / c);
  let o = origin + idx * c;
  let gap = round(P.gap * c);
  let half = 0.5 * (c - gap);
  let lp = pos - o - vec2f(floor(gap * 0.5) + half);
  let rad = P.corner * half;
  let q = abs(lp) - vec2f(half - rad);
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - rad;
  return Tile(o, idx, saturate(0.5 - d));
}

// ---------- depth layers ----------
const LAYERS = 3u;

// tile size of a layer (LED px): front coarse, middle = P.cell, back fine
fn layerSize(l: u32, c: f32) -> f32 {
  let k = select(select(P.farScale, 1.0, l == 1u), P.nearScale, l == 0u);
  return max(3.0, round(c * k));
}

// the depth layer of slot s this frame, from its distance z (m from the sensor, < 0 = unknown).
// The pixel (s, 0) keeps it for the next frame: 1 + layer + 4 * (id % 256); 0 = nothing yet. Every
// pixel computes the same from that, so the layer of a person is the same everywhere on the wall.
// A person changes the layer only P.layerHold m beyond its border (no flicker at the border).
fn slotLayer(s: u32, z: f32) -> u32 {
  let v = u32(textureLoad(prevTex, vec2i(i32(s), 0), 0).a + 0.5);
  let id = u32(personInfo(s).y + 0.5) % 256u;
  let known = v > 0u && ((v - 1u) >> 2u) == id;
  let was = select(1u, (v - 1u) & 3u, known);
  if (z < 0.0) { return was; }
  let fresh = select(select(2u, 1u, z < P.layerFar), 0u, z < P.layerNear);
  if (!known) { return fresh; }
  let lo = select(-1e3, select(P.layerNear, P.layerFar, was == 2u), was > 0u) - P.layerHold;
  let hi = select(1e3, select(P.layerNear, P.layerFar, was == 1u), was < 2u) + P.layerHold;
  return select(fresh, was, z >= lo && z <= hi);
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
    // the wall height back to the room (the projection's height mapping and the person's body scale)
    let y = wallRoomY(wallAt(p / F.resolution).y) / select(1.0, WALL.slots[s].y, WALL.perPerson > 0.5);
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

// The state of every pixel for the next frame, in prev().a as an exact integer: 3 bits per depth
// layer for the pixel's cell in that layer (7 = lit, 1..6 = fading afterimage, 0 = off). Every pixel of
// a cell computes the same, so a cell's state is read at its center. Row 0, x = 1..16, keeps the
// layer of each person slot instead (slotLayer).
fn stateAt(p: vec2f) -> u32 { return u32(textureLoad(prevTex, vec2i(p), 0).a + 0.5); }

fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let c = cellPx();
  let m = ppm();

  // every visible person: its layer and where its body center is on the wall
  var layerOf: array<u32, 17>;
  var centerX: array<f32, 17>;
  for (var s = 1u; s <= PERSON_SLOTS; s++) {
    layerOf[s] = 9u;
    if (!personVisible(s)) { continue; }
    let cj = personJoint(s, J_CENTER);
    var z = -1.0;
    centerX[s] = -1e6; // unknown: counts as near everywhere
    if (cj.w > 0.0) {
      let r = wallRoom(cj.xyz);
      z = r.z;
      centerX[s] = wallPx(wallFromRoom(r, s)).x;
    }
    layerOf[s] = slotLayer(s, z);
  }

  // front to back: the first layer with a lit cell here wins
  var state = 0u;
  var col = vec3f(0.0);
  var drawn = false;
  var ghost = vec3f(0.0); // the afterimage of the nearest fading cell
  var ghostMix = 0.0;
  for (var l = 0u; l < LAYERS; l++) {
    let size = layerSize(l, c);
    let t = tileAt(pos, size);
    let center = t.o + 0.5 * size;
    // only near the people of this layer (the same answer for every pixel of the cell)
    var near = false;
    for (var s = 1u; s <= PERSON_SLOTS; s++) {
      if (layerOf[s] == l && (centerX[s] < -1e5 || abs(center.x - centerX[s]) < 1.5 * m)) { near = true; }
    }
    if (!near) { continue; }
    let wasLevel = (stateAt(center) >> (3u * l)) & 7u;
    let wasLit = wasLevel == 7u;
    let cv = cover(t.o, size, l, &layerOf);
    let lit = cv.slot > 0u && (cv.cov > P.fill || (wasLit && cv.cov > P.fill * 0.55));
    var level = 0u;
    if (lit) {
      level = 7u;
      if (!drawn) {
        let h = hash2(t.idx + 17.0 + f32(l) * 31.0);
        let outfit = u32(personInfo(cv.slot).y + 0.5) % PAL_COUNT;
        let part = bodyPart(cv.slot, center);
        var k = part.part;
        if (k == SLEEVE) { k = select(SHIRT, SKIN, SLEEVE_SKIN[outfit] > 0.5); }
        col = tone(PAL[outfit * 5u + k], part.n, (h - 0.5) * 0.1) * t.mask; // the same colors on every layer
        drawn = true;
      }
    } else if (wasLevel > 0u) {
      // afterimage: the cell's last color fades into the grid
      let decay = pow(P.trail, F.dt * 30.0);
      level = u32(floor(select(f32(wasLevel) / 6.0, 1.0, wasLit) * decay * 6.0));
      if (level > 0u && ghostMix == 0.0) {
        ghost = textureLoad(prevTex, vec2i(center), 0).rgb * t.mask;
        ghostMix = decay;
      }
    }
    state = state | (level << (3u * l));
  }

  if (!drawn) {
    // background: dim grid, a few tiles glimmer now and then
    let t = tileAt(pos, c);
    let h = hash2(t.idx + 17.0);
    let h2 = hash2(t.idx * 1.37 + 3.1);
    let glim = pow(max(0.0, sin(F.time * (0.4 + 0.8 * h2) + h * 40.0)), 30.0) * P.twinkle;
    col = P.bg * P.grid * (0.5 + 0.5 * h + 1.6 * glim) * t.mask;
    if (ghostMix > 0.0) { col = mix(col, ghost, ghostMix); }
  }
  var out = col;
  if (P.debug > 0.5) { out = mix(out, vec3f(1.0), debugSkeleton(pos)); }

  // row 0: the layer of every slot for the next frame
  if (pos.y < 1.0 && pos.x >= 1.0 && pos.x < f32(PERSON_SLOTS) + 1.0) {
    let s = u32(pos.x);
    state = stateAt(pos); // a person hidden for a moment keeps their layer
    if (personVisible(s)) { state = 1u + layerOf[s] + 4u * (u32(personInfo(s).y + 0.5) % 256u); }
  }
  return vec4f(out, f32(state));
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
