# Labels the frames of frames.py with a large pose model (the teacher, default yolo11x-pose): what the small
# model in the browser should learn to see in the Kinect infrared image. Writes per image the YOLO pose label
#   <out>/labels/<split>/<image>.txt   class cx cy w h, then 17 x (x, y, v); normalized, v = 2 seen, 0 not
# and all raw detections (box, score, 17 x (x, y, conf) in pixels) to <out>/raw/<model>-<split>.json, so the
# thresholds can change without running the model again (--from-raw).
# Usage: python teacher.py [--model yolo11x-pose.pt] [--split train|val] [--flip] [--scales 512] [--from-raw]
#   --flip      also runs the mirrored image and averages the matching persons (left/right swapped): steadier
#   --scales    input widths, each run and averaged (e.g. 1024,768: the image upscaled, for far persons)
#   --labels 0  only the raw detections (e.g. of the small model, for comparison)
#   --threads   CPU threads for the model (default: a quarter of the cores, at the lowest priority)
# Stopping and going on: the raw detections are saved every few hundred images; a new run skips the images
# already done. The file <out>/STOP ends a run after the running batch.
import argparse, glob, json, os, sys, time
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import REC, THREADS, be_nice, device  # noqa: E402

# COCO-17: index of the same point on the other side
FLIP = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15]
W, H = 512, 424
MIN_BOX = 0.4  # teacher box confidence for a person in the labels
MIN_KP = 0.5  # teacher keypoint confidence for a labeled (visible) keypoint


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    ar = lambda r: max(0, r[2] - r[0]) * max(0, r[3] - r[1])
    return inter / max(1e-6, ar(a) + ar(b) - inter)


def passes(model, imgs, imgsz, flip):
    """One prediction pass: per image [{box, score, kp}] in image pixels (mirrored back, left/right swapped)."""
    res = model.predict([im[:, ::-1].copy() for im in imgs] if flip else imgs, imgsz=imgsz, conf=0.25, iou=0.5, device=device(), verbose=False)
    out = []
    for r in res:
        b = r.boxes.xyxy.cpu().numpy().tolist()
        s = r.boxes.conf.cpu().numpy().tolist()
        k = r.keypoints.data.cpu().numpy().tolist() if r.keypoints is not None else [[] for _ in b]
        if flip:
            b = [[W - 1 - x1, y0, W - 1 - x0, y1] for x0, y0, x1, y1 in b]
            k = [[[W - 1 - kp[FLIP[n]][0], kp[FLIP[n]][1], kp[FLIP[n]][2]] for n in range(17)] for kp in k]
        out.append([{'box': b[j], 'score': s[j], 'kp': k[j]} for j in range(len(b))])
    return out


def detect(model, paths, flip, scales=(512,)):
    """Per image: [{box: [x0, y0, x1, y1], score, kp: [17 x [x, y, conf]]}] in image pixels. The persons of the
    first pass (first scale, not mirrored); every further pass (other scales, mirrored) is averaged into them
    where its person overlaps (IoU >= 0.5)."""
    from PIL import Image
    imgs = [np.array(Image.open(p).convert('RGB')) for p in paths]
    runs = [passes(model, imgs, z, f) for z in scales for f in ((False, True) if flip else (False,))]
    out = runs[0]
    for i, persons in enumerate(out):
        for p in persons:
            got = [p]
            for r in runs[1:]:
                j = max(range(len(r[i])), key=lambda j: iou(p['box'], r[i][j]['box']), default=None)
                if j is not None and iou(p['box'], r[i][j]['box']) >= 0.5:
                    got.append(r[i][j])
            n = len(got)
            p['kp'] = [[sum(g['kp'][k][c] for g in got) / n for c in range(3)] for k in range(17)]
            p['box'] = [sum(g['box'][c] for g in got) / n for c in range(4)]
            p['score'] = sum(g['score'] for g in got) / n
    return out


def label_lines(dets):
    lines = []
    for p in dets:
        if p['score'] < MIN_BOX:
            continue
        x0, y0, x1, y1 = p['box']
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        vals = [0, (x0 + x1) / 2 / W, (y0 + y1) / 2 / H, (x1 - x0) / W, (y1 - y0) / H]
        for x, y, c in p['kp']:
            ok = c >= MIN_KP and 0 <= x < W and 0 <= y < H
            vals += [x / W, y / H, 2] if ok else [0, 0, 0]
        lines.append(' '.join(f'{v:.6g}' for v in vals))
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--model', default='yolo11x-pose.pt')
    ap.add_argument('--split', default='train')
    ap.add_argument('--flip', action='store_true')
    ap.add_argument('--scales', default='512', help='input widths, averaged (e.g. 1024,768: upscaled, finds far persons; the first gives the persons)')
    ap.add_argument('--labels', type=int, default=1)
    ap.add_argument('--from-raw', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--batch', type=int, default=8)
    ap.add_argument('--threads', type=int, default=THREADS)
    a = ap.parse_args()
    be_nice()
    stop_file = os.path.join(a.out, 'STOP')
    paths = sorted(glob.glob(os.path.join(a.out, 'images', a.split, '*.png')))
    if a.limit:
        paths = paths[:: max(1, len(paths) // a.limit)][: a.limit]
    scales = [int(z) for z in a.scales.split(',')]
    tag = os.path.splitext(os.path.basename(a.model))[0] + ('' if scales == [512] else '@' + '+'.join(map(str, scales))) + ('-flip' if a.flip else '')
    raw_path = os.path.join(a.out, 'raw', f'{tag}-{a.split}.json')
    os.makedirs(os.path.dirname(raw_path), exist_ok=True)
    raw = json.load(open(raw_path)) if os.path.exists(raw_path) else {}
    if not a.from_raw:
        import torch
        torch.set_num_threads(a.threads)
        from ultralytics import YOLO
        model = YOLO(os.path.join(a.out, 'weights', a.model) if os.path.exists(os.path.join(a.out, 'weights', a.model)) else a.model)
        todo = [p for p in paths if os.path.basename(p) not in raw]
        t0 = time.time()
        for b in range(0, len(todo), a.batch):
            chunk = todo[b : b + a.batch]
            for p, d in zip(chunk, detect(model, chunk, a.flip, scales)):
                raw[os.path.basename(p)] = d
            done = b + len(chunk)
            stop = os.path.exists(stop_file)
            if done % (a.batch * 25) < a.batch or done == len(todo) or stop:
                el = time.time() - t0
                print(f'{done}/{len(todo)} {el / done:.2f} s/image', flush=True)
                json.dump(raw, open(raw_path, 'w'))
            if stop:
                print(f'{stop_file} found: stopped; remove it and run again to go on', flush=True)
                return
        json.dump(raw, open(raw_path, 'w'))
    if a.labels:
        d = os.path.join(a.out, 'labels', a.split)
        os.makedirs(d, exist_ok=True)
        n = 0
        for p in paths:
            name = os.path.basename(p)
            if name not in raw:
                continue
            lines = label_lines(raw[name])
            n += len(lines)
            open(os.path.join(d, os.path.splitext(name)[0] + '.txt'), 'w').write('\n'.join(lines) + ('\n' if lines else ''))
        print(f'{len(paths)} images, {n} persons labeled -> {d}')


if __name__ == '__main__':
    main()
