"""Prüft synthetische (oder echte) Kinect-Aufnahmen: liest .k2rec unabhängig vom Hub und vom
Erzeuger (nur struct, zlib, numpy), prüft das Format wie kinect-hub (recording.rs, replay.rs),
rechnet die LUT aus den Kameraparametern nach und vergleicht, wenn es die Wahrheit
<name>.truth.json.gz daneben gibt, Tiefenwerte an bekannten Stellen: Boden, Wand, Körper
(Gelenke), Kabel. Schreibt dazu ein Vorschaubild <name>.preview.png (Tiefe | Infrarot, mit den
wahren Gelenken und dem Kabel eingezeichnet).

    python mocap/synthetic/pruefen.py output/synthetic              alle .k2rec im Ordner (auch *.k2rec geht)
    python mocap/synthetic/pruefen.py --no-preview datei.k2rec
    python mocap/synthetic/pruefen.py --frames 30,150,240 datei.k2rec     Vorschau dieser Frames

Ende mit Code 1, wenn eine Prüfung fehlschlägt. Echte Aufnahmen (ohne Wahrheit) werden nur auf das
Format geprüft; ihre Vorschau bleibt bei dir (recordings/ ist privat), nie ins Repository.
"""

import argparse
import gzip
import json
import math
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

W, H = 512, 424
FILE_MAGIC, FRAME_MAGIC = b"K2RC", b"K2RF"


# ---------------------------------------------------------------- reading

class K2Rec:
    """An opened .k2rec: header, info JSON, LUT (424, 512, 2) and the index of the whole frames."""

    def __init__(self, path):
        self.path = Path(path)
        self.f = open(self.path, "rb")
        size = self.path.stat().st_size
        h = self.f.read(32)
        if len(h) < 32 or h[:4] != FILE_MAGIC:
            raise ValueError("keine .k2rec-Datei (Kopf fehlt)")
        self.version, self.header_len, self.width, self.height, info_len, lut_len, reserved = struct.unpack_from("<IIHHIIQ", h, 4)
        if self.version != 1:
            raise ValueError(f"Formatversion {self.version}, erwartet 1")
        px = self.width * self.height
        if px == 0 or lut_len != px * 8 or info_len > (1 << 20):
            raise ValueError(f"Kopf kaputt (info {info_len} B, LUT {lut_len} B)")
        if self.header_len < 32 + info_len + lut_len or self.header_len > size:
            raise ValueError(f"Kopf abgeschnitten oder kaputt (header_len {self.header_len})")
        self.reserved = reserved
        self.info = json.loads(self.f.read(info_len).decode("utf-8"))
        self.lut = np.frombuffer(self.f.read(lut_len), "<f4").reshape(self.height, self.width, 2)
        self.frames = []  # (seq, capture_us, has_ir, offset of the pixels)
        self.damaged_tail = None
        pos = self.header_len
        while pos < size:
            if size - pos < 24:
                self.damaged_tail = "Frame-Kopf abgeschnitten"
                break
            self.f.seek(pos)
            fh = self.f.read(24)
            if fh[:4] != FRAME_MAGIC:
                self.damaged_tail = "keine Frame-Marke"
                break
            seq, t_us, flags, _res, payload = struct.unpack_from("<IQHHI", fh, 4)
            if flags & ~1:
                self.damaged_tail = f"unbekannte Flags {flags:#x}"
                break
            has_ir = bool(flags & 1)
            if payload != px * (3 if has_ir else 2):
                self.damaged_tail = f"Frame mit {payload} B"
                break
            if size - pos - 24 < payload:
                self.damaged_tail = "Frame abgeschnitten"
                break
            self.frames.append((seq, t_us, has_ir, pos + 24))
            pos += 24 + payload
        if not self.frames:
            raise ValueError("keine ganzen Frames")

    def frame(self, i):
        """depth uint16 (H, W) in mm and ir uint8 (H, W) or None, mirrored like the hub's image"""
        seq, t_us, has_ir, off = self.frames[i]
        px = self.width * self.height
        self.f.seek(off)
        buf = self.f.read(px * (3 if has_ir else 2))
        depth = np.frombuffer(buf, "<u2", count=px).reshape(self.height, self.width)
        ir = np.frombuffer(buf, "u1", count=px, offset=px * 2).reshape(self.height, self.width) if has_ir else None
        return depth, ir


