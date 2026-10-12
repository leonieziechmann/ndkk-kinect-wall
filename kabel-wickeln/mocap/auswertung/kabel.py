"""Kabel aus Infrarot + Tiefe (experimentell): um und unter den Händen eine dünne dunkle (oder helle) Linie.

1. Suchgebiet: Kreise um beide Hände (0,55 m) und darunter bis zum Bildrand (der Teil, der zum Boden hängt
   oder dort liegt), nur Pixel, die zur Szene vor der Wand gehören.
2. Linienstärke aus der Hesse-Matrix des geglätteten Infrarotbilds (sigma 1 und 1,6 px): quer zur Linie stark
   gekrümmt, längs kaum. Dazu muss es auf beiden Seiten heller sein als auf der Linie (eine Kante zwischen hell und
   dunkel ist keine Linie). Relativ zur örtlichen Helligkeit, damit es in hellen und dunklen Bildteilen gleich zählt.
3. Ausdünnen: nur das Maximum quer zur Linie bleibt (1 px breit), Hysterese-Schwelle, Lücken bis 2 px schließen.
4. Verbinden: Pixelketten zu Polylinien, an Kreuzungen getrennt, kurze Lücken mit passender Richtung überbrückt.
5. 3D: Tiefe an der Linie, wo sie passt (nahe den Händen oder auf dem Boden); fehlt sie (am dünnen Kabel oft nur
   Kantenpixel), entlang der Linie interpoliert, unten am Boden als Schnitt des Sichtstrahls mit dem Boden.
6. Geglättet, auf etwa 2 cm Abstand gebracht, in die WELT. Konfidenz aus Kontrast, Länge und Tiefenanteil.
"""

import numpy as np

from . import kamera as K

W, H = 512, 424


# ---------------------------------------------------------------------------------------- Bildfilter

def gauss_kernel(sigma):
    r = max(1, int(np.ceil(3 * sigma)))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-x * x / (2 * sigma * sigma))
    return k / k.sum()


def conv1(img, k, axis):
    r = len(k) // 2
    pad = [(0, 0), (0, 0)]
    pad[axis] = (r, r)
    p = np.pad(img, pad, mode="edge")
    out = np.zeros_like(img, dtype=np.float32)
    n = img.shape[axis]
    for i, kv in enumerate(k):
        sl = [slice(None), slice(None)]
        sl[axis] = slice(i, i + n)
        out += kv * p[tuple(sl)]
    return out


def blur(img, sigma):
    k = gauss_kernel(sigma)
    return conv1(conv1(img.astype(np.float32), k, 0), k, 1)


def hessian(img, sigma):
    g = blur(img, sigma)
    gy, gx = np.gradient(g)
    gxy, gxx = np.gradient(gx)
    gyy, _ = np.gradient(gy)
    return gxx, gxy, gyy, g


def ridge(ir, sigma, dark=True):
    """Linienstärke (relativ) und Richtung quer zur Linie (nx, ny) bei Maßstab sigma."""
    gxx, gxy, gyy, g = hessian(ir, sigma)
    tr = gxx + gyy
    disc = np.sqrt(np.maximum(((gxx - gyy) / 2) ** 2 + gxy ** 2, 0))
    l1 = tr / 2 + disc  # größter Eigenwert
    l2 = tr / 2 - disc
    if dark:
        strength = np.clip(l1 - np.abs(l2), 0, None)
        lam = l1
    else:
        strength = np.clip(-l2 - np.abs(l1), 0, None)
        lam = l2
    # Eigenvektor zu lam: quer zur Linie
    nx = gxy
    ny = lam - gxx
    alt = np.abs(nx) + np.abs(ny) < 1e-9
    nx = np.where(alt, 1.0, nx)
    ny = np.where(alt, 0.0, ny)
    n = np.sqrt(nx * nx + ny * ny)
    local = blur(ir, 4.0) + 8.0
    return sigma * sigma * strength / local, nx / n, ny / n


def sample(img, x, y):
    xi = np.clip(np.round(x).astype(int), 0, img.shape[1] - 1)
    yi = np.clip(np.round(y).astype(int), 0, img.shape[0] - 1)
    return img[yi, xi]


