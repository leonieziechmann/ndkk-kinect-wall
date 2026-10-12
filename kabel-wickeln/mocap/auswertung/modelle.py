"""2D-Pose-Modelle auf dem Infrarotbild der Kinect.

Alle Modelle bekommen das Infrarotbild so, wie es auch Browser, Hub und pose-training/frames.py den Modellen
geben: entspiegelt (die Kamera sieht die Welt nicht gespiegelt), grau in allen drei Kanälen. Ergebnisse kommen
als Hub-Pixel (gespiegeltes Bild, wie die Tiefe) zurück; links/rechts sind die Seiten der Person.

Detektoren (finden alle Personen, je Person Kasten + COCO-17):
  OnnxYolo         jedes YOLO-Pose-ONNX (web/lib/models, oder ein exportiertes yolo11x-pose); onnxruntime mit
                   CPU, CUDA oder DirectML. Das ist der leichte Testmodus (nur Körper).
  UltralyticsYolo  YOLO11x-pose (.pt) mit Ultralytics/PyTorch (cpu oder cuda), wie pose-training/teacher.py.
Top-down (verfeinern eine Person in einem Ausschnitt um ihren Kasten, wie pose-training/topdown.py):
  TopDown('vitpose')  ViTPose++ huge (usyd-community/vitpose-plus-huge): COCO-17
  TopDown('sapiens')  Sapiens2 pose 1b (facebook/sapiens2-pose-1b): 308 Punkte, davon Körper, Füße, 2 x 21 Hand
Alle laufen zusätzlich auf dem gespiegelten Bild; die Ergebnisse werden gemittelt (links/rechts getauscht).
"""

import time

import numpy as np

from . import gelenke as G

W, H = 512, 424
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
COCO_FLIP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]


# ---------------------------------------------------------------------------------------- Bildhilfen

