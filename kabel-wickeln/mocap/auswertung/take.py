"""Take-Datei (FORMAT.md) schreiben und lesen: gzip-JSON, mm als ganze Zahlen."""

import datetime as dt
import gzip
import json
import os
from pathlib import Path

import numpy as np

from . import gelenke as G

FORMAT = "kabel-wickeln-take"
VERSION = 1


def iso_utc(us):
    return dt.datetime.fromtimestamp(us / 1e6, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"


def encode_frames(pos, how, conf):
    """pos (K, 68, 3) mm WELT (NaN = fehlt), how (K, 68) Zeichen, conf (K, 68) 0..1 -> Listen für JSON."""
    P, Hs, C = [], [], []
    for k in range(len(pos)):
        p = pos[k].copy()
        h = how[k].copy()
        miss = ~np.isfinite(p[:, 0]) | (h == "-")
        p[miss] = 0
        h[miss] = "-"
        c = np.where(miss, 0, np.clip(np.round(conf[k] * 100), 0, 100))
        P.append([int(round(v)) for v in p.reshape(-1)])
        Hs.append("".join(h.tolist()))
        C.append([int(v) for v in c])
    return P, Hs, C


def write(path, doc):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    data = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(tmp, "wb", compresslevel=9) as f:
        f.write(data)
    os.replace(tmp, path)
    return path


def read(path):
    with gzip.open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def arrays(doc):
    """Take -> (times (K,), pos (K, J, 3) mm mit NaN für fehlende, how (K, J), conf (K, J) 0..1)."""
    K = doc["frames"]
    J = len(doc["joints"])
    t = doc["t"]
    times = np.array(t, float) if isinstance(t, list) else t["t0"] + t["dt"] * np.arange(K)
    pos = np.array(doc["pos"], float).reshape(K, J, 3)
    how = np.array([list(s) for s in doc["how"]])
    conf = np.array(doc["conf"], float) / 100.0
    pos[how == "-"] = np.nan
    return times, pos, how, conf


def check(doc):
    """Prüft eine Take-Datei gegen FORMAT.md; gibt eine Liste von Fehlern (leer = in Ordnung)."""
    err = []
    need = ["format", "version", "kind", "shot", "take", "source", "recorded_at", "setup", "fps", "frames", "t", "camera",
            "floor", "world", "joints", "pos", "conf", "how", "quality", "markers"]
    for k in need:
        if k not in doc:
            err.append(f"Feld {k} fehlt")
    if err:
        return err
    if doc["format"] != FORMAT or doc["version"] != VERSION:
        err.append(f"format/version {doc['format']} {doc['version']}")
    if doc["joints"] != G.JOINTS:
        err.append("Gelenkliste weicht ab")
    K = doc["frames"]
    J = len(doc["joints"])
    if len(doc["pos"]) != K or any(len(p) != 3 * J for p in doc["pos"]):
        err.append("pos: falsche Länge")
    if len(doc["conf"]) != K or any(len(c) != J or min(c) < 0 or max(c) > 100 for c in doc["conf"]):
        err.append("conf: falsche Länge oder Werte")
    if len(doc["how"]) != K or any(len(h) != J or set(h) - set("DIB-T") for h in doc["how"]):
        err.append("how: falsche Länge oder Zeichen")
    t = doc["t"]
    if isinstance(t, list):
        if len(t) != K:
            err.append("t: falsche Länge")
    elif not ({"t0", "dt"} <= set(t)):
        err.append("t: weder Liste noch {t0, dt}")
    m = np.array(doc["world"]["cam_to_world"], float).reshape(4, 4)
    R = m[:3, :3]
    if not np.allclose(R @ R.T, np.eye(3), atol=1e-4):
        err.append("cam_to_world ist keine Drehung")
    if not np.allclose(R[1], doc["floor"]["normal"], atol=1e-4) or abs(m[1, 3] - doc["floor"]["d_mm"]) > 1:
        err.append("floor passt nicht zu cam_to_world")
    if "cable" in doc and doc["cable"] is not None and len(doc["cable"]) != K:
        err.append("cable: falsche Länge")
    if "hands" in doc and doc["hands"] is not None and len(doc["hands"]) != K:
        err.append("hands: falsche Länge")
    for k in ("clap", "start", "end"):
        if k not in doc["markers"]:
            err.append(f"markers.{k} fehlt")
    return err
