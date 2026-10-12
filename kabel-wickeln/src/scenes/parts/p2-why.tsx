// Stage 2 (KONZEPT "2 · Warum", ≈ 1 min): the rough animation (animatic). Teo and Robin, side by side,
// each with a short ring (a 1.56 m patch cable in six loops): Teo's wound the same way every time,
// Robin's over-under.
//
//   1  wide: both hold their rings, "Zwei Ringe – von außen sehen sie gleich aus."; a short look back
//      (split screen, the same camera for both): the rings wound again, Teo's hand never turns (ü ü ü
//      ü ü ü), Robin's every second loop (ü u ü u ü u); back to now: the ring's top and the start end
//      in the left hand, the end in the right fist, locks at the hands: "Enden fest"
//   2  first one über loop alone, slow motion: pulled out, it becomes a full turn of the stripe (the
//      arc and the number are measured); then an unter loop in real time: the other way; then a pair,
//      über and unter: together 0
//   3  both pull their rings out until the cable is almost taut (hands 1.25 m apart): Teo's stripe
//      winds up like a screw, Robin's does not; counters "Drehungen im Kabel" (the measured twist
//      between the hands)
//   4  both bring the hands 40 cm together: Teo's cable throws a curl and winds round itself, Robin's
//      hangs in a calm arc
//   5  Teo pulls again: the curl closes into a kink (✗, hatched); Teo stops and lets go loosely
//   6  ✓ Robin's cable hangs smooth
//
// Everything with the cable is simulated (shots/p2-why.ts: the rings from the ring factory, pulled
// apart as the factory's own twist check does, the XLR preset; from the taut hold on the twist
// stiffness of the stuck strands); the numbers on screen are read from the bakes. The look back (1)
// is kinematic: the ring of the bake's first frame laid down loop by loop, the rest of the cable from
// the right hand straight down (placeholder for p2.teo.coil / p2.robin.coil). People: IK from simple
// keys (shots/p2-why.ts whyRig), to be replaced by the recordings listed in MOCAP_SLOTS.

import { Circle, Layout, Line, Node, Rect, Txt } from '@motion-canvas/2d';
import { all, easeInOutCubic, waitFor } from '@motion-canvas/core';
import * as THREE from 'three';
import { BakedRod, V3, loadBake, smooth } from '../../sim';
import { DEMO_T, Plan, RING_T, WHY_ID, WhyKind, loopNode, personOf, planFrom, whyRig, whyTrack } from '../../shots/p2-why';
import { Person3D } from '../../people/body3d';
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

/** the look back: one loop per FLASH_LOOP seconds after FLASH_LEAD */
const FLASH_LOOP = 1.0, FLASH_LEAD = 0.5;

/** The phases in part time (s). Shot times of the bakes: RING_T (p2-teo, p2-robin), DEMO_T (p2-one, p2-under, p2-pair). */
const PH = (() => {
  const wide = 0, flash = 5.9, now = flash + FLASH_LEAD + 6 * FLASH_LOOP + 0.7, demo1 = now + 3.4;
  // one über loop: 0.9 s before the pull, the pull in slow motion (0.25×), a hold
  const d1Slow = demo1 + 0.9, d1SlowEnd = d1Slow + (DEMO_T.pull1 + 0.2 - DEMO_T.pull0) / 0.25, d1End = d1SlowEnd + 1.0;
  // one unter loop, real time
  const dU = d1End, dUPull = dU + 0.8, dUEnd = dUPull + (DEMO_T.end - DEMO_T.pull0) + 0.6;
  // the pair, real time
  const d2 = dUEnd, d2Pull = d2 + 1.2, d2End = d2Pull + (DEMO_T.end - DEMO_T.pull0), d2Hold = d2End + 1.8;
  // the rings: the pull shot from just before the end comes out of the ring
  const ring = d2Hold, ringT0 = 0.2;
  const end = ring + (RING_T.end - ringT0) + 0.4;
  return { wide, flash, now, demo1, d1Slow, d1SlowEnd, d1End, dU, dUPull, dUEnd, d2, d2Pull, d2End, d2Hold, ring, ringT0, end };
})();
const LENGTH = PH.end;
/** ring shot time at part time s (during the ring phase) and back */
const ringTime = (s: number) => PH.ringT0 + (s - PH.ring);
const atRing = (t: number) => PH.ring + (t - PH.ringT0);

