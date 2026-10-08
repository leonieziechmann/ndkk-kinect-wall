# How well models find the persons and their keypoints in the held-out frames (images/val, teacher labels):
# Ultralytics' pose metrics (mAP over keypoint similarity, OKS) at the browser's input size, per model.
# Usage: python eval.py [model[@imgsz] ...]   default: the COCO model at 512 and 384 (the browser now, and
#   downscaled) and every runs/*/weights/best.pt at the input width it was trained for
import argparse, glob, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import REC, THREADS, be_nice, device  # noqa: E402
from train import dataset  # noqa: E402


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
    data = dataset(a.out)
    print(f'{"model":60s} pose mAP50-95  pose mAP50  box mAP50-95  box mAP50')
    for spec in models:
        m, _, size = spec.partition('@')
        r = YOLO(m).val(data=data, split='val', imgsz=int(size or 512), batch=16, device=device(), plots=False, verbose=False)
        print(f'{os.path.relpath(m, a.out) + "@" + (size or "512"):60s} {r.pose.map:13.3f}  {r.pose.map50:10.3f}  {r.box.map:12.3f}  {r.box.map50:9.3f}', flush=True)


if __name__ == '__main__':
    main()
