// Stage 2 (KONZEPT "2 · Warum", ≈ 1 min): the rough animation (animatic). Teo and Robin, side by side,
// each with a short ring (a 1.5 m patch cable in six loops): Teo's wound the same way every time,
// Robin's over-under.
//
//   1  wide: both hold their rings, "Zwei Ringe – von außen sehen sie gleich aus."; a short look back
//      (split screen, the same camera for both): the rings wound again, Teo's hand never turns (ü ü ü
//      ü ü ü), Robin's every second loop (ü u ü u ü u); back to now: the start end with the ring's top
//      in the left hand, the end in the right fist, locks at the hands: "Enden fest"
//   2  first one loop alone, slow motion: pulled out, it becomes one full turn of the stripe (+360°,
//      the arc and the number are measured), once in real time; then a pair, über then unter:
//      +360°, −360° = 0
//   3  both pull their rings out until the cable is almost taut (hands ≈ 1.25 m apart): the loops leave
//      the left hand one after the other; Teo's stripe winds up like a screw, Robin's goes there and
//      back; counters "Drehungen im Kabel" (the measured twist between the hands)
//   4  both bring the hands 40 cm together: Teo's cable throws a curl and winds round itself, Robin's
//      hangs in a calm arc
//   5  Teo pulls again: the curl closes into a kink (✗, hatched); Teo stops and lets go loosely
//   6  ✓ Robin's cable hangs smooth
//
// Everything with the cable is simulated (shots/p2-why.ts: the rings from the ring factory, the XLR
// preset with the twist stiffness of its stuck strands); the twist numbers on screen are read from
// the bakes. The look back (1) is kinematic: the baked ring at its first frame, laid down loop by
// loop, the rest of the cable from the right hand straight down (placeholder for p2.teo.coil /
// p2.robin.coil). People: IK from simple keys (shots/p2-why.ts whyRig), to be replaced by the
// recordings in MOCAP_SLOTS.

import { Circle, Layout, Line, Node, Rect, Txt } from '@motion-canvas/2d';
import { all, easeInOutCubic, waitFor } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, loadBake, smooth } from '../../sim';
import { DEMO_T, Plan, RING_T, WHY_ID, WhyKind, gripsOf, handsAt0, loopNode, personOf, planFrom, releaseAt, whyRig, whyTrack } from '../../shots/p2-why';
import { Person3D } from '../../people/body3d';
import type { Pose } from '../../people/people';
import { Grip, Rig, RigTrack, gripFrame } from '../../people/rig';
import { Captions, GAP, PANEL_H, PanelTitle, TOP, clock, readTime } from '../../lib/kit';
import { Mark, StageChip } from '../../lib/ui';
import { C, FONT, OVER, UNDER } from '../../lib/theme';
import { CableMesh } from '../../three/cable';
import { ArcArrow } from '../../three/arrows';
import { Orbit, makeCamera, mixOrbit, orbit } from '../../three/camera';
import { callout, project } from '../../three/overlay';
import { Studio } from '../../three/studio';
import { ThreeView, World3D } from '../../three/view';

// ===================================================================================== timing

/**
 * The phases in part time (s). Shot times of the bakes: RING_T (p2-teo / p2-robin), DEMO_T (p2-one,
 * p2-pair).
 */
const PH = (() => {
  const wide = 0, flash = 5.9, now = flash + 7.2, demo1 = now + 3.4;
  // one loop: 0.9 s before the pull, the pull in slow motion, a hold, the pull once more in real time
  const d1Slow = demo1 + 0.9, d1SlowEnd = d1Slow + (DEMO_T.pull1 + 0.15 - DEMO_T.pull0) / 0.25, d1Hold = d1SlowEnd + 1.2;
  const d1Real = d1Hold, d1RealEnd = d1Real + (DEMO_T.pull1 + 0.15 - DEMO_T.pull0);
  const demo2 = d1RealEnd + 1.0;
  const d2Pull = demo2 + 1.6, d2End = d2Pull + (DEMO_T.end - DEMO_T.pull0), d2Hold = d2End + 1.6;
  // the rings: the pull shot from 1 s before its pull to its end
  const ring = d2Hold, ringT0 = RING_T.pull0 - 1.2;
  const end = ring + (RING_T.end - ringT0) + 0.6;
  return { wide, flash, now, demo1, d1Slow, d1SlowEnd, d1Hold, d1Real, d1RealEnd, demo2, d2Pull, d2End, d2Hold, ring, ringT0, end };
})();
const LENGTH = PH.end;
/** the look back: one loop per second after 0.5 s */
const FLASH_LOOP = 1.0, FLASH_LEAD = 0.5;
/** ring shot time at part time s (during the ring phase) */
const ringTime = (s: number) => PH.ringT0 + (s - PH.ring);
/** part time of a ring shot time */
const atRing = (t: number) => PH.ring + (t - PH.ringT0);

