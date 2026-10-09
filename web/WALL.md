# The LED wall: setup, projection, output window, control center

The installation is a **6 m × 2 m LED wall (1008 × 336 LEDs)** with the Kinect in front of it at mid-wall. People stand 1–4 m away and should see themselves on the wall: mirrored, in real size, and able to walk from one end of the wall to the other, although the Kinect only sees about 1.4 m of width per meter of distance.

Everything about the wall lives in one shared core, so scenes do not each emulate the wall on their own:

| | |
|---|---|
| **Wall setup** | the physical wall: LED pixels, size, where the Kinect stands, the floor, color correction, block zones. One setup for every scene and every worktree, edited in the control center. |
| **Projection** | how people are mapped onto the wall: the play field on the floor, where it lands on the wall, response curves, edges, smoothing, body size. A default for every scene, and per scene only what differs (games need their own). Edited in the control center, tab "Projektion", with an assistant that measures the play field. |
| **`ctx.wall`** | the setup, the scene's projection and the mapping Kinect → wall, in JavaScript and WGSL (`lib/wall.js`). Each scene instance has its own. |
| **`wall: true`** | the scene renders the LED image: canvas = LED pixels (1008 × 336), the page shows it scaled to fit. |
| **Output window** `/wall/` | what goes to the LED controller: the LED image pixel-exact on the screen, plays the show, switches scenes with a crossfade. |
| **Control center** `/control/` | the presenter: the show (playlist with params per entry), next/previous, blackout, test images, a live preview, the projections, the wall setup with a top view of the room and block zones. |

Both pages exist on every dev server: `http://127.0.0.1:<port>/control/` and `/wall/`.

## A wall scene in 30 seconds

```js
// web/scenes/my-wall/main.js
import { createShaderPass } from '/lib/shader-pass.js';
import SHADE from './shade.wgsl?raw';
let pass;
export default {
  wall: true,                        // canvas = the LED image (ctx.width × ctx.height = 1008 × 336)
  streams: ['persons'],
  persons: { mode: 'full', delay: 0 },
  async setup(ctx) { pass = await createShaderPass(ctx, { shade: SHADE }); },
  frame() { pass.render(); },
};
```

```wgsl
// shade.wgsl: uv covers the LED image
fn shade(pos: vec2f, uv: vec2f) -> vec4f {
  let p = wallPerson(uv);                      // the people as they fall on the wall
  return vec4f(personColor(u32(p.z)) * p.x, 1.0);
}
```

The demo scene `wand-spiegel` is exactly this with glow and trails. Never hard-code the wall size, the LED resolution, the Kinect height or a stretch factor in a scene: read them from `ctx.wall`.

## Spaces

| space | unit | axes |
|---|---|---|
| **wall** | m | x from the wall's **left edge as the audience sees it**, y above the **floor**, z in front of the wall (towards the audience) |
| **uv** | 0..1 | over the LED image, y down (the `uv` of `shade()` in a wall scene) |
| **px** | LED pixels | `ctx.wall.led.w × ctx.wall.led.h` = `ctx.width × ctx.height` in a wall scene |
| **plan** | m | the floor seen from above: x from the wall's left edge (where people **really** stand), z in front of the wall. The play field and the block zones live here. |
| **norm** | 0..1 | the projection: x across its target range on the wall, y up its height range, z from the play field's front (0) to its back (1); outside the field below 0 / above 1 |
| room | m | floor y = 0, origin on the floor below the sensor, z forward (see PERSONS.md) |
| world | m | as `ctx.persons` and `ctx.camera` |

The LEDs cover wall x 0..`size.w` and wall y `bottom`..`bottom + size.h`.

## The projection (Projektion): per scene

How people land on the wall decides how a scene feels: a mirror wants real size, a game wants everybody to reach every corner of the wall without running, a top-down game wants the floor's depth as the wall's height. So the mapping is a **projection per scene**: a default for every scene, and per scene only the values that differ. Control center, tab **"Projektion"**: pick "Standard" or a scene, then drag, draw curves or use the assistant. Changes apply live when that scene plays.

The projection maps the Kinect's view into a 0..1 box (`norm`) and that box onto the wall:

- **Play field** (`field.near`, `field.far`, `field.nearL/nearR/farL/farR`, plan m): a trapezoid on the floor with a front and a back edge parallel to the wall. Across it, from its left to its right edge, is x 0..1 at every depth; front to back is z 0..1. Its shape is the stretch:
  - a **box** of width B = "the walk is stretched × wall width / B" (the old modes `factor` and `fit`);
  - the **view cone** = the view's edges reach the wall's edges at every distance (far back one walks further: parallax);
  - anything between, or wider at the front than at the back. The top view shows it in the view cone, with the lines where the wall's quarters lie and the stretch ("quer ×1.4 vorne … ×2.3 hinten").
- **Target on the wall** (`out.left`, `out.right`: m inside the left and right edge): where x 0 and 1 land. **Height**: the room's `field.low..field.high` (m above the floor) → the wall's `out.bottom..out.top` (m above the floor). 0..2 → 0..2 is real height; 0..1.8 → 0..2 lets raised hands reach the top.
- **Curves** (`curve.x`, `curve.y`, `curve.z`): a monotone response curve per axis (0 → 0, 1 → 1, up to 5 points), e.g. "Mitte ruhig, Ränder schnell". Beyond the field they go on along their end segments.
- **Mirror** (`mirror`): everyone sees themselves on their own side.
- **Body** (`apply`):
  - `person` (default): only each person's place goes through the projection; the body keeps its shape around it, × `body.scale`. With `body.fit: 'height'` everybody is scaled to `body.height` (children like adults; the standing height is the 80th percentile of the last 6 s, so crouching and jumping still show).
  - `points`: every point goes through it (bodies get wider where the walk is stretched).
