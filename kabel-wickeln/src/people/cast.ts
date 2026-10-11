// The cast of the video (KONZEPT.md, "Besetzung"): a crew packing up after a show, a team that simply
// works together. Heights, builds, clothes and colours; skin tones from light to very dark, natural
// hair colours (and one dyed accent). Clothes only in colours that do not compete with the colour
// code of the video (grey, black, olive, muted brown, mauve, dusty rose, dark denim): no saturated
// blue, orange, yellow, red or green near the cables. One or two cues per person, from the work.

import { BUILDS, PersonSpec, build } from './people';

/** Noor coils (stages 1, 3), shows the mistakes and their fixes (5); her hands are the first-person view */
export const NOOR: PersonSpec = {
  name: 'Noor',
  height: 1.65,
  build: build(BUILDS.fem),
  hair: 'none',
  headwear: 'hijab',
  top: 'longsleeve',
  pants: 'work',
  kneePads: true,
  shoes: 'sneakers',
  gloves: 'rigger',
  colors: {
    skin: '#8f6a55',
    hair: '#2a1d17',
    hijab: '#8c6c7e',
    top: '#46494f',
    pants: '#5c5e3d',
    shoes: '#c9c4bc',
    // rigger gloves: black back, light tan leather palm
    glove: '#303236',
    glove2: '#c4a582',
  },
};

/** Kofi throws the long cable (1) */
export const KOFI: PersonSpec = {
  name: 'Kofi',
  height: 1.8,
  build: build(BUILDS.base, { shoulders: 1.06, chest: 1.08, waist: 1.14, hips: 1.04, belly: 0.5, limbs: 1.1, neck: 1.1, hands: 1.04 }),
  hair: 'buzz',
  beard: true,
  top: 'tee',
  pants: 'work',
  shoes: 'workshoes',
  colors: {
    skin: '#452e21',
    hair: '#b4b0aa',
    top: '#bf8f95',
    pants: '#242528',
    shoes: '#2b2724',
  },
};

/** Ilse pulls a short cable apart at the FOH desk (1) and shows the physics (7); in her active wheelchair */
export const ILSE: PersonSpec = {
  name: 'Ilse',
  height: 1.62,
  build: build(BUILDS.fem, { shoulders: 0.94, belly: 0.15, waist: 0.96, bust: 0.3 }),
  hair: 'pixie',
  glasses: true,
  top: 'overshirt',
  lanyard: true,
  pants: 'straight',
  shoes: 'sneakers',
  colors: {
    skin: '#e9c4ae',
    hair: '#cfd0d2',
    top: '#3f4652',
    top2: '#4b525e',
    pants: '#2f3034',
    shoes: '#38393d',
    frame: '#26272b',
    accent: '#ecebe6',
  },
};

/** Teo pulls the ring that was always coiled the same way apart (2) */
export const TEO: PersonSpec = {
  name: 'Teo',
  height: 1.74,
  build: build(BUILDS.slim),
  hair: 'curly',
  glasses: true,
  top: 'hoodie',
  pants: 'work',
  shoes: 'sneakers',
  colors: {
    skin: '#80583f',
    hair: '#1f1814',
    top: '#8e9094',
    pants: '#5f5242',
    shoes: '#3a3b3f',
    accent: '#d9d7d2',
  },
};

/** Robin pulls the over-under ring apart (2), rolls a mic stand in the load-out */
export const ROBIN: PersonSpec = {
  name: 'Robin',
  height: 1.72,
  build: build(BUILDS.slim, { shoulders: 0.95, hips: 1.0, bust: 0, hands: 0.95 }),
  hair: 'undercut',
  top: 'jacket',
  pants: 'work',
  shoes: 'sneakers',
  colors: {
    skin: '#f0d0bb',
    hair: '#4a3d35',
    hair2: '#5e5048',
    dye: '#b9a6d3',
    top: '#6a5843',
    top2: '#222326',
    pants: '#36373b',
    shoes: '#2a2b2e',
  },
};

/** Jonas: the velcro tie in close-up (4), closes a case in the load-out */
export const JONAS: PersonSpec = {
  name: 'Jonas',
  height: 1.92,
  build: build(BUILDS.slim, { shoulders: 0.98, limbs: 0.9 }),
  hair: 'ponytail',
  top: 'fleece',
  pants: 'straight',
  shoes: 'sneakers',
  painted: true,
  colors: {
    skin: '#ecc6aa',
    hair: '#d2b37b',
    top: '#5f6448',
    pants: '#333438',
    shoes: '#3a3c40',
    nails: '#4b2a42',
    accent: '#3f4231',
  },
};

/** Mai coils the power cable and lays the heavy one in figure eights (6), gives the command when carrying */
export const MAI: PersonSpec = {
  name: 'Mai',
  height: 1.66,
  build: build(BUILDS.fem, { shoulders: 1.0, chest: 1.02, waist: 1.0, limbs: 1.0, neck: 0.95, hands: 0.97, bust: 0.25 }),
  hair: 'ponytail',
  headwear: 'cap',
  top: 'hoodie',
  pants: 'work',
  kneePads: true,
  shoes: 'boots',
  gloves: 'work',
  colors: {
    skin: '#dfb792',
    hair: '#1c1817',
    top: '#4b4e53',
    cap: '#232427',
    pants: '#2a2b2e',
    shoes: '#3b3029',
    glove: '#8b9096',
    glove2: '#2b2d30',
    pad: '#505257',
    accent: '#c9c7c2',
  },
};

/** Ada carries the heavy cable with Mai (6), stacks cables in the load-out */
export const ADA: PersonSpec = {
  name: 'Ada',
  height: 1.7,
  build: build(BUILDS.fem, { shoulders: 1.0, chest: 1.06, waist: 1.08, hips: 1.12, belly: 0.3, limbs: 1.02, bust: 0.4 }),
  hair: 'coils',
  top: 'tee',
  pants: 'work',
  shoes: 'workshoes',
  beltGloves: true,
  colors: {
    skin: '#5e3b28',
    hair: '#16110f',
    top: '#26272a',
    pants: '#55493a',
    shoes: '#2e2a26',
    glove: '#2b2c30',
    glove2: '#8d8f93',
  },
};

export const CAST: PersonSpec[] = [NOOR, KOFI, ILSE, TEO, ROBIN, JONAS, MAI, ADA];
