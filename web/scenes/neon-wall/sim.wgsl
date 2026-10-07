// The wall: motion field, stable fluids (after Stam / Dobryakov) and display. Everything here lives
// in wall uv (0..1, y down): the wall image and motion from kinect.wgsl, the simulation and the dye
// (one texel per LED). Velocity is in simulation cells per second; dye is linear color, advected
// with MacCormack so that filaments stay crisp.
@group(0) @binding(1) var texA: texture_2d<f32>;
@group(0) @binding(2) var texB: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var texC: texture_2d<f32>;
@group(0) @binding(11) var statsTex: texture_2d<f32>; // dyeStats: r fill, g balance gain

fn ldA(p: vec2i) -> vec4f { return textureLoad(texA, clamp(p, vec2i(0), vec2i(textureDimensions(texA)) - 1), 0); }
fn ldB(p: vec2i) -> vec4f { return textureLoad(texB, clamp(p, vec2i(0), vec2i(textureDimensions(texB)) - 1), 0); }
fn ldC(p: vec2i) -> vec4f { return textureLoad(texC, clamp(p, vec2i(0), vec2i(textureDimensions(texC)) - 1), 0); }
fn simSize() -> vec2f { return vec2f(U.simW, U.simH); }
// > 1 while little is going on on the wall (more dye, slower fading, stronger push), < 1 while it is
// full (less dye, faster fading): keeps contrast and structure in both cases
fn balance() -> f32 {
  let g = textureLoad(statsTex, vec2i(0), 0).g;
  return select(1.0, g, U.balanceOn > 0.5 && g > 0.0);
}

// ---- how full the wall is: texA dye, texB previous stats (1x1). One workgroup of 256 threads looks
// at every 4th LED in both directions. out (1x1): r fill (smoothed), g balance gain (smoothed), b fill now
var<workgroup> partFill: array<f32, 256>;
@compute @workgroup_size(16, 16)
fn dyeStats(@builtin(local_invocation_index) li: u32) {
  let size = vec2u(textureDimensions(texA)) / 4u;
  let n = size.x * size.y;
  var fill = 0.0;
  for (var i = li; i < n; i += 256u) {
    let c = textureLoad(texA, vec2u(i % size.x, i / size.x) * 4u + 2u, 0).rgb;
    fill += step(0.25, 1.0 - exp(-max(c.r, max(c.g, c.b)) * U.exposure));
  }
  partFill[li] = fill;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride >>= 1u) {
    if (li < stride) { partFill[li] += partFill[li + stride]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    let now = partFill[0] / f32(n);
    let prev = textureLoad(texB, vec2i(0), 0);
    let gain0 = select(prev.g, 1.0, prev.g <= 0.0);
    let wanted = clamp(pow(U.fillTarget / max(now, 0.02), 0.7), 0.35, 2.5);
    // down fast, up slowly: an empty wall winds the gain up, and the first people should not flood it
    let rate = select(0.03, 0.15, wanted < gain0);
    textureStore(outTex, vec2i(0), vec4f(mix(prev.r, now, 0.1), mix(gain0, wanted, rate), now, 1.0));
  }
}

// ---- wall image for colors and the people overlay: texA collect output, texB previous.
// Gaussian 5x5, averaged with the previous frame. out: r now, g before, b slot of the nearest person
@compute @workgroup_size(8, 8)
fn wallSignal(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  var sum = 0.0;
  var wsum = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let w = exp(-f32(x * x + y * y) / 3.0);
      sum += w * ldA(p + vec2i(x, y)).g;
      wsum += w;
    }
  }
  let before = ldB(p).r;
  textureStore(outTex, p, vec4f(mix(sum / wsum, before, U.wallSmooth), before, ldA(p).b, 0.0));
}

// ---- wall motion: texA vcollect body motion, texC arm motion. Gaussian 7x7 over the cells that got
// samples (far away the samples are sparser than the cells). Arms are thin: few cells, so little push,
// however fast they wave. Their motion spreads over armBrush meters on the wall, like a wing.
// out: rg velocity (m/s, y down), b 3D speed, a coverage
@compute @workgroup_size(8, 8)
fn wallMotion(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  var sum = vec3f(0.0);
  var wsum = 0.0;
  var gsum = 0.0;
  for (var y = -3; y <= 3; y++) {
    for (var x = -3; x <= 3; x++) {
      let g = exp(-f32(x * x + y * y) / 4.5);
      let s = ldA(p + vec2i(x, y));
      sum += g * s.a * s.rgb;
      wsum += g * s.a;
      gsum += g;
    }
  }
  let r = i32(clamp(U.armBrush * U.gridH / U.wallH, 1.0, 10.0));
  var asum = vec3f(0.0);
  var aw = 0.0;
  var ag = 0.0;
  for (var y = -r; y <= r; y++) {
    for (var x = -r; x <= r; x++) {
      let d2 = f32(x * x + y * y);
      if (d2 > f32(r * r)) { continue; }
      let g = exp(-2.0 * d2 / f32(r * r));
      let s = ldC(p + vec2i(x, y));
      asum += g * s.a * s.rgb;
      aw += g * s.a;
      ag += g;
    }
  }
  if (aw > 0.0) {
    // a thin arm in the band already counts like a fully covered cell
    let wa = min(1.0, 4.0 * aw / ag) * gsum;
    sum += wa * asum / aw;
    wsum += wa;
  }
  textureStore(outTex, p, vec4f(sum / max(wsum, 0.0001), wsum / gsum));
}

