# Compares the raw detections of two models (teacher.py --labels 0) on the same images: persons found,
# keypoint distance of matched persons, and a contact sheet of the images where they differ most
# (model A green, model B red). The sheet shows people: it stays in recordings/training.
# Usage: python compare.py yolo11x-pose yolo11n-pose [--split val] [--sheet 8]
import argparse, json, os, sys
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import REC  # noqa: E402
from teacher import iou  # noqa: E402

BONES = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (0, 5), (0, 6)]


def persons(dets, min_score):
    return [p for p in dets if p['score'] >= min_score]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a')
    ap.add_argument('b')
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--split', default='val')
    ap.add_argument('--min-score', type=float, default=0.5)
    ap.add_argument('--sheet', type=int, default=8)
    a = ap.parse_args()
    A = json.load(open(os.path.join(a.out, 'raw', f'{a.a}-{a.split}.json')))
    B = json.load(open(os.path.join(a.out, 'raw', f'{a.b}-{a.split}.json')))
    names = sorted(set(A) & set(B))
    na = nb = 0
    dists = []
    rows = []
    for n in names:
        pa = persons(A[n], a.min_score)
        pb = persons(B[n], a.min_score)
        na += len(pa)
        nb += len(pb)
        diff = abs(len(pa) - len(pb)) * 100
        for p in pa:
            q = max(pb, key=lambda q: iou(p['box'], q['box']), default=None)
            if q is None or iou(p['box'], q['box']) < 0.3:
                continue
            for k in range(17):
                if p['kp'][k][2] >= 0.5 and q['kp'][k][2] >= 0.5:
                    d = float(np.hypot(p['kp'][k][0] - q['kp'][k][0], p['kp'][k][1] - q['kp'][k][1]))
                    dists.append(d)
                    diff += d
                elif (p['kp'][k][2] >= 0.5) != (q['kp'][k][2] >= 0.5):
                    diff += 5
        rows.append((diff, n, pa, pb))
    d = np.array(dists) if dists else np.zeros(1)
    print(f'{len(names)} images: persons {a.a} {na}, {a.b} {nb}; matched keypoints {len(dists)}: distance median {np.median(d):.1f} px, p90 {np.percentile(d, 90):.1f} px')
    rows.sort(key=lambda r: -r[0])
    tiles = []
    for diff, n, pa, pb in rows[: a.sheet]:
        im = Image.open(os.path.join(a.out, 'images', a.split, n)).convert('RGB')
        dr = ImageDraw.Draw(im)
        for ps, col in ((pa, (60, 255, 60)), (pb, (255, 60, 60))):
            for p in ps:
                dr.rectangle(p['box'], outline=col)
                for i, j in BONES:
                    if p['kp'][i][2] >= 0.5 and p['kp'][j][2] >= 0.5:
                        dr.line([tuple(p['kp'][i][:2]), tuple(p['kp'][j][:2])], fill=col, width=2)
        dr.text((4, 4), f'{n}  {a.a}: {len(pa)}  {a.b}: {len(pb)}', fill=(255, 255, 0))
        tiles.append(im)
    if tiles:
        cols = 4
        w, h = tiles[0].size
        sheet = Image.new('RGB', (w * cols, h * ((len(tiles) + cols - 1) // cols)))
        for i, t in enumerate(tiles):
            sheet.paste(t, ((i % cols) * w, (i // cols) * h))
        p = os.path.join(a.out, f'compare-{a.a}-{a.b}-{a.split}.png')
        sheet.save(p)
        print(p)


if __name__ == '__main__':
    main()
