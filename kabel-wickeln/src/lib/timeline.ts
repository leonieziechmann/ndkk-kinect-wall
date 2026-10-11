// Scene time (what the viewer watches) ↔ shot time (the baked simulation and its choreography),
// with freezes (time stops, e.g. while the camera orbits) and slow motion, so one baked shot can be
// shown with pauses and replays. Pure TypeScript: shots and bake tools may use it too.

export type TimeEvent =
  /** at shot time `at` the shot stands still for `len` seconds of scene time */
  | { kind: 'freeze'; at: number; len: number }
  /** from shot time `at`, `len` seconds of the shot play at `factor` (0.25 = four times slower) */
  | { kind: 'slow'; at: number; len: number; factor: number };

/**
 * Scene time (what the viewer watches) ↔ shot time (the baked simulation and choreography).
 * Events must be sorted by `at` and must not overlap.
 */
export class Timeline {
  public constructor(public readonly events: TimeEvent[]) {}

  /** scene seconds an event takes */
  private span(e: TimeEvent) {
    return e.kind === 'freeze' ? e.len : e.len / e.factor;
  }

  /** shot length an event covers */
  private covers(e: TimeEvent) {
    return e.kind === 'freeze' ? 0 : e.len;
  }

  public shot(tau: number) {
    let scene = 0;
    let shot = 0;
    for (const e of this.events) {
      const gap = e.at - shot;
      if (tau <= scene + gap) return shot + (tau - scene);
      scene += gap;
      shot = e.at;
      const sp = this.span(e);
      if (tau <= scene + sp) return e.kind === 'freeze' ? shot : shot + (tau - scene) * e.factor;
      scene += sp;
      shot += this.covers(e);
    }
    return shot + (tau - scene);
  }

  public scene(t: number) {
    let scene = 0;
    let shot = 0;
    for (const e of this.events) {
      if (t <= e.at) return scene + (t - shot);
      scene += e.at - shot;
      shot = e.at;
      if (e.kind === 'slow' && t <= e.at + e.len) return scene + (t - e.at) / e.factor;
      scene += this.span(e);
      shot += this.covers(e);
    }
    return scene + (t - shot);
  }

  /** where in event i the scene is: 0..1 inside it, -1 outside */
  public phase(tau: number, i: number) {
    const e = this.events[i];
    const u = (tau - this.scene(e.at)) / this.span(e);
    return u >= 0 && u <= 1 ? u : -1;
  }

  /** scene length of a shot of `duration` seconds */
  public length(duration: number) {
    return this.scene(duration);
  }
}

/** 0 → 1 → 1 → 0 within a freeze of `len` scene seconds: swing out, hold, swing back */
export function swing(u: number, out = 0.3, back = 0.3) {
  if (u < 0) return 0;
  const s = (x: number) => x * x * (3 - 2 * x);
  if (u < out) return s(u / out);
  if (u > 1 - back) return s((1 - u) / back);
  return 1;
}

