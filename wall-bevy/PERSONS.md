# People: person tracking for scenes

Most installations should show **only the people**, not the room around them. The person tracking finds everyone in front of the Kinect and gives each person a stable id and color. It also gives you a mask of every person's pixels (at 30 fps, with details like fingers and hair) and an exact 3D skeleton. Scenes build on it in WGSL, in Rust or both.

The quickest way is the sketch API (SCENES.md, "Personen"): `f.bodies()` gives every person already mapped onto the wall, in LED pixels. This page is the full reference below that.

```rust
wall::scene! { name: "haende", title: "Hände", persons: live, sketch: Haende }   // starts the tracking
// in frame(): every visible person, in world meters
for p in f.ctx.kinect.view.iter() {
    if let (Some(hand), Some(motion)) = (p.joints[j::RIGHT_HAND], p.motion[j::RIGHT_HAND]) {
        // hand: Vec3 in meters, motion: m/s
    }
}
```

## How it works (enough to use it well)

- **Where it runs:** in kinect-hub, once for every client (streams `persons` / `persons_live`; the pose model natively with DirectML, the tracker in Rust: kinect-hub/README.md, "Personen"). The output subscribes while a scene that wants persons plays.
- A pose model (YOLO11-pose on the infrared image) finds the skeletons about 15 times a second (`--pose-hz` of the hub).
- Every depth frame is cut out on its own (30 fps). The persons' pixels of the last frame grow into the new frame without crossing depth jumps. A learned background (the floor, furniture, walls) is left out. The skeletons only tell which pixels belong to whom. A fast arm is never cut off.
- The skeleton of every frame is exact. Each frame waits for the pose of a later frame, and its keypoints are interpolated between the pose before and the pose after (the **delayed output**, about 150 ms). The depth of the arms is measured on the person's own pixels; that of the other joints is checked against the limb lengths and smoothed. The output plays the results out evenly at 30 fps. Meanwhile `ctx.kinect.depth`, `ir` and their GPU copies show the *same* frame, so everything you draw fits together.

## Modes and options

`persons:` in `wall::scene!` (or `persons: fn(&Params) -> Option<PersonOptions>` of a `wall::Scene`, which may depend on the params):

| | |
|---|---|
| `exact` (`PersonOptions::exact()`, delay 12) | the delayed output: exact skeletons, about 150 ms late |
| `live` (`PersonOptions::live()`, delay 0) | the lowest latency, about 10 ms after the sensor. The masks are the same, but the skeletons follow the optical flow from the last pose, so they are less exact on fast hands and feet. The arms come from the mask of every frame once a pose has confirmed them (an arm reaching out: its far end is the hand), so they keep up with fast arms. Under GPU load (few poses a second) live arms lag more. |
| `PersonOptions::both()` | **live and exact together**: `ctx.kinect.view` is live, and the exact skeletons of the same frames follow (see "Live and exact" below) |
| `skeleton: true` | for the scene's own logic only (the hub computes the masks anyway) |

The tracker's thresholds (at most 16 persons, 4.5 m, pose confidence, how long a hidden person is kept) are the hub's (`kinect-hub/persons/src/lib.rs`, `Options`) and the same for every scene.

## Coordinate spaces

| space | unit | axes | where |
|---|---|---|---|
| **world** | m | x right, y up, z away from the sensor; the sensor at the origin. x is mirrored as the wall needs it (`ctx.x_sign`). | `p.center`, `p.joints[j]`, `p.velocity`, `pointAt()` in WGSL |
| **room** | m | the floor is y = 0, y up, z forward along the floor, the origin on the floor below the sensor | `p.room.*`, `view.room.apply(world)` |
| **image** | px | the depth image as the hub sends it: 512×424, u right, v down, **mirrored** | `p.image.*`, `ctx.kinect.persons.labels`, `kinectUv()` in WGSL (uv = px / size) |
| **wall** | m / LED px | see WALL.md | `ctx.wall.place(p)`, `f.bodies()` |
| camera | mm | the Kinect's own frame: x right, y down, z forward | `p.camera` (the raw entry), `ctx.kinect.persons.list` |

The room needs the floor. The tracker estimates it from the visible floor, and without a visible floor it uses the feet (`view.floor`: `normal, d, height, pitch_deg, roll_deg, source`). In the final installation the sensor stands about 0.85 m high and looks straight ahead.

## ctx.kinect.view

`Arc<PersonsView>` (`wall/src/persons.rs`): iterate `ctx.kinect.view.iter()` for the visible persons, sorted by slot, plus:

| | |
|---|---|
| `.visible`, `.all` | the visible persons; every tracked person, also those hidden for a moment behind someone (`visible: false`) |
| `.entered`, `.left` | ids that came in / are gone with this update (`.entered_persons()`: the Person of each). Both are empty in frames without an update. |
| `.fresh` | `true` in the frame of an update (about 30 per second) |
| `.by_id(id)`, `.by_slot(slot)` | lookup in `.all` |
| `.room` | the room frame: `matrix` (column-major, world → room), `apply(world)`, `height`, `found` |
| `.floor`, `.seq`, `.delay_ms` | the floor, the frame number, how long after its capture the frame is shown |

