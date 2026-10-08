// The people of the mirror, as point clouds from the original depth data (like the three.js
// particles): every person pixel (or every 2nd/3rd, so the rows stay visible on the LEDs) is a
// glowing dot where the wall mapping puts it (mirror.js: ctx.wall with the stretched walk, then
// into the mirror world), colored by its distance from the wall and brightened by the infrared image. Behind the dots an almost black body hides the world, so everyone stands in front
// of it as a dark self. The contour is brighter, bands of the body glitch sideways now and then, and
// whoever comes in is scanned in from the head down.
//
// build() runs once per person tracking result on the CPU.

import * as THREE from 'three/webgpu';
import {
  float, floor, fract, hash, instancedDynamicBufferAttribute, int, max, mix, pow, smoothstep, step, uniform, uniformArray, uv,
  vec2, vec3,
} from 'three/tsl';

const W = 512;
const H = 424;
export const MAX_POINTS = 150000;
const JUMP = 110; // mm: a larger depth step between neighbors is an edge
const BORDER = 14; // px: people dissolve towards the image border instead of being cut off straight
const RES = 256; // contour points kept per slot (for the burst when someone leaves)

export function createPeople() {
  const attr = (n) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_POINTS * n), n);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const posAttr = attr(3);
  const infoAttr = attr(4); // contour, ir, slot + random / 2, distance 0..1 (near..far)
  const sizeAttr = attr(2); // dot, body (m)

  const U = {
    time: uniform(0),
    ages: uniformArray(new Array(17).fill(99), 'float'),
    dissolve: uniformArray(new Array(17).fill(0), 'float'), // per slot: 0..1 of the dots are gone (upload)
    near: uniform(new THREE.Color('#ff2d6a')),
    far: uniform(new THREE.Color('#3d4bff')),
    body: uniform(new THREE.Color('#050308')),
    gain: uniform(1),
    irGain: uniform(0.9),
    rim: uniform(1),
    reveal: uniform(1.8),
    glitch: uniform(0), // amplitude of the current glitch burst (0 = none)
    glitchSeed: uniform(0),
  };

  const P = instancedDynamicBufferAttribute(posAttr);
  const I = instancedDynamicBufferAttribute(infoAttr);
  const S = instancedDynamicBufferAttribute(sizeAttr);
  const slot = int(floor(I.z));
  const age = U.ages.element(slot);
  const keep = step(U.dissolve.element(slot), fract(I.z).mul(2.04)); // a fixed random number per pixel

  // glitch: bands of the body jump sideways for a moment
  const band = floor(P.y.mul(14).add(U.glitchSeed.mul(13.7)));
  const gOn = hash(band.add(U.glitchSeed.mul(101))).greaterThan(0.6).select(U.glitch, 0);
  const shift = hash(band.add(U.glitchSeed.mul(7)).add(3)).sub(0.5).mul(0.3).mul(gOn);
  const placed = vec3(P.x.add(shift), P.y, P.z);

  // scanned in from the head down when somebody comes in
  const revealY = float(2.4).sub(age.mul(U.reveal));
  const shown = step(revealY, P.y).mul(keep);
  const scanFront = smoothstep(0.08, 0, P.y.sub(revealY)).mul(shown);

  // the dark body behind the dots
  const bodyMat = new THREE.SpriteNodeMaterial({ transparent: false, depthWrite: true, alphaTest: 0.5 });
  bodyMat.positionNode = placed;
  bodyMat.scaleNode = vec2(S.y);
  bodyMat.colorNode = vec3(U.body);
  bodyMat.opacityNode = step(uv().sub(0.5).length(), 0.5).mul(shown);
  const body = new THREE.Sprite(bodyMat);
  body.count = 0;
  body.frustumCulled = false;
  body.renderOrder = 0;

  // the dots, slightly in front of the body
  const dotMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  dotMat.positionNode = placed.add(vec3(0, 0, 0.015));
  dotMat.scaleNode = vec2(S.x);
  // distance from the wall picks the color; dark parts in the infrared (hair, dark clothes) lean to the far color
  const base = mix(vec3(U.near), vec3(U.far), I.w.add(float(0.6).sub(I.y).max(0).mul(0.6)).min(1));
  const light = I.y.mul(U.irGain).add(0.22);
  const edge = pow(I.x, 1.5).mul(U.rim);
  const col = base.mul(light.add(edge.mul(0.9))).add(vec3(1, 0.85, 0.95).mul(edge.mul(0.35)))
    .add(vec3(1).mul(scanFront.mul(2)))
    .add(vec3(1, 0.3, 0.5).mul(gOn.mul(0.5)));
  dotMat.colorNode = col.mul(U.gain).mul(shown);
  dotMat.opacityNode = pow(max(float(1).sub(uv().sub(0.5).length().mul(2)), 0), 0.7);
  const dots = new THREE.Sprite(dotMat);
  dots.count = 0;
  dots.frustumCulled = false;
  dots.renderOrder = 1;

  const pos = posAttr.array;
  const info = infoAttr.array;
  const size = sizeAttr.array;
  const contour = new Uint32Array(16384); // point indices on the contour, to shed particles from
  const reservoir = Array.from({ length: 17 }, () => ({ n: 0, seen: 0, xyz: new Float32Array(RES * 3) }));
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  return {
    U,
    body,
    dots,
    contour,
    contourCount: 0,
    count: 0,
    reservoir,
    pos,
    info,

    /**
     * One person tracking result -> particles.
     * k: ctx.kinect.persons, rays: ctx.kinect.rays, ir: Uint8Array or null,
     * mirror: camera frame (m) -> mirror world (MirrorMap in mirror.js, updated for this frame),
     * o: { fx, step (1..3), near, far (m from the wall, colors), dotLed (dot size on the wall, m),
     *      spread (how much wider than real the mapping draws the points: closes the gaps) }
     */
    build(k, rays, ir, mirror, o) {
      const lab = k.labels;
      const dep = k.depth;
      const idx = k.indices;
      const st = o.step;
      for (const r of reservoir) {
        r.n = 0;
        r.seen = 0;
      }
      // a neighbor that is not the same person, or clearly farther away, makes a silhouette edge;
      // something clearly nearer (an arm in front of the body) does not make an edge here
      const far = (j, s, d) => {
        const d2 = dep[j];
        if (lab[j] === s && d2) return d2 - d > JUMP;
        return !(d2 && d2 < d - JUMP);
      };
      const edgeAt = (i, u, v, s, d, e) =>
        (u >= e && far(i - e, s, d)) || (u + e < W && far(i + e, s, d)) || (v >= e && far(i - e * W, s, d)) || (v + e < H && far(i + e * W, s, d));
      const span = Math.max(0.1, o.far - o.near);
      const D = mirror.eye[2];
      const p = [0, 0, 0];
      let n = 0;
      let nc = 0;
      for (let t = 0; t < idx.length && n < MAX_POINTS; t++) {
        const i = idx[t];
        const v = (i / W) | 0;
        const u = i - v * W;
        if (st > 1 && (u % st || v % st)) continue;
        const s = lab[i];
        const d = dep[i];
        if (!s || !d) continue;
        const border = Math.min(u, W - 1 - u, v, H - 1 - v);
        if (border < BORDER && rand() * BORDER > border) continue;
        let edge = 0;
        if (edgeAt(i, u, v, s, d, st)) edge = 1;
        else if (edgeAt(i, u, v, s, d, 2 * st)) edge = 0.45;

        const z = d * 0.001;
        // a fixed jitter per pixel (up to a third of the spacing): no moire with the LED grid
        const h = Math.imul(i, 2654435761) >>> 0; // fixed random bits per pixel
        const jx = ((h & 1023) / 1023 - 0.5) * 0.66 * st;
        const jy = (((h >>> 10) & 1023) / 1023 - 0.5) * 0.66 * st;
        const rx = rays[2 * i] + (jx * (rays[2 * i + 2] - rays[2 * i] || 0.0027));
        const ry = rays[2 * i + 1] + (jy * (v + 1 < H ? rays[2 * i + 2 * W + 1] - rays[2 * i + 1] : 0.0027));
        mirror.fromCamera(rx * z, ry * z, z, s, p);
        const X = p[0];
        const Y = p[1];
        const Z = p[2];
        pos[3 * n] = X;
        pos[3 * n + 1] = Y;
        pos[3 * n + 2] = Z;
        info[4 * n] = edge;
        info[4 * n + 1] = ir ? Math.min(1, ir[i] / 160) : 0.5;
        info[4 * n + 2] = s + ((h >>> 20) / 4095) * 0.49;
        info[4 * n + 3] = Math.min(1, Math.max(0, (mirror.distance(Z) - o.near) / span));
        // dot: a fixed size on the wall; body: closes the gaps between the dots
        size[2 * n] = (o.dotLed * (D - Z)) / D;
        size[2 * n + 1] = (1.9 * st * z * o.spread * mirror.scale(Z)) / o.fx;
        if (edge >= 1) {
          if (nc < contour.length) contour[nc++] = n;
          const r = reservoir[s];
          r.seen++;
          const at = r.n < RES ? r.n++ : Math.floor(rand() * r.seen);
          if (at < RES) r.xyz.set([X, Y, Z], at * 3);
        }
        n++;
      }
      for (const [a, k2] of [
        [posAttr, 3],
        [infoAttr, 4],
        [sizeAttr, 2],
      ]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * k2);
        a.needsUpdate = true;
      }
      this.count = n;
      this.contourCount = nc;
      body.count = n;
      dots.count = n;
      body.visible = n > 0;
      dots.visible = n > 0;
    },

    dispose() {
      bodyMat.dispose();
      dotMat.dispose();
    },
  };
}
