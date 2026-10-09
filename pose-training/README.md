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

## On Colab (colab CLI, e.g. an A100 with Colab Pro)

The [colab CLI](https://github.com/googlecolab/google-colab-cli) runs on Linux and macOS; on Windows in WSL (`python3 -m venv ~/colab-cli && ~/colab-cli/bin/pip install google-colab-cli`). Log in once yourself (it prints a Google link, you paste the code back): `colab --auth=oauth2 sessions`.

```bash
colab new -s pose --gpu A100
colab upload -s pose recordings/training/kaggle/kinect-pose-daten.zip /content/kinect-pose-daten.zip   # from kaggle.py
colab upload -s pose pose-training/<script>.py /content/pose-training/<script>.py                     # each script
colab exec -s pose -f pose-training/colab_job.py        # starts the whole run in the background on the VM
echo "print(open('/content/job.log').read()[-3000:])" | colab exec -s pose                            # progress
colab download -s pose /content/ergebnis.zip recordings/training/ergebnis.zip                         # once /content/DONE exists
colab stop -s pose
```

`colab_job.py` labels with the teacher (both splits, mirrored), trains at 512 (`n-ir`, as in the browser now) and at 384 (`n-ir-384`, faster in the browser), evaluates and exports both. A step that is done is skipped when it starts again; an interrupted training goes on from `resume.pt`.

## On Kaggle (free GPU)

`kaggle.py` packs everything for a Kaggle notebook into `recordings/training/kaggle/`: `kinect-pose-daten.zip` (the frames, the weights, the browser's current model; ~1 GB) and `kinect-pose-training.ipynb` (the scripts inside, so it needs nothing from the repository).

1. kaggle.com → Datasets → New Dataset: upload the zip, **Private**, name `kinect-pose-daten`.
2. Code → New Notebook → File → Import Notebook: the `.ipynb`. Settings: Accelerator *GPU T4 x2*, Internet *on* (needs a verified phone number), Add Input: the dataset.
3. *Save Version → Save & Run All*: it runs in the background (about 1–2 h), labels, trains, evaluates, exports, and deletes the copied frames at the end.
4. Output: download `ergebnis.zip` (raw labels, runs with weights and plots, ONNX export, `eval.txt`) and unpack it into `recordings/training/`.

After a change to the scripts: `kaggle.py --no-zip` rebuilds only the notebook. The scripts use the GPU when there is one (`POSE_DEVICE` overrides it).

## Results (2026-10-08, Colab A100)

Pose mAP50-95 against the teacher. "val" is the held-out frames (other recordings of the same days, same setup). "unseen" is 283 frames of the backtest recordings, which no training ever saw: `final-*` (final setup, another day) and `alt-live2` (another room, up to 5 people).

| model | val all | val T-pose | val multi | unseen all | final-solo | final-kleid | alt-live2 |
|---|---|---|---|---|---|---|---|
| yolo11n COCO @512 (browser) | 0.764 | 0.863 | 0.851 | 0.654 | 0.696 | 0.772 | 0.479 |
| yolo11n COCO @384 | 0.698 | 0.812 | 0.776 | 0.603 | 0.675 | 0.734 | 0.417 |
| yolo11n fine-tuned @512 (`n-ir-2`, 50 epochs) | 0.816 | 0.978 | 0.933 | 0.586 | 0.687 | 0.792 | 0.342 |
| yolo11n fine-tuned @384 (`n-ir-384-2`) | 0.799 | 0.963 | 0.900 | 0.536 | 0.661 | 0.784 | 0.264 |
| yolo11s COCO @512 | | | | 0.726 | 0.750 | 0.846 | 0.570 |
| yolo11s COCO @384 | | | | 0.684 | 0.722 | 0.790 | 0.535 |
| yolo11m COCO @512 | | | | 0.800 | 0.782 | 0.907 | 0.708 |

- The fine-tuning learned the recorded sessions (people, clothes, the T-pose val is the end of a recording whose start is in training), not the setup: on unseen sessions of the final setup it is even, in another room much worse (it finds fewer people: tracker backtest on alt-live2 with 25 % fewer person pixels). The browser keeps the COCO model.
- The larger model is the lever: yolo11s at 384 beats yolo11n at 512 everywhere.
- A further fine-tuning would need: a validation split by day/session, a low learning rate and a frozen backbone, COCO person images (gray) mixed in against forgetting.

## Results round 3 (2026-10-09, Colab: 2 A100 + 2 L4)

The hub runs the pose model now (DirectML), the target is yolo11s (384 by default, 512 when the GPU has room). Teacher: yolo11x at 1024+768 and at 512, both mirrored, a keypoint labeled where both agree (`ensemble.py`). "unseen" is now 800 frames (`test/`, `kinect-pose-test.zip`): `final-*` (final setup, another day), `alt-*` (the old small room), `room` (someone right in front of the sensor, overexposed). Pose mAP50-95 against that teacher, best.pt (last.pt where better):

| model | recipe | val | unseen | final | alt | room |
|---|---|---|---|---|---|---|
| yolo11n COCO @512 | – | 0.783 | 0.606 | 0.790 | 0.562 | 0.370 |
| yolo11s COCO @384 | – | 0.787 | 0.617 | 0.808 | 0.632 | 0.163 |
| yolo11s COCO @512 | – | 0.875 | 0.722 | 0.829 | 0.678 | 0.585 |
| yolo11m COCO @512 | – | 0.913 | 0.763 | 0.878 | 0.780 | 0.532 |
| r3a n@512 | lr 5e-4, 80 epochs | 0.840 | 0.440 | 0.786 | 0.359 | 0.012 |
| r3b n@512 | + gray COCO | 0.829 | 0.558 | 0.805 | 0.473 | 0.184 |
| r3b-s384 | lr 5e-4, gray COCO | 0.851 | 0.578 | 0.806 | 0.484 | 0.306 |
| r3c-s384 | + IR augmentation | 0.793 | 0.550 | 0.782 | 0.442 | 0.317 |
| r3e-s384 | lr 1e-4, COCO, IR aug, 40 epochs | 0.843 | 0.629 | 0.831 | 0.552 | 0.363 |
| r3d-s384 | lr 5e-5, frozen backbone (10 layers), COCO, IR aug, 30 epochs | 0.847 | 0.676 | 0.837 | 0.606 | 0.489 |
| r3d50-s384 | same, 60 epochs | 0.846 | 0.647 | 0.832 | 0.596 | 0.412 |
| **r3f-s384** | lr 5e-5, frozen backbone, COCO, no IR aug, 50 epochs | **0.854** | **0.682** | 0.837 | 0.598 | 0.511 |
| r3c-s512 | lr 5e-4, COCO, IR aug | 0.841 | 0.563 | 0.805 | 0.496 | 0.246 |
| r3d-s512 | as r3d-s384 at 512, 50 epochs | 0.877 | 0.683 | 0.853 | 0.663 | 0.419 |

- **Forgetting is the problem, the learning rate the lever.** At the usual fine-tuning rate (5e-4) every model learns the recorded days and loses other rooms (alt, room). Gray COCO persons help a little; a 10x smaller rate with the backbone frozen keeps the general knowledge.
- **r3f-s384 beats the COCO weights at 384** on the unseen frames (+0.065), in the final setup (+0.03) and on overexposed people (3x), and is slightly behind in the old room. Its person boxes are close to COCO's (box mAP 0.786 against 0.818; with IR augmentation 0.739).
- **At 512 the COCO weights stay ahead overall** (0.722 against 0.683), mainly on the overexposed `room`; in the final setup the fine-tuned model is better (0.853 against 0.829).
- The infrared augmentation (blur, gamma, noise, downscaling, rotation) did not help; longer training at the small rate neither.
- Colab: VMs whose kernel stays idle are reclaimed (keep them busy with a tiny `colab exec`), `colab exec` can hang (time-limit every call), back up `resume.pt` off the VM, and settings set with `os.environ` in one `colab exec` stay for the next (the job scripts clear them).

**Round 3 at 512, and round 5 (labels of four teachers):** the teachers yolo11x at 1024 and at 512, ViTPose++ huge and Sapiens2 1b (`topdown.py`, top-down on the yolo11x boxes), a keypoint labeled where 3 of 4 agree. Unseen frames, against these four-teacher labels:

| model | unseen | final | alt | room |
|---|---|---|---|---|
| yolo11s COCO @384 | 0.575 | 0.807 | 0.607 | 0.084 |
| r3f-s384 (two-teacher labels) | 0.662 | 0.842 | 0.571 | 0.482 |
| r5-s384 (four-teacher labels, r3f recipe) | 0.647 | 0.847 | 0.602 | 0.350 |
| yolo11s COCO @512 | 0.674 | 0.831 | 0.636 | 0.457 |
| r3f-s512 (against the two-teacher labels: 0.723, COCO 0.722) | | | | |
| r5-s512 (four-teacher labels) | 0.672 | 0.861 | 0.625 | 0.412 |
| yolo11m COCO @512 | 0.757 | 0.879 | 0.801 | 0.467 |

- The ranking is the same with either label set. Better labels (four teachers) add nothing measurable: the labels are not the bottleneck, forgetting was.
- At 512 the fine-tuned model (r3f-s512, r5-s512) equals the COCO weights overall and is better in the final setup (+0.03).

**Tracker backtest** (`recordings/backtest`, per-frame poses with `poses.py`, hybrid LAT 4): r3f-s384 finds the person in many more frames (final-solo: 75 frames without a pose instead of 295), but also reports a phantom at the right image edge before the person enters (score 0.4–0.6, no confident keypoint): one extra id. Keeping only poses with at least 3 keypoints above 0.5 removes it (COCO loses a few edge poses with it too). With that filter, against COCO s@384: final-solo and final-kleid equal or slightly better (flicker p99 0.57 % against 0.61 %, 1.94 % against 2.11 %, one id each); alt-live2 (the old crowded room) worse, 8–9 ids instead of 5–6 at LAT 3/4/5.

## Stopping and going on

Everything can stop at any time and go on later:

- **Training:** after every epoch `runs/<name>/weights/resume.pt` holds the whole state (model, optimizer, epoch). End the process at any time; at most the running epoch is lost. Gently: create the file `recordings/training/STOP`, and the training ends after the running epoch. `train.py --resume [--name <name>]` goes on (and removes `STOP`).
- **Teacher labels:** saved every 200 frames; a new run skips the frames already done. `STOP` ends the run after the running batch (remove it before going on).
- All scripts run at the lowest CPU priority and use a quarter of the cores by default (`--threads`): whoever works on the computer, and a live setup, come first.

## License

Ultralytics YOLO models and their fine-tuned weights are AGPL-3.0 (or an Ultralytics enterprise license); see `web/lib/models/README.md`.