- **Edge** (`edge`, `margin`): a person's place at the wall's edges: `clamp` (held `margin` m inside), `soft` (eases in), `free`.
- **Smoothing** (`smoothing` 0..1: a One-Euro filter on each person's place, little lag when moving fast) and **look-ahead** (`predict`, s: along the walk, against the tracking delay). The body moves as a whole; its own motion stays live.
- **Zone** (`zone.near`..`zone.far`, m in front of the wall): who counts (`inZone`, `wallPerson()`).
- **Camera image scenes** (`image.mode`, `image.distance`): how `kinectUv()` shows the camera image on the LED image (see below).

**Resolution:** the default, then what the scene asks for in its `main.js`, then the control center's values for the scene:

```js
export default {
  wall: true,
  // the scene's wishes (flat keys or nested); the control center can still change them
  projection: { 'body.scale': 0.6, smoothing: 0.3, edge: 'soft' },
};
```

The play field's corners belong to the room, so a scene asks for its `field` relative to the sensor (`fieldFromWish()`), and it is worked out for the room at hand:

| `field:` | the play field |
|---|---|
| `'cone'` | the view cone itself: its edges reach the wall's edges at every distance (`{ cone: 0.25 }`: 0.25 m inside it) |
| `'real'` | the wall itself: everybody exactly in front of themselves (1:1) |
| `{ depth: [0.6, 4], width: 4.8 }` | a box 4.8 m wide around the sensor, 0.6–4 m from it: the walk × wall width / 4.8, and stepping closer or back does not move one sideways |
| `{ depth: [0.8, 4], width: [1.8, 5] }` | a trapezoid between box and cone (1.8 m wide at the front, 5 m at the back) |
| `{ depth: [...] }` | only the depths (from the sensor); the default's shape carried along |

What the scenes ask for (`main.js`), as starting points to tune on site:

| scene | projection | why |
|---|---|---|
| `fluid-simulation`, `blasen-platzen` | trapezoid 1.8 → 5 m (0.8–4 m), curve "middle calm" (`curve.x` [[0.25, 0.29], [0.75, 0.71]]), smoothing 0.2 | the whole wall reachable (from about 2.5 m; in front the middle 4 m), yet one stands roughly where one shows (×1.1–1.5 in the middle at 2–3 m) |
| `fruit-ninja` | box 4.8 m (×1.25), soft edge, smoothing 0.25 | the fruit is thrown to the players: the ninja stays near where one stands and does not drift |
| `pixel-jump-run` | `'real'` (1:1), margin 0.45, smoothing 0.3 | position hardly matters (the obstacles cross the wall), but everybody finds their own figure right in front of them |
| `space-invaders`, `invaders-tracking` | box 2.9 m (×2), 0.5–4 m, smoothing 0.25 | top-down: straight walks stay straight on the map, its depth is the play field's |
| `leonie-ziechmann` | `'cone'`, margin 0.18, smoothing 0.15 | sideways by the view's angle (parallax in the wood) |
| `pixel-spiegel` | smoothing 0.2 | the big tiles must not flicker |
| the others | the default | mirrors and ads |

Ask only for what the scene needs by its nature.

**Assistant** ("Assistent: Spielfeld ablaufen …"): one person walks the play field's four corners (front left, front right, back right, back left) and stands still 2 s at each; then reaches up (optional: "hands up = top of the wall"). The wall shows a small floor plan meanwhile (the view cone, the corners so far, where to go, a progress ring around the person), so it works alone. The result is the trapezoid through the corners and, if wanted, the zone around it (± 0.3 m); "Übernehmen" sets it for the projection being edited.

**Floor:** detected by the person tracker (`sensor.floor: 'auto'`), or the sensor's height and tilt by hand (wall setup).

Older checkouts share `setup.json` and still read its old fields (`map`, `zone`, `mirror`); the projections live in `projection.json` beside it. Until that file exists, the default projection is derived from those old fields (the same mapping).

## Block zones (Sperrzonen)

Places on the floor where nobody is tracked: the bar, a walkway behind the audience, the technician's desk, a reflecting surface. Drawn as polygons in the control center ("Wand-Setup" → top view → "Sperrzone zeichnen"), on top of a floor plan of the room ("Grundriss aktualisieren": one Kinect frame projected straight down onto the floor in 5 cm cells, showing what stands between 15 cm and 2 m: walls, tables, other stations, people; the floor faintly, the ceiling left out). Corners can be dragged; a zone can be switched off or deleted.

- Stored in the setup as `blocks: [{ id, name, enabled, points: [[x, z], ...] }]` on the **floor plan**: x = m from the wall's left edge (as the audience sees it, where people really stand), z = m in front of the wall. They do not depend on mirror or stretch.
- A person whose **feet** (the floor point below them) stand in a zone is removed from the tracking result before any scene sees it: `ctx.persons`, `ctx.kinect.persons` (labels, depth, indices, list), the GPU masks and skeletons, `wallPerson()`. Scenes need nothing for it (`ctx.wall.filterPersons()`, hooked in by the runtime as `ctx.kinect.personFilter`).
- `ctx.wall.blockedPersons`: who was removed in the last result (`{ id, slot, x, z }`); the top view shows them as gray crosses. `ctx.wall.plan(room)`, `ctx.wall.blockAt(x, z)` for scenes that want the floor plan.

## ctx.wall (JavaScript)

Updated by the runtime before every `frame()`. Points are arrays; methods take an optional `out` array.

| | |
|---|---|
| `setup` | the normalized setup (read only): `led`, `size`, `bottom`, `sensor`, `color`, `output`, `blocks` |
| `projection` | the scene's projection (read only): `field`, `out`, `curve`, `mirror`, `apply`, `edge`, `margin`, `smoothing`, `predict`, `body`, `zone`, `image` |
| `led`, `size`, `pxPerM` | `{w, h}` LED pixels, `{w, h}` meters, `[px/m x, y]` |
| `active`, `output` | the canvas is the LED image (wall scene or output window); this is the output window |
| `persons` | per visible person: `{ person, id, slot, color, x, y, z, norm, plan, dist, lateral, real, scale, gain, vx, vy, u, v, px, py, feet, top, room, inZone, near }`; `x` = mapped body center (m from the left edge), `norm` = `[x, y, z]` 0..1 in the projection, `plan` / `real` = where they really stand, `scale` = body size on the wall, `gain` = wall m per floor m here, `vx` = speed across the wall incl. the stretched walk |
| `place(person)` | the same for one person |
| `joint(person, 'rightHand')` | a joint on the wall `[x, y, z]` (m) or null |
| `jointVelocity(person, 'rightHand')` | its velocity on the wall (m/s) or null |
| `fromWorld(p, slot)`, `fromRoom(r, slot)`, `fromCamera(c, slot, mm = true)` | → wall `[x, y, z]`; `slot` (or a Person) places the point with that person's body (apply `person`); 0 = through the projection like a single point |
| `norm(worldPoint, slot)` | → `[x, y, z]` 0..1 in the projection |
| `roomX(rx, rz, slot)`, `roomY(ry, slot)`, `zone` | for per-pixel loops over the person masks: room x, z → wall x; room height → wall y; `zone.near/far` in room z (m from the sensor). Never re-implement the mapping in a scene. |
| `mapX(planX, planZ)`, `mapY(y)`, `unmapY(y)`, `fieldZ(planZ)`, `fieldDepth(t)`, `fieldU(planX, planZ)`, `fieldAt(planZ)`, `edge(x)`, `gain(planX, planZ)`, `target` | the projection step by step: floor point → wall x (no person, no edge); height; depth 0..1 and back; across the field; its edges at a depth; the edge behavior; the stretch there; `[left, right]` of the target range |
| `offset`, `scale`, `visible` | per slot (`Float32Array(17)`): wall x = `offset + mirrorSign · planX · scale` for that person's points |
| `velocity(worldPoint, worldVel, slot)` | → wall m/s |
| `uv([x, y])`, `px([x, y])`, `fromUv(u, v)`, `fromPx(x, y)`, `onWall([x, y])` | wall ↔ LED image |
| `imageToWall(u, v, rays)` | depth image pixel → wall, as `kinectUv()` shows the camera image |
| `near(dist)` | 1 at the zone's near end … 0 at its far end (dist: m from the sensor) |
| `k(lat, z)` | the stretch (wall m per floor m) `lat` m beside the sensor, `z` m from it |
| `room` | `{ matrix, inverse, found, height, source }` world → room actually used |
| `plan(room)`, `blockAt(x, z)`, `blockedPersons` | floor plan `[x, z]` (m from the left edge, m in front of the wall), the block zone there, who a block zone removed |
| `pointer` | the mouse on the wall: `{ x, y, u, v, down, inside }` (for testing without people) |
| `mirror(p)` | wall point → mirror world behind the wall for 3D: x from the wall center, y up, z = −distance |
| `buffer(device)` | the uniform buffer for your own pipelines (WGSL: `wallWgsl(group, binding)` from `/lib/wall.js`) |

`offAxisProjection(eye, wallW, wallH, bottom, near, far)` from `/lib/wall.js` gives a projection that looks through the wall rectangle from an eye point (3D mirror scenes like `cyberspiegel`): `eye = [x from the wall center, height, distance]`.

## WGSL

In `createShaderPass` everything below is there. In your own pipelines put `wallWgsl(group, binding)` in front of your code and bind `ctx.wall.buffer(device)` there.

```wgsl
WALL                                   // setup and projection (struct Wall in lib/wall.js): WALL.led, WALL.size, WALL.near, WALL.far (zone, room z), WALL.slots[slot] (x offset, y scale, z visible, w offset/s), ...
wallFromWorld(p, slot) -> vec3f        // world point (pointAt(), personJoint()) -> wall m
wallFromRoom(r, slot) -> vec3f
wallNorm(r, slot) -> vec3f             // room point -> 0..1 in the projection
wallPlan(r) -> vec2f                   // room -> floor plan (m)
wallMapX(planX, planZ) -> f32          // floor point -> wall x (no person, no edge); wallMapY(y), wallRoomY(wallY) (inverse), wallFieldZ(planZ) 0..1, wallCurve(axis, t)
wallFromCamera(c, slot) -> vec3f       // Kinect camera point in m: (ray.x * z, ray.y * z, z)
wallRoom(world) -> vec3f               // world -> room
wallVelocity(r, v, slot) -> vec3f      // room point + room velocity -> wall m/s; wallVelocityWorld(world, v, slot)
wallUv(p) -> vec2f, wallPx(p) -> vec2f // wall m -> LED uv / pixels
wallAt(uv) -> vec2f                    // LED uv -> wall m (x, y)
wallOnWall(uv) -> bool
wallInZone(r) -> bool, wallNear(r) -> f32
wallMirror(p) -> vec3f                 // for 3D: mirror world behind the wall
wallToKinect(uv) -> vec2f              // LED uv -> depth image uv (camera image on the wall)
```

Only in `createShaderPass` (projected only if the shader uses them):

```wgsl
wallPerson(uv) -> vec4f      // x: covered 0..1 (soft edge), y: distance from the sensor (m), z: slot, w: infrared
wallPersonMask(uv) -> f32    // soft 0..1
wallPersonAt(uv) -> u32      // slot, 0 = nobody
```

`wallPerson` is the people projected onto the wall: every person pixel goes through the scene's projection (mirror, play field, each person's place and body size) into a grid of 2 × 2 LEDs; the nearest point wins, single holes are filled. A person covers as much wall as they are wide, near the sensor or far away (meters, not pixels). Own pipelines: `createWallPersons(ctx)` from `/lib/wall-persons.js` (`update(encoder)`, `.view`).

