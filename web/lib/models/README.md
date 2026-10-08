# Pose models

The hub loads all of these and runs the best one that keeps its pose rate (kinect-hub/README.md, "Posen"): `yolo11s-pose-512x448-fp16.onnx` (best), `yolo11s-pose-384x320-fp16.onnx`, `yolo11n-pose-384-fp16.onnx` (cheapest). `yolo11n-pose-fp16.onnx` (n at 512) is the browser's model (`lib/persons-pose.js`); the hub takes it only without the s 384 one, which costs about as much and is better.

| file | model | input | pose mAP vs. YOLO11x on 283 unseen Kinect frames | DirectML, GPU free / under heavy load |
|---|---|---|---|---|
| `yolo11s-pose-512x448-fp16.onnx` | YOLO11s-pose | 1×3×448×512 | 0.726 | 46–55 ms / 145–170 ms |
| `yolo11s-pose-384x320-fp16.onnx` | YOLO11s-pose | 1×3×320×384 | 0.684 | 27–34 ms / 83–92 ms |
| `yolo11n-pose-fp16.onnx` | YOLO11n-pose | 1×3×448×512 | 0.654 | 20–24 ms / 58–61 ms |
| `yolo11n-pose-384-fp16.onnx` | YOLO11n-pose | 1×3×320×384 | 0.603 | 12–14 ms / 33–37 ms |

All are the COCO weights (fine-tuning on the Kinect recordings did not generalize: `pose-training/README.md`), exported as below with `imgsz` = (height, width) of the input. At 384×320 the image is scaled to 384×318 (bilinear) with one gray row above and below; the hub and `persons-pose.js` letterbox any input size. Times: `kinect-hub/pose-bench/README.md`.


Origin: [Ultralytics YOLO11-pose](https://docs.ultralytics.com/tasks/pose/) (COCO-17 keypoints), weights `yolo11n-pose.pt` / `yolo11s-pose.pt` from the Ultralytics assets release, exported for the Kinect infrared image and converted to float16 (half the size, same results).

**License:** Ultralytics YOLO models are AGPL-3.0 (or an Ultralytics enterprise license). Keep that in mind before shipping the installation in a closed product.

Export (Python, `pip install ultralytics onnx onnxconverter-common onnxslim`):

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
