// Pop sounds, synthesized (WebAudio, no files): a short pitch drop plus a click of noise, panned to
// where the bubble was on the wall. Browsers start audio only after a click or key press, unless
// Chrome runs with --autoplay-policy=no-user-gesture-required (kiosk).

export class Sound {
  constructor() {
    this.ac = null;
    this.out = null;
    this.noise = null;
    this.recent = []; // times of the last sounds: at most a few at once
  }

  /** creates or resumes the audio context; call it from a click or key press */
  unlock() {
    try {
      if (!this.ac) {
        this.ac = new AudioContext();
        this.out = this.ac.createGain();
        this.out.gain.value = 0.5;
        const comp = this.ac.createDynamicsCompressor();
        this.out.connect(comp).connect(this.ac.destination);
        const len = Math.round(this.ac.sampleRate * 0.1);
        this.noise = this.ac.createBuffer(1, len, this.ac.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ac.state === 'suspended') this.ac.resume();
    } catch {
      this.ac = null;
    }
  }

  get ready() {
    return this.ac?.state === 'running';
  }

  setVolume(v) {
    if (this.out) this.out.gain.value = v;
  }

  budget() {
    const now = this.ac.currentTime;
    this.recent = this.recent.filter((t) => now - t < 0.12);
    if (this.recent.length >= 4) return false;
    this.recent.push(now);
    return true;
  }

  /** a blip: frequency f0 falling to f1 over dur seconds */
  blip(f0, f1, dur, gain, pan, at = 0, type = 'sine') {
    const ac = this.ac;
    const t = ac.currentTime + at;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  click(freq, gain, pan) {
    const ac = this.ac;
    const t = ac.currentTime;
    const s = ac.createBufferSource();
    s.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 1.2;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    s.connect(f).connect(g).connect(p).connect(this.out);
    s.start(t);
    s.stop(t + 0.05);
  }

  /** e: an event of the game (type pop/star/wave, x wall m), wallW for the panning */
  play(e, wallW) {
    if (!this.ready) return;
    const pan = Math.max(-1, Math.min(1, (e.x / wallW) * 2 - 1));
    if (e.type === 'pop') {
      if (!this.budget()) return;
      // smaller bubble, higher pop
      const f = 700 * Math.pow(0.12 / Math.max(e.r, 0.03), 0.7) * (0.9 + Math.random() * 0.25);
      const gain = e.quiet ? 0.08 : 0.35;
      this.blip(f * 1.8, f * 0.55, e.kind === 2 ? 0.18 : 0.09, gain, pan);
      this.click(2500 + Math.random() * 1500, gain * 0.8, pan);
    } else if (e.type === 'star') {
      [0, 4, 7, 12].forEach((st, i) => this.blip(880 * 2 ** (st / 12), 880 * 2 ** (st / 12), 0.25, 0.18, pan, i * 0.06, 'triangle'));
    } else if (e.type === 'wave') {
      this.blip(220, 1320, 0.7, 0.2, 0, 0, 'triangle');
    }
  }
}
