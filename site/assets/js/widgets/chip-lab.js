// <chip-lab> — an 8-Bit lead in the style of the FM-1+VA's 8-Bit engine:
// four pulse widths, a stepped 4-bit triangle, console-style noise, and fast
// arpeggios that fake chords on a voice that can only play one note at a time.

import { audio, resume, midiToHz, noteName } from '../audio/core.js';
import { el, makeControl } from '../ui/controls.js';
import { Keyboard, registerInstrument } from '../ui/keyboard.js';
import { onFrame, fit, colors, grid, drawWave, drawSpectrum, freqGrid, makeAnalyser } from '../ui/draw.js';
import { fm1 } from '../hw/fm1.js';

// A few of the FM-1+VA's 31 built-in arpeggios, in semitones from the key.
export const ARPS = {
  Off: [0],
  Major: [0, 4, 7],
  Minor: [0, 3, 7],
  'Major 8': [0, 4, 7, 12],
  'Minor 8': [0, 3, 7, 12],
  Octave: [0, 12],
  Fifth: [0, 7],
  Power: [0, 7, 12, 19],
  'Major Up Down': [0, 4, 7, 12, 7, 4],
  'Trill 2': [0, 2],
  Bounce: [0, 12, 0, -12],
};
const SPEEDS = { '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125, '1/32T': 1 / 12, '1/64T': 1 / 24 };
const WAVES = ['Pulse 12.5', 'Pulse 25', 'Pulse 50', 'Pulse 75', 'Triangle', 'GB Saw', 'Noise', 'Metal'];

const waveCache = new Map();

function pulseWave(ctx, duty) {
  const N = 96;
  const real = new Float32Array(N); const imag = new Float32Array(N);
  for (let n = 1; n < N; n++) {
    const th = 2 * Math.PI * n * duty;
    real[n] = (2 * Math.sin(th)) / (Math.PI * n);
    imag[n] = (2 * (1 - Math.cos(th))) / (Math.PI * n);
  }
  return ctx.createPeriodicWave(real, imag);
}

// A wave from a short table of 4-bit samples (0–15), like the console's
// stepped triangle or the Game Boy's 32-sample wave channel.
function tableWave(ctx, samples) {
  const L = samples.length;
  const N = 128;
  const real = new Float32Array(N); const imag = new Float32Array(N);
  const x = samples.map((s) => s / 7.5 - 1);
  for (let n = 1; n < N; n++) {
    let re = 0; let im = 0;
    for (let k = 0; k < L; k++) {
      // Each sample is a flat step one table slot long.
      const a = (2 * Math.PI * n * k) / L; const b = (2 * Math.PI * n * (k + 1)) / L;
      re += x[k] * (Math.sin(b) - Math.sin(a)) / (Math.PI * n);
      im += x[k] * (Math.cos(a) - Math.cos(b)) / (Math.PI * n);
    }
    real[n] = re; imag[n] = im;
  }
  return ctx.createPeriodicWave(real, imag);
}

function waveFor(ctx, name) {
  if (waveCache.has(name)) return waveCache.get(name);
  let w;
  if (name.startsWith('Pulse')) w = pulseWave(ctx, Number(name.split(' ')[1]) / 100);
  else if (name === 'Triangle') {
    const tri = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    w = tableWave(ctx, tri);
  } else if (name === 'GB Saw') w = tableWave(ctx, Array.from({ length: 32 }, (_, i) => Math.floor(i / 2)));
  waveCache.set(name, w);
  return w;
}

// Console-style noise: a linear-feedback shift register. The long mode hisses;
// the short mode repeats every 93 steps and rings with a metallic pitch.
function lfsrBuffer(ctx, short) {
  const key = short ? 'metal' : 'noise';
  if (waveCache.has(key)) return waveCache.get(key);
  let reg = 1;
  const len = short ? 93 * 64 : 32767;
  const buf = ctx.createBuffer(1, len, 44100);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const bit = (reg ^ (reg >> (short ? 6 : 1))) & 1;
    reg = (reg >> 1) | (bit << 14);
    d[i] = reg & 1 ? 0.8 : -0.8;
  }
  waveCache.set(key, buf);
  return buf;
}

