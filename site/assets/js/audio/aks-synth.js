// A Web Audio model of the Behringer AKS Mini: three VCOs that never stop
// running, one shared low-pass filter, one shared trapezoid envelope driving
// one VCA, an LFO, and a spring reverb. Controls run 0–10 like the panel's
// knobs; aks-core.js has the ranges and where each number comes from.
//
// It's a sketch of the instrument for learning its layout, not a copy of its
// circuits: the filter is two ordinary biquads with a sine added for
// self-oscillation, and the spring is a generated impulse response.

import { audio, midiToHz, clamp } from './core.js';
import {
  AKS_DEFAULTS, VCOS, allocate, cutoffHz, lfoHz, detuneCents, pulseWidth, sawRise,
  trapezoidTimes, trapezoidAt, loops, vcaGain,
} from './aks-core.js';

// Resonance to biquad Q, as in va-synth.js; RESPONSE runs a little hotter.
const resDb = (r) => -3 + 30 * Math.pow(clamp(r, 0, 10) / 10, 1.5);

// A wave that rises for `rise` of each cycle and falls for the rest: a saw at
// 1, a triangle at 0.5, a falling ramp near 0. Built from its harmonics so the
// browser can play it without aliasing; cached in 41 steps.
const shapeCache = new WeakMap();
function riseWave(ctx, rise) {
  let cache = shapeCache.get(ctx);
  if (!cache) { cache = new Map(); shapeCache.set(ctx, cache); }
  const key = Math.round(clamp(rise, 0, 1) * 40);
  if (cache.has(key)) return cache.get(key);
  const r = clamp(key / 40, 0.02, 0.98);
  const M = 2048;
  const N = 80;
  const x = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const th = i / M;
    x[i] = th < r ? -1 + (2 * th) / r : 1 - (2 * (th - r)) / (1 - r);
  }
  const real = new Float32Array(N); const imag = new Float32Array(N);
  for (let n = 1; n < N; n++) {
    let re = 0; let im = 0;
    for (let i = 0; i < M; i++) {
      const a = (2 * Math.PI * n * i) / M;
      re += x[i] * Math.cos(a);
      im += x[i] * Math.sin(a);
    }
    real[n] = (2 * re) / M;
    imag[n] = (2 * im) / M;
  }
  const w = ctx.createPeriodicWave(real, imag);
  cache.set(key, w);
  return w;
}

// A spring tank: two springs (about 25 and 30 ms of travel), each returning a
// smeared chirp every trip, falling away over about two seconds. The chirps
// sweep downward because a spring carries high frequencies faster than low
// ones; that's the "boing".
const springCache = new WeakMap();
function springImpulse(ctx) {
  if (springCache.has(ctx)) return springCache.get(ctx);
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2.4);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (const [trip, gain] of [[0.025 + ch * 0.0013, 0.55], [0.030 - ch * 0.0009, 0.45]]) {
      for (let k = 1; k * trip < 2.3; k++) {
        const t0 = Math.floor(k * trip * sr);
        const amp = gain * Math.exp(-(k * trip) / 0.55) * (k === 1 ? 1 : 0.8);
        // A short downward chirp, 4 kHz to 300 Hz over most of one trip.
        const chirpLen = Math.floor(trip * sr * 0.9);
        let phase = 0;
        for (let i = 0; i < chirpLen && t0 + i < len; i++) {
          const x = i / chirpLen;
          const f = 4000 * Math.pow(300 / 4000, x);
          phase += (2 * Math.PI * f) / sr;
          d[t0 + i] += amp * Math.sin(phase) * Math.sin(Math.PI * x) * 0.5;
        }
      }
    }
    // A diffuse tail under the chirps, darker as it fades.
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      lp += 0.08 * ((Math.random() * 2 - 1) - lp);
      d[i] += lp * 0.35 * Math.exp(-t / 0.6) * Math.min(1, t / 0.02);
    }
  }
  springCache.set(ctx, buf);
  return buf;
}

