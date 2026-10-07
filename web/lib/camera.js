// Orbit camera for 3D scenes (ctx.camera). Drag = rotate, wheel = zoom, double click or r = reset,
// space = automatic slow orbit on/off. The state survives hot swaps.
//
// World space: meters, origin at the sensor, x right, y up, z forward (away from the sensor).
// From Kinect camera coordinates (mm, y down):   world = (xSign * x, -y, z) / 1000
// (xSign = ctx.xSign: -1 = geometrically correct (default), +1 = mirror view; key m).
//
// Matrices are column-major Float32Arrays, ready for a WGSL mat4x4f. Clip space as in WebGPU:
// depth 0..1, w = distance along the view axis.

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export class OrbitCamera {
  constructor() {
    this.fovDeg = 70; // horizontal field of view
    this.near = 0.05;
    this.far = 100;
    this.pivotZ = 2.5; // orbits around (0, 0, pivotZ); follows the median depth of the scene
    this.view = new Float32Array(16);
    this.proj = new Float32Array(16);
    this.viewProj = new Float32Array(16);
    this.eye = [0, 0, 0];
    this.target = [0, 0, this.pivotZ];
    this.up = [0, 1, 0];
    this.focalPx = 1; // pixels per meter at 1 m distance: radiusPx = radius * focalPx / clip.w
    this.reset();
  }

  reset(now = performance.now()) {
    Object.assign(this, { yaw: 0, pitch: 14, zoom: 1.6, auto: true, t0: now, autoDeg: 32, autoPeriodS: 28 });
  }

  /** Stops the automatic orbit where it currently is. */
  freeze(now = performance.now()) {
    if (this.auto) {
      [this.yaw, this.pitch] = this.angles(now);
      this.auto = false;
    }
  }

  angles(now) {
    if (!this.auto) return [this.yaw, this.pitch];
    return [this.yaw + this.autoDeg * Math.sin((2 * Math.PI * (now - this.t0)) / (this.autoPeriodS * 1000)), this.pitch];
  }

  /** Runtime: follows the median depth of the scene (mm) so the orbit stays centered. */
  track(medianMm) {
    if (medianMm > 300) this.pivotZ = 0.92 * this.pivotZ + 0.08 * (medianMm / 1000);
  }

  /** Runtime: mouse and keys on a scene canvas. `on` registers listeners that are removed again. */
  attach(canvas, on) {
    let drag = null;
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    on(canvas, 'pointerdown', (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      this.freeze();
      drag = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = 'grabbing';
    });
    on(canvas, 'pointermove', (e) => {
      if (!drag) return;
      this.yaw -= (e.clientX - drag.x) * 0.3;
      this.pitch = clamp(this.pitch + (e.clientY - drag.y) * 0.3, -20, 75);
      drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => {
      drag = null;
      canvas.style.cursor = 'grab';
    };
    on(canvas, 'pointerup', end);
    on(canvas, 'pointercancel', end);
    on(canvas, 'wheel', (e) => {
      e.preventDefault();
      this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1 / 0.9 : 0.9), 0.25, 4);
    }, { passive: false });
    on(canvas, 'dblclick', () => this.reset());
    on(window, 'keydown', (e) => {
      if (e.target?.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey) return;
      if (e.key === ' ') {
        if (this.auto) this.freeze();
        else {
          this.auto = true;
          this.t0 = performance.now();
        }
        e.preventDefault();
      } else if (e.key === 'r') this.reset();
    });
  }

  /** Runtime: recomputes the matrices for this animation frame. */
  update(now, width, height) {
    const [yawDeg, pitchDeg] = this.angles(now);
    const yaw = yawDeg * DEG;
    const pitch = pitchDeg * DEG;
    const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const dist = this.pivotZ * this.zoom;
    const pos = [dist * back[0], dist * back[1], this.pivotZ + dist * back[2]];
    const f = [-back[0], -back[1], -back[2]];
    const r = normalize(cross([0, 1, 0], f));
    const u = cross(f, r);
    const sx = 1 / Math.tan((this.fovDeg * DEG) / 2);
    const sy = (sx * width) / Math.max(1, height);
    const A = this.far / (this.far - this.near);
    const B = (-this.near * this.far) / (this.far - this.near);
    // rows of the view matrix: right, up, forward (+ translation)
    const V = [
      [r[0], r[1], r[2], -dot(r, pos)],
      [u[0], u[1], u[2], -dot(u, pos)],
      [f[0], f[1], f[2], -dot(f, pos)],
      [0, 0, 0, 1],
    ];
    const P = [
      [sx, 0, 0, 0],
      [0, sy, 0, 0],
      [0, 0, A, B],
      [0, 0, 1, 0],
    ];
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        this.view[j * 4 + i] = V[i][j];
        this.proj[j * 4 + i] = P[i][j];
        let s = 0;
        for (let k = 0; k < 4; k++) s += P[i][k] * V[k][j];
        this.viewProj[j * 4 + i] = s;
      }
    this.eye = pos;
    this.target = [0, 0, this.pivotZ];
    this.up = u;
    this.focalPx = (sx * width) / 2;
  }
}
