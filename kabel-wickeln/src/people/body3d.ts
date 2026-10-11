// A person in three.js: the body mesh of body/styles.ts as two BufferGeometries (one draw call each),
// updated in place every frame from a Pose. Low-poly bodies with one flat colour per face from the
// person's palette; faces marked smooth (the hands) get vertex normals. The arms (from the shoulder
// joint down) are on layer 0, everything else (head, hair, neck, torso, legs, shoes) is a separate mesh on
// layer SELF (1): a first-person camera that leaves layer 1 out sees only the own arms, and both
// meshes cast shadows (view.ts renders the shadow map with a camera that sees every layer), so the
// body still throws its shadow in the first-person view. Every other camera must enable layer 1.
//
// capsulesOf(pose) gives the collision bodies of the whole person for the cable simulation;
// colliders.ts the detailed ones of a hand and its forearm.

import * as THREE from 'three';
import { V3, madd } from './math';
import { Capsule, J, Pose, PersonSpec } from './people';
import { handJoints } from './body/hand';
import { Mesh, SELF } from './body/mesh';
import { buildBody, paletteOf } from './body/styles';

export { SELF };

/** one layer's triangles of the body mesh, as a non-indexed geometry */
interface Part {
  tris: Uint32Array;
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  nrm: Float32Array;
  mesh: THREE.Mesh;
}

export class Person3D {
  /** add this to the scene */
  public readonly group = new THREE.Group();
  public readonly material: THREE.MeshStandardMaterial;
  private readonly mesh: Mesh;
  private readonly parts: Part[];
  private readonly faceN: Float32Array;
  private readonly vertN: Float32Array;
  private readonly anySmooth: boolean;

  public constructor(
    public readonly spec: PersonSpec,
    pose: Pose,
  ) {
    this.mesh = buildBody(pose);
    const m = this.mesh;
    const pal = paletteOf(spec).map((c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace));
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
    const nt = m.tri.length / 3;
    this.faceN = new Float32Array(nt * 3);
    this.vertN = new Float32Array(m.pos.length);
    this.anySmooth = m.smooth.some((x) => x === 1);
    this.parts = [0, SELF].map((layer) => {
      const list: number[] = [];
      for (let t = 0; t < nt; t++) if (m.layer[t] === layer) list.push(t);
      const tris = Uint32Array.from(list);
      const pos = new Float32Array(tris.length * 9);
      const nrm = new Float32Array(tris.length * 9);
      const col = new Float32Array(tris.length * 9);
      tris.forEach((t, i) => {
        const c = pal[m.mat[t]];
        for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], i * 9 + v * 3);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(layer);
      mesh.name = `${spec.name}${layer ? ':self' : ''}`;
      this.group.add(mesh);
      return { tris, geo, pos, nrm, mesh };
    });
    this.write();
  }

  /** moves the body to a new pose (same person: the mesh is refilled in place) */
  public update(pose: Pose) {
    buildBody(pose, this.mesh);
    this.write();
  }

  /** frees the GPU buffers and the material */
  public dispose() {
    for (const p of this.parts) p.geo.dispose();
    this.material.dispose();
  }

