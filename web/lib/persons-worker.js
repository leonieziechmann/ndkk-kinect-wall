// persons-worker.js — person tracking off the main thread: the segmentation of the depth image
// (persons-core.js), fed with poses by persons-pose-worker.js (YOLO-pose on WebGPU, its own worker,
// so a busy GPU never holds up the frames here). Started by persons.js, one per page.
//
// The pose model runs whenever it is free, on the newest infrared frame. With delay > 0 (frames) a
// frame waits until the pose of a later frame is there (at most `delay` frames): its keypoints are
// then interpolated between the poses before and after it, as exact as a pose of every frame. With
// delay 0 every frame is processed at once and the keypoints follow the optical flow since the
// last pose.
//
// in:  {type:'port', port} (to the pose worker) · {type:'config', options} · {type:'rays', rays}
//      {type:'recycle', labels, depth, indices} · {type:'frame', seq, captureTimeUs, arrived, depth, ir}
// out: {type:'result', ...} with the buffers transferred

import { PersonTracker, N } from './persons-core.js';

const tracker = new PersonTracker();
const pool = []; // output buffers the main thread gave back
const queue = []; // frames waiting for a later pose (delayed output)
let delay = 12;
let port = null; // to the pose worker
let poseReady = false;
let poseBusy = false;
let poseError = null;
let posedUpTo = -Infinity; // newest frame a pose result is in for
let poseMs = 0;
let poseRuns = 0;

function onPose(m) {
  if (m.ready) {
    poseReady = true;
    return;
  }
  if (m.error && m.seq === undefined) {
    poseError = m.error; // the model did not load
    pump();
    return;
  }
  poseBusy = false;
  if (m.error) poseError = m.error;
  else {
    poseError = null;
    // the frame the pose belongs to is usually still waiting here: its depth checks the pose
    const f = queue.find((q) => q.seq === m.seq);
    tracker.setPoses(m.poses, m.seq, f ? new Uint16Array(f.depth) : null);
    posedUpTo = m.seq;
    poseMs = poseRuns ? 0.9 * poseMs + 0.1 * m.ms : m.ms;
    poseRuns++;
  }
  pump();
}

function frame(m) {
  const ir = m.ir ? new Uint8Array(m.ir) : null;
  if (ir) {
    tracker.addInfrared(m.seq, ir);
    if (port && poseReady && !poseBusy) {
      poseBusy = true;
      tracker.markPoseFrame(m.seq);
      const copy = ir.slice().buffer;
      port.postMessage({ seq: m.seq, ir: copy }, [copy]);
    }
  }
  queue.push(m);
  pump();
}

/** Processes the waiting frames that may go: a pose of them or a later frame is in, or they waited long enough. */
function pump() {
  const newest = queue.length ? queue[queue.length - 1].seq : 0;
  const wait = delay > 0 && poseReady && !poseError;
  while (queue.length) {
    const m = queue[0];
    if (wait && m.seq > posedUpTo && newest - m.seq < delay) break;
    queue.shift();
    run(m);
  }
}

function run(m) {
  const depth = new Uint16Array(m.depth);
  const out = pool.pop() ?? { labels: new Uint8Array(N), depth: new Uint16Array(N), indices: new Uint32Array(N) };
  const r = tracker.process(depth, out, m.seq, m.ir ? new Uint8Array(m.ir) : null);
  const transfer = [m.depth, out.labels.buffer, out.depth.buffer, out.indices.buffer];
  if (m.ir) transfer.push(m.ir);
  postMessage(
    {
      type: 'result',
      seq: m.seq,
      captureTimeUs: m.captureTimeUs,
      arrived: m.arrived,
      persons: r.persons,
      floor: r.floor,
      count: r.count,
      ms: r.stats.ms,
      poseMs,
      poseRuns,
      waiting: queue.length,
      error: poseError,
      input: m.depth,
      inputIr: m.ir ?? null,
      labels: out.labels.buffer,
      depth: out.depth.buffer,
      indices: out.indices.buffer,
    },
    transfer,
  );
}

onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'port':
      port = m.port;
      port.onmessage = (p) => onPose(p.data);
      break;
    case 'config': {
      const { delay: d, ...rest } = m.options ?? {};
      if (typeof d === 'number') delay = Math.max(0, Math.round(d));
      tracker.configure(rest);
      pump();
      break;
    }
    case 'rays':
      tracker.setRays(new Float32Array(m.rays));
      break;
    case 'frame':
      frame(m);
      break;
    case 'recycle':
      if (m.labels && m.depth && m.indices) {
        pool.push({ labels: new Uint8Array(m.labels), depth: new Uint16Array(m.depth), indices: new Uint32Array(m.indices) });
      }
      break;
  }
};
