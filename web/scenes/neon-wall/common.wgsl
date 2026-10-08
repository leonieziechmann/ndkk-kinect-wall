// Shared by every pass. struct Uni and the constants BONES, BONE_COUNT, POINT_COUNT, ARM_BONES are
// generated in main.js and put in front of this.
@group(0) @binding(0) var<uniform> U: Uni;
// main.js writes it whenever the person tracking has a new result:
//   [0..3]                                  the room matrix (columns, world -> room: floor y = 0, y up, z forward)
//   SKEL_JOINTS + slot * POINT_COUNT + j    room position of point j (m), confidence (0 = not seen)
//   SKEL_PERSONS + slot                     color rgb, 1 if visible
//   SKEL_PLACE + slot                       body center: room x (m), its velocity x (m/s)
@group(0) @binding(10) var<storage, read> skel: array<vec4f>;

const KINECT_FPS = 30.0;
const SKEL_JOINTS = 4u;
const SKEL_PERSONS = SKEL_JOINTS + 17u * POINT_COUNT;
const SKEL_PLACE = SKEL_PERSONS + 17u;

fn roomMatrix() -> mat4x4f { return mat4x4f(skel[0], skel[1], skel[2], skel[3]); }
fn toRoom(world: vec3f) -> vec3f { return (roomMatrix() * vec4f(world, 1.0)).xyz; }
fn roomVector(world: vec3f) -> vec3f { return (roomMatrix() * vec4f(world, 0.0)).xyz; }
fn joint(slot: u32, j: u32) -> vec4f { return skel[SKEL_JOINTS + slot * POINT_COUNT + j]; }
fn person(slot: u32) -> vec4f { return skel[SKEL_PERSONS + slot]; }
fn place(slot: u32) -> vec4f { return skel[SKEL_PLACE + slot]; }

// Room -> wall. The wall is a mirror: everyone sees themselves on their own side (wallSign, from the
// param and the view's xSign). Walking is stretched: a person's body center moves `stretch` times as
// far on the wall as in the room, so the sensor's view spans the whole wall. The body keeps its size.
// room x of a point of person `slot` -> wall x (m, from the wall's center, right as the viewer sees it)
fn wallX(x: f32, slot: u32) -> f32 { return U.camX + U.wallSign * (x + (U.stretch - 1.0) * place(slot).x); }
// room velocity x of a point of person `slot` -> wall velocity x (m/s): the stretched walk moves along
fn wallVx(vx: f32, slot: u32) -> f32 { return U.wallSign * (vx + (U.stretch - 1.0) * place(slot).y); }
// room (x, height above the floor) of a point of person `slot` -> wall uv: 0..1, y down
fn wallUv(xh: vec2f, slot: u32) -> vec2f {
  return vec2f(wallX(xh.x, slot) / U.wallW + 0.5, (U.wallBottom + U.wallH - xh.y) / U.wallH);
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
