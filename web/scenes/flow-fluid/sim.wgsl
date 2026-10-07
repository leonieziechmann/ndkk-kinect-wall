// Optical flow + stable fluids (after Stam / Dobryakov), all compute passes on rgba16float textures.
// Velocity is in simulation cells per second; dye is linear color. The dye is advected with
// MacCormack (semi-Lagrangian there and back, error correction, clamped): it keeps filaments crisp
// where plain semi-Lagrangian advection blurs them a little in every step.
@group(0) @binding(1) var texA: texture_2d<f32>;
@group(0) @binding(2) var texB: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var texC: texture_2d<f32>;
@group(0) @binding(6) var prepTex: texture_2d<f32>; // display only: kinect.wgsl prep (nearness, IR)

fn ldA(p: vec2i) -> vec4f { return textureLoad(texA, clamp(p, vec2i(0), vec2i(textureDimensions(texA)) - 1), 0); }
fn ldB(p: vec2i) -> vec4f { return textureLoad(texB, clamp(p, vec2i(0), vec2i(textureDimensions(texB)) - 1), 0); }
fn ldC(p: vec2i) -> vec4f { return textureLoad(texC, clamp(p, vec2i(0), vec2i(textureDimensions(texC)) - 1), 0); }
fn simSize() -> vec2f { return vec2f(U.simW, U.simH); }

// ---- signal for the optical flow: texA prep (full depth resolution), texB previous signal.
// Nearness plus some IR, averaged over 8x8 depth pixels. out: r now, g before
@compute @workgroup_size(8, 8)
fn signal(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let step = vec2i(textureDimensions(texA)) / vec2i(size);
  let base = p * step - step / 2;
  var sum = vec2f(0.0);
  for (var y = 0; y < 8; y++) {
    for (var x = 0; x < 8; x++) {
      sum += ldA(base + vec2i(x, y) * step / 4).rg;
    }
  }
  sum /= 64.0;
  textureStore(outTex, p, vec4f(mix(sum.x, sum.y, U.irMix), ldB(p).r, 0.0, 0.0));
}

// ---- optical flow (Lucas-Kanade, Gaussian 9x9 window). texA: signal (r now, g before), texB: previous flow.
// out: rg flow in flow pixels per Kinect frame (smoothed), b signal, a smoothed |flow| per frame
@compute @workgroup_size(8, 8)
fn flow(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  var sxx = 0.0; var syy = 0.0; var sxy = 0.0; var sxt = 0.0; var syt = 0.0;
  for (var y = -4; y <= 4; y++) {
    for (var x = -4; x <= 4; x++) {
      let q = p + vec2i(x, y);
      let w = exp(-f32(x * x + y * y) / 18.0);
      let c = ldA(q);
      let gx = (ldA(q + vec2i(1, 0)).rg - ldA(q - vec2i(1, 0)).rg) * 0.5;
      let gy = (ldA(q + vec2i(0, 1)).rg - ldA(q - vec2i(0, 1)).rg) * 0.5;
      let ix = (gx.x + gx.y) * 0.5;
      let iy = (gy.x + gy.y) * 0.5;
      let it = c.r - c.g;
      sxx += w * ix * ix; syy += w * iy * iy; sxy += w * ix * iy;
      sxt += w * ix * it; syt += w * iy * it;
    }
  }
  // regularisation: where the signal is flat there is nothing to measure, noise must not become flow
  let a = sxx + U.lambda;
  let d = syy + U.lambda;
  let det = a * d - sxy * sxy;
  var f = vec2f(-d * sxt + sxy * syt, sxy * sxt - a * syt) / det;
  let len = length(f);
  if (len > 8.0) { f *= 8.0 / len; }
  // Smoothing the flow and its length separately: |mean flow| / mean |flow| is near 1 for real
  // motion (steady direction) and small for noise (direction jumps from frame to frame).
  let prev = ldB(p);
  let mag = mix(length(f), prev.a, U.flowSmooth);
  f = mix(f, prev.rg, U.flowSmooth);
  textureStore(outTex, p, vec4f(f, ldA(p).r, mag));
}