### Person

| field | |
|---|---|
| `id` | unique for the session; a person who leaves the view for over 1.5 s comes back with a new id |
| `slot` | 1..16, stable while tracked: the label value in the masks and the index in WGSL |
| `color`, `css` | the slot's color: `[r, g, b]` 0..1 and `"#rrggbb"` (`PERSON_COLORS`) |
| `visible`, `age`, `score` | hidden for a moment?, seconds since first seen, pose confidence 0..1 |
| `height` | m: top of the head above the floor (NaN if unknown) |
| `pixels`, `area` | size of the mask: pixels, m² |
| `center`, `head`, `ground`, `velocity` | world: center of the body, center of the head, the point on the floor below the feet, m/s |
| `joints[j]` | world `Vec3` or `None` (not seen), smoothed (One-Euro: steady when slow, no lag when fast); `p.joint("rightHand")` by name |
| `confidence[j]`, `motion[j]` | 0..1; velocity of the point in m/s (world) or `None` |
| `room.center`, `room.head`, `room.ground`, `room.joints[j]` | the same in room space |
| `image.bbox`, `image.center`, `image.joints[j]` | depth image pixels: `[u0, v0, u1, v1]`, `Vec2` |
| `camera` | the raw entry (`RawPerson`: mm, camera frame, not smoothed) |

**Point names** (`persons::POINTS`, in this order everywhere; `persons::j::NOSE` … `j::GROUND` in Rust, `J_NOSE` … `J_GROUND` in WGSL):

```
 0 nose        1 leftEye        2 rightEye       3 leftEar        4 rightEar
 5 leftShoulder  6 rightShoulder  7 leftElbow  8 rightElbow  9 leftWrist  10 rightWrist
11 leftHip    12 rightHip      13 leftKnee      14 rightKnee     15 leftAnkle  16 rightAnkle
17 neck       18 pelvis        19 head          20 leftHand      21 rightHand
22 center     23 ground
```

The points 0–16 come from the pose model (COCO). The rest are derived: neck and pelvis are between the shoulders or hips, head is the center of the face points, and the hands lie beyond the wrists along the forearms (live: where the arm in the mask ends). `left`/`right` are the person's own sides. `BONES` (pairs of indices) draws a clean stick figure. `SKELETON` has the 18 COCO pairs with the face. Also in `wall::persons`: `point(name)`, `PERSON_COLORS`, `person_color(slot)`, `room_frame(floor, x_sign, …)`, `MAX_PERSONS`.

## Live and exact

Simple things should react at once; scores and decisions should be right. `PersonOptions::both()` gives a scene both:

- `ctx.kinect.view` is **live**: the newest frame, about 10 ms after the sensor, with the live masks. `ctx.kinect.depth`, `ir` and the GPU copies show the newest frames too.
- The **exact** skeletons of every frame follow when the pose of a later frame is in (100–250 ms later, often several frames at once). They are skeletons only: the masks of a frame are the same in both.

| on `ctx.kinect` | |
|---|---|
| `.mode` | `ViewMode::Both` (live + exact), `Exact` (the delayed output, the default) or `Live` |
| `.exact_view` | the newest exact frame as a view like `view`, `None` until the first |
| `.exact_updates` | the exact frames that came in since the last frame, oldest first (usually 0–8). Look at all of them when you check events. |
| `.exact_at(seq)`, `.live_at(seq)` | the exact view and the live view of frame `seq` (the last 3 s), or `None`. Compare both to see what live got wrong. |
| `.persons_exact` | the newest exact result raw (as `persons`) |

**Decide on the exact data:** react on the live data at once and record a claim; the exact frames around it confirm or overrule it. `scenes/live-exakt` has such a `LiveCheck` (a claim about a live frame is tested on the exact frames from `seq - before` to `seq + after`, confirmed by the first that passes, overruled once all are in without one, typically 150–300 ms later); copy it into your scene. Its status line measures how far live joints are from the exact ones of the same frame.

## Raw data: ctx.kinect.persons

For pixel work, without objects (`Option<Arc<PersonsResult>>`, `None` until the first result):

| | |
|---|---|
| `labels` | 512×424 bytes: the slot per pixel, 0 = nobody |
| `depth`, `meters` | 512×424: depth in mm / m of the person pixels only, 0 elsewhere |
| `indices` | the person pixels in raster order (only the first `count` are valid) |
| `list` | the persons in the camera frame (mm, `RawPerson`): `joints` 17 × `[x, y, z, conf]`, `keypoints` 17 × `[u, v, conf]`, `extra` / `extra_keypoints` for neck, pelvis, head, leftHand, rightHand, `centroid`, `head`, `ground`, `bbox`, `velocity` (mm/s), … |
| `floor`, `seq`, `capture_time_us` | as above |

## GPU

`ctx.kgpu`, updated by the output and never recreated (ask for them in `make`: that also tells the output to upload that data):

