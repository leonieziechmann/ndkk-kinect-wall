// Cyberspiegel: the sprites of the mirror world (three.js SpriteNodeMaterial in the browser: a quad
// facing the camera per instance, world-sized, at the depth of its center). Everything is additive on
// black, depth-tested against the dark bodies of the people (opaque, drawn first). The node graphs of
// world.js, people.js and fx.js, with the same constants; colors are linear (THREE.Color).

struct U {
  proj: mat4x4f,
  view: mat4x4f,
  time: f32, eyeDist: f32, ledPx: f32, wallW: f32,
  energy: f32, floorAmt: f32, wallAmt: f32, coreAmt: f32,
  glowAmt: f32, streaksAmt: f32, motesAmt: f32, quake: f32,
  open: f32, boost: f32, _a: f32, _b: f32,
  red: vec4f, pink: vec4f, blue: vec4f,
  marks: array<vec4f, 8>,      // feet on the floor: X, Z, alpha
  markColors: array<vec4f, 8>,
  quakes: array<vec4f, 4>,     // X, Z, start time, strength
  near: vec4f, far: vec4f, body: vec4f,
  gain: f32, irGain: f32, rim: f32, reveal: f32,
  glitch: f32, glitchSeed: f32, _c: f32, _d: f32,
  ages: array<vec4f, 5>,       // per slot (17)
  dissolve: array<vec4f, 5>,   // per slot (17)
};
@group(0) @binding(0) var<uniform> u: U;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) col: vec4f,
};

// three.js TSL hash() (pcg); a float seed is converted as WGSL does (clamped, toward zero)
fn hashU(seed: u32) -> f32 {
  let state = seed * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return f32((word >> 22u) ^ word) * (1.0 / 4294967296.0);
}
fn hash(seed: f32) -> f32 { return hashU(u32(clamp(seed, 0.0, 4294967040.0))); }

// smoothstep, also for low > high (TSL passes the edges as given)
fn sstep(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn e2() -> f32 { return u.energy * 0.5 + 0.85; }

// the sprite geometry: corners -0.5..0.5 (uv 0..1, y up), drawn with the indices 0 1 2 0 2 3
fn corner(vi: u32) -> vec2f {
  var c = array<vec2f, 4>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5));
  return c[vi & 3u];
}

// SpriteNodeMaterial.setupPositionView: the quad in view space around the center; anchor = object.center
fn sprite(center: vec3f, scale: vec2f, anchor: vec2f, c: vec2f) -> vec4f {
  let mv = u.view * vec4f(center, 1.0);
  let aligned = (c - (anchor - vec2f(0.5))) * scale;
  return u.proj * vec4f(mv.xy + aligned, mv.zw);
}

fn out(center: vec3f, scale: vec2f, anchor: vec2f, vi: u32, col: vec3f) -> VOut {
  let c = corner(vi);
  var o: VOut;
  o.pos = sprite(center, scale, anchor, c);
  o.uv = c + vec2f(0.5);
  o.col = vec4f(col, 0.0);
  return o;
}

// nothing to draw (a degenerate quad)
fn none() -> VOut {
  var o: VOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.uv = vec2f(0.0);
  o.col = vec4f(0.0);
  return o;
}

// round dot with a soft edge, as opacity
fn roundDot(uv: vec2f, e: f32) -> f32 { return pow(max(1.0 - length(uv - vec2f(0.5)) * 2.0, 0.0), e); }

// the output of an additive sprite (NodeMaterial: max(0), blend src-alpha + one)
fn add(col: vec3f, alpha: f32) -> vec4f { return max(vec4f(col, alpha), vec4f(0.0)); }

// ---------- floor: rows of dots, dunes far away, ripples around the feet, quake rings ----------