// flow texture (texB) sampled at screen uv -> velocity in cells/s and a 0..1 weight
struct Motion { vel: vec2f, w: f32, dir: f32, near: f32 };
fn motionAt(uv: vec2f) -> Motion {
  var m = Motion(vec2f(0.0), 0.0, 0.0, 0.0);
  let k = toKinect(uv);
  if (!inImage(k)) { return m; }
  let f = textureSampleLevel(texB, samp, k, 0.0);
  let dk = f.rg / vec2f(textureDimensions(texB));
  m.vel = kinectDeltaToScreen(dk) * simSize() * KINECT_FPS * U.flowGain;
  let len = length(f.rg);
  let steady = len / max(f.a, 0.0001);
  m.w = smoothstep(U.threshold, U.threshold * 3.0 + 0.05, len) * smoothstep(U.coherence - 0.15, U.coherence + 0.15, steady);
  m.dir = atan2(m.vel.y, m.vel.x) / 6.2831853;
  m.near = f.b;
  return m;
}
fn mouseSplat(uv: vec2f) -> f32 {
  if (U.mouseDown < 0.5) { return 0.0; }
  let aspect = U.screenW / max(U.screenH, 1.0);
  var d = uv - vec2f(U.mouseX / U.screenW, U.mouseY / U.screenH);
  d.x *= aspect;
  return exp(-dot(d, d) / (U.splatRadius * U.splatRadius));
}
fn mouseVel() -> vec2f { return vec2f(U.mouseDX / U.screenW, U.mouseDY / U.screenH) * simSize(); }

// ---- forces: texA velocity, texB flow
@compute @workgroup_size(8, 8)
fn force(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  var v = ldA(p).xy;
  let m = motionAt(uv);
  v = mix(v, m.vel, m.w * (1.0 - exp(-U.force * U.dt)));
  v = mix(v, mouseVel(), mouseSplat(uv));
  textureStore(outTex, p, vec4f(v, 0.0, 1.0));
}

// neon: cyan, blue, violet, magenta, pink and back. Never passes yellow or green, which turn into
// olive and brown when the dye fades.
fn neon(x: f32) -> vec3f {
  let tri = abs(fract(x) * 2.0 - 1.0);
  return hsv(0.5 + 0.47 * tri, 0.8, 1.0);
}

// dir: direction of the motion (0..1 around the circle), near: nearness of what moves
fn dyeColor(dir: f32, near: f32) -> vec3f {
  let t = U.time * U.hueSpeed;
  let mode = i32(U.colorMode + 0.5);
  if (mode == 0) { return neon(dir + t); }
  if (mode == 1) { return hsv(dir + t, 0.85, 1.0); }
  if (mode == 2) { return neon(near * 1.2 + t); }
  return vec3f(U.tintR, U.tintG, U.tintB);
}

// ---- dye injection: texA dye, texB flow
@compute @workgroup_size(8, 8)
fn dye(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let m = motionAt(uv);
  // blend towards the color instead of adding it: moving longer in one place does not burn out to white
  var c = mix(ldA(p).rgb, dyeColor(m.dir, m.near) * U.dyeAmount, saturate(m.w * 15.0 * U.dt));
  let mv = mouseVel();
  let mouseColor = dyeColor(atan2(mv.y, mv.x) / 6.2831853, 1.0) * U.dyeAmount;
  c = mix(c, mouseColor, saturate(mouseSplat(uv) * 15.0 * U.dt));
  textureStore(outTex, p, vec4f(c, 1.0));
}

