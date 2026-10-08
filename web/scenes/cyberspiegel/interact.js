// What the people do, read from their skeletons (ctx.persons, delayed mode: exact joints):
//   jump      the pelvis goes up (at least 6 cm) and comes down again: an event on landing; jumping
//             jacks count too (strength: takeoff speed and height)
//   charge    both hands above the head: fills in about a second when held, drains slowly, so many
//             jumping jacks fill it too; 'erupt' when it is full
//   open      the arms spread wide at shoulder height: 0..1 while held
//   clap      the hands meet fast: an event between the hands
//   upload    standing still for a few seconds: 0..1, back to 0 quickly when moving
//   arcs      hands of two people close to each other: a link, 'touch' when they meet
//   near      how close the nearest person is to the wall: 0..1
// Events and positions are in the world space of ctx.persons (m), with the slot of the person they
// belong to; main.js maps them to the mirror (each person is shifted on the wall on their own).

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const len = (v) => (v ? Math.hypot(v[0], v[1], v[2]) : 0);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const ok = (p, name, c = 0.3) => (p.joints[name] && (p.confidence[name] ?? 1) >= c ? p.joints[name] : null);

export function createInteractions() {
  const states = new Map(); // person id -> state
  const touching = new Set(); // 'idA:idB' pairs whose hands touch

  function stateOf(p, t) {
    let s = states.get(p.id);
    if (!s) {
      s = { phase: 'ground', peak: 0, base: 0, top: 0, since: t, cool: 0, pelvis: [], charge: 0, up: false, erupted: false, open: 0, still: 0, upload: 0, hands: [], clapCool: 0 };
      states.set(p.id, s);
    }
    s.seen = t;
    return s;
  }

  return {
    states,

    /**
     * persons: ctx.persons; front: the Kinect's distance from the wall (m). Returns
     * { events: [{ type, at (world), strength, id, slot }], people: [{ id, slot, charge, open, upload }],
     *   arcs: [{ a, b (world), sa, sb (their slots), strength }], near }; a 'touch' event also has a, b, sa, sb
     */
    update(persons, t, dt, front) {
      const events = [];
      const people = [];
      const fresh = persons.fresh;
      let near = 0;
      for (const p of persons) {
        const s = stateOf(p, t);
        const head = p.room.head ?? p.room.joints.nose;
        const rl = p.room.joints.leftHand;
        const rr = p.room.joints.rightHand;
        const lh = ok(p, 'leftHand');
        const rh = ok(p, 'rightHand');

        // ---- jump: the pelvis goes up, then down, then stops (on fresh results; spikes ignored)
        const vy = (p.motion.pelvis ?? p.motion.center ?? [0, 0, 0])[1];
        const py = p.room.joints.pelvis?.[1];
        if (fresh && py != null && Math.abs(vy) < 4) {
          s.pelvis.push([t, py]);
          while (s.pelvis.length && s.pelvis[0][0] < t - 0.6) s.pelvis.shift();
          if (s.phase === 'ground' && vy > 0.45 && t > s.cool) {
            s.phase = 'up';
            s.peak = vy;
            s.base = Math.min(...s.pelvis.map((h) => h[1]));
            s.top = py;
            s.since = t;
          } else if (s.phase === 'up') {
            s.peak = Math.max(s.peak, vy);
            s.top = Math.max(s.top, py);
            if (vy < -0.35) s.phase = 'down';
            else if (t - s.since > 1) s.phase = 'ground';
          } else if (s.phase === 'down') {
            s.top = Math.max(s.top, py);
            if (vy > -0.12 || t - s.since > 1.4) {
              s.phase = 'ground';
              s.cool = t + 0.25;
              const rise = s.top - s.base;
              if (rise > 0.06 && rise < 0.9 && p.ground) {
                const strength = clamp01(0.25 + (s.peak - 0.4) / 1.4 + rise * 1.2);
                events.push({ type: 'jump', at: p.ground, strength, id: p.id, slot: p.slot });
              }
            }
          }
        }

        // ---- both hands above the head: charge, then erupt
        const up = head && rl && rr && lh && rh && rl[1] > head[1] + 0.05 && rr[1] > head[1] + 0.05;
        s.up = !!up;
        s.charge = clamp01(s.charge + (up ? dt / 1.1 : -dt / 3));
        if (s.charge >= 1 && !s.erupted) {
          s.erupted = true;
          events.push({ type: 'erupt', at: mid(lh, rh), strength: 1, id: p.id, slot: p.slot });
        }
        if (s.charge < 0.3) s.erupted = false;

        // ---- arms spread wide at shoulder height
        const ls = p.room.joints.leftShoulder;
        const rs = p.room.joints.rightShoulder;
        let wide = false;
        if (rl && rr && ls && rs && lh && rh) {
          const span = Math.hypot(rl[0] - rr[0], rl[2] - rr[2]);
          const shoulders = Math.hypot(ls[0] - rs[0], ls[2] - rs[2]);
          const sh = (ls[1] + rs[1]) / 2;
          wide = span > Math.max(1.15, 2.6 * shoulders) && Math.abs(rl[1] - sh) < 0.3 && Math.abs(rr[1] - sh) < 0.3;
        }
        s.open = clamp01(s.open + (wide ? dt / 0.7 : -dt / 1.2));

        // ---- clap: the hands were apart and meet fast
        if (lh && rh && fresh) {
          const d = dist(lh, rh);
          s.hands.push([t, d]);
          while (s.hands.length && s.hands[0][0] < t - 0.45) s.hands.shift();
          const before = Math.max(...s.hands.map((h) => h[1]));
          if (d < 0.2 && before > 0.5 && t > s.clapCool) {
            s.clapCool = t + 0.5;
            events.push({ type: 'clap', at: mid(lh, rh), strength: clamp01((before - 0.3) / 0.8), id: p.id, slot: p.slot });
          }
        }

        // ---- standing still: upload
        const moving = Math.max(len(p.velocity), len(p.motion.leftHand), len(p.motion.rightHand), len(p.motion.head));
        s.still = moving < 0.3 ? s.still + dt : Math.max(0, s.still - dt * 4);
        s.moving = moving;
        s.upload = smooth(2.5, 7, s.still);

        // ---- close to the wall
        if (p.room.center) near = Math.max(near, smooth(1.5, 0.9, p.room.center[2] + front));

        people.push({ id: p.id, slot: p.slot, charge: s.charge, up: s.up, open: s.open, upload: s.upload, still: s.still, moving, person: p });
      }

      // ---- hands of two people close together
      const arcs = [];
      for (let i = 0; i < persons.length; i++) {
        for (let j = i + 1; j < persons.length; j++) {
          const A = persons[i];
          const B = persons[j];
          let best = null;
          for (const ha of ['leftHand', 'rightHand']) {
            for (const hb of ['leftHand', 'rightHand']) {
              const a = ok(A, ha);
              const b = ok(B, hb);
              if (!a || !b) continue;
              const d = dist(a, b);
              if (!best || d < best.d) best = { a, b, d };
            }
          }
          const key = `${Math.min(A.id, B.id)}:${Math.max(A.id, B.id)}`;
          if (!best || best.d > 1.1) {
            touching.delete(key);
            continue;
          }
          const arc = { a: best.a, b: best.b, sa: A.slot, sb: B.slot, strength: smooth(1.1, 0.25, best.d) };
          arcs.push(arc);
          if (best.d < 0.15 && !touching.has(key)) {
            touching.add(key);
            events.push({ type: 'touch', at: mid(best.a, best.b), strength: 1, id: A.id, slot: A.slot, a: arc.a, b: arc.b, sa: arc.sa, sb: arc.sb });
          } else if (best.d > 0.3) touching.delete(key);
        }
      }

      for (const [id, s] of states) if (t - s.seen > 3) states.delete(id);
      return { events, people, arcs, near };
    },
  };
}
