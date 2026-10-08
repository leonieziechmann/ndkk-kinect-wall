# Fine-tunes the browser's pose model (yolo11n-pose, COCO weights) on the Kinect infrared frames labeled by
# the teacher (frames.py, teacher.py). CPU. Writes <out>/runs/<name>/ (weights/best.pt, results.csv, plots).
# Usage: python train.py [--epochs 30] [--name n-ir] [--fraction 1.0] [--resume]
#   [--extra coco/images/train] [--ir-aug] [--degrees 5] [--scale 0.7] [--freeze 10] [--model yolo11s-pose.pt]
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


def dataset(out, train='train', extra=()):
    """The dataset description for Ultralytics (labels/ next to images/); extra: more image folders for training
    (relative to out, e.g. coco/images/train from coco.py)."""
    p = os.path.join(out, f'kinect-ir-pose-{train}' + ''.join('+' + e.split('/')[0] for e in extra) + '.yaml')
    root = out.replace('\\', '/')
    dirs = ', '.join([f'images/{train}', *extra])
    open(p, 'w').write(
        f'path: {root}\ntrain: [{dirs}]\nval: images/val\nkpt_shape: [17, 3]\nflip_idx: {FLIP}\nnames:\n  0: person\n'
    )
    return p


def ir_augment():
    """Ultralytics' Albumentations step replaced by the infrared camera's faults: motion blur (fast arms and
    jumps), gamma and overexposure (distance to the emitter, bright clothes), sensor noise, low resolution (far
    persons). The same in all three channels: the model sees gray."""
    import albumentations as A
    from ultralytics.data import augment as U

    orig = U.Albumentations.__init__

    def init(self, *args, **kwargs):
        orig(self, *args, **kwargs)
        self.contains_spatial = False
        self.transform = A.Compose([
            A.MotionBlur(blur_limit=(3, 13), p=0.25),
            A.RandomGamma(gamma_limit=(60, 160), p=0.3),
            A.RandomBrightnessContrast(brightness_limit=(0.0, 0.35), contrast_limit=(-0.2, 0.4), p=0.2),
            A.GaussNoise(std_range=(0.01, 0.05), per_channel=False, p=0.3),
            A.Downscale(scale_range=(0.4, 0.8), p=0.15),
        ])

    U.Albumentations.__init__ = init


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
    ap.add_argument('--lr0', type=float, default=0.0005)
    ap.add_argument('--extra', nargs='*', default=[], help='more training image folders relative to --out (coco/images/train: gray COCO persons from coco.py, against forgetting)')
    ap.add_argument('--ir-aug', action='store_true', help='infrared augmentation: motion blur, gamma, overexposure, noise, low resolution')
    ap.add_argument('--degrees', type=float, default=0.0, help='random rotation (e.g. 5)')
    ap.add_argument('--scale', type=float, default=0.5, help='random scale gain (0.7: down to 30 %%, far persons)')
    ap.add_argument('--freeze', type=int, default=0, help='freeze the first n layers (10: the backbone)')
    ap.add_argument('--patience', type=int, default=0, help='stop after so many epochs without a better validation (0: never; the validation is noisy while the learning rate is high, the best epochs come when it decays)')
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
        if a.ir_aug:
            ir_augment()
        model.train(resume=True)
        return
    if a.ir_aug:
        ir_augment()
    w = os.path.join(a.out, 'weights', a.model)
    model = YOLO(w if os.path.exists(w) else a.model)
    model.add_callback('on_model_save', keep_state)
    model.add_callback('on_fit_epoch_end', maybe_stop)
    model.train(
        data=dataset(a.out, a.train_split, a.extra),
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
        lr0=a.lr0,
        lrf=0.1,
        warmup_epochs=1,
        cos_lr=True,
        patience=a.patience,
        # infrared is gray: no hue or saturation, but brightness varies (distance to the emitter)
        hsv_h=0.0,
        hsv_s=0.0,
        hsv_v=0.3,
        fliplr=0.5,
        degrees=a.degrees,
        scale=a.scale,
        freeze=a.freeze or None,
        mosaic=1.0,
        close_mosaic=5,
        plots=True,
    )


if __name__ == '__main__':
    main()
