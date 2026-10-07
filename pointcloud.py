"""Kinect v2 point cloud demo: white dots on dark gray, seen from a slowly orbiting virtual camera.

    python pointcloud.py                     live window (libfreenect2, needs the libusbK driver)
    python pointcloud.py --still bild.png    render one image and exit
    python pointcloud.py --hub               read depth from a running kinect-hub instead

Mouse: drag = orbit, wheel = zoom
Keys:  space = auto orbit on/off   r = reset view   + / - = dot size   d = point density
       g = glow on/off   t = temporal smoothing on/off   m = mirror   h = help text
       s = snapshot to ./snapshots   f = fullscreen   q / Esc = quit
"""

import argparse
import ctypes
import math
import time
from ctypes import wintypes
from pathlib import Path

import cv2
import numpy as np

from fn2 import Fn2DepthSensor

WIN = "Kinect v2 - Punktwolke"
DEFAULT_IR = (365.5, 365.5, 256.0, 206.0)  # used until the Kinect reports its own calibration
HFOV_DEG = 70.0  # virtual camera; about the depth camera's own field of view
MAX_FPS = 30  # the Kinect delivers 30 depth frames/s; rendering faster only burns CPU
LIGHT = np.array([-0.35, -0.55, 0.76], np.float32)  # sphere shading: from the upper left, towards the viewer
BG_CENTER, BG_EDGE = 0.175, 0.115  # background gray with a soft vignette
HELP = ["Maus ziehen = drehen   Rad = Zoom   Leertaste = Auto-Orbit   r = Reset",
        "+/- = Punktgroesse   d = Dichte   g = Glow   t = Glaettung   m = Spiegeln",
        "s = Snapshot   f = Vollbild   h = Hilfe   q = Ende"]

_f32 = np.ctypeslib.ndpointer(np.float32, flags="C_CONTIGUOUS")
_u8 = np.ctypeslib.ndpointer(np.uint8, flags="C_CONTIGUOUS")
_dll = ctypes.CDLL(str(Path(__file__).with_name("fn2") / "bin" / "cloudsplat.dll"))
_dll.splat_spheres.argtypes = [_f32, _f32, _f32, _f32, ctypes.c_int, _f32, ctypes.c_int, ctypes.c_int, _f32,
                               ctypes.c_float]
_dll.splat_spheres.restype = None
_dll.compose.argtypes = [_f32, _f32, ctypes.c_int, ctypes.c_int, ctypes.c_float, ctypes.c_float, ctypes.c_float,
                         ctypes.c_float, _u8]
_dll.compose.restype = None


class Cloud:
    """Depth image -> 3D points in meters (sensor at the origin, x right, y up, z forward)."""

    def __init__(self):
        self.step = 2  # use every n-th sensor pixel; larger = fewer, bigger dots
        self.mirror = True  # Kinect images come mirrored
        self.smooth = True
        self.ir = DEFAULT_IR
        self._rays_key = self._rays = self._prev = None

    def _rays_for(self, shape):
        key = (self.step, self.mirror, self.ir, shape)
        if key != self._rays_key:
            fx, fy, cx, cy = self.ir
            rows, cols = np.mgrid[0:shape[0]:self.step, 0:shape[1]:self.step].astype(np.float32)
            rx = (cols + 0.5 - cx) / fx * (-1 if self.mirror else 1)
            ry = -(rows + 0.5 - cy) / fy
            self._rays_key, self._rays = key, (rx.ravel(), ry.ravel())
        return self._rays

    def points(self, depth_mm):
        d = depth_mm
        if self.smooth and self._prev is not None:
            # calm the per-frame noise on static surfaces, but follow real motion immediately
            close = (np.abs(d - self._prev) < 40) & (self._prev > 0) & (d > 0)
            d = np.where(close, 0.6 * self._prev + 0.4 * d, d).astype(np.float32)
        self._prev = d
        z = d[::self.step, ::self.step].ravel() / 1000.0
        rx, ry = self._rays_for(d.shape)
        ok = (z > 0.1) & (z < 8.0)
        z = z[ok]
        return rx[ok] * z, ry[ok] * z, z


