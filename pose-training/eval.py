# How well models find the persons and their keypoints in the held-out frames (images/val, teacher labels):
# Ultralytics' pose metrics (mAP over keypoint similarity, OKS) at the browser's input size, per model, on
# all held-out frames and on the cases on their own: T-pose (spinning, aiming: space-invaders), jumping, the
# multi-user recordings (groups, sitting, occlusion).
# Usage: python eval.py [model[@imgsz] ...]   default: the COCO model at 512 and 384 (the browser now, and
#   downscaled) and every runs/*/weights/best.pt at the input width it was trained for
import argparse, glob, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import REC, THREADS, be_nice, device  # noqa: E402
from teacher import FLIP  # noqa: E402

CASES = {'alle': '', 'tpose': 'tpose-', 'springen': 'hops-', 'multi': 'multi-'}  # case: image name prefix


def subsets(out):
    """A dataset description per case (a list of its validation images); cases without images are left out."""
    root = out.replace('\\', '/')
    paths = sorted(glob.glob(os.path.join(out, 'images', 'val', '*.png')))
    found = {}
    for case, prefix in CASES.items():
        sel = [p.replace('\\', '/') for p in paths if os.path.basename(p).startswith(prefix)]
        if not sel:
            continue
        lst = os.path.join(out, f'val-{case}.txt')
        open(lst, 'w').write('\n'.join(sel) + '\n')
        y = os.path.join(out, f'val-{case}.yaml')
        open(y, 'w').write(f'path: {root}\ntrain: val-{case}.txt\nval: val-{case}.txt\nkpt_shape: [17, 3]\nflip_idx: {FLIP}\nnames:\n  0: person\n')
        found[case] = (y, len(sel))
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('models', nargs='*')
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--threads', type=int, default=THREADS)
    a = ap.parse_args()
    be_nice()
    import torch
    torch.set_num_threads(a.threads)
    from ultralytics import YOLO
    coco = os.path.join(a.out, 'weights', 'yolo11n-pose.pt')
    models = a.models or [f'{coco}@512', f'{coco}@384'] + [f"{p}@{YOLO(p).ckpt['train_args']['imgsz']}" for p in sorted(glob.glob(os.path.join(a.out, 'runs', '*', 'weights', 'best.pt')))]
    cases = subsets(a.out)
    print('pose mAP50-95 (keypoints) / box mAP50-95 (persons found) against the teacher; frames: ' + ', '.join(f'{c} {n}' for c, (_, n) in cases.items()))
    print(f'{"model":44s}' + ''.join(f'{c:>16s}' for c in cases))
    for spec in models:
        m, _, size = spec.partition('@')
        row = f'{os.path.relpath(m, a.out) + "@" + (size or "512"):44s}'
        for case, (y, _) in cases.items():
            r = YOLO(m).val(data=y, split='val', imgsz=int(size or 512), batch=16, device=device(), plots=False, verbose=False)
            row += f'{r.pose.map:9.3f} / {r.box.map:.3f}'
        print(row, flush=True)


if __name__ == '__main__':
    main()
