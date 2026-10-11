// The photo studio every shot stands in: a seamless cyclorama (a round floor that curves up into a
// wall and a ceiling, so there is no horizon from any camera angle), fog of the floor's own colour
// that dissolves the far wall, and product-shot lights: a soft sky (hemisphere), a warm key light
// with soft shadows, a cool fill and a rim light from behind that separates dark cables and dark
// skin from the floor. The 'stage' variant is a dark stage floor for context shots.
//
// The cyclorama is matte (Lambert): it covers most pixels, and the cheaper shader saves frame time.
// Only the key light casts shadows; focus() fits its shadow map to the action (keep the radius
// tight: the map is 1024² and rendered every frame).

import * as THREE from 'three';
import type { V3 } from '../sim/vec';

export type StudioVariant = 'light' | 'stage';

export interface StudioOptions {
  variant?: StudioVariant;
  /** radius of the flat floor before it curves up (m) */
  floorRadius?: number;
  /** radius of the curve between floor and wall (m) */
  coveRadius?: number;
  /** wall height before it curves into the ceiling (m) */
  height?: number;
  /** centre and radius of the area with sharp shadows (see focus()) */
  focus?: V3;
  focusRadius?: number;
  shadowMapSize?: number;
  /** blur of the shadow edges in shadow-map texels (default 3) */
  shadowSoftness?: number;
}

interface Look {
  floor: string;
  /** colour of the far distance; the floor fades into it */
  haze: string;
  fogNear: number;
  fogFar: number;
  sky: string;
  ground: string;
  hemi: number;
  key: string;
  keyI: number;
  fill: string;
  fillI: number;
  rim: string;
  rimI: number;
}

const LOOKS: Record<StudioVariant, Look> = {
  light: {
    floor: '#ece3d6',
    haze: '#efe8de',
    fogNear: 5,
    fogFar: 16,
    sky: '#fffaf4',
    ground: '#dccfbf',
    hemi: 1.15,
    key: '#fff3e6',
    keyI: 2.5,
    fill: '#e2e9ff',
    fillI: 0.55,
    rim: '#ffffff',
    rimI: 0.9,
  },
  stage: {
    floor: '#3a3b3e',
    haze: '#141416',
    fogNear: 4,
    fogFar: 12,
    sky: '#d6d9e0',
    ground: '#202024',
    hemi: 0.8,
    key: '#fff0dc',
    keyI: 3.2,
    fill: '#c4d0ff',
    fillI: 0.35,
    rim: '#ffffff',
    rimI: 1.4,
  },
};

/** direction from the action to the key light: high, front right */
const KEY_DIR = new THREE.Vector3(0.55, 1.35, 0.75).normalize();

export class Studio {
  public readonly group = new THREE.Group();
  public readonly cyclorama: THREE.Mesh;
  public readonly hemi: THREE.HemisphereLight;
  public readonly key: THREE.DirectionalLight;
  public readonly fill: THREE.DirectionalLight;
  public readonly rim: THREE.DirectionalLight;
  public readonly variant: StudioVariant;

  /** adds the studio to the scene (background, fog, cyclorama, lights) */
  public constructor(scene: THREE.Scene, o: StudioOptions = {}) {
    const variant = (this.variant = o.variant ?? 'light');
    const look = LOOKS[variant];
    const R = o.floorRadius ?? 7;
    const rc = o.coveRadius ?? 2.5;
    const H = o.height ?? 7;

    // profile: floor → cove → wall → ceiling, turned around the y axis (normals face inwards)
    const prof: THREE.Vector2[] = [];
    for (let i = 0; i <= 8; i++) prof.push(new THREE.Vector2((R * i) / 8, 0));
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * (Math.PI / 2);
      prof.push(new THREE.Vector2(R + Math.sin(a) * rc, rc - Math.cos(a) * rc));
    }
    prof.push(new THREE.Vector2(R + rc, H));
    for (let i = 1; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      prof.push(new THREE.Vector2(R + rc - (1 - Math.cos(a)) * rc, H + Math.sin(a) * rc));
    }
    prof.push(new THREE.Vector2(0, H + rc));
    // LatheGeometry faces outwards for a profile running away from the axis: flip to face inwards
    const geo = new THREE.LatheGeometry(prof, 96);
    const idx = geo.index;
    if (idx) for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    geo.computeVertexNormals();
    this.cyclorama = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: look.floor }));
    this.cyclorama.receiveShadow = true;

    this.hemi = new THREE.HemisphereLight(look.sky, look.ground, look.hemi);
    this.key = new THREE.DirectionalLight(look.key, look.keyI);
    this.key.castShadow = true;
    // the shadow map is rendered every frame (cables move): 1024² is half the cost of 2048² at the
    // same sharpness when focus() keeps the shadowed area tight
    const ms = o.shadowMapSize ?? 1024;
    this.key.shadow.mapSize.set(ms, ms);
    this.key.shadow.radius = o.shadowSoftness ?? 3;
    // small biases: a cable lying on the floor must still shadow it
    this.key.shadow.bias = -0.0002;
    this.key.shadow.normalBias = 0.0012;
    this.fill = new THREE.DirectionalLight(look.fill, look.fillI);
    this.rim = new THREE.DirectionalLight(look.rim, look.rimI);

    scene.background = new THREE.Color(look.haze);
    scene.fog = new THREE.Fog(look.haze, look.fogNear, look.fogFar);
    this.group.add(this.cyclorama, this.hemi, this.key, this.key.target, this.fill, this.fill.target, this.rim, this.rim.target);
    scene.add(this.group);
    this.focus(o.focus ?? [0, 0.6, 0], o.focusRadius ?? 2);
  }

  /**
   * Aims the lights at `center` and fits the key light's shadow map to a sphere of `radius` around
   * it: a small radius gives crisp contact shadows in close-ups, a large one covers a wide shot.
   */
  public focus(center: V3, radius: number) {
    const c = new THREE.Vector3(center[0], center[1], center[2]);
    const d = radius * 2 + 4;
    this.key.position.copy(c).addScaledVector(KEY_DIR, d);
    this.key.target.position.copy(c);
    const sc = this.key.shadow.camera;
    sc.left = -radius;
    sc.right = radius;
    sc.top = radius;
    sc.bottom = -radius;
    sc.near = Math.max(0.1, d - radius * 1.5);
    sc.far = d + radius * 2;
    sc.updateProjectionMatrix();
    this.fill.position.set(c.x - 4, c.y + 2.2, c.z + 1.2);
    this.fill.target.position.copy(c);
    this.rim.position.set(c.x - 1.2, c.y + 2.6, c.z - 4);
    this.rim.target.position.copy(c);
  }
}
