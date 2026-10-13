// Effects chain: distortion → chorus → delay → reverb.
// The FM-1 has seven effects in an order you can change; the course keeps four
// in a fixed, conventional order so the lessons stay focused.

import { audio, clamp } from './core.js';

export const DEFAULT_FX = {
  distortion: { on: false, type: 'soft', gain: 30, tone: 55, level: 70 },
  chorus: { on: false, rate: 30, depth: 25, mix: 40 },
  delay: { on: false, feedback: 30, rate: 30, mix: 25 },
  reverb: { on: false, type: 'room', decay: 30, mix: 30 },
};

function makeShaperCurve(type, drive) {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = x * drive;
    if (type === 'hard') curve[i] = clamp(y, -1, 1);
    else if (type === 'fold') {
      // Wave folding: the signal bounces back off ±1 instead of flattening,
      // however hard it's driven.
      const ph = ((((y + 1) / 4) % 1) + 1) % 1;
      curve[i] = 1 - 4 * Math.abs(ph - 0.5);
    } else curve[i] = Math.tanh(y);
  }
  return curve;
}

// A synthetic room: stereo noise with an exponential decay. Hall adds pre-delay
// and length; plate is brighter and denser from the first instant.
export function makeImpulse(ctx, type, decay) {
  const base = { room: [0.35, 1.6], hall: [1.2, 7.0], plate: [0.8, 5.0] }[type] || [0.35, 1.6];
  const rt60 = base[0] + (base[1] - base[0]) * (clamp(decay, 0, 100) / 100);
  const preDelay = type === 'hall' ? 0.025 : type === 'room' ? 0.008 : 0;
  const len = Math.ceil(ctx.sampleRate * (rt60 + preDelay + 0.1));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const pre = Math.floor(preDelay * ctx.sampleRate);
  const k = Math.log(1000) / (rt60 * ctx.sampleRate); // -60 dB at rt60
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    const smooth = type === 'plate' ? 0.1 : type === 'hall' ? 0.45 : 0.3;
    for (let i = pre; i < len; i++) {
      const n = Math.random() * 2 - 1;
      lp = lp + (n - lp) * (1 - smooth); // darker rooms have duller reflections
      d[i] = lp * Math.exp(-k * (i - pre));
    }
    // A handful of distinct early reflections for rooms and halls.
    if (type !== 'plate') {
      for (let r = 0; r < 6; r++) {
        const t = pre + Math.floor(ctx.sampleRate * (0.004 + Math.random() * (type === 'hall' ? 0.06 : 0.025)));
        if (t < len) d[t] += (Math.random() > 0.5 ? 1 : -1) * (0.5 - r * 0.06);
      }
    }
  }
  return buf;
}

export class FxChain {
  constructor(settings = {}) {
    const { ctx } = audio();
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.s = structuredClone(DEFAULT_FX);

    // Distortion
    this.dIn = ctx.createGain();
    this.dDry = ctx.createGain();
    this.dShaper = ctx.createWaveShaper();
    this.dShaper.oversample = '4x';
    this.dTone = ctx.createBiquadFilter();
    this.dTone.type = 'lowpass';
    this.dLevel = ctx.createGain();
    this.dOut = ctx.createGain();
    this.input.connect(this.dIn);
    this.dIn.connect(this.dDry).connect(this.dOut);
    this.dIn.connect(this.dShaper).connect(this.dTone).connect(this.dLevel).connect(this.dOut);

    // Chorus: two short delays swept by slow LFOs, one per side.
    this.cDry = ctx.createGain();
    this.cWet = ctx.createGain();
    this.cOut = ctx.createGain();
    this.dOut.connect(this.cDry).connect(this.cOut);
    this.cLfo = ctx.createOscillator();
    this.cLfo.type = 'triangle';
    this.cLfo2 = ctx.createOscillator();
    this.cLfo2.type = 'triangle';
    const merger = ctx.createChannelMerger(2);
    this.cDelays = [0, 1].map((side) => {
      const dl = ctx.createDelay(0.1);
      dl.delayTime.value = 0.022;
      const depth = ctx.createGain();
      (side ? this.cLfo2 : this.cLfo).connect(depth).connect(dl.delayTime);
      this.dOut.connect(dl);
      dl.connect(merger, 0, side);
      return { dl, depth };
    });
    merger.connect(this.cWet).connect(this.cOut);
    this.cLfo.start();
    this.cLfo2.start();

    // Delay with filtered feedback, so repeats get darker like tape.
    this.eDry = ctx.createGain();
    this.eWet = ctx.createGain();
    this.eOut = ctx.createGain();
    this.eDelay = ctx.createDelay(2);
    this.eFb = ctx.createGain();
    this.eDamp = ctx.createBiquadFilter();
    this.eDamp.type = 'lowpass';
    this.eDamp.frequency.value = 4500;
    this.eDamp.Q.value = -3; // no resonant peak, so the loop never gains level
    // A soft limiter inside the loop: even at full feedback the repeats can't
    // run away, they just saturate.
    this.eSat = ctx.createWaveShaper();
    this.eSat.curve = makeShaperCurve('soft', 1);
    this.cOut.connect(this.eDry).connect(this.eOut);
    this.cOut.connect(this.eDelay);
    this.eDelay.connect(this.eDamp).connect(this.eFb).connect(this.eSat).connect(this.eDelay);
    this.eDamp.connect(this.eWet).connect(this.eOut);

    // Reverb
    this.rDry = ctx.createGain();
    this.rWet = ctx.createGain();
    this.rConv = ctx.createConvolver();
    this.eOut.connect(this.rDry).connect(this.output);
    this.rConv.connect(this.rWet).connect(this.output);
    this._rConnected = false;
    this._irKey = '';
    this._shaperKey = '';

    this.set(settings);
  }

