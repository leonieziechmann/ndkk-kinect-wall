// How the people move, for the sounds that follow them (the air of the waving hand, the water of
// the fluid): how fast the hands move (0..1) and where the busiest hand is, for the lead person
// (choreo.ts, ROLES.lead) and for everybody, on the story clock. It comes from src/lib/people.ts,
// the same choreography the picture shows, loaded through Vite like tools/check-arms.mjs does.

import { createServer } from 'vite';
import { clamp } from './dsp.mjs';

/** samples per second */
const RATE = 100;

export async function loadStory(root) {
  const server = await createServer({ root, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom', plugins: [], configFile: false });
  const { people, J } = await server.ssrLoadModule('/src/lib/people.ts');
  const { ROLES } = await server.ssrLoadModule('/src/lib/choreo.ts');
  const { SCENES } = await server.ssrLoadModule('/src/lib/timeline.ts');
  await server.close();

  const N = Math.ceil(SCENES.ende * RATE) + 2;
  const series = { lead: { speed: new Float32Array(N), x: new Float32Array(N) }, all: { speed: new Float32Array(N), x: new Float32Array(N) } };
  // hand speed (m/s) to 0..1: idle hands ~0, a wave ~0.6, a fast swing towards 1
  const level = (v) => 1 - Math.exp(-v / 1.6);
  let prev = new Map();
  for (let k = 0; k < N; k++) {
    const now = new Map();
    let still = 1;
    let wx = 0;
    let ws = 0;
    for (const p of people(k / RATE)) {
      const hands = [J.leftHand, J.rightHand].map((j) => [...p.joints[j]]);
      now.set(p.slot, hands);
      const before = prev.get(p.slot);
      if (!before) continue;
      let v = 0;
      let x = p.center[0];
      hands.forEach((h, i) => {
        const b = before[i];
        const hv = Math.hypot(h[0] - b[0], h[1] - b[1], h[2] - b[2]) * RATE;
        if (hv > v) {
          v = hv;
          x = h[0];
        }
      });
      const s = level(v);
      if (p.slot === ROLES.lead) {
        series.lead.speed[k] = s;
        series.lead.x[k] = x;
      }
      still *= 1 - s;
      wx += s * x;
      ws += s;
    }
    series.all.speed[k] = 1 - still;
    series.all.x[k] = ws > 0 ? wx / ws : 0;
    prev = now;
  }
  // follow quickly up and let go slowly, so a sound breathes with the gesture instead of buzzing
  const up = 1 - Math.exp(-1 / (0.05 * RATE));
  const down = 1 - Math.exp(-1 / (0.35 * RATE));
  const glide = 1 - Math.exp(-1 / (0.2 * RATE));
  for (const m of Object.values(series)) {
    let s = 0;
    let x = 0;
    for (let k = 0; k < N; k++) {
      s += (m.speed[k] - s) * (m.speed[k] > s ? up : down);
      x += (m.x[k] - x) * glide;
      m.speed[k] = s;
      m.x[k] = x;
    }
  }

  /** the motion at story time t (s): speed 0..1, x (m, in the room, to the right as seen) */
  function motion(t, who = 'all') {
    const m = series[who];
    const f = clamp(t * RATE, 0, N - 1.001);
    const k = Math.floor(f);
    const a = f - k;
    return { speed: m.speed[k] + (m.speed[k + 1] - m.speed[k]) * a, x: m.x[k] + (m.x[k + 1] - m.x[k]) * a };
  }

  return { SCENES, motion };
}