**Camera image scenes.** On the LED image `kinectUv(uv)` (and `ctx.kinectToScreen()`) show the camera image as it falls on the wall for things at the reference distance (`image.distance`, m in front of the wall): people standing there appear in real size at their mirrored place. With `image.mode: 'true'` (default) in true proportions, so the image is narrower than the wall; with `'stretch'` it is stretched sideways like the people (play field and curve) and fills the wall (bodies get wider). This is why the old 2D templates already work on the wall. For exact silhouettes use `wallPerson()`.

## Output window and control center

**Open the control center:** `http://127.0.0.1:<port>/control/` (link in the gallery). Then "Ausgabe öffnen":

- **Kiosk-Fenster auf dem LED-Bildschirm** starts a browser of its own (Chrome/Edge, own profile in `web/.cache/wall-browser/` of the main checkout) borderless on the screen chosen in "Wand-Setup → Bildschirm für die Ausgabe wählen" (Chrome asks once for permission to list the screens). It forces one CSS pixel per screen pixel. The same from a terminal: `npm run wall` (or `npm run wall -- --screen 1920,0,1920,1080`). Close it with Alt+F4 or "Ausgabe schließen".
- **Fenster in diesem Browser** opens `/wall/` as a popup; click into it or press `f` for fullscreen.

