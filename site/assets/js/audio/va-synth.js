// A Virtual Analog synth that mirrors the FM-1+VA parameter set, so what you
// learn on the page maps one-to-one onto the hardware. Every control runs 0–100
// unless noted, like the FM-1's own rows.

import { audio, noise, midiToHz, clamp, expTime, centsFromRatio } from './core.js';
import { mixLevels, normalize, ratioFor, CENTER } from './supersaw.js';
import { FxChain, DEFAULT_FX } from './fx.js';

export const WAVEFORMS = ['sine', 'saw', 'tri', 'square'];
export const FILTER_TYPES = ['lp12', 'lp24', 'bp', 'hp'];
export const LFO_WAVES = ['triangle', 'saw down', 'saw up', 'square', 'sine', 's&h'];

export const DEFAULT_VA = {
  // Oscillator
  waveform: 'saw', super: 0, detune: 0, drift: 0, sub: 0, noise: 0, pwm: 0,
  // Filter (cutoff in Hz, key tracking 0/33/67/100)
  filterType: 'lp24', cutoff: 20000, resonance: 0,
  filterEnv: 0, filterDecay: 35, filterVelocity: 0, keyTrack: 0, lfoToCutoff: 0,
  // Envelope (amp)
  attack: 0, decay: 40, sustain: 100, release: 20,
  // LFO
  lfoWave: 'triangle', lfoSpeed: 35, lfoPitch: 0, lfoAmp: 0, lfoDelay: 0,
  // Voice
  level: 78, mono: false, glide: 0,
  fx: DEFAULT_FX,
};

const OSC_TYPE = { sine: 'sine', saw: 'sawtooth', tri: 'triangle', square: 'square' };

// Resonance (0–100) to the Web Audio filter Q. Low- and high-pass Q is in dB.
const resDb = (r) => -3 + 31 * Math.pow(clamp(r, 0, 100) / 100, 1.6);
const resQ = (r) => 0.6 + 18 * Math.pow(clamp(r, 0, 100) / 100, 2);

export const attackTime = (v) => expTime(v, 0.002, 8);
export const decayTime = (v) => expTime(v, 0.01, 8);
export const releaseTime = (v) => expTime(v, 0.1, 2); // FM-1: 0.1 s at 0, 2 s at 100
export const lfoHz = (v) => 0.05 * Math.pow(1000, clamp(v, 0, 99) / 99);
export const filterDecayTime = (v) => expTime(v, 0.01, 4);

export class VASynth {
  constructor(params = {}, { fx = true, maxVoices = 12 } = {}) {
    const { ctx } = audio();
    this.ctx = ctx;
    this.p = { ...structuredClone(DEFAULT_VA), ...structuredClone(params) };
    this.p.fx = { ...structuredClone(DEFAULT_FX), ...(params.fx ? structuredClone(params.fx) : {}) };
    this.maxVoices = maxVoices;
    this.voices = [];
    this.monoStack = [];

    this.bus = ctx.createGain();
    this.trem = ctx.createGain();
    this.tremDepth = ctx.createGain();
    this.output = ctx.createGain();
    this.bus.connect(this.trem);

    if (fx) {
      this.fx = new FxChain(this.p.fx);
      this.trem.connect(this.fx.input);
      this.fx.output.connect(this.output);
    } else {
      this.trem.connect(this.output);
    }

    // One LFO for the whole synth. Each voice takes it through its own gains,
    // so LFO Delay can fade the wobble in note by note.
    this.lfoOut = ctx.createGain();
    this.lfoOut.connect(this.tremDepth).connect(this.trem.gain);
    this._buildLfo();

    this._driftTimer = setInterval(() => this._drift(), 90);
    this.set({});
  }

  // ---------- LFO ----------
  _buildLfo() {
    const ctx = this.ctx;
    if (this.lfoSrc) { try { this.lfoSrc.stop(); } catch (_) {} this.lfoSrc.disconnect(); }
    clearInterval(this._shTimer);
    const w = this.p.lfoWave;
    if (w === 's&h') {
      const src = ctx.createConstantSource();
      src.start();
      this._shTimer = setInterval(() => {
        src.offset.setValueAtTime(Math.random() * 2 - 1, ctx.currentTime);
      }, 1000 / lfoHz(this.p.lfoSpeed));
      this.lfoSrc = src;
      src.connect(this.lfoOut);
    } else {
      const osc = ctx.createOscillator();
      osc.type = { triangle: 'triangle', 'saw down': 'sawtooth', 'saw up': 'sawtooth', square: 'square', sine: 'sine' }[w] || 'triangle';
      osc.frequency.value = lfoHz(this.p.lfoSpeed);
      const sign = ctx.createGain();
      sign.gain.value = w === 'saw down' ? -1 : 1;
      osc.connect(sign).connect(this.lfoOut);
      osc.start();
      this.lfoSrc = osc;
    }
    this._lfoWave = w;
  }

