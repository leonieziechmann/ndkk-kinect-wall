# The LED wall: setup, mapping, output window, control center

The installation is a **6 m × 2 m LED wall (1008 × 336 LEDs)** with the Kinect in front of it at mid-wall. People stand 1–4 m away and should see themselves on the wall: mirrored, in real size, and able to walk from one end of the wall to the other, although the Kinect only sees about 1.4 m of width per meter of distance.

Everything about the wall lives in one shared core, so scenes do not each emulate the wall on their own:

| | |
|---|---|
| **Wall setup** | LED pixels, size, where the Kinect stands, how people are mapped onto the wall, color correction. One setup for every scene and every worktree, edited in the control center. |
| **`ctx.wall`** | the setup plus the mapping Kinect → wall, in JavaScript and WGSL (`lib/wall.js`). |
| **`wall: true`** | the scene renders the LED image: canvas = LED pixels (1008 × 336), the page shows it scaled to fit. |
| **Output window** `/wall/` | what goes to the LED controller: the LED image pixel-exact on the screen, plays the show, switches scenes with a crossfade. |
| **Control center** `/control/` | the presenter: the show (playlist with params per entry), next/previous, blackout, test images, a live preview, the wall setup with a top view of the room and block zones. |

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
| room | m | floor y = 0, origin on the floor below the sensor, z forward (see PERSONS.md) |
| world | m | as `ctx.persons` and `ctx.camera` |

The LEDs cover wall x 0..`size.w` and wall y `bottom`..`bottom + size.h`.

## The mapping (Zuordnung)

Set in the control center, tab "Wand-Setup", folder "Zuordnung":

- **Mirror:** everyone sees themselves on their own side, independent of the key `m`.
- **Sideways** (`map.mode`):
  - `real`: 1:1, everybody exactly in front of themselves.
  - `factor`: the lateral distance from the sensor × `map.factor`.
  - `fit`: the Kinect's view at the **reference distance** (`map.distance`, e.g. 3.5 m) spans the whole wall: walking from the left edge of the view to the right edge at that distance crosses the whole wall. The factor is computed per side, so it also works with the sensor off-center. `map.depth` (0..1) blends towards the view angle: at 1 the view's edges reach the wall's edges at every distance.
- **What is stretched** (`map.apply`):
  - `person` (default): only each person's position. The body keeps its real size and is shifted as a whole (from its body center). "Den Raum strecken, nicht reinzoomen."
  - `points`: every point. Bodies get wider by the factor.
- **Hold at the edge** (`map.clamp`, `map.margin`): a person never leaves the wall; their center stays `margin` m inside it.
- **Height:** `map.lift` (m) and `map.scaleY`. The wall's `bottom` is its lower edge above the floor.
- **Camera image scenes** (`map.image`): how `kinectUv()` shows the camera image on the LED image (see below).
- **Zone** (`zone.near`..`zone.far`, m from the sensor): `wallPerson()` and `inZone` only count people inside it.
- **Floor:** detected by the person tracker (`sensor.floor: 'auto'`), or the sensor's height and tilt by hand.

## Block zones (Sperrzonen)

Places on the floor where nobody is tracked: the bar, a walkway behind the audience, the technician's desk, a reflecting surface. Drawn as polygons in the control center ("Wand-Setup" → top view → "Sperrzone zeichnen"), on top of a floor plan of the room ("Grundriss aktualisieren": one Kinect frame projected straight down onto the floor in 5 cm cells, showing what stands between 15 cm and 2 m: walls, tables, other stations, people; the floor faintly, the ceiling left out). Corners can be dragged; a zone can be switched off or deleted.

- Stored in the setup as `blocks: [{ id, name, enabled, points: [[x, z], ...] }]` on the **floor plan**: x = m from the wall's left edge (as the audience sees it, where people really stand), z = m in front of the wall. They do not depend on mirror or stretch.
- A person whose **feet** (the floor point below them) stand in a zone is removed from the tracking result before any scene sees it: `ctx.persons`, `ctx.kinect.persons` (labels, depth, indices, list), the GPU masks and skeletons, `wallPerson()`. Scenes need nothing for it (`ctx.wall.filterPersons()`, hooked in by the runtime as `ctx.kinect.personFilter`).
- `ctx.wall.blockedPersons`: who was removed in the last result (`{ id, slot, x, z }`); the top view shows them as gray crosses. `ctx.wall.plan(room)`, `ctx.wall.blockAt(x, z)` for scenes that want the floor plan.

