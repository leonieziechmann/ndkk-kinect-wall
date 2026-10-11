# Porting a browser scene to wall-bevy

A scene of `web/scenes/<name>/` becomes `wall-bevy/src/scenes/<name_with_underscores>/` (a Rust
module) with the **same name, params (keys, defaults, ranges, labels), projection wishes, persons
options and render cap**, so the control center's show entries play it unchanged. It should look and
behave like the browser scene. Read this whole file first.

## Where things are

| browser | wall-bevy |
|---|---|
| `main.js` default export | a `SceneDef` (static) + a struct implementing `Scene` (`src/scene.rs`) |
| `setup(ctx)` | `make: fn(&SetupCtx) -> Result<Box<dyn Scene>, String>` (runs in a **worker thread**; owned ctx) |
| `frame(ctx)` | `Scene::frame(&mut self, ctx: &mut FrameCtx) -> Result<(), String>` |
| `onParam(key, value)` | `Scene::on_param(&mut self, key, &Params)` |
| `dispose()` | `Drop` (GPU objects are freed with the struct) |
| `params: {...}` | `fn params() -> Vec<ParamSpec>` with `params::{num, boolean, color, select, select_map, text}` |
| `projection: {...}` | `fn projection() -> serde_json::Value`: the same object with `json!({...})` (flat keys like `"body.scale"` or nested, `field: 'cone'` / `{ depth, width }`) |
| `streams: ['persons']`, `persons: {...}` | `persons: fn(&Params) -> Option<PersonOptions>` (`PersonOptions::live()` = `delay: 0`, `::exact()` = default delay 12, `::both()` = `live: true`); other streams (`'depth'`, `'ir'`): `streams: fn(&Params) -> Vec<&str>` |
| `persons: { mode: 'full', delay: 0 }` / `{ mode: 'full' }` (default delay) / `{ live: true }` | `scene::live` / `scene::exact` / `Some(PersonOptions::both())`; `mode: 'skeleton'` → `PersonOptions { skeleton: true, ..PersonOptions::live() }` |
| `maxFps` | `max_fps: fn(&Params) -> f64` (0 = none; `scene::cap30`); a `maxFps()` method of the params → a fn reading `&Params` |
| `state per instance (WeakMap ctx)` | fields of your scene struct |

Register it in `src/scenes/mod.rs` (`v.push(&yourscene::DEF)` in `registry()`).

### ctx (FrameCtx)

