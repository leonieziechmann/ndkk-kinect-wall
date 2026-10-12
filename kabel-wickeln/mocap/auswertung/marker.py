"""Klatschen (Sync), Beginn und Ende der Aktion.

Klatschen: Die Hände kommen schnell zusammen und treffen sich vor der Brust. Gesucht wird ein Minimum des
Abstands der Handmitten (middle_mcp, sonst Handgelenke) unter 15 cm (Handgelenke 21 cm), 0,3 s davor mindestens
doppelt so weit, davor eine
Annäherung mit mindestens 0,6 m/s, auf Höhe zwischen Hüfte und Schulter (+ 20 cm). Gibt es das Startsignal des
Aufnahme-Tools (sitzung.json: signal_in_recording_s), wird ab 0,3 s davor bis 3 s danach gesucht, sonst in den ersten
4-8 s (40 % der Aufnahme). Zweites Merkmal (für verdeckte Hände, z. B. Kinect seitlich): beide Hände schnell und dann
plötzlich still, nah beieinander. Gewählt wird das früheste Ereignis; die Zeit wird zwischen den Frames verfeinert.

Beginn/Ende (Näherung): Bewegung = Mittel der drei schnellsten Körpergelenke. Nach dem Klatschen kommt laut Plan
eine ruhige Sekunde; Beginn = erstes Mal danach für 0,2 s über der Schwelle, Ende = letztes Mal darüber (danach
die Endpose). Schwelle = max(0,08 m/s, 3 x 10-%-Quantil). Eine ruhige Pose als Aktion (T-Pose) erkennt das nicht.
"""

import numpy as np

from . import gelenke as G

MOVE = [G.IDX[n] for n in ("left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
                           "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle")]


def hand_centres(pos, conf):
    I = G.IDX
    out, use_mcp = [], []
    for side in ("left", "right"):
        mcp, wr = pos[:, I[f"{side}_hand_middle_mcp"]], pos[:, I[f"{side}_wrist"]]
        good = (conf[:, I[f"{side}_hand_middle_mcp"]] >= 0.3) & np.isfinite(mcp[:, 0])
        out.append(np.where(good[:, None], mcp, wr))
        use_mcp.append(good)
    return out[0], out[1], use_mcp[0] & use_mcp[1]


def find_clap(times, pos, conf, signal_s=None, search_end_s=None):
    """times (K,), pos (K, 68, 3) WELT mm, conf (K, 68). -> dict(time, frame, gap_mm, speed_m_s, score, searched) oder None."""
    I = G.IDX
    lc, rc, mcp = hand_centres(pos, conf)
    d = np.linalg.norm(lc - rc, axis=1)
    lw, rw = I["left_wrist"], I["right_wrist"]
    ok = (conf[:, lw] > 0.1) & (conf[:, rw] > 0.1) & np.isfinite(d)
    K = len(times)
    if K < 5:
        return None
    if signal_s is not None:
        lo, hi = signal_s - 0.3, signal_s + 3.0
        searched = f"{lo:.1f}–{hi:.1f} s (Startsignal bei {signal_s:.2f} s)"
    else:
        # ohne Startsignal: das Aufnahme-Tool hat 2 s Vorlauf, von Hand gestartete Aufnahmen etwas mehr
        lo = times[0]
        hi = search_end_s if search_end_s is not None else times[0] + min(8.0, max(4.0, 0.4 * (times[-1] - times[0])))
        searched = f"{lo:.1f}–{hi:.1f} s (ohne Startsignal)"
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        sh_y = np.nanmean(pos[:, [I["left_shoulder"], I["right_shoulder"]], 1], axis=1)
        hp_y = np.nanmean(pos[:, [I["left_hip"], I["right_hip"]], 1], axis=1)
    mid_y = (lc[:, 1] + rc[:, 1]) / 2
    cands = []
    for k in range(2, K - 2):
        if not (lo <= times[k] <= hi) or not ok[k]:
            continue
        if not (d[k] <= d[k - 1] and d[k] <= d[k + 1]):
            continue
        limit = 150.0 if mcp[k] else 210.0
        if d[k] > limit:
            continue
        # ein deutliches Tal: 0,35 s vorher mindestens doppelt so weit auseinander
        before = np.where((times >= times[k] - 0.4) & (times <= times[k] - 0.25) & ok)[0]
        if len(before) and np.nanmax(d[before]) < 1.8 * d[k]:
            continue
        # Annäherung in den 0,35 s davor
        back = np.where((times >= times[k] - 0.35) & (times < times[k]) & ok)[0]
        if len(back) < 2:
            continue
        speeds = -(np.diff(d[back[0]:k + 1]) / np.maximum(np.diff(times[back[0]:k + 1]), 1e-3)) / 1000.0
        vmax = float(np.nanmax(speeds)) if len(speeds) else 0.0
        if vmax < 0.6:
            continue
        height_ok = True
        if np.isfinite(sh_y[k]) and np.isfinite(hp_y[k]):
            height_ok = hp_y[k] - 50 <= mid_y[k] <= sh_y[k] + 200
        if not height_ok:
            continue
        score = vmax * (1.2 - d[k] / 300.0)
        # Zeit zwischen den Frames: Parabel durch die drei Abstände
        a, b, c = d[k - 1], d[k], d[k + 1]
        den = a - 2 * b + c
        off = 0.5 * (a - c) / den if den > 1e-6 else 0.0
        off = float(np.clip(off, -0.5, 0.5))
        t = times[k] + off * (times[k + 1] - times[k - 1]) / 2
        cands.append({"time": round(float(t), 3), "frame": int(k), "gap_mm": round(float(d[k])), "speed_m_s": round(vmax, 2),
                      "height_ok": bool(height_ok), "score": round(float(score), 3)})
    for c in cands:
        c["method"] = "abstand"
    cands += stop_candidates(times, pos, conf, lo, hi, sh_y, hp_y)
    if not cands:
        return {"time": None, "searched": searched, "candidates": []}
    best = min(cands, key=lambda c: c["time"])
    best = dict(best, searched=searched, candidates=len(cands))
    return best


