// A Motion Canvas node that shows a three.js scene. All ThreeViews share one WebGLRenderer per
// anti-aliasing mode; each view renders into the bottom-left corner of that renderer's canvas
// (grown to the largest view, never shrunk) and copies the result into the 2D context right away,
// in the same task, so the drawing buffer is still valid.
//
// Deterministic: no clocks. A World3D owns the THREE.Scene and an update function that reads
// Motion Canvas signals; it runs inside a computed signal, so it runs once per changed frame no
// matter how many views show the world (split screen), and the shadow map is rendered only once
// per world version.
//
// Pixel size: the node asks the 2D context for its current transform (resolution scale, parent
// scales, cache offsets included) and renders exactly as many device pixels as it covers, times
// `supersample`. 1080p stays sharp, a 0.5-scale preview stays cheap.

import { Rect, RectProps, initial, signal } from '@motion-canvas/2d';
import { SignalValue, SimpleSignal, createComputed } from '@motion-canvas/core';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type ToneMap = 'aces' | 'agx' | 'neutral' | 'none';

const TONE: Record<ToneMap, THREE.ToneMapping> = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
  none: THREE.NoToneMapping,
};


// ---------------------------------------------------------------- shared renderers

interface Shared {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  lost: boolean;
  /** world version whose shadow map is in this renderer's light targets */
  shadowOf: WeakMap<World3D, number>;
  /** prefiltered RoomEnvironment, made by (and only valid in) this renderer */
  env: THREE.Texture | null;
}

const shared = new Map<boolean, Shared>();

/** sees every layer, looks at nothing: the main pass of the shadow-only render draws ~0 pixels */
const shadowPassCam = new THREE.PerspectiveCamera(1, 1, 0.01, 0.02);
shadowPassCam.layers.enableAll();
shadowPassCam.position.set(0, -1e4, 0);
shadowPassCam.lookAt(0, -2e4, 0);
shadowPassCam.updateMatrixWorld();

function getRenderer(msaa: boolean): Shared {
  const old = shared.get(msaa);
  // the event arrives as a separate task: also ask the context itself
  if (old && !old.lost && !old.renderer.getContext().isContextLost()) return old;
  if (old) old.renderer.dispose();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: msaa,
    alpha: false,
    // read back in the same task, so not strictly needed; keeps the image if a browser
    // composites in between (editor preview with devtools open, etc.)
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // r186: PCFSoftShadowMap is gone, PCF + radius is soft
  renderer.shadowMap.autoUpdate = false;
  renderer.setScissorTest(true);
  const s: Shared = { renderer, canvas, lost: false, shadowOf: new WeakMap(), env: null };
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    s.lost = true; // the next draw builds a new renderer; three re-uploads geometry and textures
  });
  shared.set(msaa, s);
  return s;
}

/** grows the shared canvas in steps of 256 px so a slowly growing view does not reallocate every frame */
function ensureSize(s: Shared, w: number, h: number) {
  const cw = s.canvas.width;
  const ch = s.canvas.height;
  if (w <= cw && h <= ch) return;
  const nw = Math.max(cw, Math.ceil(w / 256) * 256);
  const nh = Math.max(ch, Math.ceil(h / 256) * 256);
  s.renderer.setSize(nw, nh, false);
}

// ---------------------------------------------------------------- the world

/** the live world per key: Motion Canvas re-runs a scene's generator on every reset and seek backwards */
const live = new Map<string, World3D>();

/**
 * A THREE.Scene plus an update function that reads signals (runs at most once per frame).
 * Build it inside the scene generator with a key unique to the scene: creating a world disposes the
 * previous one with the same key, or every re-run would leave its buffers and shadow maps on the GPU.
 */
export class World3D {
  public readonly scene = new THREE.Scene();
  /** > 0: image-based light from three's RoomEnvironment (soft studio), this strong */
  public envIntensity = 0;
  private version = 0;
  /** read in draw: runs `update` when a signal it read has changed */
  public readonly sync: () => number;

  public constructor(key: string, update: (scene: THREE.Scene) => void) {
    live.get(key)?.dispose();
    live.set(key, this);
    this.sync = createComputed(() => {
      update(this.scene);
      return ++this.version;
    });
  }

