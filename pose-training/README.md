# Pose model training (Kinect infrared)

Fine-tunes the browser's pose model (`web/lib/models/yolo11n-pose-fp16.onnx`, Ultralytics YOLO11n-pose) on the Kinect's infrared image. The data are the local recordings in `recordings/` of the main checkout: the multi-user recordings of 2026-10-08 (catalog: `recordings/katalog/KATALOG.md`), `hops2`/`nohops` and `wand-*`. A large pose model (the **teacher**, YOLO11x-pose) labels the frames; the small model learns to see what it sees.

The data, labels, weights and runs show people. They stay in `recordings/training/` (git-ignored): never commit or upload them. Only these scripts are in git.

## Steps

```bash
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
T="$MAIN/recordings/training"
python -m venv "$T/.venv"                                   # once
"$T/.venv/Scripts/python" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
"$T/.venv/Scripts/python" -m pip install ultralytics onnx onnxruntime onnxconverter-common onnxslim
PY="$T/.venv/Scripts/python"
cd "$T/weights"                                             # the model weights download here
$PY pose-training/frames.py                                 # ~5100 training, ~540 validation frames (PNG)
$PY pose-training/teacher.py --split val --flip             # teacher labels; ~1-1.5 s per frame on the CPU
$PY pose-training/teacher.py --split train --flip
$PY pose-training/train.py --epochs 30                      # hours on the CPU, see "Stopping"
$PY pose-training/eval.py                                   # old vs new on the held-out frames
$PY pose-training/export.py                                 # ONNX + float16 like web/lib/models/README.md
```

(Paths of the scripts relative to the worktree or checkout that has `pose-training/`.)

- **frames.py**: picks the frames (every 12th; validation every 15th) and writes the infrared image exactly as `persons-pose.js` feeds it to the model: unmirrored, gray. Split by recording, so neighboring frames never land on both sides. Validation: `multi-155317`, `multi-150835`, `multi-150334` from 2:20. Never used: `final-*` and `alt-*`, the person tracker's backtest (`recordings/backtest/`), which stays a fair test.
- **teacher.py**: labels with YOLO11x-pose (`--flip` also runs the mirrored image and averages, left and right swapped). Persons from box confidence 0.4, keypoints from 0.5 (others are unlabeled, not "absent"). All raw detections go to `raw/<model>-<split>.json`; `--from-raw` rewrites the labels with other thresholds. `--labels 0 --model yolo11n-pose.pt` gives the small model's detections for `compare.py`.
- **compare.py**: two models' raw detections side by side, with a contact sheet of the frames where they differ most.
- **train.py**: fine-tunes from the COCO weights: AdamW, small learning rate, no hue/saturation augmentation (infrared is gray), brightness ±30 %, flips, mosaic. `--fraction 0.1 --epochs 1` for a quick test, `--train-split val` to test the pipeline before the training labels exist.
- **eval.py**: pose mAP (keypoint similarity, OKS) and box mAP on the validation frames against the teacher, per model.
- **export.py**: ONNX for 448×512, then float16, and a check against the current browser model (same input and output, run with the browser's preprocessing). The result goes into `web/lib/models/` only after the backtest (`recordings/backtest/`) and a check in the browser.

## On Kaggle (free GPU)

`kaggle.py` packs everything for a Kaggle notebook into `recordings/training/kaggle/`: `kinect-pose-daten.zip` (the frames, the weights, the browser's current model; ~1 GB) and `kinect-pose-training.ipynb` (the scripts inside, so it needs nothing from the repository).

1. kaggle.com → Datasets → New Dataset: upload the zip, **Private**, name `kinect-pose-daten`.
2. Code → New Notebook → File → Import Notebook: the `.ipynb`. Settings: Accelerator *GPU T4 x2*, Internet *on* (needs a verified phone number), Add Input: the dataset.
3. *Save Version → Save & Run All*: it runs in the background (about 1–2 h), labels, trains, evaluates, exports, and deletes the copied frames at the end.
4. Output: download `ergebnis.zip` (raw labels, runs with weights and plots, ONNX export, `eval.txt`) and unpack it into `recordings/training/`.

After a change to the scripts: `kaggle.py --no-zip` rebuilds only the notebook. The scripts use the GPU when there is one (`POSE_DEVICE` overrides it).

## Stopping and going on

Everything can stop at any time and go on later:

- **Training:** after every epoch `runs/<name>/weights/resume.pt` holds the whole state (model, optimizer, epoch). End the process at any time; at most the running epoch is lost. Gently: create the file `recordings/training/STOP`, and the training ends after the running epoch. `train.py --resume [--name <name>]` goes on (and removes `STOP`).
- **Teacher labels:** saved every 200 frames; a new run skips the frames already done. `STOP` ends the run after the running batch (remove it before going on).
- All scripts run at the lowest CPU priority and use a quarter of the cores by default (`--threads`): whoever works on the computer, and a live setup, come first.

## License

Ultralytics YOLO models and their fine-tuned weights are AGPL-3.0 (or an Ultralytics enterprise license); see `web/lib/models/README.md`.
