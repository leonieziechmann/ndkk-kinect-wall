# Kinect v2 project

The user writes German (informal "du"); answer in German.

## Building scenes: read `wall-bevy/SCENES.md`

Most tasks here are **scenes**: native visuals for the LED wall that react to the Kinect (Rust, Bevy 0.20, wgpu). Each scene is its own crate in `wall-bevy/scenes/<name>/`, built into a library that the running output loads and swaps in when it is rebuilt: the output never has to be restarted for a scene. Every agent works in its own git worktree; all of them use the one kinect-hub. `wall-bevy/SCENES.md` has the framework (sketch API, drawing, UI elements, persons, sound), so read it first. Short version:

```bash
cd wall-bevy
cargo build --release                                     # once per worktree (10-20 min the first time; target/ is not in git)
./target/release/wall-bevy --new-scene my-scene           # scenes/my-scene/ from the template
./target/release/wall-bevy --watch --scene my-scene --windowed   # rebuilds and swaps it on every save (in the background)
./target/release/wall-bevy --hub 8091 --scene my-scene --shots /tmp/shots-my-scene --seconds 8   # headless: PNGs, frames.json (fps, CPU per frame, errors)
```

- Edit only your own `wall-bevy/scenes/<name>/`. The framework `wall-bevy/wall/`, the output `wall-bevy/src/` and the control center's page `wall-bevy/control/` are shared, so ask before you change them. A change in `wall/` or `src/` needs every scene rebuilt and the output restarted, one in `control/` the output rebuilt and restarted.
- Always build the whole workspace (`cargo build --release` in `wall-bevy/`), never one package with `-p`: the libraries must fit the output they are loaded into. Rust 1.97 or newer (`rustup update`). `cargo clippy --release --all-targets` must stay free of warnings.
- Without the Kinect: `./target/release/fake_hub --bind 127.0.0.1:8099 --persons 3` (three made-up people) and `--hub 8099`, or a replay hub (below). `wall-bevy/README.md` has the test options.
- The full scene API (own shaders, Kinect data on the GPU, `WallMap`): `wall-bevy/PORTING.md`; the people: `wall-bevy/PERSONS.md`.
- The user sees the show on the wall and the control center at http://127.0.0.1:8095/ (built into the output). A scene appears in its scene list as soon as the running output has loaded its library; ▶ plays it.

## LED wall: read `wall-bevy/WALL.md`

The scenes run on a 6 × 2 m LED wall (1008 × 336). One shared core handles it: every scene renders the LED image, `ctx.wall` (`WallMap`) maps the Kinect onto the wall through the scene's projection (play field → wall, curves, mirror, body size; a default plus per-scene values), and `f.bodies()` gives the people already mapped, in LED pixels. Do not build your own wall emulation into a scene.

The control center is part of the output (`wall-bevy/src/control/`, its page `wall-bevy/control/`: plain HTML/JS/CSS without a build step, compiled into the program; `--control-dir control` serves it from disk while you work on it): show, params per entry, projections, test images, wall setup, live preview. It listens on port 8095 (`--control-port`) of every network interface: phones and tablets in the same network pair with a code or QR code (tab "Fernbedienung"); pages on 127.0.0.1 need no code. The documents live in the output's data folder, `wall-bevy/data/` of the main checkout (`--data DIR` or `KINECT_WALL_DIR` for another one; git-ignored): `setup.json`, `projection.json`, `show.json`, `bevy-store.json` (what scenes keep), `control-code.txt`, `control.json` (the address of the show's control center; test windows with `--windowed`, `--scene` or `--watch` do not write it). A test output with `--shots` writes none of them.

## Show launcher: `start-wand.cmd`

