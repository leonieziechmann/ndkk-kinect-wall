"""Vergleich eines ausgewerteten Takes mit der Wahrheit einer synthetischen Aufnahme (<name>.truth.json.gz).

- mpjpe(): mittlerer 3D-Fehler (mm) je Gelenk und für Gruppen, getrennt nach sichtbaren und verdeckten Gelenken
  (visible_codes der Wahrheit), dazu Median und 90 %.
- truth_kp2d(): ein kp2d-Dokument aus den wahren Pixeln (uv_values) der Wahrheit. Damit lässt sich die 3D-Kette
  (Tiefe, Strahl, Boden, WELT, Knochen, Glättung) ohne die Fehler eines 2D-Modells prüfen.
- cable_scores(): wie gut das gefundene Kabel das wahre trifft (2D und 3D).
"""

import gzip
import json
from pathlib import Path

import numpy as np

from . import gelenke as G
from . import kamera as K
from . import take as T

BODY = list(range(17))
GROUPS = {
    "Körper (COCO 17)": BODY,
    "Rumpf (Schultern, Hüften)": [G.IDX[n] for n in ("left_shoulder", "right_shoulder", "left_hip", "right_hip")],
    "Arme (Ellbogen, Handgelenke)": [G.IDX[n] for n in ("left_elbow", "right_elbow", "left_wrist", "right_wrist")],
    "Beine (Knie, Knöchel)": [G.IDX[n] for n in ("left_knee", "right_knee", "left_ankle", "right_ankle")],
    "Gesicht": [G.IDX[n] for n in ("nose", "left_eye", "right_eye", "left_ear", "right_ear")],
    "Füße": [G.IDX[n] for n in G.FEET],
    "Hände (42)": [j for j, n in enumerate(G.JOINTS) if "_hand_" in n],
    "abgeleitet (pelvis, neck, head)": [G.IDX[n] for n in G.EXTRA],
}


