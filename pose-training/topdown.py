# A top-down teacher: a large pose model that looks at one person at a time (a crop around the person's box)
# and places the joints more exactly than a model that sees the whole image. The boxes come from the raw
# detections of teacher.py (e.g. yolo11x at 1024). Writes raw/<tag>-<split>.json in teacher.py's format, for
# ensemble.py. Each crop is also run mirrored and the heatmaps averaged.
#   vitpose   ViTPose++ huge (Hugging Face usyd-community/vitpose-plus-huge, Apache-2.0), input 256x192
#   sapiens   Sapiens2 pose 1b (facebook/sapiens2-pose-1b, Sapiens2 license: fine for this non-commercial
#             art project), input 1024x768, 308 keypoints of which the 17 COCO body points are taken
# Needs transformers >= 5.10 (Sapiens2) and a GPU (meant for the Colab VM).
# Usage: python topdown.py --model vitpose|sapiens --split train [--boxes yolo11x-pose@1024+768-flip] [--out ...]
import argparse, json, os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import REC  # noqa: E402
from teacher import FLIP, MIN_BOX  # noqa: E402

MODELS = {
    # name: (Hugging Face repo, input height, width, the 17 COCO points among the model's keypoints)
    'vitpose': ('usyd-community/vitpose-plus-huge', 256, 192, list(range(17))),
    # Goliath/Sociopticon order: wrists are 62 (left) and 41 (right), hips 9/10 ... ankles 13/14
    'sapiens': ('facebook/sapiens2-pose-1b', 1024, 768, [0, 1, 2, 3, 4, 5, 6, 7, 8, 62, 41, 9, 10, 11, 12, 13, 14]),
}
MEAN, STD = np.array([0.485, 0.456, 0.406], np.float32), np.array([0.229, 0.224, 0.225], np.float32)


def load(name):
    import torch
    import transformers
    repo = MODELS[name][0]
    cls = transformers.VitPoseForPoseEstimation if name == 'vitpose' else transformers.Sapiens2ForPoseEstimation
    model = cls.from_pretrained(repo, torch_dtype=torch.bfloat16).cuda().eval()
    return model


def crop(img, box, h, w, pad=1.25):
    """The person's box widened to the model's aspect, as an affine warp: (crop h x w x 3, matrix crop -> image)."""
    import cv2
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bw, bh = (x1 - x0) * pad, (y1 - y0) * pad
    if bw / bh > w / h:
        bh = bw * h / w
    else:
        bw = bh * w / h
    s = bw / w  # image pixels per crop pixel
    to_img = np.array([[s, 0, cx - bw / 2], [0, s, cy - bh / 2]], np.float32)
    to_crop = cv2.invertAffineTransform(to_img)
    out = cv2.warpAffine(img, to_crop, (w, h), flags=cv2.INTER_LINEAR, borderValue=(114, 114, 114))
    return out, to_img


def decode(hm):
    """Heatmaps [17, hh, hw] -> [17, 3] (x, y in heatmap pixels with a quarter-pixel shift toward the higher
    neighbor, peak value)."""
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


def run(model, name, crops):
    """Heatmaps of the 17 COCO points for a batch of crops, mirrored run averaged in."""
    import torch
    _, h, w, pick = MODELS[name]
    x = (np.stack(crops).astype(np.float32) / 255 - MEAN) / STD
    x = torch.from_numpy(x).permute(0, 3, 1, 2).cuda().to(torch.bfloat16)
    x = torch.cat([x, x.flip(3)])
    kw = {'dataset_index': torch.zeros(len(x), dtype=torch.long, device='cuda')} if name == 'vitpose' else {}
    with torch.no_grad():
        o = model(pixel_values=x, **kw)
    hm = getattr(o, 'heatmaps', None)
    if hm is None:
        hm = o.logits
    hm = hm.float()[:, pick]
    n = len(crops)
    flipped = hm[n:].flip(3)[:, FLIP]
    return ((hm[:n] + flipped) / 2).cpu().numpy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--model', choices=list(MODELS), required=True)
    ap.add_argument('--split', default='train')
    ap.add_argument('--boxes', default='yolo11x-pose@1024+768-flip', help='raw tag whose person boxes are used')
    ap.add_argument('--batch', type=int, default=32)
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    from PIL import Image
    boxes = json.load(open(os.path.join(a.out, 'raw', f'{a.boxes}-{a.split}.json')))
    raw_path = os.path.join(a.out, 'raw', f'{a.model}-{a.split}.json')
    raw = json.load(open(raw_path)) if os.path.exists(raw_path) else {}
    names = sorted(n for n in boxes if n not in raw)
    if a.limit:
        names = names[: a.limit]
    model = load(a.model)
    _, h, w, _ = MODELS[a.model]
    todo = [(n, p) for n in names for p in boxes[n] if p['score'] >= MIN_BOX]
    t0, dist = time.time(), []
    for b in range(0, len(todo), a.batch):
        chunk = todo[b : b + a.batch]
        imgs = {n: np.array(Image.open(os.path.join(a.out, 'images', a.split, n)).convert('RGB')) for n in {n for n, _ in chunk}}
        cr = [crop(imgs[n], p['box'], h, w) for n, p in chunk]
        hms = run(model, a.model, [c for c, _ in cr])
        for (n, p), (_, m), hm in zip(chunk, cr, hms):
            kp = decode(hm)
            sx, sy = w / hm.shape[2], h / hm.shape[1]  # crop pixels per heatmap pixel
            xy = np.stack([(kp[:, 0] + 0.5) * sx - 0.5, (kp[:, 1] + 0.5) * sy - 0.5, np.ones(17)], 1) @ m.T
            q = [[float(x), float(y), float(c)] for (x, y), c in zip(xy, kp[:, 2])]
            raw.setdefault(n, []).append({'box': p['box'], 'score': p['score'], 'kp': q})
            dist += [np.hypot(q[k][0] - p['kp'][k][0], q[k][1] - p['kp'][k][1]) for k in range(17) if q[k][2] > 0.5 and p['kp'][k][2] > 0.5]
        done = b + len(chunk)
        if done % (a.batch * 50) < a.batch or done == len(todo):
            print(f'{done}/{len(todo)} persons {(time.time() - t0) / done * 1000:.0f} ms/person, median distance to the box teacher {np.median(dist) if dist else 0:.1f} px', flush=True)
            json.dump(raw, open(raw_path, 'w'))
    for n in names:
        raw.setdefault(n, [])  # images without persons
    json.dump(raw, open(raw_path, 'w'))
    print(f'{len(names)} images, {len(todo)} persons -> {raw_path}')


if __name__ == '__main__':
    main()
