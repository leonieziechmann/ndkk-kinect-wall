"""Die Hauptperson (und bei Bedarf weitere) über alle Frames verfolgen: stabile IDs.

1. Spuren bilden: Frame für Frame jede Person dem passendsten Kasten der vorigen Frames zuordnen (IoU, Abstand
   der Mitten), Lücken bis 1 s überbrücken.
2. Hauptperson = die Spur mit dem größten Gewicht: Summe über ihre Frames von Sicherheit x Größe x Nähe zur
   Bildmitte (x Nähe zur Kinect, wenn die Tiefe bekannt ist).
3. Lücken der Hauptspur füllen: In Frames ohne ihre Person gehört ein Kasten zu ihr, der zum letzten bekannten
   Kasten passt (z. B. nach einer Verdeckung, die die Spur zerrissen hat).
"""

import numpy as np

from .modelle import iou

W, H = 512, 424


def _center(b):
    return np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])


def _diag(b):
    return float(np.hypot(b[2] - b[0], b[3] - b[1]))


def _match(a, b):
    """Ähnlichkeit zweier Kästen 0 ... 1 (0 = gehören nicht zusammen)."""
    v = iou(a, b)
    d = np.linalg.norm(_center(a) - _center(b)) / max(1.0, 0.5 * (_diag(a) + _diag(b)))
    if v < 0.2 and d > 0.35:
        return 0.0
    return max(v, 1.0 - d / 0.35 * 0.8 if d < 0.35 else 0.0)


def build_tracks(dets, frames, max_gap=30):
    """dets: {frame: [ {box, score, kp} ]}; frames: sortierte Frame-Nummern. -> Liste von Spuren {frame: det-Index}."""
    tracks = []  # je Spur: {"items": {frame: k}, "last": frame, "box": box}
    for f in frames:
        persons = dets.get(f, [])
        pairs = []
        for t_i, t in enumerate(tracks):
            if f - t["last"] > max_gap:
                continue
            for k, p in enumerate(persons):
                s = _match(t["box"], p["box"])
                if s > 0:
                    pairs.append((s, t_i, k))
        pairs.sort(key=lambda x: -x[0])
        used_t, used_p = set(), set()
        for s, t_i, k in pairs:
            if t_i in used_t or k in used_p:
                continue
            used_t.add(t_i)
            used_p.add(k)
            t = tracks[t_i]
            t["items"][f] = k
            t["last"] = f
            t["box"] = persons[k]["box"]
        for k, p in enumerate(persons):
            if k not in used_p:
                tracks.append({"items": {f: k}, "last": f, "box": p["box"]})
    return [t["items"] for t in tracks]


def track_weight(items, dets, depth_of=None):
    w = 0.0
    for f, k in items.items():
        p = dets[f][k]
        b = p["box"]
        area = max(1.0, (b[2] - b[0]) * (b[3] - b[1])) / (W * H)
        cx = (b[0] + b[2]) / 2
        central = 1.0 - 0.6 * abs(cx - W / 2) / (W / 2)
        near = 1.0
        if depth_of is not None:
            z = depth_of(f, b)
            if z:
                near = float(np.clip(2500.0 / z, 0.4, 2.5))
        sure = float(np.mean(p["kp"][:17, 2] > 0.5))
        w += p["score"] * np.sqrt(area) * central * near * (0.5 + sure)
    return w


def select_persons(dets, frames, n=1, depth_of=None):
    """Die n wichtigsten Personen: Liste (je Person) von {frame: Person-dict}; Personen nach Gewicht sortiert."""
    tracks = build_tracks(dets, frames)
    if not tracks:
        return [{} for _ in range(n)]
    weights = [track_weight(t, dets, depth_of) for t in tracks]
    order = list(np.argsort(weights)[::-1])
    chosen = []
    taken = {f: set() for f in frames}
    for ti in order:
        if len(chosen) >= n:
            break
        t = tracks[ti]
        # eine weitere Person darf sich zeitlich nicht mit einer gewählten Spur decken, die dieselben Kästen hat
        if any(k in taken.get(f, ()) for f, k in t.items()):
            continue
        chosen.append(dict(t))
        for f, k in t.items():
            taken[f].add(k)
    # Spuren derselben Person zusammenfügen (zerrissen durch Verdeckung): passt ein freier Kasten zum
    # nächstgelegenen bekannten Kasten der Person, gehört er zu ihr
    for items in chosen:
        known = sorted(items)
        if not known:
            continue
        for f in frames:
            if f in items:
                continue
            j = int(np.searchsorted(known, f))
            near = [known[i] for i in (j - 1, j) if 0 <= i < len(known)]
            ref = min(near, key=lambda g: abs(g - f))
            if abs(ref - f) > 90:
                continue
            rb = dets[ref][items[ref]]["box"]
            best, bk = 0.3, None
            for k, p in enumerate(dets.get(f, [])):
                if k in taken[f]:
                    continue
                s = _match(rb, p["box"])
                if s > best:
                    best, bk = s, k
            if bk is not None:
                items[f] = bk
                taken[f].add(bk)
    out = []
    for items in chosen:
        out.append({f: dets[f][k] for f, k in sorted(items.items())})
    while len(out) < n:
        out.append({})
    return out
