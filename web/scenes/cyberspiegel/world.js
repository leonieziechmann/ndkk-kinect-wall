// The virtual world of the mirror, made of particles like a Kinect point cloud (rows of dots):
//   floor     rows of dots that continue the real floor and roll into dunes far away; it ripples
//             around the feet of everyone in front of the wall
//   blackwall an arena of heaving particle columns, far in the middle and nearer at the sides (red
//             ridges, blue grooves); particles come loose, it surges when the people move, trembles
//             when someone jumps and opens in the middle when someone spreads the arms
//   core      a glowing tear of light in the middle of the wall, the people stand in front of it
//   streaks   thin vertical lines of light flickering in the distance
//   motes     particles drifting in the air
// Everything is additive dots of about one LED, on black. Units: meters; the wall (the mirror) is
// the plane Z = 0, the mirror world lies at Z < 0, the eye looks along -Z.

import * as THREE from 'three/webgpu';
import {
  Fn, Loop, abs, cos, exp, float, floor, fract, hash, instanceIndex, instancedBufferAttribute, length, max, mix, pow,
  sin, smoothstep, step, uniform, uniformArray, uv, varying, vec2, vec3, vec4,
} from 'three/tsl';

export const MAX_MARKS = 8; // persons whose feet ripple the floor
export const MAX_QUAKES = 4; // quake rings at the same time

/** Round dot with a soft edge, as opacity. */
const dot = () => pow(max(float(1).sub(uv().sub(0.5).length().mul(2)), 0), 0.8);