@vertex fn vs_floor(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) a: vec4f) -> VOut {
  let t = u.time;
  let dz = u.eyeDist - a.y;
  var height = 0.0;
  var glow = vec3f(0.0);
  for (var i = 0u; i < 8u; i++) {
    let m = u.marks[i];
    let d = length(vec2f(a.x, a.y) - m.xy);
    let wave = sin(d * 14.0 - t * 5.0) * exp(d * -1.8) * m.z;
    height += wave * 0.025;
    glow += u.markColors[i].rgb * (max(wave, 0.0) * 0.9 + exp(d * -3.0) * m.z * 0.25);
  }
  // quakes: a ring runs out from where someone landed and lifts the floor
  for (var i = 0u; i < 4u; i++) {
    let q = u.quakes[i];
    let age = t - q.z;
    let d = length(vec2f(a.x, a.y) - q.xy);
    let front = (d - age * 7.0) / (age * 0.25 + 0.5);
    let ring = exp(-(front * front)) * q.w * exp(age * -0.8) * step(0.0, age);
    height += ring * 0.45;
    glow += mix(u.pink.rgb, vec3f(1.0, 0.8, 0.9), min(ring, 1.0) * 0.5) * (ring * 1.5);
  }
  // dunes far away, flat where the people stand
  let amp = sstep(7.0, 30.0, dz) * 2.4;
  let ridge = sin(a.x * 0.19 + a.y * 0.11 + t * 0.12);
  let dune = ridge * 0.55 + sin(a.x * 0.07 - a.y * 0.16 - t * 0.08) * 0.8 + sin(a.x * 0.41 + a.y * 0.37 + t * 0.2) * 0.18;
  let pos = vec3f(a.x, (dune + 1.0) * amp * 0.5 + height, a.y);
  let twinkle = step(0.985, hash(f32(ii) + floor(t * 2.0 + a.w * 10.0) * 131.0));
  let base = mix(u.pink.rgb, u.red.rgb, sstep(3.0, 25.0, dz)) * (0.16 + (ridge * 0.5 + 0.5) * amp * 0.08);
  // the floor is lit red by the core at the far end
  let lit = exp(length(vec2f(a.x, a.y + 68.0)) / -20.0) * 0.9 * u.coreAmt * e2();
  let col = ((base + u.pink.rgb * (twinkle * 0.6)) * exp(dz / -38.0) + u.red.rgb * lit + glow) * (a.z * 0.35 + 0.65);
  return out(pos, vec2f(u.ledPx * 1.25 * dz / u.eyeDist), vec2f(0.5), vi, col * u.floorAmt);
}

// ---------- the blackwall: an arena of heaving particle columns ----------

@vertex fn vs_wall(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> VOut {
  let t = u.time;
  // spread arms open the wall in the middle
  let th = b.x + sign(b.x) * u.open * 0.42 * exp(abs(b.x) / -0.32);
  let e = u.energy;
  let shake = u.quake;
  let speed = t * (e * 0.8 + 1.0);
  // the surface heaves (outwards = away from the viewer); the bands travel sideways
  let w = (sin(th * 7.0 + speed * 0.25) * 3.2
    + sin(th * 19.0 - speed * 0.42 + a.y * 0.06) * 1.5
    + sin(a.y * 0.12 + speed * 0.3 + th * 3.0) * 1.2) * (e * 0.9 + 0.8) * (shake * 1.5 + 1.0);
  let outward = vec3f(sin(th), 0.0, -cos(th));
  // it trembles in a quake
  let jolt = floor(t * 24.0) * 131.0 + floor(a.w * 9973.0);
  let tremble = vec3f(hash(jolt) - 0.5, hash(jolt + 17.0) - 0.5, hash(jolt + 41.0) - 0.5) * (shake * 3.0);
  // a few particles come loose and drift towards the viewer and with the wind
  let loose = step(0.94, b.y);
  let life = fract(t * 0.045 + b.y * 37.0);
  let blow = vec3f(-sin(th) * 14.0 + 10.0, life * 4.0, cos(th) * 22.0) * life * loose;
  let base = vec3f(sin(th) * 46.0, a.y, cos(th) * -57.0 - 15.0);
  let pos = base + outward * w + vec3f(0.0, sin(th * 11.0 + t * 0.3) * 0.6, 0.0) + blow + tremble;
  let dz = u.eyeDist - pos.z;
  // ridges (towards the viewer) red to pink, grooves blue
  var col = mix(u.blue.rgb * 0.8, u.red.rgb, sstep(2.5, -2.5, w));
  col = mix(col, u.pink.rgb, sstep(-2.5, -5.0, w) * 0.8);
  let stripes = hash(floor(a.w * 9973.0)) * 0.65 + 0.35;
  let fall = exp(a.y / -13.0) * sstep(-1.5, 1.5, a.y) * (sstep(b.z, b.z - 3.0, a.y) * 0.6 + 0.4);
  let flicker = sin(t * 3.0 + b.y * 60.0) * 0.15 + 0.85;
  let bright = fall * stripes * flicker * (e * 0.7 + 0.9) * (1.0 - life * loose) * (u.boost * 0.6 + shake * 0.6 + 1.0);
  return out(pos, vec2f(u.ledPx * 1.3 * length(vec2f(dz, pos.x)) / u.eyeDist), vec2f(0.5), vi, col * bright * u.wallAmt);
}

// ---------- the core: a glowing tear of light in the middle of the wall ----------

@vertex fn vs_core(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) a: vec4f) -> VOut {
  let t = u.time;
  let pos = vec3f(a.x + sin(t * 0.4 + a.w * 30.0) * 0.3, -0.5, -68.0);
  let k = floor(t * (a.w * 4.0 + 2.0) + a.w * 50.0);
  let pulse = hash(f32(ii) + k * 131.0) * 0.7 + 0.3;
  let grow = u.open * 0.8 + u.boost * 0.7 + 1.0;
  let scale = vec2f(a.z * (u.open * 0.6 + 1.0), a.y * (pulse * 0.4 + 0.6) * grow);
  // the color is a varying, so it is computed at the corners (uv of the vertex) as in the browser
  let c = corner(vi);
  let across = abs(c.x) * 2.0;
  let along = c.y + 0.5;
  let col = mix(vec3f(1.0, 0.85, 0.9), u.red.rgb, max(sstep(0.05, 0.6, across), sstep(0.2, 0.9, along)));
  let flare = u.open * 1.2 + u.boost * 1.5 + u.quake + 1.0;
  return out(pos, scale, vec2f(0.5, 0.0), vi, col * pulse * u.coreAmt * e2() * flare);
}

