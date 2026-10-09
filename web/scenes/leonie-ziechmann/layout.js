// Where everything sits on the LED image. Designed for the 1008 × 336 wall and scaled with its height
// (s = H / 336), centered if the image is wider. All rects in LED pixels, integer.
//
//   canopy   autumn crowns hanging from the top edge (forest.js)
//   hero     the contact card, top left
//   signs    the QR codes on wooden signs stuck in the ground, a little crooked, standing in the
//            leaf heap at the bottom right, in the wood: between the far and the mid trees
//            (SIGN_DEPTH m from the sensor), on the ground of that depth
//   post     the wooden signpost "Mehr von mir hier" pointing at them
//   heap     the leaf heap around the signs' feet (heap.js)
//   ground   the forest floor

export const DESIGN = { w: 1008, h: 336 };

// Betula, light theme (betula.app, :root)
export const C = {
  bg: '#f1f2f4',
  panel: '#ffffff',
  text: '#10151f',
  text2: '#4b5565',
  text3: '#8790a0',
  line: 'rgba(15, 23, 42, 0.08)',
  lineStrong: 'rgba(15, 23, 42, 0.15)',
  accent: '#4e7755', // oklch(.53 .07 149)
  accentInk: '#3b6342',
  bark: '#ffffff',
  barkInk: '#10151f',
  groundTop: '#e6ddcb',
  groundBot: '#d3c4ae',
  groundRoot: '#c9b99f',
};

// autumn leaves: the crown color of Betula's autumn (#d6ab61) and brighter golds for the LEDs, a few
// oranges and corals; no browns. Per color: [edge, body, light]
export const LEAF_COLORS = [
  ['#c9962f', '#f0bb3b', '#f7d27a'],
  ['#c0913f', '#d6ab61', '#e9cb8f'],
  ['#d6a21c', '#f5cc3c', '#fbe38a'],
  ['#d08a1a', '#f29f2a', '#f8c46f'],
  ['#cf6a1f', '#ef7926', '#f6a868'],
  ['#c4523a', '#e76444', '#f09a82'],
  ['#c8a73a', '#f2d76c', '#f8e9a8'],
];
// how often each color is picked (golds dominate)
export const LEAF_WEIGHTS = [5, 4, 4, 3, 2, 1, 3];

/**
 * p: the params (qrModule), qrSize: modules per side of the codes (all the same), n: number of
 * codes (1 or 2).
 */
// how far the signs stand from the sensor (m), and the ground there (design px from the top)
export const SIGN_DEPTH = 2.85;
const SIGN_GROUND = 284;

export function computeLayout(W, H, p, qrSize, n) {
  const s = H / DESIGN.h;
  const ox = Math.round((W - DESIGN.w * s) / 2);
  const X = (x) => Math.round(ox + x * s);
  const Y = (y) => Math.round(y * s);

  // the signs: wooden boards stuck in the ground, a little crooked, at different heights. The code
  // sits on a smooth light field of the board; its module size is in LEDs (not scaled: it must
  // stay sharp), so every code has exactly the same size.
  const mod = Math.max(2, Math.round(p.qrModule));
  const code = qrSize * mod;
  const quiet = 3 * mod;
  const frame = Y(5);
  const labelH = Y(31);
  const boardW = code + 2 * quiet + 2 * frame;
  const boardH = frame + labelH + code + 2 * quiet + frame;
  const places =
    n > 1
      ? [
          { cx: 714, bottom: 266, deg: -3 },
          { cx: 914, bottom: 256, deg: 2.5 },
        ]
      : [{ cx: 860, bottom: 264, deg: -2 }];
  const signs = places.slice(0, n).map((pl) => {
    const angle = (pl.deg * Math.PI) / 180;
    const cx = X(pl.cx);
    const cy = Y(pl.bottom) - boardH / 2;
    // the code's middle on the wall (the heap reaches up to it)
    const lx = 0;
    const ly = -boardH / 2 + frame + labelH + quiet + code / 2;
    const codeMid = [cx + lx * Math.cos(angle) - ly * Math.sin(angle), cy + lx * Math.sin(angle) + ly * Math.cos(angle)];
    // the top edge (for leaves lying on it): its middle and slope
    const top = [cx + (boardH / 2) * Math.sin(angle), cy - (boardH / 2) * Math.cos(angle)];
    const ext = { w: boardW * Math.abs(Math.cos(angle)) + boardH * Math.abs(Math.sin(angle)), h: boardW * Math.abs(Math.sin(angle)) + boardH * Math.abs(Math.cos(angle)) };
    // what nothing may cover: the label and the code with most of its quiet zone (the board's
    // edges may disappear behind trees)
    const fx = code / 2 + quiet * 0.7;
    const corners = [
      [-fx, -boardH / 2 + frame],
      [fx, -boardH / 2 + frame],
      [-fx, -boardH / 2 + frame + labelH + quiet * 1.3 + code],
      [fx, -boardH / 2 + frame + labelH + quiet * 1.3 + code],
    ].map(([a, b]) => [cx + a * Math.cos(angle) - b * Math.sin(angle), cy + a * Math.sin(angle) + b * Math.cos(angle)]);
    const face = {
      x0: Math.min(...corners.map((c) => c[0])),
      x1: Math.max(...corners.map((c) => c[0])),
      y0: Math.min(...corners.map((c) => c[1])),
      y1: Math.max(...corners.map((c) => c[1])),
    };
    return {
      cx,
      cy,
      angle,
      bw: boardW,
      bh: boardH,
      frame,
      labelH,
      quiet,
      code: { size: code, mod },
      codeMid,
      top,
      sign: true,
      face,
      // axis-aligned box around the turned board
      x: Math.round(cx - ext.w / 2),
      y: Math.round(cy - ext.h / 2),
      w: Math.round(ext.w),
      h: Math.round(ext.h),
    };
  });
  const ground = Y(306); // upper end of the forest floor
  // the signpost left of them, its arrow pointing at the first sign
  const postW = Y(134);
  const post = { x: signs[0].x - Y(26) - postW, y: Y(176), w: postW, h: Y(24), angle: (-4 * Math.PI) / 180, sign: true };
  post.face = { x0: post.x, x1: post.x + post.w, y0: post.y - Y(6), y1: post.y + post.h + Y(6) };
  // birches of the mid row standing among the signs: one between two signs, one in front of the
  // first sign's left edge (forest.js adds them; their trunks only cover the boards' edges)
  const signTrees = [];
  if (signs.length > 1) signTrees.push({ x: (signs[0].face.x1 + signs[1].face.x0) / 2, w: Math.min(Y(15), signs[1].face.x0 - signs[0].face.x1 - 4) });
  if (signs.length) signTrees.push({ x: signs[0].face.x0 - Y(8), w: Y(13) });
  // the heap: from the signpost's foot to the right edge, up to the codes' middle, on the ground
  // at the signs' depth
  const heap = { x0: post.x + Math.round(postW * 0.4), x1: W, base: Y(SIGN_GROUND) };

  return {
    s,
    W,
    H,
    canopy: Y(56), // lower end of the crowns
    ground,
    hero: { x: X(24), y: Y(70) }, // its size follows its text (cards.js)
    signs,
    post,
    signTrees,
    heap,
    font: 'Inter, "Inter Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  };
}