# ---------------------------------------------------------------- the camera model

def lut_from_params(p):
    """The hub's LUT (kinect-hub/src/lut.rs) recomputed: undistorted ray per distorted pixel, f32."""
    f = np.float32
    u, v = np.meshgrid(np.arange(W, dtype=f), np.arange(H, dtype=f))
    xd = (u - f(p["cx"])) / f(p["fx"])
    yd = (v - f(p["cy"])) / f(p["fy"])
    x, y = xd.copy(), yd.copy()
    k1, k2, k3, p1, p2 = (f(p.get(n, 0.0)) for n in ("k1", "k2", "k3", "p1", "p2"))
    for _ in range(12):
        r2 = x * x + y * y
        kr = f(1) + ((k3 * r2 + k2) * r2 + k1) * r2
        dx = p2 * (r2 + f(2) * x * x) + f(2) * p1 * x * y
        dy = p1 * (r2 + f(2) * y * y) + f(2) * p2 * x * y
        x = (xd - dx) / kr
        y = (yd - dy) / kr
    bad = ~np.isfinite(x) | ~np.isfinite(y) | (np.abs(x - xd) > 0.5) | (np.abs(y - yd) > 0.5)
    x[bad], y[bad] = xd[bad], yd[bad]
    return np.stack([x, y], axis=-1)


def project(p, pc):
    """Hub pixel (u, v) of CAMERA points pc (..., 3), unmirrored camera frame -> mirrored image."""
    x = -pc[..., 0] / pc[..., 2]
    y = pc[..., 1] / pc[..., 2]
    r2 = x * x + y * y
    kr = 1 + ((p.get("k3", 0) * r2 + p.get("k2", 0)) * r2 + p.get("k1", 0)) * r2
    xd = x * kr + p.get("p2", 0) * (r2 + 2 * x * x) + 2 * p.get("p1", 0) * x * y
    yd = y * kr + p.get("p1", 0) * (r2 + 2 * y * y) + 2 * p.get("p2", 0) * x * y
    return p["cx"] + p["fx"] * xd, p["cy"] + p["fy"] * yd


def camera_points(depth, lut):
    """CAMERA points (H, W, 3) in mm of a depth image: the hub's point with x negated (unmirrored)."""
    z = depth.astype(np.float32)
    return np.stack([-lut[..., 0] * z, lut[..., 1] * z, z], axis=-1)


def fit_floor(depth, lut, rng):
    """The floor plane from one depth image without any prior: RANSAC on the lower third, a plane
    whose normal points roughly up in the image (-y), refined by least squares. normal . p + d = height."""
    pts = camera_points(depth, lut)[H * 2 // 3:].reshape(-1, 3)
    pts = pts[pts[:, 2] > 0]
    if len(pts) < 500:
        return None
    best, best_n = None, 0
    for _ in range(300):
        a, b, c = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n)
        if ln < 1e-6:
            continue
        n = n / ln
        if n[1] > 0:
            n = -n
        if -n[1] < 0.5:  # not floor-like (the floor's normal is up = -y in the camera)
            continue
        d = -n @ a
        inl = np.abs(pts @ n + d) < 15
        if inl.sum() > best_n:
            best, best_n = inl, inl.sum()
    if best is None:
        return None
    q = pts[best]
    c = q.mean(axis=0)
    _, _, vt = np.linalg.svd(q - c, full_matrices=False)
    n = vt[2] if vt[2][1] < 0 else -vt[2]
    d = -n @ c
    rms = float(np.sqrt(np.mean((q @ n + d) ** 2)))
    return n, float(d), rms, int(best_n)