## ctx.wall (JavaScript)

Updated by the runtime before every `frame()`. Points are arrays; methods take an optional `out` array.

| | |
|---|---|
| `setup` | the normalized setup (read only): `led`, `size`, `bottom`, `sensor`, `mirror`, `zone`, `map`, `color`, `output` |
| `led`, `size`, `pxPerM` | `{w, h}` LED pixels, `{w, h}` meters, `[px/m x, y]` |
| `active`, `output` | the canvas is the LED image (wall scene or output window); this is the output window |
| `persons` | per visible person: `{ person, id, slot, color, x, y, z, dist, lateral, real, shift, shiftRate, vx, vy, u, v, px, py, feet, top, room, inZone, near }`; `x` = mapped body center (m from the left edge), `real` = where they really stand, `vx` = speed across the wall incl. the stretched walk |
| `place(person)` | the same for one person |
| `joint(person, 'rightHand')` | a joint on the wall `[x, y, z]` (m) or null |
| `jointVelocity(person, 'rightHand')` | its velocity on the wall (m/s) or null |
| `fromWorld(p, slot)`, `fromRoom(r, slot)`, `fromCamera(c, slot, mm = true)` | → wall `[x, y, z]`; `slot` (or a Person) applies that person's shift; 0 = stretched like points |
| `velocity(worldPoint, worldVel, slot)` | → wall m/s |
| `uv([x, y])`, `px([x, y])`, `fromUv(u, v)`, `fromPx(x, y)`, `onWall([x, y])` | wall ↔ LED image |
| `imageToWall(u, v, rays)` | depth image pixel → wall, as `kinectUv()` shows the camera image |
| `near(dist)` | 1 at the zone's near end … 0 at its far end |
| `k(lat, z)` | the stretch factor at distance z on the side of `lat` |
| `room` | `{ matrix, inverse, found, height, source }` world → room actually used |
| `plan(room)`, `blockAt(x, z)`, `blockedPersons` | floor plan `[x, z]` (m from the left edge, m in front of the wall), the block zone there, who a block zone removed |
| `pointer` | the mouse on the wall: `{ x, y, u, v, down, inside }` (for testing without people) |
| `mirror(p)` | wall point → mirror world behind the wall for 3D: x from the wall center, y up, z = −distance |
| `buffer(device)` | the uniform buffer for your own pipelines (WGSL: `wallWgsl(group, binding)` from `/lib/wall.js`) |

`offAxisProjection(eye, wallW, wallH, bottom, near, far)` from `/lib/wall.js` gives a projection that looks through the wall rectangle from an eye point (3D mirror scenes like `cyberspiegel`): `eye = [x from the wall center, height, distance]`.

## WGSL

In `createShaderPass` everything below is there. In your own pipelines put `wallWgsl(group, binding)` in front of your code and bind `ctx.wall.buffer(device)` there.

```wgsl
WALL                                   // the setup (struct Wall in lib/wall.js): WALL.led, WALL.size, WALL.near, WALL.far, ...
wallFromWorld(p, slot) -> vec3f        // world point (pointAt(), personJoint()) -> wall m
wallFromRoom(r, slot) -> vec3f
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

`wallPerson` is the people projected onto the wall: every person pixel goes through the mapping (mirror, stretch, per-person shift) into a grid of 2 × 2 LEDs; the nearest point wins, single holes are filled. A person covers as much wall as they are wide, near the sensor or far away (meters, not pixels). Own pipelines: `createWallPersons(ctx)` from `/lib/wall-persons.js` (`update(encoder)`, `.view`).

**Camera image scenes.** On the LED image `kinectUv(uv)` (and `ctx.kinectToScreen()`) show the camera image as it falls on the wall for things at the reference distance: people standing there appear in real size at their mirrored place. With `map.image: 'true'` (default) in true proportions, so the image is narrower than the wall; with `'stretch'` it is stretched sideways like the mapping and fills the wall (bodies get wider). This is why the old 2D templates already work on the wall. For exact silhouettes use `wallPerson()`.

## Output window and control center

**Open the control center:** `http://127.0.0.1:<port>/control/` (link in the gallery). Then "Ausgabe öffnen":

- **Kiosk-Fenster auf dem LED-Bildschirm** starts a browser of its own (Chrome/Edge, own profile in `web/.cache/wall-browser/` of the main checkout) borderless on the screen chosen in "Wand-Setup → Bildschirm für die Ausgabe wählen" (Chrome asks once for permission to list the screens). It forces one CSS pixel per screen pixel. The same from a terminal: `npm run wall` (or `npm run wall -- --screen 1920,0,1920,1080`). Close it with Alt+F4 or "Ausgabe schließen".
- **Fenster in diesem Browser** opens `/wall/` as a popup; click into it or press `f` for fullscreen.

