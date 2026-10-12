"""2D-Keypoints + Tiefe -> 3D-Gelenke in der WELT, mit Knochenlängen, Lücken, Glättung und genau 30 fps.

Je Frame (Messung):
  1. Tiefe am Keypoint robust: alle gültigen Tiefen in einem kleinen Fenster (Größe nach Abstand und
     Gelenkgruppe), in Gruppen getrennt, wo zwischen zwei Werten eine Lücke ist (Kanten: Person/Hintergrund,
     Hand/Körper, fliegende Pixel). Gruppen mit zu wenig Pixeln fallen weg.
  2. Welche Gruppe zur Person gehört, entscheidet der Körperbau: Rumpf zuerst (die fernste große Gruppe in
     der Rumpffläche ist der Körper; davor liegen Hände, Ring, Kabel), dann vom Rumpf nach außen: Ellbogen und
     Knie dürfen höchstens eine Knochenlänge vor/hinter dem Elternteil liegen, Hand- und Fußpunkte nahe am
     Handgelenk/Knöchel.
  3. KAMERA-Punkt = Strahl des Keypoints x Tiefe, entlang der Sichtlinie um den Abstand Haut -> Gelenkmitte
     nach hinten versetzt (gelenke.RADIUS), dann in die WELT.
Über den ganzen Take:
  4. Knochenlängen der Person (Median über Frames, in denen beide Enden sicher gemessen sind; oder aus der
     Kalibrierung). Passt ein Gelenk nicht zu seinem Elternteil (oder fehlt seine Tiefe), wird es auf seinem
     Strahl so gesetzt, dass die Knochenlänge stimmt (how = B).
  5. Robuste lokale quadratische Regression in der Zeit (Gewichte: Konfidenz x Tricube, zwei Durchgänge mit
     Ausreißer-Gewichten): glättet, behält schnelle Bewegungen, wirft Ausreißer heraus und wertet direkt auf dem
     30-fps-Raster aus (Aufnahmezeiten mit Lücken -> gleichmäßige Zeit). Lücken bis --max-luecke werden
     kubisch interpoliert (how = I), längere bleiben leer (how = -).
"""

import math

import numpy as np

from . import gelenke as G
from . import kamera as K

C_MIN = 0.3          # 2D-Konfidenz, ab der ein Keypoint zählt
GROUP_K = {"torso": 40.0, "limb": 25.0, "face": 18.0, "foot": 18.0, "hand": 9.0}  # Fenster-Halbbreite in mm
HOW_FACTOR = {"D": 1.0, "B": 0.7, "I": 0.45, "-": 0.0, "T": 1.0}


# ---------------------------------------------------------------------------------------- Tiefe am Keypoint

def density_clusters(vals, min_frac=0.1, max_n=3):
    """Tiefengruppen in sortierten Werten: Gipfel der Dichte (Anzahl Werte in +-r, r = 30 mm + 1 %). Fliegende Pixel
    zwischen zwei Flächen bilden keinen eigenen Gipfel und verbinden die Gruppen nicht. -> [(z, Anteil, Anzahl)]."""
    n = vals.size
    if n == 0:
        return []
    r = 30.0 + 0.01 * vals
    lo = np.searchsorted(vals, vals - r, side="left")
    hi = np.searchsorted(vals, vals + r, side="right")
    dens = hi - lo
    need = max(2, int(np.ceil(min_frac * n)))
    order = np.argsort(-dens, kind="stable")
    peaks = []
    for k in order:
        if dens[k] < need:
            break
        z = vals[k]
        if any(abs(z - p) < 2.2 * (30.0 + 0.01 * z) for p in peaks):
            continue
        peaks.append(float(z))
        if len(peaks) >= max_n:
            break
    out = []
    for p in peaks:
        rr = 45.0 + 0.012 * p
        m = vals[(vals >= p - rr) & (vals <= p + rr)]
        out.append((float(np.median(m)), m.size / n, int(m.size)))
    out.sort(key=lambda x: x[0])
    return out


def window_clusters(depth, u, v, r, max_n=3):
    """Gruppen der gültigen Tiefen in einem (2r+1)^2-Fenster: Liste (z_median, Anteil, Anzahl), nach z sortiert."""
    h, w = depth.shape
    iu, iv = int(round(u)), int(round(v))
    if not (0 <= iu < w and 0 <= iv < h):
        return [], 0
    win = depth[max(0, iv - r):iv + r + 1, max(0, iu - r):iu + r + 1]
    vals = np.sort(win[win > 0].astype(np.float32))
    return density_clusters(vals, 0.12, max_n), vals.size


