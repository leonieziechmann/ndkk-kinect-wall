"""Hände: Koordinatensystem je Hand und Krümmung der Finger, aus den 3D-Handpunkten (WELT).

Handsystem (FORMAT.md, Block `hands`): Ursprung im Handgelenk;
  x = vom Handgelenk zum Mittelfinger-Grundgelenk (middle_mcp), entlang der Hand;
  y = zur Daumenseite (index_mcp - pinky_mcp, senkrecht zu x gemacht);
  z = aus dem Handrücken heraus (rechte Hand: x × y, linke Hand: y × x).
Liegt die Handfläche oben, zeigt z nach unten (z_y < 0).
Krümmung je Finger 0 (gestreckt) ... 1 (Faust): Summe der Beugewinkel an den drei Gelenken (MCP: Mittelhand
zu Grundglied, PIP, DIP; Spreizen zählt nicht), geteilt durch 270°; Daumen: Winkel an MCP und IP, geteilt durch 150°.
"""

import numpy as np

from . import gelenke as G

FINGERS = ["thumb", "index", "middle", "ring", "pinky"]
MAX_BEND = {"thumb": 150.0, "index": 270.0, "middle": 270.0, "ring": 270.0, "pinky": 270.0}
LOW = 0.4  # unter dieser Konfidenz gilt die Hand als unsicher


def chain(side, finger):
    if finger == "thumb":
        names = ["wrist", "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip"]
    else:
        names = ["wrist"] + [f"{finger}_{p}" for p in ("mcp", "pip", "dip", "tip")]
    return [G.IDX[f"{side}_hand_{n}"] for n in names]


def _unit(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return np.where(n > 1e-6, v / np.maximum(n, 1e-6), np.nan)


def hand_frames(pos, conf, side):
    """pos (K, 68, 3) WELT mm, conf (K, 68) 0..1 -> origin (K, 3), axes (K, 3, 3) (Zeilen x, y, z), curl (K, 5),
    conf (K,). Fehlende Hände: NaN."""
    I = G.IDX
    w, im, mm, pm = (pos[:, I[f"{side}_hand_{n}"]] for n in ("wrist", "index_mcp", "middle_mcp", "pinky_mcp"))
    x = _unit(mm - w)
    y0 = im - pm
    y = _unit(y0 - np.sum(y0 * x, axis=1, keepdims=True) * x)
    z = np.cross(x, y) if side == "right" else np.cross(y, x)
    axes = np.stack([x, y, z], 1)
    cs = np.stack([conf[:, I[f"{side}_hand_{n}"]] for n in ("wrist", "index_mcp", "middle_mcp", "pinky_mcp")], 1)
    hconf = cs.min(1)
    curl = np.full((len(pos), 5), np.nan)
    for f, finger in enumerate(FINGERS):
        ch = chain(side, finger)
        segs = [pos[:, ch[k + 1]] - pos[:, ch[k]] for k in range(len(ch) - 1)]
        start = 1  # Winkel an den Gelenken nach dem ersten Segment (Daumen: CMC-MCP, MCP-IP, IP-Tip)
        if finger != "thumb":
            start = 0  # Finger: Mittelhand (wrist->mcp) zu Grundglied, dann PIP, DIP
        if finger != "thumb":
            # nur die Beugung zählt, nicht das Spreizen: Segmente ohne ihren Anteil entlang y (zur Daumenseite)
            segs = [sg - np.sum(sg * y, axis=1, keepdims=True) * y for sg in segs]
        ang = 0.0
        for k in range(start, len(segs) - 1):
            a, b = _unit(segs[k]), _unit(segs[k + 1])
            ang = ang + np.degrees(np.arccos(np.clip(np.sum(a * b, axis=1), -1, 1)))
        curl[:, f] = np.clip(ang / MAX_BEND[finger], 0, 1)
        fc = np.stack([conf[:, c] for c in ch[1:]], 1).min(1)
        curl[fc <= 0, f] = np.nan
    return w, axes, curl, hconf


def hands_block(pos, conf):
    """Block `hands` des Take-Formats: je Frame {"left": {...} | null, "right": ...}."""
    out = []
    per = {}
    for side in ("left", "right"):
        per[side] = hand_frames(pos, conf, side)
    for k in range(len(pos)):
        fr = {}
        for side in ("left", "right"):
            o, ax, cu, hc = (a[k] for a in per[side])
            if not np.all(np.isfinite(ax)) or hc <= 0:
                fr[side] = None
                continue
            fr[side] = {"origin": [int(round(v)) for v in o],
                        "axes": [int(round(v * 1000)) for v in ax.reshape(-1)],
                        "curl": [None if not np.isfinite(c) else int(round(c * 100)) for c in cu],
                        "conf": int(round(float(hc) * 100)),
                        "low": bool(hc < LOW)}
        out.append(fr)
    return out
