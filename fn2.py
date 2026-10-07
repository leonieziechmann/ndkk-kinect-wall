"""Depth stream via libfreenect2 (fn2/bin/fn2capi.dll), with automatic reconnect.

Needs the libusbK driver on "Xbox NUI Sensor (Interface 0)" (Zadig); build with `sh fn2/build.sh`.
"""

import ctypes
import os
from pathlib import Path

import numpy as np

_BIN = Path(__file__).with_name("fn2") / "bin"


class Fn2Error(RuntimeError):
    pass


class Fn2DepthSensor:
    width, height = 512, 424
    min_reliable_mm, max_reliable_mm = 500, 4500

    def __init__(self, pipeline="cl"):
        if not (_BIN / "fn2capi.dll").exists():
            raise Fn2Error(f"{_BIN / 'fn2capi.dll'} fehlt - erst 'sh fn2/build.sh' ausfuehren")
        self._dll_dir = os.add_dll_directory(str(_BIN))
        self._lib = ctypes.CDLL(str(_BIN / "fn2capi.dll"))
        self._lib.fn2_start.argtypes = [ctypes.c_char_p]
        self._lib.fn2_get_depth.argtypes = [ctypes.POINTER(ctypes.c_float), ctypes.c_long]
        self._lib.fn2_get_depth.restype = ctypes.c_long
        self._lib.fn2_ir_params.argtypes = [ctypes.POINTER(ctypes.c_float)]
        self._buf = np.zeros((self.height, self.width), np.float32)
        self._seq = 0
        if self._lib.fn2_start(pipeline.encode()) != 0:
            raise Fn2Error("libfreenect2 konnte nicht starten")

    @property
    def state(self):
        """0 = keine Kinect, 1 = Sensor startet, 2 = Bilder kommen"""
        return self._lib.fn2_state()

    @property
    def is_available(self):
        return self.state != 0

    def latest(self):
        """Newest depth frame as uint16 mm (0 = no measurement), or None if nothing new."""
        if not self._poll():
            return None
        return np.clip(self._buf, 0, 65535).astype(np.uint16)

    def latest_mm(self):
        """Newest depth frame as float32 mm (0 = no measurement, a fresh copy), or None if nothing new."""
        if not self._poll():
            return None
        return self._buf.copy()

    def ir_params(self):
        """(fx, fy, cx, cy) of the depth camera as stored in the Kinect, or None before the first start."""
        out = (ctypes.c_float * 4)()
        return tuple(out) if self._lib.fn2_ir_params(out) == 0 else None

    def _poll(self):
        seq = self._lib.fn2_get_depth(self._buf.ctypes.data_as(ctypes.POINTER(ctypes.c_float)), self._seq)
        if seq < 0:
            return False
        self._seq = seq
        return True

    def close(self):
        self._lib.fn2_stop()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