  /** face normals, smooth vertex normals where asked, then both layers' buffers */
  private write() {
    const P = this.mesh.pos;
    const T = this.mesh.tri;
    const S = this.mesh.smooth;
    const fn = this.faceN;
    const vn = this.vertN;
    if (this.anySmooth) vn.fill(0);
    for (let t = 0; t < T.length / 3; t++) {
      const a = T[t * 3] * 3;
      const b = T[t * 3 + 1] * 3;
      const c = T[t * 3 + 2] * 3;
      const ux = P[b] - P[a];
      const uy = P[b + 1] - P[a + 1];
      const uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a];
      const vy = P[c + 1] - P[a + 1];
      const vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      if (S[t]) {
        // area weighted
        vn[a] += nx;
        vn[a + 1] += ny;
        vn[a + 2] += nz;
        vn[b] += nx;
        vn[b + 1] += ny;
        vn[b + 2] += nz;
        vn[c] += nx;
        vn[c + 1] += ny;
        vn[c + 2] += nz;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      fn[t * 3] = nx / l;
      fn[t * 3 + 1] = ny / l;
      fn[t * 3 + 2] = nz / l;
    }
    for (const part of this.parts) {
      const { tris, pos, nrm } = part;
      for (let i = 0; i < tris.length; i++) {
        const t = tris[i];
        for (let v = 0; v < 3; v++) {
          const src = T[t * 3 + v] * 3;
          const o = i * 9 + v * 3;
          pos[o] = P[src];
          pos[o + 1] = P[src + 1];
          pos[o + 2] = P[src + 2];
          if (S[t]) {
            const l = Math.hypot(vn[src], vn[src + 1], vn[src + 2]) || 1;
            nrm[o] = vn[src] / l;
            nrm[o + 1] = vn[src + 1] / l;
            nrm[o + 2] = vn[src + 2] / l;
          } else {
            nrm[o] = fn[t * 3];
            nrm[o + 1] = fn[t * 3 + 1];
            nrm[o + 2] = fn[t * 3 + 2];
          }
        }
      }
      part.geo.attributes.position.needsUpdate = true;
      part.geo.attributes.normal.needsUpdate = true;
      part.geo.computeBoundingSphere();
    }
  }
}

/**
 * The body as capsules for the cable simulation: head, neck, torso, arms, legs, feet, and per hand
 * the palm, two bones per finger and the thumb (part 'handL' / 'handR', so a simulation can leave
 * out the hand that holds the cable).
 */
export function capsulesOf(pose: Pose): Capsule[] {
  const P = pose.joints;
  const b = pose.body;
  const k = b.k;
  const B = pose.spec.build;
  const out: Capsule[] = [
    { a: P[J.head], b: P[J.head], r: 0.1 * k * B.head, part: 'head' },
    { a: P[J.neck], b: P[J.head], r: 0.05 * k * B.neck, part: 'neck' },
    { a: P[J.pelvis], b: P[J.neck], r: 0.12 * k * B.chest, part: 'torso' },
    { a: P[J.leftShoulder], b: P[J.leftHip], r: 0.1 * k, part: 'torso' },
    { a: P[J.rightShoulder], b: P[J.rightHip], r: 0.1 * k, part: 'torso' },
  ];
  const limb = (a: V3, c: V3, r: number, part: string) => out.push({ a, b: c, r, part });
  for (const [s, side] of [[0, 'L'], [1, 'R']] as const) {
    limb(P[J.leftShoulder + s], P[J.leftElbow + s], 0.048 * k * B.limbs, `arm${side}`);
    limb(P[J.leftElbow + s], P[J.leftWrist + s], 0.04 * k * B.limbs, `arm${side}`);
    limb(P[J.leftHip + s], P[J.leftKnee + s], 0.075 * k * B.limbs, `leg${side}`);
    limb(P[J.leftKnee + s], P[J.leftAnkle + s], 0.052 * k * B.limbs, `leg${side}`);
    limb(P[J.leftAnkle + s], s ? b.toeR : b.toeL, 0.04 * k, `foot${side}`);
    const h = b.hands[s];
    const hj = handJoints(h, s ? 1 : -1);
    const part = `hand${side}`;
    limb(h.wrist, madd(h.wrist, h.fd, 0.075 * h.q), 0.026 * h.q, part);
    for (const f of hj.fingers) {
      limb(f.p[0], f.p[1], f.def.r0 * h.q, part);
      limb(f.p[1], f.p[3], f.def.r1 * h.q, part);
    }
    limb(hj.thumb[1], hj.thumb[3], 0.009 * h.q, part);
  }
  return out;
}

/** where a person looks from: between the eyes, and the direction of the face (for a POV camera) */
export function eyesOf(pose: Pose): { p: V3; f: V3; u: V3 } {
  const h = pose.body.head;
  const k = pose.body.k;
  const c = pose.joints[J.head];
  return { p: madd(madd(c, h.f, 0.09 * k), h.u, 0.035 * k), f: h.f, u: h.u };
}