def torso_surface(depth, kp, fx):
    """Tiefe der Rumpfoberfläche: die fernste große Tiefengruppe im Viereck Schultern/Hüften (Hände und Ring davor)."""
    ids = [G.IDX[n] for n in ("left_shoulder", "right_shoulder", "right_hip", "left_hip")]
    pts = kp[ids]
    ok = pts[:, 2] >= C_MIN
    if ok.sum() < 2:
        return None
    p = pts[ok, :2]
    c = p.mean(axis=0)
    if ok.sum() >= 3:
        p = c + 0.75 * (p - c)  # etwas nach innen
        x0, y0 = np.floor(p.min(0)).astype(int)
        x1, y1 = np.ceil(p.max(0)).astype(int)
    else:
        x0, y0 = np.floor(c - 8).astype(int)
        x1, y1 = np.ceil(c + 8).astype(int)
    h, w = depth.shape
    x0, x1 = max(0, x0), min(w - 1, max(x0 + 1, x1))
    y0, y1 = max(0, y0), min(h - 1, max(y0 + 1, y1))
    win = depth[y0:y1 + 1, x0:x1 + 1]
    vals = np.sort(win[win > 0].astype(np.float32))
    if vals.size < 10:
        return None
    if vals.size > 3000:
        vals = vals[:: vals.size // 3000 + 1]
    cl = density_clusters(vals, 0.15, 4)
    if not cl:
        return float(np.median(vals))
    near = cl[0][0]
    cand = [x for x in cl if x[0] - near < 700]  # nicht die Wand dahinter
    return float(cand[-1][0])


def choose(clusters, lo, hi, prefer):
    """Gruppe im Bereich [lo, hi]: prefer = 'near' (die nächste), 'far' (die fernste) oder eine Zahl (die nächste daran)."""
    c = [x for x in clusters if lo <= x[0] <= hi]
    if not c:
        return None
    if prefer == "near":
        return c[0]
    if prefer == "far":
        return c[-1]
    return min(c, key=lambda x: abs(x[0] - prefer))


class Measurement:
    """Ergebnis der Messung je aufgenommenem Frame (F Frames, 68 Gelenke)."""

    def __init__(self, F):
        self.cam = np.full((F, G.J, 3), np.nan)      # KAMERA-Punkte (Gelenkmitten), mm
        self.ray = np.full((F, G.J, 3), np.nan)      # Einheitsstrahlen der Keypoints
        self.zsurf = np.full((F, G.J), np.nan)       # gewählte Oberflächentiefe
        self.support = np.zeros((F, G.J))            # Anteil der Pixel der gewählten Gruppe
        self.conf2d = np.zeros((F, G.J))
        self.how = np.full((F, G.J), "-", dtype="<U1")
        self.torso_z = np.full(F, np.nan)
        self.clusters = [[None] * G.J for _ in range(F)]


def measure_frame(m, i, depth, kp, cam, fx):
    """Messung eines Frames: kp (68, 3) Hub-Pixel + Konfidenz."""
    ok = kp[:, 2] >= C_MIN
    m.conf2d[i] = np.where(ok, kp[:, 2], 0.0)
    if not ok.any():
        return
    r = cam.rays(kp[:, 0], kp[:, 1])
    rn = r / np.linalg.norm(r, axis=1, keepdims=True)
    m.ray[i][ok] = rn[ok]
    zt = torso_surface(depth, kp, fx)
    m.torso_z[i] = zt if zt is not None else np.nan
    zsel = {}

    def cl(j):
        zref = zt if zt is not None else 2000.0
        rad = int(np.clip(round(GROUP_K[G.GROUP[j]] * fx / max(zref, 500.0)), 1, 7))
        c, _ = window_clusters(depth, kp[j, 0], kp[j, 1], rad)
        m.clusters[i][j] = c
        return c

    def take(j, c):
        if c is None:
            return
        zsel[j] = c[0]
        m.zsurf[i, j] = c[0]
        m.support[i, j] = c[1]

    for name in G.ORDER:
        j = G.IDX[name]
        if not ok[j]:
            continue
        c = cl(j)
        if not c:
            continue
        grp = G.GROUP[j]
        parent = G.PARENT.get(name)
        pj = G.IDX[parent] if parent else None
        zp = zsel.get(pj) if pj is not None else None
        if grp == "torso":
            if zt is not None:
                if name.endswith("hip"):
                    take(j, choose(c, zt - 250, zt + 300, "far") or choose(c, zt - 400, zt + 400, zt))
                else:
                    take(j, choose(c, zt - 300, zt + 300, zt))
            else:
                take(j, max(c, key=lambda x: x[1]))
        elif grp == "face":
            ref = zt if zt is not None else None
            if ref is not None:
                take(j, choose(c, ref - 450, ref + 300, ref - 60))
            else:
                take(j, c[0])
        elif grp == "limb":
            ref = zp if zp is not None else zt
            if ref is None:
                take(j, c[0])
            elif name.endswith(("knee", "ankle")):
                # Beine: die große Gruppe nahe am Elternteil (davor hängen oft Ring oder Kabel: dünn, wenig Pixel)
                cc = [x for x in c if ref - 500 <= x[0] <= ref + 400]
                if cc:
                    take(j, max(cc, key=lambda x: x[1] * math.exp(-((x[0] - ref) / 350.0) ** 2)))
            else:
                # Arme: die nächste Gruppe mit genug Pixeln (Hände und Unterarme sind meist vor dem Körper)
                cc = [x for x in c if ref - 650 <= x[0] <= ref + 350]
                big = [x for x in cc if x[1] >= 0.2]
                take(j, (big or cc or [None])[0])
        elif grp == "hand":
            wj = G.IDX[name.split("_hand_")[0] + "_wrist"]
            ref = zsel.get(wj, zp)
            if ref is not None:
                take(j, choose(c, ref - 150, ref + 150, ref))
            else:
                take(j, c[0])
        elif grp == "foot":
            ref = zp if zp is not None else zt
            if ref is not None:
                take(j, choose(c, ref - 300, ref + 300, ref))
            else:
                take(j, c[0])
    for j, z in zsel.items():
        s = z + G.RADIUS[j] / rn[j, 2]  # Oberfläche + Abstand zur Gelenkmitte entlang der Sichtlinie (in z)
        m.cam[i, j] = rn[j] / rn[j, 2] * s
        m.how[i, j] = "D"
    # Handgelenk: COCO-Handgelenk und Hand-Handgelenk sind derselbe Punkt
    for side in ("left", "right"):
        a, b = G.IDX[f"{side}_wrist"], G.IDX[f"{side}_hand_wrist"]
        best = a if m.conf2d[i, a] >= m.conf2d[i, b] else b
        for x in (a, b):
            m.cam[i, x], m.ray[i, x], m.how[i, x] = m.cam[i, best], m.ray[i, best], m.how[i, best]
            m.zsurf[i, x], m.support[i, x], m.conf2d[i, x] = m.zsurf[i, best], m.support[i, best], m.conf2d[i, best]


# ---------------------------------------------------------------------------------------- links/rechts

SWAP_GROUPS = {
    "Beine": ["knee", "ankle", "big_toe", "small_toe", "heel"],
    "Arme": ["elbow", "wrist"] + [f"hand_{n}" for n in G.HAND[1:]],
}


def _swap(m, i, a, b):
    for arr in (m.cam, m.ray, m.zsurf, m.support, m.conf2d, m.how):
        tmp = arr[i, a].copy()
        arr[i, a] = arr[i, b]
        arr[i, b] = tmp
    ca, cb = m.clusters[i][a], m.clusters[i][b]
    m.clusters[i][a], m.clusters[i][b] = cb, ca


def fix_left_right(m, times, max_gap_s=0.5, history=6):
    """Vertauschte Seiten (das 2D-Modell nennt das linke Bein rechts, oft in der Seitenansicht): Frame für Frame mit
    den letzten, schon korrigierten Frames vergleichen (Median der letzten 6, damit ein schleichender Wechsel über
    ein paar Frames auch auffällt); passt die getauschte Zuordnung deutlich besser, wird getauscht. Beine und Arme
    getrennt. Gibt die Zahl der getauschten Frames je Gruppe."""
    import warnings
    F = m.cam.shape[0]
    out = {}
    for gname, parts in SWAP_GROUPS.items():
        L = [G.IDX[f"left_{p}"] for p in parts]
        R = [G.IDX[f"right_{p}"] for p in parts]
        hist = []  # (Zeit, links (n, 3), rechts (n, 3))
        n = 0
        for i in range(F):
            hist = [h for h in hist if times[i] - h[0] <= max_gap_s][-history:]
            okL = m.how[i, L] == "D"
            okR = m.how[i, R] == "D"
            if hist:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)
                    pl = np.nanmedian(np.stack([h[1] for h in hist]), axis=0)
                    pr = np.nanmedian(np.stack([h[2] for h in hist]), axis=0)
                use = okL & okR & np.isfinite(pl[:, 0]) & np.isfinite(pr[:, 0])
                if use.sum() >= 1:
                    cl, cr = m.cam[i, L][use], m.cam[i, R][use]
                    keep = np.linalg.norm(cl - pl[use], axis=1).sum() + np.linalg.norm(cr - pr[use], axis=1).sum()
                    swap = np.linalg.norm(cr - pl[use], axis=1).sum() + np.linalg.norm(cl - pr[use], axis=1).sum()
                    if swap < 0.5 * keep and keep - swap > 120.0 * use.sum():
                        for a, b in zip(L, R):
                            _swap(m, i, a, b)
                        n += 1
            okL = m.how[i, L] == "D"
            okR = m.how[i, R] == "D"
            if okL.any() or okR.any():
                hl = np.where(okL[:, None], m.cam[i, L], np.nan)
                hr = np.where(okR[:, None], m.cam[i, R], np.nan)
                hist.append((times[i], hl, hr))
        out[gname] = n
    return out


