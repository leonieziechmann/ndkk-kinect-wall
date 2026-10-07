"""Kinect v2 viewer.

    python viewer.py               color + depth side by side
    python viewer.py --depth-only  depth only, one large window
    python viewer.py --fn2         depth via libfreenect2 (libusbK driver, auto-reconnect)
    python viewer.py --hub         depth from a running kinect-hub (several programs at once)

Keys:  q / Esc = quit    m = mirror on/off    s = snapshot to ./snapshots
Hover over the depth window to read the distance under the cursor.
While the sensor resets, the last frame stays visible (dimmed) with a timer.
"""

import argparse
import ctypes
import time
from ctypes import wintypes
from pathlib import Path

import cv2
import numpy as np


COLOR_WIN = "Kinect v2 - Farbe"
DEPTH_WIN = "Kinect v2 - Tiefe"
NEAR_MM, FAR_MM = 500, 4500  # colormap range = reliable range of the sensor
STALE_AFTER_S = 0.5  # no new frame for this long = sensor is resetting

cursor = {"pos": None}


class Fps:
    def __init__(self):
        self.value, self._n, self._t0 = 0.0, 0, time.perf_counter()

    def tick(self):
        self._n += 1
        t = time.perf_counter()
        if t - self._t0 >= 1.0:
            self.value, self._n, self._t0 = self._n / (t - self._t0), 0, t


def colorize_depth(depth_mm):
    scaled = (np.clip(depth_mm, NEAR_MM, FAR_MM) - NEAR_MM) * (255.0 / (FAR_MM - NEAR_MM))
    img = cv2.applyColorMap((255 - scaled).astype(np.uint8), cv2.COLORMAP_TURBO)  # near = red, far = blue
    img[depth_mm == 0] = 0  # no measurement
    return img


def put_text(img, text, org, scale):
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), max(1, round(2 * scale)), cv2.LINE_AA)


def put_label(img, text, org, scale):
    """White text on a darkened box, readable on any background."""
    (w, h), baseline = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, max(1, round(2 * scale)))
    pad = max(3, round(6 * scale))
    x, y = org
    box = img[max(0, y - h - pad):y + baseline + pad, max(0, x - pad):x + w + pad]
    box[:] = box // 3
    put_text(img, text, org, scale)


def message_image(width, height, lines):
    img = np.full((height, width, 3), 40, np.uint8)
    s = width / 900
    for i, line in enumerate(lines):
        put_text(img, line, (int(30 * s), int((80 + 60 * i) * s)), 1.1 * s)
    return img