/** the captions: text, part time; each stays its reading time (or until the next one) */
const CAPS = {
  two: 'Zwei Ringe – von außen sehen sie gleich aus.',
  one: 'Erst eine Schlaufe: Ausgezogen wird sie zu einer Drehung.',
  pair: 'Dann ein Paar: über und unter.',
  taut: 'Gespannt: Die Drehung steckt unsichtbar im Kabel.',
  slack: 'Locker: Sie springt als Kringel heraus.',
  kink: 'Wieder gezogen: Knick. Das schadet den Adern.',
  calm: 'Abwechselnd gewickelt: Die Drehungen heben sich auf.',
};
const CAP_AT: [keyof typeof CAPS, number][] = [
  ['two', 0.4],
  ['one', PH.demo1 + 0.1],
  ['pair', PH.demo2 + 0.2],
  ['taut', atRing(RING_T.pull1 - 0.4)],
  ['slack', atRing(RING_T.tog0 - 1.0)],
  ['kink', atRing(RING_T.re0 - 1.0)],
  ['calm', atRing(RING_T.loose1 + 0.4)],
];

/**
 * Beats whose movement comes from a Kinect recording (mocap/shots.json, part "p2-why"), in part time.
 * The flashback's winding and the demo cable are placeholders until then.
 */
export const MOCAP_SLOTS = [
  { shot: 'idle.stand', role: 'Teo', from: PH.wide, to: PH.flash, note: 'Teo steht mit dem Ring (Take 1: kurzer Ring vor dem Bauch); Ring oben in der linken Hand, Ende in der rechten' },
  { shot: 'idle.stand', role: 'Robin', from: PH.wide, to: PH.flash, note: 'dasselbe für Robin (anderer Take oder gespiegelt versetzt, damit die beiden nicht synchron atmen)' },
  { shot: 'p2.teo.coil', role: 'Teo', from: PH.flash, to: PH.now, note: 'Rückblick: sechs Über-Schlaufen im Arbeitstempo, Hand nie umgedreht; im Rohschnitt kinematisch, 1 s pro Schlaufe' },
  { shot: 'p2.robin.coil', role: 'Robin', from: PH.flash, to: PH.now, note: 'Rückblick: abwechselnd über und unter; die rechte Hand dreht sich bei jeder Unter-Schlaufe um' },
  { shot: 'idle.stand', role: 'Teo', from: PH.now, to: PH.demo1, note: 'zurück im Jetzt: Ring in der linken Hand, Ende in der rechten, kurz stehen (Schlösser „Enden fest“)' },
  { shot: 'idle.stand', role: 'Robin', from: PH.now, to: PH.demo1, note: 'wie Teo' },
  { shot: 'p2.oneloop', role: 'Teo', from: PH.demo1, to: PH.d1RealEnd, note: 'Take 1: eine Über-Schlaufe langsam ausziehen; gezeigt in Zeitlupe 0,25×, dann einmal in Echtzeit (nur Hände und Unterarme im Bild)' },
  { shot: 'p2.oneloop', role: 'Teo', from: PH.demo2, to: PH.d2Hold, note: 'Take 2: ein Paar (über, dann unter) ausziehen, Echtzeit' },
  { shot: 'p2.teo.pull', role: 'Teo', from: PH.ring, to: PH.end, note: `Rohschnitt-Zeit = Aufnahmezeit ${PH.ringT0.toFixed(1)} s + (Teilzeit − ${PH.ring.toFixed(1)} s); Ansagen 2 / 6 / 9 / 12 / 15 / 17 s der Aufnahme liegen im Rohschnitt bei Schusszeit ${RING_T.pull0} / ${RING_T.pull1} / ${RING_T.tog0} / ${RING_T.tog1 + 1} / ${RING_T.re0} / ${RING_T.loose0} s: zeitlich strecken` },
  { shot: 'p2.robin.pull', role: 'Robin', from: PH.ring, to: PH.end, note: 'gleiche Zeiten wie Teo, ohne Wiederziehen' },
];

// ===================================================================================== layout

const midY = TOP + PANEL_H / 2;
const fullW = 1920 - 2 * GAP;
const wHalf = (1920 - 3 * GAP) / 2;
const xHalf = [-960 + GAP + wHalf / 2, 960 - GAP - wHalf / 2];
const ramp = (x: number, a: number, b: number) => smooth((x - a) / (b - a));

/** where the two stand (world x); both face -z */
const AT: Record<'teo' | 'robin', number> = { teo: -1.3, robin: 1.3 };

// ===================================================================================== small pieces

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => scale3(a, 1 / (len3(a) || 1));
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** a padlock drawn in 2D (body and shackle), dark on a white disc: "the end is held, it cannot turn" */
function Lock(props: { x: () => number; y: () => number; opacity: () => number }) {
  return (
    <Node x={props.x} y={props.y} opacity={props.opacity}>
      <Circle size={46} fill={'#ffffff'} shadowColor={'rgba(0,0,0,0.18)'} shadowBlur={10} />
      <Line points={[[-7, -2], [-7, -9], [-4, -13], [4, -13], [7, -9], [7, -2]]} stroke={C.text} lineWidth={4} lineCap={'round'} lineJoin={'round'} />
      <Rect y={5} width={22} height={16} radius={3} fill={C.text} />
    </Node>
  );
}