# ---------------------------------------------------------------------------------------- Knochen

def bone_lengths(cam, how, conf, prior=None):
    """Median-Länge je Knochen über Frames, in denen beide Enden aus der Tiefe kommen. prior: {"a-b": mm}."""
    out = {}
    for a, b in G.BONES:
        ia, ib = G.IDX[a], G.IDX[b]
        ok = (how[:, ia] == "D") & (how[:, ib] == "D") & (conf[:, ia] >= 0.5) & (conf[:, ib] >= 0.5)
        key = f"{a}-{b}"
        if ok.sum() >= 5:
            d = np.linalg.norm(cam[ok, ia] - cam[ok, ib], axis=1)
            out[key] = {"mm": float(np.median(d)), "n": int(ok.sum()), "spread": float(np.subtract(*np.percentile(d, [75, 25])))}
        if prior and key in prior:
            p = float(prior[key])
            if key not in out or abs(out[key]["mm"] - p) < 0.3 * p:
                out[key] = {"mm": p, "n": out.get(key, {}).get("n", 0), "spread": 0.0, "from": "kalibrierung"}
    # Symmetrie: fehlt eine Seite, die andere nehmen; weichen beide stark ab, den Mittelwert
    for key in list(out) + [f"{a}-{b}" for a, b in G.BONES]:
        a, b = key.split("-")
        mk = f"{G.mirror_name(a)}-{G.mirror_name(b)}"
        if key not in out and mk in out:
            out[key] = dict(out[mk], mirrored=True)
    return out


