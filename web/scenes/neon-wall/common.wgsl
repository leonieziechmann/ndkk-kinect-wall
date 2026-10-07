// Shared by every pass. struct Uni and the constants BONES, BONE_COUNT, POINT_COUNT, ARM_BONES are
// generated in main.js and put in front of this.
@group(0) @binding(0) var<uniform> U: Uni;
// main.js writes it whenever the person tracking has a new result:
//   [0..3]                                  the room matrix (columns, world -> room: floor y = 0, y up, z forward)
//   SKEL_JOINTS + slot * POINT_COUNT + j    room position of point j (m), confidence (0 = not seen)
//   SKEL_PERSONS + slot                     color rgb, 1 if visible
@group(0) @binding(10) var<storage, read> skel: array<vec4f>;

const KINECT_FPS = 30.0;
const SKEL_JOINTS = 4u;
const SKEL_PERSONS = SKEL_JOINTS + 17u * POINT_COUNT;

fn roomMatrix() -> mat4x4f { return mat4x4f(skel[0], skel[1], skel[2], skel[3]); }
fn toRoom(world: vec3f) -> vec3f { return (roomMatrix() * vec4f(world, 1.0)).xyz; }
fn roomVector(world: vec3f) -> vec3f { return (roomMatrix() * vec4f(world, 0.0)).xyz; }
fn joint(slot: u32, j: u32) -> vec4f { return skel[SKEL_JOINTS + slot * POINT_COUNT + j]; }
fn person(slot: u32) -> vec4f { return skel[SKEL_PERSONS + slot]; }

// room (x right, height above the floor) -> wall uv: 0..1, y down
fn wallUv(xh: vec2f) -> vec2f {
  return vec2f((xh.x + U.camX) / U.wallW + 0.5, (U.wallBottom + U.wallH - xh.y) / U.wallH);
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