def frame_times(truth):
    """seconds of every frame from the take's `t` (a list, or uniform {t0, dt})"""
    t = truth["t"]
    if isinstance(t, list):
        return np.array(t, float)
    return t["t0"] + t["dt"] * np.arange(truth["frames"])


def frame_at(truth, sec):
    """the frame nearest to a time (s from the first frame)"""
    return int(np.argmin(np.abs(frame_times(truth) - sec)))


def lut_at(lut, u, v, c):
    """the LUT bilinearly at a fractional pixel position (u, v), component c (0 = x, 1 = y)"""
    u0, v0 = int(math.floor(u)), int(math.floor(v))
    u0, v0 = min(max(u0, 0), W - 2), min(max(v0, 0), H - 2)
    a, b = u - u0, v - v0
    q = lut[v0:v0 + 2, u0:u0 + 2, c].astype(float)
    return (1 - b) * ((1 - a) * q[0, 0] + a * q[0, 1]) + b * ((1 - a) * q[1, 0] + a * q[1, 1])


def median_at(depth, u, v, r=1):
    """median of the valid depths in a (2r+1)^2 window around pixel (u, v); 0 if none"""
    iu, iv = int(round(u)), int(round(v))
    win = depth[max(0, iv - r):iv + r + 1, max(0, iu - r):iu + r + 1]
    win = win[win > 0]
    return float(np.median(win)) if win.size else 0.0


# ---------------------------------------------------------------- pictures

def turbo(t):
    t = np.clip(t, 0, 1)
    r = 0.13572138 + t * (4.61539260 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))))
    g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))))
    b = 0.10667330 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))))
    return (np.clip(np.stack([r, g, b], -1), 0, 1) * 255).astype(np.uint8)


def depth_rgb(depth, lo=500, hi=4500):
    img = turbo((depth.astype(np.float32) - lo) / (hi - lo))
    img[depth == 0] = 0
    return img


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def dot(img, u, v, color, r=2):
    h, w, _ = img.shape
    iu, iv = int(round(u)), int(round(v))
    img[max(0, iv - r):min(h, iv + r + 1), max(0, iu - r):min(w, iu + r + 1)] = color


def line(img, a, b, color):
    n = int(max(abs(b[0] - a[0]), abs(b[1] - a[1]))) + 1
    h, w, _ = img.shape
    for s in np.linspace(0, 1, n + 1):
        u, v = a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s
        iu, iv = int(round(u)), int(round(v))
        if 0 <= iu < w and 0 <= iv < h:
            img[iv, iu] = color


BONES = [("left_shoulder", "right_shoulder"), ("left_hip", "right_hip"), ("left_shoulder", "left_hip"), ("right_shoulder", "right_hip"),
         ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"), ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
         ("left_hip", "left_knee"), ("left_knee", "left_ankle"), ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
         ("left_ankle", "left_heel"), ("left_ankle", "left_big_toe"), ("right_ankle", "right_heel"), ("right_ankle", "right_big_toe"),
         ("neck", "head"), ("nose", "left_eye"), ("nose", "right_eye")]
for side in ("left", "right"):
    for finger in ("thumb", "index", "middle", "ring", "pinky"):
        chain = ["wrist"] + ([f"{finger}_cmc", f"{finger}_mcp", f"{finger}_ip", f"{finger}_tip"] if finger == "thumb" else [f"{finger}_{p}" for p in ("mcp", "pip", "dip", "tip")])
        BONES += [(f"{side}_hand_{a}", f"{side}_hand_{b}") for a, b in zip(chain, chain[1:])]