export class AKSSynth {
  constructor(params = {}) {
    const { ctx } = audio();
    this.ctx = ctx;
    this.p = { ...AKS_DEFAULTS, ...params };
    this.held = [];
    // What each VCO plays. They start on C3 and keep their last note when
    // the keys go up, like analog oscillators that are never switched off.
    this.notes = new Array(VCOS).fill(48);
    this.lastVel = 0.8;
    this.cycle = null; // the envelope cycle now running: { start, times, from }
    this.cycling = false; // looping by itself (Off at 6 or below)

    // ---------- Modulation sources ----------
    this.lfoOut = ctx.createGain();
    this._buildLfo();
    // The envelope: a constant source whose level draws the trapezoid. Taps
    // read it (envOut); gains below send it to the VCA, filter and pitch.
    this.envSrc = ctx.createConstantSource();
    this.envSrc.offset.value = 0;
    this.envSrc.start();
    this.envOut = ctx.createGain();
    this.envSrc.connect(this.envOut);
    // Pitch bend and mod wheel, from a keyboard plugged into the page.
    this.bendSrc = ctx.createConstantSource();
    this.bendSrc.offset.value = 0;
    this.bendSrc.start();
    this.modGain = ctx.createGain();
    this.modGain.gain.value = 0;
    this.lfoOut.connect(this.modGain);

    // Everything that moves the pitch of all three VCOs, in cents.
    this.pitchBus = ctx.createGain();
    this.lfoPitch = ctx.createGain();
    this.lfoOut.connect(this.lfoPitch).connect(this.pitchBus);
    this.envPitch = ctx.createGain();
    this.envSrc.connect(this.envPitch).connect(this.pitchBus);
    this.bendSrc.connect(this.pitchBus);
    this.modGain.connect(this.pitchBus);

    // ---------- VCOs ----------
    // Each VCO: one oscillator for SAW (its shape follows SHAPE), and one
    // sawtooth for SQUARE, which becomes a pulse by subtracting a delayed copy
    // of itself; the delay sets the pulse width.
    this.mix = ctx.createGain();
    this.vcos = [];
    for (let i = 0; i < VCOS; i++) {
      const v = {};
      v.saw = ctx.createOscillator();
      v.sq = ctx.createOscillator();
      v.sq.type = 'sawtooth';
      v.sawGain = ctx.createGain();
      v.sqGain = ctx.createGain();
      v.delay = ctx.createDelay(0.1);
      v.inv = ctx.createGain();
      v.inv.gain.value = -1;
      v.out = ctx.createGain();
      v.out.gain.value = 0.2;
      v.saw.connect(v.sawGain).connect(v.out);
      v.sq.connect(v.sqGain);
      v.sq.connect(v.delay).connect(v.inv).connect(v.sqGain);
      v.sqGain.connect(v.out);
      v.out.connect(this.mix);
      for (const o of [v.saw, v.sq]) this.pitchBus.connect(o.detune);
      const t = ctx.currentTime;
      v.saw.start(t); v.sq.start(t);
      this.vcos.push(v);
    }

    // ---------- VCF ----------
    this.filters = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    this.mix.connect(this.filters[0]).connect(this.filters[1]);
    this.cutMod = ctx.createGain(); // cents, summed into both filters
    this.lfoCut = ctx.createGain();
    this.lfoOut.connect(this.lfoCut).connect(this.cutMod);
    this.envCut = ctx.createGain();
    this.envSrc.connect(this.envCut).connect(this.cutMod);
    for (const f of this.filters) this.cutMod.connect(f.detune);
    // Near full RESPONSE the EMS filter whistles by itself: a sine at the
    // cutoff, following it wherever it's moved.
    this.selfOsc = ctx.createOscillator();
    this.selfOsc.type = 'sine';
    this.cutMod.connect(this.selfOsc.detune);
    this.selfGain = ctx.createGain();
    this.selfGain.gain.value = 0;
    this.selfOsc.connect(this.selfGain);
    this.selfOsc.start();
    this.postFilter = ctx.createGain();
    this.filters[1].connect(this.postFilter);
    this.selfGain.connect(this.postFilter);

    // ---------- VCA ----------
    // Gain = SIGNAL × (1 − TRAPEZ + TRAPEZ × envelope): the fixed part is the
    // VCA's own gain, the moving part comes in from the envelope.
    this.vca = ctx.createGain();
    this.vca.gain.value = 0;
    this.envAmp = ctx.createGain();
    this.envSrc.connect(this.envAmp).connect(this.vca.gain);
    this.postFilter.connect(this.vca);

    // ---------- Spring reverb and output ----------
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.spring = ctx.createConvolver();
    this.spring.buffer = springImpulse(ctx);
    this.springIn = ctx.createBiquadFilter(); // springs never carry much bass
    this.springIn.type = 'highpass';
    this.springIn.frequency.value = 180;
    this.output = ctx.createGain();
    this.output.gain.value = 0.9;
    this.vca.connect(this.dry).connect(this.output);
    this.vca.connect(this.springIn).connect(this.spring).connect(this.wet).connect(this.output);

    this._timer = setInterval(() => this._tick(), 25);
    this.set({});
    this._retune(true);
  }

