// persons-pose.js — 2D human poses in the Kinect infrared image with YOLO-pose (Ultralytics
// yolo11n-pose, exported to ONNX for 512×448, models/README.md) on ONNX Runtime Web (WebGPU, else
// WebAssembly). Used by persons-worker.js; the result feeds persons-core.js.
//
//   const pose = await PoseModel.create();
//   const poses = await pose.detect(irU8);   // [{ score, box: [u0, v0, u1, v1], kp: Float32Array(17*3) }]
//
// Coordinates are pixels of the depth/infrared image as the hub sends it (mirrored). Keypoints are
// COCO-17 (JOINTS in persons-core.js) as (u, v, confidence); left/right are the person's own sides.

import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import modelUrl from './models/yolo11n-pose-fp16.onnx?url';

const W = 512;
const H = 424;
const IN_W = 512;
const IN_H = 448;
const PAD_Y = (IN_H - H) / 2; // letterbox: the image keeps its scale, gray bands above and below
const MAX_POSES = 16;

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1; // no cross-origin isolation here: threads are not available anyway
ort.env.logLevel = 'error';

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  return inter / Math.max(1e-6, area(a) + area(b) - inter);
}

export class PoseModel {
  /** Loads the model; WebGPU if the browser has it, else WebAssembly (slow). */
  static async create({ url = modelUrl, providers = ['webgpu', 'wasm'] } = {}) {
    const m = new PoseModel();
    let lastError = null;
    for (const ep of providers) {
      try {
        m.session = await ort.InferenceSession.create(url, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        m.provider = ep;
        break;
      } catch (e) {
        lastError = e;
      }
    }
    if (!m.session) throw new Error(`Pose-Modell nicht ladbar: ${lastError?.message ?? lastError}`);
    m.inputName = m.session.inputNames[0];
    m.outputName = m.session.outputNames[0];
    m.input = new Float32Array(3 * IN_W * IN_H);
    return m;
  }

  /**
   * Poses in one infrared frame (Uint8Array 512×424). minScore: confidence of the person box.
   * Returns at most 16, the most confident first.
   */
  async detect(ir, { minScore = 0.35, nmsIou = 0.5 } = {}) {
    const plane = IN_W * IN_H;
    const x = this.input;
    // gray letterbox bands (as in training), the image mirrored back: the model then sees people
    // the right way round and names their left and right sides correctly
    x.fill(114 / 255);
    for (let v = 0; v < H; v++) {
      const src = v * W;
      const dst = (v + PAD_Y) * IN_W;
      for (let u = 0; u < W; u++) {
        const g = ir[src + W - 1 - u] / 255;
        x[dst + u] = g;
        x[plane + dst + u] = g;
        x[2 * plane + dst + u] = g;
      }
    }
    const tensor = new ort.Tensor('float32', x, [1, 3, IN_H, IN_W]);
    const out = await this.session.run({ [this.inputName]: tensor });
    const t = out[this.outputName];
    const data = t.data; // [1, 56, A]: cx, cy, w, h, score, 17 x (x, y, conf)
    const A = t.dims[2];
    const C = t.dims[1];
    const cands = [];
    for (let a = 0; a < A; a++) {
      const s = data[4 * A + a];
      if (s < minScore) continue;
      const cx = data[a];
      const cy = data[A + a];
      const w = data[2 * A + a];
      const h = data[3 * A + a];
      cands.push({ a, score: s, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] });
    }
    cands.sort((p, q) => q.score - p.score);
    const keep = [];
    for (const c of cands) {
      if (keep.every((k) => iou(k.box, c.box) < nmsIou)) keep.push(c);
      if (keep.length >= MAX_POSES) break;
    }
    // back to image pixels (and mirrored again, like the depth image)
    const unmirror = (px) => W - 1 - px;
    const poses = keep.map((c) => {
      const kp = new Float32Array(51);
      for (let k = 0; k < 17 && 5 + 3 * k + 2 < C; k++) {
        kp[3 * k] = unmirror(data[(5 + 3 * k) * A + c.a]);
        kp[3 * k + 1] = data[(6 + 3 * k) * A + c.a] - PAD_Y;
        kp[3 * k + 2] = data[(7 + 3 * k) * A + c.a];
      }
      const [x0, y0, x1, y1] = c.box;
      return { score: c.score, box: [unmirror(x1), y0 - PAD_Y, unmirror(x0), y1 - PAD_Y], kp };
    });
    tensor.dispose?.();
    t.dispose?.();
    return poses;
  }
}