def solve_on_ray(ray, P, L, prefer_s=None):
    """Punkt s * ray (ray Einheitsvektor) mit |s ray - P| = L; zwei Lösungen: die nähere an prefer_s, sonst die
    mit der kleineren Tiefenänderung zum Elternteil. Trifft der Strahl die Kugel nicht: der nächste Punkt."""
    rp = float(ray @ P)
    disc = rp * rp - float(P @ P) + L * L
    if disc < 0:
        return ray * rp, False
    sq = math.sqrt(disc)
    s1, s2 = rp - sq, rp + sq
    if prefer_s is not None and np.isfinite(prefer_s):
        s = s1 if abs(s1 - prefer_s) <= abs(s2 - prefer_s) else s2
    else:
        s = s1 if abs(s1 * ray[2] - P[2]) <= abs(s2 * ray[2] - P[2]) else s2
    if s <= 100:
        s = max(s1, s2)
    return ray * s, True


def enforce_bones(m, bones, tol_rel=0.18, tol_abs=30.0):
    """Gelenke, deren Knochen zum (schon gesetzten) Elternteil nicht passt oder denen die Tiefe fehlt, auf ihrem
    Strahl mit der richtigen Länge setzen (how = B). Bearbeitung vom Rumpf nach außen."""
    F = m.cam.shape[0]
    fixed = 0
    # zeitliche Vorhersage der Tiefe je Gelenk (Median der gemessenen Tiefen in +-10 Frames)
    zmed = running_nanmedian(np.where(m.how == "D", np.linalg.norm(m.cam, axis=2), np.nan), 10)
    for i in range(F):
        # Schultern untereinander: passt die Breite nicht, die unsicherere Schulter nachführen
        a, b = G.IDX["left_shoulder"], G.IDX["right_shoulder"]
        L = bones.get("left_shoulder-right_shoulder", {}).get("mm")
        if L and m.how[i, a] == "D" and m.how[i, b] == "D":
            d = np.linalg.norm(m.cam[i, a] - m.cam[i, b])
            if abs(d - L) > max(tol_rel * L, tol_abs):
                worse = a if m.support[i, a] * m.conf2d[i, a] < m.support[i, b] * m.conf2d[i, b] else b
                other = b if worse == a else a
                p, okk = solve_on_ray(m.ray[i, worse], m.cam[i, other], L, zmed[i, worse])
                m.cam[i, worse] = p
                m.how[i, worse] = "B"
                fixed += 1
        for name in G.ORDER:
            parent = G.PARENT.get(name)
            if not parent:
                continue
            j, pj = G.IDX[name], G.IDX[parent]
            if m.how[i, pj] == "-" or not np.isfinite(m.ray[i, j, 0]):
                continue
            key = f"{parent}-{name}"
            L = bones.get(key, {}).get("mm")
            if not L:
                continue
            hand = G.GROUP[j] == "hand"
            tol = max(tol_rel * L, tol_abs if not hand else 12.0)
            if m.how[i, j] == "D":
                d = np.linalg.norm(m.cam[i, j] - m.cam[i, pj])
                if abs(d - L) <= tol:
                    continue
                # Passt die Länge nicht, aber die Tiefe springt nicht (verglichen mit den Frames ringsum), liegt es am
                # 2D-Punkt, nicht an der Tiefe: dann bleibt die Messung.
                zj = float(np.linalg.norm(m.cam[i, j]))
                if np.isfinite(zmed[i, j]) and abs(zj - zmed[i, j]) < (40.0 if hand else 80.0) and abs(d - L) < 0.5 * L:
                    continue
                prefer = zmed[i, j] if np.isfinite(zmed[i, j]) else zj
            else:
                prefer = zmed[i, j]
            p, okk = solve_on_ray(m.ray[i, j], m.cam[i, pj], L, prefer)
            m.cam[i, j] = p
            m.how[i, j] = "B"
            if not okk:
                m.conf2d[i, j] *= 0.6
            fixed += 1
        for side in ("left", "right"):
            a, b = G.IDX[f"{side}_wrist"], G.IDX[f"{side}_hand_wrist"]
            m.cam[i, b], m.how[i, b] = m.cam[i, a], m.how[i, a]
    return fixed


