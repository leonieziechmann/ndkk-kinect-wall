// Drawing: the people (silhouettes from the wall grid, grid.js) and every sprite of the game
// (bubbles, rings, droplets, digits) as instanced quads, added onto black. The canvas is the LED
// image (a wall scene): it covers the wall from x 0 to wallW and from y wallBottom to wallBottom + wallH.
// PALETTE and PALETTE_SIZE are generated in main.js and put in front of this.

struct Uni {
  screen: vec2f,
  wallW: f32, wallH: f32, wallBottom: f32, time: f32,
  grid: vec2f, showFresh: f32,
  fill: f32, outline: f32, motionGlow: f32, brightness: f32,
};
// one sprite: a = center (wall m, y up) and half size (m); col = rgb, intensity;
// k = kind (0 bubble, 1 ring, 2 dot, 3 glyph), then per kind; d.w = margin of the quad
struct Sprite { a: vec4f, col: vec4f, k: vec4f, d: vec4f };

@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var gridTex: texture_2d<f32>; // r covered, g slot / 255, b activity, a newly covered
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read> sprites: array<Sprite>;

fn slotColor(s: u32) -> vec3f {
  if (s == 0u) { return vec3f(1.0); }
  return PALETTE[(s - 1u) % PALETTE_SIZE];
}

fn hsv(h: f32, s: f32, v: f32) -> vec3f {
  let k = fract(vec3f(h) + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0;
  return v * mix(vec3f(1.0), saturate(abs(k) - 1.0), s);
}
// cyan, blue, violet, magenta, pink and back: never yellow or green (they fade to olive)
fn neon(x: f32) -> vec3f {
  let tri = abs(fract(x) * 2.0 - 1.0);
  return hsv(0.5 + 0.47 * tri, 0.75, 1.0);
}

// ---- the people
@vertex fn fullVs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn people(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / U.screen;
  let t = 1.0 / U.grid;
  // soft coverage: bilinear plus four taps around (rounder edges than the 1.5 cm cells)
  var cov = textureSampleLevel(gridTex, samp, uv, 0.0).r * 0.4;
  cov += textureSampleLevel(gridTex, samp, uv + vec2f(0.7, 0.7) * t, 0.0).r * 0.15;
  cov += textureSampleLevel(gridTex, samp, uv + vec2f(-0.7, 0.7) * t, 0.0).r * 0.15;
  cov += textureSampleLevel(gridTex, samp, uv + vec2f(0.7, -0.7) * t, 0.0).r * 0.15;
  cov += textureSampleLevel(gridTex, samp, uv + vec2f(-0.7, -0.7) * t, 0.0).r * 0.15;
  let act = textureSampleLevel(gridTex, samp, uv, 0.0).b;
  // a thin outline along cov = 0.5, about 1.5 px wide whatever the scale (fwidth before any branch)
  let fw = max(fwidth(cov), 1e-4);
  let edge = 1.0 - saturate(abs(cov - 0.5) / (fw * 1.2));
  let fill = smoothstep(0.5 - fw, 0.5 + fw, cov);

  // whose: the cell here, else a neighbour (the outline lies half outside the body)
  let gs = vec2i(U.grid);
  let cell = vec2i(floor(uv * U.grid));
  var slot = u32(round(textureLoad(gridTex, cell, 0).g * 255.0));
  for (var dy = -1; dy <= 1 && slot == 0u; dy++) {
    for (var dx = -1; dx <= 1 && slot == 0u; dx++) {
      slot = u32(round(textureLoad(gridTex, clamp(cell + vec2i(dx, dy), vec2i(0), gs - 1), 0).g * 255.0));
    }
  }
  let col = slotColor(slot);
  // moving parts light up: the outline most, the body a little (no trail outside: no haze)
  let moving = act * U.motionGlow;
  var c = col * (fill * U.fill * (1.0 + moving * 2.0) + edge * U.outline * (1.0 + moving * 1.5));
  if (U.showFresh > 0.5) { c = mix(c, vec3f(1.0), textureLoad(gridTex, cell, 0).a); }
  return vec4f(c * U.brightness, 1.0);
}

// ---- sprites
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,                      // quad coordinates: 1 = the half size, y up
  @location(1) @interpolate(flat) id: u32,
  @location(2) @interpolate(flat) px: vec2f,      // the half size in pixels
};

@vertex fn spriteVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let s = sprites[ii];
  let local = corners[vi] * s.d.w;
  let m = s.a.xy + local * s.a.zw;
  let uv = vec2f(m.x / U.wallW, (U.wallBottom + U.wallH - m.y) / U.wallH);
  var o: VOut;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  o.local = local;
  o.id = ii;
  o.px = s.a.zw * U.screen / vec2f(U.wallW, U.wallH);
  return o;
}