  // ---------- LFO ----------
  _buildLfo() {
    const ctx = this.ctx;
    if (this.lfoSrc) { try { this.lfoSrc.stop(); } catch (_) {} this.lfoSrc.disconnect(); }
    clearInterval(this._shTimer);
    const w = this.p.lfoWave;
    if (w === 'random') {
      // Random: a new level at each tick of the rate, held until the next.
      const src = ctx.createConstantSource();
      src.start();
      const step = () => src.offset.setValueAtTime(Math.random() * 2 - 1, ctx.currentTime);
      this._shTimer = setInterval(step, 1000 / lfoHz(this.p.lfoRate));
      this.lfoSrc = src;
    } else {
      const osc = ctx.createOscillator();
      osc.type = { sine: 'sine', saw: 'sawtooth', square: 'square' }[w] || 'sine';
      osc.frequency.value = lfoHz(this.p.lfoRate);
      osc.start();
      this.lfoSrc = osc;
    }
    this.lfoSrc.connect(this.lfoOut);
    this._lfoWave = w;
  }

  // ---------- Parameters ----------
  set(partial = {}) {
    Object.assign(this.p, partial);
    const p = this.p;
    const t = this.ctx.currentTime;
    const glide = (param, value, tau = 0.015) => param.setTargetAtTime(value, t, tau);

    if (p.lfoWave !== this._lfoWave) this._buildLfo();
    else if (this.lfoSrc.frequency) glide(this.lfoSrc.frequency, lfoHz(p.lfoRate), 0.02);
    else if (partial.lfoRate !== undefined) this._buildLfo();

    // VCOs
    const pw = pulseWidth(p.shape);
    const wave = riseWave(this.ctx, sawRise(p.shape));
    if (wave !== this._wave) { for (const v of this.vcos) v.saw.setPeriodicWave(wave); this._wave = wave; }
    for (const v of this.vcos) {
      glide(v.sawGain.gain, clamp(p.saw, 0, 10) / 10);
      glide(v.sqGain.gain, (clamp(p.square, 0, 10) / 10) * 0.8);
    }
    this._pw = pw;
    this._retune();

    // VCF
    const [f1, f2] = this.filters;
    const hz = cutoffHz(p.cutoff);
    glide(f1.frequency, hz); glide(f2.frequency, hz); glide(this.selfOsc.frequency, hz);
    f1.type = 'lowpass';
    if (p.slope === '12') {
      f2.type = 'allpass'; f2.Q.value = 0.0001;
      glide(f1.Q, resDb(p.response));
    } else {
      f2.type = 'lowpass';
      glide(f1.Q, -3);
      glide(f2.Q, resDb(p.response));
    }
    const r = clamp(p.response, 0, 10);
    glide(this.selfGain.gain, r > 8.5 ? Math.pow((r - 8.5) / 1.5, 2) * 0.22 : 0, 0.05);
    glide(this.envCut.gain, (clamp(p.egInt, 0, 10) / 10) * 6000);
    glide(this.lfoCut.gain, (clamp(p.lfoCutoff, 0, 10) / 10) * 4800);

    // Pitch modulation
    glide(this.lfoPitch.gain, Math.pow(clamp(p.lfoPitch, 0, 10) / 10, 2) * 1200);
    glide(this.envPitch.gain, (clamp(p.pitchEg, 0, 10) / 10) * 2400);

    // VCA: the fixed part and the envelope's share.
    const fixed = vcaGain(0, p);
    glide(this.vca.gain, fixed);
    glide(this.envAmp.gain, vcaGain(1, p) - fixed);

    // Reverb
    const mix = clamp(p.reverb, 0, 10) / 10;
    glide(this.wet.gain, mix * 0.9);
    glide(this.dry.gain, 1 - mix * 0.45);

    // Off moved past 6 lets the running cycle finish and starts no more. The
    // loop starts again from the next key (or trigger).
    if (!loops(p)) this.cycling = false;
  }

  get params() { return { ...this.p }; }

  // Listening points along the signal path, for drawing it stage by stage:
  // the three VCOs' mix, after the filter, after the VCA, and the output.
  taps() {
    if (this._taps) return this._taps;
    const tap = (node) => {
      const a = this.ctx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0;
      node.connect(a);
      return a;
    };
    this._taps = { vcos: tap(this.mix), filter: tap(this.postFilter), vca: tap(this.vca), out: tap(this.output) };
    return this._taps;
  }

  // Set the three VCOs' pitches (and the pulse widths, which depend on pitch)
  // from the notes they hold, DETUNE and OCT.
  _retune(immediate = false) {
    const t = this.ctx.currentTime;
    const d = detuneCents(this.p.detune);
    const offsets = [0, d, -d];
    this.vcos.forEach((v, i) => {
      const f = midiToHz(this.notes[i] + 12 * (this.p.oct || 0)) * Math.pow(2, offsets[i] / 1200);
      for (const o of [v.saw, v.sq]) {
        if (immediate) o.frequency.setValueAtTime(f, t); else o.frequency.setTargetAtTime(f, t, 0.004);
      }
      const dt = clamp(this._pw ?? 0.1, 0.02, 0.98) / f;
      if (immediate) v.delay.delayTime.setValueAtTime(dt, t); else v.delay.delayTime.setTargetAtTime(dt, t, 0.004);
    });
  }