**Live preview without a window:** with "Live-Vorschau hier abspielen" the control center plays the show itself, in its preview area (`/wall/?embed` in a frame: a full output with its own Kinect connection and person tracking). As soon as an output window runs, the preview switches back to that window's picture, so the GPU never runs both. Handy while developing: the "▶" on a scene in the list shows it at once without adding it to the show.

The output window places the LED image at "Versatz x/y" with "Abbildung: pixelgenau" (what LED controllers expect: they take a region of the HDMI picture, usually from the top left). Set the LED screen to 100 % scaling in Windows. "Fenster füllen" stretches it over the whole window for controllers that scale the full input.

**Show:** add scenes from the list ("+"), order them, give each entry a label, a duration and its own param values ("✎"; changes apply live on the wall when that entry plays). The same scene may appear twice with different values ("⧉"). "Werte der Szenen-Seite übernehmen" copies what you tuned on `/scenes/<name>/` in this browser. "Automatisch weiter" switches after the duration, by default only when nobody stands in front of the wall, at most "höchstens … s länger bei 1 Person, … s ab … Personen" later (see "How long it may run over"). Games switch between their rounds instead ("Spiele: erst nach der Runde", at most its own "höchstens … s" later, default 120 s; see below). An entry switched to **pünktlich** ("⧗" in its row, `wait: false`) switches exactly after its duration, people in front or not: for ads. Transitions: crossfade, over black, or a cut. Keys: `→`/`←` next/previous, `B` blackout.

**Games: switch between rounds.** In a full room the wall is never empty, so the show would cut into a running round after duration + `maxWait`. A scene with rounds therefore says in every `frame()` whether one runs:

```js
ctx.holdSwitch = phase === 'countdown' || phase === 'play' || (phase === 'result' && resultTime < 2.5);
```

| `ctx.holdSwitch` | after the duration, the output … | control center |
|---|---|---|
| `true` (a round runs) | waits until it is `false`, at most `maxRoundWait` s (show field, default 120) | "wartet auf Rundenende (höchstens noch …)" |
| `false` (between rounds) | switches **right away, even with people in front**: the end of a round is a good moment | |
| never set (`undefined`) | as before: waits for an empty wall (`waitForEmpty`), at most the crowd limit (below) | "wartet, bis niemand davor steht (höchstens noch … · Grenze … bei n Personen)" |

- Set it on every frame, `true` from the countdown on, and keep it `true` for the first seconds of the result (crown, points) so people still see them: the crossfade starts at most 0.5 s after it turns `false`. Release it early enough that the output can switch before the next round starts (the next countdown sets it `true` again, and the wait starts over).
- A mode without rounds (an endless game) leaves it `undefined`, so the scene behaves like any other.
- Unchecking "Spiele: erst nach der Runde" (`waitForRound: false`) makes games behave like other scenes. An entry with `wait: false` never waits, not even for a round. "→" in the control center always switches at once.
- In the scenes: `fruit-ninja` (countdown, 60 s round, 2.5 s of the result), `pixel-jump-run` (countdown, run, 3 s of the result), `space-invaders` (a wave while people are there; 1.5 s of the fireworks of a cleared wave, 2.5 s of a fallen city).

**How long it may run over.** The fields of the show (`web/.cache/wall/show.json`), all edited next to "automatisch weiter":

| field | default | |
|---|---|---|
| `auto` | false | switch after each entry's `duration` (s) |
| `waitForEmpty` | true | ... only when nobody stands in front of the wall |
| `maxWait` | 120 | s it may run over with **one** person in front |
| `maxWaitMany` | = `maxWait` | s it may run over with `manyPersons` or more; in between linear |
| `manyPersons` | 10 | from this many people on, `maxWaitMany` applies |
| `waitForRound` | true | games (`ctx.holdSwitch`) switch between rounds instead, people in front or not |
| `maxRoundWait` | 120 | s a game may run over waiting for the end of a round (not by the crowd: a round lasts as long with one player as with ten) |
| entry `wait` | true | false: this entry switches exactly after its duration (ads) |

The crowd is the most people the output saw in front of the wall within the last 8 s, so a track lost for a moment does not shrink the limit. The limit follows the crowd while it waits: when people leave, it may switch sooner. Shows from before `maxWaitMany` keep their behavior (both limits = `maxWait`).

**The same scene after itself** (two entries of one scene, "▶" on the entry that runs, a command sent twice): the output starts no second instance. The running one takes the new entry's values: with a crossfade, numbers and colors glide there over the fade time and everything else switches at once (over black: while it is black; cut: at once). The scene keeps running and keeps its state (no restart); only one stopped by an error starts fresh. The reason: all instances of a scene share its module (`let pass` in `main.js`), so two at once would use and free each other's resources. Module-level state in a scene is fine because of this, but read `ctx.params` in `frame()`, not only in `setup()`, or a new entry's values will not show.

**Test images** (on the wall): raster with cabinets, numbered cabinets, 1-pixel frame, colored corners (red top left, green top right, blue bottom left, yellow bottom right) and a circle that must look round; color bars, gray steps, moving bars, full white/red/green/blue. **"Kalibrierung"** draws the people as the mapping puts them: their skeleton, a dashed line where they really stand, the 1 m grid, the sensor, and where the view at the reference distance ends. With "über der Szene" it lies over the running scene.