def face_fill(m):
    """Gesichtspunkte ohne Tiefe: auf ihrem Strahl in der Tiefe des Rumpfs minus 6 cm (how = B)."""
    for name in ("nose", "left_eye", "right_eye", "left_ear", "right_ear"):
        j = G.IDX[name]
        need = (m.how[:, j] == "-") & np.isfinite(m.ray[:, j, 0]) & np.isfinite(m.torso_z)
        for i in np.where(need)[0]:
            z = m.torso_z[i] - 60 + G.RADIUS[j]
            m.cam[i, j] = m.ray[i, j] / m.ray[i, j, 2] * z
            m.how[i, j] = "B"
            m.conf2d[i, j] *= 0.6


def running_nanmedian(x, half):
    """Laufender Median (je Spalte) über +-half Zeilen, NaN ignoriert."""
    F = x.shape[0]
    out = np.full_like(x, np.nan, dtype=np.float64)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for i in range(F):
            out[i] = np.nanmedian(x[max(0, i - half):i + half + 1], axis=0)
    return out


# ---------------------------------------------------------------------------------------- Zeit

BANDWIDTH = {"torso": 0.13, "limb": 0.11, "face": 0.15, "foot": 0.12, "hand": 0.10}
MAD_FLOOR = {"torso": 12.0, "limb": 15.0, "face": 12.0, "foot": 12.0, "hand": 8.0}


