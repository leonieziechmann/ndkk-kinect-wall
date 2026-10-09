// The grid test image of the control center (web/lib/wall-output.js, drawGrid) at LED resolution:
// panel lines with their numbers (column.row), the circle that is round when the pixels are mapped
// right, the center cross, colored corners, meters along the bottom, a white frame and the size.

import { FONT } from './theme';
import { WALL } from './world';

const SCALE = 2; // drawn at twice the LED resolution, so it stays sharp in close-ups
let canvas: HTMLCanvasElement | null = null;

export function testPattern() {
  if (canvas) return canvas;
  const W = WALL.ledW;
  const H = WALL.ledH;
  const cw = W / WALL.cols;
  const ch = H / WALL.rows;
  canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.scale(SCALE, SCALE);
  const px = (n: number) => Math.max(1, Math.round(n));
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#3a3a44';
  for (let x = cw; x < W; x += cw) g.fillRect(x, 0, 1, H);
  for (let y = ch; y < H; y += ch) g.fillRect(0, y, W, 1);
  // panel numbers (column.row)
  g.fillStyle = '#6a6a78';
  g.font = `500 ${px(Math.min(cw, ch) / 6)}px ${FONT}`;
  g.textBaseline = 'top';
  for (let r = 0; r * ch < H; r++) for (let c = 0; c * cw < W; c++) g.fillText(`${c + 1}.${r + 1}`, c * cw + 3, r * ch + 3);
  // a circle: round on the wall if the pixels are mapped right
  g.strokeStyle = '#2bd4ff';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(W / 2, H / 2, H * 0.42, 0, Math.PI * 2);
  g.stroke();
  // center cross
  g.fillStyle = '#2bd4ff';
  g.fillRect(Math.floor(W / 2), 0, 1, H);
  g.fillRect(0, Math.floor(H / 2), W, 1);
  // corners: red top left, green top right, blue bottom left, yellow bottom right
  const k = px(Math.min(W, H) * 0.12);
  const tri = (x: number, y: number, dx: number, dy: number, col: string) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + dx * k, y);
    g.lineTo(x, y + dy * k);
    g.fill();
  };
  tri(0, 0, 1, 1, '#ff2030');
  tri(W, 0, -1, 1, '#20ff40');
  tri(0, H, 1, -1, '#3050ff');
  tri(W, H, -1, -1, '#ffe020');
  // meters along the bottom
  const ppm = W / WALL.w;
  g.fillStyle = '#ddd';
  g.font = `500 ${px(H / 22)}px ${FONT}`;
  g.textBaseline = 'bottom';
  for (let m = 0; m <= WALL.w + 1e-6; m += 0.5) {
    const x = Math.min(W - 1, Math.round(m * ppm));
    const big = Math.abs(m - Math.round(m)) < 1e-6;
    g.fillRect(x, H - px(big ? H / 14 : H / 28), 1, px(big ? H / 14 : H / 28));
    if (big && m > 0 && m < WALL.w - 0.01) g.fillText(`${m} m`, x + 3, H - 3);
  }
  // the outermost LEDs: a 1-pixel white frame
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, 1);
  g.fillRect(0, H - 1, W, 1);
  g.fillRect(0, 0, 1, H);
  g.fillRect(W - 1, 0, 1, H);
  g.font = `600 ${px(H / 9)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.fillText(`${W} × ${H}`, W / 2, H / 2 - H * 0.1);
  g.font = `500 ${px(H / 16)}px ${FONT}`;
  g.fillStyle = '#bbb';
  g.fillText(`${WALL.w} × ${WALL.h} m · ${((1000 * WALL.w) / W).toFixed(2)} mm`, W / 2, H / 2 + H * 0.08);
  return canvas;
}
