// The Jam page's own sound: a drone generated from the key and the current
// chord, and a quiet kit to keep time. Everything here is scheduled from the
// Jam page's clock (widgets/jam-room.js), which calls tick() a little ahead
// of time, like any Web Audio sequencer.
//
// The drone has four layers:
//   * the bed: four voices (root, fifth, octave, and the chord's third when
//     the voicing asks for it), each three slightly detuned oscillators,
//     through one low-pass filter that two slow LFOs keep moving. When the
//     chord changes the voices glide to the new notes rather than jumping.
//   * the pedal: a sine an octave under the key's root that never moves, so
//     the key is always there under every chord.
//   * blooms: now and then a high note of the chord, or the mode's color note,
//     swells in and fades away at a random place in the stereo field. Color
//     sets how often. In the Glass texture they're struck like bells.
//   * plucks, for the Tanpura texture: the classic Pa–Sa–Sa–Sa cycle (the
//     fifth, the root twice, the low root) in free time, each pluck bright and
//     buzzing at first and darkening as it rings.

import { audio, noise, midiToHz, clamp } from './core.js';
import { makeImpulse } from './fx.js';
import { pc } from './theory.js';

export const TEXTURES = {
  warm: { name: 'Warm', wave: 'triangle', detune: 7, gain: 1, bright: 1, blurb: 'Soft triangle waves. A hum under everything.' },
  bowed: { name: 'Bowed', wave: 'sawtooth', detune: 11, gain: 0.55, bright: 0.8, blurb: 'Saw waves with breath in them, like a slow bow on low strings.' },
  tanpura: { name: 'Tanpura', wave: 'sawtooth', detune: 5, gain: 0.25, bright: 0.7, blurb: 'A plucked, buzzing cycle on the root and fifth, over a quiet bed.' },
  glass: { name: 'Glass', wave: 'sine', detune: 3, gain: 1.15, bright: 1.6, blurb: 'Pure sines, with chord tones struck high like bells.' },
};
export const TEXTURE_IDS = Object.keys(TEXTURES);

export const VOICINGS = {
  root: { name: 'Root' },
  fifth: { name: 'Open fifth' },
  chord: { name: 'Full chord' },
};
export const VOICING_IDS = Object.keys(VOICINGS);

const OSCS = 3;
const VOICES = 4;
const pick = (arr, r = Math.random()) => arr[Math.floor(r * arr.length) % arr.length];