/** the captions and when they come (part time); each stays its reading time or until the next */
const CAPS = {
  two: 'Zwei Ringe – von außen sehen sie gleich aus.',
  one: 'Erst eine Schlaufe: Ausgezogen wird sie zu einer Drehung.',
  under: 'Eine Unter-Schlaufe dreht andersherum.',
  pair: 'Ein Paar über und unter: zusammen null.',
  taut: 'Gespannt: Die Drehung steckt unsichtbar im Kabel.',
  slack: 'Locker: Sie springt als Kringel heraus.',
  kink: 'Wieder gezogen: Knick. Das schadet den Adern.',
  calm: 'Abwechselnd gewickelt: Die Drehungen heben sich auf.',
};
const CAP_AT: [keyof typeof CAPS, number][] = [
  ['two', 0.4],
  ['one', PH.demo1 + 0.1],
  ['under', PH.dU - 0.2],
  ['pair', PH.d2 + 0.1],
  ['taut', atRing(RING_T.pull1 - 0.2)],
  ['slack', atRing(RING_T.tog0 - 1.0)],
  ['kink', atRing(RING_T.re0 - 1.0)],
  ['calm', atRing(RING_T.loose1 + 1.0)],
];

/**
 * Beats whose movement comes from a Kinect recording (mocap/shots.json, part "p2-why"), in part time.
 * Shot ids from shots.json; idle.stand is a shot of part "idle" (standing between the handlings).
 */
export const MOCAP_SLOTS = [
  { shot: 'idle.stand', role: 'Teo', from: PH.wide, to: PH.flash, note: 'Take 1 (kurzer Ring vor dem Bauch): Ring oben in der linken Hand mit dem Anfang, Ende in der rechten Faust, stehen' },
  { shot: 'idle.stand', role: 'Robin', from: PH.wide, to: PH.flash, note: 'dasselbe, anderer Take oder versetzt, damit beide nicht gleich atmen' },
  { shot: 'p2.teo.coil', role: 'Teo', from: PH.flash, to: PH.now, note: 'Rückblick: sechs Über-Schlaufen, Hand nie umgedreht; im Rohschnitt kinematisch, 1 s pro Schlaufe (Aufnahme im Arbeitstempo auf ~7 s straffen)' },
  { shot: 'p2.robin.coil', role: 'Robin', from: PH.flash, to: PH.now, note: 'Rückblick: abwechselnd über und unter; die rechte Hand dreht sich bei jeder Unter-Schlaufe um' },
  { shot: 'idle.stand', role: 'Teo', from: PH.now, to: PH.demo1, note: 'zurück im Jetzt, kurz stehen (Schlösser „Enden fest“)' },
  { shot: 'idle.stand', role: 'Robin', from: PH.now, to: PH.demo1, note: 'wie Teo' },
  { shot: 'p2.oneloop', role: 'Teo', from: PH.demo1, to: PH.d1End, note: 'Take 1: eine Über-Schlaufe langsam ausziehen; gezeigt in Zeitlupe 0,25× (Nahaufnahme Hände)' },
  { shot: 'p2.oneloop', role: 'Teo', from: PH.dU, to: PH.dUEnd, note: 'eine Unter-Schlaufe, Echtzeit: kein eigener Shot in shots.json (Take 1 gespiegelt/umgelegt oder ein dritter Take von p2.oneloop)' },
  { shot: 'p2.oneloop', role: 'Teo', from: PH.d2, to: PH.d2Hold, note: 'Take 2: ein Paar (über, dann unter) ausziehen, Echtzeit' },
  { shot: 'p2.teo.pull', role: 'Teo', from: PH.ring, to: PH.end, note: `Schusszeit = ${PH.ringT0} s + (Teilzeit − ${PH.ring.toFixed(1)} s); Ansagen der Aufnahme 2/6/9/12/15/17 s liegen im Rohschnitt bei ${RING_T.pull0}/${RING_T.pull1}/${RING_T.tog0}/${RING_T.tog1 + 1}/${RING_T.re0}/${RING_T.loose0} s: zeitlich strecken` },
  { shot: 'p2.robin.pull', role: 'Robin', from: PH.ring, to: PH.end, note: 'gleiche Zeiten wie Teo, ohne Wiederziehen' },
];

// ===================================================================================== layout

const midY = TOP + PANEL_H / 2;
const fullW = 1920 - 2 * GAP;
const wHalf = (1920 - 3 * GAP) / 2;
const xHalf = [-960 + GAP + wHalf / 2, 960 - GAP - wHalf / 2];
const ramp = (x: number, a: number, b: number) => smooth((x - a) / (b - a));

/** where the two stand (world x); both face -z, the cameras look at their fronts: Teo on the left of the picture */
const AT: Record<'teo' | 'robin', number> = { teo: 1.3, robin: -1.3 };

