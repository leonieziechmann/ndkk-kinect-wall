"""Kameramodell, Boden und WELT (FORMAT.md, Abschnitt Koordinaten).

KAMERA: Tiefenkamera der Kinect, ungespiegelt, mm; x nach rechts, wie vom Sensor aus in die Szene gesehen;
y nach unten; z nach vorn. Der Hub liefert das Bild gespiegelt: Hub-Pixel (u, v) mit Tiefe z ergibt den
KAMERA-Punkt (-lut.x * z, lut.y * z, z).

WELT: mm, y nach oben, Boden bei y = 0, Ursprung auf dem Boden senkrecht unter dem Sensor, +z waagrecht von
der Person zum Sensor (-z = Blickrichtung der Kamera auf den Boden projiziert), x = y x z.
p_welt = R p_kamera + t, Zeile 2 von R = Bodennormale (KAMERA), t = (0, d_mm, 0).
"""

import math

import numpy as np


# ---------------------------------------------------------------------------------------- Strahlen

def lut_bilinear(lut, u, v):
    """LUT (H, W, 2) bilinear an Bruchteil-Pixeln (u, v) (Arrays gleicher Form) -> (x, y) des Hub-Strahls."""
    H, W = lut.shape[:2]
    u = np.asarray(u, np.float64)
    v = np.asarray(v, np.float64)
    u0 = np.clip(np.floor(u).astype(np.int64), 0, W - 2)
    v0 = np.clip(np.floor(v).astype(np.int64), 0, H - 2)
    a = np.clip(u - u0, 0.0, 1.0)
    b = np.clip(v - v0, 0.0, 1.0)
    q00, q01 = lut[v0, u0], lut[v0, u0 + 1]
    q10, q11 = lut[v0 + 1, u0], lut[v0 + 1, u0 + 1]
    a = a[..., None]
    b = b[..., None]
    return (1 - b) * ((1 - a) * q00 + a * q01) + b * ((1 - a) * q10 + a * q11)


def rays(lut, u, v):
    """KAMERA-Strahlen (..., 3) mit z = 1 für Hub-Pixel (u, v): (-lut.x, lut.y, 1)."""
    q = lut_bilinear(lut, u, v)
    return np.stack([-q[..., 0], q[..., 1], np.ones_like(q[..., 0])], axis=-1)


def camera_points(depth, lut):
    """KAMERA-Punkte (H, W, 3) in mm eines Tiefenbilds (0 = keine Tiefe)."""
    z = depth.astype(np.float32)
    return np.stack([-lut[..., 0] * z, lut[..., 1] * z, z], axis=-1)


def project_params(params, pc):
    """Hub-Pixel (u, v) von KAMERA-Punkten (..., 3) mit dem Linsenmodell der Parameter (wie kinect-hub/lut.rs)."""
    pc = np.asarray(pc, np.float64)
    z = np.where(np.abs(pc[..., 2]) < 1e-6, 1e-6, pc[..., 2])
    x = -pc[..., 0] / z
    y = pc[..., 1] / z
    g = lambda k: float(params.get(k, 0.0) or 0.0)
    r2 = x * x + y * y
    kr = 1 + ((g("k3") * r2 + g("k2")) * r2 + g("k1")) * r2
    xd = x * kr + g("p2") * (r2 + 2 * x * x) + 2 * g("p1") * x * y
    yd = y * kr + g("p1") * (r2 + 2 * y * y) + 2 * g("p2") * x * y
    return g("cx") + g("fx") * xd, g("cy") + g("fy") * yd