fn rot(p: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * p.x - s * p.y, s * p.x + c * p.y);
}
// five-pointed star (Inigo Quilez), pointing up
fn sdStar5(p0: vec2f, r: f32, rf: f32) -> f32 {
  let k1 = vec2f(0.809016994375, -0.587785252292);
  let k2 = vec2f(-k1.x, k1.y);
  var p = vec2f(abs(p0.x), p0.y);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  let ba = rf * vec2f(-k1.y, k1.x) - vec2f(0.0, 1.0);
  let h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
fn sdSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// k.y hue, k.z phase, k.w type (0 normal, 1 star, 2 giant)
fn bubble(p: vec2f, s: Sprite, rpx: f32) -> vec3f {
  let t = U.time;
  let d = length(p);
  let px = 1.0 / max(rpx, 1.0);
  let typ = u32(s.k.w);
  let ang = atan2(p.y, p.x);
  var rimW = max(1.1 * px, 0.025);
  if (typ == 2u) { rimW *= 1.5; }
  let rim = exp(-pow((d - 1.0) / rimW, 2.0));
  let inside = 1.0 - smoothstep(1.0 - px, 1.0 + px, d);
  // thin film: the hue runs around the rim and moves; brighter towards the edge (Fresnel)
  let film = neon(s.k.y + 0.2 * sin(ang * 2.0 + t * 0.9 + s.k.z) + 0.3 * d + t * 0.05);
  let fres = pow(saturate(d), 5.0) * inside;
  var c = film * (rim * 1.2 + fres * 0.5);
  c += film * exp(-max(d - 1.0, 0.0) * 10.0) * 0.15 * (1.0 - inside);
  // the window reflection, top left
  let h = rot(p - vec2f(-0.45, 0.45), 0.785);
  c += vec3f(1.0) * (1.0 - smoothstep(0.9, 1.0, length(h * vec2f(9.0, 3.6)))) * 0.75 * inside;
  if (typ == 1u) {
    let pulse = 0.8 + 0.2 * sin(t * 7.0);
    let sd = sdStar5(rot(p, t * 0.7), 0.55, 0.45);
    let star = 1.0 - smoothstep(-px, px, sd);
    c = neon(ang / 6.2832 + t * 0.4) * (rim * 1.6 + fres * 0.6);
    c += vec3f(1.0, 0.92, 1.0) * star * pulse + vec3f(1.0, 0.55, 0.95) * exp(-max(sd, 0.0) * 7.0) * 0.5 * inside;
    c += neon(t * 0.3) * exp(-max(d - 1.0, 0.0) * 5.0) * 0.35 * (1.0 - inside);
  }
  if (typ == 2u) {
    // giants: a second, inner rim, to look heavier
    c += film * exp(-pow((d - 0.86) / (rimW * 0.8), 2.0)) * 0.35;
  }
  return c;
}

// 7 segments: a top, b top right, c bottom right, d bottom, e bottom left, f top left, g middle
fn glyph(p: vec2f, s: Sprite, rpy: f32) -> f32 {
  let g = u32(s.k.y);
  // units of the half height; a 1 sits in the middle of its place
  let q = vec2f(p.x * s.a.z / s.a.w + select(0.0, 0.5, g == 1u), p.y);
  let th = 0.12;
  var sd = 1e9;
  if (g == 10u) { // +
    sd = min(sdSeg(q, vec2f(-0.45, 0.0), vec2f(0.45, 0.0)), sdSeg(q, vec2f(0.0, -0.45), vec2f(0.0, 0.45)));
  } else if (g == 11u) { // star
    sd = sdStar5(q * vec2f(1.0, 1.0) - vec2f(0.0, -0.05), 0.85, 0.45) + th;
  } else {
    var masks = array<u32, 10>(63u, 6u, 91u, 79u, 102u, 109u, 125u, 7u, 127u, 111u);
    let m = masks[min(g, 9u)];
    let x0 = -0.5;
    let x1 = 0.5;
    let e = 0.06; // gaps at the corners
    if ((m & 1u) != 0u) { sd = min(sd, sdSeg(q, vec2f(x0 + e, 0.9), vec2f(x1 - e, 0.9))); }
    if ((m & 2u) != 0u) { sd = min(sd, sdSeg(q, vec2f(x1, 0.9 - e), vec2f(x1, e))); }
    if ((m & 4u) != 0u) { sd = min(sd, sdSeg(q, vec2f(x1, -e), vec2f(x1, -0.9 + e))); }
    if ((m & 8u) != 0u) { sd = min(sd, sdSeg(q, vec2f(x0 + e, -0.9), vec2f(x1 - e, -0.9))); }
    if ((m & 16u) != 0u) { sd = min(sd, sdSeg(q, vec2f(x0, -e), vec2f(x0, -0.9 + e))); }
    if ((m & 32u) != 0u) { sd = min(sd, sdSeg(q, vec2f(x0, 0.9 - e), vec2f(x0, e))); }
    if ((m & 64u) != 0u) { sd = min(sd, sdSeg(q, vec2f(x0 + e, 0.0), vec2f(x1 - e, 0.0))); }
  }
  let dpx = (sd - th) * rpy; // pixels
  return saturate(0.5 - dpx) + exp(-max(dpx, 0.0) * 0.35) * 0.25;
}

@fragment fn spriteFs(in: VOut) -> @location(0) vec4f {
  let s = sprites[in.id];
  let kind = u32(s.k.x);
  let p = in.local;
  let d = length(p);
  var c = vec3f(0.0);
  if (kind == 0u) {
    c = bubble(p, s, in.px.x);
  } else if (kind == 1u) {
    let w = max(s.k.y, 1.2 / max(in.px.x, 1.0));
    c = vec3f(exp(-pow((d - 1.0) / w, 2.0)));
  } else if (kind == 2u) {
    c = vec3f(exp(-d * d * 4.0));
  } else {
    c = vec3f(glyph(p, s, in.px.y));
  }
  return vec4f(c * s.col.rgb * s.col.a * U.brightness, 1.0);
}