def resize_bilinear(img, out_h, out_w):
    """Bilinear skalieren (H, W[, C]) float32, Pixelmitten wie OpenCV/PIL."""
    h, w = img.shape[:2]
    if (h, w) == (out_h, out_w):
        return img.astype(np.float32)
    ys = (np.arange(out_h) + 0.5) * h / out_h - 0.5
    xs = (np.arange(out_w) + 0.5) * w / out_w - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, h - 1)
    x0 = np.clip(np.floor(xs).astype(int), 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    fy = np.clip(ys - y0, 0, 1)[:, None]
    fx = np.clip(xs - x0, 0, 1)[None, :]
    im = img.astype(np.float32)
    if im.ndim == 3:
        fy = fy[..., None]
        fx = fx[..., None]
    a = im[y0][:, x0] * (1 - fx) + im[y0][:, x1] * fx
    b = im[y1][:, x0] * (1 - fx) + im[y1][:, x1] * fx
    return a * (1 - fy) + b * fy


def warp_affine(img, to_img, out_h, out_w, border=114.0):
    """Ausschnitt (out_h, out_w) aus img (H, W) grau: Ausschnitt-Pixel (x, y) -> Bild (to_img @ [x, y, 1]); bilinear."""
    h, w = img.shape[:2]
    xs, ys = np.meshgrid(np.arange(out_w, dtype=np.float32), np.arange(out_h, dtype=np.float32))
    X = to_img[0, 0] * xs + to_img[0, 1] * ys + to_img[0, 2]
    Y = to_img[1, 0] * xs + to_img[1, 1] * ys + to_img[1, 2]
    x0 = np.floor(X).astype(np.int64)
    y0 = np.floor(Y).astype(np.int64)
    fx = X - x0
    fy = Y - y0
    im = np.pad(img.astype(np.float32), 1, constant_values=border)
    xi = np.clip(x0 + 1, 0, w + 1)
    yi = np.clip(y0 + 1, 0, h + 1)
    xj = np.clip(x0 + 2, 0, w + 1)
    yj = np.clip(y0 + 2, 0, h + 1)
    out = (im[yi, xi] * (1 - fx) + im[yi, xj] * fx) * (1 - fy) + (im[yj, xi] * (1 - fx) + im[yj, xj] * fx) * fy
    outside = (X < -1) | (X > w) | (Y < -1) | (Y > h)
    out[outside] = border
    return out


def crop_matrix(box, h, w, pad=1.25):
    """Kasten auf das Seitenverhältnis des Modells erweitert (wie topdown.crop): Matrix Ausschnitt -> Bild (2 x 3)."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bw, bh = max(x1 - x0, 4) * pad, max(y1 - y0, 4) * pad
    if bw / bh > w / h:
        bh = bw * h / w
    else:
        bw = bh * w / h
    s = bw / w
    return np.array([[s, 0, cx - bw / 2], [0, s, cy - bh / 2]], np.float32)


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    ar = lambda r: max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])
    return inter / max(1e-6, ar(a) + ar(b) - inter)


def nms(boxes, scores, thr=0.5):
    order = np.argsort(-scores)
    keep = []
    while len(order):
        i = order[0]
        keep.append(int(i))
        rest = [j for j in order[1:] if iou(boxes[i], boxes[j]) < thr]
        order = np.array(rest, dtype=int)
    return keep


def to_hub(kp_unmirrored):
    """Keypoints/Kasten aus dem entspiegelten Bild ins Hub-Bild (gespiegelt): u = W - 1 - x."""
    k = np.array(kp_unmirrored, np.float32, copy=True)
    k[..., 0] = W - 1 - k[..., 0]
    return k


def box_to_hub(b):
    return np.array([W - 1 - b[2], b[1], W - 1 - b[0], b[3]], np.float32)


def merge_flip(a, b):
    """Personen zweier Durchläufe (normal, gespiegelt) mitteln, wo sich die Kästen überdecken (IoU >= 0.5)."""
    out = []
    used = set()
    for p in a:
        best, bi = 0.0, -1
        for j, q in enumerate(b):
            if j in used:
                continue
            v = iou(p["box"], q["box"])
            if v > best:
                best, bi = v, j
        if bi >= 0 and best >= 0.5:
            used.add(bi)
            q = b[bi]
            kp = (p["kp"] + q["kp"]) / 2
            # wo nur ein Durchlauf den Punkt kennt (Konfidenz 0 im anderen), dessen Wert nehmen
            only_p = (q["kp"][:, 2] <= 0) & (p["kp"][:, 2] > 0)
            only_q = (p["kp"][:, 2] <= 0) & (q["kp"][:, 2] > 0)
            kp[only_p] = p["kp"][only_p]
            kp[only_q] = q["kp"][only_q]
            out.append({"box": (p["box"] + q["box"]) / 2, "score": (p["score"] + q["score"]) / 2, "kp": kp})
        else:
            out.append(p)
    return out


def device_providers(device):
    """onnxruntime-Provider für --device."""
    import onnxruntime as ort
    have = ort.get_available_providers()
    want = {"cuda": ["CUDAExecutionProvider"], "dml": ["DmlExecutionProvider"], "cpu": []}.get(device, [])
    prov = [p for p in want if p in have]
    if want and not prov:
        print(f"  Hinweis: onnxruntime hat hier keinen {want[0]} (vorhanden: {', '.join(have)}); nehme die CPU.")
    return prov + ["CPUExecutionProvider"]


# ---------------------------------------------------------------------------------------- Detektoren

class OnnxYolo:
    """YOLO-Pose als ONNX: Ausgabe 1 x 56 x A (cx, cy, w, h, score, 17 x (x, y, conf))."""

    def __init__(self, path, device="cpu", threads=0, min_score=0.25):
        import onnxruntime as ort
        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = threads
        self.session = ort.InferenceSession(str(path), so, providers=device_providers(device))
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        self.in_h, self.in_w = int(inp.shape[2]), int(inp.shape[3])
        self.fp16 = "float16" in inp.type
        self.min_score = min_score
        self.name = f"onnx:{path.name if hasattr(path, 'name') else path}"
        self.provides = list(range(17))

    def _run(self, gray):
        """gray (H, W) uint8 entspiegelt -> Personen im entspiegelten Bild."""
        h, w = gray.shape
        s = min(self.in_w / w, self.in_h / h)
        nw, nh = int(round(w * s)), int(round(h * s))
        img = resize_bilinear(gray.astype(np.float32), nh, nw) / 255.0
        px, py = (self.in_w - nw) // 2, (self.in_h - nh) // 2
        x = np.full((1, 3, self.in_h, self.in_w), 114 / 255, np.float32)
        x[0, :, py:py + nh, px:px + nw] = img
        if self.fp16:
            x = x.astype(np.float16)
        out = np.asarray(self.session.run(None, {self.input_name: x})[0][0], np.float32)
        if out.shape[0] > out.shape[1]:
            out = out.T
        keep = out[4] >= self.min_score
        o = out[:, keep]
        if o.shape[1] == 0:
            return []
        boxes = np.stack([o[0] - o[2] / 2, o[1] - o[3] / 2, o[0] + o[2] / 2, o[1] + o[3] / 2], 1)
        idx = nms(boxes, o[4], 0.5)
        res = []
        for i in idx:
            b = (boxes[i] - [px, py, px, py]) / s
            kp = o[5:, i].reshape(17, 3).copy()
            kp[:, 0] = (kp[:, 0] - px) / s
            kp[:, 1] = (kp[:, 1] - py) / s
            res.append({"box": b.astype(np.float32), "score": float(o[4, i]), "kp17": kp})
        return res

    def detect(self, ir, flip=True):
        """Alle Personen in einem Hub-Infrarotbild: [{box (Hub-Pixel), score, kp (68, 3)}]."""
        return detect_with_flip(self._run, ir, flip)


class UltralyticsYolo:
    """YOLO11x-pose (oder ein anderes .pt) über Ultralytics, wie pose-training/teacher.py."""

    def __init__(self, weights, device="cpu", imgsz=640, min_score=0.25):
        from ultralytics import YOLO
        self.model = YOLO(str(weights))
        self.device = {"cuda": "0", "cpu": "cpu"}.get(device, "cpu")
        if device == "dml":
            print("  Hinweis: Ultralytics kann DirectML nicht; der Detektor läuft auf der CPU. Schneller: yolo11x-pose als "
                  "ONNX exportieren (README) und mit --detektor <datei>.onnx über onnxruntime-directml laufen lassen.")
        self.imgsz = imgsz
        self.min_score = min_score
        self.name = f"ultralytics:{getattr(weights, 'name', weights)}@{imgsz}"
        self.provides = list(range(17))

    def _run(self, gray):
        rgb = np.repeat(gray[..., None], 3, axis=2)
        r = self.model.predict([rgb], imgsz=self.imgsz, conf=self.min_score, iou=0.5, device=self.device, verbose=False)[0]
        b = r.boxes.xyxy.cpu().numpy()
        s = r.boxes.conf.cpu().numpy()
        k = r.keypoints.data.cpu().numpy() if r.keypoints is not None else np.zeros((len(b), 17, 3))
        return [{"box": b[j].astype(np.float32), "score": float(s[j]), "kp17": k[j].astype(np.float32)} for j in range(len(b))]

    def detect(self, ir, flip=True):
        return detect_with_flip(self._run, ir, flip)


def detect_with_flip(run, ir, flip):
    """run(entspiegeltes Bild) -> Personen; mit flip zusätzlich auf dem Hub-Bild (= gespiegelt) und gemittelt."""
    gray = np.ascontiguousarray(ir[:, ::-1])  # entspiegelt: so sehen die Modelle die Welt

    def ours(p, mirrored_pass):
        kp = np.zeros((G.J, 3), np.float32)
        k = p["kp17"].copy()
        if mirrored_pass:
            # das Hub-Bild ist das gespiegelte Bild: Koordinaten sind schon Hub-Pixel, Seiten tauschen
            k = k[COCO_FLIP]
            kp[:17] = k
            box = p["box"]
        else:
            kp[:17] = to_hub(k)
            box = box_to_hub(p["box"])
        return {"box": np.asarray(box, np.float32), "score": p["score"], "kp": kp}

    a = [ours(p, False) for p in run(gray)]
    if not flip:
        return a
    b = [ours(p, True) for p in run(np.ascontiguousarray(ir))]
    return merge_flip(a, b)


# ---------------------------------------------------------------------------------------- Top-down

TOPDOWN = {
    # Name: (Hugging Face, Klasse, Eingabe h, w, Batch-Vorgabe)
    "vitpose": ("usyd-community/vitpose-plus-huge", "VitPoseForPoseEstimation", 256, 192),
    "sapiens": ("facebook/sapiens2-pose-1b", "Sapiens2ForPoseEstimation", 1024, 768),
}


def torch_device(device):
    import torch
    if device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("--device cuda: PyTorch sieht keine CUDA-GPU")
        return torch.device("cuda"), torch.bfloat16
    if device == "dml":
        try:
            import torch_directml
        except ImportError as e:
            raise RuntimeError("--device dml braucht torch-directml (python -m pip install torch-directml)") from e
        return torch_directml.device(), torch.float16
    return torch.device("cpu"), torch.float32


def decode_heatmaps(hm):
    """Heatmaps (K, hh, hw) -> (K, 3): x, y in Heatmap-Pixeln (Viertelpixel zum höheren Nachbarn), Spitzenwert."""
    k, hh, hw = hm.shape
    flat = hm.reshape(k, -1)
    idx = flat.argmax(1)
    y, x = (idx // hw).astype(np.float32), (idx % hw).astype(np.float32)
    conf = flat.max(1)
    for j in range(k):
        xi, yi = int(x[j]), int(y[j])
        if 0 < xi < hw - 1:
            x[j] += 0.25 * np.sign(hm[j, yi, xi + 1] - hm[j, yi, xi - 1])
        if 0 < yi < hh - 1:
            y[j] += 0.25 * np.sign(hm[j, yi + 1, xi] - hm[j, yi - 1, xi])
    return np.stack([x, y, conf], 1)


class TopDown:
    """ViTPose++ oder Sapiens2 auf einem Ausschnitt um den Kasten einer Person, mit Spiegel-Mittelung der
    Heatmaps (wie pose-training/topdown.py). Gibt Keypoints (68, 3) in Hub-Pixeln."""

    def __init__(self, name, device="cpu", repo=None, dtype=None):
        import torch
        import transformers
        hf, cls_name, self.h, self.w = TOPDOWN[name]
        self.kind = name
        self.repo = repo or hf
        self.device, self.dtype = torch_device(device)
        if dtype:
            self.dtype = getattr(torch, dtype)
        cls = getattr(transformers, cls_name, None)
        if cls is None:
            raise RuntimeError(f"transformers {transformers.__version__} kennt {cls_name} nicht "
                               f"(Sapiens2 braucht transformers >= 5.10: python -m pip install -U transformers)")
        kw = {"dtype": self.dtype}
        try:
            self.model = cls.from_pretrained(self.repo, attn_implementation="sdpa", **kw)
        except (ValueError, ImportError, TypeError):
            self.model = cls.from_pretrained(self.repo, **kw)
        self.model = self.model.to(self.device).eval()
        self.name = f"{name}:{self.repo}"
        if name == "vitpose":
            self.ours = list(range(17))
            self.pick = list(range(17))
        else:
            self.ours = G.SAPIENS_OURS
            self.pick = G.SAPIENS_PICK
        self.provides = list(self.ours)
        # Spiegelpartner innerhalb der ausgewählten Punkte
        pos = {o: k for k, o in enumerate(self.ours)}
        self.flip_sub = [pos[G.FLIP[o]] for o in self.ours]

    def __call__(self, ir, boxes):
        """Hub-Infrarotbild und Kästen (Hub-Pixel) -> Liste von (68, 3) je Kasten."""
        return self.many([(ir, b) for b in boxes])

    def many(self, items):
        """[(Hub-Infrarotbild, Kasten)] -> Liste von (68, 3); alle in einem Stapel (schneller auf der GPU)."""
        import torch
        if not len(items):
            return []
        crops, mats = [], []
        for ir, b in items:
            gray = np.ascontiguousarray(ir[:, ::-1]).astype(np.float32)
            bu = box_to_hub(b)  # Hub-Kasten -> entspiegelter Kasten (dieselbe Abbildung)
            m = crop_matrix(bu, self.h, self.w)
            c = warp_affine(gray, m, self.h, self.w)
            crops.append(c)
            mats.append(m)
        x = (np.repeat(np.stack(crops)[..., None], 3, axis=3) / 255.0 - MEAN) / STD
        x = torch.from_numpy(x.astype(np.float32)).permute(0, 3, 1, 2)
        x = torch.cat([x, x.flip(3)]).to(self.device).to(self.dtype)
        kw = {}
        if self.kind == "vitpose":
            kw["dataset_index"] = torch.zeros(len(x), dtype=torch.long, device=self.device)
        with torch.no_grad():
            o = self.model(pixel_values=x, **kw)
        hm = getattr(o, "heatmaps", None)
        if hm is None:
            hm = o.logits
        hm = hm.float()[:, self.pick]
        n = len(crops)
        flipped = hm[n:].flip(3)[:, self.flip_sub]
        hm = ((hm[:n] + flipped) / 2).cpu().numpy()
        out = []
        for m, h in zip(mats, hm):
            kp = decode_heatmaps(h)
            sx, sy = self.w / h.shape[2], self.h / h.shape[1]
            xy = np.stack([(kp[:, 0] + 0.5) * sx - 0.5, (kp[:, 1] + 0.5) * sy - 0.5, np.ones(len(kp))], 1) @ m.T
            full = np.zeros((G.J, 3), np.float32)
            full[self.ours, 0] = W - 1 - xy[:, 0]
            full[self.ours, 1] = xy[:, 1]
            full[self.ours, 2] = np.clip(kp[:, 2], 0, 1)
            out.append(full)
        return out


# ---------------------------------------------------------------------------------------- Zusammenführen

PRIOR = {"sapiens": 1.0, "vitpose": 0.6, "detector": 0.4}


def fuse(cands, box):
    """Keypoints mehrerer Modelle (Liste von (Name, (68, 3))) zu einem (68, 3). Je Gelenk gewinnt die Gruppe von
    Modellen, die sich einig ist (Abstand < max(4 px, 4 % der Kastenhöhe)) und das größte Gewicht hat (Vorrang^2 x
    Konfidenz; Sapiens2 vor ViTPose vor dem Detektor). Ist Sapiens2 sicher, entscheidet es fast allein; die anderen
    springen ein, wo es unsicher ist. Einigkeit macht den Punkt etwas sicherer."""
    out = np.zeros((G.J, 3), np.float32)
    thr = max(4.0, 0.04 * float(box[3] - box[1]))
    for j in range(G.J):
        c = [(PRIOR.get(n.split(":")[0], 0.4) ** 2 * k[j, 2], k[j]) for n, k in cands if k[j, 2] > 0.05]
        if not c:
            continue
        c.sort(key=lambda x: -x[0])
        best = None
        for w0, p0 in c:
            grp = [(w, p) for w, p in c if np.hypot(p[0] - p0[0], p[1] - p0[1]) < thr]
            score = sum(w for w, _ in grp)
            if best is None or score > best[0] + 1e-6:
                best = (score, grp)
        grp = best[1]
        ws = np.array([w for w, _ in grp]) + 1e-6
        ps = np.array([p for _, p in grp])
        out[j, :2] = (ps[:, :2] * ws[:, None]).sum(0) / ws.sum()
        out[j, 2] = min(1.0, float(ps[:, 2].max()) + 0.05 * (len(grp) - 1))
    return out


class Timer:
    def __init__(self):
        self.t = {}

    def add(self, k, dt):
        self.t[k] = self.t.get(k, 0.0) + dt

    def run(self, k, fn, *a, **kw):
        t0 = time.perf_counter()
        r = fn(*a, **kw)
        self.add(k, time.perf_counter() - t0)
        return r