export function createWorld() {
  const U = {
    time: uniform(0),
    energy: uniform(0), // how much the people move (0..1, smoothed)
    floor: uniform(1),
    wall: uniform(1),
    core: uniform(1),
    glow: uniform(1),
    streaks: uniform(1),
    motes: uniform(1),
    red: uniform(new THREE.Color('#ff1e3c')),
    pink: uniform(new THREE.Color('#ff3fa6')),
    blue: uniform(new THREE.Color('#3b4bff')),
    marks: uniformArray(Array.from({ length: MAX_MARKS }, () => new THREE.Vector4(0, -100, 0, 0)), 'vec4'),
    markColors: uniformArray(Array.from({ length: MAX_MARKS }, () => new THREE.Color(0, 0, 0)), 'color'),
    // interaction (see interact.js): quake rings (X, Z, start time, strength), how much everything shakes,
    // how far the wall is open, how much energy the raised arms gather
    quakes: uniformArray(Array.from({ length: MAX_QUAKES }, () => new THREE.Vector4(0, 0, -100, 0)), 'vec4'),
    quake: uniform(0),
    open: uniform(0),
    boost: uniform(0),
  };
  const group = new THREE.Group();
  const parts = []; // what build() made: { object, material, dispose? }
  const additive = () => new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const add = (object, material, order, dispose) => {
    object.frustumCulled = false;
    object.renderOrder = order;
    group.add(object);
    parts.push({ object, material, dispose });
  };
  const clear = () => {
    for (const p of parts) {
      group.remove(p.object);
      p.material.dispose();
      p.dispose?.();
    }
    parts.length = 0;
  };

  /** (Re)builds everything; the dot spacing depends on the view: { eyeH, eyeDist, ledPx, wallW } */
  function build(view) {
    clear();
    const rnd = mulberry(11);
    const { eyeH, eyeDist, ledPx, wallW } = view;
    const px = (Z) => (ledPx * (eyeDist - Z)) / eyeDist; // world meters per LED at depth Z
    const halfView = (Z) => ((wallW / 2 + 1.5) * (eyeDist - Z)) / eyeDist + 1;
    const t = U.time;
    const e2 = () => U.energy.mul(0.5).add(0.85);

    // ---------- floor: rows of dots, about 2.4 LEDs apart on the wall ----------
    {
      const data = [];
      let Z = -0.03;
      while (eyeDist - Z < 75 && data.length < 4 * 90000) {
        const dz = eyeDist - Z;
        const dx = 2.6 * px(Z);
        const half = halfView(Z);
        const row = rnd();
        for (let x = -half; x <= half; x += dx) data.push(x + (rnd() - 0.5) * dx * 0.5, Z, row, rnd());
        Z -= Math.max(0.02, (2.4 * ledPx * dz * dz) / (Math.max(0.3, eyeH) * eyeDist));
      }
      const a = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(data), 4));
      const dz = float(eyeDist).sub(a.y);
      // ripples around the feet of the people: xyz light, w height
      const ripples = Fn(() => {
        const height = float(0).toVar();
        const glow = vec3(0).toVar();
        Loop(MAX_MARKS, ({ i }) => {
          const m = U.marks.element(i);
          const d = length(vec2(a.x, a.y).sub(m.xy));
          const wave = sin(d.mul(14).sub(t.mul(5))).mul(exp(d.mul(-1.8))).mul(m.z);
          height.addAssign(wave.mul(0.025));
          glow.addAssign(vec3(U.markColors.element(i)).mul(max(wave, 0).mul(0.9).add(exp(d.mul(-3)).mul(m.z).mul(0.25))));
        });
        // quakes: a ring runs out from where someone landed and lifts the floor
        Loop(MAX_QUAKES, ({ i }) => {
          const q = U.quakes.element(i);
          const age = t.sub(q.z);
          const d = length(vec2(a.x, a.y).sub(q.xy));
          const front = d.sub(age.mul(7)).div(age.mul(0.25).add(0.5));
          const ring = exp(front.mul(front).negate()).mul(q.w).mul(exp(age.mul(-0.8))).mul(step(0, age));
          height.addAssign(ring.mul(0.45));
          glow.addAssign(mix(vec3(U.pink), vec3(1, 0.8, 0.9), ring.min(1).mul(0.5)).mul(ring.mul(1.5)));
        });
        return vec4(glow, height);
      })();
      // dunes far away, flat where the people stand
      const amp = smoothstep(7, 30, dz).mul(2.4);
      const ridge = sin(a.x.mul(0.19).add(a.y.mul(0.11)).add(t.mul(0.12)));
      const dune = ridge.mul(0.55).add(sin(a.x.mul(0.07).sub(a.y.mul(0.16)).sub(t.mul(0.08))).mul(0.8)).add(sin(a.x.mul(0.41).add(a.y.mul(0.37)).add(t.mul(0.2))).mul(0.18));
      const mat = additive();
      mat.positionNode = vec3(a.x, dune.add(1).mul(amp).mul(0.5).add(ripples.w), a.y);
      mat.scaleNode = vec2(float(ledPx * 1.25).mul(dz).div(eyeDist));
      const twinkle = step(0.985, hash(float(instanceIndex).add(floor(t.mul(2).add(a.w.mul(10))).mul(131))));
      const base = mix(vec3(U.pink), vec3(U.red), smoothstep(3, 25, dz)).mul(float(0.16).add(ridge.mul(0.5).add(0.5).mul(amp).mul(0.08)));
      // the floor is lit red by the core at the far end
      const lit = exp(length(vec2(a.x, a.y.add(68))).div(-20)).mul(0.9).mul(U.core).mul(e2());
      const col = base.add(vec3(U.pink).mul(twinkle.mul(0.6))).mul(exp(dz.div(-38))).add(vec3(U.red).mul(lit)).add(ripples.xyz).mul(a.z.mul(0.35).add(0.65));
      mat.colorNode = varying(col.mul(U.floor));
      mat.opacityNode = dot();
      const object = new THREE.Sprite(mat);
      object.count = data.length / 4;
      add(object, mat, -6);
    }

    // ---------- the blackwall: an arena of particle columns, far in the middle, near at the sides ----------
    {
      // an ellipse around the scene: Z = -15 - 57 cos(th), X = 46 sin(th); seen at a slant at the sides
      const A = 46;
      const B = 57;
      const cols = [];
      const pts = [];
      for (const sgn of [1, -1]) {
        let th = sgn > 0 ? 0 : -1e-6;
        while (Math.abs(th) < Math.PI / 2) {
          const x = A * Math.sin(th);
          const z = -15 - B * Math.cos(th);
          const dist = eyeDist - z;
          if (Math.abs(x) / dist > (wallW / 2 + 2) / eyeDist + 0.25) break;
          const gap = 2.4 * ledPx * Math.hypot(dist, x) / eyeDist;
          const top = 9 + rnd() ** 2 * 28;
          const col = rnd();
          for (let y = -1.5; y <= top; y += gap) {
            pts.push(x, y, z, col);
            cols.push(th, rnd(), top, 0);
          }
          th += sgn * (gap / Math.hypot(A * Math.cos(th), B * Math.sin(th)));
        }
      }
      const a = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(pts), 4));
      const b = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(cols), 4));
      // spread arms open the wall in the middle
      const th = b.x.add(b.x.sign().mul(U.open).mul(0.42).mul(exp(abs(b.x).div(-0.32))));
      const e = U.energy;
      const shake = U.quake;
      const speed = t.mul(e.mul(0.8).add(1));
      // the surface heaves (outwards = away from the viewer); the bands travel sideways
      const w = sin(th.mul(7).add(speed.mul(0.25))).mul(3.2)
        .add(sin(th.mul(19).sub(speed.mul(0.42)).add(a.y.mul(0.06))).mul(1.5))
        .add(sin(a.y.mul(0.12).add(speed.mul(0.3)).add(th.mul(3))).mul(1.2))
        .mul(e.mul(0.9).add(0.8)).mul(shake.mul(1.5).add(1));
      const out = vec3(sin(th), 0, cos(th).negate());
      // it trembles in a quake
      const jolt = floor(t.mul(24)).mul(131).add(floor(a.w.mul(9973)));
      const tremble = vec3(hash(jolt).sub(0.5), hash(jolt.add(17)).sub(0.5), hash(jolt.add(41)).sub(0.5)).mul(shake.mul(3));
      // a few particles come loose and drift towards the viewer and with the wind
      const loose = step(0.94, b.y);
      const life = fract(t.mul(0.045).add(b.y.mul(37)));
      const blow = vec3(sin(th).negate().mul(14).add(10), life.mul(4), cos(th).mul(22)).mul(life).mul(loose);
      const base = vec3(sin(th).mul(A), a.y, cos(th).mul(-B).sub(15));
      const pos = base.add(out.mul(w)).add(vec3(0, sin(th.mul(11).add(t.mul(0.3))).mul(0.6), 0)).add(blow).add(tremble);
      const dz = float(eyeDist).sub(pos.z);
      const mat = additive();
      mat.positionNode = pos;
      mat.scaleNode = vec2(float(ledPx * 1.3).mul(length(vec2(dz, pos.x))).div(eyeDist));
      // ridges (towards the viewer) red to pink, grooves blue
      let col = mix(vec3(U.blue).mul(0.8), vec3(U.red), smoothstep(2.5, -2.5, w));
      col = mix(col, vec3(U.pink), smoothstep(-2.5, -5, w).mul(0.8));
      const stripes = hash(floor(a.w.mul(9973))).mul(0.65).add(0.35);
      const fall = exp(a.y.div(-13)).mul(smoothstep(-1.5, 1.5, a.y)).mul(smoothstep(b.z, b.z.sub(3), a.y).mul(0.6).add(0.4));
      const flicker = sin(t.mul(3).add(b.y.mul(60))).mul(0.15).add(0.85);
      const bright = fall.mul(stripes).mul(flicker).mul(e.mul(0.7).add(0.9)).mul(float(1).sub(life.mul(loose)))
        .mul(U.boost.mul(0.6).add(shake.mul(0.6)).add(1));
      mat.colorNode = varying(col.mul(bright).mul(U.wall));
      mat.opacityNode = dot();
      const object = new THREE.Sprite(mat);
      object.count = pts.length / 4;
      add(object, mat, -8);
    }

    // ---------- the core: a glowing tear of light in the middle of the wall ----------
    {
      const COUNT = 44;
      const data = [];
      for (let i = 0; i < COUNT; i++) {
        const g = (rnd() + rnd() + rnd()) / 3 - 0.5; // more of them in the middle
        data.push(g * 7, (6 + rnd() ** 1.5 * 30) * (1 - Math.abs(g) * 1.2), 0.15 + rnd() ** 2 * 0.7, rnd());
      }
      const a = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(data), 4));
      const Zc = -68;
      const mat = additive();
      mat.positionNode = vec3(a.x.add(sin(t.mul(0.4).add(a.w.mul(30))).mul(0.3)), float(-0.5), float(Zc));
      const k = floor(t.mul(a.w.mul(4).add(2)).add(a.w.mul(50)));
      const pulse = hash(float(instanceIndex).add(k.mul(131))).mul(0.7).add(0.3);
      const grow = U.open.mul(0.8).add(U.boost.mul(0.7)).add(1);
      mat.scaleNode = vec2(a.z.mul(U.open.mul(0.6).add(1)), a.y.mul(pulse.mul(0.4).add(0.6)).mul(grow));
      const across = abs(uv().x.sub(0.5)).mul(2);
      const along = uv().y;
      const shape = float(1).sub(across).mul(pow(float(1).sub(along), 1.2));
      const col = mix(vec3(1, 0.85, 0.9), vec3(U.red), smoothstep(0.05, 0.6, across).max(smoothstep(0.2, 0.9, along)));
      const flare = U.open.mul(1.2).add(U.boost.mul(1.5)).add(U.quake).add(1);
      mat.colorNode = varying(col.mul(pulse).mul(U.core).mul(e2()).mul(flare));
      mat.opacityNode = shape;
      const object = new THREE.Sprite(mat);
      object.center.set(0.5, 0);
      object.count = COUNT;
      add(object, mat, -7);

      // and a faint red glow around it
      const glowMat = additive();
      glowMat.positionNode = vec3(0, 6, Zc - 2);
      glowMat.scaleNode = vec2(60, 36);
      const r = uv().sub(0.5).mul(vec2(2, 2)).length();
      glowMat.colorNode = vec3(U.red).mul(exp(r.mul(r).mul(-6)).mul(0.22).mul(U.core).mul(U.glow).mul(e2()).mul(U.open.add(U.boost).add(1)));
      glowMat.opacityNode = float(1);
      const glow = new THREE.Sprite(glowMat);
      add(glow, glowMat, -9);
    }

    // ---------- streaks: thin vertical lines of light in the distance ----------
    {
      const COUNT = 40;
      const data = [];
      for (let i = 0; i < COUNT; i++) {
        const z = -14 - rnd() * 50;
        data.push((rnd() * 2 - 1) * halfView(z), z, 4 + rnd() ** 2 * 40, rnd());
      }
      const a = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(data), 4));
      const dz = float(eyeDist).sub(a.y);
      const mat = additive();
      mat.positionNode = vec3(a.x.add(sin(t.mul(0.05).add(a.w.mul(40))).mul(2)), float(-0.5), a.y);
      mat.scaleNode = vec2(float(ledPx * 1.1).mul(dz).div(eyeDist), a.z);
      const k = floor(t.mul(a.w.mul(3).add(1.5)).add(a.w.mul(100)));
      const on = step(0.72, hash(float(instanceIndex).add(k.mul(131))));
      const shape = pow(float(1).sub(uv().y), 1.5).mul(float(1).sub(abs(uv().x.sub(0.5)).mul(2)));
      mat.colorNode = varying(mix(vec3(U.red), vec3(U.pink), a.w).mul(on.mul(0.9).add(0.04)).mul(exp(dz.div(-45))).mul(U.streaks));
      mat.opacityNode = shape;
      const object = new THREE.Sprite(mat);
      object.center.set(0.5, 0);
      object.count = COUNT;
      add(object, mat, -4);
    }

    // ---------- motes drifting in the air ----------
    {
      const COUNT = 1400;
      const data = [];
      for (let i = 0; i < COUNT; i++) {
        const z = -0.3 - rnd() ** 1.4 * 22;
        data.push((rnd() * 2 - 1) * halfView(z), rnd() * (eyeH + (2.2 * (eyeDist - z)) / eyeDist), z, rnd());
      }
      const a = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(data), 4));
      // a slow wind to the side, wrapping around
      const span = a.z.negate().add(eyeDist).mul((2 * (wallW / 2 + 2)) / eyeDist);
      const x = fract(a.x.add(t.mul(a.w.mul(0.25).add(0.08))).div(span).add(0.5)).sub(0.5).mul(span);
      const pos = vec3(x, a.y.add(sin(t.mul(0.3).add(a.w.mul(50))).mul(0.15)), a.z.add(cos(t.mul(0.2).add(a.w.mul(30))).mul(0.2)));
      const dz = float(eyeDist).sub(pos.z);
      const mat = additive();
      mat.positionNode = pos;
      mat.scaleNode = vec2(float(ledPx).mul(a.w.add(1)).mul(dz).div(eyeDist));
      const twinkle = pow(sin(t.mul(a.w.mul(2).add(0.5)).add(a.w.mul(90))).mul(0.5).add(0.5), 4);
      const col = mix(vec3(U.pink), vec3(U.blue), step(0.7, hash(instanceIndex.add(3)))).mul(twinkle.mul(0.7).add(0.08)).mul(exp(dz.div(-18)));
      mat.colorNode = varying(col.mul(U.motes));
      mat.opacityNode = dot();
      const object = new THREE.Sprite(mat);
      object.count = COUNT;
      add(object, mat, 3);
    }
  }

  return { group, U, build, dispose: clear };
}

/** Small deterministic random generator (the world looks the same on every load). */
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
