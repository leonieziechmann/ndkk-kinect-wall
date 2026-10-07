# Building scenes for the Kinect wall (agent guide)

You build a **scene**: a full-window browser visual that reacts to a Kinect v2 depth camera. A scene is one folder, `web/scenes/<name>/`. The Kinect data comes from kinect-hub, which is already running and shared by everyone. Your own Vite dev server shows your scene and swaps it in place whenever you save. You do not need to understand the rest of the repository.

## Start: 5 commands, in your worktree

```bash
cd web
npm install                      # once per worktree (~10 s)
npm run dev                      # start in the BACKGROUND; prints http://127.0.0.1:<port>/
npm run new my-scene             # copy of the default template (or: npm run new my-scene pointcloud)
npm run check my-scene           # renders it headless: errors, fps, Kinect fps, screenshot
```

The screenshot is `web/.cache/shots/my-scene.png`: **look at it** (Read tool). The work loop is: edit, run `npm run check my-scene`, look at the screenshot, repeat. When it looks right, write a good `title` and `description` into `scene.json`; the gallery shows them.

Before you start, `curl -s http://127.0.0.1:8090/api/status` must answer. If it does not, the hub is not running: see `CLAUDE.md`.

## Templates

`npm run new <name> <template>` copies any existing scene. Pick the closest one:

| template | what it is | edit |
|---|---|---|
| `depth-shader` (default) | 2D effect, one WGSL function per pixel, with feedback/trails | `shade.wgsl`, params in `main.js` |
| `pointcloud` | 3D point cloud in raw WebGPU, lit dots plus glow, orbit camera | `main.js` (WGSL inline) |
| `three-points` | three.js `WebGPURenderer`: points as sprites, OrbitControls | `main.js` |

## Scene file

`web/scenes/<name>/main.js`:

```js
export default {
  streams: ['depth'],               // what to receive: depth, depth_raw, ir, points; or (params) => [...]
  params: {                         // sliders in the page; the user's changes persist
    speed: { value: 1, min: 0, max: 5, step: 0.1, label: 'Tempo' },
    glow: true,                     // checkbox
    tint: '#ffcc66',                // color picker
    mode: { value: 'a', options: ['a', 'b'] },
  },
  maxFps: 30,                       // optional: render cap, frees GPU time for the Kinect
  pixelRatio: 1,                    // optional: canvas resolution (default devicePixelRatio, max 2)
  async setup(ctx) {},              // create resources; may be async; errors are shown, the old version keeps running
  frame(ctx) {},                    // every animation frame (~60/s)
  resize(ctx) {},                   // optional: ctx.width / ctx.height changed
  dispose(ctx) {},                  // optional: free what setup created
};
```

`web/scenes/<name>/scene.json` holds `{ "title", "description", "author" }` for the gallery. Other files in the folder (shaders, modules, data) are up to you: `import X from './x.wgsl?raw'` gives the text, and a relative `import` gives a module.

## ctx

| | |
|---|---|
| `ctx.canvas`, `ctx.width`, `ctx.height` | full-window canvas, size in device pixels |
| `await ctx.webgpu()` | `{ device, context, format }`: the shared GPU device, canvas already configured |
| `ctx.params` | live values of `params` |
| `ctx.time`, `ctx.dt`, `ctx.frame` | seconds since start, seconds since the last frame, frame counter |
| `ctx.kinect.depth.data` | `Uint16Array` 512×424, depth in mm, 0 = no measurement; `ctx.kinect.depth` is `null` until the first frame |
| `ctx.kinect.ir.data` | `Uint8Array` infrared brightness (needs `'ir'` in `streams`) |
| `ctx.kinect.points.data` | `Int16Array` x,y,z in mm, precomputed by the hub (needs `'points'`) |
| `ctx.kinect.rays` | `Float32Array` x,y per pixel: point = (x·z, y·z, z) |
| `ctx.kinect.fresh.depth` | `true` in the frame in which new depth arrived (also `.ir`, `.points`, `.meta`) |
| `ctx.kinect.meta.stats` | per frame: `median_mm`, `centroid_mm`, `valid_ratio`, `min_mm`, `max_mm` |
| `ctx.kinect.gpu.depthTexture` | r32float, meters. Also `irTexture` (r8unorm), `lutTexture` (rg32float, rays), and `depthBuffer` / `irBuffer` / `lutBuffer` as storage buffers. Updated automatically, never recreated. Only after `ctx.webgpu()`. |
| `ctx.camera` | orbit camera: `viewProj` / `view` / `proj` (Float32Array(16), column-major, for WGSL `mat4x4f`), `eye`, `focalPx`. Drag rotates, wheel zooms, space toggles auto orbit, `r` resets. |
| `ctx.xSign` | -1 or +1. Multiply Kinect x by it: key `m` mirrors every scene. |
| `ctx.pointer` | `{ x, y, down }` in canvas pixels |
| `ctx.dom` | a div over the canvas for your own HTML (`pointer-events: none`; set it to `auto` on your elements) |
| `ctx.on(target, type, fn)` | `addEventListener` that is removed again on hot swap |
| `ctx.track(obj)` | `obj.destroy()` on hot swap: use it for big GPU textures and buffers |
| `ctx.status = '…'` | short text in the HUD |