def local_quadratic(t_s, y, w, t_q, h, nbr):
    """Gewichtete lokale quadratische Regression: Stichproben (t_s, y (N, 3), w (N,)) ausgewertet an t_q (Q,),
    Tricube-Kern mit Halbbreite h (s). nbr: (Q, K) Indizes der Stichproben in der Nähe jedes t_q (-1 = keine).
    Gibt (Q, 3) Werte, (Q,) Gewichtssumme."""
    idx = np.where(nbr >= 0, nbr, 0)
    tau = t_s[idx] - t_q[:, None]
    k = np.clip(1 - np.abs(tau / h) ** 3, 0, None) ** 3
    ww = np.where(nbr >= 0, k * w[idx], 0.0)
    S = [np.sum(ww * tau ** p, axis=1) for p in range(5)]
    Y = y[idx]
    T = [np.sum((ww * tau ** p)[..., None] * Y, axis=1) for p in range(3)]
    A = np.stack([np.stack([S[0], S[1], S[2]], -1), np.stack([S[1], S[2], S[3]], -1), np.stack([S[2], S[3], S[4]], -1)], -2)
    B = np.stack(T, 1)  # (Q, 3 Momente, 3 Koordinaten)
    out = np.full((len(t_q), 3), np.nan)
    wsum = S[0]
    good = wsum > 1e-6
    # Regularisierung: wenig Stichproben -> lokal linear bzw. konstant
    reg = np.zeros_like(A)
    reg[:, 1, 1] = 1e-3 * (S[0] * h ** 2 + 1e-9)
    reg[:, 2, 2] = 1e-2 * (S[0] * h ** 4 + 1e-12)
    try:
        sol = np.linalg.solve(A[good] + reg[good], B[good])
        out[good] = sol[:, 0, :]
    except np.linalg.LinAlgError:
        out[good] = (T[0][good] / wsum[good, None])
    return out, wsum


def neighbours(t_s, t_q, h):
    """Indizes der Stichproben im Abstand < h um jeden Zeitpunkt (Q, K), -1 aufgefüllt."""
    lo = np.searchsorted(t_s, t_q - h, side="left")
    hi = np.searchsorted(t_s, t_q + h, side="right")
    K_ = int(max(1, (hi - lo).max())) if len(t_q) else 1
    nbr = lo[:, None] + np.arange(K_)[None, :]
    nbr = np.where(nbr < hi[:, None], nbr, -1)
    return nbr


