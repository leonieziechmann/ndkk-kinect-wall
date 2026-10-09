// Screen effects that the game triggers and the renderer (render.js) shows: lights on the floor,
// distortion ripples, flashes, color fringes (chroma), shake and slow motion. Positions in art px of
// the map, sizes in meters (the renderer converts). Everything decays in real time, also during
// slow motion.

export class FX {
  constructor() {
    this.reset();
  }

  reset() {
    this.lights = []; // { x, y, r (m), i, col, t0, life }
    this.ripples = []; // { x, y, amp (LED px), speed (m/s), t0, life }
    this.flashCol = [1, 1, 1];
    this.flashAmt = 0;
    this.chroma = 0;
    this.shake = 0;
    this.slowUntil = 0;
    this.slowScale = 1;
    this.pulse = 0; // the march beat: the hex grid pulses
    this.time = 0;
  }

  /** a light that fades out over `life` s */
  light(x, y, r, i, col, life = 0.3) {
    if (this.lights.length > 160) this.lights.shift();
    this.lights.push({ x, y, r, i, col, t0: this.time, life });
  }

  ripple(x, y, amp, speed = 4, life = 0.6) {
    if (this.ripples.length >= 8) this.ripples.shift();
    this.ripples.push({ x, y, amp, speed, t0: this.time, life });
  }

  flash(col, amt) {
    if (amt >= this.flashAmt) this.flashCol = col;
    this.flashAmt = Math.max(this.flashAmt, amt);
  }

  kick(shake, chroma = 0) {
    this.shake = Math.max(this.shake, shake);
    this.chroma = Math.max(this.chroma, chroma);
  }

  /** slow motion: game time runs at `scale` until `secs` from now */
  slow(secs, scale = 0.3) {
    this.slowUntil = Math.max(this.slowUntil, this.time + secs);
    this.slowScale = Math.min(this.slowScale < 1 && this.time < this.slowUntil ? this.slowScale : 1, scale);
  }

  /** the factor for the game's dt (eases back to 1) */
  get timeScale() {
    if (this.time >= this.slowUntil) return 1;
    const left = this.slowUntil - this.time;
    return left < 0.15 ? this.slowScale + (1 - this.slowScale) * (1 - left / 0.15) : this.slowScale;
  }

  step(dt) {
    this.time += dt;
    const t = this.time;
    this.lights = this.lights.filter((l) => t - l.t0 < l.life);
    this.ripples = this.ripples.filter((r) => t - r.t0 < r.life);
    this.flashAmt *= Math.exp(-dt * 12);
    this.chroma *= Math.exp(-dt * 6);
    this.shake = Math.max(0, this.shake - dt * 10);
    this.pulse *= Math.exp(-dt * 7);
    if (t >= this.slowUntil) this.slowScale = 1;
  }
}
