export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};
/** 0..1 inside [a, b], eased */
export const span = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
export const easeInOut = (t: number) => {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t), 3);
export const TAU = Math.PI * 2;
export function hash(...n: number[]) {
  let h = 2166136261;
  for (const v of n) {
    h ^= Math.floor(v * 9301 + 49297);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
export function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function mix(a: string, b: string, t: number) {
  const x = hexRgb(a);
  const y = hexRgb(b);
  const c = x.map((v, i) => Math.round(lerp(v, y[i], clamp(t))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
export function rgba(hex: string, a: number) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${clamp(a)})`;
}