def smooth_resample(times, P, how, conf, grid, max_gap=1.0, strength=1.0):
    """Je Gelenk: robuste lokale quadratische Regression der Messungen (times, P (F, J, 3), how, conf) auf das
    Raster grid (K,). Gibt (pos (K, J, 3), how (K, J), conf (K, J), outliers (J,) Anzahl verworfener Messungen,
    jitter (J,) robuste Streuung der Messungen um die Kurve in mm)."""
    F, J = how.shape
    Kn = len(grid)
    pos = np.full((Kn, J, 3), np.nan)
    how_out = np.full((Kn, J), "-", dtype="<U1")
    conf_out = np.zeros((Kn, J))
    outliers = np.zeros(J, int)
    jitter = np.full(J, np.nan)
    # zu jedem Rasterpunkt der nächste aufgenommene Frame (für how)
    nearest = np.clip(np.searchsorted(times, grid), 1, max(1, F - 1))
    nearest = np.where(np.abs(times[nearest - 1] - grid) <= np.abs(times[np.minimum(nearest, F - 1)] - grid),
                       nearest - 1, np.minimum(nearest, F - 1)) if F > 1 else np.zeros(Kn, int)
    near_dt = np.abs(times[nearest] - grid)
    for j in range(J):
        grp = G.GROUP[j]
        h = BANDWIDTH[grp] * strength
        valid = (how[:, j] != "-") & np.isfinite(P[:, j, 0])
        if valid.sum() < 2:
            continue
        ts = times[valid]
        ys = P[valid, j]
        ws = conf[valid, j] * np.array([HOW_FACTOR[c] for c in how[valid, j]])
        ws = np.maximum(ws, 1e-3)
        # zwei Durchgänge: Ausreißer-Gewichte aus den Residuen an den Stichproben selbst
        nb_s = neighbours(ts, ts, h)
        fit_s, _ = local_quadratic(ts, ys, ws, ts, h, nb_s)
        res = np.linalg.norm(ys - fit_s, axis=1)
        mad = max(MAD_FLOOR[grp], 1.4826 * float(np.nanmedian(res)))
        u = res / (6 * mad)
        rob = np.where(u < 1, (1 - u ** 2) ** 2, 0.0)
        bad = rob <= 0
        outliers[j] = int(bad.sum())
        ws2 = ws * rob
        fit_s2, _ = local_quadratic(ts, ys, ws2, ts, h, nb_s)
        good = ~bad
        if good.sum() >= 3:
            r2 = np.linalg.norm(ys[good] - fit_s2[good], axis=1)
            jitter[j] = float(1.4826 * np.median(r2))
        nb_q = neighbours(ts, grid, h)
        fit_q, wsum = local_quadratic(ts, ys, ws2, grid, h, nb_q)
        # Konfidenz am Rasterpunkt: kerngewichtetes Mittel der Konfidenzen
        idx = np.where(nb_q >= 0, nb_q, 0)
        k = np.clip(1 - np.abs((ts[idx] - grid[:, None]) / h) ** 3, 0, None) ** 3
        kk = np.where(nb_q >= 0, k * rob[idx], 0.0)
        cmean = np.where(kk.sum(1) > 0, (kk * ws[idx]).sum(1) / np.maximum(kk.sum(1), 1e-9), 0.0)
        # nur nahe an Messungen auswerten (nicht in Lücken hinein extrapolieren; die füllt unten die Interpolation)
        jn = np.clip(np.searchsorted(ts, grid), 0, len(ts) - 1)
        dist = np.minimum(np.abs(ts[jn] - grid), np.abs(ts[np.maximum(jn - 1, 0)] - grid))
        have = (wsum > 0.05) & np.isfinite(fit_q[:, 0]) & (dist <= 1.6 / 30)
        pos[have, j] = fit_q[have]
        conf_out[have, j] = np.clip(cmean[have], 0, 1)
        # how: der nächste aufgenommene Frame, falls nahe und dort gemessen und kein Ausreißer
        vi = np.full(F, -1)
        vi[np.where(valid)[0]] = np.arange(valid.sum())
        src = vi[nearest]
        flag = np.where((near_dt < 0.6 / 30) & (src >= 0), how[nearest, j], "I")
        isout = np.zeros(len(grid), bool)
        sel = src >= 0
        isout[sel] = bad[src[sel]]
        flag = np.where(isout, "I", flag)
        how_out[have, j] = flag[have]
        # Lücken: kubisch zwischen den Nachbarn füllen, wenn kurz genug
        gaps = ~have
        if gaps.any() and have.any():
            for g0, g1 in runs(gaps):
                left, right = g0 - 1, g1
                dur = (grid[min(g1, Kn - 1)] - grid[max(g0 - 1, 0)])
                if left >= 0 and right < Kn and have[left] and have[right] and dur <= max_gap:
                    span = grid[right] - grid[left]
                    a = (grid[g0:g1] - grid[left]) / span
                    # kubisch (Hermite) mit den Geschwindigkeiten an beiden Rändern, damit Bögen Bögen bleiben
                    v0 = (pos[left, j] - pos[left - 1, j]) / (grid[left] - grid[left - 1]) \
                        if left >= 1 and have[left - 1] else (pos[right, j] - pos[left, j]) / span
                    v1 = (pos[right + 1, j] - pos[right, j]) / (grid[right + 1] - grid[right]) \
                        if right + 1 < Kn and have[right + 1] else (pos[right, j] - pos[left, j]) / span
                    h00, h10 = 2 * a ** 3 - 3 * a ** 2 + 1, a ** 3 - 2 * a ** 2 + a
                    h01, h11 = -2 * a ** 3 + 3 * a ** 2, a ** 3 - a ** 2
                    pos[g0:g1, j] = (h00[:, None] * pos[left, j] + (h10 * span)[:, None] * v0
                                     + h01[:, None] * pos[right, j] + (h11 * span)[:, None] * v1)
                    decay = np.exp(-np.minimum(a, 1 - a) * dur / 0.5)
                    conf_out[g0:g1, j] = min(conf_out[left, j], conf_out[right, j]) * HOW_FACTOR["I"] * decay
                    how_out[g0:g1, j] = "I"
                elif (left < 0 or right >= Kn) and (grid[g1 - 1] - grid[g0]) <= 0.2:
                    ref = right if left < 0 else left
                    if 0 <= ref < Kn and have[ref]:
                        pos[g0:g1, j] = pos[ref, j]
                        conf_out[g0:g1, j] = conf_out[ref, j] * 0.3
                        how_out[g0:g1, j] = "I"
        conf_out[:, j] *= np.array([HOW_FACTOR[c] for c in how_out[:, j]])
    return pos, how_out, conf_out, outliers, jitter


