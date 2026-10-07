// Glow and the soft reflection: downsample (factor dir.z) and separable Gaussian blur, rgb.

@vertex
fn vsFull(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;
@group(0) @binding(2) var<uniform> dir: vec4f; // blur direction in texels (xy); z: downsample factor

@fragment
fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = (floor(fc.xy) * dir.z + dir.z * 0.5) / size; // center of the source block
  let o = 1.0 / size;
  let s = textureSampleLevel(src, srcSamp, uv + vec2f(-o.x, -o.y), 0.0).rgb
        + textureSampleLevel(src, srcSamp, uv + vec2f(o.x, -o.y), 0.0).rgb
        + textureSampleLevel(src, srcSamp, uv + vec2f(-o.x, o.y), 0.0).rgb
        + textureSampleLevel(src, srcSamp, uv + vec2f(o.x, o.y), 0.0).rgb;
  return vec4f(s * 0.25, 1.0);
}

@fragment
fn fsBlur(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let uv = fc.xy / size;
  let d = dir.xy / size;
  var s = textureSampleLevel(src, srcSamp, uv, 0.0).rgb * 0.2270270270;
  s += (textureSampleLevel(src, srcSamp, uv + d * 1.3846153846, 0.0).rgb
      + textureSampleLevel(src, srcSamp, uv - d * 1.3846153846, 0.0).rgb) * 0.3162162162;
  s += (textureSampleLevel(src, srcSamp, uv + d * 3.2307692308, 0.0).rgb
      + textureSampleLevel(src, srcSamp, uv - d * 3.2307692308, 0.0).rgb) * 0.0702702703;
  return vec4f(s, 1.0);
}