  // ---------- Parameters ----------
  set(partial = {}) {
    const prevWave = this.p.waveform;
    if (partial.fx) {
      for (const k of Object.keys(partial.fx)) this.p.fx[k] = { ...this.p.fx[k], ...partial.fx[k] };
    }
    const { fx, ...rest } = partial;
    Object.assign(this.p, rest);
    const p = this.p;
    const t = this.ctx.currentTime;

    if (this.fx && fx) this.fx.set(p.fx);
    if (p.lfoWave !== this._lfoWave) this._buildLfo();
    else if (this.lfoSrc.frequency) this.lfoSrc.frequency.setTargetAtTime(lfoHz(p.lfoSpeed), t, 0.02);
    else if (partial.lfoSpeed !== undefined) this._buildLfo();

    // Tremolo: the LFO moves loudness around (1 - depth/2).
    const amp = clamp(p.lfoAmp, 0, 99) / 99;
    this.trem.gain.setTargetAtTime(1 - amp * 0.5, t, 0.02);
    this.tremDepth.gain.setTargetAtTime(amp * 0.5, t, 0.02);

    for (const v of this.voices) this._updateVoice(v, prevWave);
  }

  get params() { return structuredClone(this.p); }

  // ---------- Voices ----------
  _superCents() {
    return Array.from({ length: 7 }, (_, i) => centsFromRatio(ratioFor(i, this.p.detune)));
  }

  _filterBaseCents(note, vel) {
    const kt = (this.p.keyTrack / 100) * (note - 60) * 100;
    const velCents = (this.p.filterVelocity / 100) * vel * 2400;
    return kt + velCents;
  }

  _applyFilterShape(v) {
    const p = this.p;
    const t = this.ctx.currentTime;
    const [f1, f2] = v.filters;
    const cutoff = clamp(p.cutoff, 20, 20000);
    f1.frequency.setTargetAtTime(cutoff, t, 0.015);
    f2.frequency.setTargetAtTime(cutoff, t, 0.015);
    if (p.filterType === 'lp12') {
      f1.type = 'lowpass'; f1.Q.setTargetAtTime(resDb(p.resonance), t, 0.015);
      f2.type = 'allpass'; f2.Q.value = 0.0001;
    } else if (p.filterType === 'lp24') {
      f1.type = 'lowpass'; f1.Q.setTargetAtTime(-3, t, 0.015);
      f2.type = 'lowpass'; f2.Q.setTargetAtTime(resDb(p.resonance), t, 0.015);
    } else if (p.filterType === 'hp') {
      f1.type = 'highpass'; f1.Q.setTargetAtTime(resDb(p.resonance), t, 0.015);
      f2.type = 'allpass'; f2.Q.value = 0.0001;
    } else {
      f1.type = 'bandpass'; f1.Q.setTargetAtTime(resQ(p.resonance), t, 0.015);
      f2.type = 'allpass'; f2.Q.value = 0.0001;
    }
  }

