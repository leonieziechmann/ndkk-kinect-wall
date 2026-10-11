// The cast of the video (KONZEPT.md, "Besetzung"): a team that simply works together. Heights,
// builds, clothes and colours; skin tones from light to dark, natural hair colours (and one dyed).

import { BUILDS, PersonSpec, build } from './people';

/** Noor coils in stages 1 and 3 (her own hands in the first-person view) */
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
  beltGloves: true,
  colors: {
    skin: '#a8714c',
    hair: '#2a1d17',
    hijab: '#9cb08c',
    top: '#4b4f56',
    pants: '#6c6e3e',
    shoes: '#d7d3cb',
    glove: '#2b2d31',
    glove2: '#e0782b',
  },
};

/** Kofi throws the long cable */
export const KOFI: PersonSpec = {
  name: 'Kofi',
  height: 1.8,
  build: build(BUILDS.base, { belly: 0.35, waist: 1.06, limbs: 1.05, neck: 1.05 }),
  hair: 'buzz',
  beard: true,
  top: 'tee',
  pants: 'work',
  shoes: 'workshoes',
  colors: {
    skin: '#5c3a28',
    hair: '#bdb9b2',
    top: '#e48aae',
    pants: '#2c2d31',
    shoes: '#3d3029',
  },
};

/** Robin pulls the charging cable apart */
export const ROBIN: PersonSpec = {
  name: 'Robin',
  height: 1.72,
  build: build(BUILDS.slim, { shoulders: 0.95, hips: 1.0, bust: 0, hands: 0.95 }),
  hair: 'undercut',
  top: 'hoodie',
  loose: 1,
  pants: 'wide',
  shoes: 'sneakers',
  colors: {
    skin: '#f0cdb8',
    hair: '#2fb3a6',
    hair2: '#7a6556',
    top: '#e2a72e',
    pants: '#3b4357',
    shoes: '#f0eee8',
    accent: '#f4efe4',
  },
};

/** Mai lays the heavy power cable in figure eights and lifts */
export const MAI: PersonSpec = {
  name: 'Mai',
  height: 1.58,
  build: build(BUILDS.fem, { shoulders: 1.0, chest: 1.02, waist: 1.0, limbs: 1.02, neck: 0.95, hands: 0.95, bust: 0.25 }),
  hair: 'ponytail',
  headwear: 'cap',
  top: 'hoodie',
  pants: 'work',
  kneePads: true,
  shoes: 'boots',
  gloves: 'work',
  colors: {
    skin: '#e5bf9a',
    hair: '#1e1a19',
    top: '#1f6d77',
    cap: '#2b2f36',
    pants: '#3f4348',
    shoes: '#5a4330',
    glove: '#8b9298',
    glove2: '#2b2d30',
    accent: '#e9e4da',
  },
};

/** Jonas carries with Mai */
export const JONAS: PersonSpec = {
  name: 'Jonas',
  height: 1.9,
  build: build(BUILDS.slim, { shoulders: 0.98, limbs: 0.9 }),
  hair: 'ponytail',
  top: 'fleece',
  pants: 'straight',
  shoes: 'sneakers',
  painted: true,
  colors: {
    skin: '#ecc6aa',
    hair: '#d6b274',
    top: '#9a85c4',
    pants: '#4d6789',
    shoes: '#3a3e46',
    nails: '#4d2a6b',
    accent: '#5e4f86',
  },
};

/** Ilse shows the physics at the table, in a wheelchair */
export const ILSE: PersonSpec = {
  name: 'Ilse',
  height: 1.62,
  build: build(BUILDS.fem, { shoulders: 0.9, belly: 0.3, waist: 1.0, bust: 0.3 }),
  hair: 'bob',
  glasses: true,
  top: 'cardigan',
  pants: 'straight',
  shoes: 'sneakers',
  colors: {
    skin: '#e9c4ae',
    hair: '#efebe5',
    top: '#5e8794',
    top2: '#efe6d6',
    pants: '#4a4b54',
    shoes: '#8c7d6b',
    sole: '#e9e3d8',
    frame: '#5b3424',
    accent: '#e8dfcf',
  },
};

/** Ada pulls a ring apart next to Teo (stage 2) */
export const ADA: PersonSpec = {
  name: 'Ada',
  height: 1.7,
  build: build(BUILDS.fem, { shoulders: 0.96, hips: 1.08 }),
  hair: 'curly',
  top: 'longsleeve',
  pushed: true,
  pants: 'straight',
  shoes: 'workshoes',
  colors: {
    skin: '#6f4631',
    hair: '#1b1512',
    top: '#c2653e',
    pants: '#2f3b55',
    shoes: '#5a4434',
  },
};

/** Teo pulls the other ring apart (stage 2) */
export const TEO: PersonSpec = {
  name: 'Teo',
  height: 1.74,
  build: build(BUILDS.slim),
  hair: 'curly',
  glasses: true,
  top: 'tee',
  pants: 'straight',
  shoes: 'sneakers',
  colors: {
    skin: '#b7835f',
    hair: '#2b1f19',
    top: '#3f7955',
    pants: '#bba987',
    shoes: '#ecebe6',
    sole: '#c9c6bf',
  },
};

export const CAST: PersonSpec[] = [NOOR, KOFI, ROBIN, MAI, JONAS, ILSE, ADA, TEO];