/** a counter on a plate: a title and a big number */
function Counter(props: { x: number; y: number; title: string; value: () => string; color?: () => string; opacity: () => number }) {
  return (
    <Rect x={props.x} y={props.y} offset={[1, -1]} padding={[10, 22]} radius={22} fill={C.plate} layout direction={'column'} alignItems={'center'} gap={0} opacity={props.opacity}>
      <Txt text={props.title} fontFamily={FONT} fontWeight={700} fontSize={32} fill={C.text} />
      <Txt text={props.value} fontFamily={FONT} fontWeight={800} fontSize={72} fill={props.color ?? (() => C.text)} />
    </Rect>
  );
}

/**
 * A cable at a list of node positions with the material frames of the bake: CableMesh of the cable
 * proper (the plugs are drawn by the mesh), with a group offset (where the person stands).
 */
function cableOf(b: BakedRod, i0: number, i1: number) {
  const nc = i1 - i0 + 1;
  const pos = new Float32Array(3 * b.n), d1 = new Float32Array(3 * b.n);
  const mesh = new CableMesh({ maxNodes: b.n, radius: b.radius, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.06, haloPx: 6, haloMax: 2 });
  return {
    mesh,
    pos,
    d1,
    nc,
    /** the baked cable at shot time t */
    at(t: number) {
      b.frameSample(t, pos, d1);
      mesh.update(pos.subarray(3 * i0), d1.subarray(3 * i0), nc);
    },
    /** given positions and frames (the look back) */
    set(p: Float32Array, f: Float32Array) {
      mesh.update(p.subarray(3 * i0), f.subarray(3 * i0), nc);
    },
  };
}

/**
 * The look back: the ring of the bake's first frame laid down loop by loop. Nodes up to the winding
 * point w (node index, fractional) lie where they lie in the ring; the rest runs from there to the
 * right hand and hangs straight down from it (on the floor where it reaches it). Frames: the bake's
 * up to w, then carried along (parallel transport), so the stripe runs straight on the free part.
 */
function flashShape(b: BakedRod, w: number, hand: V3, out: Float32Array, outD1: Float32Array) {
  const n = b.n;
  b.frameSample(0, out, outD1);
  const k0 = Math.min(n - 2, Math.max(1, Math.floor(w)));
  const seg = len3(sub3([out[3 * k0 + 3], out[3 * k0 + 4], out[3 * k0 + 5]], [out[3 * k0], out[3 * k0 + 1], out[3 * k0 + 2]])) || 0.005;
  // the free path: to the hand, then down, then along the floor (+x)
  const P0: V3 = [out[3 * k0], out[3 * k0 + 1], out[3 * k0 + 2]];
  const toHand = sub3(hand, P0), lHand = len3(toHand);
  let prevD: V3 = [outD1[3 * k0], outD1[3 * k0 + 1], outD1[3 * k0 + 2]];
  let prevP = P0;
  let prevT = norm3(toHand);
  for (let i = k0 + 1; i < n; i++) {
    const s = (i - k0) * seg;
    let p: V3;
    if (s <= lHand) p = add3(P0, scale3(toHand, s / (lHand || 1)));
    else {
      const down = s - lHand;
      const floorY = 0.004;
      p = hand[1] - down > floorY ? [hand[0], hand[1] - down, hand[2]] : [hand[0] + (down - (hand[1] - floorY)), floorY, hand[2]];
    }
    out.set(p, 3 * i);
    const tng = norm3(sub3(p, prevP));
    // parallel transport of d1 from the previous tangent to this one
    const ax = cross3(prevT, tng), sn = len3(ax), cs = dot3(prevT, tng);
    let d = prevD;
    if (sn > 1e-6) {
      const a = scale3(ax, 1 / sn), ang = Math.atan2(sn, cs);
      d = add3(add3(scale3(d, Math.cos(ang)), scale3(cross3(a, d), Math.sin(ang))), scale3(a, dot3(a, d) * (1 - Math.cos(ang))));
    }
    d = norm3(sub3(d, scale3(tng, dot3(d, tng))));
    outD1.set(d, 3 * i);
    prevD = d;
    prevP = p;
    prevT = tng;
  }
}

// ===================================================================================== the part

