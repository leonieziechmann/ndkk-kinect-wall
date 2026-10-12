// Cyberspiegel: the image passes after the scene, at LED resolution (main.js ledMat and three.js'
// BloomNode with the same math): luminosity high pass -> 5 mips of separable gaussian blur ->
// composite -> the LED image (row glitch, RGB split, bloom, exposure, soft shoulder, vignette), then
// the renderer's output transform (linear -> sRGB) because the LED image holds displayed values.
// vs_fullscreen comes from gpu::FULLSCREEN_WGSL.

struct Post {
  res: vec2f,        // LED pixels
  bloomRes: vec2f,   // the bright pass and mip 0
  exposure: f32, ca: f32, caGlitch: f32, slice: f32,
  seed: f32, vignette: f32, flash: f32, strength: f32,
  radius: f32, threshold: f32, smoothWidth: f32, _a: f32,
};

fn hashU(seed: u32) -> f32 {
  let state = seed * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return f32((word >> 22u) ^ word) * (1.0 / 4294967296.0);
}
fn hash(seed: f32) -> f32 { return hashU(u32(clamp(seed, 0.0, 4294967040.0))); }

fn sstep(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// ---------- bloom: bright areas ----------

@group(0) @binding(0) var<uniform> post: Post;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

@fragment fn fs_high(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let c = textureSampleLevel(src, samp, fp.xy / post.bloomRes, 0.0);
  let v = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  return c * sstep(post.threshold, post.threshold + post.smoothWidth, v);
}

// ---------- bloom: separable gaussian blur (one direction, one mip) ----------

struct Blur {
  dir: vec2f,      // (1, 0) or (0, 1)
  invSize: vec2f,  // 1 / the size of this mip
  center: f32,     // the weight of the middle tap
  n: u32,          // tap pairs
  _a: f32, _b: f32,
  offsets: array<vec4f, 3>,
  weights: array<vec4f, 3>,
};
@group(0) @binding(8) var<uniform> blur: Blur;

@fragment fn fs_blur(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let uv = fp.xy * blur.invSize;
  var sum = textureSampleLevel(src, samp, uv, 0.0).rgb * blur.center;
  for (var i = 0u; i < blur.n; i++) {
    let w = blur.weights[i / 4u][i % 4u];
    let off = blur.dir * blur.invSize * blur.offsets[i / 4u][i % 4u];
    sum += (textureSampleLevel(src, samp, uv + off, 0.0).rgb + textureSampleLevel(src, samp, uv - off, 0.0).rgb) * w;
  }
  return vec4f(sum, 1.0);
}

// ---------- bloom: the composite of the 5 blurred mips (into mip 0's size) ----------

@group(0) @binding(3) var mip1: texture_2d<f32>;
@group(0) @binding(4) var mip2: texture_2d<f32>;
@group(0) @binding(5) var mip3: texture_2d<f32>;
@group(0) @binding(6) var mip4: texture_2d<f32>;

fn factor(f: f32) -> f32 { return mix(f, 1.2 - f, post.radius); }

@fragment fn fs_comp(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let uv = fp.xy / post.bloomRes;
  let sum = factor(1.0) * textureSampleLevel(src, samp, uv, 0.0)
    + factor(0.8) * textureSampleLevel(mip1, samp, uv, 0.0)
    + factor(0.6) * textureSampleLevel(mip2, samp, uv, 0.0)
    + factor(0.4) * textureSampleLevel(mip3, samp, uv, 0.0)
    + factor(0.2) * textureSampleLevel(mip4, samp, uv, 0.0);
  return sum * post.strength;
}

// ---------- the LED image ----------

@group(0) @binding(7) var bloomTex: texture_2d<f32>;

fn srgb(c: vec3f) -> vec3f {
  return select(pow(c, vec3f(0.41666)) * 1.055 - vec3f(0.055), c * 12.92, c <= vec3f(0.0031308));
}

@fragment fn fs_led(@builtin(position) fp: vec4f) -> @location(0) vec4f {
  let q = fp.xy / post.res;
  // glitch: bands of rows jump sideways
  let row = floor(q.y * 22.0);
  let on = select(0.0, post.slice, hash(row + post.seed * 17.0) > 0.7);
  let p = vec2f(q.x + (hash(row + post.seed * 3.0 + 1.0) - 0.5) * 0.08 * on, q.y);
  // RGB split, stronger towards the ends of the wall and in a glitch
  let dx = p.x - 0.5;
  let ca = post.ca * (abs(dx) * 1.6 + 0.2) + post.caGlitch * (on + 0.3);
  let r = textureSampleLevel(src, samp, vec2f(p.x + ca, p.y), 0.0).r;
  let g = textureSampleLevel(src, samp, p, 0.0).g;
  let b = textureSampleLevel(src, samp, vec2f(p.x - ca, p.y), 0.0).b;
  let c = (vec3f(r, g, b) + textureSampleLevel(bloomTex, samp, q, 0.0).rgb) * (post.exposure * (post.flash + 1.0));
  let vig = 1.0 - sstep(0.28, 0.5, abs(dx)) * post.vignette;
  // soft shoulder, black stays black
  return vec4f(srgb(max((vec3f(1.0) - exp(-c)) * vig, vec3f(0.0))), 1.0);
}