export class DroneEngine {
  constructor() {
    const { ctx, master } = audio();
    this.ctx = ctx;
    this.s = { texture: 'warm', voicing: 'fifth', level: 60, brightness: 40, movement: 50, color: 40, space: 55 };
    this.running = false;
    this.notes = { key: 0, mode: 'ionian', chord: null, color: 0 };

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(master);
    this.dry = ctx.createGain();
    this.dry.connect(this.out);
    this.send = ctx.createGain();
    this.verb = ctx.createConvolver();
    this.verb.buffer = makeImpulse(ctx, 'hall', 90);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.9;
    this.send.connect(this.verb).connect(this.wet).connect(this.out);

    // The bed.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.9;
    this.bed = ctx.createGain();
    this.filter.connect(this.bed);
    this.bed.connect(this.dry);
    this.bed.connect(this.send);

    // Slow movement. Three LFOs at speeds that never line up: the filter
    // breathes over ~16 s, the pitch drift over ~8 s, the level over ~27 s.
    const lfo = (hz) => { const o = ctx.createOscillator(); o.frequency.value = hz; o.start(); return o; };
    this.lfoFilter = lfo(0.061);
    this.lfoDrift = lfo(0.127);
    this.lfoLevel = lfo(0.037);
    this.filterDepth = ctx.createGain();
    this.lfoFilter.connect(this.filterDepth).connect(this.filter.frequency);
    this.driftUp = ctx.createGain();
    this.driftDown = ctx.createGain();
    this.lfoDrift.connect(this.driftUp);
    this.lfoDrift.connect(this.driftDown);
    this.levelDepth = ctx.createGain();
    this.lfoLevel.connect(this.levelDepth).connect(this.bed.gain);

    this.voices = [];
    for (let v = 0; v < VOICES; v++) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.filter);
      const oscs = [];
      for (let i = 0; i < OSCS; i++) {
        const o = ctx.createOscillator();
        const pan = ctx.createStereoPanner();
        pan.pan.value = [-0.5, 0, 0.5][i] * (v % 2 ? -1 : 1);
        const g = ctx.createGain();
        g.gain.value = 1 / OSCS;
        o.connect(g).connect(pan).connect(gain);
        // Neighbouring oscillators drift in opposite directions.
        ((v + i) % 2 ? this.driftUp : this.driftDown).connect(o.detune);
        o.start();
        oscs.push(o);
      }
      this.voices.push({ gain, oscs, note: 48 });
    }

    // The pedal, under the filter's reach so it stays round.
    this.pedal = ctx.createOscillator();
    this.pedal.type = 'sine';
    this.pedalGain = ctx.createGain();
    this.pedalGain.gain.value = 0.11;
    this.pedal.connect(this.pedalGain).connect(this.dry);
    this.pedal.start();

    // Breath, for the bowed texture: noise through a narrow band near the
    // chord's upper partials.
    this.breathSrc = ctx.createBufferSource();
    this.breathSrc.buffer = noise();
    this.breathSrc.loop = true;
    this.breathBand = ctx.createBiquadFilter();
    this.breathBand.type = 'bandpass';
    this.breathBand.Q.value = 4;
    this.breath = ctx.createGain();
    this.breath.gain.value = 0;
    this.breathSrc.connect(this.breathBand).connect(this.breath).connect(this.filter);
    this.breathSrc.start();

    // Blooms and plucks get their own buses so they can lean wetter.
    this.bloomBus = ctx.createGain();
    this.bloomBus.connect(this.dry);
    this.bloomSend = ctx.createGain();
    this.bloomSend.gain.value = 1;
    this.bloomBus.connect(this.bloomSend).connect(this.send);
    this.pluckBus = ctx.createGain();
    this.pluckBus.gain.value = 0;
    this.pluckBus.connect(this.dry);
    this.pluckBus.connect(this.send);

    this.nextBloom = Infinity;
    this.nextPluck = Infinity;
    this.pluckIndex = 0;
    this.apply(true);
  }

  // Change any of: texture, voicing, level, brightness, movement, color, space.
  set(partial) {
    Object.assign(this.s, partial);
    this.apply();
  }

  apply(immediate = false) {
    const { ctx } = this;
    const t = ctx.currentTime;
    const tc = immediate ? 0.001 : 0.25;
    const s = this.s;
    const tex = TEXTURES[s.texture] || TEXTURES.warm;
    const m = clamp(s.movement, 0, 100) / 100;
    const space = clamp(s.space, 0, 100) / 100;
    for (const v of this.voices) for (const o of v.oscs) if (o.type !== tex.wave) o.type = tex.wave;
    // Wider detune with more movement, from a texture's own starting point.
    const spread = tex.detune * (0.4 + 1.2 * m);
    for (const v of this.voices) v.oscs.forEach((o, i) => o.detune.setTargetAtTime((i - 1) * spread, t, tc));
    const cutoff = 140 * Math.pow(45, clamp(s.brightness, 0, 100) / 100) * tex.bright;
    this.filter.frequency.setTargetAtTime(cutoff, t, tc);
    this.filterDepth.gain.setTargetAtTime(cutoff * 0.65 * m, t, tc);
    const drift = 1 + 14 * m;
    this.driftUp.gain.setTargetAtTime(drift, t, tc);
    this.driftDown.gain.setTargetAtTime(-drift, t, tc);
    this.bed.gain.setTargetAtTime(tex.gain, t, tc);
    this.levelDepth.gain.setTargetAtTime(tex.gain * 0.25 * m, t, tc);
    this.breath.gain.setTargetAtTime(s.texture === 'bowed' ? 0.5 * m : 0, t, tc);
    this.pluckBus.gain.setTargetAtTime(s.texture === 'tanpura' ? 1 : 0, t, tc);
    this.send.gain.setTargetAtTime(space * 0.85, t, tc);
    this.dry.gain.setTargetAtTime(1 - 0.45 * space, t, tc);
    if (this.running) this.out.gain.setTargetAtTime(this._level(), t, 0.3);
    this._voice(immediate);
    if (s.color <= 0) this.nextBloom = Infinity;
    else if (this.running && this.nextBloom === Infinity) this.nextBloom = t + 1 + Math.random() * 2;
    if (s.texture !== 'tanpura') this.nextPluck = Infinity;
    else if (this.running && this.nextPluck === Infinity) this.nextPluck = t + 0.2;
  }

  _level() { return 0.42 * Math.pow(clamp(this.s.level, 0, 100) / 100, 1.5); }

  // The key's root an octave or two down, where a drone sits best.
  _low() {
    const k = pc(this.notes.key);
    return 36 + k - (k > 6 ? 12 : 0);
  }

  // Point the bed at the current chord, gliding there from time `at`.
  setHarmony({ key, mode, chord, color }, immediate = false, at) {
    this.notes = { key, mode, chord, color };
    this._voice(immediate, at);
  }

  _voice(immediate = false, at) {
    const { chord } = this.notes;
    if (!chord) return;
    const t = Math.max(at ?? 0, this.ctx.currentTime);
    const low = this._low();
    let r = low + chord.offset;
    if (chord.offset >= 7) r -= 12;
    const third = chord.intervals[1];
    const fifth = chord.intervals[2];
    const plan = {
      root: [[r, 1], [r + 12, 0.8], [r + 24, 0.25], [r + 7 + 12, 0]],
      fifth: [[r, 1], [r + fifth, 0.85], [r + 12, 0.75], [r + 12 + fifth, 0.3]],
      chord: [[r, 1], [r + fifth, 0.8], [r + 12, 0.6], [r + 12 + third, 0.7]],
    }[this.s.voicing] || [];
    const per = 0.075;
    this.voices.forEach((v, i) => {
      const [note, amt] = plan[i];
      v.note = note;
      const f = midiToHz(note);
      for (const o of v.oscs) {
        if (immediate) o.frequency.setValueAtTime(f, t);
        else o.frequency.setTargetAtTime(f, t, 0.45);
      }
      v.gain.gain.setTargetAtTime(amt * per, t, immediate ? 0.01 : 0.8);
    });
    const pedal = midiToHz(low - 12 >= 24 ? low - 12 : low);
    this.pedal.frequency.setTargetAtTime(pedal, t, immediate ? 0.001 : 0.6);
    this.breathBand.frequency.setTargetAtTime(midiToHz(r + 36), t, 0.5);
  }

  start() {
    const t = this.ctx.currentTime;
    this.running = true;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    // Fade in over a few seconds: nobody should hear a drone begin.
    this.out.gain.setTargetAtTime(this._level(), t, 1.2);
    this.nextBloom = this.s.color > 0 ? t + 2 + Math.random() * 3 : Infinity;
    this.nextPluck = this.s.texture === 'tanpura' ? t + 0.3 : Infinity;
    this.pluckIndex = 0;
  }

  stop() {
    const t = this.ctx.currentTime;
    this.running = false;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.setTargetAtTime(0, t, 0.8);
    this.nextBloom = this.nextPluck = Infinity;
  }

  // Called by the clock with the window [now, until) to fill.
  tick(until) {
    if (!this.running) return;
    while (this.nextBloom < until) {
      this._bloom(this.nextBloom);
      const c = clamp(this.s.color, 1, 100) / 100;
      // Every ~14 s at the low end of Color, every ~2.5 s at the top.
      const mean = 14 * Math.pow(2.5 / 14, c);
      this.nextBloom += mean * (0.5 + Math.random());
    }
    while (this.nextPluck < until) {
      this._pluck(this.nextPluck);
      // Four plucks a cycle, the last one held a little longer, with the
      // small unevenness of a hand doing it.
      const gap = this.pluckIndex % 4 === 3 ? 1.5 : 0.75;
      this.nextPluck += gap * (0.94 + Math.random() * 0.12);
      this.pluckIndex++;
    }
  }

  _bloom(t) {
    const { ctx } = this;
    const { chord, color } = this.notes;
    if (!chord) return;
    const pool = [...chord.pcs, color, color];
    const p = pick(pool);
    const base = this._low() + 24;
    let note = base + pc(p - this.notes.key);
    if (Math.random() < 0.35) note += 12;
    const bell = this.s.texture === 'glass';
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() * 2 - 1) * 0.75;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(pan).connect(this.bloomBus);
    const f = midiToHz(note);
    const peak = (bell ? 0.05 : 0.04) * (0.7 + Math.random() * 0.5);
    let end;
    if (bell) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.008);
      g.gain.setTargetAtTime(0, t + 0.01, 1.6);
      end = t + 9;
    } else {
      const rise = 2 + Math.random() * 3;
      const hold = 1 + Math.random() * 3;
      const fall = 4 + Math.random() * 4;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + rise);
      g.gain.setValueAtTime(peak, t + rise + hold);
      g.gain.setTargetAtTime(0, t + rise + hold, fall / 4);
      end = t + rise + hold + fall + 0.5;
    }
    // A sine, plus quieter partials: an octave for the swell, the inharmonic
    // ones of a struck bar for the bell.
    const partials = bell ? [[1, 1], [2.76, 0.28], [5.4, 0.1]] : [[1, 1], [2, 0.18]];
    for (const [ratio, amt] of partials) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * ratio;
      o.detune.value = (Math.random() - 0.5) * 8;
      const pg = ctx.createGain();
      pg.gain.value = amt;
      o.connect(pg).connect(g);
      o.start(t);
      o.stop(end);
    }
    setTimeout(() => pan.disconnect(), (end - ctx.currentTime + 0.5) * 1000);
  }

  _pluck(t) {
    const { ctx } = this;
    const low = this._low();
    // Pa, Sa, Sa, low Sa: the fifth, the root an octave up twice, the root.
    const note = [low + 7 + 12, low + 24, low + 24, low + 12][this.pluckIndex % 4];
    const f = midiToHz(note);
    const vca = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    // The tanpura's buzz (jawari) brightens the attack and fades into a
    // sweeping resonance: a filter falling slowly from high to low.
    lp.frequency.setValueAtTime(f * 14, t);
    lp.frequency.exponentialRampToValueAtTime(f * 2.5, t + 2.6);
    const shaper = ctx.createWaveShaper();
    shaper.curve = BUZZ;
    const vel = 0.13 * (0.85 + Math.random() * 0.3);
    vca.gain.setValueAtTime(0, t);
    vca.gain.linearRampToValueAtTime(vel, t + 0.006);
    vca.gain.setTargetAtTime(0, t + 0.01, 1.4);
    lp.connect(shaper).connect(vca).connect(this.pluckBus);
    for (const d of [-4, 4]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = d;
      o.connect(lp);
      o.start(t);
      o.stop(t + 7);
    }
    setTimeout(() => vca.disconnect(), (t - ctx.currentTime + 7.5) * 1000);
  }
}