**Live preview without a window:** with "Live-Vorschau hier abspielen" the control center plays the show itself, in its preview area (`/wall/?embed` in a frame: a full output with its own Kinect connection and person tracking). As soon as an output window runs, the preview switches back to that window's picture, so the GPU never runs both. Handy while developing: the "▶" on a scene in the list shows it at once without adding it to the show.

The output window places the LED image at "Versatz x/y" with "Abbildung: pixelgenau" (what LED controllers expect: they take a region of the HDMI picture, usually from the top left). Set the LED screen to 100 % scaling in Windows. "Fenster füllen" stretches it over the whole window for controllers that scale the full input.

**Show:** add scenes from the list ("+"), order them, give each entry a label, a duration and its own param values ("✎"; changes apply live on the wall when that entry plays). The same scene may appear twice with different values ("⧉"). "Werte der Szenen-Seite übernehmen" copies what you tuned on `/scenes/<name>/` in this browser. "Automatisch weiter" switches after the duration, by default only when nobody stands in front of the wall (at most "höchstens … s" later). Transitions: crossfade, over black, or a cut. Keys: `→`/`←` next/previous, `B` blackout.

**The same scene after itself** (two entries of one scene, "▶" on the entry that runs, a command sent twice): the output starts no second instance. The running one takes the new entry's values: with a crossfade, numbers and colors glide there over the fade time and everything else switches at once (over black: while it is black; cut: at once). The scene keeps running and keeps its state (no restart); only one stopped by an error starts fresh. The reason: all instances of a scene share its module (`let pass` in `main.js`), so two at once would use and free each other's resources. Module-level state in a scene is fine because of this, but read `ctx.params` in `frame()`, not only in `setup()`, or a new entry's values will not show.

**Test images** (on the wall): raster with cabinets, numbered cabinets, 1-pixel frame, colored corners (red top left, green top right, blue bottom left, yellow bottom right) and a circle that must look round; color bars, gray steps, moving bars, full white/red/green/blue. **"Kalibrierung"** draws the people as the mapping puts them: their skeleton, a dashed line where they really stand, the 1 m grid, the sensor, and where the view at the reference distance ends. With "über der Szene" it lies over the running scene.

**Setting up on site:**
1. Grid test image: check the LED controller mapping (frame complete, corners right, circle round). Adjust "Versatz" or the controller.
2. Enter the wall size and where the Kinect stands (sideways from the center, in front of the wall). Floor: automatic usually works; else height and tilt by hand.
3. "Kalibrierung": stand in front of the wall at a few places. With mode `real` the dashed line and your skeleton must be exactly in front of you. Wrong side? Toggle "Spiegeln".
4. Choose the mapping: `fit` with the reference distance where people usually stand (3–3.5 m); the top view shows the factor and where the view lands on the wall.
5. Color: brightness (LED walls are very bright indoors), gamma, white balance. These apply only to the output window, on top of every scene.

**Where things are saved:** the setup in `web/.cache/wall/setup.json` **of the main checkout** (one wall for every worktree), the show in `web/.cache/wall/show.json` of each checkout (their scenes differ). Without a dev server (build served by the hub) both live in the browser's localStorage. "Exportieren"/"Importieren" in the setup tab saves both as one JSON file.

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
4. Keep scene-specific options (fluid, colors, game rules) as params: they become per-entry values in the control center.
5. Check with `npm run check <name> -- --hub 8091` and in the output window with the "Kalibrierung" test image over the scene.

## Files

| | |
|---|---|
| `lib/wall.js` | setup (defaults, fields, normalize), `WallMap` (= `ctx.wall`), `wallWgsl()`, `offAxisProjection()` |
| `lib/wall-persons.js` | the people projected onto the wall (GPU), used by `wallPerson()` |
| `lib/wall-bus.js` | messages between the pages, loading/saving setup and show |
| `lib/wall-show.js` | the show (playlist), test image names |
| `lib/wall-output.js` | the output window: show, test images, color correction, telemetry |
| `lib/control.js`, `control.html`, `lib/control.css` | the control center |
| `tools/wall-launch.js`, `tools/wall-window.mjs` | the kiosk window (`npm run wall`) |