  /** frees GPU memory of everything in the scene (geometries, materials, their textures, shadow maps) */
  public dispose() {
    const mats = new Set<THREE.Material>();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
      const l = o as THREE.DirectionalLight;
      if (l.isLight && l.shadow) l.shadow.dispose();
    });
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  }
}

// ---------------------------------------------------------------- the node

export interface ThreeViewProps extends RectProps {
  world: World3D;
  camera: THREE.Camera;
  /** render this many times the device pixels and let drawImage filter down (1 = off) */
  supersample?: SignalValue<number>;
  /** hardware multisampling of the WebGL context (4× in SwiftShader) */
  msaa?: SignalValue<boolean>;
  shadows?: SignalValue<boolean>;
  toneMapping?: SignalValue<ToneMap>;
  exposure?: SignalValue<number>;
}

export class ThreeView extends Rect {
  @initial(1) @signal() public declare readonly supersample: SimpleSignal<number, this>;
  @initial(true) @signal() public declare readonly msaa: SimpleSignal<boolean, this>;
  @initial(true) @signal() public declare readonly shadows: SimpleSignal<boolean, this>;
  @initial<ToneMap>('neutral') @signal() public declare readonly toneMapping: SimpleSignal<ToneMap, this>;
  @initial(1) @signal() public declare readonly exposure: SimpleSignal<number, this>;

  public readonly world: World3D;
  public readonly camera: THREE.Camera;

  public constructor(props: ThreeViewProps) {
    super(props);
    this.world = props.world;
    this.camera = props.camera;
  }

  protected override drawShape(ctx: CanvasRenderingContext2D) {
    const size = this.computedSize();
    const w = size.width;
    const h = size.height;
    if (w < 1 || h < 1) return;

    const version = this.world.sync();

    // device pixels this node covers: the context transform already holds the resolution
    // scale, every parent's scale and the cache offset (assumes no skew)
    const m = ctx.getTransform();
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    const ss = Math.max(1, this.supersample());
    const pw = Math.min(8192, Math.max(1, Math.round(w * sx * ss)));
    const ph = Math.min(8192, Math.max(1, Math.round(h * sy * ss)));

    const s = getRenderer(this.msaa());
    const r = s.renderer;
    ensureSize(s, pw, ph);

    const cam = this.camera;
    if (cam instanceof THREE.PerspectiveCamera && Math.abs(cam.aspect - w / h) > 1e-9) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }

    const tm = TONE[this.toneMapping()];
    if (r.toneMapping !== tm) r.toneMapping = tm;
    r.toneMappingExposure = this.exposure();
    const wantShadows = this.shadows();
    if (r.shadowMap.enabled !== wantShadows) r.shadowMap.enabled = wantShadows; // recompiles programs
    // The shadow map depends on the world, not on the camera: render it once per world version,
    // in a 1-pixel pass with a camera that sees every layer. three filters shadow casters by the
    // *viewing* camera's layers, so a POV camera that hides the own head and torso (layer 1)
    // would otherwise remove their shadows from every other view too.
    if (wantShadows && s.shadowOf.get(this.world) !== version) {
      r.shadowMap.needsUpdate = true;
      r.setViewport(0, 0, 1, 1);
      r.setScissor(0, 0, 1, 1);
      r.render(this.world.scene, shadowPassCam);
      s.shadowOf.set(this.world, version);
    }
    r.shadowMap.needsUpdate = false;

    if (this.world.envIntensity > 0) {
      if (!s.env) {
        const pm = new THREE.PMREMGenerator(r);
        s.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
        pm.dispose();
        r.setScissorTest(true);
      }
      this.world.scene.environment = s.env;
      this.world.scene.environmentIntensity = this.world.envIntensity;
    }

    r.setViewport(0, 0, pw, ph);
    r.setScissor(0, 0, pw, ph);
    r.render(this.world.scene, cam);

    ctx.save();
    ctx.clip(this.getPath());
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // GL's origin is bottom-left: the view sits in the canvas' bottom rows
    ctx.drawImage(s.canvas, 0, s.canvas.height - ph, pw, ph, -w / 2, -h / 2, w, h);
    ctx.restore();


    if (this.lineWidth() > 0) {
      ctx.save();
      this.applyStyle(ctx);
      ctx.stroke(this.getPath());
      ctx.restore();
    }
  }
}