// wall motion (texB) at wall uv -> velocity in sim cells/s, a weight for pushing (sideways motion)
// and one for dye (3D speed: walking towards the wall colors too, but pushes nothing)
struct Motion { vel: vec2f, push: f32, paint: f32, dir: f32, speed: f32, speed3: f32 };
fn motionAt(uv: vec2f) -> Motion {
  var m = Motion(vec2f(0.0), 0.0, 0.0, 0.0, 0.0, 0.0);
  let s = textureSampleLevel(texB, samp, uv, 0.0);
  let cover = smoothstep(0.15, 0.6, s.a) * U.motionOn;
  m.speed = length(s.rg);
  m.vel = s.rg / vec2f(U.wallW, U.wallH) * simSize() * U.flowGain;
  m.push = smoothstep(U.threshold, U.threshold * 3.0 + 0.1, m.speed) * cover;
  m.paint = smoothstep(U.threshold, U.threshold * 3.0 + 0.1, s.b) * cover;
  m.dir = atan2(s.g, s.r) / 6.2831853;
  m.speed3 = s.b;
  return m;
}
fn mouseSplat(uv: vec2f) -> f32 {
  if (U.mouseDown < 0.5) { return 0.0; }
  var d = uv - vec2f(U.mouseX, U.mouseY);
  d.x *= U.dyeW / U.dyeH;
  return exp(-dot(d, d) / (U.splatRadius * U.splatRadius));
}
fn mouseVel() -> vec2f { return vec2f(U.mouseDX, U.mouseDY) * simSize(); }

// ---- forces: texA velocity, texB wall motion
@compute @workgroup_size(8, 8)
fn force(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  var v = ldA(p).xy;
  let m = motionAt(uv);
  v = mix(v, m.vel, m.push * (1.0 - exp(-U.force * clamp(balance(), 0.7, 2.0) * U.dt)));
  v = mix(v, mouseVel(), mouseSplat(uv));
  textureStore(outTex, p, vec4f(v, 0.0, 1.0));
}

// dir: direction of the motion (0..1 around the circle), near: nearness of what moves, slot: whose,
// speed: m/s (faster motion shifts the hue a little, so a busy wall does not turn into one color)
fn dyeColor(dir: f32, near: f32, slot: u32, speed: f32) -> vec3f {
  let t = U.time * U.hueSpeed + speed * U.hueBySpeed;
  let mode = i32(U.colorMode + 0.5);
  if (mode == 0) { return neon(near * 1.2 + f32(slot) * U.personHue + t); }
  if (mode == 1) { return select(neon(near * 1.2 + t), person(slot).rgb, slot > 0u); }
  if (mode == 2) { return neon(dir + t); }
  if (mode == 3) { return hsv(dir + t, 0.85, 1.0); }
  return vec3f(U.tintR, U.tintG, U.tintB);
}

// ---- dye injection: texA dye, texB wall motion, texC wall image (wallSignal)
@compute @workgroup_size(8, 8)
fn dye(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let m = motionAt(uv);
  let near = textureSampleLevel(texC, samp, uv, 0.0).r;
  let slot = u32(ldC(vec2i(uv * vec2f(textureDimensions(texC)))).b + 0.5);
  // blend towards the color instead of adding it: moving longer in one place does not burn out to white
  var c = mix(ldA(p).rgb, dyeColor(m.dir, near, slot, m.speed3) * U.dyeAmount, saturate(m.paint * 15.0 * U.dt * balance()));
  let mv = mouseVel();
  let mouseColor = dyeColor(atan2(mv.y, mv.x) / 6.2831853, 0.8, 0u, 0.0) * U.dyeAmount;
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

// ---- velocity advection (semi-Lagrangian: its slight smoothing keeps vorticity confinement from
// amplifying grid-sized noise). texA velocity
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

// ---- dye advection, step 1 (semi-Lagrangian): texA velocity, texB dye -> forward estimate
@compute @workgroup_size(8, 8)
fn advect(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let back = uv - U.dt * textureSampleLevel(texA, samp, uv, 0.0).xy / simSize();
  textureStore(outTex, p, textureSampleLevel(texB, samp, back, 0.0));
}

// ---- dye advection, step 2 (MacCormack): texA velocity, texB forward estimate, texC dye before.
// Carries the estimate back, corrects by half the error, clamps to the values step 1 interpolated.
@compute @workgroup_size(8, 8)
fn maccormackDye(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(outTex);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy);
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let step = U.dt * textureSampleLevel(texA, samp, uv, 0.0).xy / simSize();
  let andBack = textureSampleLevel(texB, samp, uv + step, 0.0);
  let r = ldB(p) + 0.5 * (ldC(p) - andBack);
  let i = vec2i(floor((uv - step) * vec2f(size) - 0.5));
  let a = ldC(i); let b = ldC(i + vec2i(1, 0)); let c = ldC(i + vec2i(0, 1)); let d = ldC(i + vec2i(1, 1));
  let corrected = clamp(r, min(min(a, b), min(c, d)), max(max(a, b), max(c, d))).rgb;
  // exponential fading plus a small linear part: faint traces end in clean black instead of a haze
  let g = balance();
  let faded = max(corrected / (1.0 + U.dyeDiss / g * U.dt) - vec3f(U.fade / g * U.dt), vec3f(0.0));
  textureStore(outTex, p, vec4f(faded, 1.0));
}