  _makeVoice(note, vel, t) {
    const ctx = this.ctx;
    const p = this.p;
    const f = midiToHz(note);
    const v = { note, vel, freq: f, oscs: [], oscGains: [], drift: new Array(7).fill(0), stopAt: Infinity };

    v.mix = ctx.createGain();
    v.superGain = ctx.createGain();
    v.superGain.connect(v.mix);

    v.lfoPitch = ctx.createGain();
    v.lfoPitch.gain.value = 0;
    v.lfoCut = ctx.createGain();
    v.lfoCut.gain.value = 0;
    this.lfoOut.connect(v.lfoPitch);
    this.lfoOut.connect(v.lfoCut);

    const cents = this._superCents();
    const usePwm = p.waveform === 'square' && p.pwm > 0;
    v.pwm = usePwm;

    for (let i = 0; i < 7; i++) {
      const g = ctx.createGain();
      g.connect(v.superGain);
      let osc;
      if (usePwm) {
        // Pulse wave = a saw minus a delayed copy of itself. Moving the delay
        // moves the pulse width, which is how PWM sweeps the tone.
        osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const inv = ctx.createGain(); inv.gain.value = -1;
        const dl = ctx.createDelay(0.1);
        dl.delayTime.value = 0.5 / f;
        const pwmLfo = ctx.createOscillator();
        pwmLfo.frequency.value = 0.6 + i * 0.07;
        const pwmDepth = ctx.createGain();
        pwmDepth.gain.value = (p.pwm / 100) * 0.42 / f;
        pwmLfo.connect(pwmDepth).connect(dl.delayTime);
        osc.connect(g);
        osc.connect(dl).connect(inv).connect(g);
        pwmLfo.start(t);
        v.extraStops = v.extraStops || [];
        v.extraStops.push(pwmLfo);
      } else {
        osc = ctx.createOscillator();
        osc.type = OSC_TYPE[p.waveform];
        osc.connect(g);
      }
      osc.frequency.value = f;
      osc.detune.value = cents[i];
      v.lfoPitch.connect(osc.detune);
      // All seven copies start in step, as on the FM-1+VA: with Detune at 0
      // they stay in step and sound like one oscillator.
      osc.start(t);
      v.oscs.push(osc);
      v.oscGains.push(g);
    }

    v.sub = ctx.createOscillator();
    v.sub.type = 'square';
    v.sub.frequency.value = f / 2;
    v.lfoPitch.connect(v.sub.detune);
    v.subGain = ctx.createGain();
    v.sub.connect(v.subGain).connect(v.mix);
    v.sub.start(t);

    v.noise = ctx.createBufferSource();
    v.noise.buffer = noise();
    v.noise.loop = true;
    v.noise.loopStart = Math.random();
    v.noiseGain = ctx.createGain();
    v.noise.connect(v.noiseGain).connect(v.mix);
    v.noise.start(t, Math.random() * 1.5);

    v.filters = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    v.vca = ctx.createGain();
    v.vca.gain.value = 0;
    v.mix.connect(v.filters[0]).connect(v.filters[1]).connect(v.vca).connect(this.bus);
    for (const fl of v.filters) v.lfoCut.connect(fl.detune);

    this._updateVoice(v);
    return v;
  }

  _updateVoice(v, prevWave) {
    const p = this.p;
    const t = this.ctx.currentTime;
    const { center, side } = mixLevels(p.super / 100);
    const norm = normalize(center, side, p.detune);
    const cents = this._superCents();
    v.oscGains.forEach((g, i) => g.gain.setTargetAtTime((i === CENTER ? center : side) * norm, t, 0.02));
    v.oscs.forEach((o, i) => {
      o.detune.setTargetAtTime(cents[i] + v.drift[i], t, 0.03);
      if (!v.pwm && prevWave !== undefined) o.type = OSC_TYPE[p.waveform];
    });
    v.superGain.gain.setTargetAtTime(0.9, t, 0.02);
    v.subGain.gain.setTargetAtTime((p.sub / 100) * 0.55, t, 0.02);
    v.noiseGain.gain.setTargetAtTime((p.noise / 100) * 0.35, t, 0.02);
    this._applyFilterShape(v);
    const lfoCutCents = (p.lfoToCutoff / 100) * 4800; // ±4 octaves at full
    const lfoPitchCents = Math.pow(clamp(p.lfoPitch, 0, 99) / 99, 2) * 600;
    v.lfoTargets = { pitch: lfoPitchCents, cut: lfoCutCents };
    if (v.lfoFadedIn) {
      v.lfoPitch.gain.setTargetAtTime(lfoPitchCents, t, 0.02);
      v.lfoCut.gain.setTargetAtTime(lfoCutCents, t, 0.02);
    }
  }

  _gateOn(v, t) {
    const p = this.p;
    const peak = 0.24 * (p.level / 78) * (0.45 + 0.55 * v.vel);
    const a = attackTime(p.attack);
    const d = decayTime(p.decay);
    const s = peak * clamp(p.sustain, 0, 100) / 100;
    const g = v.vca.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + a);
    g.setTargetAtTime(s, t + a, d / 4);

    // Filter envelope: a jump up in cutoff that falls back over Decay.
    const base = this._filterBaseCents(v.note, v.vel);
    const env = (p.filterEnv / 100) * 7200;
    for (const fl of v.filters) {
      fl.detune.cancelScheduledValues(t);
      fl.detune.setValueAtTime(base + env, t);
      fl.detune.setTargetAtTime(base, t + 0.001, filterDecayTime(p.filterDecay) / 3);
    }

