// Shared by every pass: uniforms (written by main.js in this exact order) and Kinect <-> screen mapping.
struct Uni {
  simW: f32, simH: f32, dyeW: f32, dyeH: f32,
  screenW: f32, screenH: f32, mouseX: f32, mouseY: f32,
  mouseDX: f32, mouseDY: f32, mouseDown: f32, dt: f32,
  time: f32, xSign: f32, curl: f32, velDiss: f32,
  dyeDiss: f32, force: f32, dyeAmount: f32, threshold: f32,
  flowSmooth: f32, nearM: f32, farM: f32, colorMode: f32,
  hueSpeed: f32, silhouette: f32, pressureDecay: f32, shading: f32,
  flowGain: f32, irMix: f32, showFlow: f32, exposure: f32,
  tintR: f32, tintG: f32, tintB: f32, splatRadius: f32,
  lambda: f32, fade: f32, coherence: f32, pad: f32,
};
@group(0) @binding(0) var<uniform> U: Uni;

const KINECT_SIZE = vec2f(512.0, 424.0);
const KINECT_FPS = 30.0;

// screen uv -> depth image uv before mirroring: the image covers the screen
fn coverScale() -> vec2f {
  let screen = U.screenW / max(U.screenH, 1.0);
  let image = KINECT_SIZE.x / KINECT_SIZE.y;
  return select(vec2f(screen / image, 1.0), vec2f(1.0, image / screen), screen > image);
}
fn toKinect(uv: vec2f) -> vec2f {
  var k = (uv - 0.5) * coverScale() + 0.5;
  if (U.xSign < 0.0) { k.x = 1.0 - k.x; }
  return k;
}
// a displacement in depth image uv -> the same displacement in screen uv
fn kinectDeltaToScreen(dk: vec2f) -> vec2f {
  var d = dk / coverScale();
  if (U.xSign < 0.0) { d.x = -d.x; }
  return d;
}
fn inImage(k: vec2f) -> bool { return all(k >= vec2f(0.0)) && all(k <= vec2f(1.0)); }

fn hsv(h: f32, s: f32, v: f32) -> vec3f {
  let k = fract(vec3f(h) + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0;
  return v * mix(vec3f(1.0), saturate(abs(k) - 1.0), s);
}