def min3(d):
    """kleinste gültige Tiefe im 3 x 3 um jedes Pixel (0 = keine)."""
    big = np.where(d > 0, d, np.inf).astype(np.float32)
    p = np.pad(big, 1, constant_values=np.inf)
    h, w = d.shape
    out = np.full((h, w), np.inf, np.float32)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            out = np.minimum(out, p[dy:dy + h, dx:dx + w])
    return np.where(np.isfinite(out), out, 0.0)


def thin_line_mask(ir, roi, dark=True, depth=None, floor_z=None, hi=0.07, lo=0.035):
    """Pixel auf Linien (1 px breit) im Suchgebiet, mit Stärke und Kontrast. Mit Tiefe: eine Linie muss vor
    beiden Seiten liegen (Kabel vor Körper oder Wand), ein Loch zwischen gleich tiefen Seiten sein (dünnes Kabel ohne
    eigene Tiefe) oder auf dem Boden liegen. Fugen (zwischen Arm und Rumpf, zwischen den Beinen) und dunkle Ränder an
    der Silhouette fallen so weg."""
    ir = ir.astype(np.float32)
    best = np.zeros(ir.shape, np.float32)
    bnx = np.zeros_like(best)
    bny = np.zeros_like(best)
    sig_best = np.ones_like(best)
    for s in (1.0, 1.6):
        r, nx, ny = ridge(ir, s, dark)
        take = r > best
        best = np.where(take, r, best)
        bnx = np.where(take, nx, bnx)
        bny = np.where(take, ny, bny)
        sig_best = np.where(take, s, sig_best)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    # beide Seiten heller (dunkle Linie) bzw. dunkler (helle Linie) als die Mitte
    g = blur(ir, 0.7)
    off = 1.5 * sig_best + 1.0
    c = sample(g, xx, yy)
    a = sample(g, xx + off * bnx, yy + off * bny)
    b = sample(g, xx - off * bnx, yy - off * bny)
    contrast = (np.minimum(a, b) - c) if dark else (c - np.maximum(a, b))
    rel = contrast / (np.maximum(a, b) + 8.0)
    ok = roi & (rel > 0.04) & (best > lo)
    if depth is not None:
        d = depth.astype(np.float32)
        dc = min3(d)
        o2 = off + 2.0
        da = sample(dc, xx + o2 * bnx, yy + o2 * bny)
        db = sample(dc, xx - o2 * bnx, yy - o2 * bny)
        both = (da > 0) & (db > 0)
        near_side = np.where(both, np.minimum(da, db), np.maximum(da, db))
        tol = 8.0 + 0.004 * near_side
        in_front = (dc > 0) & (near_side > 0) & (dc < near_side - tol)
        hole = (sample(d, xx, yy) == 0) & both & (np.abs(da - db) < 60 + 0.03 * near_side)
        on_floor = np.zeros_like(ok)
        if floor_z is not None:
            fz = floor_z
            fl = lambda z: (fz > 0) & (z > 0) & (np.abs(z - fz) < 30 + 0.012 * fz)
            on_floor = fl(dc) & fl(da) & fl(db)
        ok &= in_front | hole | on_floor
    # Maximum quer zur Linie
    r1 = sample(best, xx + bnx, yy + bny)
    r2 = sample(best, xx - bnx, yy - bny)
    nms = ok & (best >= r1) & (best >= r2)
    strong = nms & (best > hi) & (rel > 0.06)
    # Hysterese: von starken Pixeln aus über schwache Nachbarn wachsen
    keep = strong.copy()
    for _ in range(60):
        grown = dilate(keep) & nms
        if (grown == keep).all():
            break
        keep = grown | keep
    return keep, best, rel


def dilate(m):
    p = np.pad(m, 1)
    out = np.zeros_like(m)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            out |= p[1 + dy:1 + dy + m.shape[0], 1 + dx:1 + dx + m.shape[1]]
    return out