// ---- curl of velocity (texA)
@compute @workgroup_size(8, 8)
fn curl(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let L = ldA(p - vec2i(1, 0)).y; let R = ldA(p + vec2i(1, 0)).y;
  let B = ldA(p - vec2i(0, 1)).x; let T = ldA(p + vec2i(0, 1)).x;
  textureStore(outTex, p, vec4f(0.5 * (R - L - T + B), 0.0, 0.0, 1.0));
}

// ---- vorticity confinement: texA velocity, texB curl
@compute @workgroup_size(8, 8)
fn vorticity(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let L = ldB(p - vec2i(1, 0)).x; let R = ldB(p + vec2i(1, 0)).x;
  let B = ldB(p - vec2i(0, 1)).x; let T = ldB(p + vec2i(0, 1)).x;
  let C = ldB(p).x;
  var f = 0.5 * vec2f(abs(T) - abs(B), abs(R) - abs(L));
  f = f / (length(f) + 0.0001) * U.curl * C;
  f.y = -f.y;
  let v = clamp(ldA(p).xy + f * U.dt, vec2f(-3000.0), vec2f(3000.0));
  textureStore(outTex, p, vec4f(v, 0.0, 1.0));
}

// ---- divergence of velocity (texA), walls reflect
@compute @workgroup_size(8, 8)
fn divergence(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(outTex));
  if (i32(id.x) >= size.x || i32(id.y) >= size.y) { return; }
  let p = vec2i(id.xy);
  let C = ldA(p).xy;
  var L = ldA(p - vec2i(1, 0)).x; var R = ldA(p + vec2i(1, 0)).x;
  var B = ldA(p - vec2i(0, 1)).y; var T = ldA(p + vec2i(0, 1)).y;
  if (p.x == 0) { L = -C.x; }
  if (p.x == size.x - 1) { R = -C.x; }
  if (p.y == 0) { B = -C.y; }
  if (p.y == size.y - 1) { T = -C.y; }
  textureStore(outTex, p, vec4f(0.5 * (R - L + T - B), 0.0, 0.0, 1.0));
}

// ---- pressure: start from a faded copy of the last solution (texA)
@compute @workgroup_size(8, 8)
fn pressureFade(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(outTex, vec2i(id.xy), vec4f(ldA(vec2i(id.xy)).x * U.pressureDecay, 0.0, 0.0, 1.0));
}

// ---- one Jacobi step: texA pressure, texB divergence
@compute @workgroup_size(8, 8)
fn jacobi(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let s = ldA(p - vec2i(1, 0)).x + ldA(p + vec2i(1, 0)).x + ldA(p - vec2i(0, 1)).x + ldA(p + vec2i(0, 1)).x;
  textureStore(outTex, p, vec4f((s - ldB(p).x) * 0.25, 0.0, 0.0, 1.0));
}

// ---- make velocity divergence free: texA velocity, texB pressure
@compute @workgroup_size(8, 8)
fn gradient(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let g = vec2f(ldB(p + vec2i(1, 0)).x - ldB(p - vec2i(1, 0)).x, ldB(p + vec2i(0, 1)).x - ldB(p - vec2i(0, 1)).x);
  textureStore(outTex, p, vec4f(ldA(p).xy - 0.5 * g, 0.0, 1.0));
}

// ---- advection, step 1 (semi-Lagrangian): texA velocity, texB the field -> forward estimate
@compute @workgroup_size(8, 8)
fn advect(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let back = uv - U.dt * textureSampleLevel(texA, samp, uv, 0.0).xy / simSize();
  textureStore(outTex, p, textureSampleLevel(texB, samp, back, 0.0));
}

