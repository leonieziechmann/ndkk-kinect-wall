// Tracking check for Space Invaders: is it the tracking or the game? Left the Kinect view as the game
// gets it (live, masks + skeletons, the same tracker settings), right the floor from above exactly as
// the game reads it (the same code: ../space-invaders/body.js): the mask points by height, the torso,
// the arms it found, the turn from the shoulders, jumps.
//
// Left:  the person mask (colored per person), the stick figure (dim joints: low confidence), the
//        shoulders as a thick line.
// Right: the wall (top) and the zone; per person the mask points from above (brighter = higher), the
//        torso (ring), every arm found (line: real direction and length), the turn (arrow), a jump
//        (flash). Bottom: tracker numbers.

import game from '../space-invaders/main.js';
import { makeLayout } from '../space-invaders/main.js';
import { Bodies } from '../space-invaders/body.js';
import { BONES, POINTS, personColor } from '/lib/persons.js';

const W = 512;
const H = 424;
const STATES = new WeakMap();
const COLS = Array.from({ length: 17 }, (_, s) => personColor(s, [0, 0, 0]));

// the game's parameters (defaults), with the ones of this page on top
const gameParams = Object.fromEntries(Object.entries(game.params).map(([k, v]) => [k, v.value]));

export default {
  streams: ['persons'],
  // as the game: live masks, live + exact skeletons (or the delayed output alone, for comparison)
  persons: (p) => (p.timing === 'verzögert (genau)' ? { mode: 'full', delay: 12 } : p.exactSlow ? { mode: 'full', live: true } : { mode: 'full', delay: 0 }),

  params: {
    timing: { value: 'live (wie das Spiel)', options: ['live (wie das Spiel)', 'verzögert (genau)'], label: 'Tracking' },
    mask: { value: 0.45, min: 0, max: 1, step: 0.01, label: 'Maske' },
    raw: { value: false, label: 'Rohe Keypoints (ungeglättet)' },
    ghost: { value: true, label: 'Exaktes Skelett dazu (hängt etwas hinterher)' },
    armSource: { value: gameParams.armSource, options: ['Skelett', 'Maske'], label: 'Arme aus' },
    exactSlow: { value: gameParams.exactSlow, label: 'Skelett: langsam exakt, schnell live' },
    exactBelow: { value: gameParams.exactBelow, min: 0, max: 2, step: 0.05, label: 'Exakt unter (m/s)' },
    liveAbove: { value: gameParams.liveAbove, min: 0.1, max: 3, step: 0.05, label: 'Live über (m/s)' },
    armMin: { value: gameParams.armMin, min: 0.2, max: 0.6, step: 0.01, label: 'Arm ab (m vom Körper)' },
    mirrorArm: { value: true, label: 'Verdeckten Arm ergänzen (gestrichelt)' },
  },

  setup(ctx) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000';
    ctx.dom.append(canvas);
    const mask = new ImageData(W, H);
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    STATES.set(ctx, { canvas, g: canvas.getContext('2d'), mask, off, og: off.getContext('2d'), body: new Bodies(), seqs: [], jumps: new Map(), t0: performance.now() });
  },

  frame(ctx) {
    const S = STATES.get(ctx);
    const { canvas, g } = S;
    const dpr = ctx.pixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr);
    const ch = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const time = (performance.now() - S.t0) / 1000;
    g.fillStyle = '#000';
    g.fillRect(0, 0, cw, ch);
    const R = ctx.kinect.persons;
    const fs = Math.max(11, Math.round(13 * dpr));
    g.font = `${fs}px ui-monospace, Consolas, monospace`;

    // ---- left: the Kinect view (as the hub sends it: mirrored, like a mirror)
    const lw = Math.min(cw * 0.46, ((ch - 3 * fs) * W) / H);
    const lh = (lw * H) / W;
    const lx = 0;
    const ly = 0;
    const sx = lw / W;
    const sy = lh / H;
    if (R?.indices) {
      const d = S.mask.data;
      d.fill(0);
      const a = Math.round(ctx.params.mask * 255);
      for (let j = 0; j < R.indices.length; j++) {
        const i = R.indices[j];
        const c = COLS[R.labels[i]] ?? COLS[0];
        d[i * 4] = c[0] * 255;
        d[i * 4 + 1] = c[1] * 255;
        d[i * 4 + 2] = c[2] * 255;
        d[i * 4 + 3] = a;
      }
      S.og.putImageData(S.mask, 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(S.off, lx, ly, lw, lh);
    }
    g.strokeStyle = '#333';
    g.strokeRect(lx + 0.5, ly + 0.5, lw - 1, lh - 1);
    const css = (p, a = 1) => {
      const c = personColor(p.slot);
      return `rgba(${c.map((v) => Math.round(v * 255)).join(',')},${a})`;
    };
    // the exact skeletons (live + exact): dim and dashed, where they were a few frames ago
    if (ctx.params.ghost && ctx.persons.mode === 'both' && ctx.persons.exact) {
      g.setLineDash([4 * dpr, 4 * dpr]);
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.lineWidth = 2 * dpr;
      for (const p of ctx.persons.exact) {
        const J = p.image.joints;
        for (const [a, b] of BONES) {
          const pa = J[POINTS[a]];
          const pb = J[POINTS[b]];
          if (!pa || !pb) continue;
          g.beginPath();
          g.moveTo(lx + pa[0] * sx, ly + pa[1] * sy);
          g.lineTo(lx + pb[0] * sx, ly + pb[1] * sy);
          g.stroke();
        }
      }
      g.setLineDash([]);
    }
    for (const p of ctx.persons) {
      const J = p.image.joints;
      const C = p.confidence;
      const at = (n) => J[n] && [lx + J[n][0] * sx, ly + J[n][1] * sy];
      g.lineCap = 'round';
      for (const [a, b] of BONES) {
        const pa = at(POINTS[a]);
        const pb = at(POINTS[b]);
        if (!pa || !pb) continue;
        const conf = Math.min(C[POINTS[a]] ?? 1, C[POINTS[b]] ?? 1);
        g.strokeStyle = conf < 0.3 ? 'rgba(255,255,255,0.25)' : '#fff';
        g.lineWidth = 2.5 * dpr;
        g.beginPath();
        g.moveTo(...pa);
        g.lineTo(...pb);
        g.stroke();
      }
      // the shoulders: what the turn is made of
      const ls = at('leftShoulder');
      const rs = at('rightShoulder');
      if (ls && rs) {
        g.strokeStyle = css(p);
        g.lineWidth = 6 * dpr;
        g.beginPath();
        g.moveTo(...ls);
        g.lineTo(...rs);
        g.stroke();
        g.fillStyle = '#f44';
        g.fillText('L', ls[0] - fs * 0.3, ls[1] - fs * 0.6);
        g.fillStyle = '#4af';
        g.fillText('R', rs[0] - fs * 0.3, rs[1] - fs * 0.6);
      }
      for (let k = 0; k < POINTS.length; k++) {
        const q = at(POINTS[k]);
        if (!q) continue;
        g.fillStyle = (C[POINTS[k]] ?? 1) < 0.3 ? 'rgba(255,255,255,0.3)' : css(p);
        g.beginPath();
        g.arc(q[0], q[1], 3.5 * dpr, 0, Math.PI * 2);
        g.fill();
      }
      // the raw keypoints of the tracker (not smoothed)
      if (ctx.params.raw) {
        g.fillStyle = '#ff0';
        for (const kp of [...(p.camera.keypoints ?? []), ...(p.camera.extraKeypoints ?? [])]) {
          if (!kp || !(kp[2] > 0)) continue;
          g.fillRect(lx + kp[0] * sx - 2 * dpr, ly + kp[1] * sy - 2 * dpr, 4 * dpr, 4 * dpr);
        }
      }
      const head = at('head') ?? at('nose');
      if (head) {
        g.fillStyle = css(p);
        g.fillText(`#${p.id}`, head[0] + 8 * dpr, head[1] - 10 * dpr);
      }
    }

    // ---- right: the floor from above, read by the game's code
    const cp = ctx.params;
    const P = { ...gameParams, armMin: cp.armMin, mirrorArm: cp.mirrorArm, armSource: cp.armSource, exactSlow: cp.exactSlow, exactBelow: cp.exactBelow, liveAbove: cp.liveAbove, look: 'Silhouette', turn: true };
    const led = ctx.wall.setup.led;
    const L = makeLayout({ wall: ctx.wall, width: led.w, height: led.h }, P);
    const B = S.body;
    if (B.w !== L.AW || B.h !== L.AH) B.resize(L.AW, L.AH);
    B.update(ctx, L, P, time);
    const rx = lw + 16 * dpr;
    const rw = cw - rx - 8 * dpr;
    const k = Math.min(rw / L.AW, (ch - 3 * fs) / L.AH);
    const ry = 0;
    // the zone and the wall side
    g.strokeStyle = '#333';
    g.strokeRect(rx + 0.5, ry + 0.5, L.AW * k, L.AH * k);
    g.fillStyle = '#29f';
    g.fillRect(rx, L.up ? ry : ry + L.AH * k - 3 * dpr, L.AW * k, 3 * dpr);
    g.fillStyle = '#29f';
    g.fillText('Wand', rx + 4 * dpr, L.up ? ry + fs + 4 * dpr : ry + L.AH * k - 6 * dpr);
    // a 1 m grid
    g.strokeStyle = '#151515';
    g.lineWidth = 1;
    for (let x = 0; x <= ctx.wall.setup.size.w; x += 1) {
      g.beginPath();
      g.moveTo(rx + x * L.sx * k, ry);
      g.lineTo(rx + x * L.sx * k, ry + L.AH * k);
      g.stroke();
    }
    // the mask points from above (the game's grid): brighter = higher, arms orange
    for (let y = 0; y < B.h; y++) {
      for (let x = 0; x < B.w; x++) {
        const c = y * B.w + x;
        const s = B.slot[c];
        if (!s) continue;
        const hgt = B.height[c] / 200;
        if (B.kind[c] === 2) g.fillStyle = `rgba(255,150,40,${0.5 + 0.5 * Math.min(1, hgt)})`;
        else {
          const col = personColor(s);
          g.fillStyle = `rgba(${col.map((v) => Math.round(v * 255 * (0.35 + 0.65 * Math.min(1, hgt)))).join(',')},1)`;
        }
        g.fillRect(rx + x * k, ry + y * k, Math.ceil(k), Math.ceil(k));
      }
    }
    for (const bp of B.persons) {
      const [cx, cy] = bp.center;
      const X = rx + cx * k;
      const Y = ry + cy * k;
      // the torso
      g.strokeStyle = '#fff';
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.arc(X, Y, 5 * dpr, 0, Math.PI * 2);
      g.stroke();
      // the turn: an arrow where the body faces
      const f = [Math.cos(bp.face), Math.sin(bp.face)];
      const len = 0.45 * L.sx * k;
      g.strokeStyle = '#0f8';
      g.lineWidth = 3 * dpr;
      g.beginPath();
      g.moveTo(X, Y);
      g.lineTo(X + f[0] * len, Y + f[1] * len);
      g.stroke();
      g.beginPath();
      g.arc(X + f[0] * len, Y + f[1] * len, 4 * dpr, 0, Math.PI * 2);
      g.fillStyle = '#0f8';
      g.fill();
      // the arms the game found (real direction and length; the figure on the wall draws them shorter)
      for (const a of bp.arms) {
        g.strokeStyle = '#fa2';
        g.lineWidth = 4 * dpr;
        g.setLineDash(a.virtual ? [6 * dpr, 5 * dpr] : []);
        g.beginPath();
        g.moveTo(X, Y);
        g.lineTo(rx + a.tip[0] * k, ry + a.tip[1] * k);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = '#fa2';
        g.fillText(`${a.virtual ? 'ergänzt ' : ''}${a.len.toFixed(2)} m`, rx + a.tip[0] * k + 6 * dpr, ry + a.tip[1] * k);
      }
      if (bp.stomp) S.jumps.set(bp.id, time);
      const jt = time - (S.jumps.get(bp.id) ?? -9);
      if (jt < 0.6) {
        g.strokeStyle = `rgba(255,255,255,${1 - jt / 0.6})`;
        g.lineWidth = 3 * dpr;
        g.beginPath();
        g.arc(X, Y, (10 + jt * 60) * dpr, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = '#fff';
      g.fillText(`#${bp.id} ${Math.round(((bp.face - L.wallFace) * 180) / Math.PI + 360 + 180) % 360 - 180}°`, X + 10 * dpr, Y + 18 * dpr);
    }

    // ---- numbers: tracker results per second, poses, delay
    if (R && R.seq !== S.lastSeq) {
      S.lastSeq = R.seq;
      S.seqs.push(performance.now());
    }
    while (S.seqs.length && performance.now() - S.seqs[0] > 2000) S.seqs.shift();
    const st = globalThis.__kinectRuntime?.status?.() ?? {};
    const ps = st.persons ?? {};
    if (ps.poseRuns !== undefined) {
      S.poses = S.poses ?? [];
      S.poses.push([performance.now(), ps.poseRuns]);
      while (S.poses.length && performance.now() - S.poses[0][0] > 2000) S.poses.shift();
    }
    const poseRate = S.poses?.length > 1 ? ((S.poses.at(-1)[1] - S.poses[0][1]) * 1000) / Math.max(1, S.poses.at(-1)[0] - S.poses[0][0]) : 0;
    const line = [
      `Masken ${(S.seqs.length / 2).toFixed(0)}/s`,
      `Posen ${poseRate.toFixed(1)}/s (${ps.poseMs ? Math.round(ps.poseMs) : '–'} ms)`,
      `Verzögerung ${Math.round(ctx.persons.delayMs ?? 0)} ms`,
      `Personen ${ctx.persons.length}`,
      `Modus ${ctx.persons.mode ?? '–'}${ctx.persons.exact && ctx.persons.mode === 'both' ? ` (exakt ${Math.round(((ctx.persons.seq ?? 0) - ctx.persons.exact.seq) * 33)} ms zurück, Anteil ${Math.round((B.exactShare ?? 0) * 100)} %)` : ''}`,
      `Arme aus ${P.armSource}`,
      `Seite ${st.fps ? Math.round(st.fps) : '–'} fps`,
    ].join('   ');
    g.fillStyle = '#aaa';
    g.fillText(line, 8 * dpr, ch - fs * 0.8);
    g.fillStyle = '#666';
    g.fillText('links: Tracking (Maske, Strichfigur live, gestrichelt exakt, Schultern L/R)   rechts: was das Spiel daraus liest (Arme orange, ergänzt gestrichelt, Drehung grün, Sprung = Ring)', 8 * dpr, ch - fs * 2.1);
    ctx.status = `${ctx.persons.length} Personen`;
  },

  dispose(ctx) {
    STATES.delete(ctx);
  },
};