**Coordinates.** The Kinect camera frame is in mm: x right, y down, z forward (away from the sensor). The world used by `ctx.camera` and `pointAt()` is in meters with y up: world = (xSign·x, −y, z) / 1000. The person standing in front of the wall is typically 1–3 m away.

## 2D shaders (template `depth-shader`)

You write a single function in `shade.wgsl`:

```wgsl
fn shade(pos: vec2f, uv: vec2f) -> vec4f {    // pos: pixel, uv: 0..1 (y down)
  let k = kinectUv(uv);                       // screen -> depth image (covers the screen, mirrored like 3D)
  let d = depthSmooth(k);                     // meters, 0 = no measurement
  return vec4f(vec3f(fract(d * 4.0 - F.time)) * P.tint, 1.0);
}
```

The shader also has:
- `depthAt(k)`, `irAt(k)` (0..1), `pointAt(k)` (world, m), `inImage(k)`
- `prev(uv)`: the previous output, when `createShaderPass(ctx, { shade, feedback: true })`
- `F.resolution`, `F.time`, `F.dt`, `F.mouse` (xy px, z pressed), `F.xSign`, `F.frame`, `F.hasDepth`
- `P.<param>`: every param of the scene. Numbers and checkboxes are `f32`, colors `vec3f`, options are the value (if numeric) or the index.

WGSL errors show the line in your `shade.wgsl`. `fwidth`/`dpdx` must not sit inside an `if`; use `select()`.

## three.js

Import only from `three/webgpu`, `three/tsl` and `three/addons/...`. Mixing in plain `three` gives two copies of the classes. Create `new THREE.WebGPURenderer({ canvas: ctx.canvas })`, `await renderer.init()`, `renderer.setPixelRatio(1)`, `renderer.setSize(ctx.width, ctx.height, false)`, and do the same in `resize`. `dispose()` must call `renderer.dispose()` and `controls.dispose()`. Points larger than 1 px: `THREE.Sprite` + `PointsNodeMaterial` with `instancedDynamicBufferAttribute` (see `three-points`); with `sizeAttenuation` the size is in meters.

## Rules

- Edit only `web/scenes/<your-scene>/`. `web/lib/` is shared: a change there reloads every open page and can break every scene, so ask the user first.
- No new npm packages without asking (`package.json` is shared). Available: `three` (with addons), `lil-gui`.
- Give the scene a distinctive name; the scenes of all worktrees end up side by side.
- Keep the Kinect at 30 fps. Its depth decoding runs on the **same GPU** as your scene. If `npm run check` reports that the hub rate dropped, render less (fewer points, lower resolution, `pixelRatio: 1`) or set `maxFps: 30`.
- Do not start the Kinect tools (`fn2_*`, `viewer.py --fn2`). Do not stop the hub or anybody else's dev server.
- Screenshots and thumbnails show the room and the people in it. They stay in `web/.cache/` (git-ignored); never commit or upload them.

## Looking at it

- Your dev server: `http://127.0.0.1:<port>/` is the gallery, `/scenes/<name>/` is the scene. The URL is in the `npm run dev` output and in `web/.cache/dev-server.json`. Every worktree gets the next free port from 5173.
- All worktrees together: http://127.0.0.1:8090/ (what the user looks at).
- Keys in a scene:
  - `h` UI on/off
  - `f` fullscreen
  - `m` mirror
  - `,` / `.` previous/next scene, across all worktrees
- URL options: `?hub=8091` (another hub), `?fps=30`, `?kiosk` (no UI).
- Hot swap: saving `main.js` or a file it imports replaces the scene without a reload. If `setup()` throws, the previous version keeps running and the error is shown. If `frame()` throws, the scene pauses; save again to retry.
- `npm run check` without names checks every scene in your worktree. Options go after `--`: `npm run check my-scene -- --seconds 8 --size 1920x1080 --hub 8091`.
- Reproducible data without the real Kinect: run your own synthetic hub (moving spheres in a room): `"$MAIN/kinect-hub/target/release/kinect-hub.exe" --source synthetic --bind 127.0.0.1:8091` (`MAIN` = first path of `git worktree list`). Then `npm run check my-scene -- --hub 8091` or `?hub=8091`.

## When something is off

| symptom | cause |
|---|---|
| "Keine Verbindung zu kinect-hub" | the hub is not running: `CLAUDE.md` |
| `check`: Kinect connected but no frames | the sensor is (re)starting; wait a few seconds and run it again |
| `check`: "Kinect-Bildrate im Hub fiel" | your scene uses too much GPU (see Rules) |
| `check`: "Die Seite bekam nur … Kinect-Bilder" | `frame()` blocks the main thread too long (heavy JS per frame), or other scenes are rendering on the same GPU right now; run it again later and compare |
| black screen, no error | nothing drawn yet: is `ctx.kinect.depth` still `null`? Is the camera looking somewhere else? |
| changed default values do not show | the user moved that slider (value saved); use "Zurücksetzen" in the panel |
