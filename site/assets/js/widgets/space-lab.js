// <space-lab> — play the same short note four ways and plot its loudness over
// time. Pitch tricks (Super + Detune) only last as long as the note. Time
// tricks (chorus, delay, reverb) keep going after it, because they're made of
// copies of the sound that arrive later.

import { audio, resume } from '../audio/core.js';
import { VASynth } from '../audio/va-synth.js';
import { el } from '../ui/controls.js';
import { onFrame, fit, colors, grid, drawWave, makeAnalyser, rms } from '../ui/draw.js';
import { fm1 } from '../hw/fm1.js';

const BASE = { waveform: 'saw', cutoff: 3200, resonance: 8, attack: 0, decay: 50, sustain: 80, release: 0 };
const MODES = [
  { id: 'dry', label: 'Dry', color: 'ink3', dash: [], p: {} },
  { id: 'super', label: 'Super + Detune', color: 'sound', dash: [], p: { super: 85, detune: 55 } },
  { id: 'chorus', label: 'Chorus', color: 'move', dash: [6, 4], p: { fx: { chorus: { on: true, rate: 35, depth: 70, mix: 60 } } } },
  { id: 'delay', label: 'Delay', color: 'time', dash: [2, 3], p: { fx: { delay: { on: true, rate: 55, feedback: 45, mix: 45 } } } },
  { id: 'reverb', label: 'Reverb', color: 'space', dash: [], p: { fx: { reverb: { on: true, type: 'hall', decay: 55, mix: 55 } } } },
];
const SECONDS = 3.2;
const NOTE_LEN = 0.35;

class SpaceLab extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.traces = new Map();
    this.current = null;
    const box = el('section', { class: 'instrument', 'aria-label': 'Detune, chorus, delay and reverb compared' });
    box.append(el('div', { class: 'instrument-head' }, [
      el('h3', { text: 'Same note, five treatments' }),
      el('p', { text: 'Each button plays a short note and plots how loud it is for the next three seconds.' }),
    ]));
    this.plot = el('canvas', { role: 'img', 'aria-label': 'Loudness over time for each treatment' });
    this.scope = el('canvas', { role: 'img', 'aria-label': 'Live waveform' });
    this.legend = el('div', { class: 'viz-legend' });
    box.append(el('div', { class: 'viz', style: 'height:250px' }, [this.plot, el('div', { class: 'viz-label', text: 'Loudness (dB) after the key goes down' }), this.legend]));
    box.append(el('div', { class: 'viz', style: 'height:130px' }, [this.scope, el('div', { class: 'viz-label', text: 'Waveform right now' })]));

    const buttons = MODES.map((m) => {
      const b = el('button', { class: 'btn', type: 'button', text: m.label });
      b.style.borderColor = `var(--${m.color === 'ink3' ? 'ink-3' : m.color})`;
      b.addEventListener('click', () => this.play(m));
      return b;
    });
    const long = el('input', { type: 'checkbox', id: `long-${Math.random().toString(36).slice(2, 7)}` });
    long.addEventListener('change', () => { this.noteLen = long.checked ? 1.4 : NOTE_LEN; });
    this.noteLen = NOTE_LEN;
    const clear = el('button', { class: 'btn', type: 'button', text: 'Clear' });
    clear.addEventListener('click', () => { this.traces.clear(); });
    box.append(el('div', { class: 'instrument-foot' }, [
      ...buttons,
      el('span', { class: 'grow' }),
      el('label', { class: 'switch', for: long.id }, [long, el('span', { text: 'Longer note' })]),
      clear,
    ]));
    this.append(box);
    onFrame(this.plot, () => this.drawPlot());
    onFrame(this.scope, () => this.drawScope());
  }

  play(mode) {
    resume();
    const { ctx, master } = audio();
    if (!this.analyser) { this.analyser = makeAnalyser(ctx, 2048, 0); this.analyser.connect(master); }
    this.synth?.dispose();
    this.synth = new VASynth({ ...BASE, ...mode.p, fx: { ...mode.p.fx } });
    this.synth.output.connect(this.analyser);
    // Give the reverb's room a moment to build before the note.
    setTimeout(() => {
      this.synth.playNote(52, this.noteLen, 0.85);
      this.current = { mode, start: performance.now(), data: [], len: this.noteLen };
      this.traces.set(mode.id, this.current);
    }, 160);
  }

  drawPlot() {
    const c = colors();
    const { g, w, h } = fit(this.plot);
    g.clearRect(0, 0, w, h);
    grid(g, w, h, 8, 4);
    const pad = { l: 38, r: 12, t: 34, b: 24 };
    const X = (t) => pad.l + (t / SECONDS) * (w - pad.l - pad.r);
    const Y = (db) => pad.t + (-db / 60) * (h - pad.t - pad.b);

    // Record the running trace.
    if (this.current && this.analyser) {
      const t = (performance.now() - this.current.start) / 1000;
      if (t <= SECONDS) {
        const level = rms(this.analyser);
        this.current.data.push([t, 20 * Math.log10(Math.max(1e-5, level / 0.25))]);
      } else this.current = null;
    }

    // Axes
    g.fillStyle = c.ink3;
    g.font = '10px Archivo, sans-serif';
    for (const db of [0, -20, -40, -60]) g.fillText(`${db}`, 6, Y(db) + 3);
    for (let s = 0; s <= 3; s++) g.fillText(`${s} s`, X(s) - 6, h - 6);
    const len = this.current?.len ?? [...this.traces.values()].pop()?.len ?? this.noteLen;
    g.strokeStyle = c.ink2;
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(X(len), pad.t); g.lineTo(X(len), h - pad.b); g.stroke();
    g.setLineDash([]);
    g.fillStyle = c.ink2;
    g.fillText('key released', X(len) + 5, h - pad.b - 6);

    for (const tr of this.traces.values()) {
      const col = c[tr.mode.color];
      g.strokeStyle = col;
      g.lineWidth = tr === this.current ? 2.4 : 1.8;
      g.setLineDash(tr.mode.dash);
      g.beginPath();
      tr.data.forEach(([t, db], i) => {
        const y = Y(Math.max(-60, Math.min(0, db)));
        if (i === 0) g.moveTo(X(t), y); else g.lineTo(X(t), y);
      });
      g.stroke();
      g.setLineDash([]);
    }
    const key = [...this.traces.keys()].join('|');
    if (this.legend.dataset.key !== key) {
      this.legend.dataset.key = key;
      this.legend.replaceChildren(...[...this.traces.values()].map((tr) => el('span', {}, [Object.assign(el('i'), { style: `background:var(--${tr.mode.color === 'ink3' ? 'ink-3' : tr.mode.color})` }), tr.mode.label])));
    }
  }

  drawScope() {
    const c = colors();
    const { g, w, h } = fit(this.scope);
    g.clearRect(0, 0, w, h);
    grid(g, w, h, 8, 2);
    if (fm1.analyser) drawWave(g, w, h, fm1.analyser, { color: c.hw, span: 1400, lineWidth: 1.4 });
    if (this.analyser) drawWave(g, w, h, this.analyser, { color: this.current ? c[this.current.mode.color] : c.sound, span: 1400, gain: 1.6 });
  }
}

customElements.define('space-lab', SpaceLab);