// ---- display: texA dye, texB wall motion, texC wall image. The wall is shown fitted into the
// window (preview with a frame) or pixel exact at the top left (for the LED controller).
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

// wall rectangle on the canvas: xy offset, zw size in pixels
fn wallRect() -> vec4f {
  let led = vec2f(U.dyeW, U.dyeH);
  if (U.viewMode > 0.5) { return vec4f(0.0, 0.0, led); }
  let screen = vec2f(U.screenW, U.screenH);
  let size = led * min(screen.x / led.x, screen.y / led.y);
  return vec4f((screen - size) * 0.5, size);
}

// distance in canvas pixels from px to the stick figures of everyone on the wall; y = slot (0 = none)
fn skeletonDist(px: vec2f, r: vec4f) -> vec2f {
  var best = vec2f(1e9, 0.0);
  for (var s = 1u; s <= 16u; s++) {
    if (person(s).w < 0.5) { continue; }
    for (var b = 0u; b < BONE_COUNT; b++) {
      let a = joint(s, BONES[b].x);
      let c = joint(s, BONES[b].y);
      if (a.w <= 0.0 || c.w <= 0.0) { continue; }
      let pa = r.xy + wallUv(a.xy) * r.zw;
      let pc = r.xy + wallUv(c.xy) * r.zw;
      let ab = pc - pa;
      let t = saturate(dot(px - pa, ab) / max(dot(ab, ab), 1e-6));
      let d = length(px - (pa + t * ab));
      if (d < best.x) { best = vec2f(d, f32(s)); }
    }
  }
  return best;
}

@fragment fn display(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let r = wallRect();
  let uv = (pos.xy - r.xy) / r.zw;
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) {
    // outside the wall: dark grey, with a thin frame around the wall in the preview
    let outside = max(max(r.x - pos.x, pos.x - r.x - r.z), max(r.y - pos.y, pos.y - r.y - r.w));
    return vec4f(vec3f(select(0.04, 0.3, outside < 1.5 && U.viewMode < 0.5)), 1.0);
  }

  let t = 1.0 / vec2f(textureDimensions(texA));
  var c = textureSampleLevel(texA, samp, uv, 0.0).rgb;
  // relief shading from the dye density
  let l = length(textureSampleLevel(texA, samp, uv - vec2f(t.x, 0.0), 0.0).rgb);
  let rr = length(textureSampleLevel(texA, samp, uv + vec2f(t.x, 0.0), 0.0).rgb);
  let b = length(textureSampleLevel(texA, samp, uv - vec2f(0.0, t.y), 0.0).rgb);
  let tp = length(textureSampleLevel(texA, samp, uv + vec2f(0.0, t.y), 0.0).rgb);
  let n = normalize(vec3f(rr - l, tp - b, 0.3));
  let diffuse = clamp(dot(n, normalize(vec3f(-0.4, -0.5, 1.0))) + 0.25, 0.5, 1.2);
  c *= mix(1.0, diffuse, U.shading);
  c = 1.0 - exp(-c * U.exposure);

  if (U.showPeople > 0.5) {
    // the people, projected onto the wall, and a 1 m grid to check positions and sizes
    c += vec3f(0.35) * textureSampleLevel(texC, samp, uv, 0.0).r;
    let pxPerM = r.z / U.wallW;
    let m = vec2f((uv.x - 0.5) * U.wallW - U.camX, U.wallBottom + (1.0 - uv.y) * U.wallH);
    let dist = abs(fract(m + 0.5) - 0.5) * pxPerM;
    c += vec3f(0.12, 0.16, 0.2) * (1.0 - smoothstep(0.5, 1.5, min(dist.x, dist.y)));
  }
  if (U.showSkeleton > 0.5) {
    let sd = skeletonDist(pos.xy, r);
    if (sd.y > 0.0) { c = mix(c, person(u32(sd.y)).rgb, 1.0 - smoothstep(1.0, 2.5, sd.x)); }
  }
  if (U.showFlow > 0.5) {
    // what drives the fluid: direction as hue, faint below the threshold, strong above it
    let m = motionAt(uv);
    c = mix(c, hsv(m.dir, 1.0, 1.0), max(saturate(m.speed / max(U.threshold, 0.01)) * 0.25, m.push * 0.9));
  }
  return vec4f(c, 1.0);
}
