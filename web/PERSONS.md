# People: person tracking for scenes

Most installations should show **only the people**, not the room around them. The person tracking finds everyone in front of the Kinect and gives each person a stable id and color. It also gives you a mask of every person's pixels (at 30 fps, with details like fingers and hair) and an exact 3D skeleton. Scenes build on it in WGSL, in JavaScript or both.

This page is the full reference. The short version is in [AGENTS.md](AGENTS.md#people-person-tracking).

```js
export default {
  streams: ['persons'],                          // starts the tracking (depth and ir come with it)
  persons: { mode: 'full' },                     // optional, see "Modes and options"
  frame(ctx) {
    for (const p of ctx.persons) {               // the visible persons
      const hand = p.joints.rightHand;           // [x, y, z] in meters, or null
      if (hand && p.motion.rightHand) { /* ... */ }
    }
  },
};
```

## How it works (enough to use it well)

- **Where it runs:** the hub tracks everyone itself and sends the results to every page (streams `persons` / `persons_live`; the pose model natively with DirectML, the tracker in Rust: kinect-hub/README.md, "Personen"). A page with `streams: ['persons']` takes them automatically. With an older hub (or one without its pose model) the page runs the same tracker in two Web Workers, as described below. `?persons=local` forces that for comparisons.
- A pose model (YOLO11n-pose on the infrared image) finds the skeletons: in the hub about 15 times a second (`--pose-hz`); in the browser (WebGPU, its own Web Worker) as often as it can.
- Every depth frame is cut out on its own (a second worker, 30 fps). The persons' pixels of the last frame grow into the new frame without crossing depth jumps. A learned background (the floor, furniture, walls) is left out. The skeletons only tell which pixels belong to whom. A fast arm is never cut off.
- The skeleton of every frame is exact. Each frame waits for the pose of a later frame, and its keypoints are interpolated between the pose before and the pose after (the **delayed output**, about 150–250 ms). The depth of the arms is measured on the person's own pixels; that of the other joints is checked against the limb lengths and smoothed. The results are played out evenly at 30 fps. Meanwhile `ctx.kinect.depth`, `ir` and their GPU copies show the *same* frame, so everything you draw fits together.

## Modes and options

Put `persons` into the scene definition, as an object or as a function of the params (like `streams`):

```js
persons: { mode: 'skeleton', delay: 0 },
persons: (p) => ({ mode: p.style === 'Strichmännchen' ? 'skeleton' : 'full' }),
```

| option | default | |
|---|---|---|
| `mode` | `'full'` | `'full'`: masks and skeletons. `'skeleton'`: skeletons only, no masks. Much less work (1–2 ms instead of 6–30 ms per frame), and the skeletons are just as exact. The mask textures and buffers stay empty, and `pixels`/`area` are 0. Person ids are a bit less stable when people cross each other. |
| `delay` | `12` | Frames the output may wait for a later pose (see above). `0` is **live**: the lowest latency. The masks are the same, but the skeletons follow the optical flow from the last pose, so they are less exact on fast hands and feet. The arms come from the mask of every frame once a pose has confirmed them (an arm reaching out: its far end is the hand), so they keep up with fast arms. Under GPU load (few poses a second) live arms lag more. |
| `maxPersons` | `16` | At most this many persons get a slot. |
| `maxDepth` | `4500` | mm: farther pixels are never a person. |
| `minScore` | `0.45` | Pose confidence needed for a new person. |
| `keepSeconds` / `lostSeconds` | `4` / `1.5` | A visible person the pose model misses is kept this long; a hidden one is forgotten after `lostSeconds`. |
| `staleSeconds` | `0.5` | Skeleton mode: without a pose for this long a person is not visible (but kept). |

There are more thresholds in `DEFAULTS` in `lib/persons-core.js`. Scenes rarely need them. The options apply while the scene runs, and other scenes get the defaults back.

## Coordinate spaces

| space | unit | axes | where |
|---|---|---|---|
| **world** | m | x right, y up, z away from the sensor; the sensor at the origin. x is mirrored by key `m` (`ctx.xSign`). | `p.center`, `p.joints.*`, `p.velocity`, `pointAt()` in WGSL, `ctx.camera` |
| **room** | m | the floor is y = 0, y up, z forward along the floor, the origin on the floor below the sensor | `p.room.*`, `ctx.persons.room.apply(world)`, `roomFrame()` |
| **image** | px | the depth image as the hub sends it: 512×424, u right, v down, **mirrored** | `p.image.*`, `ctx.kinect.persons.labels`, `kinectUv()` in WGSL (uv = px / size) |
| **screen** | canvas px | `ctx.width` × `ctx.height` (CSS px = canvas px / `ctx.pixelRatio`) | `ctx.kinectToScreen(u, v)` for 2D scenes, `ctx.worldToScreen(p)` for 3D scenes |
| camera | mm | the Kinect's own frame: x right, y down, z forward | `p.camera` (the raw entry), `ctx.kinect.persons.list` |

The room needs the floor. The tracker estimates it from the visible floor, and without a visible floor it uses the feet (`ctx.persons.floor`: `{ normal, d, height, pitchDeg, rollDeg, source }`). In the final installation the sensor stands about 0.85 m high and looks straight ahead.

## ctx.persons

An `Array` of the visible persons, sorted by slot, plus:

| | |
|---|---|
| `.all` | every tracked person, also those hidden for a moment behind someone (`visible: false`) |
| `.entered` | the persons that came in with this update (each person once). `.left`: ids that are gone. Both are empty in frames without an update. |
| `.fresh` | `true` in the animation frame of an update (about 30 per second) |
| `.byId(id)`, `.bySlot(slot)` | lookup in `.all` |
| `.room` | the room frame: `{ matrix, apply(world) → room, up, forward, right, height, found }` (`matrix` is a column-major `mat4x4f` world → room) |
| `.floor`, `.seq`, `.delayMs` | the floor, the frame number, how long after its capture the frame is shown |

### Person

| field | |
|---|---|
| `id` | unique for the session; a person who leaves the view for over 1.5 s comes back with a new id |
| `slot` | 1..16, stable while tracked: the label value in the masks and the index in WGSL |
| `color`, `css` | the slot's color: `[r, g, b]` 0..1 and `'#rrggbb'` (`PERSON_COLORS`) |
| `visible`, `age`, `score` | hidden for a moment?, seconds since first seen, pose confidence 0..1 |
| `height` | m: top of the head above the floor |
| `pixels`, `area` | size of the mask: pixels, m² (0 in skeleton mode) |
| `center`, `head`, `ground`, `velocity` | world: center of the body, center of the head, the point on the floor below the feet, m/s |
| `joints.<name>` | world `[x, y, z]` or `null` (not seen), smoothed (One-Euro: steady when slow, no lag when fast) |
| `confidence.<name>`, `motion.<name>` | 0..1; velocity of the point in m/s (world) or `null` |
| `room.center`, `room.head`, `room.ground`, `room.joints.<name>` | the same in room space |
| `image.bbox`, `image.center`, `image.joints.<name>` | depth image pixels: `[u0, v0, u1, v1]`, `[u, v]` |
| `camera` | the raw entry from `ctx.kinect.persons.list` (mm, camera frame, not smoothed) |

**Point names** (`POINTS` in `/lib/persons.js`, in this order everywhere; WGSL `J_NOSE` … `J_GROUND`):

```
 0 nose        1 leftEye        2 rightEye       3 leftEar        4 rightEar
 5 leftShoulder  6 rightShoulder  7 leftElbow  8 rightElbow  9 leftWrist  10 rightWrist
11 leftHip    12 rightHip      13 leftKnee      14 rightKnee     15 leftAnkle  16 rightAnkle
17 neck       18 pelvis        19 head          20 leftHand      21 rightHand
22 center     23 ground
```

The points 0–16 come from the pose model (COCO). The rest are derived: neck and pelvis are between the shoulders or hips, head is the center of the face points, and the hands lie beyond the wrists along the forearms (live: where the arm in the mask ends). `left`/`right` are the person's own sides. `BONES` (pairs of indices) draws a clean stick figure. `SKELETON` has the 18 COCO pairs with the face.

From `/lib/persons.js`: `POINTS`, `POINT` (name → index), `BONES`, `SKELETON`, `JOINTS`, `PERSON_COLORS`, `personColor(slot)`, `toWorld(cameraMm, xSign)`, `roomFrame(floor, xSign)`, `MAX_PERSONS`.

## Raw data: ctx.kinect.persons

For pixel work, without objects (`null` until the first result):

| | |
|---|---|
| `labels` | `Uint8Array` 512×424: the slot per pixel, 0 = nobody |
| `depth` | `Uint16Array` 512×424: depth in mm of the person pixels only, 0 elsewhere |
| `indices` | `Uint32Array`: the person pixels in raster order (`labels[i]` is their slot) |
| `list` | the persons in the camera frame (mm): `joints` 17 × `[x, y, z, conf]`, `keypoints` 17 × `[u, v, conf]`, `extra` / `extraKeypoints` for neck, pelvis, head, leftHand, rightHand, `centroid`, `head`, `ground`, `bbox`, `velocity` (mm/s), … |
| `floor`, `seq`, `captureTimeUs`, `lag` | as above |

The arrays stay valid until the next but one result. Copy what you keep longer.

## GPU

`ctx.kinect.gpu` (after `ctx.webgpu()`), updated automatically and never recreated:

| | |
|---|---|
| `personLabelTexture` | `r8uint` slot per pixel |
| `personDepthTexture` | `r32float` meters, person pixels only |
| `personLabelBuffer`, `personDepthBuffer`, `personIndexBuffer` | storage: u8 slots (four per u32), u16 mm (two per u32), u32 pixel indices (count = `ctx.kinect.persons.indices.length`) |
| `personPointBuffer` | storage `array<vec4f>`: for slot s (1..16) and point j (0..23, `POINTS`) at `(s * 25 + j) * 2`: `[0]` = `(u, v` depth image uv 0..1, depth m, confidence)`, `[1]` = `(x, y, z` world m, confidence)`. Entry j = 24 is the info: `[0]` = (visible 0/1, id, height m, age s), `[1]` = the person's box in depth image uv (u0, v0, u1, v1). Slot 0 is unused. |

### WGSL helpers in 2D shaders (`createShaderPass`)

```wgsl
personAt(k) -> u32            // slot of the person at depth image uv k, 0 = none
isPerson(k) -> bool
personMask(k) -> f32          // 0..1 with smooth edges (bilinear)
personDepthAt(k) -> f32       // meters, person pixels only
personPointAt(k) -> vec3f     // world point of a person pixel
personColor(slot) -> vec3f
personVisible(slot) -> bool
personInfo(slot) -> vec4f     // visible, id, height m, age s
personJointUv(slot, J_LEFT_HAND) -> vec4f   // xy: depth image uv (compare with kinectUv(uv)), z: depth m, w: confidence
personJoint(slot, J_LEFT_HAND) -> vec4f     // xyz: world m, w: confidence
personBox(slot) -> vec4f      // box in depth image uv
personBoneDist(k, slot) -> f32   // depth image pixels from k to that person's stick figure
skeletonDist(k) -> vec2f      // x: pixels to the nearest stick figure of anyone, y: its slot (0 = none)
PERSON_SLOTS, PERSON_POINTS, BONES, BONE_COUNT, J_NOSE … J_GROUND
```

In your own WebGPU pipelines, bind `personPointBuffer` as `var<storage, read> personPoints: array<vec4f>` and copy the few lines from `lib/shader-pass.js`.

## Recipes

**Only the people (2D).** Template `person-mask`:

```wgsl
fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let k = kinectUv(uv);
  let m = personMask(k);
  return vec4f(personColor(personAt(k)) * m, 1.0);
}
```

**A glow around every hand (2D).** Works in both modes:

```wgsl
let scale = fwidth(k.x * KINECT_SIZE.x);      // depth image pixels per screen pixel (before any if)
var col = vec3f(0.0);
for (var s = 1u; s <= PERSON_SLOTS; s++) {
  if (!personVisible(s)) { continue; }
  for (var h = J_LEFT_HAND; h <= J_RIGHT_HAND; h++) {
    let p = personJointUv(s, h);
    if (p.w <= 0.0) { continue; }
    let d = length((k - p.xy) * KINECT_SIZE) / scale;   // screen pixels to the hand
    col += personColor(s) * exp(-d / 25.0);
  }
}
```

**Stick figures.** Template `person-skeleton`: `let sd = skeletonDist(k); if (sd.y > 0.0) { ... sd.x / scale ... }` with `persons: { mode: 'skeleton' }`.

**Follow a hand in 3D (three.js / your own camera).** The world space is the one of `ctx.camera`:

```js
for (const p of ctx.persons) {
  const h = p.joints.rightHand;
  if (!h) continue;
  sprite.position.set(h[0], h[1], h[2]);
  const speed = p.motion.rightHand ? Math.hypot(...p.motion.rightHand) : 0;   // m/s
}
```

**Things on the floor below everyone** (rings, shadows, footsteps): `p.room.ground` is on the floor (y = 0). Template `neon-room` draws its rings this way and puts the people into a room with `ctx.persons.room.matrix`.

**Somebody comes in or leaves:**

```js
for (const p of ctx.persons.entered) spawnWelcome(p.id, p.room.ground, p.color);
for (const id of ctx.persons.left) fadeOut(id);
```

**Labels or HTML on top of a 2D scene:** `const [x, y] = ctx.kinectToScreen(...p.image.joints.head)`, then place the element at `x / ctx.pixelRatio`, `y / ctx.pixelRatio`. Templates `person-mask` and `person-skeleton` do this.

**Every person pixel as a 3D point (raw WebGPU).** Draw one instance per entry of `personIndexBuffer`. Read the depth from `personDepthBuffer`, the ray from `lutBuffer` and the slot from `personLabelBuffer` (template `neon-room`, `points.wgsl`).

## Cost and latency (this laptop, Vega iGPU)

The figures in the table are mask cost per frame and output delay.

| | mask cost per frame | output delay |
|---|---|---|
| `full`, 1–2 persons | 5–15 ms | ~150–200 ms |
| `full`, 4–5 persons | 10–30 ms | ~170–270 ms |
| `skeleton` | 1–5 ms | ~150 ms |
| `delay: 0` | the same | ~40–60 ms |

- The pose model takes 60–110 ms per run on this GPU, in a worker of its own.
- The tracking work runs in workers, so `frame()` is not affected. The GPU is shared, though: the pose model, the Kinect's depth decoding and your scene. Keep scenes light (the templates render at 60 fps next to it).
- The HUD shows people, pose time, mode and delay. `npm run check` reports `Pose … ms`, `Maske … ms` and `verzögert … ms`.

## Testing without people in the room

Recordings with people (local only, never commit or upload them) are in `recordings/` of the main checkout:

| recording | what |
|---|---|
| `final-solo` | the final setup: one person moving fast (jumping jacks, running, crouching) |
| `final-kleid` | the final setup: dancing with a dress |
| `final-start` | the final setup: a person already standing there when the tracking starts |
| `alt-live2` | a small full room: up to 5 people, sitting, standing close, in the door |
| `alt-desk2` | a desk, a person close to the camera |

Play one on a replay hub as in [AGENTS.md](AGENTS.md#recorded-people-instead-of-an-empty-room) (one replay hub serves everyone: if 8091 already plays a recording, use it; another recording on 8092, …), and point the scene at it:

```bash
curl -s http://127.0.0.1:8091/api/status        # "source":"replay"? which file: sensor.detail
"$MAIN/kinect-hub/target/release/kinect-hub.exe" --source replay "$MAIN/recordings/final-solo.k2rec" --bind 127.0.0.1:8091   # else, in the BACKGROUND
npm run check my-scene -- --hub 8091 --seconds 12
```

Allow 8–12 s: the pose model loads and warms up first (about 5 s).

## Good to know

- **Mirrored image:** image coordinates (`labels`, `image.*`) are as the hub sends them (mirrored). World and room coordinates follow `ctx.xSign`. 2D shaders get both right with `kinectUv()`.
- **Very close people** (under about 0.7 m) have little depth, so their masks have holes.
- **A dress held out** at arm's length can be found as a second person by the pose model.
- **Loose clothes** and things a person holds belong to the person as long as they move. Something left lying still for 8 s outside the person's body parts becomes background.
- **Skeleton quality:** keypoints are exact to about 1–2 px (median). The depth of elbows, wrists and hands is measured on the person's pixels around them (delayed: about 2 cm median, live: about 5 cm on fast arms). Knees and ankles are kept at their learned bone lengths and smoothed. For effects that need raw values, use `p.camera`.
- **Smoothing costs lag on fast arms:** the One-Euro filter of `p.joints` is steady when slow, but on jumping jacks it puts the hands about 5 cm (median) behind the raw `p.camera` points. A scene that needs every fast swing can read `p.camera` and smooth it itself.