| JS | Rust |
|---|---|
| `ctx.width`, `ctx.height` | `ctx.width`, `ctx.height` (LED pixels: every scene is a wall scene in the output) |
| `ctx.time`, `ctx.dt`, `ctx.frame` | the same (`f32`, `f32`, `u64`); `performance.now()` → `ctx.now_ms` |
| `ctx.params.x` | `ctx.params.f("x")` (number, checkbox as 0/1), `.b("x")`, `.color("x")` → `[f32; 3]`, `.s("x")` (text/option), `.f64()` |
| `ctx.status = '…'` | `*ctx.status = format!(...)` |
| `ctx.holdSwitch = true` | `*ctx.hold_switch = Some(true)` |
| `ctx.persons` | `ctx.kinect.view` (`Arc<PersonsView>`, `src/persons.rs`): `.visible` (Vec<Person>, iterate `&*ctx.kinect.view`), `.all`, `.entered` (ids; `.entered_persons()`), `.left` (ids), `.fresh`, `.room`, `.floor`, `.seq`, `.by_id()`, `.by_slot()` |
| `p.joints.rightHand` | `p.joints[j::RIGHT_HAND]` (`Option<Vec3>`, world m); `p.motion[j]`, `p.confidence[j]`, `p.room.joints[j]`, `p.image.joints[j]` (`Option<Vec2>` depth px), `p.image.bbox`, `p.center`, `p.head`, `p.ground`, `p.velocity`, `p.height` (NaN if unknown), `p.color`, `p.css`, `p.camera` (raw entry: `RawPerson`, mm) |
| `ctx.persons.exactUpdates`, `.mode`, `.exact`, `.exactAt(seq)`, `.liveAt(seq)` | `ctx.kinect.exact_updates`, `ctx.kinect.mode` (`ViewMode`), `ctx.kinect.exact_view`, `ctx.kinect.exact_at(seq)`, `ctx.kinect.live_at(seq)` |
| `ctx.kinect.persons` (labels, depth, indices, list, floor, seq) | `ctx.kinect.persons: Option<Arc<PersonsResult>>`: `labels`, `depth` (mm), `meters`, `indices` (only the first `count` are valid!), `list` (`Vec<RawPerson>`), `floor`, `seq` |
| `ctx.kinect.fresh.persons` | `ctx.kinect.fresh.persons` (also `.depth`, `.ir`) |
| `ctx.kinect.depth.data`, `.ir.data` | `ctx.kinect.depth` (`Option<Arc<DepthFrame>>`: `.mm`, `.meters`), `ctx.kinect.ir` (`.data`) |
| `ctx.kinect.rays` | `ctx.kinect.rays()` (`Arc<Vec<f32>>`, x, y per pixel) |
| `ctx.kinect.gpu.*Texture/Buffer` | `ctx.kgpu.depth_texture()`, `ir_texture()`, `lut_texture()`, `person_label_texture()`, `person_depth_texture()`, `depth_buffer()`, `ir_buffer()`, `lut_buffer()`, `person_label_buffer()`, `person_depth_buffer()`, `person_index_buffer()`, `person_point_buffer()` (call them in `make`: they also tell the runtime to upload that data) |
| `ctx.xSign` | `ctx.x_sign` |
| `ctx.kinectToScreen(u, v)` | `ctx.kinect_to_screen(u, v)` → `Option<[f32; 2]>` |
| `ctx.wall` | `ctx.wall` (`WallMap`, `src/wall.rs`), see below |
| `ctx.wall.buffer(device)` | `ctx.wall_buf` (the runtime writes it every frame), in `make`: `ctx.wall_buf` |
| `ctx.webgpu()` → device, context, format | `ctx.gpu` (`Gpu`: `.device`, `.queue`); the format of your output is `gpu::TARGET_FORMAT` (rgba8unorm) |
| `context.getCurrentTexture().createView()` | `ctx.target` (render the final LED image into it) |
| `device.createCommandEncoder()` … `queue.submit()` | record into `ctx.encoder` (the runtime submits it after `frame()`, inside an error scope). Do not submit yourself. `queue.write_buffer/write_texture` are fine (they land before the encoder). |
| `ctx.track(obj)`, `ctx.onDispose` | not needed (Drop) |
| sounds (`sound.js`, WebAudio) | `ctx.audio.play(&pcm, volume)` with PCM made once in `make` by `audio::{render, osc, noise, exp_ramp, lin_ramp, Biquad, OnePole, mix}` |
| `Math.random()` | `scenes::common::rand::{Rng, random}` (a seeded `Rng` per instance is nicer) |
| `localStorage.getItem/setItem(key, …)` | `crate::store::get(key)` / `crate::store::set(key, value)` (same key; kept in `web/.cache/wall/bevy-store.json`, written by a thread of its own) |
| `ctx.scene` (name, for labels) | `ctx.name` in `make` / your `DEF.name` |
| `ctx.wall.pointer` (mouse on the preview page), `ctx.params.mouse`, `ctx.on(window, 'pointerdown'/'keydown', …)` | none in the output: no pointer, no keyboard (the LED wall has no mouse). Behave as with `pointer.inside == false`; audio needs no unlock. Keep the param itself (show entries may carry it). |
| DOM overlays (`ctx.dom`, HTML elements on top of the canvas) | the output shows them on the wall: draw them (`scenes::common::overlay::TextOverlay` for text labels); leave out what only the dev page showed |
| three.js (`three/webgpu`, TSL, BloomNode) | no three.js here: write the same scene with wgpu directly (meshes as vertex buffers, a camera matrix from the same numbers, bloom as a few blur passes); match the look at the LED resolution |

### ctx.wall (WallMap)

