// Stage 7 (KONZEPT "7 · Für Neugierige: die Physik"): the rough animation (animatic). Every beat,
// caption, label, counter and camera is in place; Ilse's hands come from simple keyframes
// (shots/p7-physics-rig.ts) on the frames the simulation used; the recorded movements (MOCAP_SLOTS)
// replace them later. Ilse sits in her wheelchair at an experiment table.
//
//   0  intro: the table with the experiments
//   1  stiffness: three equal pieces over the table's edge (charging cable, XLR, power 5G2.5), the
//      same small clamp on each tip: the thin ones hang, the thick one stays almost straight;
//      "So weit trägt sich ein Kabel selbst." + "Ungefähr so groß werden seine Schlaufen." (loop
//      sizes); a clamped XLR turned at a crank: the stripe winds, past a limit a loop pops out (slow
//      motion, real time); "Ein Kabel wehrt sich gegen Biegen und Verdrehen …"; back at the edge:
//      "Doppelt so dick: viel steifer." + "Steifere Kabel brauchen größere Schlaufen."
//   2  memory: an old cable let go above the table lands in its old curls, a new one almost straight
//   3  tension hides twist: a twisted cable taut = straight, slack = a curl; one end let go: the
//      twist turns out (slow motion, real time); "Stecken beide Stecker, bleibt er drin."
//   4  the band: the striped cable becomes a flat band (yellow = stripe); four bands with four loops
//      each, both ends in clamps that cannot turn: über ×4 / unter ×4 / abwechselnd / ü ü u ü;
//      pulled apart, pushed together, a bar under each band split into Verdrillung (yellow) and
//      Schlingen (blue): the split shifts, the length stays; the numbers at the end; pulled again,
//      one clamp opened: the band turns free (slow motion, real time), its sum goes to 0
//   5  too much twist in a closed ring: it flips into an eight (slow motion, real time); flashback
//      to stage 5's eight (the eight-snap bake)
//   6  the formula Drehung + Schlingen = bleibt gleich (Lk = Tw + Wr …) over the band, DNA
//   7  1 + 1 + 1 + 1 + 1 + 1 = 6 · 1 − 1 + 1 − 1 + 1 − 1 = 0; the finished ring
//
// Cables: all simulated (shots/p7-physics.ts), except the old ring lying on the table and the
// finished ring at the end (kinematic props). Every label and tick that claims something about a
// cable is checked against its bake when the part runs (`truth` in the log).

import { Circle, Layout, Node, Rect, Txt } from '@motion-canvas/2d';
import { easeInOutCubic } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, coilPoints, loadBake, smooth } from '../../sim';
import { BAND, BAND_KINDS, BAND_ORDER, BandKind, EDGE, EDGE_SPEC, EdgeKind, KNOB, MEM, RING, TABLE, TENSION, knobRot, ringTurns } from '../../shots/p7-physics';
import { BOOK, EDGE_DX, SEATS, SLED, Seat, TRAY, bandRig, crankHandle, edgeRig, edgeTake, holdRig, introRig, knobRig } from '../../shots/p7-physics-rig';
import { ILSE } from '../../people/cast';
import { Rig, RigTrack } from '../../people/rig';
import { yawFrame } from '../../people/people';
import { CAPTION_Y, GAP, PANEL_H, TOP, clock, readTime, splitPerson } from '../../lib/kit';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { Mark, StageChip } from '../../lib/ui';
import { CableMesh } from '../../three/cable';
import { RibbonMesh } from '../../three/ribbon';
import { Orbit, makeCamera, mixOrbit, orbit } from '../../three/camera';
import { callout, project } from '../../three/overlay';
import { flightCase, table, wheelchair } from '../../three/props';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

// ===================================================================================== the plan

type Beat = 'intro' | 'edge' | 'knob' | 'old' | 'new' | 'cmp' | 'ten' | 'morph' | 'band' | 'ring' | 'formula' | 'sums' | 'final';
const SLOW = 0.25;

interface Seg {
  id: string;
  /** scene seconds */
  len: number;
  beat: Beat;
  /** shot time at its start and end (equal: time stands still) */
  from: number;
  to: number;
  /** scene time of its start */
  at: number;
  /** a continuous take (a cut starts a new one): Ilse's arms are solved per take */
  take: number;
}

const SEGS: Seg[] = [];
let sceneAt = 0, take = 0;
const cut = () => take++;
const hold = (id: string, beat: Beat, at: number, len: number) => {
  SEGS.push({ id, len, beat, from: at, to: at, at: sceneAt, take });
  sceneAt += len;
};
const play = (id: string, beat: Beat, from: number, to: number, speed = 1) => {
  const len = (to - from) / speed;
  SEGS.push({ id, len, beat, from, to, at: sceneAt, take });
  sceneAt += len;
};

/** key moments of the bakes (shot time): measured from the tracks, see the report */
const POP = { a: 7.75, b: 8.75 }; // p7-knob: the loop pops between (wr 0.12 → 1.0)
const TEN = TENSION.t;
const FLIP = { a: 4.3, b: 5.7 }; // p7-ring: the loop swings into an eight (wr 0.5 → 1.2)
const REL = { a: 15.9, b: 16.9 }; // p7-band-over: the clamp opens at 16.0, the band turns free within 0.5 s

// 0 · intro
hold('intro', 'intro', 0, 3.0);
// 1 · stiffness at the edge
cut();
hold('edgeIn', 'edge', 1.0, 1.0);
play('edge', 'edge', 1.0, EDGE.duration);
hold('edgeRes', 'edge', EDGE.duration, 9.8);
// 1b · the crank
cut();
hold('knobIn', 'knob', 0, 1.6);
play('knobTurn', 'knob', 0, POP.a);
play('knobPop', 'knob', POP.a, POP.b, SLOW);
play('knobRest', 'knob', POP.b, KNOB.duration);
cut();
play('knobReplay', 'knob', POP.a - 1.0, POP.b + 0.6);
cut();
hold('knobHold', 'knob', KNOB.duration, 1.2);
// 1c · back at the edge
cut();
hold('edge2', 'edge', EDGE.duration, 10.0);
// 2 · memory
cut();
hold('memIn', 'old', 0, 1.0);
play('memOld', 'old', 0, 3.0);
hold('memOldRest', 'old', 3.0, 2.0);
cut();
hold('memNewIn', 'new', 0.6, 0.5);
play('memNew', 'new', 0.6, 3.4);
cut();
hold('memCmp', 'cmp', MEM.duration, 16.3);
// 3 · tension hides twist
cut();
hold('tenIn', 'ten', 0, 1.0);
play('tenTaut', 'ten', 0, 3.8);
play('tenSlack', 'ten', 3.8, 9.4);
play('tenRelIn', 'ten', 9.4, 10.3);
play('tenRel', 'ten', 10.3, 11.6, SLOW);
play('tenRelRest', 'ten', 11.6, 12.6);
cut();
play('tenReplay', 'ten', 10.0, 12.2);
cut();
hold('tenEnd', 'ten', 12.6, 5.2);
// 4 · the band
cut();
hold('morph', 'morph', 0, 6.2);
cut();
hold('bandsIn', 'band', 0, 5.6);
hold('pullCap', 'band', 0, 0.9);
play('pull', 'band', 0, 5.4);
hold('pulled', 'band', 5.4, 3.6);
hold('pushCap', 'band', 6.0, 1.0);
play('push', 'band', 6.0, 11.0);
hold('pushed', 'band', 11.0, 3.4);
hold('count', 'band', 11.5, 4.3);
play('pull2', 'band', 11.5, 14.6);
hold('pulled2', 'band', 14.6, 3.0);
play('relIn', 'band', 14.6, REL.a);
play('rel', 'band', REL.a, REL.b, SLOW);
play('relRest', 'band', REL.b, 18.0);
cut();
play('relReplay', 'band', REL.a - 0.8, REL.b + 0.4);
cut();
hold('relEnd', 'band', BAND.t.end, 4.0);
// 5 · the ring
cut();
hold('ringIn', 'ring', 0, 1.2);
play('ringTurn', 'ring', 0, FLIP.a);
play('ringFlip', 'ring', FLIP.a, FLIP.b, SLOW);
play('ringRest', 'ring', FLIP.b, RING.duration);
cut();
play('ringReplay', 'ring', FLIP.a - 0.8, FLIP.b + 0.4);
cut();
hold('ringEnd', 'ring', RING.duration, 5.2);
hold('ringFlash', 'ring', RING.duration, 6.4);
// 6 · the formula (over the über band: pulled ↔ pushed, the sum stays)
cut();
play('formula', 'formula', 6.0, 11.0, 0.7);
hold('formulaDna', 'formula', 11.0, 7.6);
// 7 · the sums, the finished ring
cut();
hold('sums', 'sums', 0, 9.6);
hold('final', 'final', 0, 4.4);

/** the part's length [s] */
export const LENGTH = sceneAt;

function seg(id: string): Seg {
  const s = SEGS.find((x) => x.id === id);
  if (!s) throw new Error(`p7-physics: no segment ${id}`);
  return s;
}
/** scene time where segment id starts / ends */
const S = (id: string) => seg(id).at;
const E = (id: string) => seg(id).at + seg(id).len;

function segAt(tau: number): Seg {
  let s = SEGS[0];
  for (const x of SEGS) {
    if (tau < x.at) break;
    s = x;
  }
  return s;
}
/** the shot time at scene time tau */
function shotAt(tau: number): number {
  const s = segAt(tau);
  const u = s.len > 0 ? Math.min(1, Math.max(0, (tau - s.at) / s.len)) : 1;
  return s.from + (s.to - s.from) * u;
}
const takeStart = (k: number) => (SEGS.find((x) => x.take === k) ?? SEGS[0]).at;

// ------------------------------------------------------------------------------------ captions