class ChipLab extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.p = { wave: this.getAttribute('wave') || 'Pulse 25', arp: this.getAttribute('arp') || 'Off', speed: this.getAttribute('speed') || '1/32', tempo: 120, decay: 60, vibrato: 0, tone: 'smooth' };
    this.baseNote = 60;
    this.stack = [];
    this._build();
    registerInstrument(this);
  }

  get root() { return this; }

  _build() {
    const box = el('section', { class: 'instrument', 'aria-label': '8-Bit lead' });
    box.append(el('div', { class: 'instrument-head' }, [
      el('h3', { text: this.getAttribute('heading') || 'An 8-Bit lead' }),
      el('p', { text: this.getAttribute('intro') || 'One voice, one note at a time, like a console channel.' }),
    ]));
    this.wave = el('canvas', { role: 'img', 'aria-label': 'Waveform' });
    this.spec = el('canvas', { role: 'img', 'aria-label': 'Spectrum' });
    this.legend = el('div', { class: 'viz-legend' });
    box.append(el('div', { class: 'viz-row' }, [
      el('div', { class: 'viz', style: 'height:180px' }, [this.wave, el('div', { class: 'viz-label', text: 'Waveform' }), this.legend]),
      el('div', { class: 'viz', style: 'height:180px' }, [this.spec, el('div', { class: 'viz-label', text: 'Spectrum' })]),
    ]));

    const ctl = el('div', { class: 'controls' });
    const choice = (key, label, opts, kind = 'sound') => makeControl(`chip.${key}`, this.p[key], (_, v) => { this.p[key] = v; this._live(key); }, { def: { label, type: 'choice', options: opts, names: opts, kind } });
    ctl.append(
      el('div', { class: 'control-group' }, [choice('wave', 'Wave', WAVES)]),
      el('div', { class: 'control-group' }, [el('div', { class: 'group-name', text: 'Arpeggio' }), choice('arp', 'Arpeggio', Object.keys(ARPS), 'move'), choice('speed', 'Arp speed', Object.keys(SPEEDS), 'move'),
        makeControl('chip.tempo', this.p.tempo, (_, v) => { this.p.tempo = v; }, { def: { label: 'Tempo', min: 60, max: 200, step: 1, kind: 'move', format: (v) => `${Math.round(v)} BPM` } })]),
      el('div', { class: 'control-group' }, [el('div', { class: 'group-name', text: 'Shape' }),
        makeControl('chip.decay', this.p.decay, (_, v) => { this.p.decay = v; }, { def: { label: 'Decay', min: 0, max: 99, step: 1, kind: 'time', format: (v) => (v >= 99 ? 'Hold' : `${(0.05 * Math.pow(40, v / 99)).toFixed(2)} s`) } }),
        makeControl('chip.vibrato', this.p.vibrato, (_, v) => { this.p.vibrato = v; this._live('vibrato'); }, { def: { label: 'Vibrato', min: 0, max: 99, step: 1, kind: 'move' } }),
        choice('tone', 'Tone', ['raw', 'smooth'])]),
    );
    box.append(ctl);

    this.kb = new Keyboard({ low: this.baseNote, onDown: (n, v) => this.noteOn(n, v), onUp: (n) => this.noteOff(n) });
    const demo = el('button', { class: 'btn primary', type: 'button', text: 'Play a chord progression' });
    demo.addEventListener('click', () => this.demo());
    box.append(el('div', { class: 'keys-wrap' }, [el('div', { class: 'keys-bar' }, [el('span', { text: 'Hold one key: with an arpeggio on, it plays a whole chord.' }), el('span', { class: 'grow' }), demo]), this.kb.root]));
    this.append(box);
    onFrame(this.wave, () => this.drawWave());
    onFrame(this.spec, () => this.drawSpec());
  }

  _ensure() {
    if (this.out) return;
    const { ctx, master } = audio();
    this.out = ctx.createGain();
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 90;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 14000;
    this.analyser = makeAnalyser(ctx, 8192, 0.4);
    this.out.connect(this.hp).connect(this.lp).connect(this.analyser).connect(master);
    this._live('tone');
  }

  _live(key) {
    if (!this.out) return;
    const { ctx } = audio();
    if (key === 'tone') {
      // Smooth: the FM-1's 90 Hz high-pass and 14 kHz low-pass. Raw: neither.
      const raw = this.p.tone === 'raw';
      this.hp.frequency.value = raw ? 10 : 90;
      this.lp.frequency.value = raw ? 22000 : 14000;
    }
    if (this.voice) {
      if (key === 'wave') { this._stopVoice(); if (this.stack.length) this._startVoice(this.stack[this.stack.length - 1]); }
      if (key === 'vibrato') this.voice.vib.gain.setTargetAtTime(this.p.vibrato * 0.6, ctx.currentTime, 0.02);
    }
  }

  _startVoice(note) {
    const { ctx } = audio();
    const t = ctx.currentTime + 0.005;
    const v = { note };
    const isNoise = this.p.wave === 'Noise' || this.p.wave === 'Metal';
    if (isNoise) {
      v.src = ctx.createBufferSource();
      v.src.buffer = lfsrBuffer(ctx, this.p.wave === 'Metal');
      v.src.loop = true;
      v.freqParam = v.src.playbackRate;
      v.toValue = (n) => Math.pow(2, (n - 60) / 12) * 0.5;
    } else {
      v.src = ctx.createOscillator();
      v.src.setPeriodicWave(waveFor(ctx, this.p.wave));
      v.freqParam = v.src.frequency;
      v.toValue = (n) => midiToHz(n);
    }
    v.amp = ctx.createGain();
    const level = this.p.wave === 'Triangle' ? 0.32 : isNoise ? 0.12 : 0.16;
    v.amp.gain.setValueAtTime(level, t);
    const decay = 0.05 * Math.pow(40, this.p.decay / 99);
    if (this.p.decay < 99) {
      if (this.p.tone === 'raw') {
        // The console's volume has only sixteen steps; Raw keeps them.
        const steps = new Float32Array(64);
        for (let i = 0; i < 64; i++) steps[i] = Math.round(15 * Math.exp(-3 * i / 63)) / 15 * level;
        v.amp.gain.setValueCurveAtTime(steps, t, decay * 3);
      } else v.amp.gain.setTargetAtTime(0, t, decay);
    }
    // Vibrato
    v.lfo = ctx.createOscillator();
    v.lfo.frequency.value = 5.5;
    v.vib = ctx.createGain();
    v.vib.gain.value = this.p.vibrato * 0.6;
    if (v.src.detune) v.lfo.connect(v.vib).connect(v.src.detune);
    v.lfo.start(t);
    v.src.connect(v.amp).connect(this.out);
    v.src.start(t);
    this.voice = v;
    this._arpStart(note, t);
  }

  _stopVoice() {
    const v = this.voice;
    if (!v) return;
    const { ctx } = audio();
    const t = ctx.currentTime;
    clearInterval(this.arpTimer);
    v.amp.gain.cancelScheduledValues(t);
    v.amp.gain.setTargetAtTime(0, t, 0.015);
    v.src.stop(t + 0.1); v.lfo.stop(t + 0.1);
    this.voice = null;
  }

  // Step through the arpeggio on the beat grid, scheduling a little ahead.
  _arpStart(note, t0) {
    clearInterval(this.arpTimer);
    const { ctx } = audio();
    const v = this.voice;
    v.root = note;
    v.step = 0;
    v.next = t0;
    const tick = () => {
      if (this.voice !== v) return;
      const pattern = ARPS[this.p.arp] || [0];
      const len = (60 / this.p.tempo) * SPEEDS[this.p.speed];
      while (v.next < ctx.currentTime + 0.1) {
        const off = pattern[v.step % pattern.length];
        v.freqParam.setValueAtTime(v.toValue(v.root + off), v.next);
        v.step++;
        v.next += pattern.length > 1 ? len : 0.1;
      }
    };
    tick();
    this.arpTimer = setInterval(tick, 20);
  }

  noteOn(note, vel = 0.8, source) {
    void vel; void source;
    resume();
    this._ensure();
    this.stack = this.stack.filter((n) => n !== note);
    this.stack.push(note);
    this.kb.light(note, true);
    // One voice, newest key wins, as on a console channel.
    if (this.voice) this._stopVoice();
    this._startVoice(note);
  }

  noteOff(note) {
    this.stack = this.stack.filter((n) => n !== note);
    this.kb.light(note, false);
    if (this.voice?.note !== note) return;
    this._stopVoice();
    if (this.stack.length) this._startVoice(this.stack[this.stack.length - 1]);
  }

  showHardwareNote(note, on) { this.kb.light(note, on, 'data-hw'); }

  demo() {
    resume();
    this._ensure();
    const prog = [[60, 'Major'], [57, 'Minor'], [53, 'Major'], [55, 'Major']];
    const beat = 60 / this.p.tempo;
    const prevArp = this.p.arp;
    const useArp = prevArp === 'Off' ? 'Major' : prevArp;
    let i = 0;
    clearTimeout(this.demoTimer);
    const next = () => {
      if (i > 0) this.noteOff(prog[(i - 1) % 4][0]);
      if (i >= 8) { this.p.arp = prevArp; return; }
      const [n, q] = prog[i % 4];
      // Keep the learner's arpeggio shape, but follow major/minor chords.
      this.p.arp = useArp.startsWith('Minor') && q === 'Major' ? useArp.replace('Minor', 'Major')
        : useArp.startsWith('Major') && q === 'Minor' ? useArp.replace('Major', 'Minor') : useArp;
      this.noteOn(n);
      i++;
      this.demoTimer = setTimeout(next, beat * 2 * 1000);
    };
    next();
  }

  drawWave() {
    const c = colors();
    const { g, w, h } = fit(this.wave);
    g.clearRect(0, 0, w, h);
    grid(g, w, h, 8, 4);
    if (fm1.analyser) drawWave(g, w, h, fm1.analyser, { color: c.hw, span: 700, lineWidth: 1.4 });
    if (this.analyser) drawWave(g, w, h, this.analyser, { color: c.sound, span: 700, gain: 3 });
    const txt = this.voice ? `${this.p.wave} · ${noteName(this.voice.note)}${this.p.arp !== 'Off' ? ` · ${this.p.arp} arpeggio` : ''}` : this.p.wave;
    if (this.legend.textContent !== txt) this.legend.textContent = txt;
  }

  drawSpec() {
    const c = colors();
    const { g, w, h } = fit(this.spec);
    g.clearRect(0, 0, w, h);
    freqGrid(g, w, h);
    if (fm1.analyser) drawSpectrum(g, w, h, fm1.analyser, { color: c.hw, fill: false, lineWidth: 1.2 });
    if (this.analyser) drawSpectrum(g, w, h, this.analyser, { color: c.sound });
  }
}

customElements.define('chip-lab', ChipLab);