def overlay(img, truth, i, scale=1):
    """the truth's joints (left blue, right orange, middle white; hidden ones dim) and the cable"""
    names = truth["joints"]
    uv = truth["truth"]["uv_values"][i]
    vis = truth["truth"]["visible_codes"][i]
    idx = {n: j for j, n in enumerate(names)}
    p = truth["camera"]
    m = np.array(truth["world"]["cam_to_world"], float).reshape(4, 4)
    to_cam = np.linalg.inv(m)
    for line_pts in truth["cable"][i]:
        pts = np.array(line_pts["pts"], float).reshape(-1, 3)
        pc = (to_cam[:3, :3] @ pts.T).T + to_cam[:3, 3]
        u, v = project(p, pc)
        for k in range(len(u) - 1):
            line(img, (u[k] * scale, v[k] * scale), (u[k + 1] * scale, v[k + 1] * scale), (0, 255, 120))
    for a, b in BONES:
        ja, jb = idx[a], idx[b]
        if vis[ja] != "x" and vis[jb] != "x":
            line(img, (uv[2 * ja] * scale, uv[2 * ja + 1] * scale), (uv[2 * jb] * scale, uv[2 * jb + 1] * scale), (235, 235, 235))
    for j, n in enumerate(names):
        if vis[j] == "x":
            continue
        color = (60, 150, 255) if n.startswith("left") else (255, 150, 40) if n.startswith("right") else (255, 255, 255)
        if vis[j] == "o":
            color = tuple(c // 3 for c in color)
        dot(img, uv[2 * j] * scale, uv[2 * j + 1] * scale, color, 1 if "_hand_" in n else 2)


def preview(rec, truth, frames, out):
    rows = []
    for i in frames:
        depth, ir = rec.frame(i)
        d = depth_rgb(depth)
        g = np.repeat((ir if ir is not None else np.zeros_like(depth, np.uint8))[..., None], 3, axis=2).copy()
        gt = g.copy()
        if truth:
            overlay(gt, truth, i)
        rows.append(np.concatenate([d, g, gt], axis=1))
        rows.append(np.full((4, rows[-1].shape[1], 3), 40, np.uint8))
    write_png(out, np.concatenate(rows[:-1], axis=0))


# ---------------------------------------------------------------- the checks

class Report:
    def __init__(self):
        self.failed = []

    def check(self, ok, text):
        print(f"  {'ok ' if ok else 'FEHLER'} {text}")
        if not ok:
            self.failed.append(text)


def check_file(path, args):
    print(f"{path}")
    rep = Report()
    rec = K2Rec(path)
    p = rec.info.get("params", {})
    n = len(rec.frames)
    seqs = np.array([f[0] for f in rec.frames], np.int64)
    ts = np.array([f[1] for f in rec.frames], np.int64)
    dt = np.diff(ts) / 1000.0
    rep.check(rec.width == W and rec.height == H, f"Bildgröße {rec.width} x {rec.height}")
    rep.check(rec.reserved == 0, "reservierte Bytes 0")
    rep.check(rec.damaged_tail is None, f"{n} ganze Frames, kein kaputtes Ende ({rec.damaged_tail})")
    rep.check(all(f[2] for f in rec.frames), "jeder Frame hat Infrarot")
    ok_params = (p.get("width") == W and p.get("height") == H and 100 <= p.get("fx", 0) < 2000 and 100 <= p.get("fy", 0) < 2000
                 and 0 <= p.get("cx", -1) < W and 0 <= p.get("cy", -1) < H)
    rep.check(ok_params, f"Kameraparameter plausibel wie im Hub (fx {p.get('fx')}, cx {p.get('cx')}, cy {p.get('cy')}, k1 {p.get('k1')})")
    rep.check(bool(np.all(np.isfinite(rec.lut)) and np.all(np.abs(rec.lut) < 10)), "LUT endlich, |x|, |y| < 10")
    lut2 = lut_from_params(p)
    diff = float(np.max(np.abs(lut2 - rec.lut)))
    rep.check(diff < 2e-5, f"LUT = aus den Parametern nachgerechnet (max. Abweichung {diff:.2e})")
    skipped = int(np.sum(np.clip(np.diff(seqs) - 1, 0, None)))
    rep.check(bool(np.all(np.diff(seqs) >= 1)), f"Sequenznummern steigen ({skipped} Frames fehlen)")
    if n > 1:
        rep.check(bool(np.all(dt > 0)), f"Zeitstempel steigen: Abstand Median {np.median(dt):.2f} ms, max {dt.max():.2f} ms "
                  f"({n} Frames, {(ts[-1] - ts[0]) / 1e6:.2f} s)")

    truth_path = Path(str(path)[: -len(".k2rec")] + ".truth.json.gz")
    truth = json.loads(gzip.open(truth_path).read()) if truth_path.exists() else None
    rng = np.random.default_rng(1)

    # depth and infrared statistics of the first frame
    d0, ir0 = rec.frame(0)
    valid = d0 > 0
    print(f"  Frame 0: {valid.mean() * 100:.1f} % Pixel mit Tiefe, {d0[valid].min()}–{d0[valid].max()} mm; "
          f"Infrarot Median {np.median(ir0):.0f}, 99 % {np.percentile(ir0, 99):.0f}")

    floor = fit_floor(d0, rec.lut, rng)
    if floor:
        fn, fd, frms, cnt = floor
        print(f"  Boden aus der Tiefe (RANSAC, {cnt} Punkte): Kamera {fd:.0f} mm hoch, Neigung {math.degrees(math.asin(np.clip(fn[2], -1, 1))):+.1f}°, "
              f"Roll {math.degrees(math.atan2(fn[0], -fn[1])):+.1f}°, Streuung {frms:.1f} mm")
    if not truth:
        print("  (keine Wahrheit daneben: nur das Format geprüft)")
        return rep, rec, None

    T = truth
    rep.check(T["frames"] == n, f"Wahrheit hat {T['frames']} Frames wie die Aufnahme")
    J = len(T["joints"])
    rep.check(all(len(x) == 3 * J for x in T["pos"]) and len(T["pos"]) == n, f"{J} Gelenke pro Frame, Positionen vollständig")
    m = np.array(T["world"]["cam_to_world"], float).reshape(4, 4)
    R, t = m[:3, :3], m[:3, 3]
    rep.check(np.allclose(R @ R.T, np.eye(3), atol=1e-5) and abs(np.linalg.det(R) - 1) < 1e-5, "cam_to_world ist eine Drehung (+ Verschiebung in mm)")
    fl = T["floor"]
    rep.check(np.allclose(fl["normal"], R[1], atol=1e-5) and abs(fl["d_mm"] - t[1]) < 1, "Bodenebene passt zu cam_to_world (Normale = Weltachse y, d = Höhe)")
    if floor:
        ang = math.degrees(math.acos(np.clip(abs(np.dot(fn, fl["normal"])), -1, 1)))
        rep.check(ang < 0.6 and abs(fd - fl["d_mm"]) < 12, f"gemessener Boden = wahrer Boden: Winkel {ang:.2f}°, Höhe {fd - fl['d_mm']:+.1f} mm")

    to_cam = np.linalg.inv(m)
    cam = lambda pw: to_cam[:3, :3] @ np.asarray(pw, float) + to_cam[:3, 3]
    mark = np.array(T["world"]["mark_mm"], float)
    stride = max(1, n // 60)
    sample = list(range(0, n, stride))
    stack = np.stack([rec.frame(i)[0] for i in sample])

    # known points of the room: floor beside the mark and in front of it, the wall behind
    probes = [("Boden 0,9 m links der Marke", mark + [-900, 0, 0]), ("Boden 0,9 m rechts der Marke", mark + [900, 0, 0]),
              ("Boden 0,45 m vor der Marke", mark + [0, 0, 450])]
    wall_z = -(T["kinect"]["distance_m"] + T["truth"]["wall_m"]) * 1000
    probes.append(("Wand hinter der Person, 1,6 m hoch, 1 m seitlich", np.array([1000, 1600, wall_z])))
    for name, pw in probes:
        pc = cam(pw)
        u, v = project(p, pc)
        if not (2 <= u < W - 2 and 2 <= v < H - 2):
            print(f"  ({name}: außerhalb des Bildes)")
            continue
        meas = np.median([median_at(s, u, v) for s in stack])
        if pc[2] > 4500:
            rep.check(meas == 0, f"{name}: {pc[2]:.0f} mm, jenseits der Reichweite: gemessen {meas:.0f} (0 = keine Tiefe)")
            continue
        rep.check(abs(meas - pc[2]) < 12, f"{name}: Pixel ({u:.0f}, {v:.0f}), erwartet {pc[2]:.0f} mm, gemessen {meas:.0f} mm ({meas - pc[2]:+.1f})")

    # the body: measured depth at the joints' pixels against the surface the renderer saw there
    tr = T["truth"]
    errs, offs, holes = [], [], 0
    torso = [T["joints"].index(nm) for nm in ("left_shoulder", "right_shoulder", "left_hip", "right_hip", "pelvis", "neck")]
    perp, ray_err = [], []
    for k, i in enumerate(sample):
        pos = np.array(T["pos"][i], float).reshape(-1, 3)
        for j in torso:
            if tr["visible_codes"][i][j] != "v" or tr["hit_codes"][i][j] != "p":
                continue
            u, v = tr["uv_values"][i][2 * j], tr["uv_values"][i][2 * j + 1]
            # the whole chain, independently: pixel -> LUT ray (unmirrored) -> CAMERA -> WORLD, against the joint
            ray = np.array([-lut_at(rec.lut, u, v, 0), lut_at(rec.lut, u, v, 1), 1.0])
            jc = cam(pos[j])
            ray_err.append(math.degrees(math.acos(np.clip(ray @ jc / np.linalg.norm(ray) / np.linalg.norm(jc), -1, 1))))
            meas = median_at(stack[k], u, v, 0)
            if meas == 0:
                holes += 1
                continue
            errs.append(meas - tr["zsurf_mm"][i][j])
            offs.append(tr["zcam_mm"][i][j] - meas)
            pw = R @ (ray * meas) + t
            d = pos[j] - pw
            axis = (pos[j] - t) / np.linalg.norm(pos[j] - t)
            perp.append(np.linalg.norm(d - (d @ axis) * axis))
    if errs:
        e = np.abs(errs)
        rep.check(np.median(e) < 6 and np.percentile(e, 90) < 25,
                  f"Körper: Tiefe an Schultern/Hüften/Becken/Hals = gerenderte Oberfläche (Median {np.median(e):.1f} mm, 90 % {np.percentile(e, 90):.1f} mm, "
                  f"{len(errs)} Proben, {holes} Löcher); Gelenkmitte liegt im Median {np.median(offs):.0f} mm hinter der Haut")
        rep.check(max(ray_err) < 0.05 and np.median(perp) < 3,
                  f"Kette Pixel -> LUT -> Kamera -> Welt: Strahl zum wahren Gelenk max. {max(ray_err):.3f}°, "
                  f"gemessener Punkt liegt im Median {np.median(perp):.1f} mm neben der Sichtlinie zum Gelenk")
    # hands: how often a hand joint's pixel has a depth that belongs to the hand
    hj = [j for j, nm in enumerate(T["joints"]) if "_hand_" in nm]
    seen = good = 0
    for k, i in enumerate(sample):
        for j in hj:
            if tr["visible_codes"][i][j] != "v":
                continue
            seen += 1
            meas = median_at(stack[k], tr["uv_values"][i][2 * j], tr["uv_values"][i][2 * j + 1], 0)
            good += meas > 0 and abs(meas - tr["zsurf_mm"][i][j]) < 30
    if seen:
        print(f"  Hände: {good / seen * 100:.0f} % der sichtbaren Handpunkte haben eine passende Tiefe (Rest: Kanten, fliegende Pixel, Löcher)")

    # the cable: contrast in the infrared, and how often the depth sees it
    cable_pts = cable_dark = cable_depth = 0
    for k, i in enumerate(sample):
        _, ir = rec.frame(i)
        for ln in T["cable"][i]:
            pts = np.array(ln["pts"], float).reshape(-1, 3)
            pc = (to_cam[:3, :3] @ pts.T).T + to_cam[:3, 3]
            u, v = project(p, pc)
            for a in range(len(u)):
                iu, iv = int(round(u[a])), int(round(v[a]))
                if not (3 <= iu < W - 3 and 3 <= iv < H - 3):
                    continue
                ring = np.concatenate([ir[iv - 3, iu - 3:iu + 4], ir[iv + 3, iu - 3:iu + 4], ir[iv - 3:iv + 4, iu - 3], ir[iv - 3:iv + 4, iu + 3]])
                cable_pts += 1
                cable_dark += int(ir[iv, iu]) < np.median(ring) - 4
                cable_depth += abs(float(stack[k][iv, iu]) - pc[a, 2]) < 25
    if cable_pts:
        print(f"  Kabel: an {cable_dark / cable_pts * 100:.0f} % seiner Punkte im Infrarot dunkler als die Umgebung, "
              f"an {cable_depth / cable_pts * 100:.0f} % mit eigener Tiefe (±25 mm)")

    # markers: the hands meet at the clap
    clap = T["markers"]["clap"]
    ci = frame_at(T, clap)
    if abs(frame_times(T)[ci] - clap) < 0.04:
        pos = np.array(T["pos"][ci], float).reshape(-1, 3)
        a, b = T["joints"].index("left_hand_middle_mcp"), T["joints"].index("right_hand_middle_mcp")
        gap = np.linalg.norm(pos[a] - pos[b])
        rep.check(gap < 80, f"Klatschen bei {clap:.2f} s: Handmitten {gap:.0f} mm auseinander")
    print(f"  IK-Restfehler der Choreographie max. {tr.get('ik_pos_error_max_mm')} mm; Gelenke gesehen: "
          + ", ".join(f"{nm} {T['quality']['joints'][nm]['depth_hits'] * 100:.0f} %" for nm in ("left_wrist", "right_wrist", "left_hand_index_tip", "right_hand_index_tip", "left_ankle")))
    return rep, rec, truth


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("files", nargs="+")
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--frames", help="Frames für die Vorschau, z. B. 30,150,240 (Standard: die Zeiten preview_s der Wahrheit, sonst Klatschen, Mitte, Ende der Aktion)")
    args = ap.parse_args()
    failed = []
    files = []
    for f in args.files:
        p = Path(f)
        if p.is_dir():
            files += sorted(str(x) for x in p.glob("*.k2rec"))
        elif any(c in f for c in "*?["):
            files += sorted(str(x) for x in Path(p.anchor or ".").glob(str(p.relative_to(p.anchor)) if p.anchor else f))
        else:
            files.append(f)
    for f in files:
        try:
            rep, rec, truth = check_file(f, args)
        except (OSError, ValueError) as e:
            print(f"  FEHLER {e}")
            failed.append(f)
            continue
        failed += [f"{f}: {x}" for x in rep.failed]
        if not args.no_preview:
            n = len(rec.frames)
            if args.frames:
                frames = [int(x) for x in args.frames.split(",")]
            elif truth:
                mk = truth["markers"]
                times = truth.get("truth", {}).get("preview_s") or [mk["clap"], (mk["start"] + mk["end"]) / 2, mk["end"] - 0.6]
                frames = [frame_at(truth, x) for x in times]
            else:
                frames = [0, n // 2, n - 1]
            frames = [min(max(0, i), n - 1) for i in frames]
            out = Path(str(f)[: -len(".k2rec")] + ".preview.png")
            preview(rec, truth, frames, out)
            print(f"  Vorschau: {out} (Frames {frames}: Tiefe | Infrarot | Infrarot mit Wahrheit)")
    print("alles in Ordnung" if not failed else f"{len(failed)} Prüfungen fehlgeschlagen")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