class Camera:
    """Parameter + LUT einer Aufnahme. project() ist auf die LUT abgestimmt (zwei Newton-Schritte), so dass
    rays(project(p)) wieder durch p geht, auch wenn die LUT nicht genau aus den Parametern stammt."""

    def __init__(self, params, lut):
        self.params = dict(params)
        self.lut = lut
        self.H, self.W = lut.shape[:2]
        if not all(k in self.params for k in ("fx", "fy", "cx", "cy")):
            self.params.update(estimate_intrinsics(lut))
        # Ableitung der LUT nach u und v (für die Newton-Schritte)
        self._dxdu = np.gradient(lut[..., 0], axis=1)
        self._dydv = np.gradient(lut[..., 1], axis=0)

    def rays(self, u, v):
        return rays(self.lut, u, v)

    def project(self, pc, iterations=2):
        pc = np.asarray(pc, np.float64)
        u, v = project_params(self.params, pc)
        z = np.where(np.abs(pc[..., 2]) < 1e-6, 1e-6, pc[..., 2])
        tx, ty = -pc[..., 0] / z, pc[..., 1] / z
        for _ in range(iterations):
            ok = np.isfinite(u) & np.isfinite(v)
            uu = np.where(ok, np.clip(u, 0, self.W - 1.001), 0)
            vv = np.where(ok, np.clip(v, 0, self.H - 1.001), 0)
            q = lut_bilinear(self.lut, uu, vv)
            iu = np.clip(np.round(uu).astype(int), 0, self.W - 1)
            iv = np.clip(np.round(vv).astype(int), 0, self.H - 1)
            du = self._dxdu[iv, iu]
            dv = self._dydv[iv, iu]
            inside = ok & (u >= 0) & (u <= self.W - 1) & (v >= 0) & (v <= self.H - 1)
            u = np.where(inside & (np.abs(du) > 1e-6), u + (tx - q[..., 0]) / np.where(np.abs(du) > 1e-6, du, 1), u)
            v = np.where(inside & (np.abs(dv) > 1e-6), v + (ty - q[..., 1]) / np.where(np.abs(dv) > 1e-6, dv, 1), v)
        return u, v

    def to_json(self):
        p = self.params
        out = {k: p.get(k, 0.0) for k in ("fx", "fy", "cx", "cy", "k1", "k2", "k3", "p1", "p2")}
        out = {"width": self.W, "height": self.H, **out, "mirrored": True,
               "frame": "CAMERA: unmirrored depth camera, mm; x right as seen from the sensor looking into the scene, "
                        "y down, z forward. Hub pixel (u, v) with depth z: hub point (lut.x*z, lut.y*z, z), "
                        "CAMERA point (-lut.x*z, lut.y*z, z)."}
        return out


def estimate_intrinsics(lut):
    """fx, fy, cx, cy aus der LUT (für Aufnahmen ohne params): lineare Näherung um die Bildmitte."""
    H, W = lut.shape[:2]
    cu, cv = W // 2, H // 2
    fx = 1.0 / float(np.mean(np.diff(lut[cv, cu - 20:cu + 20, 0])))
    fy = 1.0 / float(np.mean(np.diff(lut[cv - 20:cv + 20, cu, 1])))
    cx = cu - float(lut[cv, cu, 0]) * fx
    cy = cv - float(lut[cv, cu, 1]) * fy
    return {"fx": fx, "fy": fy, "cx": cx, "cy": cy}


# ---------------------------------------------------------------------------------------- Boden

def expected_floor_normal(pitch_deg):
    """Bodennormale (nach oben) in KAMERA bei einer Kinect ohne Rollen, um pitch_deg geneigt (negativ = nach unten)."""
    a = math.radians(-(pitch_deg or 0.0))
    return np.array([0.0, -math.cos(a), -math.sin(a)])


def _refine(pts, n, d, thr):
    inl = np.abs(pts @ n + d) < thr
    if inl.sum() < 3:
        return n, d, inl
    q = pts[inl]
    c = q.mean(axis=0)
    _, _, vt = np.linalg.svd(q - c, full_matrices=False)
    m = vt[2] if np.dot(vt[2], n) > 0 else -vt[2]
    return m, float(-m @ c), inl