// A gentle soft-clip curve: enough to add the buzz, never enough to crunch.
const BUZZ = (() => {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
  }
  return c;
})();

// A quiet kit: a soft kick, a shaker and a rim click. Enough to keep time
// without turning the drone into a backing track.
export class Kit {
  constructor(sendTo) {
    const { ctx, master } = audio();
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.6;
    this.out.connect(master);
    if (sendTo) {
      const s = ctx.createGain();
      s.gain.value = 0.15;
      this.out.connect(s).connect(sendTo);
    }
  }

  setLevel(v) { this.out.gain.setTargetAtTime(Math.pow(clamp(v, 0, 100) / 100, 1.5), this.ctx.currentTime, 0.05); }

  hit(drum, t, vel = 0.7) {
    if (drum === 'kick') this._kick(t, vel);
    else if (drum === 'shaker') this._shaker(t, vel);
    else if (drum === 'rim') this._rim(t, vel);
  }

  _kick(t, vel) {
    const { ctx } = this;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.55 * vel, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.02, 0.11);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.7);
  }

  _shaker(t, vel) {
    const { ctx } = this;
    const src = ctx.createBufferSource();
    src.buffer = noise();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.008);
    g.gain.setTargetAtTime(0, t + 0.012, 0.025);
    src.connect(hp).connect(g).connect(this.out);
    src.start(t, Math.random());
    src.stop(t + 0.15);
  }

  _rim(t, vel) {
    const { ctx } = this;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 1750;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22 * vel, t + 0.001);
    g.gain.setTargetAtTime(0, t + 0.002, 0.012);
    o.connect(bp).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.1);
  }
}