def close_gaps(m):
    """Einzelne fehlende Pixel zwischen zwei Linienpixeln ergänzen (Abstand 2 in einer Richtung)."""
    p = np.pad(m, 2)
    add = np.zeros_like(m)
    h, w = m.shape
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        a = p[2 - dy:2 - dy + h, 2 - dx:2 - dx + w]
        b = p[2 + dy:2 + dy + h, 2 + dx:2 + dx + w]
        add |= a & b
    return m | add


def thin(m):
    """Zhang-Suen-Ausdünnung (vektorisiert)."""
    m = m.copy()
    for _ in range(10):
        changed = False
        for step in (0, 1):
            p = np.pad(m, 1).astype(np.uint8)
            h, w = m.shape
            P = [p[1 + dy:1 + dy + h, 1 + dx:1 + dx + w] for dy, dx in
                 ((-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1))]
            B = sum(P)
            A = sum(((P[k] == 0) & (P[(k + 1) % 8] == 1)).astype(np.uint8) for k in range(8))
            if step == 0:
                c1 = (P[0] * P[2] * P[4]) == 0
                c2 = (P[2] * P[4] * P[6]) == 0
            else:
                c1 = (P[0] * P[2] * P[6]) == 0
                c2 = (P[0] * P[4] * P[6]) == 0
            rm = m & (B >= 2) & (B <= 6) & (A == 1) & c1 & c2
            if rm.any():
                m &= ~rm
                changed = True
        if not changed:
            break
    return m


# ---------------------------------------------------------------------------------------- Verbinden

NB8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def trace(m):
    """Pixelketten (Liste von (N, 2) x, y) aus einer dünnen Maske: von Enden aus gehen, immer zum unbesuchten Nachbarn,
    der die Richtung am besten fortsetzt (Kreuzungen werden dabei irgendwo getrennt, für Polylinien reicht das)."""
    ys, xs = np.nonzero(m)
    pts = set(zip(xs.tolist(), ys.tolist()))
    if not pts:
        return []
    deg = {p: sum((p[0] + dx, p[1] + dy) in pts for dy, dx in NB8) for p in pts}
    visited = set()
    chains = []
    order = sorted(pts, key=lambda p: (deg[p], p))  # Enden (Grad 1) zuerst
    for s0 in order:
        if s0 in visited:
            continue
        ch = [s0]
        visited.add(s0)
        d = None
        cur = s0
        while True:
            nb = [(cur[0] + dx, cur[1] + dy) for dy, dx in NB8 if (cur[0] + dx, cur[1] + dy) in pts
                  and (cur[0] + dx, cur[1] + dy) not in visited]
            if not nb:
                break
            if d is None:
                q = min(nb, key=lambda q: (abs(q[0] - cur[0]) + abs(q[1] - cur[1]), q))
            else:
                q = max(nb, key=lambda q: ((q[0] - cur[0]) * d[0] + (q[1] - cur[1]) * d[1])
                        / np.hypot(q[0] - cur[0], q[1] - cur[1]))
                if ((q[0] - cur[0]) * d[0] + (q[1] - cur[1]) * d[1]) / np.hypot(q[0] - cur[0], q[1] - cur[1]) < -0.2:
                    break  # keine Umkehr
            nd = (q[0] - cur[0], q[1] - cur[1])
            d = nd if d is None else (0.6 * d[0] + 0.4 * nd[0], 0.6 * d[1] + 0.4 * nd[1])
            visited.add(q)
            ch.append(q)
            cur = q
        if len(ch) >= 2:
            chains.append(np.array(ch, np.float32))
    return chains


def _dir(c, end, n=5):
    """Richtung am Ende einer Kette (nach außen)."""
    if end == 0:
        a, b = c[min(n, len(c) - 1)], c[0]
    else:
        a, b = c[max(-n - 1, -len(c))], c[-1]
    d = b - a
    ln = np.linalg.norm(d)
    return d / ln if ln > 1e-6 else d


