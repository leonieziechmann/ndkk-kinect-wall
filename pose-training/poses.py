# Poses of a pose model (ONNX) on every infrared frame of an extracted recording, the way persons-pose.js runs
# it, in the format of recordings/backtest/poses/*.poses.json (per frame: score, box, 17 x (x, y, conf) in
# depth image pixels, mirrored like the hub's image). Like recordings/backtest/poses.py, with a choice of model.
# Usage: python poses.py <model.onnx> <work/name> <out.poses.json>
#   work/name: from recordings/backtest/k2rec.py (<name>.ir)
import json, os, sys, time
import numpy as np
import onnxruntime as ort

W, PAD = 512, 12


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    ar = lambda r: max(0, r[2] - r[0]) * max(0, r[3] - r[1])
    return inter / max(1e-6, ar(a) + ar(b) - inter)


def main():
    model, src, dst = sys.argv[1:4]
    so = ort.SessionOptions()
    so.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 4)
    if os.name == 'nt':
        import ctypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = ctypes.c_void_p
        k.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k.SetPriorityClass(k.GetCurrentProcess(), 0x40)  # idle: work comes first
    s = ort.InferenceSession(model, so, providers=['CPUExecutionProvider'])
    name = s.get_inputs()[0].name
    ir = np.fromfile(src + '.ir', np.uint8).reshape(-1, 424, 512)
    out = []
    t0 = time.time()
    for f in range(len(ir)):
        if f % 500 == 0:
            print(f, round(time.time() - t0, 1), flush=True)
        x = np.full((1, 3, 448, 512), 114 / 255, np.float32)
        x[0, :, PAD : PAD + 424, :] = ir[f][:, ::-1][None] / 255.0
        y = s.run(None, {name: x})[0][0].astype(np.float32)
        idx = np.where(y[4] > 0.35)[0]
        keep = []
        for a in sorted(idx, key=lambda a: -y[4, a]):
            cx, cy, w, h = y[0:4, a]
            box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
            if all(iou(k[1], box) < 0.5 for k in keep):
                keep.append((a, box))
        poses = []
        for a, box in keep[:16]:
            kp = []
            for k in range(17):
                kp += [float(W - 1 - y[5 + 3 * k, a]), float(y[6 + 3 * k, a] - PAD), float(y[7 + 3 * k, a])]
            poses.append({'score': float(y[4, a]), 'box': [float(W - 1 - box[2]), float(box[1] - PAD), float(W - 1 - box[0]), float(box[3] - PAD)], 'kp': kp})
        out.append(poses)
    json.dump(out, open(dst, 'w'))
    print(dst, len(out), 'frames', round(sum(len(p) for p in out) / max(1, len(out)), 2), 'poses/frame')


if __name__ == '__main__':
    main()
