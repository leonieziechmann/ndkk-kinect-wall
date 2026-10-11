// The hands while coiling: one number `p` drives everything. p = 2.4 means two loops are done and
// the third is on its way. Per loop: the right hand goes to the floor and takes the cable (turning
// over for an "unter" loop), lifts it up to the fist (turning back), lets go, and the rest falls.

import { HandCoil, HandCoilOpts, Kind, grabPoint, handCoil, rightHandPath } from './coil';
import { clamp, lerp, smooth } from './math';

export interface Coiling {
  coil: HandCoil;
  hand: { x: number; y: number; flip: number; arm: number };
  /** the loop in the making and how far it is (0..1), -1 between loops */
  loop: number;
  phase: 'reach' | 'lift' | 'let go' | 'rest';
}

const REACH = 0.28;
const LIFT = 0.82;

export function coiling(base: Omit<HandCoilOpts, 'done' | 'form' | 'release'>, p: number, rest: { x: number; y: number }, shoulder: { x: number; y: number }): Coiling {
  const loops = base.kinds.length;
  const k = Math.min(loops, Math.floor(p));
  const f = k >= loops ? 0 : p - k;
  const kind: Kind = base.kinds[k] ?? 'over';
  const o: HandCoilOpts = { ...base, done: k, form: 0, release: 0 };
  // where the hand was after the last loop
  const from = k === 0 ? rest : ends(base, k - 1);
  let x = from.x;
  let y = from.y;
  let flip = 0;
  let phase: Coiling['phase'] = 'rest';
  if (k < loops && f > 0) {
    if (f < REACH) {
      phase = 'reach';
      const t = smooth(f / REACH);
      const g = grabPoint(o, k);
      // a little arc on the way down
      x = lerp(from.x, g.x, t) + Math.sin(Math.PI * t) * 60;
      y = lerp(from.y, g.y - 30, t);
      if (kind === 'under') flip = smooth((f - REACH * 0.35) / (REACH * 0.6));
    } else if (f < LIFT) {
      phase = 'lift';
      o.form = clamp((f - REACH) / (LIFT - REACH));
      const h = rightHandPath(o, k, o.form);
      x = h.x;
      y = h.y;
      if (kind === 'under') flip = 1 - smooth(o.form / 0.75);
    } else {
      phase = 'let go';
      o.form = 1;
      o.release = clamp((f - LIFT) / (1 - LIFT));
      const e = ends(base, k);
      x = e.x;
      y = e.y;
    }
  }
  const coil = handCoil(o);
  if (phase === 'reach' && f > REACH * 0.85) {
    // the fist closes on the cable: snap to it
    const g = grabPoint(o, k);
    const t = smooth((f - REACH * 0.85) / (REACH * 0.15));
    y = lerp(y, g.y, t);
  }
  const arm = (Math.atan2(shoulder.y - y, shoulder.x - x) * 180) / Math.PI;
  return { coil, hand: { x, y, flip, arm }, loop: phase === 'rest' ? -1 : k, phase };
}

/** where the right hand puts loop k into the fist */
function ends(base: Omit<HandCoilOpts, 'done' | 'form' | 'release'>, k: number) {
  const h = rightHandPath({ ...base, done: k, form: 1, release: 0 }, k, 1);
  return { x: h.x, y: h.y };
}
