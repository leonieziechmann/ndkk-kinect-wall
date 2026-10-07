// Only the people: each in the color of its slot, with relief from the depth, infrared detail and a
// glowing outline; the room at most as a faint ghost. Available: F.*, P.*, kinectUv, depthAt,
// irAt, personAt, isPerson, personMask, personDepthAt, personColor, ... (see /lib/shader-pass.js).

// slot of the person at k, or of a neighbor (for the soft edge outside the mask)
fn slotNear(k: vec2f) -> u32 {
  let o = vec2f(1.0) / KINECT_SIZE;
  var s = personAt(k);
  s = max(s, personAt(k + vec2f(o.x, 0.0)));
  s = max(s, personAt(k - vec2f(o.x, 0.0)));
  s = max(s, personAt(k + vec2f(0.0, o.y)));
  s = max(s, personAt(k - vec2f(0.0, o.y)));
  return s;
}

fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let k = kinectUv(uv);
  let m = personMask(k);
  let mw = fwidth(m); // outline: where the mask changes (outside any branch)
  if (!inImage(k)) { return vec4f(0.0, 0.0, 0.0, 1.0); }

  // background: dark; the room as the infrared camera image if wanted (to set up the sensor)
  let ghost = irAt(k) * P.room;
  var col = vec3f(0.012, 0.016, 0.026) + vec3f(0.8, 0.85, 0.9) * ghost;

  let slot = slotNear(k);
  if (slot > 0u) {
    // relief: normal from the person depth around k (only where neighbors are persons too)
    let o = vec2f(1.5) / KINECT_SIZE;
    let z = personDepthAt(k);
    let zx = personDepthAt(k + vec2f(o.x, 0.0)) - personDepthAt(k - vec2f(o.x, 0.0));
    let zy = personDepthAt(k + vec2f(0.0, o.y)) - personDepthAt(k - vec2f(0.0, o.y));
    let ok = z > 0.0 && abs(zx) < 0.08 && abs(zy) < 0.08;
    let pxm = 1.5 * z / 365.0; // size of 1.5 pixels in meters at that depth
    let n = normalize(vec3f(select(0.0, -zx * F.xSign * -1.0, ok), select(0.0, zy, ok), 2.0 * max(pxm, 0.002)));
    let light = normalize(vec3f(-0.4, -0.5, 0.75));
    let lit = mix(1.0, 0.35 + 0.85 * max(dot(n, light), 0.0), P.shading);
    let tint = personColor(slot);
    let detail = mix(1.0, 0.55 + 0.9 * irAt(k), P.ir);
    var body = tint * lit * detail;
    // rim: brighter towards the silhouette
    let rim = 1.0 - smoothstep(0.0, 0.6, abs(n.z) - 0.4);
    body += tint * rim * 0.35;
    col = mix(col, body, m);
    // glowing outline
    let edge = saturate(mw * 1.6) * P.outline;
    col += tint * edge * 1.4;
  }
  return vec4f(col, 1.0);
}