**Setting up on site:**
1. Grid test image: check the LED controller mapping (frame complete, corners right, circle round). Adjust "Versatz" or the controller.
2. Enter the wall size and where the Kinect stands (sideways from the center, in front of the wall). Floor: automatic usually works; else height and tilt by hand.
3. "Kalibrierung": stand in front of the wall at a few places. With mode `real` the dashed line and your skeleton must be exactly in front of you. Wrong side? Toggle "Spiegeln".
4. Tab "Projektion", "Standard": run the assistant (walk the play field's corners) or drag the play field in the top view; check the stretch it shows. Then the games: pick each one, adjust what differs (field, curves, smoothing, body size) and try it with "▶ auf der Wand" and "Kalibrierung".
5. Color: brightness (LED walls are very bright indoors), gamma, white balance. These apply only to the output window, on top of every scene.

**Where things are saved:** the setup and the projections in `web/.cache/wall/setup.json` and `projection.json` **of the main checkout** (one wall for every worktree), the show in `web/.cache/wall/show.json` of each checkout (their scenes differ). Without a dev server (build served by the hub) they live in the browser's localStorage. "Exportieren"/"Importieren" in the setup tab saves all three as one JSON file.

**How the pages talk:** over the dev server (HMR WebSocket, event `kinect:wall`, `lib/wall-bus.js`), so the output may run in another browser profile; a BroadcastChannel carries the messages too. The output reports what it plays several times a second (telemetry) and sends small preview pictures while a control center is open. The show runs in the output window: closing the control center does not stop it. A scene that throws in `frame()` is retried every 2 s and skipped after 3 errors in 30 s; one whose `setup()` fails is skipped after 5 s.

**Only scenes of the same dev server** can be played (the output imports them). For the event, merge the scenes into `main` and run the dev server there; other worktrees' control centers are linked at the bottom of the scene list.

## Porting a scene that emulates the wall itself

`neon-wall`, `cyberspiegel` and `blasen-platzen` were written before this core and carry their own wall params. To port one:

1. Add `wall: true`. Delete the params `viewMode`, `ledW`, `ledH`, `wallW`, `wallH`, `wallBottom`, `camX`, `front`, `mirror`, `stretch`, `zoneNear`, `zoneFar`, `camH`, `camTilt`, `live`-style wall options, and the letterbox code ("Vorschau"/"LED pixelgenau"): the canvas is the LED image now (`ctx.width × ctx.height`).
2. Delete `manualRoom()` and the room matrix choice: use `ctx.wall.room.matrix` or simply `ctx.wall.fromWorld(...)`.
3. Replace the own mapping with `ctx.wall`:
   - JS: `ctx.wall.fromWorld(p, person.slot)`, `.place(person).x`, `.uv()`, `.px()`, `.velocity()`, `.near()`, `.persons`.
   - WGSL: bind `ctx.wall.buffer(device)` and prepend `wallWgsl(group, binding)`; replace `wallX`/`wallUv`/`wallVx` and friends by `wallFromRoom`/`wallUv`/`wallVelocity`.
   - Mouse: `ctx.wall.pointer`.
4. Keep scene-specific options (fluid, colors, game rules) as params: they become per-entry values in the control center. Anything about where people land (own zone, own stretch, own min/max of the play area, own smoothing of positions, own body size) belongs to the projection: read `ctx.wall` (`norm`, `x`, `roomX/roomY/zone` in per-pixel loops) and, where the scene needs it by nature, ask for it in `projection: {...}`.
5. Check with `npm run check <name> -- --hub 8091` and in the output window with the "Kalibrierung" test image over the scene.

## Files

| | |
|---|---|
| `lib/wall.js` | setup and projections (defaults, fields, normalize, resolve per scene, curves), `WallMap` (= `ctx.wall`), `wallWgsl()`, `offAxisProjection()` |
| `lib/wall-persons.js` | the people projected onto the wall (GPU), used by `wallPerson()` |
| `lib/wall-bus.js` | messages between the pages, loading/saving setup and show |
| `lib/wall-show.js` | the show (playlist, auto advance settings), test image names |
| `lib/wall-output.js` | the output window: show and auto advance (`ctx.holdSwitch`), test images, color correction, telemetry |
| `lib/control.js`, `control.html`, `lib/control.css` | the control center |
| `lib/control-projection.js` | its tab "Projektion": top view, front view, curves, form, assistant |
| `tools/wall-launch.js`, `tools/wall-window.mjs` | the kiosk window (`npm run wall`) |
