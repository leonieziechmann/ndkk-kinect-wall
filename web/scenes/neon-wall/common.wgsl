// Shared by every pass. struct Uni is generated from FIELDS in main.js and put in front of this.
@group(0) @binding(0) var<uniform> U: Uni;

const KINECT_FPS = 30.0;

// a vector in the Kinect camera frame (x right, y down, z forward) -> room axes:
// x right as seen on the wall (mirrored by xSign), down, forward (away from the wall)
fn roomAxes(v: vec3f) -> vec3f {
  let t = radians(U.camTilt);
  return vec3f(U.xSign * v.x, v.y * cos(t) + v.z * sin(t), v.z * cos(t) - v.y * sin(t));
}
// a point in the camera frame (m) -> wall frame: x = meters right of the wall center,
// y = height above the floor, z = distance in front of the camera
fn toWall(cam: vec3f) -> vec3f {
  let r = roomAxes(cam);
  return vec3f(r.x + U.camX, U.camH - r.y, r.z);
}
// wall frame (x, height) -> wall uv: 0..1, y down
fn wallUv(xh: vec2f) -> vec2f {
  return vec2f(xh.x / U.wallW + 0.5, (U.wallBottom + U.wallH - xh.y) / U.wallH);
}
fn nearness(d: f32) -> f32 { return saturate((U.zoneFar - d) / max(U.zoneFar - U.zoneNear, 0.01)); }

fn hsv(h: f32, s: f32, v: f32) -> vec3f {
  let k = fract(vec3f(h) + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0;
  return v * mix(vec3f(1.0), saturate(abs(k) - 1.0), s);
}
// neon: cyan, blue, violet, magenta, pink and back. Never passes yellow or green, which turn into
// olive and brown when the dye fades.
fn neon(x: f32) -> vec3f {
  let tri = abs(fract(x) * 2.0 - 1.0);
  return hsv(0.5 + 0.47 * tri, 0.8, 1.0);
}
