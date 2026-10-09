# Pose models

The hub loads all of these and runs the best one that keeps its pose rate (kinect-hub/README.md, "Posen"): `yolo11s-pose-512x448-fp16.onnx` (best), `yolo11s-pose-384x320-fp16.onnx`, `yolo11n-pose-384-fp16.onnx` (cheapest). `yolo11n-pose-fp16.onnx` (n at 512) is the browser's model (`lib/persons-pose.js`); the hub takes it only without the s 384 one, which costs about as much and is better.

| file | model | input | pose mAP vs. the teacher on 800 unseen Kinect frames (final setup) | DirectML, GPU free / under heavy load |
|---|---|---|---|---|
| `yolo11s-pose-512x448-fp16.onnx` | YOLO11s-pose, **fine-tuned** (`r3f-s512`) | 1×3×448×512 | 0.723 (0.859); COCO weights 0.722 (0.829) | 46–55 ms / 145–170 ms |
| `yolo11s-pose-384x320-fp16.onnx` | YOLO11s-pose, **fine-tuned** (`r3f-s384`) | 1×3×320×384 | 0.682 (0.837); COCO weights 0.617 (0.808) | 27–34 ms / 83–92 ms |
| `yolo11n-pose-fp16.onnx` | YOLO11n-pose, COCO | 1×3×448×512 | 0.606 (0.790) | 20–24 ms / 58–61 ms |
| `yolo11n-pose-384-fp16.onnx` | YOLO11n-pose, COCO | 1×3×320×384 | 0.561 (0.752) | 12–14 ms / 33–37 ms |

**The two s models are fine-tuned on the Kinect infrared image** (`pose-training/README.md`, round 3, recipe `r3f`): teacher labels from YOLO11x at 1024 and 512 on the recordings of 2026-10-08, learning rate 5e-5 with the backbone (first 10 layers) frozen, gray COCO person images mixed in against forgetting, 50 epochs. Unseen frames are recordings no training saw: `final-*` (the final setup on another day), the old small room (`alt-*`, where the fine-tuned models are a little behind the COCO weights) and someone right in front of the sensor, overexposed (where s 384 is three times better). The 512 model is the last epoch, the 384 one the best on the held-out frames. The n models are the COCO weights. The COCO s weights are in git history (before 2026-10-09) and can be exported as below.

The fine-tuned models sometimes report a "person" without a single sure joint at the image edge while nobody is in view: the hub drops poses with fewer than 3 keypoints of confidence 0.5 (`kinect-hub/src/yolo.rs`).

All are exported as below with `imgsz` = (height, width) of the input. At 384×320 the image is scaled to 384×318 (bilinear) with one gray row above and below; the hub and `persons-pose.js` letterbox any input size. Times: `kinect-hub/pose-bench/README.md` (measured with the COCO weights; the fine-tuned ones have the same architecture).

Origin: [Ultralytics YOLO11-pose](https://docs.ultralytics.com/tasks/pose/) (COCO-17 keypoints), weights `yolo11n-pose.pt` / `yolo11s-pose.pt` from the Ultralytics assets release (the s ones fine-tuned with `pose-training/train.py`), exported for the Kinect infrared image and converted to float16 (half the size, same results).

**License:** Ultralytics YOLO models, and weights fine-tuned from them, are AGPL-3.0 (or an Ultralytics enterprise license). Keep that in mind before shipping the installation in a closed product.

Export (Python, `pip install ultralytics onnx onnxconverter-common onnxslim`; `pose-training/export.py` does the same for a trained run):

```python
from ultralytics import YOLO
YOLO('yolo11n-pose.pt').export(format='onnx', imgsz=(448, 512), opset=17, simplify=True)   # -> yolo11n-pose.onnx

import onnx
from onnxconverter_common import float16
m = onnx.load('yolo11n-pose.onnx')
del m.graph.value_info[:]                     # stale shapes would break the conversion
m = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=float16.DEFAULT_OP_BLOCK_LIST + ['Resize'])
m = onnx.shape_inference.infer_shapes(m)
onnx.save(m, 'yolo11n-pose-fp16.onnx')
```

Input (512 models): 1×3×448×512 (the 512×424 infrared image unmirrored, 12 rows of gray 114/255 above and below, gray in all three channels, 0..1). Output: 1×56×A (box cx, cy, w, h, score, then 17 × x, y, confidence).
