// Bindings and helpers of every compute pass in the sim module (camera.wgsl + sim.wgsl), and the
// optical flow of the camera image, once per Kinect frame:
//   camSignal   prep (512x424) -> signal 128x106: r now, g before, b front depth now, a before
//   down        signal -> half resolution (64x53, then 32x27)
//   lkCoarse    Lucas-Kanade on the coarsest level
//   lkRefine    next level: start from the coarser flow (doubled), the before image is shifted by it
//   lkFinal     same on 128x106, plus smoothing over time
// Coarse to fine because a hand 1 m from the sensor easily moves 30 pixels per frame, far more than
// Lucas-Kanade can follow on a single level.
@group(0) @binding(1) var texA: texture_2d<f32>;
@group(0) @binding(2) var texB: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var texC: texture_2d<f32>;

fn ldA(p: vec2i) -> vec4f { return textureLoad(texA, clamp(p, vec2i(0), vec2i(textureDimensions(texA)) - 1), 0); }
fn ldB(p: vec2i) -> vec4f { return textureLoad(texB, clamp(p, vec2i(0), vec2i(textureDimensions(texB)) - 1), 0); }
fn ldC(p: vec2i) -> vec4f { return textureLoad(texC, clamp(p, vec2i(0), vec2i(textureDimensions(texC)) - 1), 0); }

// ---- texA prep, texB previous signal. Nearness mixed with IR, averaged over 8x8 depth pixels; the
// depth of the front surface in the block (mean of the points up to 15 cm behind the nearest)
@compute @workgroup_size(8, 8)
fn camSignal(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let step = vec2i(textureDimensions(texA)) / vec2i(size);
  let base = p * step - step / 2;
  var sum = vec2f(0.0);
  var zmin = 1e9;
  for (var y = 0; y < 8; y++) {
    for (var x = 0; x < 8; x++) {
      let s = ldA(base + vec2i(x, y) * step / 4);
      sum += s.rg;
      if (s.b > 0.1) { zmin = min(zmin, s.b); }
    }
  }
  var zsum = 0.0;
  var zn = 0.0;
  for (var y = 0; y < 8; y++) {
    for (var x = 0; x < 8; x++) {
      let z = ldA(base + vec2i(x, y) * step / 4).b;
      if (z > 0.1 && z < zmin + 0.15) {
        zsum += z;
        zn += 1.0;
      }
    }
  }
  sum /= 64.0;
  let prev = ldB(p);
  textureStore(outTex, p, vec4f(mix(sum.x, sum.y, U.irMix), prev.r, select(0.0, zsum / zn, zn > 0.0), prev.b));
}

// ---- texA finer signal -> half resolution (r now, g before)
@compute @workgroup_size(8, 8)
fn down(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let q = vec2i(id.xy) * 2;
  let s = 0.25 * (ldA(q) + ldA(q + vec2i(1, 0)) + ldA(q + vec2i(0, 1)) + ldA(q + vec2i(1, 1)));
  textureStore(outTex, vec2i(id.xy), vec4f(s.rg, 0.0, 0.0));
}

// Lucas-Kanade (Gaussian 9x9 window) on texA (r now, g before) around p, starting from the guess u
// (pixels of this level): the before image is sampled at q - u, so only the rest has to be small.
fn lucasKanade(p: vec2i, u: vec2f) -> vec2f {
  let px = 1.0 / vec2f(textureDimensions(texA));
  let dx = vec2f(px.x, 0.0);
  let dy = vec2f(0.0, px.y);
  var sxx = 0.0; var syy = 0.0; var sxy = 0.0; var sxt = 0.0; var syt = 0.0;
  for (var y = -4; y <= 4; y++) {
    for (var x = -4; x <= 4; x++) {
      let q = p + vec2i(x, y);
      let w = exp(-f32(x * x + y * y) / 18.0);
      let b = (vec2f(q) + 0.5 - u) * px; // where q was before
      let ix = 0.25 * (ldA(q + vec2i(1, 0)).r - ldA(q - vec2i(1, 0)).r
        + textureSampleLevel(texA, samp, b + dx, 0.0).g - textureSampleLevel(texA, samp, b - dx, 0.0).g);
      let iy = 0.25 * (ldA(q + vec2i(0, 1)).r - ldA(q - vec2i(0, 1)).r
        + textureSampleLevel(texA, samp, b + dy, 0.0).g - textureSampleLevel(texA, samp, b - dy, 0.0).g);
      let it = ldA(q).r - textureSampleLevel(texA, samp, b, 0.0).g;
      sxx += w * ix * ix; syy += w * iy * iy; sxy += w * ix * iy;
      sxt += w * ix * it; syt += w * iy * it;
    }
  }
  // regularisation: where the signal is flat there is nothing to measure, noise must not become flow
  let a = sxx + U.lambda;
  let d = syy + U.lambda;
  var du = vec2f(-d * sxt + sxy * syt, sxy * sxt - a * syt) / (a * d - sxy * sxy);
  let len = length(du);
  if (len > 3.0) { du *= 3.0 / len; } // per level only a small correction is trustworthy
  // Keep the coarser guess only where this level sees structure. In flat areas (the empty wall
  // next to a moving ball) nothing can be measured, and the coarse level's big window would
  // otherwise smear the motion far into the background.
  return u * smoothstep(0.2 * U.lambda, 2.0 * U.lambda, sxx + syy) + du;
}
// the coarser flow (texB) at p, in pixels of this level
fn guess(p: vec2i, size: vec2u) -> vec2f {
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  return textureSampleLevel(texB, samp, uv, 0.0).rg * vec2f(size) / vec2f(textureDimensions(texB));
}

@compute @workgroup_size(8, 8)
fn lkCoarse(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(outTex, vec2i(id.xy), vec4f(lucasKanade(vec2i(id.xy), vec2f(0.0)), 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn lkRefine(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  textureStore(outTex, p, vec4f(lucasKanade(p, guess(p, size)), 0.0, 0.0));
}

// texA signal 128x106, texB flow of the level above, texC previous result.
// out: rg flow (pixels of 128x106 per Kinect frame, smoothed), b signal, a smoothed |flow|.
// Smoothing the flow and its length separately lets kinect.wgsl tell steady motion from noise.
@compute @workgroup_size(8, 8)
fn lkFinal(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  var f = lucasKanade(p, guess(p, size));
  let len = length(f);
  if (len > 24.0) { f *= 24.0 / len; }
  let prev = ldC(p);
  let mag = mix(length(f), prev.a, U.flowSmooth);
  f = mix(f, prev.rg, U.flowSmooth);
  textureStore(outTex, p, vec4f(f, ldA(p).r, mag));
}
