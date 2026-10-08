// The outfits of the pixel people: every person gets one by their tracking id (a new id after leaving
// the view = a new outfit). Colors stay saturated, they sit on a dark grid on the LED wall.
// Ids start at 1, so the first person of a session wears PALETTES[1].
// sleeves: 'long' = forearms in the shirt color, 'short' = bare forearms.

export const PARTS = ['hair', 'skin', 'shirt', 'pants', 'shoes'];

export const PALETTES = [
  { hair: '#1f78a0', skin: '#bff0f5', shirt: '#5fd0e6', pants: '#2b6fae', shoes: '#7a5cff', sleeves: 'long' },
  { hair: '#ff7a1a', skin: '#ffc49a', shirt: '#ffaa2b', pants: '#c8452d', shoes: '#7a2448', sleeves: 'long' },
  { hair: '#e0562b', skin: '#ffd0b0', shirt: '#ff6a4d', pants: '#5a6cff', shoes: '#7a52a8', sleeves: 'short' },
  { hair: '#ffcf5a', skin: '#ffe2c8', shirt: '#eafff2', pants: '#3fae8c', shoes: '#22707e', sleeves: 'long' },
  { hair: '#8a5aff', skin: '#f4d4ff', shirt: '#e2d6ff', pants: '#9a6ae0', shoes: '#ff3d9a', sleeves: 'short' },
  { hair: '#ff2e7e', skin: '#ffd6e6', shirt: '#ff7ab8', pants: '#4656ff', shoes: '#f4f0ff', sleeves: 'short' },
  { hair: '#3a4dff', skin: '#c4eeff', shirt: '#2ee6ff', pants: '#2b62e8', shoes: '#ff4fa0', sleeves: 'long' },
  { hair: '#ff5a2a', skin: '#ffd8b6', shirt: '#8cff5a', pants: '#2f86ff', shoes: '#ffe14d', sleeves: 'short' },
  { hair: '#ffd23a', skin: '#ffcca8', shirt: '#ff2a4a', pants: '#4a58e0', shoes: '#f4f0ff', sleeves: 'long' },
  { hair: '#c45cff', skin: '#c88664', shirt: '#ffe14d', pants: '#2fb8ff', shoes: '#ff3d6e', sleeves: 'short' },
];

export function hexRgb(hex) {
  const v = Number.parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** WGSL constants: PAL[outfit * 5 + part], SLEEVE_SKIN[outfit], PAL_COUNT. */
export function paletteWgsl() {
  const f = (x) => x.toFixed(4);
  const colors = PALETTES.flatMap((p) => PARTS.map((k) => `vec3f(${hexRgb(p[k]).map(f).join(', ')})`));
  return /* wgsl */ `
const PAL_COUNT = ${PALETTES.length}u;
const PAL = array<vec3f, ${colors.length}>(${colors.join(', ')});
const SLEEVE_SKIN = array<f32, ${PALETTES.length}>(${PALETTES.map((p) => (p.sleeves === 'short' ? '1.0' : '0.0')).join(', ')});
`;
}

/** The outfit of a person (same rule as the shader: id modulo the number of outfits). */
export function outfit(id) {
  return PALETTES[((id % PALETTES.length) + PALETTES.length) % PALETTES.length];
}
