# Labels from several teachers (their raw detections from teacher.py): a keypoint is labeled only where all
# teachers that see the person agree on it, at their mean position. Disagreement (one sure, one not, or too
# far apart) leaves it unlabeled, so the student is not taught a guess. The persons come from the first raw
# file (e.g. the teacher at 1024, which finds far persons); a person the other teachers miss keeps its labels.
# Agreement: within the OKS-0.5 distance of the teachers' median point (COCO keypoint sigmas, the
# person's box size); --need sets how many of the teachers must agree (default all).
# Usage: python ensemble.py --split train --raw yolo11x-pose@1024+768-flip yolo11x-pose-flip [--out ...]
import argparse, glob, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import REC  # noqa: E402
from teacher import MIN_BOX, MIN_KP, iou, label_lines  # noqa: E402

SIGMA = [0.026, 0.025, 0.025, 0.035, 0.035, 0.079, 0.079, 0.072, 0.072, 0.062, 0.062, 0.107, 0.107, 0.087, 0.087, 0.089, 0.089]


def agree(p, others, need=1.0):
    """p with its keypoints merged with the matching persons of the other teachers (conf 1 agreed, 0 not):
    labeled where at least `need` of the teachers that see the person are sure and lie near their median."""
    x0, y0, x1, y1 = p['box']
    s = math.sqrt(max(1.0, (x1 - x0) * (y1 - y0)))
    got = [p['kp']]
    for persons in others:
        j = max(range(len(persons)), key=lambda j: iou(p['box'], persons[j]['box']), default=None)
        if j is not None and iou(p['box'], persons[j]['box']) >= 0.5:
            got.append(persons[j]['kp'])
    kp = []
    for k in range(17):
        pts = [g[k] for g in got]
        sure = [q for q in pts if q[2] >= MIN_KP]
        tol = s * 2 * SIGMA[k] * math.sqrt(2 * math.log(2))  # the distance where OKS falls to 0.5
        med = (sorted(q[0] for q in sure)[len(sure) // 2], sorted(q[1] for q in sure)[len(sure) // 2]) if sure else (0, 0)
        near = [q for q in sure if math.dist(q[:2], med) <= tol]
        ok = len(near) >= max(1, math.ceil(need * len(pts) - 1e-9)) and (len(pts) == 1 or len(near) >= 2)
        use = near if ok else pts
        kp.append([sum(q[0] for q in use) / len(use), sum(q[1] for q in use) / len(use), 1.0 if ok else 0.0])
    return {**p, 'kp': kp}, len(got)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--split', default='train')
    ap.add_argument('--raw', nargs='+', required=True, help='raw tags (raw/<tag>-<split>.json); the first gives the persons')
    ap.add_argument('--need', type=float, default=1.0, help='share of the teachers that must agree on a keypoint (1: all; 0.6: 2 of 3, 3 of 4)')
    a = ap.parse_args()
    raws = [json.load(open(os.path.join(a.out, 'raw', f'{t}-{a.split}.json'))) for t in a.raw]
    paths = sorted(glob.glob(os.path.join(a.out, 'images', a.split, '*.png')))
    d = os.path.join(a.out, 'labels', a.split)
    os.makedirs(d, exist_ok=True)
    persons = kept = single = 0
    for path in paths:
        name = os.path.basename(path)
        if any(name not in r for r in raws):
            continue
        merged = []
        for p in raws[0][name]:
            if p['score'] < MIN_BOX:
                continue
            q, n = agree(p, [r[name] for r in raws[1:]], a.need)
            merged.append(q)
            persons += 1
            single += n == 1
            kept += sum(k[2] > 0 for k in q['kp'])
        lines = label_lines(merged)
        open(os.path.join(d, os.path.splitext(name)[0] + '.txt'), 'w').write('\n'.join(lines) + ('\n' if lines else ''))
    print(f'{a.split}: {len(paths)} images, {persons} persons ({single} seen by the first teacher only), {kept / max(1, 17 * persons):.0%} of keypoints labeled -> {d}')


if __name__ == '__main__':
    main()
