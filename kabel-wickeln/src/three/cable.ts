// A cable as a tube mesh along the simulated nodes, rebuilt in place every frame (no allocation).
//
// Input per frame: node positions and the material frame's d1 per node (from BakedRod.frameSample).
// Between nodes the axis is a Catmull-Rom spline (`sub` rings per segment), so 1-2.5 cm node spacing
// still gives a round, smooth tube. Rings are oriented by a rotation-minimising frame (double
// reflection, Wang et al. 2008) along the dense spline, turned by the angle of d1 in that frame
// (unwrapped and interpolated between nodes): ring coordinate 0 points along d1, and the printed
// stripe sits there, so the stripe shows the cable's twist exactly as the simulation has it.
//
// Satin jacket (Standard material), the stripe cut in the fragment shader (crisp at any radial
// resolution, optional darker edge for thin or white cables), per-node tint (rgba, a = mix) and a
// per-node halo: an outline of constant pixel width, drawn as the tube grown by that width with
// everything inside the tube's silhouette discarded (blue for "über", orange for "unter", white for
// the strand to the floor). A soft contact shadow marks where the cable touches the ground.
// Flat end caps, and optional plugs (plugs.ts) on both ends, oriented by the end frames.

import * as THREE from 'three';
import { PlugKind, makePlug } from './plugs';

export interface CableOptions {
  /** most nodes update() will get */
  maxNodes: number;
  /** jacket radius (m) */
  radius: number;
  jacket?: string;
  /** stripe colour; null = no stripe */
  stripe?: string | null;
  /** half width of the stripe as a fraction of the circumference (0.04 = 29° wide) */
  stripeWidth?: number;
  /** a darker edge around the stripe (thin or light cables) */
  stripeEdge?: string | null;
  /** radial segments (default 12) */
  sides?: number;
  /** rings per node segment (default 2; 3 for nodes 2 cm or more apart in close-ups) */
  sub?: number;
  roughness?: number;
  plugStart?: PlugKind | null;
  plugEnd?: PlugKind | null;
  /** plug body size factor (1 = real size) */
  plugScale?: number;
  /** halo width in rendered pixels (default 6) */
  haloPx?: number;
  /** but at most this many cable radii (default 0.8): a thin, far cable keeps a thin halo */
  haloMax?: number;
  /**
   * height of the surface the cable may lie on (m; default 0 = the floor), for a soft contact
   * shadow under the parts that touch it or hang just above; null = none
   */
  ground?: number | null;
}

/** linear rgba from an sRGB hex colour, for tint and halo arrays */
export function rgba(hex: string, a = 1): [number, number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b, a];
}

/** writes one rgba into nodes [from, to) of a per-node rgba array (a = 0 clears) */
export function paint(arr: Float32Array, from: number, to: number, c: readonly number[], a = c[3]) {
  for (let i = Math.max(0, from); i < Math.min(to, arr.length / 4); i++) {
    arr[i * 4] = c[0];
    arr[i * 4 + 1] = c[1];
    arr[i * 4 + 2] = c[2];
    arr[i * 4 + 3] = a;
  }
}

const viewport = new THREE.Vector4();

export class CableMesh {
  /** add this to the scene: tube, halo, contact shadow and plugs */
  public readonly group = new THREE.Group();
  public readonly tube: THREE.Mesh;
  public readonly halo: THREE.Mesh;
  /** the soft contact shadow on the ground (null without `ground`) */
  public readonly contact: THREE.Mesh | null = null;
  public readonly material: THREE.MeshStandardMaterial;
  public readonly plugStart: THREE.Group | null;
  public readonly plugEnd: THREE.Group | null;
  public readonly radius: number;
  public readonly maxNodes: number;