The user's one-click launcher for the exhibition. It starts the hub and the output `wall-bevy` (with its control center) from the main checkout, and opens the control center as an app window. The displays are detected automatically: the output goes only on the second display, never on the notebook's panel (without one it stays closed, and with it the control center), and the control center goes maximized on the notebook's panel. Until it ends, it tunes Windows: power plan, priorities and efficiency mode. Windows services stay as they are: Windows restarts them within seconds. It keeps its journal and logs in `%LOCALAPPDATA%\kinect-wand\`.
- Do not run it unless asked: it changes system settings and stops what it started.
- It shares the notebook with the show, so it must stay cheap (about 5 ms CPU per second). Keep WMI, `Get-Process`, `Invoke-RestMethod`, display queries and `Write-Host` out of its loop; the header of `start-wand.ps1` says how.
- `-Minimal` (desktop icon "Kinect-Wand starten (minimal)"), for a show that stutters now and then: the power plan is a copy of Balanced with only no sleep, lid, USB and PCIe (no CPU minimum or boost, which takes the APU's power and heat budget from the GPU), no priorities or efficiency mode, and the loop looks at windows, displays and the hub less often.
- **R** in its window records training data while the show runs: 5 min (`-RecordMinutes`) of depth and IR from the hub with `kinect-hub-probe record`, into `recordings/wand-<date>-<time>.k2rec`. It asks for consent first and checks the free disk space.
- `-Fn2`: the hub it starts uses libfreenect2's worker instead of the Rust driver (fallback if kinect-driver misbehaves). Its status line shows the driver ("Treiber Rust compat" / "libfreenect2").
- It passes the hub its pose models (`kinect-hub/models/`) explicitly, so hub builds from before that folder find them too. `-Bevy` has no effect any more.
- To test it, run `-NoWall -NoControl -Hub 8091`. For an output of your own, add `-Checkout <worktree>` and set `KINECT_WALL_DIR` (else it uses that checkout's `wall-bevy/data/`).
- End a test run by creating `quit.flag` in that folder.
- Diff the power plan and priorities before and after.
- From a Claude session, `%LOCALAPPDATA%` is virtualized: the desktop app is an MSIX package. Your test runs write to `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local\kinect-wand\`, and those files hide the user's real ones. To read or write the real files, such as the `quit.flag` of the user's run, use a process started outside the package: `Invoke-CimMethod Win32_Process -MethodName Create`. To start the real launcher, run `explorer.exe <path>\start-wand.cmd`.

## Kinect data: always through kinect-hub

Only one process can open the Kinect at a time. **kinect-hub** owns it and serves it to every worktree and agent.

- Check whether it runs: `curl -s http://127.0.0.1:8090/api/status`.
- If it does not, start it in the background from the **main checkout**:
  - `MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')`
  - then `"$MAIN/kinect-hub/target/release/kinect-hub.exe"`
- Worktrees have no built hub or worker (`target/`, `kinect-driver/target/` and `fn2/bin/` are not in git). Do not build them there.
- Never stop a hub you did not start yourself.
- Do **not** start `fn2_capture.exe`, `fn2_reconnect.exe`, `kinect-driver.exe` on the sensor (`stream`, `record`, `info`, a worker without `KINECT_DRIVER_SOURCE`), `viewer.py --fn2` or `pointcloud.py` without `--hub` while the hub runs; they would fight over the sensor. `kinect-driver bench`/`replay` on a `.k2raw` file are fine. `viewer.py --hub` / `pointcloud.py --hub` are fine.
- Recorded people instead of an empty room, or reproducible tests: use a **replay hub** on a separate port. It loops a recording at the original frame rate and never touches the Kinect.
  - `$MAIN/recordings/INDEX.md` lists every recording: session, length, persons, tags, use (`training`, `test`, …) and path. `recordings/README.md` has the layout and its rules: one folder per session `recordings/<date>-<place>/aufnahmen/<name>.k2rec`, with `session.json` (the classification) and `README.md`.
  - Never use what lies in `recordings/_gesperrt/` (recognizable children) or `recordings/_doppelt/` (copies); never train on `test` recordings (`final-*`, `alt-*`).
  - Sorted by use case (occlusion, groups, sitting, empty room, …): the catalogs `$MAIN/recordings/2026-10-08-besuch/KATALOG.md` and `$MAIN/recordings/2026-10-10-ndkk/KATALOG.md`, with the time ranges in their `katalog.json`.
  - Ready-cut and labelled clips: `$MAIN/recordings/clips/<case>/INDEX.md`. Each clip comes with `.json` (persons and occlusions every 6th frame) and `.png` (preview). Cut clips with `clip.py` in a session's `werkzeuge/`, label a folder with `recordings/werkzeuge/clips_index.py <case>`.
  - `curl -s http://127.0.0.1:8091/api/status`: if it answers with `"source":"replay"`, use that hub. Otherwise start one in the background: `"$MAIN/kinect-hub/target/release/kinect-hub.exe" --source replay "$MAIN/recordings/<session>/aufnahmen/<name>.k2rec" --bind 127.0.0.1:8091`. If another kind of hub holds 8091, take 8092, 8093, ….
  - The output then uses `--hub 8091` (also with `--watch` and `--shots`).
  - No recording yet: `--source synthetic` instead of `--source replay <file>` gives moving spheres in a room.
- New recordings need someone in front of the sensor, so ask the user. Then `"$MAIN/kinect-hub/target/release/kinect-hub-probe.exe" record --seconds 30 --out "$MAIN/recordings/<name>.k2rec"` reads from the running hub (not the sensor); file it into a session afterwards (`recordings/README.md`, "Neue Aufnahmen einsortieren"). Recordings show the room and people: `recordings/` is git-ignored; never commit or upload them.
- Protocol: `kinect-hub/README.md`, or `GET /api` (machine-readable).
- Python: `kinect_hub.py` provides `Hub().depth()`, `.points()`, `.stream([...])` and `HubDepthSensor`.
- Coordinates: x right, y down, z forward, in mm. point = (lut.x * z, lut.y * z, z). The Kinect image is mirrored.
- The hub's capture worker is the Rust driver `kinect-driver/target/release/kinect-driver.exe` (mode `compat` = libfreenect2's results; `--driver-mode extended` = more range, about twice the CPU); without it, or with `--worker fn2` (start-wand `-Fn2`), libfreenect2's `fn2/bin/fn2_capture.exe`. `/api/status` → `worker.heartbeat.decoder` says which.
- The worker decodes the depth on the CPU by default (`--pipeline fast`, kinect-driver compat or fn2/fast_depth.cpp, above normal priority: the sensor keeps 30 fps on a busy CPU), so the GPU belongs to the scenes and the hub's pose model. A scene that saturates the GPU still costs CPU and power on this APU; the control center's status tab and `/api/status` report the sensor rate. `--pipeline cl` = decoding on the GPU.
- The hub tracks persons itself (streams `persons` / `persons_live`, pose model with DirectML; the models are in `kinect-hub/models/`): scenes with `persons: live` or `exact` take them automatically.
- The hub spends the GPU where it is seen: it tracks only while a client subscribes, poses 3×/s with the cheapest model while nobody is in the room, and steps the pose model down while the output renders below its target fps.

## Building the hub and the worker (main checkout only)

- Hub: `cargo build --release` in `kinect-hub/`. Once per checkout for the pose model (stream `poses`): `powershell -NoProfile -ExecutionPolicy Bypass -File kinect-hub/setup-onnxruntime.ps1` fetches `onnxruntime.dll` (not in git). Without it the hub runs without poses and says so in `/api/status`.
  - The running exe is locked. Stop the hub only if you started it yourself, or rename the running exe before building.
  - Lints deny `unwrap`/`expect`/`panic`/indexing. Run `cargo clippy --release --all-targets` before finishing.
- Worker (Rust driver, the default): `cargo build --release` in `kinect-driver/` (about 3 min; w64devkit gcc). Clippy: `cargo clippy --workspace --all-targets --all-features`. Test it without the Kinect: a hub on another port with `KINECT_DRIVER_SOURCE=<file>.k2raw` (raw packets, `recordings/2026-10-15-rohpakete/`).
- libfreenect2 worker (fallback), DLLs, tools: `sh fn2/build.sh` (w64devkit gcc; from a worktree `T=<main>/third_party sh fn2/build.sh`). Depth decoder tools: `fn2_rawdump` (raw packets, needs the Kinect) and `depth_bench` (compares decoders offline). libfreenect2 is a patched copy in `third_party/`; the changes are in `third_party/libfreenect2-fastreconnect.patch`.
- Robustness check after hub changes: `kinect-hub-probe abuse` must end with 0 errors, the healthy client at about 30 fps, and "http paths: ... OK".