  // ---------- Keys ----------
  noteOn(note, vel = 0.8) {
    const wasEmpty = !this.held.length;
    this.held = this.held.filter((n) => n !== note);
    this.held.push(note);
    this.lastVel = vel;
    this._assign();
    // Every key fires the envelope, or only the first after all were up.
    if (wasEmpty || this.p.trigger !== 'single') this.trigger();
  }

  noteOff(note) {
    if (!this.held.includes(note)) return;
    this.held = this.held.filter((n) => n !== note);
    if (this.held.length) this._assign();
    // Letting go changes nothing else: the trapezoid runs on its own clock.
  }

  allOff() { this.held = []; }

  // Stop a looping envelope: it falls from where it is, at its Decay rate.
  stopCycling() {
    this.cycling = false;
    if (!this.cycle) return;
    const now = this.ctx.currentTime;
    const { level, stage } = this.envAt(now);
    if (stage === 'off') return;
    const { a, on, d } = this.cycle.times;
    const p = this.envSrc.offset;
    p.cancelScheduledValues(now);
    p.setValueAtTime(level, now);
    p.linearRampToValueAtTime(0, now + Math.max(0.02, d * level));
    // Pretend the cycle began just early enough to be this far into Decay.
    this.cycle = { start: now - a - on - d * (1 - level), times: this.cycle.times, from: 0 };
  }

  _assign() {
    const notes = allocate(this.held, this.p.mode, this.p.priority);
    if (!notes) return;
    this.notes = notes;
    this._retune();
    this.dispatch('voices', this.notes);
  }

  // ---------- Envelope ----------
  // The level and stage of the envelope at audio time t.
  envAt(t = this.ctx.currentTime) {
    if (!this.cycle) return { level: 0, stage: 'off', dt: 0 };
    const dt = t - this.cycle.start;
    return { ...trapezoidAt(dt, this.cycle.times, this.cycle.from), dt };
  }

  // Fire the envelope now (a key, or the joystick's button on the AKS Mini).
  trigger(when) {
    const t = Math.max(when ?? 0, this.ctx.currentTime);
    const from = this.envAt(t).level;
    this._schedule(t, from);
    if (loops(this.p)) this.cycling = true;
  }

  _schedule(t, from) {
    const times = trapezoidTimes(this.p);
    const rise = times.a * (1 - from);
    const p = this.envSrc.offset;
    p.cancelScheduledValues(t);
    p.setValueAtTime(from, t);
    p.linearRampToValueAtTime(1, t + Math.max(rise, 0.001));
    p.setValueAtTime(1, t + rise + times.on);
    p.linearRampToValueAtTime(0, t + rise + times.on + Math.max(times.d, 0.001));
    this.cycle = { start: t, times, from };
  }

  // Looping: once a cycle's Decay and Off have passed, start the next one.
  // Scheduled a little ahead so it lands on time.
  _tick() {
    if (!this.cycling || !this.cycle) return;
    const { a, on, d, off } = this.cycle.times;
    const next = this.cycle.start + a * (1 - this.cycle.from) + on + d + (Number.isFinite(off) ? off : Infinity);
    if (next - this.ctx.currentTime < 0.06) this._schedule(Math.max(next, this.ctx.currentTime), 0);
  }

  // ---------- Controllers ----------
  // Pitch bend, −1 to 1, over ±2 semitones (the AKS Mini's own bend range
  // isn't documented).
  bend(x) { this.bendSrc.offset.setTargetAtTime(clamp(x, -1, 1) * 200, this.ctx.currentTime, 0.01); }
  // Mod wheel, 0 to 1: adds up to a quarter tone of LFO vibrato.
  mod(x) { this.modGain.gain.setTargetAtTime(clamp(x, 0, 1) * 50, this.ctx.currentTime, 0.02); }

  // ---------- Events ----------
  on(type, fn) { (this._listeners ||= {})[type] = [...(this._listeners?.[type] || []), fn]; }
  dispatch(type, detail) { for (const fn of this._listeners?.[type] || []) fn(detail); }

  dispose(fadeTime = 0.08) {
    clearInterval(this._timer);
    clearInterval(this._shTimer);
    this.cycling = false;
    this.output.gain.setTargetAtTime(0, this.ctx.currentTime, fadeTime / 3);
    setTimeout(() => {
      for (const n of [this.lfoSrc, this.envSrc, this.bendSrc, this.selfOsc, ...this.vcos.flatMap((v) => [v.saw, v.sq])]) {
        try { n.stop(); } catch (_) {}
      }
      this.output.disconnect();
    }, fadeTime * 1000 + 150);
  }
}
