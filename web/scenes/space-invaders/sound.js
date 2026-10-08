// Arcade sounds, synthesized (WebAudio, no files): the four-note march of the formations, lasers,
// explosions, the mothership's wobble. Panned to where it happens on the wall. Browsers start audio
// only after a click or key press, unless Chrome runs with --autoplay-policy=no-user-gesture-required
// (kiosk).

const MARCH = [87.31, 77.78, 73.42, 65.41]; // F2, D#2, D2, C2: the classic descending four notes

export class Sound {
  constructor() {
    this.ac = null;
    this.out = null;
    this.noise = null;
    this.recent = new Map(); // per kind: times of the last sounds (a few at once at most)
    this.ufo = null;
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
        const len = Math.round(this.ac.sampleRate * 1);
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

  /** a tone from f0 to f1 over dur seconds */
  tone(f0, f1, dur, gain, pan, { at = 0, type = 'square', lowpass = 0 } = {}) {
    const ac = this.ac;
    const t = ac.currentTime + at;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o.connect(g);
    if (lowpass) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      node = node.connect(f);
    }
    node.connect(this.panner(pan));
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** filtered noise: an explosion */
  noiseBurst(freq, dur, gain, pan, type = 'bandpass', at = 0) {
    const ac = this.ac;
    const t = ac.currentTime + at;
    const s = ac.createBufferSource();
    s.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + dur);
    f.Q.value = 0.9;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.panner(pan));
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }

  ufoOn(on) {
    const ac = this.ac;
    if (on && !this.ufo) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 520;
      const lfo = ac.createOscillator();
      lfo.frequency.value = 7;
      const depth = ac.createGain();
      depth.gain.value = 140;
      lfo.connect(depth).connect(o.frequency);
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1400;
      const g = ac.createGain();
      g.gain.value = 0.0001;
      g.gain.exponentialRampToValueAtTime(0.06, ac.currentTime + 0.3);
      o.connect(f).connect(g).connect(this.out);
      o.start();
      lfo.start();
      this.ufo = { o, lfo, g };
    } else if (!on && this.ufo) {
      const { o, lfo, g } = this.ufo;
      const t = ac.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.stop(t + 0.2);
      lfo.stop(t + 0.2);
      this.ufo = null;
    }
  }

  /** e: an event of the game ({ type, x } in art px), w: the width of the map for the panning */
  play(e, w) {
    if (!this.ready) return;
    const pan = (e.x / Math.max(1, w)) * 2 - 1;
    switch (e.type) {
      case 'march':
        this.tone(MARCH[e.note], MARCH[e.note] * 0.98, 0.14, 0.35, 0, { lowpass: 600 });
        break;
      case 'laser':
        if (this.budget('laser', 3, 0.1)) this.tone(1500, 380, 0.09, 0.05, pan);
        break;
      case 'kill': {
        if (!this.budget('kill', 4, 0.12)) break;
        // kills in quick succession climb a scale: the longer the streak, the higher
        const up = 2 ** (Math.min(e.combo ?? 0, 12) / 12);
        this.noiseBurst(1400 * up, 0.25, 0.45, pan);
        this.tone(520 * up, 70 * up, 0.2, 0.09, pan);
        if (e.combo >= 2) this.tone(880 * up, 880 * up, 0.08, 0.05, pan, { type: 'triangle', at: 0.03 });
        break;
      }
      case 'warp':
        if (this.budget('warp', 3, 0.08)) this.tone(400 + Math.random() * 400, 1600, 0.07, 0.04, pan, { type: 'triangle' });
        break;
      case 'dive':
        this.tone(1400, 160, 0.7, 0.07, pan, { type: 'sawtooth', lowpass: 2500 });
        this.noiseBurst(2500, 0.6, 0.12, pan);
        break;
      case 'fall':
        this.tone(440, 40, 2.5, 0.25, 0, { type: 'sawtooth', lowpass: 1200 });
        this.tone(220, 30, 3, 0.3, 0, { type: 'square', lowpass: 400 });
        this.noiseBurst(300, 2.5, 0.8, 0, 'lowpass');
        break;
      case 'rebuild':
        [0, 3, 7, 10, 12, 15].forEach((st, i) => this.tone(220 * 2 ** (st / 12), 220 * 2 ** (st / 12), 0.25, 0.1, 0, { at: i * 0.12, type: 'triangle' }));
        break;
      case 'shield':
        if (this.budget('shield', 3, 0.08)) this.tone(2600, 2000, 0.06, 0.06, pan, { type: 'triangle' });
        break;
      case 'shieldBreak':
        this.noiseBurst(5000, 0.3, 0.3, pan, 'highpass');
        [0, 0.03, 0.06].forEach((at) => this.tone(3000 - at * 8000, 1500, 0.08, 0.06, pan, { type: 'triangle', at }));
        break;
      case 'bombThrow':
        this.tone(300, 900, 0.3, 0.05, pan, { type: 'triangle' });
        break;
      case 'bombLand':
        this.tone(200, 120, 0.08, 0.12, pan, { type: 'square', lowpass: 800 });
        break;
      case 'bombBeep':
        if (this.budget('bombBeep', 4, 0.06)) this.tone(1800, 1800, 0.04, 0.06, pan, { type: 'square', lowpass: 4000 });
        break;
      case 'bomb':
        this.noiseBurst(600, 0.7, 0.8, pan, 'lowpass');
        this.tone(120, 30, 0.6, 0.35, pan, { type: 'sine' });
        break;
      case 'shipEnter':
        this.tone(55, 110, 1.6, 0.3, pan, { type: 'sawtooth', lowpass: 500 });
        this.tone(82, 164, 1.6, 0.2, pan, { type: 'sawtooth', lowpass: 500 });
        break;
      case 'charge':
        this.tone(120, 1600, 1.5, 0.12, pan, { type: 'sawtooth', lowpass: 3000 });
        this.tone(60, 800, 1.5, 0.12, pan, { type: 'square', lowpass: 1500 });
        break;
      case 'beam':
        this.beamOn(e.on, pan);
        break;
      case 'shipHit':
        this.tone(900, 60, 1.2, 0.3, pan, { type: 'sawtooth', lowpass: 2000 });
        break;
      case 'shipKill':
        this.noiseBurst(1200, 2.2, 1, pan, 'lowpass');
        this.tone(200, 20, 2, 0.5, pan, { type: 'sine' });
        [0, 0.1, 0.2, 0.3, 0.45].forEach((at, i) => this.tone(800 + i * 200, 1600 + i * 300, 0.25, 0.1, 0, { type: 'triangle', at: 0.6 + at }));
        break;
      case 'item':
        [1568, 1175, 1568].forEach((f, i) => this.tone(f, f, 0.1, 0.08, pan, { type: 'triangle', at: i * 0.07 }));
        break;
      case 'pickup': {
        const base = { repair: 392, rapid: 523, spread: 587, shield: 440, nova: 330, mega: 494, slow: 349 }[e.power] ?? 440;
        [0, 4, 7, 12, 16].forEach((st, i) => this.tone(base * 2 ** (st / 12), base * 2 ** (st / 12), 0.14, 0.12, pan, { type: 'square', lowpass: 3500, at: i * 0.05 }));
        if (e.power === 'nova') this.noiseBurst(800, 0.8, 0.7, pan, 'lowpass');
        break;
      }
      case 'edgeCharge':
        this.tone(200, 1400, 1.2, 0.05, pan, { type: 'sawtooth', lowpass: 2500 });
        break;
      case 'edgeFire':
        this.noiseBurst(2500, 0.75, 0.45, pan);
        this.tone(140, 70, 0.75, 0.25, pan, { type: 'sawtooth', lowpass: 900 });
        break;
      case 'boost':
        [0, 7, 12, 19, 24].forEach((st, i) => this.tone(220 * 2 ** (st / 12), 220 * 2 ** (st / 12) * 1.02, 0.3, 0.12, pan, { type: 'sawtooth', lowpass: 4000, at: i * 0.035 }));
        this.tone(80, 400, 0.5, 0.3, pan, { type: 'sine' });
        this.noiseBurst(3000, 0.4, 0.3, pan);
        break;
      case 'boostEnd':
        this.tone(660, 220, 0.4, 0.1, pan, { type: 'triangle' });
        break;
      case 'boostReady':
        [988, 1319].forEach((f, i) => this.tone(f, f, 0.12, 0.08, pan, { type: 'triangle', at: i * 0.08 }));
        break;
      case 'ping':
        if (this.budget('ping', 3, 0.08)) this.tone(1800, 1500, 0.05, 0.07, pan, { type: 'triangle' });
        break;
      case 'stomp':
        this.tone(140, 30, 0.5, 0.5, pan, { type: 'sine' });
        this.noiseBurst(400, 0.5, 0.6, pan, 'lowpass');
        break;
      case 'fortify':
        this.tone(330, 330, 0.06, 0.07, pan, { type: 'triangle' });
        this.tone(495, 495, 0.08, 0.07, pan, { type: 'triangle', at: 0.06 });
        break;
      case 'link':
        this.tone(600, 1800, 0.18, 0.06, pan, { type: 'sawtooth', lowpass: 3000 });
        break;
      case 'zap':
        if (this.budget('zap', 3, 0.1)) this.tone(2400, 300, 0.12, 0.08, pan, { type: 'sawtooth', lowpass: 4000 });
        break;
      case 'block':
        if (this.budget('block', 3, 0.1)) this.tone(2400, 1200, 0.05, 0.06, pan, { type: 'triangle' });
        break;
      case 'hit':
        this.noiseBurst(500, 0.45, 0.7, pan, 'lowpass');
        this.tone(180, 40, 0.4, 0.15, pan, { type: 'triangle' });
        break;
      case 'city':
        if (this.budget('city', 3, 0.1)) this.noiseBurst(700, 0.12, 0.25, pan);
        break;
      case 'crash':
        if (this.budget('crash', 3, 0.15)) this.noiseBurst(300, 0.6, 0.6, pan, 'lowpass');
        break;
      case 'storm':
        this.tone(330, 55, 1.2, 0.18, pan, { type: 'sawtooth', lowpass: 900 });
        break;
      case 'ufo':
        this.ufoOn(e.on);
        break;
      case 'ufoKill':
        [0, 0.08, 0.16, 0.24].forEach((at, i) => this.tone(1200 - i * 180, 300, 0.12, 0.12, pan, { at }));
        this.noiseBurst(2000, 0.6, 0.5, pan);
        break;
      case 'clear':
        [0, 4, 7, 12, 16].forEach((st, i) => this.tone(523 * 2 ** (st / 12), 523 * 2 ** (st / 12), 0.22, 0.12, 0, { at: i * 0.08, type: 'triangle' }));
        break;
      case 'firework':
        if (this.budget('firework', 2, 0.2)) this.noiseBurst(3000, 0.35, 0.2, pan);
        break;
      case 'enter':
        this.tone(110, 440, 0.8, 0.1, 0, { type: 'sawtooth', lowpass: 1200 });
        break;
    }
  }

  /** the battleship's laser: a roaring noise and a deep tone while it fires */
  beamOn(on, pan = 0) {
    const ac = this.ac;
    if (on && !this.beam) {
      const n = ac.createBufferSource();
      n.buffer = this.noise;
      n.loop = true;
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1800;
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 55;
      const g = ac.createGain();
      g.gain.value = 0.0001;
      g.gain.exponentialRampToValueAtTime(0.5, ac.currentTime + 0.05);
      const pn = this.panner(pan);
      n.connect(f).connect(g);
      o.connect(g);
      g.connect(pn);
      n.start();
      o.start();
      this.beam = { n, o, g };
    } else if (!on && this.beam) {
      const { n, o, g } = this.beam;
      const t = ac.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      n.stop(t + 0.3);
      o.stop(t + 0.3);
      this.beam = null;
    }
  }

  stopAll() {
    if (this.ac && this.ufo) this.ufoOn(false);
    if (this.ac && this.beam) this.beamOn(false);
  }
}