// ===================================================================================== small pieces

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => scale3(a, 1 / (len3(a) || 1));
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** a padlock drawn in 2D (body and shackle), dark on a white disc: the end is held, it cannot turn */
function Lock(props: { x: () => number; y: () => number; opacity: () => number }) {
  return (
    <Node x={props.x} y={props.y} opacity={props.opacity}>
      <Circle size={50} fill={'#ffffff'} shadowColor={'rgba(0,0,0,0.18)'} shadowBlur={10} />
      <Line points={[[-7, -2], [-7, -9], [-4, -13], [4, -13], [7, -9], [7, -2]]} stroke={C.text} lineWidth={4} lineCap={'round'} lineJoin={'round'} />
      <Rect y={5} width={22} height={16} radius={3} fill={C.text} />
    </Node>
  );
}

/** a counter on a plate, top right of a panel: a title and a big number */
function Counter(props: { x: number; y: number; title: string | string[]; value: () => string; color?: () => string; opacity: () => number }) {
  const lines = typeof props.title === 'string' ? [props.title] : props.title;
  return (
    <Rect x={props.x} y={props.y} offset={[1, -1]} padding={[10, 24]} radius={22} fill={C.plate} layout direction={'column'} alignItems={'center'} opacity={props.opacity}>
      {lines.map((l) => (
        <Txt text={l} fontFamily={FONT} fontWeight={700} fontSize={32} lineHeight={38} fill={C.text} />
      ))}
      <Txt text={props.value} fontFamily={FONT} fontWeight={800} fontSize={72} fill={props.color ?? (() => C.text)} />
    </Rect>
  );
}

/** a baked cable (the cable proper; the plugs are drawn by the mesh) */
function cableOf(b: BakedRod) {
  const i0 = Math.round(b.track('cable0', 0)), i1 = Math.round(b.track('cable1', 0));
  const nc = i1 - i0 + 1;
  const pos = new Float32Array(3 * b.n), d1 = new Float32Array(3 * b.n);
  const mesh = new CableMesh({ maxNodes: b.n, radius: b.radius, plugStart: 'xlr-male', plugEnd: 'xlr-female', stripeWidth: 0.045, haloPx: 6, haloMax: 2 });
  return {
    mesh,
    i0,
    i1,
    /** the baked cable at shot time t */
    at(t: number) {
      b.frameSample(t, pos, d1);
      mesh.update(pos.subarray(3 * i0), d1.subarray(3 * i0), nc);
    },
    /** given node positions and stripe directions (the look back) */
    set(p: Float32Array, f: Float32Array) {
      mesh.update(p.subarray(3 * i0), f.subarray(3 * i0), nc);
    },
  };
}

/**
 * The look back: the ring of the bake's first frame laid down loop by loop. Nodes up to the winding
 * point w (node index) lie where they lie in the ring; the rest runs from there to the right hand and
 * hangs straight down from it (on the floor where it reaches it). Stripe: the bake's up to w, then
 * carried along (parallel transport), so it runs straight on the free part.
 */