    // LFO Delay: the wobble fades in after the key goes down.
    const delay = (p.lfoDelay / 99) * 3;
    const { pitch, cut } = v.lfoTargets;
    v.lfoPitch.gain.setValueAtTime(0, t);
    v.lfoCut.gain.setValueAtTime(0, t);
    v.lfoPitch.gain.linearRampToValueAtTime(pitch, t + delay + 0.01);
    v.lfoCut.gain.linearRampToValueAtTime(cut, t + delay + 0.01);
    v.lfoFadedIn = true;
  }

  _release(v, t) {
    const r = releaseTime(this.p.release);
    const g = v.vca.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    g.setTargetAtTime(0, t, r / 5);
    v.stopAt = t + r * 1.2 + 0.05;
    v.released = true;
    const all = [...v.oscs, v.sub, v.noise, ...(v.extraStops || [])];
    for (const n of all) { try { n.stop(v.stopAt); } catch (_) {} }
    v.oscs[0].onended = () => {
      this.lfoOut.disconnect(v.lfoPitch);
      this.lfoOut.disconnect(v.lfoCut);
      v.vca.disconnect();
      this.voices = this.voices.filter((x) => x !== v);
    };
  }

  noteOn(note, vel = 0.8, when) {
    const t = Math.max(when ?? 0, this.ctx.currentTime);
    if (this.p.mono) return this._monoOn(note, vel, t);
    // Retrigger the same key cleanly.
    for (const v of this.voices) if (v.note === note && !v.released) this._release(v, t);
    const live = this.voices.filter((v) => !v.released);
    const limit = (this.p.waveform === 'tri' || this.p.waveform === 'square') ? Math.min(8, this.maxVoices) : this.maxVoices;
    if (live.length >= limit) this._release(live[0], t);
    const v = this._makeVoice(note, vel, t);
    this.voices.push(v);
    this._gateOn(v, t);
    this.dispatch('noteon', note);
  }

  noteOff(note, when) {
    const t = Math.max(when ?? 0, this.ctx.currentTime);
    if (this.p.mono) return this._monoOff(note, t);
    for (const v of this.voices) if (v.note === note && !v.released) this._release(v, t);
    this.dispatch('noteoff', note);
  }

  _glideTo(v, note, t) {
    const f = midiToHz(note);
    const tau = Math.max(0.001, (this.p.glide / 100) * 0.25);
    for (const o of v.oscs) o.frequency.setTargetAtTime(f, t, tau);
    v.sub.frequency.setTargetAtTime(f / 2, t, tau);
    v.note = note;
    v.freq = f;
  }

  _monoOn(note, vel, t) {
    this.monoStack = this.monoStack.filter((n) => n !== note);
    this.monoStack.push(note);
    const v = this.voices.find((x) => !x.released);
    if (v) {
      // Legato: slide to the new note without a fresh attack.
      this._glideTo(v, note, t);
    } else {
      const nv = this._makeVoice(note, vel, t);
      this.voices.push(nv);
      this._gateOn(nv, t);
    }
    this.dispatch('noteon', note);
  }

  _monoOff(note, t) {
    this.monoStack = this.monoStack.filter((n) => n !== note);
    const v = this.voices.find((x) => !x.released);
    if (!v) return;
    if (this.monoStack.length) this._glideTo(v, this.monoStack[this.monoStack.length - 1], t);
    else this._release(v, t);
    this.dispatch('noteoff', note);
  }

  allOff() {
    const t = this.ctx.currentTime;
    this.monoStack = [];
    for (const v of this.voices) if (!v.released) this._release(v, t);
  }

  playNote(note, dur = 0.5, vel = 0.8) {
    const t = this.ctx.currentTime + 0.01;
    this.noteOn(note, vel, t);
    this.noteOff(note, t + dur);
  }

  // ---------- Drift ----------
  _drift() {
    const d = this.p.drift;
    if (!d || !this.voices.length) return;
    // A few cents of wander in the first half; deliberately wild above it.
    const range = d <= 50 ? (d / 50) * 6 : 6 + Math.pow((d - 50) / 50, 2) * 90;
    const tau = d <= 50 ? 0.6 : 0.6 - ((d - 50) / 50) * 0.5;
    const t = this.ctx.currentTime;
    const cents = this._superCents();
    for (const v of this.voices) {
      if (v.released) continue;
      v.oscs.forEach((o, i) => {
        if (Math.random() < 0.35) {
          v.drift[i] = clamp(v.drift[i] + (Math.random() * 2 - 1) * range * 0.5, -range, range);
          o.detune.setTargetAtTime(cents[i] + v.drift[i], t, tau);
        }
      });
    }
  }

  // ---------- Events ----------
  on(type, fn) { (this._listeners ||= {})[type] = [...(this._listeners?.[type] || []), fn]; }
  dispatch(type, detail) { for (const fn of this._listeners?.[type] || []) fn(detail); }

  dispose() {
    this.allOff();
    clearInterval(this._driftTimer);
    clearInterval(this._shTimer);
    setTimeout(() => {
      try { this.lfoSrc.stop(); } catch (_) {}
      this.fx?.disconnect();
      this.output.disconnect();
    }, 2500);
  }
}