export function* part(layer: Node) {
  const bT = (yield loadBake(WHY_ID.teo)) as BakedRod;
  const bR = (yield loadBake(WHY_ID.robin)) as BakedRod;
  const bOne = (yield loadBake(WHY_ID.one)) as BakedRod;
  const bPair = (yield loadBake(WHY_ID.pair)) as BakedRod;
  for (const [k, at] of CAP_AT) {
    const next = CAP_AT.find(([, a]) => a > at)?.[1] ?? LENGTH;
    if (next - at < readTime(CAPS[k]) + 0.6) console.warn(`p2-why: caption "${k}" has ${(next - at).toFixed(1)} s, needs ${readTime(CAPS[k]).toFixed(1)} s`);
  }

  const { tau, run } = clock(LENGTH);
  /** 0 → 1 → 0 between part times a and b */
  const win = (a: number, b: number, fi = 0.35, fo = 0.35) => {
    const s = tau();
    return smooth((s - a) / Math.max(1e-6, fi)) * (1 - smooth((s - (b - fo)) / Math.max(1e-6, fo)));
  };

  // ------------------------------------------------------------------------- the two people (now and the look back)
  type Who = 'teo' | 'robin';
  const WHO: Who[] = ['teo', 'robin'];
  const bake = { teo: bT, robin: bR };
  const plan: Record<Who, Plan> = { teo: planFrom((nm, t) => bT.vector(nm, t)), robin: planFrom((nm, t) => bR.vector(nm, t)) };
  const track: Record<Who, RigTrack> = { teo: whyTrack('teo', plan.teo), robin: whyTrack('robin', plan.robin) };
  const ends = (b: BakedRod): [number, number] => [Math.round(b.track('cable0', 0)), Math.round(b.track('cable1', 0))];

  /** the look back's rig: the left hand holds the ring's top as at the start; the right hand goes round the ring once per loop, for "unter" turned over */
  const flashRig = (who: Who) => {
    const p = plan[who];
    const base = whyRig(who, p);
    const g0 = gripsOf(who, p);
    const pattern = who === 'teo' ? 'oooooo' : 'ououou';
    return (f: number): Rig => {
      const r = base(0);
      const { hand, turn } = flashHand(who, f, pattern);
      const toRing = norm3(sub3(g0.left(0).p, hand));
      // palm down, turned over (palm up) while an "unter" loop is laid
      const palm: V3 = norm3([0, -Math.cos(Math.PI * turn), 0.15 + Math.sin(Math.PI * turn) * 0.2]);
      const right = { grip: gripFrame(hand, toRing, palm) as Grip, hold: 'pinch' as const, radius: 0.0032, free: 0.4 };
      return { ...r, hands: [r.hands[0], right], look: [g0.left(0).p[0] + 0.08, g0.left(0).p[1] - 0.05, g0.left(0).p[2]] };
    };
  };
  /** the right hand in the look back at flashback time f: where it is and how far it is turned (0 … 1) */
  function flashHand(who: Who, f: number, pattern: string): { hand: V3; turn: number; w: number } {
    const p = plan[who], b = bake[who];
    const N = pattern.length;
    const u = Math.max(0, Math.min(N, (f - FLASH_LEAD) / FLASH_LOOP));
    const k = Math.min(N - 1, Math.floor(u)), v = u - k;
    const a = loopNode(p, k), e = loopNode(p, k + 1);
    const w = u >= N ? loopNode(p, N) : a + (e - a) * smooth(v);
    // the ring's middle (its first frame) and where the cable is being laid
    const tmp: V3 = [0, 0, 0];
    let c: V3 = [0, 0, 0];
    for (let i = loopNode(p, 0); i < loopNode(p, N); i++) c = add3(c, b.nodeAt(0, i, tmp));
    c = scale3(c, 1 / (loopNode(p, N) - loopNode(p, 0)));
    const at = b.nodeAt(0, Math.round(w), [0, 0, 0]);
    const radial = norm3([0, at[1] - c[1], at[2] - c[2]]);
    const hand: V3 = add3(add3(at, scale3(radial, 0.06)), [0.07, 0, 0]);
    const turn = pattern[k] === 'u' && u < N ? Math.sin(Math.PI * v) : 0;
    return { hand, turn, w };
  }
  const FLASH_LEN = PH.now - PH.flash;
  const flashTrack: Record<Who, RigTrack> = { teo: new RigTrack(personOf('teo'), flashRig('teo'), 0, 60), robin: new RigTrack(personOf('robin'), flashRig('robin'), 0, 60) };

  const people = {} as Record<Who, { person: Person3D; group: THREE.Group; cable: ReturnType<typeof cableOf>; turnArrow: ArcArrow }>;
  const flashPos = new Float32Array(3 * Math.max(bT.n, bR.n)), flashD1 = new Float32Array(3 * Math.max(bT.n, bR.n));
  for (const who of WHO) {
    const b = bake[who];
    const [i0, i1] = ends(b);
    const g = new THREE.Group();
    g.position.x = AT[who];
    const person = new Person3D(personOf(who), track[who].pose(0));
    const cable = cableOf(b, i0, i1);
    const turnArrow = new ArcArrow({ color: UNDER, thickness: 0.004 });
    g.add(person.group, cable.mesh.group, turnArrow.group);
    people[who] = { person, group: g, cable, turnArrow };
  }

  /** what each phase shows of the ring shots: the pose time and whether the look back is on */
  const nowTime = (): number => {
    const s = tau();
    if (s < PH.flash) return 0.12 * s;
    if (s < PH.ring) return Math.min(PH.ringT0, 0.7 + 0.15 * (s - PH.now));
    return Math.min(RING_T.end, ringTime(s));
  };
  const flashOn = () => tau() >= PH.flash && tau() < PH.now;

  // cameras: the wide shot of both; the split screen: the same camera relative to each person
  const WIDE: Orbit = { target: [0, 0.98, -0.3], yaw: Math.PI + 0.12, pitch: 0.14, dist: 5.2, fov: 32 };
  const one = (who: Who, o: Orbit): Orbit => ({ ...o, target: [o.target[0] + AT[who], o.target[1], o.target[2]] });
  const NEAR: Orbit = { target: [0.02, 1.03, -0.34], yaw: Math.PI + 0.32, pitch: 0.16, dist: 1.05, fov: 34 };
  const SPLIT: Orbit = { target: [0, 0.97, -0.34], yaw: Math.PI + 0.22, pitch: 0.12, dist: 2.35, fov: 34 };
  const camW = makeCamera(32), camT = makeCamera(34), camR = makeCamera(34);
  const oT: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 }, oR: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  /** the split cameras: close on the ring in the look back and at the locks, the whole person for the pull */
  const splitCam = (who: Who, out: Orbit) => {
    const s = tau();
    if (s < PH.ring) return mixOrbit(one(who, NEAR), one(who, NEAR), 0, out);
    return mixOrbit(one(who, NEAR), one(who, SPLIT), easeInOutCubic(ramp(s, PH.ring, PH.ring + 1.2)), out);
  };

  const world = new World3D('p2-why', () => {
    const s = tau();
    const t = nowTime();
    for (const who of WHO) {
      const P = people[who];
      if (flashOn()) {
        const f = s - PH.flash;
        P.person.update(flashTrack[who].pose(f));
        const pattern = who === 'teo' ? 'oooooo' : 'ououou';
        const fh = flashHand(who, f, pattern);
        const pose = flashTrack[who].pose(f);
        const hand = pose.body.arms?.[1].grip?.p ?? fh.hand;
        flashShape(bake[who], fh.w, hand, flashPos, flashD1);
        P.cable.set(flashPos, flashD1);
        // Robin: the arc round the forearm while the hand is turned over
        const on = who === 'robin' ? fh.turn : 0;
        P.turnArrow.group.visible = on > 0.05;
        if (on > 0.05) {
          const wr = pose.joints[10], el = pose.joints[8];
          const ax = norm3(sub3(wr, el));
          P.turnArrow.update({ center: add3(wr, scale3(ax, -0.04)), axis: ax, from: [0, 1, 0], radius: 0.06, angle: Math.PI, progress: on });
        }
      } else {
        P.turnArrow.group.visible = false;
        P.person.update(track[who].pose(t));
        P.cable.at(t);
      }
    }
    orbit(camW, WIDE);
    orbit(camT, splitCam('teo', oT));
    orbit(camR, splitCam('robin', oR));
  });
  new Studio(world.scene, { focus: [0, 0.9, -0.3], focusRadius: 2.4 });
  world.scene.add(people.teo.group, people.robin.group);

  // ------------------------------------------------------------------------- the demo (one loop, a pair)
  const demo = (() => {
    const pOne = planFrom((nm, t) => bOne.vector(nm, t)), pPair = planFrom((nm, t) => bPair.vector(nm, t));
    const trOne = whyTrack('one', pOne), trPair = whyTrack('pair', pPair);
    const person = new Person3D(personOf('one'), trOne.pose(0));
    const cOne = cableOf(bOne, ...ends(bOne)), cPair = cableOf(bPair, ...ends(bPair));
    const arrow = new ArcArrow({ color: OVER, thickness: 0.003 });
    const arrow2 = new ArcArrow({ color: UNDER, thickness: 0.003 });
    const cam = makeCamera(34);
    /** which demo and its shot time at part time s */
    const at = (s: number): { which: 'one' | 'pair'; t: number } => {
      if (s < PH.demo2) {
        if (s < PH.d1Slow) return { which: 'one', t: DEMO_T.pull0 - (PH.d1Slow - s) * 0.3 };
        if (s < PH.d1SlowEnd) return { which: 'one', t: DEMO_T.pull0 + (s - PH.d1Slow) * 0.25 };
        if (s < PH.d1Real) return { which: 'one', t: DEMO_T.pull1 + 0.15 };
        if (s < PH.d1RealEnd) return { which: 'one', t: DEMO_T.pull0 + (s - PH.d1Real) };
        return { which: 'one', t: Math.min(DEMO_T.end, DEMO_T.pull1 + 0.15 + (s - PH.d1RealEnd)) };
      }
      return { which: 'pair', t: Math.max(0, Math.min(DEMO_T.end, DEMO_T.pull0 + (s - PH.d2Pull))) };
    };
    const centre: V3 = [0, 1.13, -0.34];
    const DEMO_CAM: Orbit = { target: [centre[0] + 0.04, centre[1] - 0.05, centre[2]], yaw: Math.PI + 0.18, pitch: 0.2, dist: 1.0, fov: 34 };
    const w = new World3D('p2-why-demo', () => {
      const s = tau();
      const d = at(s);
      const isOne = d.which === 'one';
      person.update((isOne ? trOne : trPair).pose(d.t));
      cOne.mesh.group.visible = isOne;
      cPair.mesh.group.visible = !isOne;
      (isOne ? cOne : cPair).at(d.t);
      // the arc round the cable's middle: one turn per measured turn of twist (blue for the über
      // loop's turn, orange for the unter loop's), drawn as far as the twist has come
      const b = isOne ? bOne : bPair;
      const tw = b.track('tw', d.t);
      const mid: V3 = [0.02, centre[1] + 0.0, centre[2]];
      const g = gripsOf(isOne ? 'one' : 'pair', isOne ? pOne : pPair);
      const m = scale3(add3(g.left(d.t).p, g.right(d.t).p), 0.5);
      mid[0] = m[0];
      mid[1] = m[1];
      mid[2] = m[2];
      const prog = Math.min(1, Math.abs(tw));
      arrow.group.visible = tw > 0.05;
      arrow2.group.visible = tw < -0.05;
      const a = tw > 0 ? arrow : arrow2;
      if (Math.abs(tw) > 0.05) a.update({ center: mid, axis: [Math.sign(tw), 0, 0], from: [0, 1, 0], radius: 0.035, angle: 2 * Math.PI * 0.92, progress: prog });
      orbit(cam, DEMO_CAM);
    });
    new Studio(w.scene, { focus: centre, focusRadius: 1.0 });
    w.scene.add(person.group, cOne.mesh.group, cPair.mesh.group, arrow.group, arrow2.group);
    return { world: w, cam, at, pOne, pPair, centre };
  })();

  // ------------------------------------------------------------------------- the picture
  const isWide = () => tau() < PH.flash;
  const isDemo = () => tau() >= PH.demo1 && tau() < PH.ring;
  const splitOn = () => !isWide() && !isDemo();
  const wideView = (<ThreeView world={world} camera={camW} x={0} y={midY} width={fullW} height={PANEL_H} radius={28} opacity={() => (isWide() ? 1 : 0)} />) as ThreeView;
  const viewT = (<ThreeView world={world} camera={camT} x={xHalf[0]} y={midY} width={wHalf} height={PANEL_H} radius={28} opacity={() => (splitOn() ? 1 : 0)} />) as ThreeView;
  const viewR = (<ThreeView world={world} camera={camR} x={xHalf[1]} y={midY} width={wHalf} height={PANEL_H} radius={28} opacity={() => (splitOn() ? 1 : 0)} />) as ThreeView;
  const demoView = (<ThreeView world={demo.world} camera={demo.cam} x={0} y={midY} width={fullW} height={PANEL_H} radius={28} opacity={() => (isDemo() ? 1 : 0)} />) as ThreeView;
  layer.add([wideView, viewT, viewR, demoView]);
  const viewOf: Record<Who, ThreeView> = { teo: viewT, robin: viewR };
  const xOf: Record<Who, number> = { teo: xHalf[0], robin: xHalf[1] };
  /** a point of a person's world (person-local → world) */
  const W = (who: Who, p: V3): V3 => [p[0] + AT[who], p[1], p[2]];

  // panel titles (the split screen after the look back), the stage chip
  const titlesOn = () => (splitOn() && !flashOn() ? 1 : 0) * win(PH.now, LENGTH + 1, 0.4, 0.1);
  layer.add(<PanelTitle text={'immer gleich gewickelt'} x={-960 + GAP + 24} />);
  layer.add(<PanelTitle text={'abwechselnd gewickelt'} x={960 - GAP - wHalf + 24} />);
  layer.children().slice(-2).forEach((n) => n.opacity(titlesOn));
  const chip = (<StageChip current={2} x={0} y={TOP + PANEL_H + 34} opacity={0} />) as Node;
  layer.add(chip);
  // badges: the look back, slow motion, real time
  const badge = (text: string, visible: () => number, x = 0) =>
    layer.add(
      <Rect x={x} y={TOP + 24} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.text} opacity={visible} layout>
        <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={28} fill={'#fff'} />
      </Rect>,
    );
  badge('Rückblick', () => win(PH.flash + 0.1, PH.now));
  badge('Zeitlupe', () => win(PH.d1Slow - 0.2, PH.d1SlowEnd + 0.2));
  badge('Echtzeit', () => win(PH.d1Real, PH.d1RealEnd + 0.4));

  // the look back: the tallies (ü / u, lit as each loop is laid), top right of each panel
  for (const who of WHO) {
    const pattern = who === 'teo' ? 'oooooo' : 'ououou';
    const box = (<Rect x={xOf[who] + wHalf / 2 - 24} y={TOP + 24} offset={[1, -1]} padding={[10, 22]} radius={40} fill={C.plate} layout gap={14} opacity={() => win(PH.flash + 0.2, PH.now + 2.6)} />) as Rect;
    pattern.split('').forEach((c, k) =>
      box.add(<Txt text={c === 'o' ? 'ü' : 'u'} fontFamily={FONT} fontWeight={800} fontSize={44} fill={c === 'o' ? OVER : UNDER} opacity={() => 0.15 + 0.85 * (tau() >= PH.now ? 1 : ramp(tau() - PH.flash, FLASH_LEAD + (k + 0.4) * FLASH_LOOP, FLASH_LEAD + (k + 0.9) * FLASH_LOOP))} />),
    );
    layer.add(box);
    // a label at the ring: how the hand goes (from the third loop on, while the look back runs)
    const ring = () => W(who, add3(handsAt0(plan[who])[0], [0.05, -0.05, 0]));
    layer.add(
      callout({
        view: viewOf[who],
        target: ring,
        at: () => {
          const p = project(viewOf[who], ring());
          return [p.x + (who === 'teo' ? -10 : 10), p.y + 230] as [number, number];
        },
        text: who === 'teo' ? 'Hand nie umgedreht' : 'Hand jedes zweite Mal umgedreht',
        color: who === 'teo' ? OVER : UNDER,
        opacity: () => win(PH.flash + FLASH_LEAD + 2.2 * FLASH_LOOP, PH.now - 0.2),
      }),
    );
  }

  // now: the locks at both hands, "Enden fest" (in the split screen before the demo, and while the pull starts)
  const lockOn = () => win(PH.now + 0.3, PH.demo1, 0.4, 0.2) + win(PH.ring, atRing(RING_T.pull0 + 0.6), 0.3, 0.3);
  for (const who of WHO) {
    for (const side of [0, 1] as const) {
      const hand = () => W(who, track[who].pose(nowTime()).body.arms?.[side].grip?.p ?? [0, 1, 0]);
      const pr = () => project(viewOf[who], hand());
      layer.add(<Lock x={() => pr().x + (side ? 34 : -34)} y={() => pr().y - 52} opacity={() => (splitOn() ? lockOn() * pr().vis : 0)} />);
    }
    const handR = () => W(who, track[who].pose(nowTime()).body.arms?.[1].grip?.p ?? [0, 1, 0]);
    layer.add(
      callout({
        view: viewOf[who],
        target: handR,
        at: () => {
          const p = project(viewOf[who], handR());
          return [p.x + 40, p.y + 150] as [number, number];
        },
        text: 'Enden fest',
        opacity: () => (splitOn() ? win(PH.now + 0.5, PH.demo1, 0.4, 0.2) : 0),
      }),
    );
  }

  // the demo: the measured twist in degrees; the pair's two pills, then "= 0"
  const twDeg = (b: BakedRod, t: number) => 360 * b.track('tw', t);
  const fmtDeg = (d: number) => `${d >= 0 ? '+' : '−'}${Math.round(Math.abs(d) / 10) * 10}°`;
  const demoT = () => demo.at(tau());
  layer.add(
    <Counter
      x={960 - GAP - 24}
      y={TOP + 24}
      title={'Drehung des Streifens'}
      value={() => fmtDeg(twDeg(demoT().which === 'one' ? bOne : bPair, demoT().t))}
      color={() => {
        const d = twDeg(demoT().which === 'one' ? bOne : bPair, demoT().t);
        return Math.abs(d) < 45 ? C.text : d > 0 ? OVER : UNDER;
      }}
      opacity={() => (isDemo() ? win(PH.demo1 + 0.6, PH.ring, 0.3, 0.3) : 0)}
    />,
  );
  // the pair: which loop is which (before the pull), then what each turned
  const pairLoopAt = (k: number) => () => {
    const b = bPair, p = demo.pPair;
    const a = loopNode(p, k), e = loopNode(p, k + 1);
    return b.nodeAt(demoT().t, Math.round((a + e) / 2), [0, 0, 0]);
  };
  const pairOn = () => (isDemo() && demoT().which === 'pair' ? 1 : 0);
  // (loop 1 is the front one, it leaves first: wound "uo", so the über loop comes out first)
  layer.add(callout({ view: demoView, target: pairLoopAt(1), at: () => { const p = project(demoView, pairLoopAt(1)()); return [p.x + 200, p.y - 170] as [number, number]; }, text: 'über', color: OVER, opacity: () => pairOn() * win(PH.demo2 + 0.3, PH.d2Pull + 0.4) }));
  layer.add(callout({ view: demoView, target: pairLoopAt(0), at: () => { const p = project(demoView, pairLoopAt(0)()); return [p.x - 200, p.y - 170] as [number, number]; }, text: 'unter', color: UNDER, opacity: () => pairOn() * win(PH.demo2 + 0.3, PH.d2Pull + 0.4) }));
  const sum = (<Layout layout direction={'row'} gap={22} alignItems={'center'} x={0} y={TOP + PANEL_H - 90} opacity={() => pairOn() * win(PH.d2Pull + 0.2, PH.d2Hold + 0.3)} />) as Layout;
  const pill = (text: string, color: string, on: () => number) => (
    <Rect padding={[8, 24]} radius={36} fill={color} opacity={on} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={800} fontSize={44} fill={'#fff'} />
    </Rect>
  );
  const relPair = (k: number) => releaseAt(demo.pPair, k);
  const pairT = () => demoT().t;
  sum.add(pill('über +360°', OVER, () => 0.25 + 0.75 * ramp(pairT(), relPair(1) + 0.5, relPair(1) + 0.8)));
  sum.add(pill('unter −360°', UNDER, () => 0.25 + 0.75 * ramp(pairT(), relPair(0) + 0.5, relPair(0) + 0.8)));
  sum.add(
    <Rect padding={[8, 24]} radius={36} fill={C.plate} opacity={() => ramp(pairT(), DEMO_T.pull1, DEMO_T.pull1 + 0.3)} layout>
      <Txt text={'= 0'} fontFamily={FONT} fontWeight={800} fontSize={44} fill={C.text} />
    </Rect>,
  );
  layer.add(sum);

  // the rings: the counters (measured twist between the hands, whole turns)
  const ringOn = () => (tau() >= PH.ring ? win(PH.ring + 0.6, LENGTH + 1, 0.4, 0.1) : 0);
  for (const who of WHO) {
    const b = bake[who];
    layer.add(
      <Counter
        x={xOf[who] + wHalf / 2 - 24}
        y={TOP + 24}
        title={'Drehungen im Kabel'}
        value={() => `${Math.round(Math.abs(b.track('tw', nowTime())))}`}
        opacity={ringOn}
      />,
    );
  }
  // Teo's curl and kink, Robin's calm arc (labels where it happens; measured where the bend is)
  const bendAt = (who: Who) => () => W(who, bake[who].nodeAt(nowTime(), Math.round(bake[who].track('bendNode', nowTime())), [0, 0, 0]));
  const lowAt = (who: Who) => () => {
    const b = bake[who], t = nowTime();
    const [i0, i1] = ends(b);
    return W(who, b.nodeAt(t, Math.round((i0 + i1) / 2), [0, 0, 0]));
  };
  layer.add(
    callout({
      view: viewT,
      target: bendAt('teo'),
      at: () => { const p = project(viewT, bendAt('teo')()); return [p.x - 150, p.y + 120] as [number, number]; },
      text: 'Kringel',
      opacity: () => (tau() >= PH.ring ? win(atRing(RING_T.tog1 + 0.6), atRing(RING_T.re0)) : 0),
    }),
  );
  layer.add(
    callout({
      view: viewR,
      target: lowAt('robin'),
      at: () => { const p = project(viewR, lowAt('robin')()); return [p.x + 60, p.y + 120] as [number, number]; },
      text: 'ruhiger Bogen',
      opacity: () => (tau() >= PH.ring ? win(atRing(RING_T.tog1 + 0.6), atRing(RING_T.re0)) : 0),
    }),
  );
  // the kink: ✗ and a hatched red ring round it (red only with ✗ and hatching)
  const kinkOn = () => (tau() >= PH.ring ? win(atRing(RING_T.re1 + 0.2), LENGTH + 1, 0.3, 0.1) : 0);
  const kinkP = () => project(viewT, bendAt('teo')());
  const hatch = new Node({ x: () => kinkP().x, y: () => kinkP().y, opacity: kinkOn });
  hatch.add(new Circle({ size: 64, stroke: C.bad, lineWidth: 5, lineDash: [10, 7] }));
  for (let k = -2; k <= 2; k++) hatch.add(new Line({ points: [[k * 10 - 14, 22], [k * 10 + 14, -22]], stroke: C.bad, lineWidth: 3, opacity: 0.8, clip: false }));
  layer.add(hatch);
  layer.add(
    <Layout layout direction={'row'} gap={14} alignItems={'center'} x={() => kinkP().x - 190} y={() => kinkP().y + 110} opacity={kinkOn}>
      <Mark good={false} size={54} />
      <Rect padding={[8, 20]} radius={14} fill={'#ffffff'} layout>
        <Txt text={'Knick'} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
      </Rect>
    </Layout>,
  );
  // ✓ Robin's cable hangs smooth
  layer.add(
    <Layout layout direction={'row'} gap={14} alignItems={'center'} x={xHalf[1]} y={TOP + PANEL_H - 80} opacity={() => (tau() >= PH.ring ? win(atRing(RING_T.loose1 + 0.4), LENGTH + 1, 0.4, 0.1) : 0)}>
      <Mark good size={58} />
      <Rect padding={[8, 20]} radius={14} fill={C.plate} layout>
        <Txt text={'hängt glatt'} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
      </Rect>
    </Layout>,
  );

  // ------------------------------------------------------------------------- captions
  const cap = new Captions(layer);
  function* captions() {
    for (let i = 0; i < CAP_AT.length; i++) {
      const [k, at] = CAP_AT[i];
      yield* waitFor(Math.max(0, at - tau()));
      yield* cap.show(CAPS[k]);
      const next = CAP_AT[i + 1]?.[1] ?? LENGTH - 0.6;
      const until = Math.min(next - 0.3, at + Math.max(readTime(CAPS[k]), 0) + (i === CAP_AT.length - 1 ? 2 : 1.2));
      yield* waitFor(Math.max(0, until - tau()));
      yield* cap.hide();
    }
  }

  yield* all(
    run(),
    chip.opacity(1, 0.5),
    captions(),
    (function* () {
      yield* waitFor(LENGTH - 0.5);
      yield* all(...layer.children().map((c) => c.opacity(0, 0.45)));
    })(),
  );

  layer.removeChildren();
  world.dispose();
  demo.world.dispose();
  void FLASH_LEN;
}

/** (the pose type is used by the helpers above through RigTrack) */
export type { Pose, WhyKind };