// ---- advection, step 2 (MacCormack): texA velocity, texB forward estimate, texC the field before.
// Carries the estimate back, corrects by half the error, clamps to the values step 1 interpolated.
fn maccormack(p: vec2i, size: vec2u) -> vec4f {
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let step = U.dt * textureSampleLevel(texA, samp, uv, 0.0).xy / simSize();
  let there = ldB(p);
  let andBack = textureSampleLevel(texB, samp, uv + step, 0.0);
  let r = there + 0.5 * (ldC(p) - andBack);
  let i = vec2i(floor((uv - step) * vec2f(size) - 0.5));
  let a = ldC(i); let b = ldC(i + vec2i(1, 0)); let c = ldC(i + vec2i(0, 1)); let d = ldC(i + vec2i(1, 1));
  return clamp(r, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
}

// velocity stays semi-Lagrangian: its slight smoothing keeps vorticity confinement from amplifying
// grid-sized noise
@compute @workgroup_size(8, 8)
fn advectVel(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let back = uv - U.dt * ldA(p).xy / simSize();
  let v = textureSampleLevel(texA, samp, back, 0.0).xy / (1.0 + U.velDiss * U.dt);
  textureStore(outTex, p, vec4f(v, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn maccormackDye(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let c = maccormack(vec2i(id.xy), size).rgb;
  // exponential fading plus a small linear part: faint traces end in clean black instead of a haze
  let faded = max(c / (1.0 + U.dyeDiss * U.dt) - vec3f(U.fade * U.dt), vec3f(0.0));
  textureStore(outTex, vec2i(id.xy), vec4f(faded, 1.0));
}

// ---- display: texA dye, texB flow, prepTex
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn display(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / vec2f(U.screenW, U.screenH);
  let k = toKinect(uv);
  // soft glow along depth edges of near things (people), far edges (furniture, walls) stay dark.
  // The nearness is blurred first (4 bilinear taps over 3 depth pixels), otherwise the edge shows
  // the staircase of the depth pixels. fwidth must not sit inside a branch.
  let kt = 1.5 / KINECT_SIZE;
  let near = 0.25 * (textureSampleLevel(prepTex, samp, k + vec2f(-kt.x, -kt.y), 0.0).r + textureSampleLevel(prepTex, samp, k + vec2f(kt.x, -kt.y), 0.0).r
    + textureSampleLevel(prepTex, samp, k + vec2f(-kt.x, kt.y), 0.0).r + textureSampleLevel(prepTex, samp, k + vec2f(kt.x, kt.y), 0.0).r);
  let edge = saturate(fwidth(near) * 8.0) * smoothstep(0.15, 0.5, near) * select(0.0, 1.0, inImage(k));

  var c = textureSampleLevel(texA, samp, uv, 0.0).rgb;
  // relief shading from the dye density, over about 3 screen pixels whatever the dye resolution
  let t = 1.5 / vec2f(U.screenW, U.screenH);
  let l = length(textureSampleLevel(texA, samp, uv - vec2f(t.x, 0.0), 0.0).rgb);
  let r = length(textureSampleLevel(texA, samp, uv + vec2f(t.x, 0.0), 0.0).rgb);
  let b = length(textureSampleLevel(texA, samp, uv - vec2f(0.0, t.y), 0.0).rgb);
  let tp = length(textureSampleLevel(texA, samp, uv + vec2f(0.0, t.y), 0.0).rgb);
  let n = normalize(vec3f(r - l, tp - b, 0.3));
  let diffuse = clamp(dot(n, normalize(vec3f(-0.4, -0.5, 1.0))) + 0.25, 0.5, 1.2);
  c *= mix(1.0, diffuse, U.shading);
  c = 1.0 - exp(-c * U.exposure);
  c += vec3f(0.7, 0.85, 1.0) * edge * U.silhouette;

  if (U.showFlow > 0.5 && inImage(k)) {
    // what drives the fluid: direction as hue, faint below the threshold, strong above it
    let m = motionAt(uv);
    let raw = saturate(length(textureSampleLevel(texB, samp, k, 0.0).rg) / max(U.threshold, 0.01));
    c = mix(c, hsv(m.dir, 1.0, 1.0), max(raw * 0.25, m.w * 0.9));
  }
  return vec4f(c, 1.0);
}
