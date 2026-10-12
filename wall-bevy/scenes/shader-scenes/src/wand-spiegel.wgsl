// The people on the LED wall (uv = the LED image). wallPerson(uv): x covered 0..1 (soft edge),
// y distance from the sensor (m), z slot, w infrared. WALL: the setup (zone, size, ...).
// Only light on black: crisp outlines, a soft glow around them, trails that rise like smoke.

fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let w = wallPerson(uv);
  let m = w.x;
  let edge = saturate(fwidth(m) * 2.2); // outline: where the mask changes (outside any branch)
  let px = 1.0 / F.resolution;

  // color by distance: near the sensor warm pink, far away blue
  let near = saturate((WALL.far - w.y) / max(WALL.far - WALL.near, 0.01));
  let tint = mix(P.farColor, P.nearColor, near);

  // glow: the mask around, a few taps on a ring
  var halo = 0.0;
  for (var i = 0; i < 8; i++) {
    let a = f32(i) * 0.785398;
    halo += wallPersonMask(uv + vec2f(cos(a), sin(a)) * px * 7.0);
  }
  halo = halo / 8.0 * (1.0 - m);

  let body = tint * m * P.fill * mix(1.0, 0.35 + 1.4 * w.w, P.ir);
  var col = body + tint * edge * P.outline + tint * halo * P.glow * 0.6;

  // trails: the previous picture, faded and shifted upwards
  let before = prev(uv + vec2f(0.0, P.rise) * px).rgb * P.trail;
  col = max(col, before * (1.0 - m * 0.7));
  return vec4f(col, 1.0);
}
