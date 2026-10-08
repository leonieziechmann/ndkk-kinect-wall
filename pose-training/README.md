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

## Stopping and going on

Everything can stop at any time and go on later:

- **Training:** after every epoch `runs/<name>/weights/resume.pt` holds the whole state (model, optimizer, epoch). End the process at any time; at most the running epoch is lost. Gently: create the file `recordings/training/STOP`, and the training ends after the running epoch. `train.py --resume [--name <name>]` goes on (and removes `STOP`).
- **Teacher labels:** saved every 200 frames; a new run skips the frames already done. `STOP` ends the run after the running batch (remove it before going on).
- All scripts run at the lowest CPU priority and use a quarter of the cores by default (`--threads`): whoever works on the computer, and a live setup, come first.

## License

Ultralytics YOLO models and their fine-tuned weights are AGPL-3.0 (or an Ultralytics enterprise license); see `web/lib/models/README.md`.