def dimmed(img, text):
    out = cv2.convertScaleAbs(img, alpha=0.4)
    s = img.shape[1] / 850
    put_label(out, text, (int(20 * s), img.shape[0] // 2), s)
    return out


def render_color(frame, mirror, fps):
    img = cv2.flip(frame, 1) if mirror else frame.copy()
    put_label(img, f"{img.shape[1]}x{img.shape[0]}  {fps:4.1f} fps", (30, 70), 1.5)
    return img


def render_depth(frame, mirror, fps):
    shown = cv2.flip(frame, 1) if mirror else frame
    img = colorize_depth(shown)
    if cursor["pos"]:
        x, y = cursor["pos"]
        if 0 <= x < img.shape[1] and 0 <= y < img.shape[0]:
            mm = int(shown[y, x])
            cv2.drawMarker(img, (x, y), (255, 255, 255), cv2.MARKER_CROSS, 14, 1)
            put_label(img, f"{mm} mm" if mm else "kein Messwert", (10, img.shape[0] - 14), 0.6)
    put_label(img, f"{img.shape[1]}x{img.shape[0]}  {fps:4.1f} fps", (10, 26), 0.6)
    return img


class Feed:
    """One window: shows each new frame; while none arrive, the last one dimmed with a timer."""

    def __init__(self, window, reader, render):
        self.window, self.reader, self.render = window, reader, render
        self.fps = Fps()
        self.raw = None  # newest sensor frame, for snapshots
        self.image = None  # newest rendered image
        self.t_frame = None
        self.t_drawn = 0.0

    def update(self, now, available, mirror):
        frame = self.reader.latest()
        if frame is not None:
            if self.t_frame is not None and now - self.t_frame > STALE_AFTER_S:
                print(f"{self.window}: wieder Bilder nach {now - self.t_frame:.1f} s")
            self.raw, self.t_frame = frame, now
            self.fps.tick()
            self.image = self.render(frame, mirror, self.fps.value)
            cv2.imshow(self.window, self.image)
        elif now - self.t_drawn > 0.25 and (self.t_frame is None or now - self.t_frame > STALE_AFTER_S):
            self.t_drawn = now
            if self.image is None:
                lines = (["Kinect verbunden,", "warte auf Bilder ..."] if available
                         else ["Keine Kinect gefunden.", "USB 3 + 12V-Netzteil pruefen."])
                cv2.imshow(self.window, message_image(self.reader.width, self.reader.height, lines))
            else:
                phase = "Sensor startet" if available else "Kinect-Reset (USB)"
                cv2.imshow(self.window, dimmed(self.image, f"{phase} ... {now - self.t_frame:4.1f} s"))


def on_mouse(event, x, y, flags, param):
    cursor["pos"] = (x, y)


def setup_windows(feeds):
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # 1:1 pixels on scaled displays
    except (AttributeError, OSError):
        pass
    work = wintypes.RECT()
    ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(work), 0)  # SPI_GETWORKAREA
    gap = 30
    ratios = [f.reader.width / f.reader.height for f in feeds]
    h = int(min(work.bottom - work.top - 120, (work.right - work.left - (len(feeds) + 1) * gap) / sum(ratios)))
    x = work.left + gap // 2
    for feed, ratio in zip(feeds, ratios):
        cv2.namedWindow(feed.window, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(feed.window, int(h * ratio), h)
        cv2.moveWindow(feed.window, x, work.top + 10)
        x += int(h * ratio) + gap
    cv2.setMouseCallback(DEPTH_WIN, on_mouse)


def save_snapshot(feeds):
    folder = Path(__file__).with_name("snapshots")
    folder.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    for feed in feeds:
        if feed.raw is None:
            continue
        if feed.window == DEPTH_WIN:
            cv2.imwrite(str(folder / f"{stamp}_depth_mm.png"), feed.raw)  # 16-bit PNG, values in mm
        else:
            cv2.imwrite(str(folder / f"{stamp}_color.png"), feed.raw)
    print(f"Snapshot gespeichert: {folder / stamp}_*.png")


def main():
    parser = argparse.ArgumentParser(description="Kinect v2 Live-Vorschau")
    parser.add_argument("--depth-only", action="store_true", help="nur das Tiefenbild anzeigen")
    parser.add_argument("--fn2", action="store_true",
                        help="Tiefe ueber libfreenect2 statt Kinect SDK (braucht libusbK-Treiber, nur Tiefe)")
    parser.add_argument("--hub", nargs="?", const="http://127.0.0.1:8090", metavar="URL",
                        help="Tiefe von einem laufenden kinect-hub lesen (Standard http://127.0.0.1:8090)")
    parser.add_argument("--pipeline", default="cl", choices=["cl", "cpu", "clkde"],
                        help="libfreenect2-Tiefenberechnung (nur mit --fn2, Standard: cl = OpenCL)")
    args = parser.parse_args()

    try:
        if args.hub:
            from kinect_hub import HubDepthSensor
            sensor = HubDepthSensor(args.hub)
        elif args.fn2:
            from fn2 import Fn2DepthSensor
            sensor = Fn2DepthSensor(args.pipeline)
        else:
            from kinect2 import KinectSensor
            sensor = KinectSensor()
    except RuntimeError as e:
        print(e)
        return 1

    with sensor:
        depth = sensor if args.fn2 or args.hub else sensor.open_depth_reader()
        feeds = [Feed(DEPTH_WIN, depth, render_depth)]
        if not (args.depth_only or args.fn2 or args.hub):
            feeds.insert(0, Feed(COLOR_WIN, sensor.open_color_reader(), render_color))
        print(f"Tiefe {depth.width}x{depth.height} (zuverlässig {depth.min_reliable_mm}-{depth.max_reliable_mm} mm)"
              + ("" if args.depth_only or args.fn2 or args.hub else f", Farbe {feeds[0].reader.width}x{feeds[0].reader.height}"))
        print("q/Esc = Ende, m = spiegeln, s = Snapshot")
        setup_windows(feeds)

        available, t_status, mirror = None, 0.0, False
        while True:
            now = time.perf_counter()
            if now - t_status > 0.25:
                t_status = now
                if sensor.is_available != available:
                    available = sensor.is_available
                    print("Kinect verbunden." if available else "Kinect nicht verfügbar - warte ...")
            for feed in feeds:
                feed.update(now, available, mirror)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("m"):
                mirror = not mirror
            if key == ord("s"):
                save_snapshot(feeds)
            if any(cv2.getWindowProperty(f.window, cv2.WND_PROP_VISIBLE) < 1 for f in feeds):
                break

        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