def runs(mask):
    """(start, ende) der zusammenhängenden True-Bereiche."""
    m = np.concatenate([[False], np.asarray(mask, bool), [False]])
    d = np.diff(m.astype(int))
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def derive(pos, how, conf):
    """Abgeleitete Gelenke (FORMAT.md): pelvis = Mitte der Hüften, neck = Mitte der Schultern, 0,11 Schulterbreiten
    zum Kopf hin (entlang Becken -> Schultern), head = Mitte der Ohren (sonst Mitte der Augen 8 cm nach hinten)."""
    I = G.IDX
    ls, rs, lh, rh = pos[:, I["left_shoulder"]], pos[:, I["right_shoulder"]], pos[:, I["left_hip"]], pos[:, I["right_hip"]]

    def put(name, p, srcs):
        j = I[name]
        ok = np.isfinite(p[:, 0])
        pos[ok, j] = p[ok]
        hs = np.stack([how[:, I[s]] for s in srcs], 1)
        cs = np.stack([conf[:, I[s]] for s in srcs], 1)
        worst = np.where((hs == "-").any(1), "-", np.where((hs == "I").any(1), "I", np.where((hs == "B").any(1), "B", "D")))
        how[ok, j] = worst[ok]
        conf[ok, j] = cs.min(1)[ok]
        how[~ok, j] = "-"
        conf[~ok, j] = 0

    pel = (lh + rh) / 2
    put("pelvis", pel, ["left_hip", "right_hip"])
    ms = (ls + rs) / 2
    up = ms - pel
    upn = up / np.maximum(np.linalg.norm(up, axis=1, keepdims=True), 1e-6)
    sw = np.linalg.norm(ls - rs, axis=1, keepdims=True)
    up_fallback = np.array([0.0, 1.0, 0.0])
    upn = np.where(np.isfinite(upn), upn, up_fallback)
    put("neck", ms + 0.11 * sw * upn, ["left_shoulder", "right_shoulder"])
    le, re_ = pos[:, I["left_ear"]], pos[:, I["right_ear"]]
    head = (le + re_) / 2
    eyes = (pos[:, I["left_eye"]] + pos[:, I["right_eye"]]) / 2
    put("head", head, ["left_ear", "right_ear"])
    j = I["head"]
    miss = ~np.isfinite(head[:, 0]) & np.isfinite(eyes[:, 0]) & np.isfinite(ms[:, 0])
    if miss.any():
        # Augen 8 cm nach hinten (weg von der Blickrichtung ~ von der Kamera weg, -z in der WELT)
        pos[miss, j] = eyes[miss] + np.array([0.0, 0.0, -80.0])
        how[miss, j] = "B"
        conf[miss, j] = 0.3 * np.minimum(conf[miss, I["left_eye"]], conf[miss, I["right_eye"]])
    for side in ("left", "right"):
        a, b = I[f"{side}_wrist"], I[f"{side}_hand_wrist"]
        use = np.where((conf[:, b] > conf[:, a])[:, None], pos[:, b], pos[:, a])
        hw = np.where(conf[:, b] > conf[:, a], how[:, b], how[:, a])
        cw = np.maximum(conf[:, a], conf[:, b])
        for x in (a, b):
            pos[:, x], how[:, x], conf[:, x] = use, hw, cw
    return pos, how, conf


def interpolate_2d(kp, computed, max_span):
    """2D-Keypoints (F, 68, 3) nur in den Frames `computed` bekannt: linear dazwischen (Konfidenz x 0,8),
    wenn beide Nachbarn den Punkt kennen und höchstens max_span Frames auseinander liegen."""
    out = kp.copy()
    comp = np.array(sorted(computed))
    if len(comp) < 2:
        return out
    for a, b in zip(comp[:-1], comp[1:]):
        if b - a <= 1 or b - a > max_span:
            continue
        ka, kb = kp[a], kp[b]
        both = (ka[:, 2] >= C_MIN) & (kb[:, 2] >= C_MIN)
        for i in range(a + 1, b):
            s = (i - a) / (b - a)
            out[i, both, :2] = ka[both, :2] + s * (kb[both, :2] - ka[both, :2])
            out[i, both, 2] = 0.8 * np.minimum(ka[both, 2], kb[both, 2])
    return out


def to_world(world, cam_pts):
    out = np.full(cam_pts.shape, np.nan)
    ok = np.isfinite(cam_pts[..., 0])
    out[ok] = K.apply(world, cam_pts[ok])
    return out
