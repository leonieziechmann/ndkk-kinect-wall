// The stages of the video: from the short overview to the physics. Every stage is a scene and a
// chapter of the mp4 (tools/render.mjs), and each one ends with a card saying you may stop here.

export const STAGES = [
  { short: 'Überblick', title: 'Der Überblick' },
  { short: 'Warum', title: 'Warum das funktioniert' },
  { short: 'Schritt für Schritt', title: 'Schritt für Schritt' },
  { short: 'Feinheiten', title: 'Feinheiten und Fehler' },
  { short: 'Physik', title: 'Für Neugierige: die Physik' },
];

/** scene name (file name in src/scenes) → chapter title in the mp4 */
export const CHAPTERS = [
  { scene: 's0-titel', title: 'Start' },
  { scene: 's1-ueberblick', title: '1 · Der Überblick' },
  { scene: 's2-warum', title: '2 · Warum das funktioniert' },
  { scene: 's3-schritte', title: '3 · Schritt für Schritt' },
  { scene: 's4-feinheiten', title: '4 · Feinheiten und Fehler' },
  { scene: 's5-physik', title: '5 · Für Neugierige: die Physik' },
];
