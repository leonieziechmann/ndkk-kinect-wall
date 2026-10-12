"""Leser für .k2rec, das Aufnahmeformat von kinect-hub (kinect-hub/src/recording.rs).

Little-endian:
  Dateikopf 32 Byte: "K2RC" | u32 version (1) | u32 header_len | u16 width | u16 height | u32 info_len
                     | u32 lut_len | u64 reserviert
  info_len Byte JSON ({"params": {...}, "recorded_at_us", ...}), lut_len Byte LUT (f32 x, y je Pixel)
  Frames bis zum Dateiende: "K2RF" | u32 seq | u64 capture_time_us | u16 flags (1 = IR folgt) | u16 res.
                     | u32 payload_len | u16 Tiefe[w*h] mm | u8 ir[w*h]

Es gibt keine Frame-Anzahl im Kopf: Eine abgebrochene Aufnahme (auch eine .k2rec.part) ist bis zum letzten
ganzen Frame lesbar; was danach kommt, steht in `damaged_tail`. Das Bild ist gespiegelt wie im Hub.
"""

import json
import struct
from pathlib import Path

import numpy as np

FILE_MAGIC = b"K2RC"
FRAME_MAGIC = b"K2RF"
FILE_HEADER = 32
FRAME_HEADER = 24
MAX_INFO = 1 << 20


class K2RecError(ValueError):
    pass