| | |
|---|---|
| `person_label_texture()` | `r8uint` slot per pixel |
| `person_depth_texture()` | `r32float` meters, person pixels only |
| `person_label_buffer()`, `person_depth_buffer()`, `person_index_buffer()` | storage: u8 slots (four per u32), u16 mm (two per u32), u32 pixel indices |
| `person_point_buffer()` | storage `array<vec4f>`: for slot s (1..16) and point j (0..23) at `(s * 25 + j) * 2`: `[0]` = `(u, v` depth image uv 0..1, depth m, confidence)`, `[1]` = `(x, y, z` world m, confidence)`. Entry j = 24 is the info: `[0]` = (visible 0/1, id, height m, age s), `[1]` = the person's box in depth image uv (u0, v0, u1, v1). Slot 0 is unused. |

### WGSL helpers in a `ShaderPass`

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

In your own pipelines, bind `person_point_buffer()` as `var<storage, read> personPoints: array<vec4f>` and copy the few lines from `wall/src/shader_pass.rs`.

## Recipes

**Only the people (camera image).** `person-mask` in `scenes/shader-scenes`:

```wgsl
fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let k = kinectUv(uv);
  let m = personMask(k);
  return vec4f(personColor(personAt(k)) * m, 1.0);
}
```

**A glow around every hand.**

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

**Stick figures.** `person-skeleton` in `scenes/shader-scenes`: `let sd = skeletonDist(k); if (sd.y > 0.0) { ... sd.x / scale ... }`; on the wall with the sketch API: `f.skeleton(body, width)`.

**Things on the floor below everyone** (rings, shadows, footsteps): `p.room.ground` is on the floor (y = 0). `scenes/neon-room` draws its rings this way and puts the people into a room with `view.room.matrix`.

**Somebody comes in or leaves:**

```rust
for p in ctx.kinect.view.entered_persons() { spawn_welcome(p.id, p.room.ground, p.color); }
for id in &ctx.kinect.view.left { fade_out(*id); }
```

(sketch API: `f.entered()`, `f.left()`, `body.entered`.)

**Every person pixel as a 3D point.** Draw one instance per entry of `person_index_buffer()`. Read the depth from `person_depth_buffer()`, the ray from `lut_buffer()` and the slot from `person_label_buffer()` (`scenes/neon-room`, `points.wgsl`).

## Cost and latency

| | |
|---|---|
| tracker in the hub | 2–5 ms per frame, for every client together |
| poses | about 15 per second (s model at 512 or 384, by what the GPU keeps) |
| `live` | about 10 ms after the sensor |
| `exact` | about 150 ms after the sensor |

The GPU is shared: the pose model, and your scene. When the output renders below its target rate for 2 s, the hub steps down to a cheaper pose model (kinect-hub/README.md, "Posen"). The control center's status tab shows the people, the pose rate and the delay.

## Testing without people in the room

Recordings with people (local only, never commit or upload them) are in `recordings/` of the main checkout (`recordings/README.md`, the catalog `recordings/katalog/KATALOG.md`). Play one on a replay hub (CLAUDE.md: one replay hub serves everyone; if 8091 already plays a recording, use it; another recording on 8092, …) and point the output at it:

```bash
curl -s http://127.0.0.1:8091/api/status        # "source":"replay"? which file: sensor.detail
"$MAIN/kinect-hub/target/release/kinect-hub.exe" --source replay "$MAIN/recordings/final-solo.k2rec" --bind 127.0.0.1:8091   # else, in the BACKGROUND
wall-bevy --hub 8091 --scene my-scene --windowed            # or headless: --shots DIR --seconds 12
```

Allow 8–12 s: the pose model loads and warms up first (about 5 s). Without any recording: `fake_hub --persons 3` (three made-up people, README.md, "Testen ohne Kinect").

## Good to know

- **Mirrored image:** image coordinates (`labels`, `image.*`) are as the hub sends them (mirrored). World and room coordinates follow `ctx.x_sign`. Shaders get both right with `kinectUv()`.
- **Very close people** (under about 0.7 m) have little depth, so their masks have holes.
- **A dress held out** at arm's length can be found as a second person by the pose model.
- **Reflections and people far away:** the pose model also finds people where the depth measures nothing (or only noise): in a window or a glass door, or far away. They are followed but not confirmed: a person shows (gets an id and a slot) once a pose of it lies on measured depth. Someone walking in from far away shows a moment later, when the depth reaches them.
- **Loose clothes** and things a person holds belong to the person as long as they move. Something left lying still for 8 s outside the person's body parts becomes background.
- **Skeleton quality:** keypoints are exact to about 1–2 px (median). The depth of elbows, wrists and hands is measured on the person's pixels around them (delayed: about 2 cm median, live: about 5 cm on fast arms). Knees and ankles are kept at their learned bone lengths and smoothed. For effects that need raw values, use `p.camera`.
- **Smoothing costs lag on fast arms:** the One-Euro filter of `p.joints` is steady when slow, but on jumping jacks it puts the hands about 5 cm (median) behind the raw `p.camera` points. A scene that needs every fast swing can read `p.camera` and smooth it itself.
