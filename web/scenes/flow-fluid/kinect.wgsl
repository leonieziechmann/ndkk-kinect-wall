// Kinect -> cleaned nearness at full depth resolution, once per Kinect frame.
// r = nearness 0..1 (1 at nearM, 0 at farM and beyond), g = infrared brightness.
// Single pixels without a measurement are filled from their neighbours (they flicker at edges and
// would show up as motion); larger holes count as far away.
@group(0) @binding(1) var depthTex: texture_2d<f32>; // meters, 0 = no measurement
@group(0) @binding(2) var irTex: texture_2d<f32>;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba16float, write>;

fn nearness(d: f32) -> f32 { return saturate((U.farM - d) / max(U.farM - U.nearM, 0.01)); }

@compute @workgroup_size(8, 8)
fn prep(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(KINECT_SIZE);
  let p = vec2i(id.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let d = textureLoad(depthTex, p, 0).r;
  var near = nearness(d);
  if (d <= 0.1) {
    var sum = 0.0;
    var n = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = textureLoad(depthTex, clamp(p + vec2i(x, y), vec2i(0), size - 1), 0).r;
        if (q > 0.1) {
          sum += nearness(q);
          n += 1.0;
        }
      }
    }
    near = select(0.0, sum / max(n, 1.0), n >= 3.0);
  }
  textureStore(outTex, p, vec4f(near, textureLoad(irTex, p, 0).r, 0.0, 1.0));
}
