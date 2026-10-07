# Kinect v2 project

The user writes German (informal "du"); answer in German.

## Kinect data: always go through kinect-hub

Only one process can open the Kinect at a time. **kinect-hub** owns it and serves it to everyone. Several agents can work at the same time this way.

- Check whether it runs: `curl http://127.0.0.1:8090/api/status`. If it does not, start it: `kinect-hub\target\release\kinect-hub.exe`. Run it in the background and do not stop it if somebody else started it.
- Do **not** start `fn2_capture.exe`, `fn2_reconnect.exe`, `viewer.py --fn2` or `pointcloud.py` without `--hub` while the hub runs. They would fight over the sensor. Use `viewer.py --hub` / `pointcloud.py --hub` instead.
- Without hardware, or for reproducible tests, run your own hub on a separate port: `kinect-hub.exe --source synthetic --bind 127.0.0.1:8091`.
- Protocol: `kinect-hub/README.md`, or `GET /api` (machine-readable).
- Browser clients go in their own folder `web/<name>/` and use `/lib/kinect-stream.js`. The hub serves them immediately at `http://127.0.0.1:8090/<name>/`. Do not edit other agents' folders.
- Python: `kinect_hub.py` provides `Hub().depth()`, `.points()`, `.stream([...])` and `HubDepthSensor`.
- Coordinates: x right, y down, z forward, in mm. point = (lut.x * z, lut.y * z, z). The Kinect image is mirrored.

## Building

- Hub: `cargo build --release` in `kinect-hub/`. The running exe is locked; stop the hub only if you started it yourself. Lints deny `unwrap`/`expect`/`panic`/indexing; run `cargo clippy --release --all-targets` before finishing.
- Worker, DLLs, tools: `sh fn2/build.sh` (w64devkit gcc). libfreenect2 is a patched copy in `third_party/`; the changes are in `third_party/libfreenect2-fastreconnect.patch`.
- Robustness check after hub changes: `kinect-hub-probe abuse` must end with 0 errors and the healthy client at about 30 fps.