const CAPS: { text: string; a: number; b: number }[] = (() => {
  const out: { text: string; a: number; b: number }[] = [];
  /** a caption from a for its reading time (+ fade in) plus extra */
  const say = (text: string, a: number, extra = 0.2) => {
    const b = a + 0.35 + readTime(text) + extra;
    out.push({ text, a, b });
    return b;
  };
  say('Häng an jede Spitze dieselbe Klammer.', S('edgeIn') + 0.1);
  let b = say('So weit trägt sich ein Kabel selbst.', S('edgeRes') + 0.3);
  say('Ungefähr so groß werden seine Schlaufen.', b + 0.15);
  b = say('Dreh ein Ende, das andere sitzt fest.', S('knobIn') + 0.1);
  // (already there when the loop pops: no new text during the pop)
  say('Ein Kabel wehrt sich gegen Biegen und Verdrehen – fast gleich stark.', b + 0.15);
  say('Darum wird aus einer Drehung so leicht eine Schlaufe.', S('knobPop') + 3.3);
  b = say('Doppelt so dick: viel steifer.', S('edge2') + 0.2);
  say('Steifere Kabel brauchen größere Schlaufen.', b + 0.15);
  say('Lass ein altes und ein neues Kabel fallen.', S('memIn') + 0.1);
  b = say('Lange aufgerollt? Der Mantel hat sich an die Rundung gewöhnt.', S('memOldRest') + 1.55);
  b = say('Warm und gerade gelagert vergisst er schneller. Kälte macht PVC steif.', b + 0.15);
  say('Richtig wickeln trainiert das Kabel um.', b + 0.15);
  say('Gespannt sieht man den Drall nicht.', S('tenIn') + 0.1);
  say('Locker wird er zum Kringel.', S('tenSlack') + 0.02);
  say('Lass ein Ende los: Der Drall dreht sich heraus.', S('tenRelIn') - 0.6);
  say('Stecken beide Stecker, bleibt er drin.', S('tenEnd') + 0.2);
  say('Stell dir das Kabel als flaches Band vor.', S('morph') + 0.2);
  say('Enden fest – sie dürfen sich nicht drehen.', S('bandsIn') + 0.3);
  say('Zieh die Enden auseinander.', S('pullCap') + 0.05);
  say('Schieb sie wieder zusammen.', S('pushCap') - 0.3);
  b = say('Zähl einfach: über +1, unter −1.', S('count') + 0.2);
  say('Was übrig bleibt, steckt als Drehung im Kabel.', b + 0.15);
  say('Lässt du ein Ende los, dreht sich der Drall heraus.', S('pulled2') + 3.1);
  say('Das nutzt du bei der Acht.', S('relEnd') + 0.2);
  say('Dreh einen Stecker: Der Ring bekommt Drall.', S('ringIn') + 0.1);
  say('Zu viel Drall: Der Ring klappt zur Acht.', S('ringEnd') + 0.1);
  say('So schlägt auch die Schlaufe aus Stufe 5 eine Acht.', S('ringFlash') + 0.2);
  say('Dieselbe Rechnung erklärt die Superspiralen der DNA in der Zelle.', S('formulaDna') + 0.2);
  say('Darum über-unter: Die Drehungen heben sich auf.', S('sums') + 2.6);
  return out;
})();
const CAP_IN = 0.35, CAP_OUT = 0.3;

/** captions shorter than their reading time, overlapping, too long, or running past their beat: printed when the part runs */
const captionProblems = (() => {
  const out: string[] = [];
  CAPS.forEach((c, i) => {
    const visible = c.b - c.a - CAP_IN;
    if (visible < readTime(c.text) - 0.01) out.push(`"${c.text}" visible ${visible.toFixed(2)} s < ${readTime(c.text).toFixed(2)} s`);
    if (i > 0 && c.a < CAPS[i - 1].b) out.push(`"${c.text}" overlaps the caption before (${(CAPS[i - 1].b - c.a).toFixed(2)} s)`);
    if (c.text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length > 11) out.push(`"${c.text}" has more than 11 words`);
  });
  return out;
})();

// ------------------------------------------------------------------------------------ mocap

/**
 * Beats whose movement comes from a Kinect recording later (mocap/shots.json ids; times in part
 * seconds). Until then Ilse moves by the keyframes of shots/p7-physics-rig.ts.
 */
export const MOCAP_SLOTS = [
  { shot: 'p7.stiff.edge', role: 'Ilse', from: S('edgeIn'), to: E('edgeRes'), note: 'Klammern an die drei Spitzen: linke Hand auf dem Buch, rechte holt je eine Klammer und setzt sie auf; dann Hände weg, anschauen. Die Kabel bleiben Simulation (die Hand folgt der Spitze beim Loslassen). Auch edge2 (Wiederholung des Endbilds) nutzt das Ende dieser Aufnahme' },
  { shot: 'p7.stiff.edge', role: 'Ilse', from: S('edge2'), to: E('edge2'), note: 'Endpose der Aufnahme (Hände ruhen), nur Kamera und Text' },
  { shot: 'p7.stiff.twist', role: 'Ilse', from: S('knobIn'), to: E('knobHold'), note: 'Kurbel drehen bis die Schlaufe herausspringt; Zeitlupe aus derselben Aufnahme gedehnt. Die Kurbeldrehung (0,6 U/s, 4,7 U) treibt die Simulation: nach der Aufnahme an die gemessene Drehzahl anpassen (die Umdrehungen bis zur Schlaufe zählt die Nutzerin selbst mit)' },
  { shot: 'p7.memory.drop', role: 'Ilse', from: S('memIn'), to: E('memOldRest'), note: 'Take 1 (altes Kabel): halten, fallen lassen. Das Abziehen vom Ring ist nicht im Bild (Schnitt), die Aufnahme beginnt laut Plan früher' },
  { shot: 'p7.memory.drop', role: 'Ilse', from: S('memNewIn'), to: E('memNew'), note: 'Take 2 (neues Kabel)' },
  { shot: 'p7.tension', role: 'Ilse', from: S('tenIn'), to: E('tenEnd'), note: 'Spannen, locker lassen, links loslassen und rechts anheben; Zeitlupe aus derselben Aufnahme. Der Drall (4 U) ist im Shot vorgegeben, nicht von den Händen eingedreht' },
  { shot: 'p7.ribbon.pull', role: 'Ilse', from: S('bandsIn'), to: E('pulled2'), note: 'Take 1 (vier Über-Schlaufen) für die Hände; in der Animation schieben die Hände zwei Schlitten mit je vier Klemmen (alle vier Bänder zugleich), in der Aufnahme sind die Hände die Klemmen: Handbahn auf die Schlittengriffe übertragen. Ziehen, schieben, nochmals ziehen' },
  { shot: 'p7.ribbon.release', role: 'Ilse', from: S('relIn'), to: E('relEnd'), note: 'Linke Hand öffnet die Klemme des Über-Bands (in der Aufnahme: Ende anheben und loslassen)' },
  { shot: 'p7.ring.eight', role: 'Ilse', from: S('ringIn'), to: E('ringFlash'), note: 'Ring an beiden Steckern halten (Stecker aufgerichtet nebeneinander, der Ring hängt), die rechte Hand dreht ihren Stecker um die eigene Achse. Achtung: Bei einem gesteckten Ring ändert Drehen einer Hand den Drall des Rings nicht (Lk bleibt); in der Animation sind die Stecker deshalb nebeneinander in zwei Händen, nicht gesteckt' },
];

// ===================================================================================== helpers

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (v: V3): V3 => mul3(v, 1 / (Math.hypot(v[0], v[1], v[2]) || 1));
const mixV = (a: V3, b: V3, u: number): V3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (u: number) => easeInOutCubic(clamp01(u));
const TOPY = TABLE.height;

// the picture: one view over the whole width (above the caption band)
const VW = 1920 - 2 * GAP;
const midY = TOP + PANEL_H / 2;

/** a small dark chip like the "Zeitlupe" badge, with any text */
function badge(layer: Node, text: string, visible: () => number, x = 0, y = TOP + 24) {
  layer.add(
    <Rect x={x} y={y} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.text} opacity={visible} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={28} fill={'#fff'} />
    </Rect>,
  );
}

/** node d1 by parallel transport along a polyline (kinematic cables: the stripe on top at the start) */
function transportFrames(P: V3[], d0: V3 = [0, 1, 0]): V3[] {
  const out: V3[] = [];
  let d = d0;
  for (let i = 0; i < P.length; i++) {
    const t = norm3(sub3(P[Math.min(P.length - 1, i + 1)], P[Math.max(0, i - 1)]));
    d = norm3(sub3(d, mul3(t, dot3(d, t))));
    out.push(d);
  }
  return out;
}

/** a kinematic cable through points (old ring, the finished ring) */
function staticCable(P: V3[], radius: number, plugs: boolean) {
  const m = new CableMesh({ maxNodes: P.length, radius, plugStart: plugs ? 'xlr-male' : null, plugEnd: plugs ? 'xlr-female' : null, stripeWidth: 0.05 });
  const pos = new Float32Array(3 * P.length), d1 = new Float32Array(3 * P.length);
  transportFrames(P).forEach((d, i) => {
    pos.set(P[i], 3 * i);
    d1.set(d, 3 * i);
  });
  m.update(pos, d1, P.length);
  return m;
}

const box = (w: number, h: number, d: number, color: string, rough = 0.6, metal = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  m.castShadow = m.receiveShadow = true;
  return m;
};
const cyl = (r: number, h: number, color: string, rough = 0.4, metal = 0.3) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  m.castShadow = m.receiveShadow = true;
  return m;
};

