# Kinect v2 project

The user writes German (informal "du"); answer in German.

## Building scenes: read `web/AGENTS.md`

Most tasks here are **scenes**: browser visuals that react to the Kinect. Every agent works in its own git worktree and runs its own Vite dev server; all of them use the one kinect-hub. `web/AGENTS.md` has everything you need, so read it first. Short version:

```bash
cd web && npm install            # once per worktree
npm run dev                      # in the background; prints your URL
npm run new my-scene             # web/scenes/my-scene/ from a template
npm run check my-scene           # headless render: errors, fps, screenshot web/.cache/shots/my-scene.png
```

The user sees the scenes of every worktree at http://127.0.0.1:8090/; each worktree lists only the scenes it added or changed against `main`. Edit only your own `web/scenes/<name>/`. `web/lib/` and `package.json` are shared, so ask before you change them.

## LED wall: read `web/WALL.md`

The scenes run on a 6 × 2 m LED wall (1008 × 336). One shared core handles it: `wall: true` makes the canvas the LED image, `ctx.wall` maps the Kinect onto the wall through the scene's projection (play field → wall, curves, mirror, body size; a default plus per-scene values), and the control center `http://127.0.0.1:<port>/control/` runs the output window `/wall/` (show, params per scene, projections, test images, wall setup). Do not build your own wall emulation into a scene.

## Show launcher: `start-wand.cmd`

The user's one-click launcher for the exhibition. It starts the hub, the main checkout's dev server, the kiosk output and the control center. The displays are detected automatically: the output goes only on the second display, never on the notebook's panel, and the control center goes maximized on the notebook's panel. Until it ends, it tunes Windows: power plan, priorities and efficiency mode. Windows services stay as they are: Windows restarts them within seconds. It keeps its journal and logs in `%LOCALAPPDATA%\kinect-wand\`.
- Do not run it unless asked: it changes system settings and stops what it started.
- It shares the notebook with the show, so it must stay cheap (about 5 ms CPU per second). Keep WMI, `Get-Process`, `Invoke-RestMethod`, display queries and `Write-Host` out of its loop; the header of `start-wand.ps1` says how.
- To test it, run `-NoWall -NoControl -Hub 8091`. For a dev server and kiosk of your own, add `-Checkout <worktree>` and set `KINECT_WALL_DIR`.
- End a test run by creating `quit.flag` in that folder.
- Diff the power plan and priorities before and after.
- From a Claude session, `%LOCALAPPDATA%` is virtualized: the desktop app is an MSIX package. Your test runs write to `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local\kinect-wand\`, and those files hide the user's real ones. To read or write the real files, such as the `quit.flag` of the user's run, use a process started outside the package: `Invoke-CimMethod Win32_Process -MethodName Create`. To start the real launcher, run `explorer.exe <path>\start-wand.cmd`.

## Kinect data: always through kinect-hub

Only one process can open the Kinect at a time. **kinect-hub** owns it and serves it to every worktree and agent.

- Check whether it runs: `curl -s http://127.0.0.1:8090/api/status`.
- If it does not, start it in the background from the **main checkout**:
  - `MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')`
  - then `"$MAIN/kinect-hub/target/release/kinect-hub.exe"`
- Worktrees have no built hub or worker (`target/` and `fn2/bin/` are not in git). Do not build them there.
- Never stop a hub you did not start yourself.
- Do **not** start `fn2_capture.exe`, `fn2_reconnect.exe`, `viewer.py --fn2` or `pointcloud.py` without `--hub` while the hub runs; they would fight over the sensor. `viewer.py --hub` / `pointcloud.py --hub` are fine.
- Recorded people instead of an empty room, or reproducible tests: use a **replay hub** on a separate port. It loops a recording at the original frame rate and never touches the Kinect.
  - `ls "$MAIN/recordings"` lists the recordings (`*.k2rec`). `recordings/README.md` says what each one shows.
  - Multi-user recordings sorted by use case (occlusion, groups, sitting, empty room, …): `$MAIN/recordings/katalog/KATALOG.md`, with the time ranges in `katalog.json`.
  - Ready-cut and labelled clips: `$MAIN/recordings/clips/<case>/INDEX.md`. Each clip comes with `.json` (persons and occlusions every 6th frame) and `.png` (preview). Cut and label more clips with `recordings/katalog/werkzeuge/clip.py` and `label_clips.py`.
  - `curl -s http://127.0.0.1:8091/api/status`: if it answers with `"source":"replay"`, use that hub. Otherwise start one in the background: `"$MAIN/kinect-hub/target/release/kinect-hub.exe" --source replay "$MAIN/recordings/<name>.k2rec" --bind 127.0.0.1:8091`. If another kind of hub holds 8091, take 8092, 8093, ….
  - Scenes then use `?hub=8091`; for `npm run check`, append `-- --hub 8091`.
  - No recording yet: `--source synthetic` instead of `--source replay <file>` gives moving spheres in a room.
- New recordings need someone in front of the sensor, so ask the user. Then `"$MAIN/kinect-hub/target/release/kinect-hub-probe.exe" record --seconds 30 --out "$MAIN/recordings/<name>.k2rec"` reads from the running hub (not the sensor). Recordings show the room and people: `recordings/` is git-ignored; never commit or upload them.
- Protocol: `kinect-hub/README.md`, or `GET /api` (machine-readable). Dev servers announce themselves at `POST /api/devservers` (done by the Vite plugin).
- Python: `kinect_hub.py` provides `Hub().depth()`, `.points()`, `.stream([...])` and `HubDepthSensor`.
- Coordinates: x right, y down, z forward, in mm. point = (lut.x * z, lut.y * z, z). The Kinect image is mirrored.
- The worker decodes the depth on the CPU by default (`--pipeline fast`, fn2/fast_depth.cpp, above normal priority: the sensor keeps 30 fps on a busy CPU), so the GPU belongs to the scenes and the hub's pose model. A scene that saturates the GPU still costs CPU and power on this APU; `npm run check` reports the sensor rate. `--pipeline cl` = the old OpenCL decoding on the GPU.
- The hub tracks persons itself (streams `persons` / `persons_live`, pose model with DirectML): scenes with `streams: ['persons']` take them automatically. `?persons=local` forces the old in-browser tracker for comparisons.
- The hub spends the GPU where it is seen: it tracks only while a page subscribes (a page hidden for 3 s unsubscribes), poses 3×/s with the cheapest model while nobody is in the room, and steps the pose model down while a visible page renders below its target fps.

## Building the hub and the worker (main checkout only)

- Hub: `cargo build --release` in `kinect-hub/`. Once per checkout for the pose model (stream `poses`): `powershell -NoProfile -ExecutionPolicy Bypass -File kinect-hub/setup-onnxruntime.ps1` fetches `onnxruntime.dll` (not in git). Without it the hub runs without poses and says so in `/api/status`.
  - The running exe is locked. Stop the hub only if you started it yourself, or rename the running exe before building.
  - Lints deny `unwrap`/`expect`/`panic`/indexing. Run `cargo clippy --release --all-targets` before finishing.
- Worker, DLLs, tools: `sh fn2/build.sh` (w64devkit gcc; from a worktree `T=<main>/third_party sh fn2/build.sh`). Depth decoder tools: `fn2_rawdump` (raw packets, needs the Kinect) and `depth_bench` (compares decoders offline). libfreenect2 is a patched copy in `third_party/`; the changes are in `third_party/libfreenect2-fastreconnect.patch`.
- Robustness check after hub changes: `kinect-hub-probe abuse` must end with 0 errors, the healthy client at about 30 fps, and "dev server registry: ... OK".
