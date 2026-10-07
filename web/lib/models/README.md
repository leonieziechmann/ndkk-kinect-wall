# Pose model

`yolo11n-pose-fp16.onnx`: [Ultralytics YOLO11n-pose](https://docs.ultralytics.com/tasks/pose/) (COCO-17 keypoints), weights `yolo11n-pose.pt` from the Ultralytics assets release v8.4.0, exported for the Kinect infrared image and converted to float16 (half the size, same results). Used by `lib/persons-pose.js`.

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

Input: 1×3×448×512 (the 512×424 infrared image unmirrored, 12 rows of gray 114/255 above and below, gray in all three channels, 0..1). Output: 1×56×A (box cx, cy, w, h, score, then 17 × x, y, confidence).