Same math as `lib/wall.js` (and its WGSL is the same `struct Wall`): `from_world(p, slot)`, `from_room`, `from_camera(c, slot, mm)`, `joint(&person, j)`, `joint_velocity`, `velocity(world, vel, slot)`, `norm(world, slot)`, `room_x(rx, rz, slot)`, `room_y(ry, slot)`, `zone()` → `[near, far]`, `uv(x, y)`, `px(x, y)`, `from_uv`, `from_px`, `on_wall`, `near(dist)`, `k(lat, z)`, `gain`, `map_x`, `map_y`, `unmap_y`, `field_z`, `field_depth`, `field_u`, `field_at`, `edge`, `target()`, `image_to_wall`, `mirror(p)`, `plan(r)`, `block_at`, `to_room(world)`, `side()`, `mirror_sign()`, `plan_x0()`, `led()`, `size()`, `px_per_m()`, `room` (column-major [f32; 16] world → room), `room_inv`, `x_sign`, `tan_h`, `setup` (`Setup`: `led_w`, `led_h`, `size_w`, `size_h`, `bottom`, `sensor_x`, `sensor_front`, …), `projection` (`Profile`), `persons` (`Vec<Placed>`: `x, y, z, norm, plan, dist, lateral, real, scale, gain, vx, vy, u, v, px, py, feet, top, room, in_zone, near, id, slot, color`), `placed(id)`, `place(&person)`.
`wallWgsl(group, binding)` → `crate::wall::wall_wgsl(group, binding)`; `offAxisProjection` → `wall::off_axis_projection`.

### GPU

- `gpu.shader(key, wgsl)` compiles once per key for the whole run (naga first: readable errors). **Every pipeline goes through `gpu.render_pipeline(key, |device| …)` / `gpu.compute_pipeline`**, key unique per scene and pipeline (e.g. `"fluid-simulation advect"`). The runtime sets up every scene once at the start (warm-up), so a switch in the show never compiles.
- Create textures, buffers, bind groups in `make` (or once when the size changes), never per frame. Reuse CPU buffers (`Vec`s) too; nothing big allocated per frame.
- `gpu::layout::{uniform, storage, float_tex, uint_tex, sampler, storage_tex}`, `gpu.bind_group_layout(key, entries)`, `gpu.linear_sampler()`, `gpu.nearest_sampler()`, `gpu.texture(...)`, `gpu.target(label, w, h, format)` (render target, sampled, copyable), `gpu.uniform_buffer`, `gpu.storage_buffer`, `gpu.write_texture(tex, bytes, bytes_per_pixel)`, `gpu::begin_pass(enc, label, view)` (clears to black), `gpu::FULLSCREEN_WGSL` (`vs_fullscreen`).
- WGSL: if the browser's `.wgsl` file runs unchanged under naga, include it with `include_str!("../../../../web/scenes/<name>/x.wgsl")` (one source for both outputs). Inline WGSL in JS → a Rust string (`r"..."`). If naga needs a change, copy the file into your module folder and say why in a comment.
- wgpu 30 wraps optional entries: `bind_group_layouts: &[Some(&bgl)]`, `buffers: &[Some(wgpu::VertexBufferLayout { .. })]`, `targets: &[Some(ColorTargetState { .. })]`; `immediate_size: 0`, `multiview_mask: None`, `cache: None` in the descriptors (copy them from `pixel_spiegel/sparks.rs` or `shader_pass.rs`).
- WebGPU → wgpu: `copy_buffer_to_texture` needs `bytes_per_row` a multiple of 256 (`write_texture` does not); bind group layouts must match exactly (filterable vs unfilterable float: `r32float`/`rg32float` are unfilterable unless `gpu.float32_filterable`); `@builtin(position)` etc. the same; naga rejects some things Tint accepts (e.g. `let` shadowing in the same scope is fine, but check `const` arrays indexed by runtime values: use `var` copies).
- `createShaderPass(ctx, { shade, feedback })` → `crate::shader_pass::ShaderPass::new(&gpu, &kgpu, &wall_buf, [w, h], name, &params.specs, shade, feedback)`, then `pass.render(ctx)` in `frame`. The prelude is identical (F, P, kinectUv, personMask, wallPerson, …).
- `createWallPersons(ctx)` → `crate::wall_persons::WallPersons::new(&gpu, &kgpu, &wall_buf, [w, h])`, `wp.update(ctx.encoder, ctx.kinect)`, `wp.view`.

