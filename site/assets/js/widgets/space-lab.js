// <space-lab> — play the same short note four ways and plot its loudness over
// time. Pitch tricks (Super + Detune) only last as long as the note. Time
// tricks (chorus, delay, reverb) keep going after it, because they're made of
// copies of the sound that arrive later.

import { audio, resume } from '../audio/core.js';
import { VASynth } from '../audio/va-synth.js';
import { el } from '../ui/controls.js';
import {
  onFrame, fit, colors, grid, drawWave, makeAnalyser, rms, layer, font, idle, quietFor, setLegend, dot, backgroundOf, lineScale, haloText, headBand,
} from '../ui/draw.js';
import { fm1 } from '../hw/fm1.js';

const BASE = { waveform: 'saw', cutoff: 3200, resonance: 8, attack: 0, decay: 50, sustain: 80, release: 0 };
const MODES = [
  { id: 'dry', label: 'Dry', color: 'ink3', dash: [], p: {} },
  { id: 'super', label: 'Super + Detune', color: 'sound', dash: [], p: { super: 85, detune: 55 } },
  { id: 'chorus', label: 'Chorus', color: 'move', dash: [6, 4], key: 'dash', p: { fx: { chorus: { on: true, rate: 35, depth: 70, mix: 60 } } } },
  { id: 'delay', label: 'Delay', color: 'time', dash: [2, 3], key: 'dot', p: { fx: { delay: { on: true, rate: 55, feedback: 45, mix: 45 } } } },
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
    box.append(el('div', { class: 'viz', style: 'height:250px' }, [this.plot, el('div', { class: 'viz-label' }, ['Loudness', el('span', { class: 'more', text: ' (dB) after the key goes down' })]), this.legend]));
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
    onFrame(this.scope, (now) => this.drawScope(now));
  }

  play(mode) {
    resume();
    const { ctx, master } = audio();
    if (!this.analyser) { this.analyser = makeAnalyser(ctx, 2048, 0); this.analyser.connect(master); }
    clearTimeout(this.pending);
    this.synth?.dispose(0.08);
    const synth = new VASynth({ ...BASE, ...mode.p, fx: { ...mode.p.fx } });
    synth.output.connect(this.analyser);
    this.synth = synth;
    this.current = null;
    // Give the reverb's room a moment to build before the note.
    this.pending = setTimeout(() => {
      synth.playNote(52, this.noteLen, 0.85);
      this.current = { mode, start: performance.now(), data: [], len: this.noteLen };
      this.traces.set(mode.id, this.current);
    }, 200);
  }

  drawPlot() {
    const c = colors();
    const { g, w, h, k } = fit(this.plot);
    const lk = lineScale(k);
    g.clearRect(0, 0, w, h);
    const pad = { l: Math.round(44 * k), r: Math.round(14 * k), t: headBand(g) + Math.round(8 * k), b: Math.round(24 * k) };
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

    // Axes, on the plot's own grid: every 10 dB and every half second.
    layer(g, w, h, 'axes', (lg, W, H) => {
      lg.lineWidth = 1;
      lg.strokeStyle = c.grid;
      lg.beginPath();
      for (let db = -10; db >= -50; db -= 10) { const y = Math.round(Y(db)) + 0.5; lg.moveTo(pad.l, y); lg.lineTo(W - pad.r, y); }
      for (let s = 0.5; s < SECONDS; s += 0.5) { const x = Math.round(X(s)) + 0.5; lg.moveTo(x, pad.t); lg.lineTo(x, H - pad.b); }
      lg.stroke();
      lg.strokeStyle = c.axis;
      lg.beginPath();
      const yb = Math.round(Y(-60)) + 0.5; const xl = Math.round(X(0)) + 0.5;
      lg.moveTo(xl, pad.t); lg.lineTo(xl, yb); lg.lineTo(W - pad.r, yb);
      lg.stroke();
      lg.font = font(10 * k);
      lg.fillStyle = c.ink3;
      lg.textAlign = 'right'; lg.textBaseline = 'middle';
      for (const db of [0, -20, -40, -60]) lg.fillText(db === 0 ? '0 dB' : `−${-db}`, pad.l - 7 * k, Y(db));
      lg.textAlign = 'center'; lg.textBaseline = 'middle';
      for (let s = 0; s <= 3; s++) lg.fillText(`${s} s`, X(s), H - pad.b / 2 + 1);
      lg.textAlign = 'start'; lg.textBaseline = 'alphabetic';
    });
    const len = this.current?.len ?? [...this.traces.values()].pop()?.len ?? this.noteLen;
    const xr = Math.round(X(len)) + 0.5;
    g.strokeStyle = c.ink3; g.lineWidth = 1;
    g.setLineDash([3 * k, 3 * k]);
    g.beginPath(); g.moveTo(xr, pad.t); g.lineTo(xr, h - pad.b); g.stroke();
    g.setLineDash([]);
    g.font = font(10 * k);
    haloText(g, 'key released', xr + 6 * k, h - pad.b - 7 * k, c.ink2, backgroundOf(this.plot), 3);

    if (!this.traces.size) idle(g, w, h, 'Press a treatment below to play a note and plot it');
    for (const tr of this.traces.values()) {
      const col = c[tr.mode.color];
      const line = new Path2D();
      let last = null;
      tr.data.forEach(([t, db], i) => {
        const p = [X(t), Y(Math.max(-60, Math.min(0, db)))];
        if (i === 0) line.moveTo(...p); else line.lineTo(...p);
        last = p;
      });
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.strokeStyle = col;
      g.lineWidth = (tr === this.current ? 2.4 : 1.8) * lk;
      g.setLineDash(tr.mode.dash.map((d) => d * k));
      g.stroke(line);
      g.setLineDash([]); g.lineCap = 'butt';
      if (tr === this.current && last) dot(g, last[0], last[1], 4 * lk, col, backgroundOf(this.plot));
    }
    setLegend(this.legend, [...this.traces.values()].map((tr) => [tr.mode.label, c[tr.mode.color], tr.mode.key]));
  }

  drawScope(now) {
    const c = colors();
    const { g, w, h } = fit(this.scope);
    g.clearRect(0, 0, w, h);
    grid(g, w, h, 8, 2);
    let peak = 0;
    if (fm1.analyser) peak = drawWave(g, w, h, fm1.analyser, { color: c.hw, span: 1400, lineWidth: 1.4 });
    if (this.analyser) peak = Math.max(peak, drawWave(g, w, h, this.analyser, { color: this.current ? c[this.current.mode.color] : c.sound, span: 1400, gain: 1.6 }));
    if (quietFor(this._quiet ||= {}, peak > 1e-4, now)) idle(g, w, h, 'Waiting for a note', { y: h * 0.3 });
  }
}

customElements.define('space-lab', SpaceLab);
