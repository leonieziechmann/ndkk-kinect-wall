# Exports a trained model the way web/lib/models/README.md describes (ONNX for 448x512, then float16) and
# checks that it is a drop-in for web/lib/models/yolo11n-pose-fp16.onnx: the same input and output, run on
# a validation frame with the browser's preprocessing (persons-pose.js), side by side with the old model.
# Usage: python export.py [--name n-ir] [--weights best.pt]  ->  <out>/export/<name>.onnx, <name>-fp16.onnx
import argparse, glob, os, shutil, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from frames import MAIN, REC, be_nice  # noqa: E402


def browser_input(png, w=512, h=448):
    """persons-pose.js: the (already unmirrored) infrared image scaled to width w, gray in 3 channels, gray rows above and below."""
    from PIL import Image
    im = Image.open(png).convert('L')
    ih = round(424 * w / 512)
    g = np.asarray(im.resize((w, ih), Image.BILINEAR) if w != 512 else im, np.float32) / 255
    x = np.full((1, 3, h, w), 114 / 255, np.float32)
    pad = (h - ih) // 2
    x[0, :, pad : pad + ih, :] = g[None]
    return x


def persons(y, min_score=0.35):
    y = y[0]
    return int((y[4] > min_score).sum()), y.shape


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(REC, 'training'))
    ap.add_argument('--name', default='n-ir')
    ap.add_argument('--weights', default='best.pt')
    ap.add_argument('--imgsz', type=int, default=0, help='input width (default: the one it was trained for); the height fits 512x424 scaled, a multiple of 32')
    a = ap.parse_args()
    be_nice()
    from ultralytics import YOLO
    import onnx
    import onnxruntime as ort
    from onnxconverter_common import float16

    src = os.path.join(a.out, 'runs', a.name, 'weights', a.weights)
    dst = os.path.join(a.out, 'export')
    os.makedirs(dst, exist_ok=True)
    w = a.imgsz or YOLO(src).ckpt['train_args']['imgsz']
    h = -(-round(424 * w / 512) // 32) * 32  # 512 -> 448, 384 -> 320
    fp32 = YOLO(src).export(format='onnx', imgsz=(h, w), opset=17, simplify=True)
    p32 = os.path.join(dst, f'{a.name}.onnx')
    shutil.move(fp32, p32)
    m = onnx.load(p32)
    del m.graph.value_info[:]  # stale shapes would break the conversion
    m = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=float16.DEFAULT_OP_BLOCK_LIST + ['Resize'])
    m = onnx.shape_inference.infer_shapes(m)
    p16 = os.path.join(dst, f'{a.name}-fp16.onnx')
    onnx.save(m, p16)

    old = os.path.join(MAIN, 'web', 'lib', 'models', 'yolo11n-pose-fp16.onnx')
    png = sorted(glob.glob(os.path.join(a.out, 'images', 'val', '*.png')))[len(glob.glob(os.path.join(a.out, 'images', 'val', '*.png'))) // 2]
    for label, path in (('old', old), ('new fp32', p32), ('new fp16', p16)):
        s = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
        i = s.get_inputs()[0]
        o = s.get_outputs()[0]
        y = s.run(None, {i.name: browser_input(png, i.shape[3], i.shape[2])})[0]
        print(f'{label:9s} in {i.name} {i.shape} {i.type} | out {o.name} {list(y.shape)} | candidates > 0.35: {persons(y)[0]} | {os.path.getsize(path) / 1e6:.1f} MB')
    print(p16)


if __name__ == '__main__':
    main()
