# Fine-tunes the browser's pose model (yolo11n-pose, COCO weights) on the Kinect infrared frames labeled by
# the teacher (frames.py, teacher.py). CPU. Writes <out>/runs/<name>/ (weights/best.pt, results.csv, plots).
# Usage: python train.py [--epochs 30] [--name n-ir] [--fraction 1.0] [--resume]
#
# Stopping and going on: after every epoch weights/resume.pt holds the whole state (model, optimizer,
# epoch). Stop at any time (Ctrl+C, end the process: at most the running epoch is lost), or gently:
# create the file <out>/STOP and the training ends after the running epoch. `python train.py --resume
# [--name n-ir]` goes on from the last epoch (and removes STOP).
import argparse, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import REC, THREADS, be_nice, device  # noqa: E402
from teacher import FLIP  # noqa: E402


def dataset(out, train='train'):
    """The dataset description for Ultralytics (labels/ next to images/)."""
    p = os.path.join(out, f'kinect-ir-pose-{train}.yaml')
    root = out.replace('\\', '/')
    open(p, 'w').write(
        f'path: {root}\ntrain: images/{train}\nval: images/val\nkpt_shape: [17, 3]\nflip_idx: {FLIP}\nnames:\n  0: person\n'
    )
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--model', default='yolo11n-pose.pt')
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--imgsz', type=int, default=512, help='input width (512: as in the browser now; 384: 1.5-2x faster there)')
    ap.add_argument('--batch', type=int, default=16)
    ap.add_argument('--fraction', type=float, default=1.0, help='share of the training images (short test runs)')
    ap.add_argument('--name', default='n-ir')
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--train-split', default='train', help='images/<split> to train on (val: a quick test of the pipeline)')
    ap.add_argument('--threads', type=int, default=THREADS, help='CPU threads (the rest stays free)')
    a = ap.parse_args()
    be_nice()
    import torch
    torch.set_num_threads(a.threads)
    from ultralytics import YOLO
    stop_file = os.path.join(a.out, 'STOP')

    def keep_state(trainer):
        # last.pt loses its optimizer when the training ends; resume.pt keeps everything
        shutil.copyfile(trainer.last, os.path.join(os.path.dirname(trainer.last), 'resume.pt'))

    def maybe_stop(trainer):
        if not trainer.stop and os.path.exists(stop_file):
            print(f'{stop_file} found: stopping after epoch {trainer.epoch + 1}; go on with: python train.py --resume --name {a.name}', flush=True)
            trainer.stop = True

    if a.resume:
        if os.path.exists(stop_file):
            os.remove(stop_file)
        w = os.path.join(a.out, 'runs', a.name, 'weights')
        model = YOLO(os.path.join(w, 'resume.pt') if os.path.exists(os.path.join(w, 'resume.pt')) else os.path.join(w, 'last.pt'))
        model.add_callback('on_model_save', keep_state)
        model.add_callback('on_fit_epoch_end', maybe_stop)
        model.train(resume=True)
        return
    w = os.path.join(a.out, 'weights', a.model)
    model = YOLO(w if os.path.exists(w) else a.model)
    model.add_callback('on_model_save', keep_state)
    model.add_callback('on_fit_epoch_end', maybe_stop)
    model.train(
        data=dataset(a.out, a.train_split),
        imgsz=a.imgsz,
        epochs=a.epochs,
        batch=a.batch,
        fraction=a.fraction,
        device=device(),
        workers=a.workers,
        project=os.path.join(a.out, 'runs'),
        name=a.name,
        exist_ok=True,
        # fine-tuning: a small learning rate, the COCO knowledge stays
        optimizer='AdamW',
        lr0=0.0005,
        lrf=0.1,
        warmup_epochs=1,
        cos_lr=True,
        patience=8,
        # infrared is gray: no hue or saturation, but brightness varies (distance to the emitter)
        hsv_h=0.0,
        hsv_s=0.0,
        hsv_v=0.3,
        fliplr=0.5,
        mosaic=1.0,
        close_mosaic=5,
        plots=True,
    )


if __name__ == '__main__':
    main()