@fragment fn fs_core(in: VOut) -> @location(0) vec4f {
  let across = abs(in.uv.x - 0.5) * 2.0;
  let shape = (1.0 - across) * pow(1.0 - in.uv.y, 1.2);
  return add(in.col.rgb, shape);
}

// and a faint red glow around it
@vertex fn vs_glow(@builtin(vertex_index) vi: u32) -> VOut {
  let k = 0.22 * u.coreAmt * u.glowAmt * e2() * (u.open + u.boost + 1.0);
  return out(vec3f(0.0, 6.0, -70.0), vec2f(60.0, 36.0), vec2f(0.5), vi, u.red.rgb * k);
}

@fragment fn fs_glow(in: VOut) -> @location(0) vec4f {
  let r = length((in.uv - vec2f(0.5)) * 2.0);
  return add(in.col.rgb * exp(r * r * -6.0), 1.0);
}

// ---------- streaks: thin vertical lines of light in the distance ----------

@vertex fn vs_streak(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) a: vec4f) -> VOut {
  let t = u.time;
  let dz = u.eyeDist - a.y;
  let pos = vec3f(a.x + sin(t * 0.05 + a.w * 40.0) * 2.0, -0.5, a.y);
  let k = floor(t * (a.w * 3.0 + 1.5) + a.w * 100.0);
  let on = step(0.72, hash(f32(ii) + k * 131.0));
  let col = mix(u.red.rgb, u.pink.rgb, a.w) * (on * 0.9 + 0.04) * exp(dz / -45.0) * u.streaksAmt;
  return out(pos, vec2f(u.ledPx * 1.1 * dz / u.eyeDist, a.z), vec2f(0.5, 0.0), vi, col);
}

@fragment fn fs_streak(in: VOut) -> @location(0) vec4f {
  let shape = pow(1.0 - in.uv.y, 1.5) * (1.0 - abs(in.uv.x - 0.5) * 2.0);
  return add(in.col.rgb, shape);
}

// ---------- motes drifting in the air ----------

@vertex fn vs_mote(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) a: vec4f) -> VOut {
  let t = u.time;
  // a slow wind to the side, wrapping around
  let span = (-a.z + u.eyeDist) * (2.0 * (u.wallW / 2.0 + 2.0) / u.eyeDist);
  let x = (fract((a.x + t * (a.w * 0.25 + 0.08)) / span + 0.5) - 0.5) * span;
  let pos = vec3f(x, a.y + sin(t * 0.3 + a.w * 50.0) * 0.15, a.z + cos(t * 0.2 + a.w * 30.0) * 0.2);
  let dz = u.eyeDist - pos.z;
  let twinkle = pow(sin(t * (a.w * 2.0 + 0.5) + a.w * 90.0) * 0.5 + 0.5, 4.0);
  let col = mix(u.pink.rgb, u.blue.rgb, step(0.7, hashU(ii + 3u))) * (twinkle * 0.7 + 0.08) * exp(dz / -18.0);
  return out(pos, vec2f(u.ledPx * (a.w + 1.0) * dz / u.eyeDist), vec2f(0.5), vi, col * u.motesAmt);
}