function flashShape(b: BakedRod, w: number, hand: V3, out: Float32Array, outD1: Float32Array) {
  const n = b.n;
  b.frameSample(0, out, outD1);
  const k0 = Math.min(n - 2, Math.max(1, Math.floor(w)));
  const seg = len3(sub3([out[3 * k0 + 3], out[3 * k0 + 4], out[3 * k0 + 5]], [out[3 * k0], out[3 * k0 + 1], out[3 * k0 + 2]])) || 0.005;
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
      const down = s - lHand, floorY = 0.004;
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
  const bUnder = (yield loadBake(WHY_ID.under)) as BakedRod;
  const bPair = (yield loadBake(WHY_ID.pair)) as BakedRod;
  for (let i = 0; i < CAP_AT.length; i++) {
    const [k, at] = CAP_AT[i];
    const next = CAP_AT[i + 1]?.[1] ?? LENGTH;
    if (next - at < readTime(CAPS[k]) + 0.6) console.warn(`p2-why: caption "${k}" has ${(next - at).toFixed(1)} s, needs ${readTime(CAPS[k]).toFixed(1)} s + fades`);
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
  const bake: Record<Who, BakedRod> = { teo: bT, robin: bR };
  const PATTERN: Record<Who, string> = { teo: 'oooooo', robin: 'ououou' };
  const plan: Record<Who, Plan> = { teo: planFrom((nm, t) => bT.vector(nm, t)), robin: planFrom((nm, t) => bR.vector(nm, t)) };
  const track: Record<Who, RigTrack> = { teo: whyTrack('teo', plan.teo), robin: whyTrack('robin', plan.robin) };

  /** the ring's middle in the bake's first frame */
  const ringMid = (who: Who): V3 => {
    const b = bake[who], p = plan[who], tmp: V3 = [0, 0, 0];
    let c: V3 = [0, 0, 0];
    const a = loopNode(p, 0), e = loopNode(p, 6);
    for (let i = a; i < e; i++) c = add3(c, b.nodeAt(0, i, tmp));
    return scale3(c, 1 / (e - a));
  };
  const MID: Record<Who, V3> = { teo: ringMid('teo'), robin: ringMid('robin') };
  /** the right hand in the look back at flashback time f: where it lays the cable, how far it is turned over (0 … 1), the winding point (node) */
  const flashHand = (who: Who, f: number) => {
    const p = plan[who], b = bake[who], pattern = PATTERN[who];
    const N = pattern.length;
    const u = Math.max(0, Math.min(N, (f - FLASH_LEAD) / FLASH_LOOP));
    const k = Math.min(N - 1, Math.floor(u)), v = u - k;
    const a = loopNode(p, k), e = loopNode(p, k + 1);
    const w = u >= N ? loopNode(p, N) : a + (e - a) * smooth(v);
    const at = b.nodeAt(0, Math.round(w), [0, 0, 0]);
    const c = MID[who];
    const radial = norm3([at[0] - c[0], at[1] - c[1], 0]);
    const hand: V3 = add3(add3(at, scale3(radial, 0.07)), [0, 0, -0.06]);
    const turn = pattern[k] === 'u' && u < N ? Math.sin(Math.PI * v) : 0;
    return { hand, turn, w };
  };
  /** the look back's rig: the left hand as at the start, the right hand goes round the ring once per loop, turned over for "unter" */
  const flashRig = (who: Who) => {
    const base = whyRig(who, plan[who]);
    return (f: number): Rig => {
      const r = base(0);
      const { hand, turn } = flashHand(who, f);
      const toRing = norm3(sub3(MID[who], hand));
      const palm: V3 = norm3([0, -Math.cos(Math.PI * turn), 0.25 + 0.3 * Math.sin(Math.PI * turn)]);
      const right = { grip: gripFrame(hand, toRing, palm) as Grip, hold: 'pinch' as const, radius: 0.0032, free: 0.5 };
      return { ...r, hands: [r.hands[0], right], look: MID[who] };
    };
  };
  const flashTrack: Record<Who, RigTrack> = { teo: new RigTrack(personOf('teo'), flashRig('teo'), 0, 60), robin: new RigTrack(personOf('robin'), flashRig('robin'), 0, 60) };

  const people = {} as Record<Who, { person: Person3D; group: THREE.Group; cable: ReturnType<typeof cableOf>; turnArrow: ArcArrow }>;
  const flashPos = new Float32Array(3 * Math.max(bT.n, bR.n)), flashD1 = new Float32Array(3 * Math.max(bT.n, bR.n));
  for (const who of WHO) {
    const g = new THREE.Group();
    g.position.x = AT[who];
    const person = new Person3D(personOf(who), track[who].pose(0));
    const cable = cableOf(bake[who]);
    const turnArrow = new ArcArrow({ color: UNDER, thickness: 0.004 });
    g.add(person.group, cable.mesh.group, turnArrow.group);
    people[who] = { person, group: g, cable, turnArrow };
  }

  /** the ring shots' time on screen: almost still before the pull phase, then real time */
  const nowTime = (): number => {
    const s = tau();
    if (s < PH.ring) return Math.min(0.12, 0.012 * s);
    return Math.min(RING_T.end, ringTime(s));
  };
  const flashOn = () => tau() >= PH.flash && tau() < PH.now;

  // cameras: the wide shot of both; the split screen: the same camera relative to each person
  const WIDE: Orbit = { target: [0, 1.08, -0.25], yaw: Math.PI + 0.06, pitch: 0.1, dist: 2.7, fov: 32 };
  const one = (who: Who, o: Orbit): Orbit => ({ ...o, target: [o.target[0] + AT[who], o.target[1], o.target[2]] });
  const NEAR: Orbit = { target: [0.0, 1.08, -0.28], yaw: Math.PI + 0.25, pitch: 0.18, dist: 0.95, fov: 34 };
  const SPLIT: Orbit = { target: [0.0, 1.0, -0.26], yaw: Math.PI + 0.2, pitch: 0.1, dist: 2.45, fov: 34 };
  const camW = makeCamera(32), camT = makeCamera(34), camR = makeCamera(34);
  const oT: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 }, oR: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, dist: 1 };
  /** the cable's middle (between the holds) at ring shot time t, person-local */
  const cableMid = (who: Who, t: number): V3 => {
    const b = bake[who];
    return b.nodeAt(t, Math.round((b.track('nodeA', 0) + b.track('nodeB', 0)) / 2), [0, 0, 0]);
  };
  // the stripe close-up while the cable is held taut (the screw), and closer once it is slack (the curl, the kink)
  // (the same camera for both, relative to each person: Teo's cable middle; Robin is about as tall)
  const mT = cableMid('teo', 9), mS = cableMid('teo', 16);
  const MACRO: Orbit = { target: mT, yaw: Math.PI + 0.2, pitch: 0.1, dist: 0.55, fov: 34 };
  const CLOSE: Orbit = { target: [mS[0], mS[1] + 0.06, mS[2]], yaw: Math.PI + 0.2, pitch: 0.12, dist: 1.7, fov: 34 };
  const splitCam = (who: Who, out: Orbit) => {
    const s = tau();
    mixOrbit(one(who, NEAR), one(who, SPLIT), easeInOutCubic(ramp(s, PH.ring + 0.6, PH.ring + 2.4)), out);
    const uM = easeInOutCubic(ramp(s, atRing(RING_T.pull1 + 0.3), atRing(RING_T.pull1 + 1.5))) * (1 - easeInOutCubic(ramp(s, atRing(RING_T.tog0 - 1.4), atRing(RING_T.tog0 - 0.2))));
    if (uM > 0) mixOrbit(out, one(who, MACRO), uM, out);
    const uC = easeInOutCubic(ramp(s, atRing(RING_T.tog1 + 0.2), atRing(RING_T.tog1 + 1.3)));
    if (uC > 0) mixOrbit(out, one(who, CLOSE), uC, out);
    return out;
  };

  const world = new World3D('p2-why', () => {
    const s = tau();
    const t = nowTime();
    for (const who of WHO) {
      const P = people[who];
      if (flashOn()) {
        const f = s - PH.flash;
        const pose = flashTrack[who].pose(f);
        P.person.update(pose);
        const fh = flashHand(who, f);
        flashShape(bake[who], fh.w, pose.body.arms?.[1].grip?.p ?? fh.hand, flashPos, flashD1);
        P.cable.set(flashPos, flashD1);
        // Robin: the arc round the forearm while the hand is turned over
        const on = fh.turn;
        P.turnArrow.group.visible = on > 0.05;
        if (on > 0.05) {
          const wr = pose.joints[10], el = pose.joints[8];
          const ax = norm3(sub3(wr, el));
          P.turnArrow.update({ center: add3(wr, scale3(ax, -0.05)), axis: ax, from: [0, 1, 0], radius: 0.06, angle: Math.PI, progress: on });
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

  // ------------------------------------------------------------------------- the demos (one über loop, one unter loop, a pair)
  type Demo = 'one' | 'under' | 'pair';
  const demoBake: Record<Demo, BakedRod> = { one: bOne, under: bUnder, pair: bPair };
  const demo = (() => {
    const plans = { one: planFrom((nm, t) => bOne.vector(nm, t)), under: planFrom((nm, t) => bUnder.vector(nm, t)), pair: planFrom((nm, t) => bPair.vector(nm, t)) };
    const tracks = { one: whyTrack('one', plans.one), under: whyTrack('under', plans.under), pair: whyTrack('pair', plans.pair) };
    const person = new Person3D(personOf('one'), tracks.one.pose(0));
    const cables = { one: cableOf(bOne), under: cableOf(bUnder), pair: cableOf(bPair) };
    const cam = makeCamera(34);
    /** which demo and its shot time at part time s */
    const at = (s: number): { which: Demo; t: number } => {
      if (s < PH.dU) {
        if (s < PH.d1Slow) return { which: 'one', t: Math.max(0, DEMO_T.pull0 - (PH.d1Slow - s) * 0.4) };
        if (s < PH.d1SlowEnd) return { which: 'one', t: DEMO_T.pull0 + (s - PH.d1Slow) * 0.25 };
        return { which: 'one', t: Math.min(DEMO_T.end, DEMO_T.pull1 + 0.2 + (s - PH.d1SlowEnd) * 0.4) };
      }
      if (s < PH.d2) return { which: 'under', t: Math.max(0, Math.min(DEMO_T.end, DEMO_T.pull0 + (s - PH.dUPull))) };
      return { which: 'pair', t: Math.max(0, Math.min(DEMO_T.end, DEMO_T.pull0 + (s - PH.d2Pull))) };
    };
    const centre: V3 = [0, 1.166, -0.26];
    const DEMO_CAM: Orbit = { target: [centre[0] - 0.02, centre[1] - 0.04, centre[2]], yaw: Math.PI + 0.16, pitch: 0.22, dist: 0.85, fov: 34 };
    const w = new World3D('p2-why-demo', () => {
      const d = at(tau());
      person.update(tracks[d.which].pose(d.t));
      for (const k of ['one', 'under', 'pair'] as Demo[]) cables[k].mesh.group.visible = k === d.which;
      cables[d.which].at(d.t);
      orbit(cam, DEMO_CAM);
    });
    new Studio(w.scene, { focus: centre, focusRadius: 1.0 });
    w.scene.add(person.group, cables.one.mesh.group, cables.under.mesh.group, cables.pair.mesh.group);
    return { world: w, cam, at, plans };
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
  const t1 = (<PanelTitle text={'immer gleich gewickelt'} x={-960 + GAP + 24} />) as Node;
  const t2 = (<PanelTitle text={'abwechselnd gewickelt'} x={960 - GAP - wHalf + 24} />) as Node;
  t1.opacity(titlesOn);
  t2.opacity(titlesOn);
  layer.add([t1, t2]);
  const chip = (<StageChip current={2} x={0} y={TOP + PANEL_H + 34} opacity={0} />) as Node;
  layer.add(chip);
  // badges: the look back, slow motion
  const badge = (text: string, visible: () => number, x = 0) =>
    layer.add(
      <Rect x={x} y={TOP + 24} offset={[0, -1]} padding={[8, 20]} radius={30} fill={C.text} opacity={visible} layout>
        <Txt text={text} fontFamily={FONT} fontWeight={700} fontSize={28} fill={'#fff'} />
      </Rect>,
    );
  badge('Rückblick', () => win(PH.flash + 0.1, PH.now));
  badge('Zeitlupe', () => win(PH.d1Slow - 0.2, PH.d1SlowEnd + 0.2));

  // the look back: the tallies (ü / u, lit as each loop is laid), top right of each panel, and how the hand goes
  for (const who of WHO) {
    // (the outer top corners: the panel titles come only after the look back; the badge is in the middle)
    const box = (<Rect x={who === 'teo' ? xOf[who] - wHalf / 2 + 24 : xOf[who] + wHalf / 2 - 24} y={TOP + 24} offset={who === 'teo' ? [-1, -1] : [1, -1]} padding={[10, 22]} radius={40} fill={C.plate} layout gap={14} opacity={() => win(PH.flash + 0.2, PH.now + 0.2)} />) as Rect;
    PATTERN[who].split('').forEach((c, k) =>
      box.add(<Txt text={c === 'o' ? 'ü' : 'u'} fontFamily={FONT} fontWeight={800} fontSize={44} fill={c === 'o' ? OVER : UNDER} opacity={() => 0.15 + 0.85 * (tau() >= PH.now ? 1 : ramp(tau() - PH.flash, FLASH_LEAD + (k + 0.4) * FLASH_LOOP, FLASH_LEAD + (k + 0.9) * FLASH_LOOP))} />),
    );
    layer.add(box);
    const ring = () => W(who, MID[who]);
    layer.add(
      callout({
        view: viewOf[who],
        target: ring,
        at: () => {
          const p = project(viewOf[who], ring());
          return [xOf[who], TOP + PANEL_H - 70 + 0 * p.y] as [number, number];
        },
        text: who === 'teo' ? 'Hand nie umgedreht' : 'Hand jedes 2. Mal umgedreht',
        color: who === 'teo' ? OVER : UNDER,
        opacity: () => (flashOn() ? win(PH.flash + FLASH_LEAD + 1.6 * FLASH_LOOP, PH.now - 0.1) : 0),
      }),
    );
  }

  // now: the locks at both hands, "Enden fest" (in the split screen before the demos, and while the pull starts)
  const lockOn = () => win(PH.now + 0.3, PH.demo1, 0.4, 0.2) + win(PH.ring, atRing(RING_T.pull0 + 0.8), 0.3, 0.3);
  for (const who of WHO) {
    for (const side of [0, 1] as const) {
      const hand = () => W(who, track[who].pose(nowTime()).body.arms?.[side].grip?.p ?? [0, 1, 0]);
      const pr = () => project(viewOf[who], hand());
      layer.add(<Lock x={() => pr().x + (side ? 46 : -46)} y={() => pr().y - 60} opacity={() => (splitOn() ? lockOn() * pr().vis : 0)} />);
    }
    const handR = () => W(who, track[who].pose(nowTime()).body.arms?.[1].grip?.p ?? [0, 1, 0]);
    layer.add(
      callout({
        view: viewOf[who],
        target: handR,
        at: () => {
          const p = project(viewOf[who], handR());
          return [p.x + 30, Math.min(TOP + PANEL_H - 60, p.y + 190)] as [number, number];
        },
        text: 'Enden fest',
        opacity: () => (splitOn() ? win(PH.now + 0.5, PH.demo1, 0.4, 0.2) : 0),
      }),
    );
  }

  // the demos: the measured turn of the stripe in degrees (live), the loop's kind, the pair's sum
  const fmtDeg = (d: number) => `${d >= 0 ? '+' : '−'}${Math.round(Math.abs(d) / 10) * 10}°`;
  const demoNow = () => demo.at(tau());
  const demoTw = () => {
    const d = demoNow();
    return demoBake[d.which].track('tw', d.t);
  };
  layer.add(
    <Counter
      x={960 - GAP - 24}
      y={TOP + 24}
      title={'Drehung des Streifens'}
      value={() => fmtDeg(360 * demoTw())}
      color={() => (Math.abs(demoTw()) < 0.15 ? C.text : demoTw() > 0 ? OVER : UNDER)}
      opacity={() => (isDemo() ? win(PH.demo1 + 0.6, PH.ring, 0.3, 0.3) : 0)}
    />,
  );
  // the turn round the cable's middle, drawn as a ring seen a little from the side: as far as the
  // measured twist has come (blue: an über loop's turn, orange: an unter loop's)
  const demoMid = () => {
    const d = demoNow(), b = demoBake[d.which];
    return project(demoView, b.nodeAt(d.t, Math.round((b.track('nodeA', 0) + b.track('nodeB', 0)) / 2), [0, 0, 0]));
  };
  const turnCol = () => (demoTw() >= 0 ? OVER : UNDER);
  const turnEnd = () => -90 + Math.sign(demoTw()) * 330 * Math.min(1, Math.abs(demoTw()));
  layer.add(
    <Node x={() => demoMid().x} y={() => demoMid().y} opacity={() => (isDemo() ? ramp(Math.abs(demoTw()), 0.06, 0.16) * win(PH.demo1, PH.ring, 0.1, 0.3) : 0)}>
      <Circle width={70} height={160} startAngle={-90} endAngle={turnEnd} counterclockwise={() => demoTw() < 0} lineWidth={15} stroke={'rgba(255,255,255,0.85)'} lineCap={'round'} />
      <Circle width={70} height={160} startAngle={-90} endAngle={turnEnd} counterclockwise={() => demoTw() < 0} lineWidth={8} stroke={turnCol} lineCap={'round'} endArrow arrowSize={18} />
    </Node>,
  );
  // which loop it is (at the loop, before and while it is pulled out)
  const loopAt = (which: Demo, k: number) => () => {
    const b = demoBake[which], p = demo.plans[which];
    return b.nodeAt(demoNow().t, Math.round((loopNode(p, k) + loopNode(p, k + 1)) / 2), [0, 0, 0]);
  };
  const tag = (which: Demo, k: number, text: string, color: string, a: number, b: number, dx: number) =>
    layer.add(
      callout({
        view: demoView,
        target: loopAt(which, k),
        at: () => {
          const p = project(demoView, loopAt(which, k)());
          return [p.x + dx, p.y - 190] as [number, number];
        },
        text,
        color,
        opacity: () => (isDemo() && demoNow().which === which ? win(a, b) : 0),
      }),
    );
  tag('one', 0, 'Über-Schlaufe', OVER, PH.demo1 + 0.3, PH.d1Slow + 0.6, 160);
  tag('under', 0, 'Unter-Schlaufe', UNDER, PH.dU + 0.1, PH.dUPull + 0.3, 160);
  tag('pair', 0, 'über', OVER, PH.d2 + 0.2, PH.d2Pull + 0.3, -180);
  tag('pair', 1, 'unter', UNDER, PH.d2 + 0.2, PH.d2Pull + 0.3, 180);
  // the sum: über +360° (measured, the first demo), unter −360° (measured, the second), the pair (measured)
  const endTw = (b: BakedRod) => b.track('tw', DEMO_T.end);
  const sum = (<Layout layout direction={'row'} gap={22} alignItems={'center'} x={0} y={TOP + PANEL_H - 90} opacity={() => (isDemo() ? win(PH.d2End - 0.4, PH.ring + 0.3) : 0)} />) as Layout;
  const pill = (text: string, color: string, fg = '#fff') => (
    <Rect padding={[8, 24]} radius={36} fill={color} layout>
      <Txt text={text} fontFamily={FONT} fontWeight={800} fontSize={44} fill={fg} />
    </Rect>
  );
  sum.add(pill(`über ${fmtDeg(360 * endTw(bOne))}`, OVER));
  sum.add(pill(`unter ${fmtDeg(360 * endTw(bUnder))}`, UNDER));
  const pairDeg = 360 * endTw(bPair);
  sum.add(pill(`Paar ${Math.abs(pairDeg) < 20 ? '≈ 0°' : fmtDeg(pairDeg)}`, C.plate, C.text));
  layer.add(sum);

  // the rings: the counters (measured twist between the hands, whole turns)
  const ringOn = () => (tau() >= PH.ring ? win(PH.ring + 0.6, LENGTH + 1, 0.4, 0.1) : 0);
  for (const who of WHO) {
    const b = bake[who];
    layer.add(<Counter x={xOf[who] + wHalf / 2 - 24} y={TOP + 24} title={['Drehungen', 'im Kabel']} value={() => `${Math.round(Math.abs(b.track('tw', nowTime())))}`} opacity={ringOn} />);
  }
  // Teo's curl and kink, Robin's calm arc (labels where it happens; the bend is measured)
  const bendAt = (who: Who) => () => W(who, bake[who].nodeAt(nowTime(), Math.round(bake[who].track('bendNode', nowTime())), [0, 0, 0]));
  const midAt = (who: Who) => () => {
    const b = bake[who], t = nowTime(), p = people[who].cable;
    return W(who, b.nodeAt(t, Math.round((p.i0 + p.i1) / 2), [0, 0, 0]));
  };
  layer.add(
    callout({
      view: viewT,
      target: bendAt('teo'),
      at: () => {
        const p = project(viewT, bendAt('teo')());
        return [Math.max(xHalf[0] - wHalf / 2 + 110, Math.min(xHalf[0] + wHalf / 2 - 110, p.x + 60)), Math.min(TOP + PANEL_H - 60, p.y + 170)] as [number, number];
      },
      text: 'Kringel',
      opacity: () => (tau() >= PH.ring ? win(atRing(RING_T.tog1 + 0.4), atRing(RING_T.re0)) : 0),
    }),
  );
  layer.add(
    callout({
      view: viewR,
      target: midAt('robin'),
      at: () => {
        const p = project(viewR, midAt('robin')());
        return [p.x + 40, Math.min(TOP + PANEL_H - 60, p.y + 130)] as [number, number];
      },
      text: 'ruhiger Bogen',
      opacity: () => (tau() >= PH.ring ? win(atRing(RING_T.tog1 + 0.4), atRing(RING_T.re0)) : 0),
    }),
  );
  // the kink: ✗ and a hatched red ring round it (red only with ✗ and hatching)
  const kinkOn = () => (tau() >= PH.ring ? win(atRing(RING_T.re1 + 0.3), LENGTH + 1, 0.3, 0.1) : 0);
  const kinkP = () => project(viewT, bendAt('teo')());
  const hatch = new Node({ x: () => kinkP().x, y: () => kinkP().y, opacity: kinkOn });
  hatch.add(new Circle({ size: 70, stroke: C.bad, lineWidth: 5, lineDash: [10, 7] }));
  for (let k = -2; k <= 2; k++) hatch.add(new Line({ points: [[k * 11 - 14, 22], [k * 11 + 14, -22]], stroke: C.bad, lineWidth: 3, opacity: 0.85 }));
  layer.add(hatch);
  layer.add(
    <Layout layout direction={'row'} gap={14} alignItems={'center'} x={() => kinkP().x - 180} y={() => Math.min(TOP + PANEL_H - 60, kinkP().y + 120)} opacity={kinkOn}>
      <Mark good={false} size={54} />
      <Rect padding={[8, 20]} radius={14} fill={'#ffffff'} layout>
        <Txt text={'Knick'} fontFamily={FONT} fontWeight={700} fontSize={36} fill={C.text} />
      </Rect>
    </Layout>,
  );
  // ✓ Robin's cable hangs smooth
  layer.add(
    <Layout layout direction={'row'} gap={14} alignItems={'center'} x={xHalf[1]} y={TOP + PANEL_H - 80} opacity={() => (tau() >= PH.ring ? win(atRing(RING_T.loose1 + 1.0), LENGTH + 1, 0.4, 0.1) : 0)}>
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
      const next = CAP_AT[i + 1]?.[1] ?? LENGTH - 0.2;
      const until = Math.min(next - 0.3, at + readTime(CAPS[k]) + 1.2);
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
}

/** the kinds of shots this part plays (for tests) */
export type { WhyKind };
