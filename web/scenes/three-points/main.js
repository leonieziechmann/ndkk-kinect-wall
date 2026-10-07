// three.js example (WebGPURenderer): the Kinect points as glowing, colored sprites, OrbitControls.
// Positions are computed on the CPU from depth + LUT whenever a new Kinect frame arrives.
// three.js: always import from 'three/webgpu' and 'three/tsl' (do not mix in plain 'three').

import * as THREE from 'three/webgpu';
import { instancedDynamicBufferAttribute, shapeCircle } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const W = 512;
const H = 424;

let renderer, scene, camera, controls, sprite, material, posAttr, colAttr;
const near = new THREE.Color();
const far = new THREE.Color();

function updatePoints(ctx) {
  const k = ctx.kinect;
  const p = ctx.params;
  const depth = k.depth.data; // u16 mm, 0 = no measurement
  const rays = k.rays; // x, y per pixel: point = (x*z, y*z, z)
  const ir = k.ir?.data; // u8
  const pos = posAttr.array;
  const col = colAttr.array;
  const step = Number(p.step) || 2;
  near.set(p.nearColor);
  far.set(p.farColor);
  let n = 0;
  for (let v = 0; v < H; v += step) {
    for (let u = 0; u < W; u += step) {
      const i = v * W + u;
      const mm = depth[i];
      if (!mm) continue;
      const z = mm * 0.001;
      // Kinect (x right, y down, z forward) -> three.js (y up, the camera looks along -z)
      pos[n * 3] = ctx.xSign * rays[i * 2] * z;
      pos[n * 3 + 1] = -rays[i * 2 + 1] * z;
      pos[n * 3 + 2] = -z;
      const t = Math.min(1, Math.max(0, (z - 0.8) / 3.5));
      const b = ir ? 0.3 + (p.irBoost * ir[i]) / 255 : 1;
      col[n * 3] = (near.r + (far.r - near.r) * t) * b;
      col[n * 3 + 1] = (near.g + (far.g - near.g) * t) * b;
      col[n * 3 + 2] = (near.b + (far.b - near.b) * t) * b;
      n++;
    }
  }
  for (const a of [posAttr, colAttr]) {
    a.clearUpdateRanges();
    a.addUpdateRange(0, n * 3);
    a.needsUpdate = true;
  }
  sprite.count = n;
}

export default {
  streams: ['depth', 'ir'],

  params: {
    step: { value: 2, options: { 'jedes Pixel': 1, 'jedes 2.': 2, 'jedes 3.': 3 }, label: 'Dichte' },
    size: { value: 0.012, min: 0.002, max: 0.08, step: 0.001, label: 'Punktgröße (m)' }, // world units: sizeAttenuation
    irBoost: { value: 0.8, min: 0, max: 2, step: 0.05, label: 'IR-Helligkeit' },
    nearColor: { value: '#ff8a3d', label: 'Farbe nah' },
    farColor: { value: '#3d7bff', label: 'Farbe fern' },
    autoRotate: { value: true, label: 'Auto-Rotation' },
  },

  async setup(ctx) {
    renderer = new THREE.WebGPURenderer({ canvas: ctx.canvas, antialias: true });
    await renderer.init();
    renderer.setPixelRatio(1); // ctx.width/height are device pixels already
    renderer.setSize(ctx.width, ctx.height, false);
    renderer.setClearColor(0x0b0b0e);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(55, ctx.width / ctx.height, 0.05, 50);
    camera.position.set(0, 0.25, 0.6);
    controls = new OrbitControls(camera, ctx.canvas);
    controls.target.set(0, 0, -2.5);
    controls.enableDamping = true;
    controls.autoRotateSpeed = 0.8;

    posAttr = new THREE.InstancedBufferAttribute(new Float32Array(W * H * 3), 3);
    colAttr = new THREE.InstancedBufferAttribute(new Float32Array(W * H * 3), 3);
    material = new THREE.PointsNodeMaterial({ blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    material.positionNode = instancedDynamicBufferAttribute(posAttr);
    material.colorNode = instancedDynamicBufferAttribute(colAttr);
    material.opacityNode = shapeCircle();
    sprite = new THREE.Sprite(material);
    sprite.count = 0;
    sprite.frustumCulled = false;
    scene.add(sprite);
  },

  resize(ctx) {
    renderer.setSize(ctx.width, ctx.height, false);
    camera.aspect = ctx.width / ctx.height;
    camera.updateProjectionMatrix();
  },

  frame(ctx) {
    if (ctx.kinect.fresh.depth) updatePoints(ctx);
    material.size = ctx.params.size;
    controls.autoRotate = ctx.params.autoRotate;
    controls.update(ctx.dt);
    renderer.render(scene, camera);
    ctx.status = `${Math.round(sprite.count / 1000)}k Punkte`;
  },

  dispose() {
    controls?.dispose();
    renderer?.dispose();
  },
};
