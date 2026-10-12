// Stick figures of the tracked persons in their slot colors: crisp lines, joints as dots, glowing
// hands, short trails; optionally their silhouettes. Uses skeletonDist(), personJointUv(), J_...,
// personMask() and personColor() (see /lib/shader-pass.js and PERSONS.md).

// distance in screen pixels from the fragment to a point of a person (depth image uv)
fn pointPx(k: vec2f, p: vec4f, scale: f32) -> f32 {
  return length((k - p.xy) * KINECT_SIZE) / scale;
}

fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let k = kinectUv(uv);
  // depth image pixels per screen pixel (derivatives outside any branch)
  let scale = max(fwidth(k.x * KINECT_SIZE.x), 1e-4);
  let m = personMask(k);
  if (!inImage(k)) { return vec4f(0.0, 0.0, 0.0, 1.0); }

  // trails: what was drawn fades out (a moving arm leaves a short streak)
  var col = prev(uv).rgb * P.trails;

  // silhouettes (Silhouette, Beides)
  if (P.mode >= 1.0) {
    col = max(col, personColor(personAt(k)) * m * P.fill);
  }

  // stick figures (Skelett, Beides)
  if (P.mode != 1.0) {
    let sd = skeletonDist(k);
    if (sd.y > 0.0) {
      let tint = personColor(u32(sd.y));
      let d = sd.x / scale; // screen pixels to the nearest bone
      let core = 1.0 - smoothstep(P.line, P.line + 1.0, d);
      let glow = exp(-d / (2.0 + 10.0 * P.glow)) * P.glow;
      col = max(col, tint * (core + 0.8 * glow));
    }
    // joints as dots, the hands as glowing discs
    for (var s = 1u; s <= PERSON_SLOTS; s++) {
      if (!personVisible(s)) { continue; }
      let box = personBox(s);
      let margin = (P.hands + 20.0) * scale / KINECT_SIZE;
      if (any(k < box.xy - margin) || any(k > box.zw + margin)) { continue; }
      let tint = personColor(s);
      for (var j = 0u; j < J_CENTER; j++) {
        let p = personJointUv(s, j);
        if (p.w <= 0.0 || (j < J_LEFT_SHOULDER && j != J_NOSE)) { continue; } // the face: just the nose
        let d = pointPx(k, p, scale);
        let hand = j == J_LEFT_HAND || j == J_RIGHT_HAND;
        let r = select(P.dots, P.hands, hand);
        let disc = 1.0 - smoothstep(r - 1.0, r, d);
        let halo = select(0.0, exp(-max(d - r, 0.0) / (3.0 + 12.0 * P.glow)) * P.glow, hand);
        col = max(col, mix(tint, vec3f(1.0), 0.55) * disc + tint * halo);
      }
    }
  }
  return vec4f(col, 1.0);
}
