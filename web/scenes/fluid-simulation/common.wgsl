// Shared by every pass. struct Uni, the constants BONES, BONE_COUNT, POINT_COUNT, ARM_BONES and the
// wall (WALL, wallFromRoom(), wallVelocity(), wallUv(), wallNear(), ...: /lib/wall.js, WALL.md) are
// generated in main.js and put in front of this. Room -> wall is the shared mapping: mirrored, the
// walk stretched by the wall setup (each person shifted as a whole by WALL.slots[slot]).
@group(0) @binding(0) var<uniform> U: Uni;
// main.js writes it whenever the person tracking has a new result:
//   slot * POINT_COUNT + j    room position of point j (m), confidence (0 = not seen)
//   SKEL_PERSONS + slot       color rgb, 1 if visible
@group(0) @binding(10) var<storage, read> skel: array<vec4f>;

const KINECT_FPS = 30.0;
const SKEL_PERSONS = 17u * POINT_COUNT;

fn joint(slot: u32, j: u32) -> vec4f { return skel[slot * POINT_COUNT + j]; }
fn person(slot: u32) -> vec4f { return skel[SKEL_PERSONS + slot]; }
// world vector (velocity) -> room
fn roomVector(world: vec3f) -> vec3f { return (WALL.room * vec4f(world, 0.0)).xyz; }

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
