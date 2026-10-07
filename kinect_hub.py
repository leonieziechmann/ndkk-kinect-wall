"""Python client for kinect-hub (the Kinect middleware: one process owns the sensor, any number of
clients read its stream). HTTP needs only the standard library and numpy; live streaming over
WebSocket additionally needs `pip install websockets`.

    from kinect_hub import Hub
    hub = Hub()                           # http://127.0.0.1:8090
    depth = hub.depth()                   # newest frame: uint16 (424, 512) in mm, 0 = no measurement
    xyz = hub.points()                    # int16 (424, 512, 3) in mm; x right, y down, z forward
    print(hub.status()["fps"])

    for frame in hub.stream(["depth", "ir"]):          # live (websockets)
        print(frame.name, frame.seq, frame.data.shape, f"{frame.age_ms:.1f} ms old")

`HubDepthSensor` mimics fn2.Fn2DepthSensor, so viewer.py / pointcloud.py can read from the hub
(`--hub`) while other programs use the Kinect at the same time.
"""

import json
import struct
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

import numpy as np

WIDTH, HEIGHT = 512, 424
HEADER = struct.Struct("<IBBHIHHQQ")  # magic, kind, version, header_len, seq, width, height, capture_us, publish_us
MAGIC = 0x3148324B
KINDS = {1: ("depth", np.uint16, 1), 2: ("depth_raw", np.uint16, 1), 3: ("ir", np.uint8, 1),
         4: ("points", np.int16, 3), 16: ("lut", np.float32, 2)}


@dataclass
class Frame:
    name: str
    seq: int
    capture_time_us: int
    publish_time_us: int
    data: np.ndarray  # (424, 512) or (424, 512, channels)

    @property
    def age_ms(self):
        """Time since the sensor delivered the frame (hub and client on the same machine)."""
        return time.time() * 1000 - self.capture_time_us / 1000


def parse_binary(buf):
    """One binary hub message -> Frame (or None if it is not one)."""
    if len(buf) < HEADER.size:
        return None
    magic, kind, _version, header_len, seq, w, h, cap, pub = HEADER.unpack_from(buf, 0)
    if magic != MAGIC or kind not in KINDS:
        return None
    name, dtype, channels = KINDS[kind]
    data = np.frombuffer(buf, dtype=dtype, offset=header_len, count=w * h * channels)
    data = data.reshape((h, w, channels) if channels > 1 else (h, w))
    return Frame(name, seq, cap, pub, data)


class Hub:
    def __init__(self, url="http://127.0.0.1:8090", timeout=5.0):
        self.url = url.rstrip("/")
        self.timeout = timeout

    def _get(self, path):
        with urllib.request.urlopen(self.url + path, timeout=self.timeout) as r:
            return r.read(), r.headers

    def status(self):
        return json.loads(self._get("/api/status")[0])

    def params(self):
        """Depth camera intrinsics + distortion, or None while unknown."""
        try:
            return json.loads(self._get("/api/params")[0])
        except urllib.error.HTTPError:
            return None

    def lut(self):
        """Undistorted ray per pixel, float32 (424, 512, 2): point = (x*z, y*z, z)."""
        body, _ = self._get("/api/lut")
        return np.frombuffer(body, np.float32).reshape(HEIGHT, WIDTH, 2)

    def _frame(self, stream, dtype, channels=1):
        body, headers = self._get(f"/api/frame/{stream}")
        data = np.frombuffer(body, dtype)
        shape = (HEIGHT, WIDTH, channels) if channels > 1 else (HEIGHT, WIDTH)
        return data.reshape(shape), int(headers.get("x-seq", -1))

    def depth(self, raw=False):
        """Newest depth frame, uint16 mm (temporally smoothed unless raw=True)."""
        return self._frame("depth_raw" if raw else "depth", np.uint16)[0]

    def ir(self):
        return self._frame("ir", np.uint8)[0]

    def points(self):
        return self._frame("points", np.int16, 3)[0]

    def stream(self, streams=("depth",), max_fps=None):
        """Yields live Frames (and nothing for text messages). Reconnects on its own."""
        try:
            from websockets.sync.client import connect
        except ImportError as e:
            raise RuntimeError("live streaming needs `pip install websockets` (HTTP works without)") from e
        ws_url = "ws" + self.url[len("http"):] + "/ws"
        while True:
            try:
                with connect(ws_url, max_size=None) as ws:
                    sub = {"type": "subscribe", "streams": list(streams)}
                    if max_fps:
                        sub["max_fps"] = max_fps
                    ws.send(json.dumps(sub))
                    for msg in ws:
                        if isinstance(msg, bytes):
                            frame = parse_binary(msg)
                            if frame is not None:
                                yield frame
            except (OSError, EOFError) as e:
                print(f"kinect-hub: connection lost ({e}), reconnecting ...")
                time.sleep(1.0)
            except Exception as e:  # websockets.ConnectionClosed and friends
                if type(e).__name__.startswith("ConnectionClosed"):
                    time.sleep(0.5)
                    continue
                raise


class HubDepthSensor:
    """Drop-in for fn2.Fn2DepthSensor that reads from kinect-hub over HTTP (stdlib only)."""

    width, height = WIDTH, HEIGHT
    min_reliable_mm, max_reliable_mm = 500, 4500

    def __init__(self, url="http://127.0.0.1:8090"):
        self.hub = Hub(url, timeout=2.0)
        self._seq = None
        self._next_poll = 0.0
        self._state = 0
        self._state_at = 0.0
        self._params = None
        try:
            self.hub.status()
        except OSError as e:
            raise RuntimeError(f"kinect-hub not reachable at {url} ({e}); start kinect-hub first") from e

    @property
    def state(self):
        """0 = keine Kinect, 1 = Sensor startet, 2 = Bilder kommen (cached for 0.5 s)"""
        if time.monotonic() - self._state_at > 0.5:
            self._state_at = time.monotonic()
            try:
                s = self.hub.status()["sensor"]["state"]
                self._state = {"streaming": 2, "starting": 1}.get(s, 0)
            except OSError:
                self._state = 0
        return self._state

    @property
    def is_available(self):
        return self.state != 0

    def _poll(self, stream, dtype):
        now = time.monotonic()
        if now < self._next_poll:
            return None
        self._next_poll = now + 0.008  # do not hammer the hub; frames come every 33 ms
        try:
            data, seq = self.hub._frame(stream, dtype)
        except (OSError, ValueError):
            return None
        if seq == self._seq:
            return None
        self._seq = seq
        return data

    def latest(self):
        """Newest depth frame as uint16 mm, or None if nothing new."""
        d = self._poll("depth", np.uint16)
        return None if d is None else d.copy()

    def latest_mm(self):
        """Newest depth frame as float32 mm, or None if nothing new."""
        d = self._poll("depth", np.uint16)
        return None if d is None else d.astype(np.float32)

    def ir_params(self):
        if self._params is None:
            try:
                p = self.hub.params()
            except OSError:
                p = None
            if p:
                self._params = (p["fx"], p["fy"], p["cx"], p["cy"])
        return self._params

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