class K2Rec:
    """Eine geöffnete Aufnahme: Kopf, info, LUT (H, W, 2) float32 und der Index der ganzen Frames.
    Pixel werden erst beim Zugriff gelesen (wenig Speicher, auch bei langen Aufnahmen)."""

    def __init__(self, path):
        self.path = Path(path)
        self._f = open(self.path, "rb")
        try:
            self._index()
        except Exception:
            self._f.close()
            raise

    def _index(self):
        f = self._f
        size = self.path.stat().st_size
        h = f.read(FILE_HEADER)
        if len(h) < FILE_HEADER or h[:4] != FILE_MAGIC:
            raise K2RecError("keine .k2rec-Datei (Kopf fehlt oder falsche Kennung)")
        (self.version, self.header_len, self.width, self.height, info_len, lut_len,
         self.reserved) = struct.unpack_from("<IIHHIIQ", h, 4)
        if self.version != 1:
            raise K2RecError(f"Formatversion {self.version}, dieser Leser kennt 1")
        px = self.width * self.height
        if px == 0 or lut_len != px * 8 or info_len > MAX_INFO:
            raise K2RecError(f"Kopf kaputt (Bild {self.width} x {self.height}, info {info_len} B, LUT {lut_len} B)")
        if self.header_len < FILE_HEADER + info_len + lut_len or self.header_len > size:
            raise K2RecError(f"Kopf abgeschnitten oder kaputt ({size} B in der Datei, Kopf sagt {self.header_len})")
        try:
            self.info = json.loads(f.read(info_len).decode("utf-8"))
        except ValueError as e:
            raise K2RecError(f"info-JSON kaputt: {e}") from e
        lut = np.frombuffer(f.read(lut_len), "<f4")
        if lut.size != px * 2 or not np.all(np.isfinite(lut)) or np.any(np.abs(lut) >= 10):
            raise K2RecError("LUT kaputt (Werte außerhalb des Bereichs)")
        self.lut = lut.astype(np.float32).reshape(self.height, self.width, 2)
        self.params = dict(self.info.get("params") or {})
        seqs, times, has_ir, offs = [], [], [], []
        self.damaged_tail = None
        pos = self.header_len
        while pos < size:
            if size - pos < FRAME_HEADER:
                self.damaged_tail = f"letzte {size - pos} B ignoriert: Frame-Kopf abgeschnitten"
                break
            f.seek(pos)
            fh = f.read(FRAME_HEADER)
            if fh[:4] != FRAME_MAGIC:
                self.damaged_tail = f"letzte {size - pos} B ignoriert: keine Frame-Marke"
                break
            seq, t_us, flags, _res, payload = struct.unpack_from("<IQHHI", fh, 4)
            if flags & ~1:
                self.damaged_tail = f"letzte {size - pos} B ignoriert: unbekannte Flags {flags:#x}"
                break
            ir = bool(flags & 1)
            if payload != px * (3 if ir else 2):
                self.damaged_tail = f"letzte {size - pos} B ignoriert: Frame mit {payload} B"
                break
            if size - pos - FRAME_HEADER < payload:
                self.damaged_tail = f"letzte {size - pos} B ignoriert: Frame abgeschnitten"
                break
            seqs.append(seq)
            times.append(t_us)
            has_ir.append(ir)
            offs.append(pos + FRAME_HEADER)
            pos += FRAME_HEADER + payload
        if not seqs:
            raise K2RecError("keine ganzen Frames" + (f" ({self.damaged_tail})" if self.damaged_tail else ""))
        self.seq = np.array(seqs, np.int64)
        self.capture_us = np.array(times, np.int64)
        self.has_ir = np.array(has_ir, bool)
        self._off = offs

    # ------------------------------------------------------------------ Zugriff

    def __len__(self):
        return len(self._off)

    def close(self):
        self._f.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    @property
    def times(self):
        """Sekunden jedes Frames seit dem ersten Frame (aus capture_time_us)."""
        return (self.capture_us - self.capture_us[0]) / 1e6

    @property
    def skipped(self):
        """Frames, die der Hub erzeugt hat, die aber in der Aufnahme fehlen (Lücken in seq)."""
        d = np.diff(self.seq)
        return int(np.sum(np.clip(d[(d > 0) & (d < 1000)] - 1, 0, None)))

    @property
    def recorded_at_us(self):
        v = self.info.get("recorded_at_us")
        return int(v) if isinstance(v, (int, float)) else int(self.capture_us[0])

    def frame(self, i):
        """(Tiefe uint16 (H, W) in mm, IR uint8 (H, W) oder None), gespiegelt wie im Hub."""
        px = self.width * self.height
        ir = bool(self.has_ir[i])
        self._f.seek(self._off[i])
        buf = self._f.read(px * (3 if ir else 2))
        if len(buf) < px * (3 if ir else 2):
            raise K2RecError(f"Frame {i} lässt sich nicht lesen (Datei verändert?)")
        depth = np.frombuffer(buf, "<u2", count=px).reshape(self.height, self.width)
        irimg = np.frombuffer(buf, "u1", count=px, offset=px * 2).reshape(self.height, self.width) if ir else None
        return depth, irimg

    def depth(self, i):
        return self.frame(i)[0]

    def ir(self, i):
        return self.frame(i)[1]

    def summary(self):
        n = len(self)
        dur = (self.capture_us[-1] - self.capture_us[0]) / 1e6
        return {"frames": n, "seconds": round(float(dur), 3), "fps": round((n - 1) / dur, 2) if dur > 0 else None,
                "skipped": self.skipped, "frames_without_ir": int(np.sum(~self.has_ir)),
                "damaged_tail": self.damaged_tail}


def write_k2rec(path, params, lut, frames, info_extra=None):
    """Schreibt eine .k2rec wie kinect-hub-probe record (für Tests): frames = [(seq, t_us, depth, ir|None)]."""
    lut = np.asarray(lut, "<f4")
    h, w = lut.shape[:2]
    info = {"params": params, "recorded_at_us": int(frames[0][1]) if frames else 0}
    info.update(info_extra or {})
    ib = json.dumps(info).encode("utf-8")
    lb = lut.tobytes()
    with open(path, "wb") as f:
        f.write(FILE_MAGIC + struct.pack("<IIHHIIQ", 1, FILE_HEADER + len(ib) + len(lb), w, h, len(ib), len(lb), 0))
        f.write(ib)
        f.write(lb)
        for seq, t_us, depth, ir in frames:
            d = np.asarray(depth, "<u2").tobytes()
            r = np.asarray(ir, "u1").tobytes() if ir is not None else b""
            f.write(FRAME_MAGIC + struct.pack("<IQHHI", seq, t_us, 1 if ir is not None else 0, 0, len(d) + len(r)))
            f.write(d)
            f.write(r)
