// 8-bit sounds, synthesized (WebAudio, no files): jump, coin, hit, smash, star, a new player. Panned
// to where it happens on the wall. Browsers start audio only after a click or key press, unless Chrome
// runs with --autoplay-policy=no-user-gesture-required (kiosk).

export class Sound {
  constructor() {
    this.ac = null;
    this.out = null;
    this.noise = null;
    this.recent = new Map();
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
        const len = Math.round(this.ac.sampleRate * 0.5);
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

  /** at most n sounds of a kind within `window` seconds */
  budget(kind, n, window) {
    const now = this.ac.currentTime;
    const list = (this.recent.get(kind) ?? []).filter((t) => now - t < window);
    this.recent.set(kind, list);
    if (list.length >= n) return false;
    list.push(now);
    return true;
  }

  panner(pan) {
    const p = this.ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.out);
    return p;
  }

  tone(f0, f1, dur, gain, pan, { at = 0, type = 'square' } = {}) {
    const ac = this.ac;
    const t = ac.currentTime + at;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.setValueAtTime(gain, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.panner(pan));
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  hiss(dur, gain, pan, { at = 0, lowpass = 2000 } = {}) {
    const ac = this.ac;
    const t = ac.currentTime + at;
    const s = ac.createBufferSource();
    s.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(lowpass, t);
    f.frequency.exponentialRampToValueAtTime(120, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.panner(pan));
    s.start(t);
    s.stop(t + dur + 0.02);
  }

  /** e: { type, x (m) }, wallW: m */
  play(e, wallW) {
    if (!this.ready) return;
    const pan = (e.x / wallW) * 2 - 1;
    switch (e.type) {
      case 'jump':
        if (this.budget('jump', 3, 0.15)) this.tone(260, 720, 0.16, 0.12, pan);
        break;
      case 'coin':
        if (this.budget('coin', 4, 0.1)) {
          this.tone(988, 988, 0.07, 0.1, pan);
          this.tone(1319, 1319, 0.22, 0.1, pan, { at: 0.07 });
        }
        break;
      case 'clear':
        if (this.budget('clear', 2, 0.1)) this.tone(660 + Math.min(12, e.streak) * 40, 880 + Math.min(12, e.streak) * 50, 0.06, 0.05, pan, { type: 'triangle' });
        break;
      case 'hit':
        if (this.budget('hit', 3, 0.2)) {
          this.tone(220, 55, 0.3, 0.16, pan, { type: 'sawtooth' });
          this.hiss(0.2, 0.25, pan, { lowpass: 1500 });
        }
        break;
      case 'smash':
        if (this.budget('smash', 3, 0.15)) {
          this.hiss(0.35, 0.3, pan, { lowpass: 4000 });
          this.tone(400, 80, 0.25, 0.1, pan);
        }
        break;
      case 'star':
        [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, f, 0.08, 0.09, pan, { at: i * 0.055 }));
        break;
      case 'crown':
        [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, f, 0.1, 0.08, pan, { at: i * 0.08, type: 'triangle' }));
        break;
      case 'crownLost':
        [784, 622, 494].forEach((f, i) => this.tone(f, f, 0.1, 0.06, pan, { at: i * 0.08, type: 'triangle' }));
        break;
      case 'airjump':
        if (this.budget('jump', 3, 0.15)) this.tone(420, 1100, 0.14, 0.11, pan);
        break;
      case 'count':
        this.tone(660, 660, 0.18, 0.14, 0);
        break;
      case 'go':
        this.tone(1320, 1320, 0.4, 0.14, 0);
        this.tone(990, 990, 0.4, 0.08, 0, { type: 'triangle' });
        break;
      case 'goalIn':
        [1047, 1319, 1047, 1319].forEach((f, i) => this.tone(f, f, 0.08, 0.07, pan, { at: i * 0.09, type: 'triangle' }));
        break;
      case 'finish':
        if (this.budget('finish', 3, 0.3)) [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.1, 0.09, pan, { at: i * 0.07 }));
        break;
      case 'die':
        if (this.budget('die', 2, 0.3)) {
          this.tone(600, 150, 0.7, 0.12, pan, { type: 'triangle' });
          this.tone(606, 152, 0.7, 0.06, pan, { type: 'square' });
        }
        break;
      case 'end':
        [784, 784, 784, 1047, 988, 1047, 1319].forEach((f, i) => this.tone(f, f, i === 6 ? 0.5 : 0.12, 0.1, 0, { at: [0, 0.13, 0.26, 0.42, 0.58, 0.71, 0.86][i] }));
        break;
      case 'enter':
        if (this.budget('enter', 2, 0.5)) [392, 523, 659, 784].forEach((f, i) => this.tone(f, f * 1.01, 0.07, 0.06, pan, { at: i * 0.05 }));
        break;
      default:
    }
  }

  stopAll() {
    this.recent.clear();
  }
}
