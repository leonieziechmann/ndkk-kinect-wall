"""Kontrollvideo: Infrarotbild (2x) mit Skelett, Händen und Kabel, daneben zwei Ansichten der 3D-Gelenke in der WELT.
Bleibt bei der Aufnahme in recordings/ (zeigt dich), nie ins Repository.

Farben: Linien grün = aus der Tiefe (D), orange = über die Knochenlänge (B), gelb = interpoliert (I);
kleine weiße Punkte = 2D-Keypoints des Modells; violett = Kabel. Links blau, rechts orange (Gelenkpunkte).
Video: ffmpeg (im PATH oder aus `pip install imageio-ffmpeg`), sonst OpenCV; ohne beides ein Kontaktbogen (PNG).
"""

import shutil
import struct
import subprocess
import zlib
from pathlib import Path

import numpy as np

from . import gelenke as G
from . import kamera as K

HOW_COLOR = {"D": (70, 220, 90), "B": (255, 150, 30), "I": (235, 215, 50), "T": (255, 255, 255)}
LEFT, RIGHT, MID = (90, 160, 255), (255, 140, 60), (240, 240, 240)
CABLE = (230, 70, 230)


def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


class VideoWriter:
    def __init__(self, path, w, h, fps=30):
        self.path = Path(path)
        self.w, self.h = w, h
        self.kind = None
        self.frames = []
        exe = ffmpeg_exe()
        if exe:
            self.proc = subprocess.Popen([exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
                                          "-r", str(fps), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23",
                                          "-preset", "veryfast", "-movflags", "+faststart", str(self.path)],
                                         stdin=subprocess.PIPE)
            self.kind = "ffmpeg"
            return
        try:
            import cv2
            self.cv2 = cv2
            self.vw = cv2.VideoWriter(str(self.path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
            if self.vw.isOpened():
                self.kind = "cv2"
                return
        except Exception:
            pass
        self.path = self.path.with_suffix(".png")
        self.kind = "png"

    def add(self, rgb):
        if self.kind == "ffmpeg":
            self.proc.stdin.write(np.ascontiguousarray(rgb, np.uint8).tobytes())
        elif self.kind == "cv2":
            self.vw.write(rgb[..., ::-1].copy())
        else:
            self.frames.append(rgb)

    def close(self):
        if self.kind == "ffmpeg":
            self.proc.stdin.close()
            self.proc.wait()
        elif self.kind == "cv2":
            self.vw.release()
        else:
            # Kontaktbogen: höchstens 12 Bilder, halb so groß
            if not self.frames:
                return self.path
            step = max(1, len(self.frames) // 12)
            pick = [f[::2, ::2] for f in self.frames[::step][:12]]
            rows = [np.concatenate(pick[i:i + 3] + [np.zeros_like(pick[0])] * (3 - len(pick[i:i + 3])), 1)
                    for i in range(0, len(pick), 3)]
            write_png(self.path, np.concatenate(rows, 0))
        return self.path


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


# ---------------------------------------------------------------------------------------- Zeichnen

def line(img, a, b, color, width=1):
    h, w, _ = img.shape
    if not (np.all(np.isfinite(a)) and np.all(np.isfinite(b))):
        return
    n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1]))) + 1
    if n > 4000:
        return
    s = np.linspace(0, 1, n + 1)
    xs = np.round(a[0] + (b[0] - a[0]) * s).astype(int)
    ys = np.round(a[1] + (b[1] - a[1]) * s).astype(int)
    r = width // 2
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            x, y = xs + dx, ys + dy
            ok = (x >= 0) & (x < w) & (y >= 0) & (y < h)
            img[y[ok], x[ok]] = color


def dot(img, p, color, r=2):
    h, w, _ = img.shape
    if not np.all(np.isfinite(p)):
        return
    x, y = int(round(p[0])), int(round(p[1]))
    img[max(0, y - r):min(h, y + r + 1), max(0, x - r):min(w, x + r + 1)] = color


def side_color(name):
    return LEFT if name.startswith("left") else RIGHT if name.startswith("right") else MID


