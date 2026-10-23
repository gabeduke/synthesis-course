// <voice-stack> — draws the seven oscillators that Super adds, each in its own
// lane, and the single wave they add up to. The lanes are drawn in the frame
// of the centre oscillator, so the side copies visibly slide past it at their
// real speed: the difference between their frequencies.
//
// <hero-stack> — the same picture, bigger and simpler, for the home page.

import { audio, resume, midiToHz } from '../audio/core.js';
import { VASynth } from '../audio/va-synth.js';
import { OFFSETS, CENTER, mixLevels, detuneCurve, normalize } from '../audio/supersaw.js';
import { el, makeControl } from '../ui/controls.js';
import { onFrame, fit, colors, grid, alpha, lineScale, drawHistory, headBand } from '../ui/draw.js';
import { registerInstrument } from '../ui/keyboard.js';
import { prefersReducedMotion } from '../audio/core.js';

const WAVE = {
  saw: (x) => 2 * (x - Math.floor(x + 0.5)),
  square: (x) => (x - Math.floor(x) < 0.5 ? 1 : -1),
  tri: (x) => 1 - 4 * Math.abs(x - Math.floor(x + 0.5)),
  sine: (x) => Math.sin(2 * Math.PI * x),
};

export function stackState(waveform, superV, detuneV, note = 45) {
  const f = midiToHz(note);
  const { center, side } = mixLevels(superV / 100);
  const norm = normalize(center, side, detuneV);
  const amt = detuneCurve(detuneV / 100);
  const oscs = OFFSETS.map((o, i) => ({
    ratio: 1 + o * amt,
    gain: (i === CENTER ? center : side) * norm,
    // How fast this copy slides against the centre, in cycles per second.
    slip: o * amt * f,
  }));
  return { f, oscs, fn: WAVE[waveform] || WAVE.saw };
}

// Draw `cycles` cycles of the centre oscillator with every copy at time t.
export function drawStack(g, x0, y0, w, h, state, t, phases, { lanes = true, overlay = false, cycles = 2, c, sumColor, sumWidth = 2.5, k = 1 }) {
  const lk = lineScale(k);
  const { oscs, fn } = state;
  const laneH = lanes ? (h * 0.6) / 7 : 0;
  const sumTop = lanes ? y0 + h * 0.64 : y0;
  const sumH = lanes ? h * 0.36 : h;
  const N = Math.max(200, Math.floor(w));

  if (lanes) {
    // A faint baseline for each lane, and a rule between the lanes and the sum.
    g.strokeStyle = c.grid; g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < oscs.length; i++) { const y = Math.round(y0 + laneH * (i + 0.5)) + 0.5; g.moveTo(x0, y); g.lineTo(x0 + w, y); }
    g.stroke();
    g.strokeStyle = c.axis;
    g.beginPath(); g.moveTo(x0, Math.round(y0 + h * 0.62) + 0.5); g.lineTo(x0 + w, Math.round(y0 + h * 0.62) + 0.5); g.stroke();
    oscs.forEach((o, i) => {
      const mid = y0 + laneH * (i + 0.5);
      const amp = laneH * 0.42;
      g.globalAlpha = i === CENTER ? 1 : 0.25 + 0.75 * Math.min(1, o.gain * 2.5);
      g.strokeStyle = i === CENTER ? c.ink : c.sound;
      g.lineWidth = (i === CENTER ? 1.7 : 1.4) * lk;
      g.lineJoin = 'round';
      g.beginPath();
      for (let j = 0; j <= N; j++) {
        const x = (j / N) * cycles;
        const ph = x * o.ratio + phases[i] + o.slip * t;
        const y = mid - fn(ph) * amp * (o.gain > 0.001 || i === CENTER ? 1 : 0);
        const px = x0 + (j / N) * w;
        if (j === 0) g.moveTo(px, y); else g.lineTo(px, y);
      }
      g.stroke();
    });
    g.globalAlpha = 1;
  }

  if (overlay) {
    const amp = (h * 0.44) / 1.6;
    oscs.forEach((o, i) => {
      if (i !== CENTER && o.gain < 0.001) return;
      g.globalAlpha = i === CENTER ? 0.55 : 0.32;
      g.strokeStyle = i === CENTER ? c.ink : c.sound;
      g.lineWidth = 1.2 * lk;
      g.beginPath();
      for (let j = 0; j <= N; j++) {
        const x = (j / N) * cycles;
        const y = y0 + h / 2 - fn(x * o.ratio + phases[i] + o.slip * t) * amp * 0.9;
        const px = x0 + (j / N) * w;
        if (j === 0) g.moveTo(px, y); else g.lineTo(px, y);
      }
      g.stroke();
    });
    g.globalAlpha = 1;
  }

  // The sum: what you actually hear.
  const vals = new Float32Array(N + 1);
  let peak = 0.0001;
  for (let j = 0; j <= N; j++) {
    const x = (j / N) * cycles;
    let s = 0;
    oscs.forEach((o, i) => { s += o.gain * fn(x * o.ratio + phases[i] + o.slip * t); });
    vals[j] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  const scale = (sumH * 0.44) / 1.6;
  const col = sumColor || c.sound;
  g.lineJoin = 'round';
  g.beginPath();
  for (let j = 0; j <= N; j++) {
    const px = x0 + (j / N) * w;
    const y = sumTop + sumH / 2 - vals[j] * scale;
    if (j === 0) g.moveTo(px, y); else g.lineTo(px, y);
  }
  // The sum is what you hear: a soft wash under a strong line.
  g.strokeStyle = alpha(col, c.dark ? 0.18 : 0.1);
  g.lineWidth = sumWidth * lk * 3;
  g.stroke();
  g.strokeStyle = col;
  g.lineWidth = sumWidth * lk;
  g.stroke();
  return { sumTop, sumH, peak };
}

