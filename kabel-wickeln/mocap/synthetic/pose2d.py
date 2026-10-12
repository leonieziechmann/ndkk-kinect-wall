"""Die Rundreise im Kleinen: ein Pose-Modell auf den Infrarotbildern einer synthetischen Aufnahme,
die 17 COCO-Gelenke mit der Tiefe in 3D gehoben und in die WELT des Take-Formats gebracht (Boden
selbst aus der Tiefe gemessen, nicht aus der Wahrheit), dann mit der Wahrheit verglichen: in Pixeln
und in mm. Zeigt, ob die Pose-Modelle die gerenderten Figuren als Menschen sehen und wie genau, und
ist eine einfache Messlatte für auswerten.py.

    python mocap/synthetic/pose2d.py output/synthetic
    python mocap/synthetic/pose2d.py --model ..\\web\\lib\\models\\yolo11s-pose-512x448-fp16.onnx --stride 3 datei.k2rec

Braucht numpy und onnxruntime (`python -m pip install numpy onnxruntime`). Standardmodell: das
Pose-Modell des Browsers/Hubs (YOLO11s-pose, 512 x 448) aus web/lib/models; die Vorverarbeitung ist
die von web/lib/persons-pose.js (Infrarot entspiegelt, grau, graue Ränder oben und unten).
"""

import argparse
import gzip
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pruefen import K2Rec, fit_floor, lut_at  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
MODEL = REPO / "web" / "lib" / "models" / "yolo11s-pose-512x448-fp16.onnx"
COCO = ["nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
        "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"]


def detect(session, ir, in_w=512, in_h=448, min_score=0.35):
    """the most confident person: score, keypoints (17, 3) as hub pixels (mirrored image) and confidence"""
    W, H = ir.shape[1], ir.shape[0]
    pad = (in_h - H) // 2
    x = np.full((1, 3, in_h, in_w), 114 / 255, np.float32)
    x[0, :, pad:pad + H, :W] = (ir[:, ::-1] / 255.0).astype(np.float32)
    out = session.run(None, {session.get_inputs()[0].name: x})[0][0]  # (56, A)
    a = int(np.argmax(out[4]))
    if out[4, a] < min_score:
        return 0.0, None
    kp = out[5:, a].reshape(17, 3).copy()
    kp[:, 0] = W - 1 - kp[:, 0]
    kp[:, 1] -= pad
    return float(out[4, a]), kp


# how far a joint centre lies behind the skin the depth sees (mm, along the line of sight)
RADIUS = {"nose": 0, "left_eye": 0, "right_eye": 0, "left_ear": 30, "right_ear": 30, "left_shoulder": 60, "right_shoulder": 60,
          "left_elbow": 35, "right_elbow": 35, "left_wrist": 25, "right_wrist": 25, "left_hip": 70, "right_hip": 70,
          "left_knee": 45, "right_knee": 45, "left_ankle": 35, "right_ankle": 35}


def world_from_floor(n, d):
    """the take's WORLD from a measured floor (FORMAT.md): y = up, origin below the sensor, -z = the camera's view on the floor"""
    ey = n / np.linalg.norm(n)
    zc = np.array([0.0, 0.0, 1.0])
    ez = -(zc - (zc @ ey) * ey)
    ez /= np.linalg.norm(ez)
    ex = np.cross(ey, ez)
    return lambda p: np.array([ex @ p, ey @ p + d, ez @ p])


def lift(depth, lut, u, v, radius):
    """CAMERA point (mm) of a keypoint: the near surface around it (30 % quantile of a 7 x 7 window), pushed back by the radius"""
    iu, iv = int(round(u)), int(round(v))
    win = depth[max(0, iv - 3):iv + 4, max(0, iu - 3):iu + 4]
    win = win[win > 0]
    if win.size < 5:
        return None
    z = float(np.percentile(win, 30))
    ray = np.array([-lut_at(lut, u, v, 0), lut_at(lut, u, v, 1), 1.0])
    p = ray * z
    return p + radius * ray / np.linalg.norm(ray)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("files", nargs="+")
    ap.add_argument("--model", default=str(MODEL))
    ap.add_argument("--stride", type=int, default=3, help="jeder wievielte Frame")
    args = ap.parse_args()
    import onnxruntime as ort
    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    in_h, in_w = session.get_inputs()[0].shape[2:4]
    files = []
    for f in args.files:
        p = Path(f)
        files += sorted(p.glob("*.k2rec")) if p.is_dir() else [p]
    for f in files:
        truth_path = Path(str(f)[: -len(".k2rec")] + ".truth.json.gz")
        if not truth_path.exists():
            print(f"{f}: keine Wahrheit daneben, übersprungen")
            continue
        T = json.loads(gzip.open(truth_path).read())
        rec = K2Rec(f)
        found = tried = 0
        err = {n: [] for n in COCO}
        err3 = {n: [] for n in COCO}
        floor = fit_floor(rec.frame(0)[0], rec.lut, np.random.default_rng(1))
        to_world = world_from_floor(floor[0], floor[1]) if floor else None
        swapped = 0
        for i in range(0, len(rec.frames), args.stride):
            depth, ir = rec.frame(i)
            score, kp = detect(session, ir, in_w, in_h)
            tried += 1
            if kp is None:
                continue
            found += 1
            uv = np.array(T["truth"]["uv_values"][i], float).reshape(-1, 2)
            vis = T["truth"]["visible_codes"][i]
            pos = np.array(T["pos"][i], float).reshape(-1, 3)
            for j, n in enumerate(COCO):
                if vis[j] == "v" and kp[j, 2] > 0.5:
                    err[n].append(float(np.hypot(*(kp[j, :2] - uv[j]))))
                    p = lift(depth, rec.lut, kp[j, 0], kp[j, 1], RADIUS[n]) if to_world else None
                    if p is not None:
                        err3[n].append(float(np.linalg.norm(to_world(p) - pos[j])))
            # left and right mixed up? (shoulders and hips nearer to the other side's truth)
            pairs = [(5, 6), (11, 12)]
            d_ok = sum(np.hypot(*(kp[a, :2] - uv[a])) + np.hypot(*(kp[b, :2] - uv[b])) for a, b in pairs)
            d_sw = sum(np.hypot(*(kp[a, :2] - uv[b])) + np.hypot(*(kp[b, :2] - uv[a])) for a, b in pairs)
            swapped += d_sw + 4 < d_ok
        print(f"{f.name}: Person in {found}/{tried} Frames gefunden, links/rechts vertauscht in {swapped}")
        print("  Gelenk            Median px   90 % px   PCK@5px   Proben   3D Median mm   3D 90 % mm")
        for n in COCO:
            e = np.array(err[n])
            e3 = np.array(err3[n])
            if len(e):
                d3 = f"{np.median(e3):14.0f} {np.percentile(e3, 90):12.0f}" if len(e3) else ""
                print(f"  {n:16s} {np.median(e):9.1f} {np.percentile(e, 90):9.1f} {np.mean(e < 5) * 100:8.0f} % {len(e):7d} {d3}")
            else:
                print(f"  {n:16s}         –  (nicht sichtbar oder nicht sicher erkannt)")


if __name__ == "__main__":
    main()
