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
| `person-mask` | only the people, 2D: each in its tracking color, relief, outline, id tags | `shade.wgsl`, `main.js` |
| `neon-room` | only the people as lit point clouds in a virtual neon room, floor rings, reflection | `main.js`, `points.wgsl`, `room.wgsl` |
| `person-skeleton` | stick figures of everyone (skeleton-only tracking), glowing hands, trails, optional silhouettes | `shade.wgsl`, `main.js` |

## Scene file

`web/scenes/<name>/main.js`:

```js
export default {
  wall: true,                       // optional: an LED wall scene, the canvas is the LED image (see WALL.md)
  projection: { smoothing: 0.3 },   // optional: what the scene needs of the projection by nature (WALL.md)
  streams: ['depth'],               // what to receive: depth, depth_raw, ir, points, persons; or (params) => [...]
  persons: { mode: 'full' },        // optional, with 'persons' in streams: see PERSONS.md
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
| `ctx.persons` | the tracked people (with `streams: ['persons']`), see People below |
| `ctx.wall` | the LED wall: setup, the scene's projection and the mapping Kinect → wall (`fromWorld`, `place(person)`, `joint`, `norm`, `uv`, `px`, `persons`, ...), see LED wall below |
| `ctx.kinectToScreen(u, v)` | depth image pixel -> canvas pixels as `kinectUv()` (2D scenes); `ctx.worldToScreen([x, y, z])` for 3D scenes |
| `ctx.dom` | a div over the canvas for your own HTML (`pointer-events: none`; set it to `auto` on your elements) |
| `ctx.on(target, type, fn)` | `addEventListener` that is removed again on hot swap |
| `ctx.track(obj)` | `obj.destroy()` on hot swap: use it for big GPU textures and buffers |
| `ctx.status = '…'` | short text in the HUD |
| `ctx.holdSwitch = true/false` | games: set every frame, `true` while a round runs; the show then switches only between rounds (WALL.md, "Games: switch between rounds") |

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

## People (person tracking)

Most installations should show **only the people**, not the room. Add `streams: ['persons']`: the tracker finds everyone, keeps a stable id and color per person, and gives you each person's mask (30 fps, with details) and an exact 3D skeleton. **Full reference with recipes: [PERSONS.md](PERSONS.md).**

```js
export default {
  streams: ['persons'],
  persons: { mode: 'full' },          // optional: 'skeleton' = skeletons only (much cheaper); delay: 0 = live
  frame(ctx) {
    for (const p of ctx.persons) {    // the visible persons
      p.id; p.slot; p.color;          // stable id, slot 1..16, its color [r, g, b]
      p.joints.rightHand;             // [x, y, z] meters (world, as ctx.camera) or null; 24 named points
      p.room.ground;                  // on the floor below the feet (room space: floor at y = 0)
      p.image.joints.head;            // [u, v] depth image pixels -> ctx.kinectToScreen(u, v)
    }
    for (const p of ctx.persons.entered) { /* someone came in */ }
  },
};
```

| | |
|---|---|
| `ctx.persons` | the visible persons (Person objects, see PERSONS.md); `.all`, `.entered`, `.left`, `.byId()`, `.room`, `.floor` |
| WGSL (2D shaders) | masks: `personAt(k)`, `isPerson(k)`, `personMask(k)`, `personDepthAt(k)`, `personColor(slot)`; skeletons: `personVisible(s)`, `personJointUv(s, J_LEFT_HAND)`, `personJoint(s, j)`, `skeletonDist(k)` |
| `ctx.kinect.gpu` | `personLabelTexture`, `personDepthTexture`, `personPointBuffer` (all points of everyone), `personIndexBuffer` … |
| `ctx.kinect.persons` | the raw data: `labels`, `depth`, `indices` (Uint arrays per pixel), `list` (camera frame, mm) |
| templates | `person-mask` (2D masks), `person-skeleton` (stick figures, skeleton mode), `neon-room` (3D point clouds in a room) |

**Delayed by default** (about 150–250 ms): every frame waits for a later pose, and its skeleton is interpolated, so it is as exact as a pose on every frame. The whole scene, including `ctx.kinect.depth` and `ir`, is shifted by the same time. `persons: { delay: 0 }` is live. A page that stays hidden for 3 s (background tab, minimized window) unsubscribes the Kinect streams, so the hub stops tracking for it; data comes back when it is shown. `persons: { live: true }` is both: `ctx.persons` live, and the exact skeletons of the same frames follow as `ctx.persons.exact` / `.exactUpdates`, so a scene can react at once and confirm with `LiveCheck` (PERSONS.md, "Live and exact"; scene `live-exakt`). The pose model shares the GPU with your scene: keep the scene light. Replays with people for testing: PERSONS.md, "Testing".

## LED wall

The scenes are for a **6 × 2 m LED wall (1008 × 336 LEDs)**. Its setup (size, LED pixels, where the Kinect stands) is shared by every scene; how people are mapped onto it (the play field stretched over the wall, curves, mirror, body size, smoothing) is a **projection per scene** over a default. Both are edited in the control center. **Full reference: [WALL.md](WALL.md).**

- `wall: true` in the scene: the canvas is the LED image (`ctx.width × ctx.height` = LED pixels); the page shows it scaled to fit.
- `ctx.wall`: `fromWorld(p, person.slot)` → wall meters, `place(person)` (where a person is on the wall, `.norm` = 0..1 in the play field), `joint(person, 'rightHand')`, `uv()`, `px()`, `velocity()`, `persons`; in per-pixel loops over the masks `roomX(rx, rz, slot)`, `roomY(ry, slot)`, `zone`. Never hard-code wall size, LED resolution, sensor height, a stretch factor, a play area or a zone: they come from the projection, tuned per scene in the control center.
- WGSL (`createShaderPass`): `wallPerson(uv)` = the people as they fall on the wall (covered, distance, slot, IR); `wallFromWorld(p, slot)`, `wallUv()`, `wallVelocity()`, `WALL.*`. On the LED image `kinectUv()` shows the camera image calibrated to the wall.
- Control center `/control/` and output window `/wall/` on your dev server: the show (playlist with params per entry), a live preview (no extra window needed; "▶" on a scene shows it at once), test images, calibration view, the projections (tab "Projektion": play field, curves, assistant), the setup with a top view of the room and block zones (nobody standing there is tracked, in every scene). `npm run wall` opens the output as a kiosk window on the LED screen.
- Demo: scene `wand-spiegel`. Porting a scene that emulates the wall itself (its own `ledW`, `wallW`, `stretch`, `viewMode`, ...): WALL.md, "Porting".

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
- Your dev server's gallery and the hub list only the scenes your worktree **added or changed** against `main` (`?all` shows every scene; the main checkout shows all).
- `npm run check` without names checks your worktree's new and changed scenes. Options go after `--`: `npm run check my-scene -- --seconds 8 --size 1920x1080 --hub 8091`.

## Recorded people instead of an empty room

Often nobody stands in front of the Kinect, and your scene only sees an empty room. A **replay hub** loops a recording of the real sensor, people and noise included, at the original frame rate. Every run gets the same data, so you can compare versions. It never touches the Kinect and uses no GPU.

```bash
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')   # the main checkout
ls "$MAIN/recordings"                                                 # the recordings (*.k2rec)
curl -s http://127.0.0.1:8091/api/status                              # "source":"replay"? then just use it
"$MAIN/kinect-hub/target/release/kinect-hub.exe" --source replay "$MAIN/recordings/<name>.k2rec" --bind 127.0.0.1:8091   # else: in the BACKGROUND
npm run check my-scene -- --hub 8091                                  # or open the scene with ?hub=8091
```

- One replay hub serves everyone: leave it running, and never stop one you did not start.
- If another kind of hub holds 8091, or you want a different recording, take 8092, 8093, ….
- No recordings yet: `--source synthetic` instead of `--source replay <file>` gives moving spheres in a room.
- New recordings need someone in front of the sensor, so ask the user. The command is in `CLAUDE.md`.
- Recordings show the room and the people in it. They stay in `recordings/` (git-ignored); never commit or upload them.

## When something is off

| symptom | cause |
|---|---|
| "Keine Verbindung zu kinect-hub" | the hub is not running: `CLAUDE.md`. With `?hub=8091` / `--hub 8091`: start the replay hub (above) |
| replay hub: no frames, sensor `offline` | recording missing or damaged; `curl -s http://127.0.0.1:8091/api/status` shows why |
| `check`: Kinect connected but no frames | the sensor is (re)starting; wait a few seconds and run it again |
| `check`: "Kinect-Bildrate im Hub fiel" | your scene uses too much GPU (see Rules) |
| `check`: "Die Seite bekam nur … Kinect-Bilder" | `frame()` blocks the main thread too long (heavy JS per frame), or other scenes are rendering on the same GPU right now; run it again later and compare |
| black screen, no error | nothing drawn yet: is `ctx.kinect.depth` still `null`? Is the camera looking somewhere else? |
| changed default values do not show | the user moved that slider (value saved); use "Zurücksetzen" in the panel |