/** a binder clip (black jaws, silver handles); local x = along the cable, y up */
function binderClip() {
  const g = new THREE.Group();
  const jaw = box(0.018, 0.012, 0.02, '#141416', 0.4, 0.2);
  g.add(jaw);
  for (const s of [-1, 1]) {
    const h = cyl(0.0012, 0.022, '#c9ccd1', 0.25, 0.8);
    h.rotation.x = s * 0.5;
    h.position.set(0, 0.012, s * 0.006);
    g.add(h);
  }
  return g;
}

/** a frame that turns local +z onto dir (shortest arc) */
const alongQuat = (dir: V3) => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());

// ===================================================================================== cameras

const CAMS: Record<string, Orbit> = {
  intro: { target: [-0.25, 0.86, 0.5], yaw: 0.42, pitch: 0.38, dist: 2.3, fov: 36 },
  // from behind her, to her right: the pieces in profile against the light floor beyond the table's end
  edge: { target: [EDGE.edgeX + EDGE_DX - 0.1, TOPY - 0.05, 0.4], yaw: Math.PI + 0.6, pitch: 0.22, dist: 0.78, fov: 36 },
  knob: { target: [KNOB.cx, KNOB.H - 0.16, KNOB.z], yaw: 0.25, pitch: 0.42, dist: 1.1, fov: 36 },
  mem: { target: [0, TOPY + 0.12, MEM.z], yaw: 0.2, pitch: 0.42, dist: 1.55, fov: 36 },
  cmp: { target: [0, TOPY + 0.02, MEM.z], yaw: 0.0, pitch: 0.95, dist: 1.5, fov: 36 },
  ten: { target: [TENSION.cx - 0.02, TENSION.H - 0.16, TENSION.z], yaw: 0.22, pitch: 0.12, dist: 1.75, fov: 36 },
  tenClose: { target: [TENSION.cx, TENSION.H - 0.2, TENSION.z], yaw: 0.22, pitch: 0.14, dist: 1.3, fov: 36 },
  tenLow: { target: [TENSION.cx - 0.08, TENSION.H - 0.3, TENSION.z], yaw: 0.22, pitch: 0.1, dist: 1.85, fov: 36 },
  morph: { target: [0, TOPY + 0.02, BAND.rows.over], yaw: 0.0, pitch: 0.82, dist: 0.95, fov: 36 },
  band: { target: [0, TOPY + 0.03, 0.82], yaw: 0.0, pitch: 0.92, dist: 2.1, fov: 34 },
  ring: { target: [RING.cx, RING.top - 0.3, RING.z], yaw: 0.75, pitch: 0.12, dist: 1.2, fov: 36 },
  // (the band low in the picture, under the formula card)
  formula: { target: [0.0, TOPY + 0.2, BAND.rows.over - 0.3], yaw: 0.0, pitch: 0.75, dist: 1.6, fov: 34 },
  final: { target: [2.6, 0.62, 0.0], yaw: 0.35, pitch: 0.62, dist: 1.05, fov: 34 },
};

// ===================================================================================== the part