  set(settings = {}) {
    for (const k of Object.keys(settings)) Object.assign(this.s[k] || (this.s[k] = {}), settings[k]);
    const t = this.ctx.currentTime;
    const ramp = (param, v) => param.setTargetAtTime(v, t, 0.02);
    const { distortion: d, chorus: c, delay: e, reverb: r } = this.s;

    // Distortion: Gain drives the shaper, Tone opens a low-pass, Level sets output.
    const drive = 1 + (d.gain / 100) * 30;
    const shaperKey = `${d.type}:${d.gain}`;
    if (shaperKey !== this._shaperKey) { this._shaperKey = shaperKey; this.dShaper.curve = makeShaperCurve(d.type, drive); }
    ramp(this.dTone.frequency, 600 * Math.pow(30, d.tone / 100));
    ramp(this.dLevel.gain, d.on ? (d.level / 100) * 0.9 : 0);
    ramp(this.dDry.gain, d.on ? 0 : 1);

    // Chorus: Rate 0.1–1 Hz (as on the FM-1), Depth sweeps up to ±8 ms.
    const rate = 0.1 + (c.rate / 100) * 0.9;
    ramp(this.cLfo.frequency, rate);
    ramp(this.cLfo2.frequency, rate * 1.11);
    for (const { depth } of this.cDelays) ramp(depth.gain, (c.depth / 100) * 0.008);
    ramp(this.cWet.gain, c.on ? (c.mix / 100) * 1.1 : 0);
    ramp(this.cDry.gain, c.on ? 1 - (c.mix / 100) * 0.5 : 1);

    // Delay: Rate up means a shorter gap, 0.8 s down to 0.1 s (as on the FM-1).
    ramp(this.eDelay.delayTime, 0.8 - (e.rate / 100) * 0.7);
    ramp(this.eFb.gain, (e.feedback / 100) * 0.92); // with the soft limiter in the loop, this rings long but never runs away
    ramp(this.eWet.gain, e.on ? (e.mix / 100) : 0);
    ramp(this.eDry.gain, 1);

    // Reverb: rebuild the room only when its shape changes.
    const key = `${r.type}:${Math.round(r.decay / 5)}`;
    if (key !== this._irKey) {
      this._irKey = key;
      clearTimeout(this._irTimer);
      this._irTimer = setTimeout(() => { this.rConv.buffer = makeImpulse(this.ctx, r.type, r.decay); }, this.rConv.buffer ? 120 : 0);
    }
    // The convolver is the most expensive node on the page, so it only runs
    // while reverb is on.
    if (r.on && !this._rConnected) { this.eOut.connect(this.rConv); this._rConnected = true; }
    if (!r.on && this._rConnected) {
      clearTimeout(this._rOffTimer);
      this._rOffTimer = setTimeout(() => {
        if (!this.s.reverb.on && this._rConnected) { this.eOut.disconnect(this.rConv); this._rConnected = false; }
      }, 4000);
    }
    ramp(this.rWet.gain, r.on ? (r.mix / 100) * 1.4 : 0);
    ramp(this.rDry.gain, r.on ? 1 - (r.mix / 100) * 0.4 : 1);
  }

  disconnect() {
    try { this.cLfo.stop(); this.cLfo2.stop(); } catch (_) { /* already stopped */ }
    this.output.disconnect();
  }
}