def fit_floor(points, rng=None, prior_normal=None, prior_height_mm=None, max_angle_deg=35.0, iterations=400):
    """Bodenebene aus KAMERA-Punkten (N, 3) mm per RANSAC. Höhe eines Punkts über dem Boden = n . p + d.
    Waagrechte Ebenen werden gesammelt; Boden = die mit den meisten Punkten, gewichtet mit der geplanten
    Kamerahöhe (falls bekannt, damit z. B. eine Tischplatte nicht gewinnt), sonst die unterste große Ebene.
    Gibt dict(normal, d_mm, rms_mm, inliers, points, candidates) oder None."""
    rng = rng or np.random.default_rng(1)
    pts = np.asarray(points, np.float64)
    pts = pts[np.isfinite(pts).all(axis=1) & (pts[:, 2] > 0) & (pts[:, 2] < 4500)]
    if len(pts) < 300:
        return None
    if len(pts) > 40000:
        pts = pts[rng.choice(len(pts), 40000, replace=False)]
    z_m = pts[:, 2] / 1000.0
    thr_pts = 8.0 + 1.5 * z_m ** 2  # Rauschen wächst mit z^2
    up = prior_normal if prior_normal is not None else np.array([0.0, -1.0, 0.0])
    up = up / np.linalg.norm(up)
    cos_max = math.cos(math.radians(max_angle_deg))
    cands = []
    for _ in range(iterations):
        a, b, c = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n)
        if ln < 1e-6:
            continue
        n = n / ln
        if n @ up < 0:
            n = -n
        if n @ up < cos_max:
            continue
        d = -n @ a
        if d < 150:  # die Kamera liegt über dem Boden: Ebene mindestens 15 cm unter ihr
            continue
        inl = np.abs(pts @ n + d) < thr_pts
        cands.append((int(inl.sum()), n, float(d)))
    if not cands:
        return None
    cands.sort(key=lambda x: -x[0])
    # Kandidaten zu Ebenen zusammenfassen (ähnliche Normale und Höhe)
    planes = []
    for cnt, n, d in cands[:60]:
        for p in planes:
            if abs(p["d"] - d) < 60 and p["n"] @ n > math.cos(math.radians(4)):
                break
        else:
            m, dd, inl = _refine(pts, n, d, thr_pts)
            m, dd, inl = _refine(pts, m, dd, thr_pts)
            planes.append({"n": m, "d": dd, "count": int(inl.sum()), "inl": inl})
    best_count = max(p["count"] for p in planes)
    for p in planes:
        w = p["count"] / best_count
        if prior_height_mm:
            w *= math.exp(-((p["d"] - prior_height_mm) / 450.0) ** 2)
        else:
            # ohne geplante Höhe: die unterste Ebene mit mindestens 30 % der Punkte der größten (Tisch liegt höher)
            w = (1.0 + p["d"] / 1000.0) if p["count"] >= 0.3 * best_count else 0.0
        p["score"] = w
    best = max(planes, key=lambda p: p["score"])
    q = pts[best["inl"]]
    res = q @ best["n"] + best["d"]
    return {"normal": best["n"], "d_mm": float(best["d"]), "rms_mm": float(np.sqrt(np.mean(res ** 2))),
            "inliers": int(best["count"]), "points": int(len(pts)),
            "candidates": [{"d_mm": round(p["d"]), "count": p["count"], "score": round(p["score"], 3)} for p in planes[:6]]}


def floor_points_from_depth(depths, lut, rows=(0.35, 1.0), step=2):
    """KAMERA-Punkte für die Bodensuche aus mehreren Tiefenbildern: Median je Pixel (bewegte Personen fallen
    heraus), untere Bildteile, jedes step-te Pixel."""
    stack = np.stack([d for d in depths]).astype(np.float32)
    stack[stack == 0] = np.nan
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(stack, axis=0)
    med = np.nan_to_num(med, nan=0.0)
    H = med.shape[0]
    r0, r1 = int(rows[0] * H), int(rows[1] * H)
    sub = med[r0:r1:step, ::step]
    L = lut[r0:r1:step, ::step]
    pts = np.stack([-L[..., 0] * sub, L[..., 1] * sub, sub], axis=-1).reshape(-1, 3)
    return pts[pts[:, 2] > 0]


# ---------------------------------------------------------------------------------------- WELT

def world_from_floor(normal, d_mm):
    """4 x 4 KAMERA-mm -> WELT-mm (FORMAT.md): Zeile 2 von R = Normale, -z = Kamerablick auf den Boden projiziert."""
    ey = np.asarray(normal, np.float64)
    ey = ey / np.linalg.norm(ey)
    zc = np.array([0.0, 0.0, 1.0])
    f = zc - (zc @ ey) * ey
    if np.linalg.norm(f) < 1e-6:  # Kamera schaut senkrecht nach unten: Bild-oben als Blickrichtung
        f = np.array([0.0, -1.0, 0.0]) - (np.array([0.0, -1.0, 0.0]) @ ey) * ey
    ez = -f / np.linalg.norm(f)
    ex = np.cross(ey, ez)
    m = np.eye(4)
    m[0, :3], m[1, :3], m[2, :3] = ex, ey, ez
    m[:3, 3] = [0.0, float(d_mm), 0.0]
    return m


def apply(m, p):
    p = np.asarray(p, np.float64)
    return p @ m[:3, :3].T + m[:3, 3]


def invert(m):
    r = np.eye(4)
    r[:3, :3] = m[:3, :3].T
    r[:3, 3] = -m[:3, :3].T @ m[:3, 3]
    return r


def tilt_deg(normal):
    """Neigung (Grad, negativ = nach unten) und Rollen der Kamera aus der Bodennormale in KAMERA."""
    n = np.asarray(normal, float)
    pitch = -math.degrees(math.asin(np.clip(-n[2], -1, 1)))
    roll = math.degrees(math.atan2(n[0], -n[1]))
    return pitch, roll
