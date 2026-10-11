// Colours and type of the 2D layer (captions, labels, cards). The 3D world has its own materials
// (src/three). Blue means "über", orange "unter"; both carry white text at ≥ 5:1 contrast and stay
// apart for colour-blind eyes. Red and green are only used together with ✗ / ✓.

export const OVER = '#2a6cc4';
export const UNDER = '#b85000';

export const C = {
  bg: '#f2eee6',
  paper: '#fbf9f4',
  plate: '#ffffffe6',
  text: '#1d232d',
  /** secondary text, still ≥ 4.5:1 on bg */
  muted: '#5b616d',
  faint: '#b9b2a5',
  over: OVER,
  under: UNDER,
  stripe: '#f2c230',
  good: '#2e8a52',
  bad: '#c63b3b',
  /** "too small" and other soft warnings (never alone: always with a word or a symbol) */
  amber: '#9a6a00',
};

export const FONT = 'Inter';