function randomPhases() { return OFFSETS.map(() => Math.random()); }
const inStep = () => OFFSETS.map(() => 0);

class VoiceStack extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.p = { waveform: this.getAttribute('waveform') || 'saw', super: Number(this.getAttribute('super') ?? 70), detune: Number(this.getAttribute('detune') ?? 40) };
    this.note = 45;
    // On the FM-1 every note starts its seven copies in step.
    this.phases = inStep();
    this.t0 = performance.now();
    this.paused = prefersReducedMotion();
    this.levels = new Float32Array(300);
    this.levelPos = 0;
    this._build();
    registerInstrument(this);
  }

  get root() { return this; }

  _build() {
    const box = el('section', { class: 'instrument', 'aria-label': 'Super and Detune, voice by voice' });
    box.append(el('div', { class: 'instrument-head' }, [
      el('h3', { text: 'Seven voices, one sound' }),
      el('p', { text: 'Top: each oscillator on its own line, with the centre one in black. Bottom: what they add up to.' }),
    ]));
    this.canvas = el('canvas', { role: 'img', 'aria-label': 'Seven oscillator waveforms and their sum' });
    this.beat = el('canvas', { role: 'img', 'aria-label': 'Loudness of the sum over time' });
    this.readout = el('div', { class: 'viz-legend' });
    box.append(el('div', { class: 'viz', style: 'height:300px' }, [this.canvas, el('div', { class: 'viz-label', text: 'Oscillators, slowed to the eye but sliding at their real speed' }), this.readout]));
    box.append(el('div', { class: 'viz', style: 'height:90px' }, [this.beat, el('div', { class: 'viz-label', text: 'Peak level of the sum over the last few seconds' })]));

    const ctl = el('div', { class: 'controls' });
    const onChange = (k, v) => {
      this.p[k] = v;
      this.synth?.set({ [k]: v });
    };
    ctl.append(makeControl('waveform', this.p.waveform, onChange), makeControl('super', this.p.super, onChange), makeControl('detune', this.p.detune, onChange));
    box.append(ctl);

    const play = el('button', { class: 'btn primary', type: 'button', 'aria-pressed': 'false', text: 'Hear it' });
    play.addEventListener('click', () => {
      const on = play.getAttribute('aria-pressed') !== 'true';
      play.setAttribute('aria-pressed', String(on));
      play.textContent = on ? 'Stop' : 'Hear it';
      // The button always plays A2 and stops everything when turned off, so
      // notes played on the keys in between can't leave it droning.
      if (on) this.noteOn(45, 0.8); else { this.synth?.allOff(); this.playing = 0; }
    });
    this.playBtn = play;
    const restart = el('button', { class: 'btn', type: 'button', text: 'Start in step' });
    restart.title = 'Start every copy at the same point in its cycle, as a new note does on the FM-1';
    restart.addEventListener('click', () => { this.phases = inStep(); this.t0 = performance.now(); });
    const scatter = el('button', { class: 'btn', type: 'button', text: 'Scatter them' });
    scatter.title = 'Start each copy at a random point, as the JP-8000’s free-running oscillators did';
    scatter.addEventListener('click', () => { this.phases = randomPhases(); this.t0 = performance.now(); });
    const pause = el('button', { class: 'btn', type: 'button', 'aria-pressed': String(this.paused), text: this.paused ? 'Resume motion' : 'Pause motion' });
    pause.addEventListener('click', () => {
      this.paused = !this.paused;
      if (!this.paused) this.t0 = performance.now() - (this.frozenAt || 0) * 1000;
      pause.setAttribute('aria-pressed', String(this.paused));
      pause.textContent = this.paused ? 'Resume motion' : 'Pause motion';
    });
    box.append(el('div', { class: 'instrument-foot' }, [play, restart, scatter, el('span', { class: 'grow' }), pause]));
    this.append(box);

    onFrame(this.canvas, () => this._draw());
  }

  ensure() {
    if (this.synth) return this.synth;
    const { ctx, master } = audio();
    this.synth = new VASynth({ ...this.p, cutoff: 9000, release: 30 }, { fx: false });
    this.synth.output.connect(master);
    return this.synth;
  }

  noteOn(note, vel) {
    resume();
    this.note = note;
    this.phases = inStep();
    this.t0 = performance.now();
    this.ensure().noteOn(note, vel);
    this.playing = (this.playing || 0) + 1;
  }

  noteOff(note) {
    this.synth?.noteOff(note);
    this.playing = Math.max(0, (this.playing || 0) - 1);
  }

  _draw() {
    const c = colors();
    const t = this.paused ? (this.frozenAt ?? 0) : (performance.now() - this.t0) / 1000;
    if (!this.paused) this.frozenAt = t;
    const state = stackState(this.p.waveform, this.p.super, this.p.detune, this.note);

    const { g, w, h, k } = fit(this.canvas);
    g.clearRect(0, 0, w, h);
    grid(g, w, h, 6, 1);
    const top = headBand(g) + 2 * k;
    const { peak } = drawStack(g, 12 * k, top, w - 24 * k, h - top - 8 * k, state, t, this.phases, { c, k });

    const spread = state.oscs.map((o) => 1200 * Math.log2(o.ratio));
    const maxCents = Math.max(...spread.map(Math.abs));
    const beat = Math.max(...state.oscs.map((o) => Math.abs(o.slip)));
    const text = this.p.super <= 0
      ? 'Super is 0: only the centre oscillator sounds'
      : maxCents < 0.5 ? 'Detune is 0: all seven copies sit on the same pitch'
        : `Spread ±${maxCents.toFixed(1)} cents · fastest slip ${beat.toFixed(2)} Hz at ${state.f.toFixed(0)} Hz`;
    if (this.readout.textContent !== text) this.readout.textContent = text;

    // Level history: the slow swell and fade that detuning makes.
    this.levels[this.levelPos] = peak;
    this.levelPos = (this.levelPos + 1) % this.levels.length;
    const b = fit(this.beat);
    b.g.clearRect(0, 0, b.w, b.h);
    const bt = headBand(b.g) - 2;
    grid(b.g, b.w, b.h, 6, 1, { top: bt, bottom: 6 });
    drawHistory(b.g, b.w, b.h, this.levels, this.levelPos, { color: c.sound, gain: 1 / 1.6, lineWidth: 2, top: bt, bottom: 6 });
  }
}