class View:
    """Orbit camera around a pivot in front of the sensor; at yaw = pitch = 0 it sits on the sensor."""

    ZOOM = 1.6  # camera distance / pivot distance; > 1 = behind the sensor, the scene floats in the dark

    def __init__(self):
        self.drag = None
        self.reset()

    def reset(self):
        self.yaw, self.pitch, self.zoom = 0.0, 14.0, self.ZOOM
        self.auto, self.t0 = True, time.perf_counter()

    def angles(self, now):
        if self.auto:
            return self.yaw + 32.0 * math.sin(2 * math.pi * (now - self.t0) / 28.0), self.pitch
        return self.yaw, self.pitch

    def freeze(self, now):
        """Stop the auto orbit where it currently is."""
        if self.auto:
            self.yaw, self.pitch = self.angles(now)
            self.auto = False

    def camera(self, pivot_z, now):
        yaw, pitch = (math.radians(a) for a in self.angles(now))
        target = np.array([0.0, 0.0, pivot_z])
        back = np.array([math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)])
        pos = target + pivot_z * self.zoom * back
        fwd = -back
        right = np.cross([0.0, 1.0, 0.0], fwd)
        right /= np.linalg.norm(right)
        up = np.cross(fwd, right)
        return pos, np.stack([right, up, fwd])