def stop_candidates(times, pos, conf, lo, hi, sh_y, hp_y):
    """Zweites Merkmal: beide Hände schnell (>= 0,7 m/s in den 0,25 s davor) und dann plötzlich fast still (<= 35 %),
    nah beieinander (< 25 cm) auf Brusthöhe. Hilft, wenn die Hände sich im Bild verdecken (Kinect seitlich: das
    Modell setzt die verdeckte Hand oft auf die sichtbare, dann gibt es kein Abstandsminimum)."""
    I = G.IDX
    lw, rw = pos[:, I["left_wrist"]], pos[:, I["right_wrist"]]
    ok = (conf[:, I["left_wrist"]] > 0.1) & (conf[:, I["right_wrist"]] > 0.1)
    if len(times) < 5:
        return []
    vl = np.linalg.norm(np.gradient(lw, times, axis=0), axis=1) / 1000.0
    vr = np.linalg.norm(np.gradient(rw, times, axis=0), axis=1) / 1000.0
    d = np.linalg.norm(lw - rw, axis=1)
    mid_y = (lw[:, 1] + rw[:, 1]) / 2
    out = []
    for k in range(2, len(times) - 2):
        if not (lo <= times[k] <= hi) or not ok[k] or not np.isfinite(d[k]) or d[k] > 250:
            continue
        s = vl[k] + vr[k]
        if not (s <= vl[k - 1] + vr[k - 1] and s <= vl[k + 1] + vr[k + 1]):
            continue
        back = (times >= times[k] - 0.25) & (times <= times[k] - 0.05)
        if not back.any():
            continue
        ml, mr = float(np.nanmax(vl[back])), float(np.nanmax(vr[back]))
        if min(ml, mr) < 0.7 or vl[k] > 0.35 * ml or vr[k] > 0.35 * mr:
            continue
        if np.isfinite(sh_y[k]) and np.isfinite(hp_y[k]) and not (hp_y[k] - 50 <= mid_y[k] <= sh_y[k] + 200):
            continue
        out.append({"time": round(float(times[k]), 3), "frame": int(k), "gap_mm": round(float(d[k])),
                    "speed_m_s": round(min(ml, mr), 2), "height_ok": True, "score": round(min(ml, mr), 3), "method": "stopp"})
    return out


def activity(times, pos, conf):
    """Bewegung (m/s) je Rasterpunkt: Mittel der drei schnellsten Körpergelenke, über 0,2 s gemittelt (beim Wickeln
    bewegen sich vor allem die Hände; ein Mittel über alle Gelenke würde das verwischen)."""
    P = pos[:, MOVE]
    v = np.linalg.norm(np.gradient(P, times, axis=0), axis=2) / 1000.0
    v = np.where((conf[:, MOVE] > 0.2) & np.isfinite(v), v, 0.0)
    top = np.sort(v, axis=1)[:, -3:].mean(1)
    k = max(1, int(round(0.2 / max(np.median(np.diff(times)), 1e-3))))
    return np.convolve(top, np.ones(k) / k, mode="same")


def start_end(times, pos, conf, clap_t):
    """Beginn und Ende der Aktion. Nach dem Klatschen kommen die Hände zur Ruhe (laut Plan 1 s still); Beginn = das
    erste Mal danach, dass die Bewegung für 0,2 s über der Schwelle liegt. Kommt keine Ruhe innerhalb 1,3 s, beginnt
    die Aktion direkt (Klatschen + 0,3 s). Ende = das letzte Mal über der Schwelle (danach die Endpose)."""
    a = activity(times, pos, conf)
    if not len(a):
        return None, None, {}
    still = float(np.percentile(a, 10))
    thr = max(0.08, 3.0 * still)
    dt = float(np.median(np.diff(times))) if len(times) > 1 else 1 / 30
    hold = max(1, int(round(0.2 / dt)))
    above = a > thr
    sustained = np.convolve(above.astype(float), np.ones(hold), mode="same") >= hold - 0.5
    info = {"threshold_m_s": round(thr, 3), "still_m_s": round(still, 3)}
    t0 = clap_t if clap_t is not None else times[0]
    if clap_t is not None:
        calm = np.where((times > clap_t + 0.1) & (times <= clap_t + 1.3) & (a < max(thr, 0.12)))[0]
        if len(calm):
            after = np.where((times > times[calm[0]]) & sustained)[0]
            start_i = after[0] - hold // 2 if len(after) else None
        else:
            start_i = int(np.searchsorted(times, clap_t + 0.3))
            info["no_rest_after_clap"] = True
    else:
        after = np.where(sustained)[0]
        start_i = after[0] - hold // 2 if len(after) else None
    tail = np.where((times > t0) & sustained)[0]
    if start_i is None or not len(tail):
        return None, None, info
    start = float(times[int(np.clip(start_i, 0, len(times) - 1))])
    end = float(times[min(len(times) - 1, tail[-1] + hold // 2)])
    return round(start, 3), round(max(end, start), 3), info
