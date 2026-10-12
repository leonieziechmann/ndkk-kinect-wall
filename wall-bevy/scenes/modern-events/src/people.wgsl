// The people on the LED wall as LED dots in the Modern Events gradient (blue, violet, magenta across
// the wall), lighter along their outline. The dots sit on the same grid as the logo panel, so the
// people seen through a hole in the panel continue its dot pattern. Black everywhere else.
// wallPerson(uv): x covered 0..1, y m from the sensor, z slot, w infrared.

fn brand(t: f32) -> vec3f {
  let blue = vec3f(0.24, 0.36, 1.0);
  let violet = vec3f(0.58, 0.30, 1.0);
  let magenta = vec3f(1.0, 0.24, 0.62);
  return select(mix(violet, magenta, saturate(t * 2.0 - 1.0)), mix(blue, violet, saturate(t * 2.0)), t < 0.5);
}

fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let pitch = max(3.0, round(P.pitch));
  let c = (floor(pos / pitch) + 0.5) * pitch;
  let cuv = c / F.resolution;
  let e = vec2f(pitch) / F.resolution;
  let w = wallPerson(cuv);
  let on = step(0.5, w.x);
  // outline: dots whose neighbours are not all covered
  let nb = step(0.5, wallPersonMask(cuv + vec2f(e.x, 0.0))) + step(0.5, wallPersonMask(cuv - vec2f(e.x, 0.0)))
         + step(0.5, wallPersonMask(cuv + vec2f(0.0, e.y))) + step(0.5, wallPersonMask(cuv - vec2f(0.0, e.y)));
  let rim = on * step(nb, 3.5);

  // the gradient runs along the wall (as brand() in main.js); infrared gives the body some structure
  let t = cuv.x;
  let structure = mix(1.0, 0.45 + 1.1 * saturate(w.w), P.ir);
  var col = brand(t) * P.people * structure * on;
  col = mix(col, vec3f(1.0, 0.92, 1.0) * P.people, rim * P.rim);

  // the faint grid of all dots (an LED panel switched off), if wanted
  col = max(col, vec3f(0.07, 0.07, 0.16) * P.grid);

  let rad = pitch * P.dotSize * 0.5;
  let cover = clamp(rad - length(pos - c) + 0.5, 0.0, 1.0);
  return vec4f(col * cover, 1.0);
}