class Renderer:
    def __init__(self):
        self.dot_fill = 0.42  # dot radius as a fraction of the spacing between neighbouring sensor pixels
        self.glow = True
        self.gain = 1.5

    def render(self, pts, cam_pos, cam_rot, w, h, step, fx_ir):
        X, Y, Z = pts
        f = (w / 2) / math.tan(math.radians(HFOV_DEG / 2))
        cx, cy, cz = (float(c) for c in cam_pos)  # Python floats keep the math in float32
        px, py, pz = X - cx, Y - cy, Z - cz
        (r00, r01, r02), (r10, r11, r12), (r20, r21, r22) = cam_rot.tolist()
        zc = r20 * px + r21 * py + r22 * pz
        ok = zc > 0.2
        inv = f / zc[ok]
        u = w / 2 + (r00 * px[ok] + r01 * py[ok] + r02 * pz[ok]) * inv
        v = h / 2 - (r10 * px[ok] + r11 * py[ok] + r12 * pz[ok]) * inv
        r = self.dot_fill * step * Z[ok] / fx_ir * inv  # a sensor pixel's footprint, seen from the camera
        a = np.clip(1.2 - 0.2 * Z[ok], 0.3, 1.0)  # depth fog: the background fades, close subjects stand out
        on = (u > -30) & (u < w + 30) & (v > -30) & (v < h + 30) & (r < 30)
        u, v, r, a = (np.ascontiguousarray(x[on], np.float32) for x in (u, v, r, a))

        acc = np.zeros((h, w), np.float32)
        _dll.splat_spheres(u, v, r, a, len(u), acc, w, h, LIGHT, 0.28)
        if self.glow:
            small = cv2.resize(acc, (max(1, w // 4), max(1, h // 4)), interpolation=cv2.INTER_AREA)
            glow = cv2.resize(cv2.GaussianBlur(small, (0, 0), 3.0), (w, h), interpolation=cv2.INTER_LINEAR)
            glow_gain = 0.35
        else:
            glow, glow_gain = acc, 0.0
        out = np.empty((h, w), np.uint8)
        _dll.compose(acc, np.ascontiguousarray(glow, np.float32), w, h, self.gain, glow_gain, BG_CENTER, BG_EDGE, out)
        return out


def put_label(img, text, org, scale=0.55, alpha=1.0):
    """Light text on a darkened box (gray image)."""
    thick = max(1, round(1.6 * scale))
    (tw, th), base = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
    x, y = org
    pad = 6
    box = img[max(0, y - th - pad):y + base + pad, max(0, x - pad):x + tw + pad]
    box[:] = (box * (1 - 0.6 * alpha)).astype(np.uint8)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, int(40 + 190 * alpha), thick, cv2.LINE_AA)


def empty_frame(w, h, text):
    img = np.empty((h, w), np.uint8)
    _dll.compose(np.zeros((h, w), np.float32), np.zeros((h, w), np.float32), w, h, 1.0, 0.0, BG_CENTER, BG_EDGE, img)
    put_label(img, text, (30, h // 2), 0.8)
    return img


def work_area():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # 1:1 pixels on scaled displays
    except (AttributeError, OSError):
        pass
    rect = wintypes.RECT()
    ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0)  # SPI_GETWORKAREA
    return rect.right - rect.left, rect.bottom - rect.top


def on_mouse(event, x, y, flags, view):
    now = time.perf_counter()
    if event == cv2.EVENT_LBUTTONDOWN:
        view.freeze(now)
        view.drag = (x, y)
    elif event == cv2.EVENT_MOUSEMOVE and view.drag and flags & cv2.EVENT_FLAG_LBUTTON:
        view.yaw -= (x - view.drag[0]) * 0.3
        view.pitch = min(75.0, max(-20.0, view.pitch + (y - view.drag[1]) * 0.3))
        view.drag = (x, y)
    elif event == cv2.EVENT_LBUTTONUP:
        view.drag = None
    elif event == cv2.EVENT_MOUSEWHEEL:
        view.zoom = min(4.0, max(0.25, view.zoom * (0.9 if cv2.getMouseWheelDelta(flags) > 0 else 1 / 0.9)))


def save_snapshot(img):
    folder = Path(__file__).with_name("snapshots")
    folder.mkdir(exist_ok=True)
    path = folder / f"{time.strftime('%Y%m%d_%H%M%S')}_cloud.png"
    cv2.imwrite(str(path), img)
    print(f"Snapshot gespeichert: {path}")


class Pivot:
    """Distance the camera orbits around: the median depth of the scene, smoothed."""

    def __init__(self):
        self.z = None

    def update(self, z):
        if len(z) < 100:
            return
        m = float(np.median(z[::7]))
        self.z = m if self.z is None else 0.92 * self.z + 0.08 * m


def run_still(args, sensor, cloud, view, renderer, pivot):
    w, h = args.size
    t0, frames, pts = time.perf_counter(), 0, None
    while frames < 30:  # let smoothing and pivot settle
        if time.perf_counter() - t0 > 20:
            print("Keine Tiefenbilder von der Kinect.")
            return 1
        depth = sensor.latest_mm()
        if depth is None:
            time.sleep(0.005)
            continue
        cloud.ir = sensor.ir_params() or cloud.ir
        pts = cloud.points(depth)
        pivot.update(pts[2])
        frames += 1
    view.auto, view.yaw, view.pitch, view.zoom = False, args.yaw, args.pitch, args.zoom
    pos, rot = view.camera(pivot.z, time.perf_counter())
    t = time.perf_counter()
    img = renderer.render(pts, pos, rot, w, h, cloud.step, cloud.ir[0])
    print(f"{len(pts[2])} Punkte, gerendert in {1000 * (time.perf_counter() - t):.0f} ms, Pivot {pivot.z:.2f} m")
    cv2.imwrite(args.still, img)
    print(f"gespeichert: {args.still}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Kinect v2 Punktwolken-Demo")
    parser.add_argument("--still", metavar="PNG", help="ein Einzelbild rendern, speichern und beenden")
    parser.add_argument("--size", default="1600x900", help="Bildgroesse fuer --still (Standard 1600x900)")
    parser.add_argument("--yaw", type=float, default=28.0, help="Blickwinkel seitlich fuer --still (Grad)")
    parser.add_argument("--pitch", type=float, default=14.0, help="Blickwinkel von oben fuer --still (Grad)")
    parser.add_argument("--zoom", type=float, default=View.ZOOM, help="Kameraabstand relativ zur Szene (Standard %(default)s)")
    parser.add_argument("--step", type=int, default=2, choices=[1, 2, 3], help="jedes n-te Sensorpixel (Standard 2)")
    parser.add_argument("--pipeline", default="cl", choices=["cl", "cpu", "clkde"], help="libfreenect2-Tiefenberechnung")
    parser.add_argument("--hub", nargs="?", const="http://127.0.0.1:8090", metavar="URL",
                        help="Tiefe von einem laufenden kinect-hub lesen (Standard http://127.0.0.1:8090)")
    args = parser.parse_args()
    args.size = tuple(int(s) for s in args.size.lower().split("x"))

    cloud, view, renderer, pivot = Cloud(), View(), Renderer(), Pivot()
    cloud.step = args.step
    try:
        if args.hub:
            from kinect_hub import HubDepthSensor
            sensor = HubDepthSensor(args.hub)
        else:
            sensor = Fn2DepthSensor(args.pipeline)
    except RuntimeError as e:
        print(e)
        return 1

    with sensor:
        if args.still:
            return run_still(args, sensor, cloud, view, renderer, pivot)

        aw, ah = work_area()
        ww = min(1600, aw - 80)
        cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(WIN, ww, ww * 9 // 16)
        cv2.moveWindow(WIN, (aw - ww) // 2, 20)
        cv2.setMouseCallback(WIN, on_mouse, view)
        print("\n".join(HELP))

        pts, t_frame, t_help = None, None, time.perf_counter()
        show_help, fps, n_fps, t_fps = True, 0.0, 0, time.perf_counter()
        while True:
            now = time.perf_counter()
            depth = sensor.latest_mm()
            if depth is not None:
                if t_frame is not None and now - t_frame > 0.5:
                    print(f"wieder Bilder nach {now - t_frame:.1f} s")
                cloud.ir = sensor.ir_params() or cloud.ir
                pts, t_frame = cloud.points(depth), now
                pivot.update(pts[2])

            _, _, w, h = cv2.getWindowImageRect(WIN)
            if w < 160 or h < 90:
                w, h = 1280, 720
            if pts is None:
                img = empty_frame(w, h, "warte auf Kinect ..." if sensor.state == 0 else "Sensor startet ...")
            else:
                pos, rot = view.camera(pivot.z, now)
                img = renderer.render(pts, pos, rot, w, h, cloud.step, cloud.ir[0])
                if now - t_frame > 0.5:
                    phase = "Sensor startet" if sensor.state == 1 else "Kinect-Reset"
                    put_label(img, f"{phase} ... {now - t_frame:4.1f} s", (24, 40), 0.7)

            n_fps += 1
            if now - t_fps >= 1.0:
                fps, n_fps, t_fps = n_fps / (now - t_fps), 0, now
            fade = min(1.0, max(0.0, 9.0 - (now - t_help)))  # help fades out after ~8 s
            if show_help and fade > 0:
                for i, line in enumerate(HELP + [f"{fps:4.1f} fps, {0 if pts is None else len(pts[2])} Punkte"]):
                    put_label(img, line, (24, h - 24 - 30 * (len(HELP) - i)), 0.55, fade)
            cv2.imshow(WIN, img)

            wait_ms = int((now + 1 / MAX_FPS - time.perf_counter()) * 1000)
            key = cv2.waitKey(max(1, wait_ms)) & 0xFF
            if key in (ord("q"), 27):
                break
            elif key == ord(" "):
                if view.auto:
                    view.freeze(now)
                else:
                    view.auto, view.t0 = True, now
            elif key == ord("r"):
                view.reset()
            elif key in (ord("+"), ord("=")):
                renderer.dot_fill = min(1.2, renderer.dot_fill * 1.15)
            elif key in (ord("-"), ord("_")):
                renderer.dot_fill = max(0.1, renderer.dot_fill / 1.15)
            elif key == ord("d"):
                cloud.step = cloud.step % 3 + 1
                print(f"jedes {cloud.step}. Sensorpixel")
            elif key == ord("g"):
                renderer.glow = not renderer.glow
            elif key == ord("t"):
                cloud.smooth = not cloud.smooth
            elif key == ord("m"):
                cloud.mirror = not cloud.mirror
            elif key == ord("h"):
                show_help, t_help = (True, now) if not show_help or fade == 0 else (False, t_help)
            elif key == ord("s"):
                save_snapshot(img)
            elif key == ord("f"):
                full = cv2.getWindowProperty(WIN, cv2.WND_PROP_FULLSCREEN) == cv2.WINDOW_FULLSCREEN
                cv2.setWindowProperty(WIN, cv2.WND_PROP_FULLSCREEN,
                                      cv2.WINDOW_NORMAL if full else cv2.WINDOW_FULLSCREEN)
            if cv2.getWindowProperty(WIN, cv2.WND_PROP_VISIBLE) < 1:
                break

        cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
