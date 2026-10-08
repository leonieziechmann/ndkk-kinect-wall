// Particles, simulated on the CPU (a few thousand, cheap) and drawn as additive, world-sized dots:
//   Sparks  short-lived: dust blown off everyone's contour, trails of fast hands, bursts (claps,
//           quakes, eruptions, leaving), the upload stream; plus one-frame points (eyes, arcs)
//   Swarm   particles resting in the air around the people, stirred by hands and feet

import * as THREE from 'three/webgpu';
import { float, instancedDynamicBufferAttribute, max, pow, uv, vec2 } from 'three/tsl';

const F = 14; // floats per spark: x y z vx vy vz life ttl size r g b gravity turbulence

export class Sparks {
  constructor(maxCount, extras = 900) {
    this.max = maxCount;
    this.cap = maxCount + extras;
    this.d = new Float32Array(maxCount * F);
    this.n = 0;
    this.extra = 0;
    this.posAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3), 3);
    this.colAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    const col = instancedDynamicBufferAttribute(this.colAttr);
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mat.positionNode = instancedDynamicBufferAttribute(this.posAttr);
    mat.scaleNode = vec2(col.w);
    mat.colorNode = col.xyz;
    mat.opacityNode = pow(max(float(1).sub(uv().sub(0.5).length().mul(2)), 0), 0.8);
    this.mat = mat;
    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 5;
  }

  spawn(x, y, z, vx, vy, vz, ttl, size, r, g, b, gravity = 0, turbulence = 0) {
    if (this.n >= this.max) return;
    const o = this.n++ * F;
    const d = this.d;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = vx;
    d[o + 4] = vy;
    d[o + 5] = vz;
    d[o + 6] = 0;
    d[o + 7] = ttl;
    d[o + 8] = size;
    d[o + 9] = r;
    d[o + 10] = g;
    d[o + 11] = b;
    d[o + 12] = gravity;
    d[o + 13] = turbulence;
  }

  /** Moves everything, drops the dead, writes the GPU data. Then add extras (eyes) with point(). */
  update(dt, t) {
    const d = this.d;
    const pos = this.posAttr.array;
    const col = this.colAttr.array;
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * F;
      const life = d[o + 6] + dt;
      const ttl = d[o + 7];
      if (life >= ttl) continue;
      const turb = d[o + 13];
      let vx = d[o + 3];
      let vy = d[o + 4];
      let vz = d[o + 5];
      if (turb) {
        const x = d[o];
        const y = d[o + 1];
        const z = d[o + 2];
        vx += Math.sin(y * 3.1 + t * 0.9 + z * 1.7) * turb * dt;
        vz += Math.cos(x * 2.7 - t * 0.7 + y * 2.3) * turb * dt * 0.6;
        vy += Math.sin(z * 2.2 + x * 1.9 + t * 1.3) * turb * dt * 0.3;
      }
      vy += d[o + 12] * dt;
      const o2 = j * F;
      if (o2 !== o) d.copyWithin(o2, o, o + F);
      d[o2 + 3] = vx;
      d[o2 + 4] = vy;
      d[o2 + 5] = vz;
      d[o2] += vx * dt;
      d[o2 + 1] += vy * dt;
      d[o2 + 2] += vz * dt;
      d[o2 + 6] = life;
      // bounce off the floor
      if (d[o2 + 1] < 0) {
        d[o2 + 1] = -d[o2 + 1];
        d[o2 + 4] = Math.abs(vy) * 0.35;
      }
      const f = life / ttl;
      const a = (1 - f) * (1 - f) * Math.min(1, f * 10);
      pos[3 * j] = d[o2];
      pos[3 * j + 1] = d[o2 + 1];
      pos[3 * j + 2] = d[o2 + 2];
      col[4 * j] = d[o2 + 9] * a;
      col[4 * j + 1] = d[o2 + 10] * a;
      col[4 * j + 2] = d[o2 + 11] * a;
      col[4 * j + 3] = d[o2 + 8] * (0.55 + 0.45 * (1 - f));
      j++;
    }
    this.n = j;
    this.extra = 0;
  }

  /** A sprite for this frame only (not simulated). */
  point(x, y, z, size, r, g, b) {
    if (this.extra >= this.cap - this.max) return;
    const j = this.n + this.extra++;
    this.posAttr.array.set([x, y, z], 3 * j);
    this.colAttr.array.set([r, g, b, size], 4 * j);
  }

  upload() {
    const count = this.n + this.extra;
    for (const [a, k] of [
      [this.posAttr, 3],
      [this.colAttr, 4],
    ]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * k);
      a.needsUpdate = true;
    }
    this.sprite.count = count;
    this.sprite.visible = count > 0;
  }

  clear() {
    this.n = 0;
  }

  dispose() {
    this.mat.dispose();
  }
}

// ---------- the swarm: particles in the air around the people, stirred by hands and feet ----------

