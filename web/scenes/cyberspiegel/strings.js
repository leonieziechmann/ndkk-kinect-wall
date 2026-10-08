// Marionette strings: thin threads of light from the top of everyone's head and from both hands up
// out of the picture, to an invisible puppeteer above them (or, as an option, all to the core of
// the Blackwall). The puppeteer follows the person with a lag, so the strings lean when someone
// walks. Fast hands make their string bow and swing, a jump makes the strings go slack and twang.
// Whoever comes in is let down on the strings; whoever leaves, their strings snap up and away.
//
// Everything is in the mirror world (m); the strings are drawn as dots of about one LED.

const ATTACH = [
  { name: 'head', bar: 0 }, // the top of the head, from the middle of the control bar
  { name: 'leftHand', bar: -1 },
  { name: 'rightHand', bar: 1 },
];
const CORE = [0, 26, -66]; // where all strings meet in "Kern" mode

export function createStrings() {
  const puppets = new Map(); // person id -> state

  function puppetOf(id, t) {
    let s = puppets.get(id);
    if (!s) {
      s = { attach: 0, seen: t, leaving: false, anchor: null, strings: ATTACH.map(() => ({ end: null, vel: [0, 0, 0], bow: [0, 0, 0], vib: 0, phase: Math.random() * 6.28 })) };
      puppets.set(id, s);
    }
    return s;
  }

  return {
    /**
     * persons: ctx.persons; joint(person, name), motion(person, name) -> mirror position, velocity
     * (m/s) or null; view: { eyeH, eyeDist,
     * wallTop, ledPx }; o: { amount, target ('up' | 'core'), color [r, g, b], swing, slack (0..1,
     * a jump just now), dissolve(slot) }; point(x, y, z, size, r, g, b) draws one dot.
     */
    update(persons, t, dt, joint, motion, view, o, point) {
      const k = Math.min(1, dt * 6);
      for (const q of persons) {
        const s = puppetOf(q.id, t);
        s.seen = t;
        s.leaving = false;
        s.slot = q.slot;
        // let down on the strings when someone comes in
        s.attach = Math.min(1, s.attach + dt / 0.9);
        const head = joint(q, 'head');
        if (head) {
          const above = o.target === 'core' ? CORE : [head[0], head[1] + 4.5, head[2] - 0.2];
          if (!s.anchor) s.anchor = [...above];
          // the puppeteer follows slowly
          for (let i = 0; i < 3; i++) s.anchor[i] += (above[i] - s.anchor[i]) * Math.min(1, dt * (o.target === 'core' ? 4 : 1.4));
        }
        ATTACH.forEach((a, i) => {
          const str = s.strings[i];
          let j = joint(q, a.name);
          if (a.name === 'head' && j) j = [j[0], j[1] + 0.12, j[2]]; // the crown, not the face
          if (!j) return;
          const v = motion(q, a.name) ?? [0, 0, 0];
          const dv = Math.hypot(v[0] - str.vel[0], v[1] - str.vel[1], v[2] - str.vel[2]);
          for (let c = 0; c < 3; c++) str.vel[c] += (v[c] - str.vel[c]) * k;
          // a jerk makes the string swing
          str.vib = Math.max(str.vib * Math.exp(-dt * 3.5), Math.min(0.035, dv * 0.012) * o.swing);
          str.end = j;
          // the middle of the string lags behind the hand
          for (let c = 0; c < 3; c++) {
            const target = Math.max(-0.35, Math.min(0.35, -str.vel[c] * 0.12 * o.swing));
            str.bow[c] += (target - str.bow[c]) * k;
          }
        });
      }
      // strings of those who left snap up
      for (const [id, s] of puppets) {
        if (t - s.seen < 0.05) continue;
        s.leaving = true;
        s.attach -= dt / 0.45;
        if (s.attach <= 0) puppets.delete(id);
      }

      if (o.amount <= 0) return;
      const { eyeH, eyeDist, wallTop, ledPx } = view;
      for (const [, s] of puppets) {
        if (!s.anchor) continue;
        const fade = Math.max(0, Math.min(1, s.attach * 1.5)) * (1 - 0.8 * (o.dissolve(s.slot) ?? 0));
        ATTACH.forEach((a, i) => {
          const str = s.strings[i];
          if (!str.end) return;
          const top = o.target === 'core' ? CORE : [s.anchor[0] + a.bar * 0.3, s.anchor[1], s.anchor[2]];
          // the lower end: on the joint, or on the way up (coming in, leaving)
          const ease = s.attach * s.attach * (3 - 2 * s.attach);
          const lo = [0, 1, 2].map((c) => top[c] + (str.end[c] - top[c]) * ease);
          const d = [top[0] - lo[0], top[1] - lo[1], top[2] - lo[2]];
          const L = Math.hypot(d[0], d[1], d[2]) || 1;
          // only the part that is in view: up to the top edge of the wall at that depth (+ margin)
          const dz = eyeDist - lo[2];
          const yTop = eyeH + ((wallTop - eyeH) * dz) / eyeDist + 0.3;
          const fMax = d[1] > 0.01 ? Math.min(1, Math.max(0.02, (yTop - lo[1]) / d[1])) : 1;
          const step = (ledPx * 1.05 * dz) / eyeDist;
          const n = Math.min(400, Math.ceil((fMax * L) / step));
          const slack = 1 + 2.5 * o.slack; // a jump: the strings bow out
          const tension = Math.min(1, Math.hypot(...str.vel) * 0.4);
          const b = (0.75 + 0.7 * tension + 0.6 * str.vib * 10) * o.amount * fade;
          const size = ledPx * 1.15;
          for (let m = 0; m <= n; m++) {
            const f = (m / n) * fMax;
            const env = Math.sin(Math.PI * f);
            // a standing wave (still at both ends), long enough not to look like a zigzag
            const wave = Math.sin(f * L * 4 - t * 28 + str.phase) * str.vib * env;
            const x = lo[0] + d[0] * f + str.bow[0] * env * slack + wave;
            const y = lo[1] + d[1] * f + str.bow[1] * env * 0.3;
            const z = lo[2] + d[2] * f + str.bow[2] * env * slack + wave * 0.5;
            const depth = (eyeDist - z) / eyeDist;
            // brighter near the body, a little flicker like a thread catching light
            const lit = b * (0.7 + 0.3 * (1 - f / fMax)) * (0.85 + 0.15 * Math.sin(f * 40 + t * 7 + i));
            point(x, y, z, size * depth, o.color[0] * lit, o.color[1] * lit, o.color[2] * lit);
          }
          // a small knot where it holds on
          if (s.attach > 0.95 && !s.leaving) {
            const kb = 1.6 * o.amount * fade;
            point(lo[0], lo[1], lo[2] + 0.02, ledPx * 2 * (dz / eyeDist), o.color[0] * kb, o.color[1] * kb, o.color[2] * kb);
          }
        });
      }
    },
  };
}