export function* part(layer: Node) {
  const bake = function* (id: string) {
    return (yield loadBake(id)) as BakedRod;
  };
  const B = {
    edge: { charging: yield* bake('p7-edge-charging'), xlr: yield* bake('p7-edge-xlr'), power: yield* bake('p7-edge-power') } as Record<EdgeKind, BakedRod>,
    knob: yield* bake('p7-knob'),
    old: yield* bake('p7-mem-old'),
    neu: yield* bake('p7-mem-new'),
    ten: yield* bake('p7-tension'),
    band: {} as Record<BandKind, BakedRod>,
    ring: yield* bake('p7-ring'),
    eight: yield* bake('eight-snap'),
  };
  for (const k of BAND_ORDER) B.band[k] = yield* bake(`p7-band-${k}`);
  for (const p of captionProblems) console.log('[render] p7-physics caption:', p);

  const { tau, run } = clock(LENGTH);
  /** 0 → 1 → 0 between scene times a and b (fading in and out) */
  const win = (a: number, b: number, fi = 0.35, fo = 0.35) => {
    const s = tau();
    return smooth((s - a) / Math.max(1e-6, fi)) * (1 - smooth((s - (b - fo)) / Math.max(1e-6, fo)));
  };
  const cur = () => segAt(tau());
  const t = () => shotAt(tau());
  const node = (b: BakedRod, i: number, tt: number): V3 => b.nodeAt(tt, i, [0, 0, 0]);
  const idx = (b: BakedRod, k: string) => Math.round(b.track(k, 0));

  // ------------------------------------------------------------------------- what the bakes say
  const firstAbove = (b: BakedRod, track: string, v: number, from = 0) => {
    for (let x = from; x <= b.duration; x += 1 / 60) if (Math.abs(b.track(track, x)) > v) return x;
    return Infinity;
  };
  const edgeEnd = Object.fromEntries((Object.keys(B.edge) as EdgeKind[]).map((k) => [k, { before: B.edge[k].track('droop', EDGE.clampAt[k] - 0.05), after: B.edge[k].track('droop', EDGE.duration) }])) as Record<EdgeKind, { before: number; after: number }>;
  const knobPop = firstAbove(B.knob, 'wr', 0.5);
  const knobAt = { pop: knobPop, turns: B.knob.track('turns', knobPop), wrEnd: B.knob.track('wr', KNOB.duration) };
  const memEnd = { oldCurl: B.old.track('curl', MEM.duration), oldStraight: B.old.track('straight', MEM.duration), newCurl: B.neu.track('curl', MEM.duration), newStraight: B.neu.track('straight', MEM.duration) };
  const tenAt = {
    taut: { tw: B.ten.track('tw', 3.5), wr: B.ten.track('wr', 3.5) },
    slack: { tw: B.ten.track('tw', 9.4), wr: B.ten.track('wr', 9.4) },
    end: { tw: B.ten.track('tw', TEN.end), wr: B.ten.track('wr', TEN.end) },
  };
  const lkOf = (k: BandKind, tt: number) => B.band[k].track('tw', tt) + B.band[k].track('wr', tt);
  const bandAt = Object.fromEntries(BAND_ORDER.map((k) => [k, {
    lk: lkOf(k, 0),
    taut: { tw: B.band[k].track('tw', 5.4), wr: B.band[k].track('wr', 5.4) },
    pushed: { tw: B.band[k].track('tw', 11.0), wr: B.band[k].track('wr', 11.0) },
    end: { tw: B.band[k].track('tw', BAND.t.end), wr: B.band[k].track('wr', BAND.t.end), spin: B.band[k].track('spin', BAND.t.end) },
  }])) as Record<BandKind, { lk: number; taut: { tw: number; wr: number }; pushed: { tw: number; wr: number }; end: { tw: number; wr: number; spin: number } }>;
  const ringAt = { flip: firstAbove(B.ring, 'wr', 0.8), wrEnd: B.ring.track('wr', RING.duration), turns: B.ring.track('turns', firstAbove(B.ring, 'wr', 0.8)) };
  // what may be claimed (labels and ticks appear only if the bake shows it)
  const truth = {
    thinHangs: edgeEnd.charging.after > 0.1,
    xlrHangs: edgeEnd.xlr.after > 0.08,
    thickStraight: edgeEnd.power.after < 0.03,
    loopPops: knobAt.wrEnd > 0.7 && knobAt.pop < POP.b,
    oldCurls: memEnd.oldCurl > 0.8 && memEnd.oldStraight < 0.8,
    newStraight: memEnd.newStraight > 0.95,
    hiddenTaut: Math.abs(tenAt.taut.wr) < 0.1 && Math.abs(tenAt.taut.tw) > 3.5,
    curlSlack: Math.abs(tenAt.slack.wr) > 1.0,
    twistOut: Math.abs(tenAt.end.tw) < 0.2 && Math.abs(tenAt.end.wr) < 0.2,
    overTaut: bandAt.over.taut.tw > 3.5,
    underTaut: bandAt.under.taut.tw < -3.5,
    altFlat: Math.abs(bandAt.alt.taut.tw) < 0.3 && Math.abs(bandAt.alt.taut.wr) < 0.3,
    oouoTaut: Math.abs(bandAt.oouo.taut.tw - 2) < 0.3,
    overLoops: bandAt.over.pushed.wr > 1.5,
    underLoops: bandAt.under.pushed.wr < -1.5,
    altCalm: Math.abs(bandAt.alt.pushed.wr) < 0.3,
    oouoCurl: Math.abs(bandAt.oouo.pushed.wr) > 0.7,
    released: Math.abs(bandAt.over.end.tw + bandAt.over.end.wr) < 0.3,
    ringEight: ringAt.wrEnd > 1.0,
  };
  console.log('[render] p7-physics checks', JSON.stringify({
    length: +LENGTH.toFixed(2),
    segs: SEGS.map((x) => `${x.id} ${x.at.toFixed(2)}`).join(' | '),
    edgeEnd, knobAt, memEnd, tenAt, bandAt, ringAt, truth, captionProblems,
  }));

  // ------------------------------------------------------------------------- Ilse: one RigTrack per take
  const seatOf = (b: Beat): Seat => (b === 'edge' ? 'edge' : b === 'knob' ? 'knob' : b === 'ten' || b === 'ring' ? 'tension' : 'centre');
  const plugsOf = (b: BakedRod, tt: number): [{ p: V3; out: V3 }, { p: V3; out: V3 }] => {
    const i0 = idx(b, 'i0'), i1 = idx(b, 'i1'), n = b.n;
    const a0 = node(b, 0, tt), a1 = node(b, i0, tt), b0 = node(b, n - 1, tt), b1 = node(b, i1, tt);
    return [{ p: mixV(a0, a1, 0.5), out: norm3(sub3(a0, a1)) }, { p: mixV(b0, b1, 0.5), out: norm3(sub3(b0, b1)) }];
  };
  const edgeTip = (k: number, tt: number) => {
    const b = B.edge[(['charging', 'xlr', 'power'] as EdgeKind[])[k]];
    return add3(node(b, b.n - 1, tt), [EDGE_DX, 0, 0]);
  };
  const knobLow = (tt: number): V3 => {
    const b = B.knob, i0 = idx(b, 'i0'), i1 = idx(b, 'i1');
    let best = i0, y = Infinity;
    for (let i = i0; i <= i1; i += 3) {
      const p = node(b, i, tt);
      if (p[1] < y) { y = p[1]; best = i; }
    }
    return node(b, best, tt);
  };
  const bandHalfAt = (tt: number) => B.band.over.track('half', tt);
  const rigAt = (s: number): Rig => {
    const sc = Math.min(LENGTH, Math.max(0, s));
    const sg = segAt(sc), tt = shotAt(sc);
    switch (sg.beat) {
      case 'edge':
        return edgeRig(tt, sc, edgeTip);
      case 'knob':
        return knobRig(tt, sc, () => knobLow(tt));
      case 'old':
      case 'new': {
        const b = sg.beat === 'old' ? B.old : B.neu;
        return holdRig('centre', sc, plugsOf(b, tt), tt, MEM.release, [0, TOPY + 0.05, MEM.z]);
      }
      case 'ten': {
        const pl = plugsOf(B.ten, tt);
        const look = mixV(mixV(pl[0].p, pl[1].p, 0.5), node(B.ten, 2, tt), clamp01((tt - TEN.release) / 0.8) * 0.7);
        return holdRig('tension', sc, pl, tt, TEN.release, look, [[SEATS.tension[0] + 0.25, TOPY - 0.12, 0.22], null], true);
      }
      case 'band':
        return bandRig(tt, sc, bandHalfAt(tt), [0, TOPY, 0.62], BAND.t.release);
      case 'ring':
        return holdRig('tension', sc, plugsOf(B.ring, tt), tt, null, [RING.cx, RING.top - 0.25, RING.z]);
      case 'morph':
        return introRig(sc, 'centre', [0, TOPY, BAND.rows.over]);
      case 'cmp':
        return introRig(sc, 'centre', [0, TOPY, MEM.z]);
      default:
        return introRig(sc);
    }
  };
  const tracks = new Map<number, RigTrack>();
  const trackOf = (k: number) => {
    let tr = tracks.get(k);
    if (!tr) {
      const s0 = takeStart(k);
      tr = new RigTrack(ILSE, (x) => rigAt(s0 + x), 0, 30);
      tracks.set(k, tr);
    }
    return tr;
  };
  const poseNow = () => {
    const sg = cur();
    return trackOf(sg.take).pose(tau() - takeStart(sg.take));
  };

  // ------------------------------------------------------------------------- the world
  const world = new World3D('p7-physics', () => update());
  const scene = world.scene;
  const studio = new Studio(scene, { focus: [0, 0.8, 0.6], focusRadius: 1.4 });
  const desk = table({ width: TABLE.width, depth: TABLE.depth, height: TABLE.height, top: '#e6dccb' });
  desk.position.set(TABLE.x, 0, TABLE.z);
  const chair = wheelchair();
  const ilse = splitPerson(ILSE, new RigTrack(ILSE, (x) => introRig(x), 0, 30).pose(0));
  scene.add(desk, chair, ilse.person.group);
  const groups: Record<string, THREE.Group> = {};
  const group = (name: string) => {
    const g = new THREE.Group();
    groups[name] = g;
    scene.add(g);
    return g;
  };

  // 1 · the edge: three pieces, the book, the tray, three clamps
  const gEdge = group('edge');
  const edgeMesh = {} as Record<EdgeKind, CableMesh>;
  for (const k of Object.keys(B.edge) as EdgeKind[]) {
    const spec = EDGE_SPEC[k];
    edgeMesh[k] = new CableMesh({ maxNodes: B.edge[k].n, radius: spec.od / 2, stripe: k === 'xlr' ? undefined : null, stripeWidth: 0.05, plugStart: null, plugEnd: null, ground: TOPY, sub: 3 });
    gEdge.add(edgeMesh[k].group);
  }
  const book = box(0.17, 0.03, 0.34, '#7a4e3a', 0.8);
  book.position.set(BOOK[0] - EDGE_DX, TOPY + 0.016 + 0.015, BOOK[2]);
  const tray = box(0.1, 0.012, 0.07, '#9aa0a8', 0.5, 0.3);
  tray.position.set(TRAY[0] - EDGE_DX, TOPY + 0.006, TRAY[2]);
  gEdge.add(book, tray);
  const clips = [0, 1, 2].map(() => binderClip());
  gEdge.add(...clips);

  // 1b · the crank: the cable, the vise post, the crank on its post
  const gKnob = group('knob');
  const knobCable = new CableMesh({ maxNodes: B.knob.n, radius: 0.0032, plugStart: 'xlr-female', plugEnd: 'xlr-male', stripeWidth: 0.05 });
  gKnob.add(knobCable.group);
  const post = (x: number, z: number, top: number) => {
    const m = cyl(0.012, top - TOPY, '#2b2c30', 0.5, 0.4);
    m.position.set(x, (top + TOPY) / 2, z);
    const foot = cyl(0.05, 0.012, '#2b2c30', 0.5, 0.4);
    foot.position.set(x, TOPY + 0.006, z);
    gKnob.add(m, foot);
  };
  const vOut = KNOB.viseOut, cOut = KNOB.crankOut;
  const viseJaw = box(0.05, 0.035, 0.04, '#3a3c41', 0.4, 0.5);
  const viseAt = add3(KNOB.vise, mul3(vOut, 0.035));
  viseJaw.position.set(viseAt[0], viseAt[1], viseAt[2]);
  viseJaw.quaternion.copy(alongQuat(vOut).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)));
  gKnob.add(viseJaw);
  post(viseAt[0] + 0.01, KNOB.z, viseAt[1] - 0.02);
  const bearingAt = add3(KNOB.crank, mul3(cOut, 0.1));
  const bearing = cyl(0.016, 0.03, '#3a3c41', 0.4, 0.5);
  bearing.position.set(bearingAt[0], bearingAt[1], bearingAt[2]);
  bearing.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...cOut)));
  gKnob.add(bearing);
  post(bearingAt[0] - 0.005, KNOB.z + 0.03, bearingAt[1] - 0.015);
  // the turning part: a disc at the plug's back, the arm, the handle (local +z = the crank's axis)
  const crank = new THREE.Group();
  const disc = cyl(0.05, 0.008, '#b2161a', 0.5, 0.1);
  disc.rotation.x = Math.PI / 2;
  disc.position.z = 0.085;
  crank.add(disc);
  const handle = cyl(0.008, 0.04, '#1d1e21', 0.6, 0.1);
  handle.rotation.x = Math.PI / 2;
  crank.add(handle);
  const hub = cyl(0.009, 0.03, '#c9ccd1', 0.3, 0.7);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = 0.07;
  crank.add(hub);
  gKnob.add(crank);

  // 2 · memory: old and new cable, the old ring they come from
  const gMem = group('mem');
  const oldCable = new CableMesh({ maxNodes: B.old.n, radius: 0.0032, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.05, ground: TOPY });
  const newCable = new CableMesh({ maxNodes: B.neu.n, radius: 0.0032, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.05, ground: TOPY });
  gMem.add(oldCable.group, newCable.group);
  const oldRing = staticCable(coilPoints({ center: [0.5, TOPY + 0.004, 0.86], R: 0.11, loops: 3, pitch: 0.0065, seg: 0.01, lead: 0.12, handed: 1 }).map((p) => [p[0], TOPY + 0.0035 + (p[1] - TOPY - 0.004) * 0.4, p[2]] as V3), 0.0032, true);
  gMem.add(oldRing.group);

  // 3 · tension
  const gTen = group('ten');
  const tenCable = new CableMesh({ maxNodes: B.ten.n, radius: 0.0032, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.05 });
  gTen.add(tenCable.group);

  // 4 · the bands: four ribbons, the morphing cable, rails, sleds, clamps
  const gBand = group('band');
  const BAND_W = 0.025, BAND_T = 0.0025;
  const ribbons = {} as Record<BandKind, RibbonMesh>;
  for (const k of BAND_ORDER) {
    ribbons[k] = new RibbonMesh({ maxNodes: B.band[k].n, width: BAND_W, thickness: BAND_T, top: '#f2c230', bottom: '#2a2d33' });
    (ribbons[k].mesh.material as THREE.MeshStandardMaterial).transparent = true;
    gBand.add(ribbons[k].mesh);
  }
  const morphCable = new CableMesh({ maxNodes: B.band.over.n, radius: 0.0045, plugStart: null, plugEnd: null, stripeWidth: 0.06, ground: TOPY });
  morphCable.material.transparent = true;
  gBand.add(morphCable.group);
  const gRig = new THREE.Group();
  gBand.add(gRig);
  for (const z of [SLED.nearZ, SLED.farZ]) {
    const rail = box(1.56, 0.012, 0.022, '#b9bdc3', 0.3, 0.6);
    rail.position.set(0, TOPY + 0.006, z);
    gRig.add(rail);
  }
  const sleds = [-1, 1].map(() => {
    const g = new THREE.Group();
    const bar = box(0.035, 0.02, SLED.farZ - SLED.nearZ + 0.06, '#2b2c30', 0.5, 0.4);
    bar.position.set(0, TOPY + 0.022, (SLED.nearZ + SLED.farZ) / 2);
    const knobH = cyl(0.011, 0.07, '#1d1e21', 0.7, 0.1);
    knobH.position.set(0, SLED.handleY - 0.005, SLED.nearZ - 0.03);
    g.add(bar, knobH);
    return g;
  });
  gRig.add(...sleds);
  /** clamps: [band][side 0 = −x, 1 = +x]: a post and a jaw at the band's end, the lever on top */
  const clamps = BAND_ORDER.map((k) => [-1, 1].map(() => {
    const g = new THREE.Group();
    const postM = box(0.012, BAND.lift, 0.012, '#2b2c30', 0.5, 0.4);
    postM.position.set(0, TOPY + 0.032 + BAND.lift / 2 - 0.02, BAND.rows[k]);
    const jaw = box(0.034, 0.016, 0.036, '#3a3c41', 0.4, 0.5);
    jaw.position.set(0, TOPY + BAND.rc + BAND.lift, BAND.rows[k]);
    const lever = box(0.006, 0.006, 0.04, '#b2161a', 0.5, 0.1);
    lever.position.set(0, TOPY + BAND.rc + BAND.lift + 0.012, BAND.rows[k]);
    g.add(postM, jaw, lever);
    return { g, lever };
  }));
  for (const c of clamps) for (const s of c) gRig.add(s.g);

  // 5 · the ring
  const gRing = group('ring');
  const ringCable = new CableMesh({ maxNodes: B.ring.n, radius: 0.0032, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.05 });
  gRing.add(ringCable.group);

  // 7 · the finished ring on a flight case (kinematic)
  const gFinal = group('final');
  const fcase = flightCase({ width: 0.7, depth: 0.5, height: 0.55 });
  fcase.position.set(2.6, 0, 0);
  const finRing = staticCable(coilPoints({ center: [2.6, 0.555, 0], R: 0.12, loops: 6, pitch: 0.0068, seg: 0.012, lead: 0.16, handed: 1 }).map((p) => [p[0], 0.555 + (p[1] - 0.555) * 0.6 + 0.004, p[2]] as V3), 0.0032, true);
  const strap = box(0.03, 0.03, 0.006, '#26282c', 0.8);
  strap.position.set(2.6 + 0.12, 0.575, 0);
  strap.rotation.y = Math.PI / 2;
  gFinal.add(fcase, finRing.group, strap);

  // the inset: stage 5's eight (eight-snap at its eight), in a little world of its own
  const eightIdx = { iF: idx(B.eight, 'iF'), iE: idx(B.eight, 'iE'), iPlug: idx(B.eight, 'iPlug') };
  const EIGHT_T = 4.4;
  const eightWorld = new World3D('p7-physics-eight', () => {
    B.eight.frameSample(EIGHT_T, ePos, eD1);
    eightCable.update(ePos, eD1, eightIdx.iPlug + 1);
  });
  const ePos = new Float32Array(3 * B.eight.n), eD1 = new Float32Array(3 * B.eight.n);
  const eightCable = new CableMesh({ maxNodes: B.eight.n, radius: 0.0032, plugStart: null, plugEnd: 'xlr-female', stripeWidth: 0.05 });
  eightWorld.scene.add(eightCable.group);
  new Studio(eightWorld.scene, { focus: [0, 0.8, 0], focusRadius: 1 });
  const eightCam = makeCamera(34);
  {
    const c: V3 = [0, 0, 0];
    for (let i = eightIdx.iF; i <= eightIdx.iE; i++) {
      const p = node(B.eight, i, EIGHT_T);
      for (let k = 0; k < 3; k++) c[k] += p[k] / (eightIdx.iE - eightIdx.iF + 1);
    }
    orbit(eightCam, { target: c, yaw: 1.31, pitch: 0.25, dist: 0.62, fov: 34 });
  }

  // scratch for the bakes
  const maxN = Math.max(B.knob.n, B.old.n, B.ten.n, B.ring.n, ...BAND_ORDER.map((k) => B.band[k].n), ...Object.values(B.edge).map((b) => b.n));
  const pos = new Float32Array(3 * maxN), d1 = new Float32Array(3 * maxN), d2 = new Float32Array(3 * maxN);
  const draw = (b: BakedRod, mesh: CableMesh, tt: number, from = 0, to = b.n - 1) => {
    b.frameSample(tt, pos, d1);
    mesh.update(pos.subarray(3 * from), d1.subarray(3 * from), to - from + 1);
  };
  /** a band: the ribbon's width runs along −d2, so its yellow face looks along d1 (the stripe) */
  const drawBand = (b: BakedRod, r: RibbonMesh, tt: number) => {
    b.frameSample(tt, pos, d1, d2);
    for (let i = 0; i < 3 * b.n; i++) d2[i] = -d2[i];
    r.update(pos, d2, b.n);
  };

  const cam = makeCamera(36);
  const camOut: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  /** the camera per beat; moves (ease) between some beats, cuts elsewhere */
  const camAt = (): Orbit => {
    const sg = cur(), s = tau(), tt = t();
    switch (sg.beat) {
      case 'intro':
        return mixOrbit(CAMS.intro, { ...CAMS.intro, yaw: 0.3, dist: 2.1 }, ease((s - S('intro')) / 3.0), camOut);
      case 'edge':
        return CAMS.edge;
      case 'knob':
        return CAMS.knob;
      case 'old':
      case 'new':
        return CAMS.mem;
      case 'cmp':
        return CAMS.cmp;
      case 'ten':
        if (tt < TEN.release - 0.6) return mixOrbit(CAMS.ten, CAMS.tenClose, ease((tt - TEN.slack0 + 0.4) / 1.6), camOut);
        return mixOrbit(CAMS.tenClose, CAMS.tenLow, ease((tt - TEN.release + 0.6) / 1.4), camOut);
      case 'morph':
        return CAMS.morph;
      case 'band':
        return CAMS.band;
      case 'ring':
        return CAMS.ring;
      case 'formula':
        return CAMS.formula;
      default:
        return CAMS.final;
    }
  };

  function update() {
    const sg = cur(), tt = t(), b = sg.beat;
    const show = (name: string, on: boolean) => (groups[name].visible = on);
    show('edge', b === 'edge' || b === 'intro');
    show('knob', b === 'knob' || b === 'intro');
    show('mem', b === 'old' || b === 'new' || b === 'cmp' || b === 'intro');
    // the edge beat happens EDGE_DX further left at the table (shots/p7-physics-rig.ts EDGE_DX)
    groups.edge.position.x = b === 'edge' ? EDGE_DX : 0;
    desk.position.x = TABLE.x + (b === 'edge' ? EDGE_DX : 0);
    show('ten', b === 'ten');
    show('band', b === 'morph' || b === 'band' || b === 'formula');
    show('ring', b === 'ring');
    show('final', b === 'final' || b === 'sums');
    desk.visible = chair.visible = ilse.person.group.visible = b !== 'final' && b !== 'sums';
    // (the tension and the ring happen beside the table: its corner would only clutter the picture)
    if (b === 'ten' || b === 'ring') desk.visible = false;
    // Ilse and her chair
    if (ilse.person.group.visible) {
      ilse.update(poseNow());
      const seat = SEATS[seatOf(b)], f = yawFrame(Math.PI).f;
      chair.position.set(seat[0] + f[0] * 0.03, 0, seat[1] + f[2] * 0.03);
      chair.rotation.y = 0;
    }
    if (b === 'intro') {
      for (const k of Object.keys(B.edge) as EdgeKind[]) draw(B.edge[k], edgeMesh[k], EDGE.duration);
      clips.forEach((c, i) => c.position.set(TRAY[0] - EDGE_DX - 0.03 + 0.03 * i, TOPY + 0.018, TRAY[2]));
      oldCable.group.visible = newCable.group.visible = false;
      oldRing.group.visible = true;
    }
    if (b === 'edge') {
      for (const k of Object.keys(B.edge) as EdgeKind[]) draw(B.edge[k], edgeMesh[k], tt);
      // the clips: in the tray, in her right hand, on the tips
      const kinds: EdgeKind[] = ['charging', 'xlr', 'power'];
      const pose = poseNow();
      const hand = pose.body.arms?.[1]?.grip?.p as V3 | undefined;
      kinds.forEach((k, i) => {
        const at = EDGE.clampAt[k];
        const take = edgeTake(i);
        const c = clips[i];
        if (tt >= at - 0.15) {
          const bk = B.edge[k], n = bk.n;
          const p = node(bk, n - 1, tt), q = node(bk, n - 3, tt);
          const dir = norm3(sub3(p, q));
          c.position.set(p[0] - dir[0] * 0.006, p[1] - dir[1] * 0.006 + 0.002, p[2] - dir[2] * 0.006);
          c.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(dir[0], dir[1], dir[2]));
        } else if (tt > take && hand) {
          c.position.set(hand[0] - EDGE_DX, hand[1] - 0.018, hand[2]);
          c.quaternion.identity();
        } else {
          c.position.set(TRAY[0] - EDGE_DX - 0.03 + 0.03 * i, TOPY + 0.018, TRAY[2]);
          c.quaternion.identity();
        }
      });
    }
    if (b === 'knob' || b === 'intro') {
      const kt = b === 'knob' ? tt : 0;
      draw(B.knob, knobCable, kt);
      crank.position.set(KNOB.crank[0], KNOB.crank[1], KNOB.crank[2]);
      const q = knobRot(kt);
      crank.quaternion.set(q[0], q[1], q[2], q[3]).multiply(alongQuat(KNOB.crankOut));
      const h = crankHandle(kt);
      // the handle in the crank's frame
      const local = new THREE.Vector3(h[0], h[1], h[2]).sub(crank.position).applyQuaternion(crank.quaternion.clone().invert());
      handle.position.set(local.x, local.y, local.z + 0.02);
      disc.position.set(0, 0, local.z);
    }
    if (b === 'old' || b === 'new' || b === 'cmp') {
      oldCable.group.visible = b === 'old' || b === 'cmp';
      newCable.group.visible = b === 'new' || b === 'cmp';
      const oT = b === 'cmp' ? MEM.duration : tt;
      if (oldCable.group.visible) draw(B.old, oldCable, oT);
      if (newCable.group.visible) draw(B.neu, newCable, oT);
      oldCable.group.position.x = b === 'cmp' ? CMP_X.old : 0;
      newCable.group.position.x = b === 'cmp' ? CMP_X.neu : 0;
      oldCable.group.position.z = newCable.group.position.z = b === 'cmp' ? 0.06 : 0;
      oldRing.group.visible = b !== 'cmp';
    }
    if (b === 'ten') draw(B.ten, tenCable, tt);
    if (b === 'morph' || b === 'band' || b === 'formula') {
      const morph = b === 'morph' ? ease((tau() - S('morph') - 1.6) / 2.2) : 1;
      const only = b !== 'band';
      for (const k of BAND_ORDER) {
        const r = ribbons[k];
        r.mesh.visible = k === 'over' || !only;
        if (!r.mesh.visible) continue;
        // the bands other than über fade in at the start of the beat
        const op = k === 'over' ? (b === 'morph' ? smooth((morph - 0.2) / 0.5) : 1) : smooth((tau() - S('bandsIn')) / 0.8);
        (r.mesh.material as THREE.MeshStandardMaterial).opacity = op;
        (r.mesh.material as THREE.MeshStandardMaterial).depthWrite = op > 0.99;
        r.setSize(0.009 + (BAND_W - 0.009) * morph, 0.009 + (BAND_T - 0.009) * morph);
        drawBand(B.band[k], r, tt);
      }
      morphCable.group.visible = b === 'morph' && morph < 0.99;
      if (morphCable.group.visible) {
        morphCable.material.opacity = 1 - smooth((morph - 0.1) / 0.5);
        draw(B.band.over, morphCable, 0);
      }
      gRig.visible = b === 'band' || b === 'formula';
      const half = bandHalfAt(tt);
      sleds[0].position.x = -half;
      sleds[1].position.x = half;
      BAND_ORDER.forEach((k, i) => {
        clamps[i].forEach((c, side) => {
          c.g.position.x = (side === 0 ? -1 : 1) * half;
          c.g.visible = b === 'band' || k === 'over';
          // the über band's +x clamp opens at the release
          const open = k === 'over' && side === 1 ? smooth((tt - BAND.t.release + 0.15) / 0.2) : 0;
          c.lever.rotation.x = -1.1 * open;
          c.lever.position.y = TOPY + BAND.rc + BAND.lift + 0.012 + 0.012 * open;
        });
      });
      sleds.forEach((sl) => (sl.visible = b === 'band' || b === 'formula'));
    }
    if (b === 'ring') draw(B.ring, ringCable, tt);
    // camera and shadow focus
    const o = camAt();
    orbit(cam, o);
    studio.focus(o.target, b === 'intro' ? 1.8 : 1.1);
  }

  // ------------------------------------------------------------------------- the picture
  const root = new Node({ opacity: () => smooth(tau() / 0.5) * (1 - smooth((tau() - (LENGTH - 0.6)) / 0.6)) });
  layer.add(root);
  const cardOn = () => Math.max(win(S('sums'), E('sums'), 0.5, 0.5));
  const view = (<ThreeView world={world} camera={cam} x={0} y={midY} width={VW} height={PANEL_H} radius={28} opacity={() => 1 - 0.85 * cardOn()} />) as ThreeView;
  root.add(view);
  root.add(<StageChip current={7} x={0} y={TOP + PANEL_H + 34} />);

  // title plate in the intro
  root.add(
    <Rect x={-VW / 2 + 24} y={TOP + 24} offset={[-1, -1]} padding={[10, 24]} radius={40} fill={C.plate} layout opacity={() => win(0.2, E('intro'), 0.4, 0.4)}>
      <Txt text={'Für Neugierige: die Physik'} fontFamily={FONT} fontWeight={700} fontSize={40} fill={C.text} />
    </Rect>,
  );
  // which experiment (top left)
  const topic = (text: string, a: number, b: number) =>
    root.add(
      <Rect x={-VW / 2 + 24} y={TOP + 24} offset={[-1, -1]} padding={[8, 22]} radius={40} fill={C.plate} layout opacity={() => win(a, b, 0.4, 0.4)}>
        <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={34} fill={C.text} />
      </Rect>,
    );
  topic('Steifigkeit', S('edgeIn'), E('edge2'));
  topic('Formgedächtnis', S('memIn'), E('memCmp'));
  topic('Zug versteckt den Drall', S('tenIn'), E('tenEnd'));
  topic('Das Band', S('morph'), E('relEnd'));
  topic('Zu viel Drall im Ring', S('ringIn'), E('ringFlash'));

  // badges over the view: slow motion, real time
  badge(root, 'Zeitlupe', () => Math.max(win(S('knobPop'), E('knobPop'), 0.2, 0.2), win(S('tenRel'), E('tenRel'), 0.2, 0.2), win(S('rel'), E('rel'), 0.2, 0.2), win(S('ringFlip'), E('ringFlip'), 0.2, 0.2)));
  badge(root, 'Echtzeit', () => Math.max(win(S('knobReplay'), E('knobReplay'), 0.3, 0.3), win(S('tenReplay'), E('tenReplay'), 0.3, 0.3), win(S('relReplay'), E('relReplay'), 0.3, 0.3), win(S('ringReplay'), E('ringReplay'), 0.3, 0.3)));

  // ------------------------------------------------------------------------- labels where it happens
  const label = (o: { target: () => V3; at: [number, number] | (() => [number, number]); text: string | (() => string); color?: string; on: () => number; size?: number }) =>
    root.add(callout({ view, target: o.target, at: o.at, text: o.text, color: o.color, size: o.size ?? 34, arrow: true, opacity: o.on }));
  const tNode = (b: () => BakedRod, i: () => number) => () => node(b(), i(), t());
  const L = -VW / 2, R = VW / 2;

  // 1 · names and diameters at the tips, then what each one does
  const tip = (k: EdgeKind) => () => add3(node(B.edge[k], B.edge[k].n - 1, t()), [EDGE_DX, 0, 0]);
  const edgeNames: Record<EdgeKind, string> = { charging: 'Ladekabel Ø 4 mm', xlr: 'XLR Ø 6,4 mm', power: 'Starkstrom Ø 16 mm' };
  const edgeAt: Record<EdgeKind, [number, number]> = { charging: [L + 330, TOP + 150], xlr: [L + 330, TOP + 300], power: [L + 330, TOP + 450] };
  for (const k of ['charging', 'xlr', 'power'] as EdgeKind[]) {
    label({ target: tip(k), at: edgeAt[k], text: edgeNames[k], on: () => Math.max(win(S('edgeIn') + 0.3, S('edge') + 1.0, 0.4, 0.3), win(S('edge2') + 0.3, E('edge2'), 0.4, 0.3)) });
  }
  const verdict: Record<EdgeKind, { text: string; ok: boolean }> = {
    charging: { text: 'hängt', ok: truth.thinHangs },
    xlr: { text: 'hängt', ok: truth.xlrHangs },
    power: { text: 'bleibt fast gerade', ok: truth.thickStraight },
  };
  for (const k of ['charging', 'xlr', 'power'] as EdgeKind[]) {
    if (!verdict[k].ok) continue;
    const a = S('edge') + (EDGE.clampAt[k] - 1.0) + 0.9;
    label({ target: tip(k), at: [edgeAt[k][0], edgeAt[k][1]], text: verdict[k].text, on: () => win(a, E('edgeRes') - 0.2, 0.4, 0.3) });
  }

  // loop sizes (KONZEPT's cable table) and diameters: a panel on the right
  const panelOn = () => Math.max(win(S('edgeRes') + 5.0, E('edgeRes'), 0.4, 0.4), win(S('edge2') + 0.2, E('edge2'), 0.4, 0.4));
  const crossOn = () => win(S('edge2') + 0.2, E('edge2'), 0.4, 0.4);
  const loopPanel = new Node({ opacity: panelOn });
  {
    const px = R - 470, py = TOP + 70;
    loopPanel.add(<Rect x={px} y={py} offset={[-1, -1]} width={450} height={680} radius={28} fill={C.plate} />);
    loopPanel.add(<Txt x={px + 225} y={py + 40} text={'Schlaufe'} fontFamily={FONT} fontWeight={700} fontSize={34} fill={C.text} />);
    const rows: [string, number, number][] = [['Ladekabel', 10, 4], ['XLR', 25, 6.4], ['Starkstrom', 45, 16]];
    const k = 3.4; // px per cm of loop diameter
    let y = py + 90;
    rows.forEach(([name, cm, mm]) => {
      const d = cm * k;
      loopPanel.add(<Circle x={px + 290} y={y + d / 2} size={d} stroke={C.text} lineWidth={4} lineDash={[12, 8]} />);
      loopPanel.add(<Txt x={px + 24} y={y + d / 2 - 22} offset={[-1, 0]} text={name} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />);
      loopPanel.add(<Txt x={px + 24} y={y + d / 2 + 18} offset={[-1, 0]} text={`Ø ${cm} cm`} fontFamily={FONT} fontWeight={600} fontSize={32} fill={C.muted} />);
      // the cable's own cross-section (Doppelt so dick: viel steifer), 4 px per mm
      loopPanel.add(<Circle x={px + 290} y={y + d / 2} size={mm * 4} fill={'#25272c'} opacity={crossOn} />);
      y += d + 34;
    });
  }
  root.add(loopPanel);

  // 1b · the crank: turns, the stripe, the loop
  const knobI = { i0: idx(B.knob, 'i0'), i1: idx(B.knob, 'i1') };
  root.add(
    <Rect x={R - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 22]} radius={40} fill={C.plate} layout opacity={() => win(S('knobIn') + 0.3, E('knobHold'), 0.4, 0.4)}>
      <Txt text={() => `Umdrehungen: ${Math.floor(B.knob.track('turns', t()) + 1e-6)}`} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
    </Rect>,
  );
  label({ target: tNode(() => B.knob, () => Math.round(knobI.i0 + (knobI.i1 - knobI.i0) * 0.72)), at: [R - 420, TOP + 200], text: 'Streifen windet sich', on: () => win(S('knobTurn') + 3.5, S('knobPop') - 0.1, 0.4, 0.3) });
  if (truth.loopPops) label({ target: () => knobLow(t()), at: [L + 520, TOP + 640], text: 'Schlaufe springt heraus', on: () => Math.max(win(E('knobPop'), E('knobRest'), 0.3, 0.3), win(S('knobHold'), E('knobHold'), 0.3, 0.3)) });
  label({ target: () => crankHandle(t()), at: [L + 300, TOP + 160], text: 'Kurbel', on: () => win(S('knobIn') + 0.3, S('knobTurn') + 2.5, 0.4, 0.3) });
  label({ target: () => add3(KNOB.vise, mul3(KNOB.viseOut, 0.03)), at: [R - 300, TOP + 380], text: 'eingespannt', on: () => win(S('knobIn') + 0.3, S('knobTurn') + 2.5, 0.4, 0.3) });

  // 2 · memory: the comparison
  const memI = { old: { i0: idx(B.old, 'i0'), i1: idx(B.old, 'i1') }, neu: { i0: idx(B.neu, 'i0'), i1: idx(B.neu, 'i1') } };
  const offs = (p: V3, dx: number): V3 => [p[0] + dx, p[1], p[2] + 0.06];
  if (truth.oldCurls) label({ target: () => offs(node(B.old, Math.round((memI.old.i0 + memI.old.i1) * 0.5), MEM.duration), CMP_X.old), at: [L + 330, TOP + 110], text: 'alt: in Kringeln', on: () => win(S('memCmp') + 0.4, E('memCmp'), 0.4, 0.3) });
  if (truth.newStraight) label({ target: () => offs(node(B.neu, Math.round((memI.neu.i0 + memI.neu.i1) * 0.5), MEM.duration), CMP_X.neu), at: [R - 330, TOP + 110], text: 'neu: fast gerade', on: () => win(S('memCmp') + 0.4, E('memCmp'), 0.4, 0.3) });
  label({ target: () => node(B.old, Math.round((memI.old.i0 + memI.old.i1) * 0.5), t()), at: [R - 380, TOP + 130], text: 'altes Kabel', on: () => win(S('memIn') + 0.2, E('memOld'), 0.4, 0.3) });
  label({ target: () => node(B.neu, Math.round((memI.neu.i0 + memI.neu.i1) * 0.5), t()), at: [R - 380, TOP + 130], text: 'neues Kabel', on: () => win(S('memNewIn') + 0.1, E('memNew'), 0.3, 0.3) });
  label({ target: () => [0.5, TOPY + 0.01, 0.86], at: [R - 330, TOP + 640], text: 'lag lange aufgerollt', on: () => win(S('memIn') + 0.4, E('memOld'), 0.4, 0.3) });

  // 3 · tension: the twist counter and labels
  const tenI = { i0: idx(B.ten, 'i0'), i1: idx(B.ten, 'i1') };
  root.add(
    <Rect x={R - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 22]} radius={40} fill={C.plate} layout opacity={() => win(S('tenIn') + 0.3, E('tenEnd'), 0.4, 0.4)}>
      <Txt text={() => `Drall im Kabel: ${Math.round(Math.abs(B.ten.track('tw', t())) + Math.abs(cur().beat === 'ten' && t() < TEN.release ? B.ten.track('wr', t()) : 0))}`} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
    </Rect>,
  );
  const tenMid = () => node(B.ten, Math.round((tenI.i0 + tenI.i1) / 2), t());
  if (truth.hiddenTaut) label({ target: tenMid, at: [L + 560, TOP + 140], text: 'gespannt: gerade', on: () => win(S('tenTaut') + 2.2, S('tenSlack') + 1.0, 0.4, 0.3) });
  /** the curl: the node farthest below the line between the hands */
  const tenCurl = (): V3 => {
    const tt = t(), a = node(B.ten, tenI.i0, tt), c = node(B.ten, tenI.i1, tt);
    let best = tenI.i0, d = -1;
    for (let i = tenI.i0; i <= tenI.i1; i += 2) {
      const p = node(B.ten, i, tt);
      const u = clamp01(dot3(sub3(p, a), sub3(c, a)) / Math.max(1e-6, dot3(sub3(c, a), sub3(c, a))));
      const q = mixV(a, c, u);
      const dd = Math.hypot(...sub3(p, q));
      if (dd > d) { d = dd; best = i; }
    }
    return node(B.ten, best, tt);
  };
  if (truth.curlSlack) label({ target: tenCurl, at: [L + 560, TOP + 640], text: 'locker: Kringel', on: () => win(S('tenSlack') + 4.4, E('tenRelIn') - 0.1, 0.4, 0.3) });
  if (truth.twistOut) label({ target: () => node(B.ten, 2, t()), at: [R - 420, TOP + 600], text: 'freies Ende dreht sich', on: () => Math.max(win(S('tenRelRest'), E('tenRelRest'), 0.3, 0.3), win(S('tenEnd'), E('tenEnd'), 0.3, 0.3)) });

  // 4 · the band: morph label, tallies, bars, results, numbers
  label({ target: () => node(B.band.over, Math.round(B.band.over.n * 0.12), 0), at: [L + 420, TOP + 150], text: 'gelbe Seite = Streifen', on: () => win(S('morph') + 3.2, E('morph'), 0.4, 0.3) });
  const clampPos = (side: -1 | 1, k: BandKind) => (): V3 => [side * bandHalfAt(t()), TOPY + BAND.lift + 0.02, BAND.rows[k]];
  label({ target: clampPos(-1, 'over'), at: [-330, TOP + 110], text: 'Enden fest', on: () => win(S('bandsIn') + 1.0, E('pullCap') + 1.0, 0.4, 0.3) });
  label({ target: clampPos(1, 'over'), at: [330, TOP + 110], text: 'Enden fest', on: () => win(S('bandsIn') + 1.0, E('pullCap') + 1.0, 0.4, 0.3) });
  const rowY = (k: BandKind) => () => project(view, [0, TOPY, BAND.rows[k]]).y;
  const bandOn = () => win(S('bandsIn') + 0.6, E('relEnd'), 0.5, 0.4);
  const UNIT = 70; // px per turn
  const lkNow = (k: BandKind) => lkOf(k, t());
  const NUMS: Record<BandKind, string> = { over: '+1 +1 +1 +1 = 4', under: '−1 −1 −1 −1 = −4', alt: '+1 −1 +1 −1 = 0', oouo: '+1 +1 −1 +1 = 2' };
  const numsOn = () => win(S('count') + 0.6, E('relEnd'), 0.4, 0.4);
  BAND_ORDER.forEach((k) => {
    const y = rowY(k);
    const tl = new Rect({ x: L + 24, y: () => y() - 6, offset: [-1, 1], padding: [6, 18], radius: 30, fill: C.plate, layout: true, gap: 12, opacity: bandOn });
    BAND_KINDS[k].forEach((s) => tl.add(new Txt({ text: s > 0 ? 'ü' : 'u', fontFamily: FONT, fontWeight: 800, fontSize: 36, fill: s > 0 ? OVER : UNDER })));
    root.add(tl);
    // the bar: |Lk| long, yellow = the share in the twist, blue = in the loops
    const lk = () => lkNow(k);
    const len = () => Math.abs(lk()) * UNIT;
    const yel = () => len() * clamp01(B.band[k].track('tw', t()) / (Math.abs(lk()) > 0.2 ? lk() : 1));
    const bx = L + 24;
    root.add(new Rect({ x: bx, y: () => y() + 8, offset: [-1, -1], width: 4 * UNIT, height: 26, radius: 6, fill: '#00000014', opacity: bandOn }));
    root.add(new Rect({ x: bx, y: () => y() + 8, offset: [-1, -1], width: () => Math.max(0.001, yel()), height: 26, radius: 6, fill: '#f2c230', opacity: bandOn }));
    root.add(new Rect({ x: () => bx + yel(), y: () => y() + 8, offset: [-1, -1], width: () => Math.max(0.001, len() - yel()), height: 26, radius: 6, fill: OVER, opacity: bandOn }));
    // the numbers at the end, right of the bar
    root.add(new Rect({ x: bx + 4 * UNIT + 16, y: () => y() + 21, offset: [-1, 0], padding: [4, 14], radius: 24, fill: C.plate, layout: true, opacity: numsOn, children: [new Txt({ text: () => (k === 'over' && t() > REL.b + 0.05 && cur().beat === 'band' ? 'losgelassen: 0' : NUMS[k]), fontFamily: FONT, fontWeight: 700, fontSize: 32, fill: C.text })] }));
  });
  // the legend of the bars
  root.add(
    <Rect x={R - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 18]} radius={30} fill={C.plate} layout gap={14} alignItems={'center'} opacity={() => win(S('pull') + 0.6, E('relEnd'), 0.4, 0.4)}>
      <Rect width={30} height={20} radius={5} fill={'#f2c230'} />
      <Txt text={'Verdrillung'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
      <Rect width={30} height={20} radius={5} fill={OVER} marginLeft={14} />
      <Txt text={'Schlingen'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>,
  );
  // what each band does: pulled apart, then pushed together (on the right, at its row)
  const RES_PULL: Record<BandKind, { text: string; ok: boolean }> = {
    over: { text: '4 Drehungen, rechtsgängig', ok: truth.overTaut },
    under: { text: '4 Drehungen, andersherum', ok: truth.underTaut },
    alt: { text: 'glatt', ok: truth.altFlat },
    oouo: { text: '2 Drehungen', ok: truth.oouoTaut },
  };
  const RES_PUSH: Record<BandKind, { text: string; ok: boolean }> = {
    over: { text: 'Schlaufen springen heraus', ok: truth.overLoops },
    under: { text: 'dasselbe, spiegelbildlich', ok: truth.underLoops },
    alt: { text: 'ruhiger Bogen', ok: truth.altCalm },
    oouo: truth.oouoCurl ? { text: 'ein Kringel', ok: true } : { text: 'Drall bleibt als Drehung', ok: true },
  };
  BAND_ORDER.forEach((k) => {
    const y = rowY(k);
    const chip = (text: string, on: () => number) =>
      root.add(new Rect({ x: R - 24, y: () => y() + 8, offset: [1, 0], padding: [6, 18], radius: 30, fill: C.plate, layout: true, opacity: on, children: [new Txt({ text, fontFamily: FONT, fontWeight: 700, fontSize: 32, fill: C.text })] }));
    if (RES_PULL[k].ok) chip(RES_PULL[k].text, () => win(S('pulled') + 0.2, E('pushCap'), 0.4, 0.3));
    if (RES_PUSH[k].ok) chip(RES_PUSH[k].text, () => win(S('pushed') + 0.2, E('count') - 0.4, 0.4, 0.3));
  });
  if (truth.released) label({ target: clampPos(1, 'over'), at: [R - 330, TOP + 160], text: 'Klemme offen: dreht sich frei', on: () => Math.max(win(E('rel') - 0.4, E('relRest'), 0.3, 0.3), win(S('relEnd'), E('relEnd'), 0.3, 0.3)) });

  // 5 · the ring
  root.add(
    <Rect x={R - 24} y={TOP + 24} offset={[1, -1]} padding={[8, 22]} radius={40} fill={C.plate} layout opacity={() => win(S('ringIn') + 0.3, E('ringFlash'), 0.4, 0.4)}>
      <Txt text={() => `Drall dazu: ${ringTurns(t()).toFixed(1).replace('.', ',')} Umdrehungen`} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
    </Rect>,
  );
  const ringI = { i0: idx(B.ring, 'i0'), i1: idx(B.ring, 'i1') };
  /** where the eight crosses itself: the closest pair of ring nodes far apart along it */
  const ringCross = (() => {
    let best = { d: Infinity, p: [0, 0, 0] as V3 };
    for (let i = ringI.i0 + 6; i <= ringI.i1 - 6; i += 2)
      for (let j = i + 30; j <= ringI.i1 - 6; j += 2) {
        const a = node(B.ring, i, RING.duration), c = node(B.ring, j, RING.duration);
        const d = Math.hypot(...sub3(a, c));
        if (d < best.d) best = { d, p: mixV(a, c, 0.5) };
      }
    return best;
  })();
  if (truth.ringEight) label({ target: () => ringCross.p, at: [L + 420, TOP + 560], text: 'Acht', on: () => Math.max(win(E('ringFlip'), E('ringRest'), 0.3, 0.3), win(S('ringEnd'), E('ringFlash'), 0.3, 0.3)) });
  // the flashback inset: stage 5's eight
  const IW = 420, IH = 420;
  const inset = new Node({ opacity: () => win(S('ringFlash') + 0.2, E('ringFlash'), 0.4, 0.4) });
  inset.add(<Rect x={R - 24 - IW / 2} y={TOP + 110 + IH / 2} width={IW + 10} height={IH + 10} radius={26} fill={'#ffffff'} />);
  inset.add(<ThreeView world={eightWorld} camera={eightCam} x={R - 24 - IW / 2} y={TOP + 110 + IH / 2} width={IW} height={IH} radius={22} />);
  inset.add(
    <Rect x={R - 24 - IW / 2} y={TOP + 110 + IH + 30} offset={[0, -1]} padding={[6, 18]} radius={30} fill={C.plate} layout>
      <Txt text={'Stufe 5: die verdrehte Schlaufe'} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
    </Rect>,
  );
  root.add(inset);

  // 6 · the formula, over the über band (pulled ↔ pushed): a bar that keeps its length
  const fOn = () => win(S('formula') + 0.3, E('formulaDna'), 0.5, 0.5);
  const fy = TOP + 300;
  const formula = new Node({ opacity: fOn });
  formula.add(<Rect x={0} y={fy} width={1500} height={500} radius={30} fill={'#fbf9f4ee'} />);
  formula.add(
    <Layout x={0} y={fy - 150} layout direction={'row'} alignItems={'center'} gap={22}>
      <Rect padding={[8, 24]} radius={36} fill={'#f2c230'} layout>
        <Txt text={'Drehung'} fontFamily={FONT} fontWeight={800} fontSize={56} fill={C.text} />
      </Rect>
      <Txt text={'+'} fontFamily={FONT} fontWeight={800} fontSize={56} fill={C.text} />
      <Rect padding={[8, 24]} radius={36} fill={OVER} layout>
        <Txt text={'Schlingen'} fontFamily={FONT} fontWeight={800} fontSize={56} fill={'#fff'} />
      </Rect>
      <Txt text={'= bleibt gleich'} fontFamily={FONT} fontWeight={800} fontSize={56} fill={C.text} />
    </Layout>,
  );
  formula.add(<Txt x={0} y={fy - 70} text={'(bei festgehaltenen Enden)'} fontFamily={FONT} fontWeight={600} fontSize={40} fill={C.muted} />);
  // the band's bar: its split shifts, its length stays
  const fLk = () => lkOf('over', t());
  const fLen = () => Math.abs(fLk()) * 150;
  const fYel = () => fLen() * clamp01(B.band.over.track('tw', t()) / fLk());
  formula.add(<Rect x={-300} y={fy + 10} offset={[-1, -1]} width={() => Math.max(0.001, fYel())} height={40} radius={8} fill={'#f2c230'} />);
  formula.add(<Rect x={() => -300 + fYel()} y={fy + 10} offset={[-1, -1]} width={() => Math.max(0.001, fLen() - fYel())} height={40} radius={8} fill={OVER} />);
  formula.add(<Txt x={0} y={fy + 115} text={'Lk = Tw + Wr'} fontFamily={FONT} fontWeight={700} fontSize={40} fill={C.muted} />);
  formula.add(<Txt x={0} y={fy + 160} text={'Verschlingungszahl = Verdrillung (Twist) + Writhe'} fontFamily={FONT} fontWeight={600} fontSize={32} fill={C.muted} />);
  formula.add(<Txt x={0} y={fy + 200} text={'Satz von Călugăreanu, White und Fuller'} fontFamily={FONT} fontWeight={600} fontSize={32} fill={C.muted} />);
  root.add(formula);

  // 7 · the sums
  const sums = new Node({ opacity: cardOn });
  const sumRow = (y: number, kinds: number[], eq: string, good: boolean, result: string, a: number) => {
    const row = (
      <Layout y={y} layout direction={'row'} alignItems={'center'} gap={30} opacity={() => smooth((tau() - a) / 0.5)}>
        <Rect padding={[8, 22]} radius={40} fill={C.plate} layout gap={14}>
          {kinds.map((s) => (
            <Txt text={s > 0 ? 'ü' : 'u'} fontFamily={FONT} fontWeight={800} fontSize={48} fill={s > 0 ? OVER : UNDER} />
          ))}
        </Rect>
        <Txt text={eq} fontFamily={FONT} fontWeight={700} fontSize={56} fill={C.text} />
        <Rect padding={[8, 22, 8, 12]} radius={40} fill={C.plate} layout gap={12} alignItems={'center'}>
          <Mark good={good} size={46} />
          <Txt text={result} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
        </Rect>
      </Layout>
    );
    sums.add(row);
  };
  sums.add(<Txt y={TOP + 150} text={'Darum über-unter'} fontFamily={FONT} fontWeight={800} fontSize={60} fill={C.text} />);
  sumRow(TOP + 330, [1, 1, 1, 1, 1, 1], '1 + 1 + 1 + 1 + 1 + 1 = 6', false, '6 Drehungen im Kabel', S('sums') + 0.6);
  sumRow(TOP + 520, [1, -1, 1, -1, 1, -1], '1 − 1 + 1 − 1 + 1 − 1 = 0', true, 'Kabel liegt ruhig', S('sums') + 1.6);
  root.add(sums);

  // the finished ring
  root.add(
    <Layout y={TOP + 90} layout direction={'column'} alignItems={'center'} gap={10} opacity={() => win(S('final') + 0.2, LENGTH + 1, 0.5, 0.3)}>
      <Rect padding={[10, 30]} radius={40} fill={C.plate} layout direction={'row'} gap={16} alignItems={'center'}>
        <Txt text={'über,'} fontFamily={FONT} fontWeight={800} fontSize={52} fill={OVER} />
        <Txt text={'unter,'} fontFamily={FONT} fontWeight={800} fontSize={52} fill={UNDER} />
        <Txt text={'über …'} fontFamily={FONT} fontWeight={800} fontSize={52} fill={OVER} />
      </Rect>
    </Layout>,
  );

  // ------------------------------------------------------------------------- captions
  const capNow = () => {
    const s = tau();
    for (const c of CAPS) if (s >= c.a && s <= c.b) return { text: c.text, op: smooth((s - c.a) / CAP_IN) * (1 - smooth((s - (c.b - CAP_OUT)) / CAP_OUT)) };
    return { text: '', op: 0 };
  };
  root.add(<Txt y={CAPTION_Y} text={() => capNow().text} opacity={() => capNow().op} fontFamily={FONT} fontWeight={600} fontSize={46} fill={C.text} />);

  yield* run();

  layer.removeChildren();
  world.dispose();
  eightWorld.dispose();
}

/** where the two memory cables lie for the comparison (x offsets) */
const CMP_X = { old: -0.36, neu: 0.3 };