export class Swarm {
  constructor(count) {
    this.count = count;
    this.home = new Float32Array(count * 3);
    this.p = new Float32Array(count * 3);
    this.v = new Float32Array(count * 3);
    this.seed = new Float32Array(count);
    this.size = new Float32Array(count);
    this.posAttr = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.colAttr = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    const col = instancedDynamicBufferAttribute(this.colAttr);
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mat.positionNode = instancedDynamicBufferAttribute(this.posAttr);
    mat.scaleNode = vec2(col.w);
    mat.colorNode = col.xyz;
    mat.opacityNode = pow(max(float(1).sub(uv().sub(0.5).length().mul(2)), 0), 0.8);
    this.mat = mat;
    this.sprite = new THREE.Sprite(mat);
    this.sprite.count = count;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 4;
    this.rest = [0.9, 0.2, 0.45]; // color at rest
    this.hot = [1, 0.75, 0.9]; // color when stirred
  }

  /** Places the particles for the view: { eyeDist, ledPx, wallW } */
  build({ eyeDist, ledPx, wallW }, rnd) {
    for (let i = 0; i < this.count; i++) {
      const z = -0.2 - rnd() ** 1.2 * 5;
      const depth = (eyeDist - z) / eyeDist;
      const x = (rnd() * 2 - 1) * (wallW / 2 + 0.3) * depth;
      const y = 0.05 + rnd() * 2.3;
      this.home.set([x, y, z], 3 * i);
      this.p.set([x, y, z], 3 * i);
      this.v.fill(0, 3 * i, 3 * i + 3);
      this.seed[i] = rnd();
      this.size[i] = ledPx * (1 + rnd() * 0.6) * depth;
    }
  }

  /**
   * movers: [{ p: [x, y, z], v: [vx, vy, vz] }] hands and feet (mirror world, m and m/s);
   * kicks: [{ p, r, s, up }] one-frame pushes (claps, jumps).
   */
  update(dt, t, movers, kicks, gain) {
    const { home, p, v, seed } = this;
    const pos = this.posAttr.array;
    const col = this.colAttr.array;
    const R = 0.45;
    for (let i = 0; i < this.count; i++) {
      const o = 3 * i;
      const s = seed[i] * 6.283;
      // drift around its home, come back slowly when pushed away
      const tx = home[o] + Math.sin(t * 0.31 + s) * 0.06;
      const ty = home[o + 1] + Math.sin(t * 0.23 + s * 2) * 0.05;
      const tz = home[o + 2] + Math.cos(t * 0.27 + s * 3) * 0.06;
      let ax = (tx - p[o]) * 1.2 - v[o] * 1.6;
      let ay = (ty - p[o + 1]) * 1.2 - v[o + 1] * 1.6;
      let az = (tz - p[o + 2]) * 1.2 - v[o + 2] * 1.6;
      for (const m of movers) {
        const dx = p[o] - m.p[0];
        const dy = p[o + 1] - m.p[1];
        const dz = p[o + 2] - m.p[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > R * R) continue;
        const d = Math.sqrt(d2) || 1e-3;
        const w = (1 - d / R) ** 2;
        ax += m.v[0] * w * 16 + (dx / d) * w * 5;
        ay += m.v[1] * w * 16 + (dy / d) * w * 5;
        az += m.v[2] * w * 16 + (dz / d) * w * 5;
      }
      for (const k of kicks) {
        const dx = p[o] - k.p[0];
        const dy = p[o + 1] - k.p[1];
        const dz = p[o + 2] - k.p[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
        if (d > k.r) continue;
        const w = (1 - d / k.r) * k.s;
        v[o] += (dx / d) * w;
        v[o + 1] += (dy / d) * w + k.up * w;
        v[o + 2] += (dz / d) * w;
      }
      v[o] += ax * dt;
      v[o + 1] += ay * dt;
      v[o + 2] += az * dt;
      p[o] += v[o] * dt;
      p[o + 1] = Math.max(0.01, p[o + 1] + v[o + 1] * dt);
      p[o + 2] += v[o + 2] * dt;
      pos[o] = p[o];
      pos[o + 1] = p[o + 1];
      pos[o + 2] = p[o + 2];
      const speed = Math.min(1, Math.hypot(v[o], v[o + 1], v[o + 2]) * 0.9);
      const twinkle = 0.5 + 0.5 * Math.sin(t * (0.7 + seed[i]) + s * 9);
      const b = (0.06 + 0.06 * twinkle + speed * 1.6) * gain;
      const h = speed;
      col[4 * i] = (this.rest[0] + (this.hot[0] - this.rest[0]) * h) * b;
      col[4 * i + 1] = (this.rest[1] + (this.hot[1] - this.rest[1]) * h) * b;
      col[4 * i + 2] = (this.rest[2] + (this.hot[2] - this.rest[2]) * h) * b;
      col[4 * i + 3] = this.size[i] * (1 + speed * 0.6);
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sprite.visible = gain > 0;
  }

  dispose() {
    this.mat.dispose();
  }
}
