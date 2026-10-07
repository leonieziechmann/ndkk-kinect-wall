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

The user sees the scenes of every worktree at http://127.0.0.1:8090/. Edit only your own `web/scenes/<name>/`. `web/lib/` and `package.json` are shared, so ask before you change them.

## Kinect data: always through kinect-hub

Only one process can open the Kinect at a time. **kinect-hub** owns it and serves it to every worktree and agent.

- Check whether it runs: `curl -s http://127.0.0.1:8090/api/status`.
- If it does not, start it in the background from the **main checkout**:
  - `MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')`
  - then `"$MAIN/kinect-hub/target/release/kinect-hub.exe"`
- Worktrees have no built hub or worker (`target/` and `fn2/bin/` are not in git). Do not build them there.
- Never stop a hub you did not start yourself.
- Do **not** start `fn2_capture.exe`, `fn2_reconnect.exe`, `viewer.py --fn2` or `pointcloud.py` without `--hub` while the hub runs; they would fight over the sensor. `viewer.py --hub` / `pointcloud.py --hub` are fine.
- Without hardware, or for reproducible tests, run your own synthetic hub on a separate port: `"$MAIN/kinect-hub/target/release/kinect-hub.exe" --source synthetic --bind 127.0.0.1:8091`. Scenes then use `?hub=8091`; for `npm run check`, append `-- --hub 8091`.
- Protocol: `kinect-hub/README.md`, or `GET /api` (machine-readable). Dev servers announce themselves at `POST /api/devservers` (done by the Vite plugin).
- Python: `kinect_hub.py` provides `Hub().depth()`, `.points()`, `.stream([...])` and `HubDepthSensor`.
- Coordinates: x right, y down, z forward, in mm. point = (lut.x * z, lut.y * z, z). The Kinect image is mirrored.
- The depth decoding (OpenCL) shares the GPU with the browser. A scene that saturates the GPU drops the sensor rate; `npm run check` reports it.

## Building the hub and the worker (main checkout only)

- Hub: `cargo build --release` in `kinect-hub/`.
  - The running exe is locked. Stop the hub only if you started it yourself, or rename the running exe before building.
  - Lints deny `unwrap`/`expect`/`panic`/indexing. Run `cargo clippy --release --all-targets` before finishing.
- Worker, DLLs, tools: `sh fn2/build.sh` (w64devkit gcc). libfreenect2 is a patched copy in `third_party/`; the changes are in `third_party/libfreenect2-fastreconnect.patch`.
- Robustness check after hub changes: `kinect-hub-probe abuse` must end with 0 errors, the healthy client at about 30 fps, and "dev server registry: ... OK".