### 2D on the CPU (Canvas 2D)

`crate::canvas::Canvas` (tiny-skia; premultiplied RGBA8): `fill_rect`, `fill_poly`, `line`, `polyline`, `stroke_arc`, `stroke_ellipse`, `fill_circle`, `fill_rect_gradient_x`, `fill_text(text, x, y, &Font, Align, Baseline, Rgba, max_width)`, `wrap_text`, `measure_text`, `text_coverage` (a text as an alpha mask: for the scenes' `textMask()`), `alpha`, `line_width`, `dash`, `cap`; `canvas.pix` is the tiny-skia `Pixmap` for anything else (paths, transforms, gradients). Upload with `gpu.write_texture(&tex, canvas.data(), 4)`. Fonts are the system's, chosen from a CSS family list (`Font::new("\"Segoe UI\", Arial, sans-serif", 24.0, 700)`); on Windows the same as in the browser.
Pixel layers the scenes keep as `Uint8ClampedArray`/`Float32Array` → a `Vec<u8>`/`Vec<f32>` in the struct, uploaded with `write_texture` when changed.

### Shared helpers

`scenes::common::field::BodyField` (field.js), `scenes::common::qr::encode_qr(text, 'M', min_version)` (qr.js, with its mask choice), `scenes::common::rand`, `scenes::common::overlay::TextOverlay` (HTML labels over the scene: font, letter-spacing, padding, rounded background, text-shadow glow; painted once, cached, blended per frame; see person-mask in `shader_scenes.rs`), `crate::store` (localStorage).

## Rules

- Same behavior and look. Port the logic faithfully (constants, thresholds, timings); keep the German comments' meaning in English comments as in the JS. No new features, no "improvements" of the design.
- Performance: the output must never stutter. Per frame: bounded CPU work, no allocations of GPU objects, no blocking, no `println!` in the frame loop. Heavy one-time work (painting backdrops, building sprites, synthesizing sounds) belongs in `make` (it runs in a worker thread).
- Errors: return `Err(String)` from `make`/`frame` instead of panicking; avoid `unwrap()` on anything that can fail at run time (indexing with checked bounds where the input comes from the hub).
- Only add files under `src/scenes/<your_scene>/` and the one `registry()` line; tell me if you need a change in the shared core (`src/*.rs`), don't make it silently.
- `cargo build` must be warning-free for your module (`cargo build 2>&1 | grep -A5 "your_scene"`).

## Testing (no Kinect needed)

```bash
cd wall-bevy
# a fake hub with 3 synthetic people (walking, waving, jumping); --freeze 4.2 = always the same frame
./target/debug/fake_hub --bind 127.0.0.1:8099 --persons 3 &
# render your scene headless for 8 s, a PNG every 2 s + frames.json (fps, frame times, errors):
Xvfb :99 -screen 0 1920x1080x24 &   # once
DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/xdg WGPU_BACKEND=vulkan VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json \
  ./target/debug/wall-bevy --hub 8099 --scene <name> --shots /tmp/shots-<name> --seconds 8 --shot-every 2 [-p key=value ...]
```

Look at the PNGs (Read tool). The renderer is a CPU emulation (lavapipe): slow, so judge looks, not fps.
A reference picture of the browser scene from the same fake hub (headless Chromium, WebGPU in SwiftShader):
`node <scratch>/ref/ref.mjs http://127.0.0.1:5199 <name> 8099 8 /tmp/ref-<name>.png` (a Vite dev server of the main
checkout runs on 5199). Scenes that use `wallPerson()` render black there (SwiftShader limitation), the others
work. `python3 <scratch>/pngdiff.py a.png b.png [diff.png]` compares two pictures of the same moment (with `--freeze`).