def load_truth(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def truth_path_for(rec_path):
    p = Path(rec_path)
    return p.with_name(p.name.replace(".k2rec", ".truth.json.gz"))


def truth_kp2d(truth, only_visible=True, noise_px=0.0, seed=0):
    """kp2d aus den wahren Pixeln: Konfidenz 1 für sichtbare Gelenke (mit only_visible=False auch verdeckte,
    Konfidenz 0,6). noise_px: Gaußsches Rauschen auf die Pixel (Test der Robustheit)."""
    rng = np.random.default_rng(seed)
    F = truth["frames"]
    uv = np.array(truth["truth"]["uv_values"], float).reshape(F, -1, 2)
    vis = np.array([list(s) for s in truth["truth"]["visible_codes"]])
    kps, frames, boxes = [], [], []
    for i in range(F):
        kp = np.zeros((G.J, 3))
        kp[:, :2] = uv[i] + (rng.normal(0, noise_px, uv[i].shape) if noise_px else 0)
        conf = np.where(vis[i] == "v", 1.0, np.where(vis[i] == "o", 0.0 if only_visible else 0.6, 0.0))
        conf[[G.IDX[n] for n in G.EXTRA]] = 0.0  # abgeleitete Punkte liefert kein Modell
        kp[:, 2] = conf
        ok = conf > 0
        if not ok.any():
            continue
        x0, y0 = kp[ok, :2].min(0)
        x1, y1 = kp[ok, :2].max(0)
        frames.append(i)
        boxes.append([float(x0), float(y0), float(x1), float(y1)])
        kps.append([round(float(v), 3) for v in kp.reshape(-1)])
    return {"format": "kabel-wickeln-kp2d", "version": 1, "source": truth["source"], "frames": F,
            "computed": list(range(F)), "every": 1, "flip": False,
            "models": {"detector": "truth-uv" + ("" if only_visible else "+hidden"), "topdown": [], "device": "-"},
            "joints": G.JOINTS, "provided": list(range(65)),
            "persons": [{"id": 1, "frames": frames, "box": boxes, "score": [1.0] * len(frames), "kp": kps}]}


def align(take_doc, truth):
    """Frame-Paare (Take-Index, Wahrheit-Index) über die Zeit."""
    tt, _, _, _ = T.arrays(take_doc)
    tr = truth["t"]
    if isinstance(tr, list):
        ttr = np.array(tr, float)
    else:
        ttr = tr["t0"] + tr["dt"] * np.arange(truth["frames"])
    idx = np.clip(np.searchsorted(ttr, tt), 0, len(ttr) - 1)
    prev = np.maximum(idx - 1, 0)
    idx = np.where(np.abs(ttr[prev] - tt) < np.abs(ttr[idx] - tt), prev, idx)
    ok = np.abs(ttr[idx] - tt) < 0.5 / 30
    return np.where(ok)[0], idx[ok]


def mpjpe(take_doc, truth, frames=None):
    """dict: je Gelenk {"vis": [Fehler], "occ": [Fehler]} und eine Zusammenfassung je Gruppe."""
    _, pos, how, conf = T.arrays(take_doc)
    ka, kt = align(take_doc, truth)
    if frames is not None:
        sel = np.isin(kt, frames)
        ka, kt = ka[sel], kt[sel]
    tp = np.array(truth["pos"], float).reshape(truth["frames"], -1, 3)
    vis = np.array([list(s) for s in truth["truth"]["visible_codes"]])
    per = {}
    for j, n in enumerate(G.JOINTS):
        e = np.linalg.norm(pos[ka, j] - tp[kt, j], axis=1)
        have = np.isfinite(e)
        v = vis[kt, j]
        per[n] = {"vis": e[have & (v == "v")], "occ": e[have & (v == "o")], "missing": int((~have).sum()),
                  "how": how[ka, j]}
    return per


def summarize(per):
    rows = []
    for gname, idx in GROUPS.items():
        ev = np.concatenate([per[G.JOINTS[j]]["vis"] for j in idx])
        eo = np.concatenate([per[G.JOINTS[j]]["occ"] for j in idx])
        rows.append((gname, ev, eo))
    return rows


def fmt_stats(e):
    if not len(e):
        return "      –        –        –      0"
    return f"{np.mean(e):7.0f}  {np.median(e):7.0f}  {np.percentile(e, 90):7.0f}  {len(e):5d}"


def report(per, title=""):
    out = [title] if title else []
    out.append("  Gruppe                              sichtbar: Mittel  Median   90 %   Anzahl | verdeckt: Mittel  Median   90 %   Anzahl")
    for gname, ev, eo in summarize(per):
        out.append(f"  {gname:35s} {fmt_stats(ev)} | {fmt_stats(eo)}")
    out.append("  je Gelenk (sichtbar, mm):  " + "  ".join(
        f"{n} {np.mean(per[n]['vis']):.0f}" for n in G.JOINTS[:17] if len(per[n]["vis"])))
    return "\n".join(out)


def project_truth_cable(truth, i):
    """Wahre Kabelpunkte (N, 3) WELT und ihre Hub-Pixel in Frame i."""
    m = np.array(truth["world"]["cam_to_world"], float).reshape(4, 4)
    to_cam = K.invert(m)
    pts = [np.array(ln["pts"], float).reshape(-1, 3) for ln in truth["cable"][i]]
    if not pts:
        return np.zeros((0, 3)), np.zeros((0, 2))
    p = np.concatenate(pts)
    pc = K.apply(to_cam, p)
    u, v = K.project_params(truth["camera"], pc)
    return p, np.stack([u, v], 1)


def cable_scores(take_doc, truth, cam, near_mm=600.0):
    """Recall: Anteil der wahren Kabelpunkte nahe einer Hand (< near_mm), die ein gefundener Punkt in < 6 px trifft;
    Precision: Anteil der gefundenen Punkte, die in < 6 px am wahren Kabel liegen; 3D-Abstand der Treffer (mm)."""
    ka, kt = align(take_doc, truth)
    to_cam = K.invert(np.array(take_doc["world"]["cam_to_world"], float).reshape(4, 4))
    tp = np.array(truth["pos"], float).reshape(truth["frames"], -1, 3)
    hands = [G.IDX["left_wrist"], G.IDX["right_wrist"]]
    rec_hit = rec_all = prec_hit = prec_all = 0
    d3 = []
    for a, b in zip(ka, kt):
        found = take_doc["cable"][a] if take_doc.get("cable") else []
        tw, tuv = project_truth_cable(truth, b)
        if not len(tw):
            continue
        near = np.min(np.linalg.norm(tw[:, None, :] - tp[b, hands][None], axis=2), axis=1) < near_mm
        inside = (tuv[:, 0] >= 0) & (tuv[:, 0] < 512) & (tuv[:, 1] >= 0) & (tuv[:, 1] < 424)
        sel = near & inside
        fw = np.concatenate([np.array(ln["pts"], float).reshape(-1, 3) for ln in found]) if found else np.zeros((0, 3))
        if len(fw):
            fu, fv = cam.project(K.apply(to_cam, fw))
            fuv = np.stack([fu, fv], 1)
        else:
            fuv = np.zeros((0, 2))
        rec_all += int(sel.sum())
        if len(fuv) and sel.any():
            dd = np.linalg.norm(tuv[sel][:, None] - fuv[None], axis=2)
            rec_hit += int((dd.min(1) < 6).sum())
        prec_all += len(fuv)
        if len(fuv):
            dd = np.linalg.norm(fuv[:, None] - tuv[None], axis=2)
            hit = dd.min(1) < 6
            prec_hit += int(hit.sum())
            if hit.any():
                j = dd.argmin(1)
                d3 += list(np.linalg.norm(fw[hit] - tw[j[hit]], axis=1))
    return {"recall": rec_hit / max(1, rec_all), "precision": prec_hit / max(1, prec_all),
            "found_points": prec_all, "truth_points": rec_all,
            "d3_median_mm": float(np.median(d3)) if d3 else None, "d3_p90_mm": float(np.percentile(d3, 90)) if d3 else None}
