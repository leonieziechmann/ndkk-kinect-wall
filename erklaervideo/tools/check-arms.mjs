// Checks every frame of the story (30 per second) for arm poses that could read as a raised-arm
// salute: an arm stretched (or nearly) forward, level or upward. The video is shown in Germany; no
// such pose may ever appear, not even for one frame in a transition.
//
//   npm run check-arms        prints the frames it finds and exits with 1, or "OK"; checks both cuts
//                             of the video (timeline.ts): the full one and the one for social media

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** the people of one cut (timeline.ts): a fresh module graph each, with the flag set before */
async function load(cut) {
  globalThis.__CUT = cut;
  const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom', plugins: [], configFile: false });
  const { people } = await server.ssrLoadModule('/src/lib/people.ts');
  const { SCENES } = await server.ssrLoadModule('/src/lib/timeline.ts');
  await server.close();
  return { people, SCENES };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const deg = (r) => (r * 180) / Math.PI;

let failed = false;
for (const cut of ['full', 'social']) {
  const { people, SCENES } = await load(cut);
  const end = Math.max(...Object.values(SCENES));
  const found = [];
  let worst = { fwd: -1 };
  for (let f = 0; f <= end * 30; f++) {
    const T = f / 30;
    for (const p of people(T)) {
      const J = p.joints;
      for (const [side, sh, el, wr] of [['links', 5, 7, 9], ['rechts', 6, 8, 10]]) {
        const upper = norm(sub(J[el], J[sh]));
        const fore = norm(sub(J[wr], J[el]));
        const arm = norm(sub(J[wr], J[sh]));
        const bend = deg(Math.acos(Math.max(-1, Math.min(1, dot(upper, fore)))));
        const fwd = dot(arm, p.F);
        const elev = deg(Math.asin(arm[1]));
        // stretched (bend under 60°) and pointing forward at shoulder height or above
        const bad = bend < 60 && fwd > 0.45 && elev > -10;
        if (bad) found.push(`${T.toFixed(2)} s  Person ${p.slot}, Arm ${side}: nach vorne ${fwd.toFixed(2)}, ${elev.toFixed(0)}° hoch, Ellbogen ${bend.toFixed(0)}°`);
        if (elev > -10 && fwd > worst.fwd) worst = { fwd, T, slot: p.slot, side, bend, elev };
      }
    }
  }
  const name = cut === 'full' ? 'Video' : 'Social-Fassung';
  if (found.length) {
    console.log(found.slice(0, 50).join('\n'));
    console.log(`${name}: ${found.length} Arm-Posen gefunden, die nach vorne gestreckt sind.`);
    failed = true;
    continue;
  }
  console.log(
    `${name} OK: kein gestreckter Arm nach vorne in ${Math.round(end * 30)} Bildern. Am weitesten nach vorne: ` +
      `${worst.fwd.toFixed(2)} bei ${worst.T.toFixed(2)} s (Person ${worst.slot}, ${worst.side}, Ellbogen ${worst.bend.toFixed(0)}° gebeugt).`,
  );
}
if (failed) process.exit(1);