def join(chains, max_gap=6.0, max_angle=40.0, min_len=3):
    """Ketten verbinden, deren Enden nah sind und aufeinander zu zeigen: alle Kandidaten über ein Gitter, dann gierig
    nach Abstand verbinden (jedes Ende höchstens einmal, keine Ringe aus mehreren Ketten)."""
    chains = [c for c in chains if len(c) >= min_len]
    n = len(chains)
    if n < 2:
        return chains
    cos_max = np.cos(np.radians(max_angle))
    ends = []  # (Kette, Ende, Punkt, Richtung)
    grid = {}
    cell = max_gap
    for i, c in enumerate(chains):
        for e in (0, 1):
            p = c[0] if e == 0 else c[-1]
            ends.append((i, e, p, _dir(c, e)))
            grid.setdefault((int(p[0] // cell), int(p[1] // cell)), []).append(len(ends) - 1)
    pairs = []
    for k, (i, e, p, d) in enumerate(ends):
        gx, gy = int(p[0] // cell), int(p[1] // cell)
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                for k2 in grid.get((gx + ox, gy + oy), []):
                    if k2 <= k:
                        continue
                    j, f, q, dq = ends[k2]
                    if j == i:
                        continue
                    gap = float(np.linalg.norm(p - q))
                    if gap > max_gap or float(d @ -dq) < cos_max:
                        continue
                    if gap > 1.5 and float(d @ ((q - p) / gap)) < cos_max * 0.8:
                        continue
                    pairs.append((gap, k, k2))
    pairs.sort()
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    link = {}
    for gap, k, k2 in pairs:
        if k in link or k2 in link:
            continue
        i, j = ends[k][0], ends[k2][0]
        if find(i) == find(j):
            continue
        parent[find(i)] = find(j)
        link[k] = k2
        link[k2] = k
    # Ketten zusammensetzen: bei einer Kette mit freiem Ende beginnen und den Verbindungen folgen
    used = set()
    out = []
    for start in range(n):
        if start in used:
            continue
        # freies Ende suchen
        e0 = 0 if (2 * start) not in link else 1 if (2 * start + 1) not in link else None
        if e0 is None:
            continue
        seq = []
        i, e = start, e0
        while True:
            used.add(i)
            c = chains[i] if e == 0 else chains[i][::-1]
            seq.append(c)
            other = 2 * i + (1 - e)
            if other not in link:
                break
            k2 = link[other]
            i, e = ends[k2][0], ends[k2][1]
            if i in used:
                break
        out.append(np.concatenate(seq))
    for i in range(n):
        if i not in used:
            out.append(chains[i])
    return out


# ---------------------------------------------------------------------------------------- 3D

def resample_polyline(p, step):
    seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] < step:
        return p[[0, -1]] if len(p) > 1 else p
    q = np.arange(0, s[-1] + 1e-6, step)
    return np.stack([np.interp(q, s, p[:, k]) for k in range(p.shape[1])], 1)


def smooth_polyline(p, k=2):
    if len(p) < 2 * k + 1:
        return p
    out = p.copy()
    for i in range(len(p)):
        a, b = max(0, i - k), min(len(p), i + k + 1)
        out[i] = p[a:b].mean(0)
    out[0], out[-1] = p[0], p[-1]
    return out


class CableFinder:
    def __init__(self, cam, world, dark=True, min_len_px=12):
        self.cam = cam
        self.world = world
        self.to_cam = K.invert(world)
        self.dark = dark
        self.min_len = min_len_px
        self.floor_n = world[1, :3]
        self.floor_d = world[1, 3]
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        r = cam.rays(xx, yy)
        self.rays = r  # z = 1
        self.yy, self.xx = yy, xx
        # Tiefe des Bodens je Pixel (Schnitt des Strahls mit dem Boden), 0 = trifft ihn nicht vor der Kamera
        den = r @ self.floor_n
        zf = np.where(den < -1e-6, -self.floor_d / np.where(den < -1e-6, den, -1), 0.0)
        self.floor_z = np.where((zf > 300) & (zf < 9000), zf, 0.0)

    def roi(self, depth, hands_uvz, fx):
        """Suchgebiet um und unter den Händen."""
        m = np.zeros((H, W), bool)
        for u, v, z in hands_uvz:
            if not np.isfinite(u):
                continue
            rad = 550.0 * fx / max(z, 500.0)
            m |= (self.xx - u) ** 2 + (self.yy - v) ** 2 < rad * rad
            half = 450.0 * fx / max(z, 500.0)
            m |= (np.abs(self.xx - u) < half) & (self.yy > v)
        return m

    def find(self, ir, depth, hands_uvz):
        """hands_uvz: [(u, v, z_mm)] der Handmitten (Hub-Pixel). -> Liste {"pts": (N, 3) WELT mm, "conf", "px": (N, 2)}."""
        fx = float(self.cam.params.get("fx", 365.0))
        if not hands_uvz or ir is None:
            return []
        zh = np.nanmedian([z for _, _, z in hands_uvz]) if hands_uvz else 2000.0
        roi = self.roi(depth, hands_uvz, fx)
        d = depth.astype(np.float32)
        # Hintergrund (Wand) ausschließen: deutlich hinter den Händen und nicht Boden
        floor_like = (self.floor_z > 0) & (np.abs(d - self.floor_z) < 40 + 0.02 * self.floor_z)
        behind = (d > zh + 700) & ~floor_like
        roi &= ~behind
        if not roi.any():
            return []
        keep, strength, rel = thin_line_mask(ir, roi, self.dark, d, self.floor_z)
        keep = thin(close_gaps(keep))
        chains = join(trace(keep))
        out = []
        for c in chains:
            seg = np.linalg.norm(np.diff(c, axis=0), axis=1).sum()
            if seg < self.min_len:
                continue
            pl = self.lift(c, d, zh, floor_like)
            if pl is None:
                continue
            pts3, depth_frac = pl
            contrast = float(np.mean(sample(rel, c[:, 0], c[:, 1])))
            conf = np.clip(contrast / 0.2, 0, 1) * np.clip(seg / 60.0, 0.3, 1.0) * (0.5 + 0.5 * depth_frac)
            out.append({"pts": pts3, "conf": float(conf), "px": c, "length_px": float(seg)})
        return out

    def lift(self, c, d, zh, floor_like):
        u, v = c[:, 0], c[:, 1]
        n = len(c)
        z = np.full(n, np.nan)
        for k in range(n):
            iu, iv = int(round(u[k])), int(round(v[k]))
            win = d[max(0, iv - 1):iv + 2, max(0, iu - 1):iu + 2]
            fl = floor_like[max(0, iv - 1):iv + 2, max(0, iu - 1):iu + 2]
            vals = win[(win > 0)]
            if vals.size == 0:
                continue
            # nahe den Händen oder auf dem Boden
            near = vals[np.abs(vals - zh) < 450]
            if near.size:
                z[k] = float(np.min(near))  # das Kabel liegt vor dem, was dahinter ist
            elif fl.any():
                z[k] = float(np.median(win[fl]))
        have = np.isfinite(z)
        depth_frac = float(have.mean())
        if have.sum() == 0:
            # keine Tiefe: unten am Boden, sonst in Handtiefe
            fz = self.floor_z[np.clip(np.round(v).astype(int), 0, H - 1), np.clip(np.round(u).astype(int), 0, W - 1)]
            if np.all(fz > 0) and np.median(v) > 0.6 * H:
                z = fz.astype(float)
            else:
                z = np.full(n, zh)
        else:
            idx = np.arange(n)
            z = np.interp(idx, idx[have], z[have])
        # Ausreißer entlang der Linie entfernen
        zm = np.array([np.median(z[max(0, k - 3):k + 4]) for k in range(n)])
        z = np.where(np.abs(z - zm) > 120, zm, z)
        r = self.cam.rays(u, v)
        pc = r * z[:, None]
        pw = K.apply(self.world, pc)
        pw = smooth_polyline(pw, 2)
        pw = resample_polyline(pw, 20.0)
        return pw, depth_frac


def to_json(lines):
    return [{"pts": [int(round(x)) for x in ln["pts"].reshape(-1)], "conf": int(round(ln["conf"] * 100))} for ln in lines]
