// Called once per pixel. pos: pixel, uv: 0..1 on the screen (y down). Available: F.*, P.*,
// kinectUv, depthAt, depthSmooth, irAt, pointAt, inImage, prev (see /lib/shader-pass.js).
fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let k = kinectUv(uv);
  let d = depthSmooth(k); // meters, 0 = no measurement
  let valid = d > 0.3 && inImage(k);

  // contour lines every P.spacing meters, drifting with time
  let x = d / P.spacing - F.time * P.speed;
  let dist = abs(fract(x + 0.5) - 0.5); // 0 on a line, 0.5 between two lines
  let aa = max(fwidth(x), 0.0001);
  let line = 1.0 - smoothstep(P.lineWidth * 0.5, P.lineWidth * 0.5 + aa, dist);

  let tint = mix(P.nearColor, P.farColor, saturate((d - 0.6) / 3.5));
  var col = tint * line + vec3f(irAt(k) * P.irFill);
  col = select(vec3f(0.0), col, valid);

  // trails: the previous frame, a bit darker
  col = max(col, prev(uv).rgb * P.trail);
  return vec4f(col, 1.0);
}
