// persons-pose-worker.js — the pose model (persons-pose.js, YOLO-pose on WebGPU) in a worker of its
// own, so that a busy GPU never holds up the segmentation in persons-worker.js. Started by
// persons.js, which connects it to persons-worker.js through a MessagePort.
//
// port in:  {seq, ir}          one infrared frame (Uint8Array buffer), sent only while idle
// port out: {ready} · {seq, poses, ms} · {seq, error} · {error} (the model did not load)
// out (to the page): {type:'status', provider | error}

import { PoseModel } from './persons-pose.js';

let model = null;
let loadError = null;
let port = null;

PoseModel.create()
  .then(async (m) => {
    // the first run compiles the GPU programs (seconds): done on an empty image before anyone waits
    await m.detect(new Uint8Array(512 * 424));
    model = m;
    postMessage({ type: 'status', provider: m.provider });
    port?.postMessage({ ready: true });
  })
  .catch((e) => {
    loadError = String(e?.message ?? e);
    postMessage({ type: 'status', error: loadError });
    port?.postMessage({ error: loadError });
  });

async function detect(seq, ir) {
  const t0 = performance.now();
  try {
    const poses = await model.detect(new Uint8Array(ir));
    port.postMessage({ seq, poses, ms: performance.now() - t0 });
  } catch (e) {
    const error = String(e?.message ?? e);
    postMessage({ type: 'status', error });
    port.postMessage({ seq, error });
  }
}

onmessage = (e) => {
  if (e.data?.type !== 'port') return;
  port = e.data.port;
  port.onmessage = (m) => {
    if (model && m.data?.ir) detect(m.data.seq, m.data.ir);
  };
  if (model) port.postMessage({ ready: true });
  else if (loadError) port.postMessage({ error: loadError });
};