// the dots of floor, wall and motes, the sparks and the swarm
@fragment fn fs_dot(in: VOut) -> @location(0) vec4f { return add(in.col.rgb, roundDot(in.uv, 0.8)); }

// ---------- sparks and swarm (fx.js): position, size and color per instance from the CPU ----------

@vertex fn vs_spark(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) c: vec3f) -> VOut {
  return out(a.xyz, vec2f(a.w), vec2f(0.5), vi, c);
}

// ---------- the people (people.js): dots in front of a dark body ----------

fn slotOf(z: f32) -> u32 { return min(u32(max(floor(z), 0.0)), 16u); }
fn ageOf(s: u32) -> f32 { return u.ages[s / 4u][s % 4u]; }
fn dissolveOf(s: u32) -> f32 { return u.dissolve[s / 4u][s % 4u]; }

struct Placed { pos: vec3f, shown: f32, scanFront: f32, gOn: f32 };

// info: contour, ir, slot + random / 2, distance 0..1 (near..far)
fn placed(p: vec3f, info: vec4f) -> Placed {
  let slot = slotOf(info.z);
  let age = ageOf(slot);
  let keep = step(dissolveOf(slot), fract(info.z) * 2.04); // a fixed random number per pixel
  // glitch: bands of the body jump sideways for a moment
  let band = floor(p.y * 14.0 + u.glitchSeed * 13.7);
  let gOn = select(0.0, u.glitch, hash(band + u.glitchSeed * 101.0) > 0.6);
  let shift = (hash(band + u.glitchSeed * 7.0 + 3.0) - 0.5) * 0.3 * gOn;
  // scanned in from the head down when somebody comes in
  let revealY = 2.4 - age * u.reveal;
  let shown = step(revealY, p.y) * keep;
  let scanFront = sstep(0.08, 0.0, p.y - revealY) * shown;
  var o: Placed;
  o.pos = vec3f(p.x + shift, p.y, p.z);
  o.shown = shown;
  o.scanFront = scanFront;
  o.gOn = gOn;
  return o;
}

// the dark body behind the dots (opaque, writes depth: it hides the world behind)
@vertex fn vs_body(@builtin(vertex_index) vi: u32, @location(0) p: vec3f, @location(1) info: vec4f, @location(2) size: vec2f) -> VOut {
  let q = placed(p, info);
  if (q.shown < 0.5) { return none(); }
  return out(q.pos, vec2f(size.y), vec2f(0.5), vi, u.body.rgb);
}

@fragment fn fs_body(in: VOut) -> @location(0) vec4f {
  if (step(length(in.uv - vec2f(0.5)), 0.5) <= 0.5) { discard; }
  return vec4f(max(in.col.rgb, vec3f(0.0)), 1.0);
}

// the dots, slightly in front of the body
@vertex fn vs_people(@builtin(vertex_index) vi: u32, @location(0) p: vec3f, @location(1) info: vec4f, @location(2) size: vec2f) -> VOut {
  let q = placed(p, info);
  if (q.shown <= 0.0) { return none(); }
  // distance from the wall picks the color; dark parts in the infrared (hair, dark clothes) lean to the far color
  let base = mix(u.near.rgb, u.far.rgb, min(info.w + max(0.6 - info.y, 0.0) * 0.6, 1.0));
  let light = info.y * u.irGain + 0.22;
  let edge = pow(info.x, 1.5) * u.rim;
  let col = base * (light + edge * 0.9) + vec3f(1.0, 0.85, 0.95) * (edge * 0.35)
    + vec3f(1.0) * (q.scanFront * 2.0)
    + vec3f(1.0, 0.3, 0.5) * (q.gOn * 0.5);
  return out(q.pos + vec3f(0.0, 0.0, 0.015), vec2f(size.x), vec2f(0.5), vi, col * u.gain * q.shown);
}

@fragment fn fs_people(in: VOut) -> @location(0) vec4f { return add(in.col.rgb, roundDot(in.uv, 0.7)); }