customElements.define('voice-stack', VoiceStack);

// ---------- Home page hero ----------
class HeroStack extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.phases = randomPhases();
    this.t0 = performance.now() - 4000;
    this.still = prefersReducedMotion();
    this.amount = 0; // eases from one saw to a full supersaw
    this.target = 1;
    this.canvas = el('canvas', { role: 'img', 'aria-label': 'Seven sawtooth waves stacking into a supersaw' });
    const hint = el('p', { class: 'hint' });
    hint.innerHTML = 'Click to hear a chord built this way. After that, <kbd>A</kbd> to <kbd>K</kbd> play it too.';
    this.className = 'hero-scope';
    this.append(this.canvas, hint);
    this.tabIndex = 0;
    this.setAttribute('role', 'button');
    this.setAttribute('aria-label', 'Play a supersaw chord');
    this.baseNote = 48;
    registerInstrument(this);

    const chord = [48, 55, 60, 64, 67];
    const toggle = () => {
      resume();
      this.on = !this.on;
      for (const n of chord) this.on ? this.noteOn(n, 0.7) : this.noteOff(n);
    };
    this.addEventListener('click', toggle);
    this.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    onFrame(this.canvas, () => this._draw());
  }

  get root() { return this; }

  ensure() {
    if (this.synth) return this.synth;
    const { master } = audio();
    this.synth = new VASynth({
      waveform: 'saw', super: 80, detune: 45, cutoff: 5200, resonance: 10, attack: 30, release: 60,
      fx: { chorus: { on: true, mix: 30 }, reverb: { on: true, type: 'hall', decay: 55, mix: 32 } },
    });
    this.synth.output.connect(master);
    return this.synth;
  }

  noteOn(n, v) { this.ensure().noteOn(n, v); this.lit = performance.now(); }
  noteOff(n) { this.synth?.noteOff(n); }

  _draw() {
    const c = colors();
    const { g, w, h } = fit(this.canvas);
    g.clearRect(0, 0, w, h);
    const t = this.still ? 0 : (performance.now() - this.t0) / 1000;
    // Slowly build up from a single saw to the full stack, then hold.
    this.amount += (this.target - this.amount) * (this.still ? 1 : 0.012);
    const sup = 80 * this.amount;
    const state = stackState('saw', sup, 45, 40);
    const pad = Math.max(18, w * 0.03);
    drawStack(g, pad, h * 0.06, w - pad * 2, h * 0.8, state, t, this.phases, { lanes: false, overlay: true, cycles: 2.5, c, sumColor: c.sound, sumWidth: 3.2 });
  }
}

customElements.define('hero-stack', HeroStack);