  private readonly sides: number;
  private readonly sub: number;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly nrm: Float32Array;
  private readonly tint: Float32Array;
  private readonly haloCol: Float32Array;
  private readonly haloGeo = new THREE.BufferGeometry();
  private readonly haloIdx: Uint32Array;
  private hadTint = false;
  private hadHalo = false;
  private readonly ground: number | null;
  private readonly shadePos: Float32Array | null = null;
  private readonly shadeA: Float32Array | null = null;
  private readonly shadeIdx: Uint32Array | null = null;
  private readonly capVerts: number;
  private readonly capIdx: number;
  // per ring scratch: centre, tangent, rotation-minimising normal and binormal, angle
  private readonly C: Float32Array;
  private readonly T: Float32Array;
  private readonly N: Float32Array;
  private readonly B: Float32Array;
  private readonly ang: Float64Array;
  private readonly cosA: Float32Array;
  private readonly sinA: Float32Array;
  private readonly haloViewport = { value: new THREE.Vector2(1920, 1080) };

  public constructor(o: CableOptions) {
    const S = (this.sides = o.sides ?? 12);
    const sub = (this.sub = o.sub ?? 2);
    this.radius = o.radius;
    this.maxNodes = o.maxNodes;
    const maxRings = (o.maxNodes - 1) * sub + 1;
    const ring = S + 1; // duplicated seam vertex: the ring coordinate runs 0..1 without a jump
    this.capVerts = 2 * (ring + 1);
    const nv = this.capVerts + maxRings * ring;
    this.pos = new Float32Array(nv * 3);
    this.nrm = new Float32Array(nv * 3);
    this.tint = new Float32Array(nv * 4);
    this.haloCol = new Float32Array(nv * 4);
    const ringU = new Float32Array(nv).fill(-1); // caps: no stripe
    for (let k = 0; k < maxRings; k++) for (let j = 0; j <= S; j++) ringU[this.capVerts + k * ring + j] = j / S;
    this.C = new Float32Array(maxRings * 3);
    this.T = new Float32Array(maxRings * 3);
    this.N = new Float32Array(maxRings * 3);
    this.B = new Float32Array(maxRings * 3);
    this.ang = new Float64Array(o.maxNodes);
    this.cosA = new Float32Array(ring);
    this.sinA = new Float32Array(ring);
    for (let j = 0; j <= S; j++) {
      this.cosA[j] = Math.cos((2 * Math.PI * j) / S);
      this.sinA[j] = Math.sin((2 * Math.PI * j) / S);
    }

    // indices: the two caps (fixed), then the tube body ring by ring
    this.capIdx = 2 * S * 3;
    const idx = new Uint32Array(this.capIdx + (maxRings - 1) * S * 6);
    let k = 0;
    for (let j = 0; j < S; j++) {
      // start cap faces -t, end cap faces +t
      idx[k++] = 0;
      idx[k++] = 1 + j + 1;
      idx[k++] = 1 + j;
      const c = ring + 1;
      idx[k++] = c;
      idx[k++] = c + 1 + j;
      idx[k++] = c + 1 + j + 1;
    }
    for (let r = 0; r < maxRings - 1; r++)
      for (let j = 0; j < S; j++) {
        const a = this.capVerts + r * ring + j;
        const b = a + ring;
        idx[k++] = a;
        idx[k++] = a + 1;
        idx[k++] = b;
        idx[k++] = a + 1;
        idx[k++] = b + 1;
        idx[k++] = b;
      }
    const g = this.geometry;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const dyn = (arr: Float32Array, size: number) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', dyn(this.pos, 3));
    g.setAttribute('normal', dyn(this.nrm, 3));
    g.setAttribute('aTint', dyn(this.tint, 4));
    g.setAttribute('aHalo', dyn(this.haloCol, 4));
    g.setAttribute('aRing', new THREE.BufferAttribute(ringU, 1));

    // ---------------------------------------------------------------- jacket and stripe
    const stripe = o.stripe === undefined ? '#f2c200' : o.stripe;
    const u = {
      uStripe: { value: new THREE.Color(stripe ?? '#000000') },
      uStripeW: { value: stripe ? (o.stripeWidth ?? 0.04) : -1 },
      uEdge: { value: new THREE.Color(o.stripeEdge ?? '#000000') },
      uEdgeW: { value: o.stripeEdge ? 0.025 : 0 },
    };
    this.material = new THREE.MeshStandardMaterial({ color: o.jacket ?? '#25272c', roughness: o.roughness ?? 0.42, metalness: 0 });
    this.material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aRing;\nattribute vec4 aTint;\nvarying float vRing;\nvarying vec4 vTint;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRing = aRing;\nvTint = aTint;');
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform vec3 uStripe;\nuniform float uStripeW;\nuniform vec3 uEdge;\nuniform float uEdgeW;\nvarying float vRing;\nvarying vec4 vTint;',
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          diffuseColor.rgb = mix(diffuseColor.rgb, vTint.rgb, vTint.a);
          // derivatives outside the branch; caps have vRing -1, and multisampling may extrapolate
          // vRing a little below 0 at the seam
          float aa = max(0.5 * fwidth(vRing), 1e-4);
          if (vRing > -0.5 && uStripeW > 0.0) {
            float d = abs(fract(vRing + 0.5) - 0.5);
            float e = 1.0 - smoothstep(uStripeW + uEdgeW - aa, uStripeW + uEdgeW + aa, d);
            float s = 1.0 - smoothstep(uStripeW - aa, uStripeW + aa, d);
            diffuseColor.rgb = mix(diffuseColor.rgb, uEdge, e * step(1e-5, uEdgeW));
            diffuseColor.rgb = mix(diffuseColor.rgb, uStripe, s);
          }`,
        );
    };
    this.material.customProgramCacheKey = () => 'cable-jacket';
    this.tube = new THREE.Mesh(g, this.material);
    this.tube.castShadow = true;
    this.tube.receiveShadow = true;
    this.tube.frustumCulled = false; // bounds change every frame

    // ---------------------------------------------------------------- halo
    const haloMat = new THREE.ShaderMaterial({
      uniforms: { uPx: { value: o.haloPx ?? 6 }, uRadius: { value: o.radius }, uMaxW: { value: o.radius * (o.haloMax ?? 0.8) }, uViewport: this.haloViewport },
      vertexShader: `
        attribute vec4 aHalo;
        uniform float uPx;
        uniform float uRadius;
        uniform float uMaxW;
        uniform vec2 uViewport;
        varying vec4 vHalo;
        varying vec3 vN;
        varying vec3 vV;
        varying float vQ;
        void main() {
          vHalo = aHalo;
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // the halo is the tube grown by uPx pixels (at this depth), at most uMaxW (wide shots)
          float pix = (projectionMatrix[3][3] > 0.5 ? 1.0 : -mv.z) * 2.0 / (projectionMatrix[1][1] * uViewport.y);
          float w = min(uPx * pix, uMaxW);
          mv.xyz += vN * w;
          vV = normalize(-mv.xyz);
          vQ = uRadius / (uRadius + w);
          // pulled towards the camera, so the floor the cable lies on cannot hide it
          mv.xyz += vV * 2.0 * uRadius;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec4 vHalo;
        varying vec3 vN;
        varying vec3 vV;
        varying float vQ;
        void main() {
          // only the ring outside the tube's silhouette: a view ray through this point of the
          // grown tube passes the axis at R·sin, and it misses the tube if that is more than r
          float c = abs(dot(normalize(vN), normalize(vV)));
          if (vHalo.a < 0.01 || c > sqrt(1.0 - vQ * vQ)) discard;
          gl_FragColor = vHalo;
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.haloIdx = new Uint32Array((maxRings - 1) * S * 6);
    const hg = this.haloGeo;
    hg.setIndex(new THREE.BufferAttribute(this.haloIdx, 1).setUsage(THREE.DynamicDrawUsage));
    for (const name of ['position', 'normal', 'aHalo']) hg.setAttribute(name, g.getAttribute(name));
    this.halo = new THREE.Mesh(hg, haloMat);
    this.halo.frustumCulled = false;
    this.halo.visible = false;
    // the outline keeps its pixel width in every view: read the viewport of the current render
    this.halo.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(viewport);
      this.haloViewport.value.set(viewport.z, viewport.w);
    };

    this.group.add(this.tube, this.halo);

    // ---------------------------------------------------------------- contact shadow
    // a dark, soft strip on the ground under the cable, fading as the cable rises: the shadow
    // map alone is too soft to show where a thin cable touches the floor
    this.ground = o.ground === undefined ? 0 : o.ground;
    if (this.ground !== null) {
      this.shadePos = new Float32Array(maxRings * 2 * 3);
      this.shadeA = new Float32Array(maxRings * 2 * 2);
      this.shadeIdx = new Uint32Array((maxRings - 1) * 6);
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', dyn(this.shadePos, 3));
      sg.setAttribute('aShade', dyn(this.shadeA, 2));
      sg.setIndex(new THREE.BufferAttribute(this.shadeIdx, 1).setUsage(THREE.DynamicDrawUsage));
      const sm = new THREE.ShaderMaterial({
        vertexShader: `
          attribute vec2 aShade;
          varying vec2 vShade;
          void main() {
            vShade = aShade;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          varying vec2 vShade;
          void main() {
            float e = 1.0 - vShade.y * vShade.y;
            gl_FragColor = vec4(0.0, 0.0, 0.0, vShade.x * e * e);
          }`,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const contact = new THREE.Mesh(sg, sm);
      contact.frustumCulled = false;
      contact.renderOrder = -1; // under halos and other transparent things
      this.contact = contact;
      this.group.add(contact);
    }
    const plug = (kind: PlugKind | null | undefined) => {
      if (!kind) return null;
      const p = makePlug(kind, { cableRadius: o.radius, scale: o.plugScale });
      p.matrixAutoUpdate = false;
      this.group.add(p);
      return p;
    };
    this.plugStart = plug(o.plugStart);
    this.plugEnd = plug(o.plugEnd);
  }

  /**
   * Rebuilds the tube from n nodes. pos and d1: xyz per node; tint and halo: rgba per node
   * (linear rgb, a = strength; see rgba() and paint()); radius: a factor on the jacket's radius per
   * node (1 = as built; < 1 squeezes it, e.g. a dent under a tie pulled too tight). Allocates nothing.
   */
  public update(pos: Float32Array, d1: Float32Array, n: number, tint?: Float32Array, halo?: Float32Array, radius?: Float32Array) {
    n = Math.min(n, this.maxNodes);
    if (n < 2) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const { C, T, N, B, ang, cosA, sinA, sub } = this;
    const S = this.sides;
    const ring = S + 1;
    const rings = (n - 1) * sub + 1;
    const rad = this.radius;

    // spline centres and tangents (uniform Catmull-Rom; mirrored phantom nodes at the ends)
    for (let k = 0; k < rings; k++) {
      const i = Math.min(n - 2, Math.floor(k / sub));
      const u = k / sub - i;
      const u2 = u * u;
      const u3 = u2 * u;
      for (let c = 0; c < 3; c++) {
        const p1 = pos[i * 3 + c];
        const p2 = pos[(i + 1) * 3 + c];
        const p0 = i > 0 ? pos[(i - 1) * 3 + c] : 2 * p1 - p2;
        const p3 = i + 2 < n ? pos[(i + 2) * 3 + c] : 2 * p2 - p1;
        C[k * 3 + c] = 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (3 * p1 - p0 - 3 * p2 + p3) * u3);
        T[k * 3 + c] = 0.5 * (p2 - p0 + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * u + 3 * (3 * p1 - p0 - 3 * p2 + p3) * u2);
      }
      const k3 = k * 3;
      const l = Math.hypot(T[k3], T[k3 + 1], T[k3 + 2]) || 1;
      T[k3] /= l;
      T[k3 + 1] /= l;
      T[k3 + 2] /= l;
    }

    // first normal: d1 of node 0 made perpendicular to the tangent (then the angle there is ~0)
    {
      const tx = T[0], ty = T[1], tz = T[2];
      let nx = d1[0], ny = d1[1], nz = d1[2];
      const d = nx * tx + ny * ty + nz * tz;
      nx -= d * tx;
      ny -= d * ty;
      nz -= d * tz;
      let l = Math.hypot(nx, ny, nz);
      if (l < 1e-6) {
        // d1 along the tangent (bad input): any perpendicular
        nx = Math.abs(ty) > 0.9 ? 1 : 0;
        ny = Math.abs(ty) > 0.9 ? 0 : 1;
        nz = 0;
        const e = nx * tx + ny * ty;
        nx -= e * tx;
        ny -= e * ty;
        nz -= e * tz;
        l = Math.hypot(nx, ny, nz);
      }
      N[0] = nx / l;
      N[1] = ny / l;
      N[2] = nz / l;
    }
    // rotation-minimising frames by double reflection
    for (let k = 0; k < rings - 1; k++) {
      const i3 = k * 3;
      const j3 = i3 + 3;
      const v1x = C[j3] - C[i3], v1y = C[j3 + 1] - C[i3 + 1], v1z = C[j3 + 2] - C[i3 + 2];
      const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
      if (c1 < 1e-14) {
        N[j3] = N[i3];
        N[j3 + 1] = N[i3 + 1];
        N[j3 + 2] = N[i3 + 2];
        continue;
      }
      let f = (2 / c1) * (v1x * N[i3] + v1y * N[i3 + 1] + v1z * N[i3 + 2]);
      const rx = N[i3] - f * v1x, ry = N[i3 + 1] - f * v1y, rz = N[i3 + 2] - f * v1z;
      f = (2 / c1) * (v1x * T[i3] + v1y * T[i3 + 1] + v1z * T[i3 + 2]);
      const v2x = T[j3] - (T[i3] - f * v1x), v2y = T[j3 + 1] - (T[i3 + 1] - f * v1y), v2z = T[j3 + 2] - (T[i3 + 2] - f * v1z);
      const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
      f = c2 < 1e-14 ? 0 : (2 / c2) * (v2x * rx + v2y * ry + v2z * rz);
      N[j3] = rx - f * v2x;
      N[j3 + 1] = ry - f * v2y;
      N[j3 + 2] = rz - f * v2z;
    }
    for (let k = 0; k < rings; k++) {
      const k3 = k * 3;
      const tx = T[k3], ty = T[k3 + 1], tz = T[k3 + 2];
      let nx = N[k3], ny = N[k3 + 1], nz = N[k3 + 2];
      // keep N exactly perpendicular and unit (rounding drift over long cables)
      const d = nx * tx + ny * ty + nz * tz;
      nx -= d * tx;
      ny -= d * ty;
      nz -= d * tz;
      const l = Math.hypot(nx, ny, nz) || 1;
      N[k3] = nx /= l;
      N[k3 + 1] = ny /= l;
      N[k3 + 2] = nz /= l;
      B[k3] = ty * nz - tz * ny;
      B[k3 + 1] = tz * nx - tx * nz;
      B[k3 + 2] = tx * ny - ty * nx;
    }
    // angle of d1 in the frame at every node, unwrapped along the cable
    for (let i = 0; i < n; i++) {
      const k3 = i * sub * 3;
      const i3 = i * 3;
      const x = d1[i3] * N[k3] + d1[i3 + 1] * N[k3 + 1] + d1[i3 + 2] * N[k3 + 2];
      const y = d1[i3] * B[k3] + d1[i3 + 1] * B[k3 + 1] + d1[i3 + 2] * B[k3 + 2];
      let a = Math.atan2(y, x);
      if (i > 0) {
        const p = ang[i - 1];
        a = p + (a - p) - 2 * Math.PI * Math.round((a - p) / (2 * Math.PI));
      }
      ang[i] = a;
    }

    // rings
    const P = this.pos, Nr = this.nrm, tc = this.tint, hc = this.haloCol;
    const base = this.capVerts;
    // colours are written (and uploaded) only while given, and once more to clear them
    const writeTint = !!tint || this.hadTint;
    const writeHalo = !!halo || this.hadHalo;
    this.hadTint = !!tint;
    this.hadHalo = !!halo;
    for (let k = 0; k < rings; k++) {
      const i = Math.min(n - 2, Math.floor(k / sub));
      const u = k / sub - i;
      const a = ang[i] + (ang[i + 1] - ang[i]) * u;
      const ca = Math.cos(a), sa = Math.sin(a);
      const k3 = k * 3;
      const nx = N[k3], ny = N[k3 + 1], nz = N[k3 + 2];
      const bx = B[k3], by = B[k3 + 1], bz = B[k3 + 2];
      // the frame turned by the d1 angle: ring coordinate 0 points along d1
      const ux = nx * ca + bx * sa, uy = ny * ca + by * sa, uz = nz * ca + bz * sa;
      const wx = bx * ca - nx * sa, wy = by * ca - ny * sa, wz = bz * ca - nz * sa;
      const cx = C[k3], cy = C[k3 + 1], cz = C[k3 + 2];
      const rr = radius ? rad * (radius[i] + (radius[i + 1] - radius[i]) * u) : rad;
      // per-node colours, blended between the two nodes
      const i4 = i * 4;
      for (let j = 0; j <= S; j++) {
        const ox = ux * cosA[j] + wx * sinA[j];
        const oy = uy * cosA[j] + wy * sinA[j];
        const oz = uz * cosA[j] + wz * sinA[j];
        const v = base + k * ring + j;
        const v3 = v * 3;
        P[v3] = cx + ox * rr;
        P[v3 + 1] = cy + oy * rr;
        P[v3 + 2] = cz + oz * rr;
        Nr[v3] = ox;
        Nr[v3 + 1] = oy;
        Nr[v3 + 2] = oz;
      }
      const v4 = (base + k * ring) * 4;
      if (writeTint)
        for (let c = 0; c < 4; c++) {
          const x = tint ? tint[i4 + c] + (tint[i4 + 4 + c] - tint[i4 + c]) * u : 0;
          for (let j = 0; j <= S; j++) tc[v4 + j * 4 + c] = x;
        }
      if (writeHalo)
        for (let c = 0; c < 4; c++) {
          const x = halo ? halo[i4 + c] + (halo[i4 + 4 + c] - halo[i4 + c]) * u : 0;
          for (let j = 0; j <= S; j++) hc[v4 + j * 4 + c] = x;
        }
    }
    // caps: centre + a copy of the end ring, facing along the tangent
    for (let e = 0; e < 2; e++) {
      const k = e === 0 ? 0 : rings - 1;
      const sgn = e === 0 ? -1 : 1;
      const c0 = e * (ring + 1);
      const k3 = k * 3;
      const tx = T[k3] * sgn, ty = T[k3 + 1] * sgn, tz = T[k3 + 2] * sgn;
      const src = base + k * ring;
      for (let j = -1; j <= S; j++) {
        const v3 = (c0 + 1 + j) * 3;
        if (j < 0) {
          P[v3] = C[k3];
          P[v3 + 1] = C[k3 + 1];
          P[v3 + 2] = C[k3 + 2];
        } else {
          P[v3] = P[(src + j) * 3];
          P[v3 + 1] = P[(src + j) * 3 + 1];
          P[v3 + 2] = P[(src + j) * 3 + 2];
        }
        Nr[v3] = tx;
        Nr[v3 + 1] = ty;
        Nr[v3 + 2] = tz;
        for (let c = 0; c < 4; c++) tc[(c0 + 1 + j) * 4 + c] = tc[src * 4 + c];
      }
    }

    const g = this.geometry;
    g.setDrawRange(0, this.capIdx + (rings - 1) * S * 6);
    const nv = base + rings * ring;
    for (const name of ['position', 'normal', 'aTint', 'aHalo']) {
      if ((name === 'aTint' && !writeTint) || (name === 'aHalo' && !writeHalo)) continue;
      const att = g.getAttribute(name) as THREE.BufferAttribute;
      att.clearUpdateRanges();
      att.addUpdateRange(0, nv * att.itemSize);
      att.needsUpdate = true;
    }

    // the halo hull only where a halo is: its own index over the shared vertices
    let m = 0;
    if (halo) {
      const hi = this.haloIdx;
      let prev = hc[base * 4 + 3];
      for (let k = 0; k < rings - 1; k++) {
        const next = hc[(base + (k + 1) * ring) * 4 + 3];
        if (prev > 0.01 || next > 0.01)
          for (let j = 0; j < S; j++) {
            const a = base + k * ring + j;
            const b = a + ring;
            hi[m++] = a;
            hi[m++] = a + 1;
            hi[m++] = b;
            hi[m++] = a + 1;
            hi[m++] = b + 1;
            hi[m++] = b;
          }
        prev = next;
      }
      const ia = this.haloGeo.index as THREE.BufferAttribute;
      ia.clearUpdateRanges();
      ia.addUpdateRange(0, m);
      ia.needsUpdate = true;
    }
    this.haloGeo.setDrawRange(0, m);
    this.halo.visible = m > 0;
    if (this.contact) this.updateContact(rings);

    if (this.plugStart) this.placePlug(this.plugStart, 0, -1, ang[0]);
    if (this.plugEnd) this.placePlug(this.plugEnd, rings - 1, 1, ang[n - 1]);
  }

  /** the contact strip: two vertices per ring on the ground, indices only where it is dark */
  private updateContact(rings: number) {
    const sp = this.shadePos, sa = this.shadeA, si = this.shadeIdx, contact = this.contact;
    if (!sp || !sa || !si || !contact || this.ground === null) return;
    const { C, T } = this;
    const r = this.radius;
    const y = this.ground + 0.0005;
    let sx = 1, sz = 0;
    for (let k = 0; k < rings; k++) {
      const k3 = k * 3;
      // horizontal direction across the cable (kept from the last ring where the cable is vertical)
      const hx = -T[k3 + 2], hz = T[k3];
      const hl = Math.hypot(hx, hz);
      if (hl > 0.2) {
        sx = hx / hl;
        sz = hz / hl;
      }
      const gap = Math.max(0, C[k3 + 1] - r - this.ground);
      const f = Math.max(0, 1 - gap / (5 * r));
      const w = r * (1.5 + (gap / r) * 0.6);
      for (let e = 0; e < 2; e++) {
        const sgn = e === 0 ? -1 : 1;
        const v = k * 2 + e;
        sp[v * 3] = C[k3] + sx * w * sgn;
        sp[v * 3 + 1] = y;
        sp[v * 3 + 2] = C[k3 + 2] + sz * w * sgn;
        sa[v * 2] = 0.55 * f * f;
        sa[v * 2 + 1] = sgn;
      }
    }
    let m = 0;
    for (let k = 0; k < rings - 1; k++) {
      if (sa[k * 4] < 0.01 && sa[k * 4 + 4] < 0.01) continue;
      const a = k * 2;
      si[m++] = a;
      si[m++] = a + 1;
      si[m++] = a + 2;
      si[m++] = a + 1;
      si[m++] = a + 3;
      si[m++] = a + 2;
    }
    const g = contact.geometry;
    g.setDrawRange(0, m);
    contact.visible = m > 0;
    if (!m) return;
    for (const name of ['position', 'aShade']) {
      const att = g.getAttribute(name) as THREE.BufferAttribute;
      att.clearUpdateRanges();
      att.addUpdateRange(0, rings * 2 * att.itemSize);
      att.needsUpdate = true;
    }
    const ia = g.index as THREE.BufferAttribute;
    ia.clearUpdateRanges();
    ia.addUpdateRange(0, m);
    ia.needsUpdate = true;
  }

  /** puts a plug at ring k: local +z along the outward tangent, +x along d1 */
  private placePlug(p: THREE.Group, k: number, sgn: number, a: number) {
    const k3 = k * 3;
    const { C, T, N, B } = this;
    const ca = Math.cos(a), sa = Math.sin(a);
    const xx = N[k3] * ca + B[k3] * sa, xy = N[k3 + 1] * ca + B[k3 + 1] * sa, xz = N[k3 + 2] * ca + B[k3 + 2] * sa;
    const zx = T[k3] * sgn, zy = T[k3 + 1] * sgn, zz = T[k3 + 2] * sgn;
    // y = z × x (right-handed)
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    p.matrix.set(xx, yx, zx, C[k3], xy, yy, zy, C[k3 + 1], xz, yz, zz, C[k3 + 2], 0, 0, 0, 1);
    p.matrixWorldNeedsUpdate = true;
  }
}