class Painter:
    def __init__(self, cam, world, scale=2):
        self.cam = cam
        self.world = world
        self.to_cam = K.invert(world)
        self.s = scale
        try:
            from PIL import Image, ImageDraw, ImageFont
            self.Image, self.ImageDraw = Image, ImageDraw
            try:
                self.font = ImageFont.load_default(size=18)
            except TypeError:
                self.font = ImageFont.load_default()
        except ImportError:
            self.Image = None

    def project(self, pw):
        pc = K.apply(self.to_cam, pw)
        u, v = self.cam.project(pc)
        bad = pc[..., 2] < 100
        u = np.where(bad, np.nan, u)
        return np.stack([u, v], -1) * self.s

    def frame(self, ir, kp2d, pos, how, conf, cable, texts, view_box):
        s = self.s
        g = np.zeros((ir.shape[0], ir.shape[1]), np.uint8) if ir is None else ir
        img = np.repeat(np.repeat(np.repeat(g[..., None], 3, 2), s, 0), s, 1).copy()
        uv = self.project(np.where(np.isfinite(pos), pos, 0.0))
        uv[~np.isfinite(pos[:, 0])] = np.nan
        for ln in cable or []:
            p = self.project(np.asarray(ln["pts"], float).reshape(-1, 3))
            for a, b in zip(p[:-1], p[1:]):
                line(img, a, b, CABLE, 2)
        for a, b in G.DRAW:
            ia, ib = G.IDX[a], G.IDX[b]
            if how[ia] == "-" or how[ib] == "-":
                continue
            worst = max(how[ia], how[ib], key=lambda c: "DTBI".index(c) if c in "DTBI" else 9)
            line(img, uv[ia], uv[ib], HOW_COLOR.get(worst, (200, 200, 200)), 1 if "_hand_" in b else 3)
        for j, n in enumerate(G.JOINTS):
            if how[j] == "-":
                continue
            dot(img, uv[j], side_color(n), 1 if "_hand_" in n else 3)
        if kp2d is not None:
            for j in range(G.J):
                if kp2d[j, 2] >= 0.3:
                    dot(img, kp2d[j, :2] * s, (255, 255, 255), 0)
        panel = self.views(pos, how, view_box, img.shape[0])
        out = np.concatenate([img, panel], 1)
        if self.Image is not None and texts:
            im = self.Image.fromarray(out)
            d = self.ImageDraw.Draw(im)
            y = 6
            for t, col in texts:
                d.text((10, y), t, fill=col, font=self.font, stroke_width=2, stroke_fill=(0, 0, 0))
                y += 24
            out = np.asarray(im)
        return out

    def views(self, pos, how, box, height):
        """Zwei Ansichten der WELT: von vorn (x, y; Blick wie die Kinect) und von der Seite (z, y)."""
        h = height // 2
        w = h
        panel = np.full((height, w, 3), 24, np.uint8)
        (x0, x1), (y0, y1), (z0, z1) = box
        span = max(x1 - x0, y1 - y0, z1 - z0, 1.0)
        sc = (h - 20) / span

        def to_px(a, b, a0, top):
            return np.stack([10 + (a - a0) * sc, top + h - 10 - (b - y0) * sc], -1)

        front = to_px(pos[:, 0], pos[:, 1], x0, 0)
        side = to_px(-pos[:, 2], pos[:, 1], -z1, h)
        for pts in (front, side):
            for a, b in G.DRAW:
                ia, ib = G.IDX[a], G.IDX[b]
                if how[ia] == "-" or how[ib] == "-":
                    continue
                worst = max(how[ia], how[ib], key=lambda c: "DTBI".index(c) if c in "DTBI" else 9)
                line(panel, pts[ia], pts[ib], HOW_COLOR.get(worst, (200, 200, 200)), 1 if "_hand_" in b else 2)
        # Boden
        line(panel, (0, h - 10), (w - 1, h - 10), (90, 90, 90))
        line(panel, (0, 2 * h - 10), (w - 1, 2 * h - 10), (90, 90, 90))
        line(panel, (0, h), (w - 1, h), (60, 60, 60))
        return panel
