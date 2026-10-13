// <fm-lab> — two-operator FM. One sine (the modulator) wobbles the pitch of
// another (the carrier). When the wobble is fast enough you stop hearing it as
// vibrato and start hearing it as new tones: sidebands at carrier ± n × modulator.

import { audio, resume, midiToHz, clamp, noteName } from '../audio/core.js';
import { el, makeControl } from '../ui/controls.js';
import { Keyboard, registerInstrument } from '../ui/keyboard.js';
import { onFrame, fit, colors, grid, drawWave, drawSpectrum, freqGrid, xForFreq, makeAnalyser } from '../ui/draw.js';
import { fm1 } from '../hw/fm1.js';

class FMLab extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.p = {
      ratio: Number(this.getAttribute('ratio') ?? 1),
      index: Number(this.getAttribute('index') ?? 2),
      indexDecay: Number(this.getAttribute('index-decay') ?? 0),
      modRate: Number(this.getAttribute('mod-rate') ?? 0),
    };
    this.slow = this.hasAttribute('slow');
    this.baseNote = 48;
    this.voices = new Map();
    this.lastNote = 57;
    this._build();
    registerInstrument(this);
  }

  get root() { return this; }

  _build() {
    const box = el('section', { class: 'instrument', 'aria-label': 'Two-operator FM' });
    box.append(el('div', { class: 'instrument-head' }, [
      el('h3', { text: this.getAttribute('heading') || 'Two operators' }),
      el('p', { text: this.getAttribute('intro') || 'A modulator wobbling a carrier. Ratio sets how fast, index sets how hard.' }),
    ]));
    this.wave = el('canvas', { role: 'img', 'aria-label': 'Waveform' });
    this.spec = el('canvas', { role: 'img', 'aria-label': 'Spectrum with sidebands marked' });
    this.diagram = el('canvas', { role: 'img', 'aria-label': 'Modulator feeding the carrier' });
    this.legend = el('div', { class: 'viz-legend' });
    box.append(el('div', { class: 'viz-row' }, [
      el('div', { class: 'viz', style: 'height:190px' }, [this.wave, el('div', { class: 'viz-label', text: 'Waveform' })]),
      el('div', { class: 'viz', style: 'height:190px' }, [this.diagram, el('div', { class: 'viz-label', text: 'Algorithm' })]),
    ]));
    box.append(el('div', { class: 'viz', style: 'height:200px' }, [this.spec, el('div', { class: 'viz-label', text: 'Spectrum. Ticks mark where FM puts sidebands' }), this.legend]));

    const ctl = el('div', { class: 'controls' });
    const on = (k, v) => { this.p[k.split('.').pop()] = v; this._live(); };
    ctl.append(
      makeControl('fm.ratio', this.p.ratio, on, { def: { label: 'Ratio (modulator ÷ carrier)', min: 0.5, max: 8, step: 0.01, kind: 'sound', format: (v) => `${v.toFixed(2)} : 1` } }),
      makeControl('fm.index', this.p.index, on, { def: { label: 'Index (how hard)', min: 0, max: 10, step: 0.05, kind: 'sound', format: (v) => v.toFixed(2) } }),
      makeControl('fm.indexDecay', this.p.indexDecay, on, { def: { label: 'Index decay', min: 0, max: 100, step: 1, kind: 'time', format: (v) => (v === 0 ? 'Off' : `${(0.05 * Math.pow(60, v / 100)).toFixed(2)} s`) } }),
    );
    if (this.slow) {
      ctl.append(makeControl('fm.modRate', this.p.modRate, on, { def: { label: 'Slow it down', min: 0, max: 100, step: 1, kind: 'move', format: (v) => (v === 0 ? 'Audio rate' : `${(0.5 * Math.pow(60, v / 100)).toFixed(1)} Hz`) } }));
    }
    const snap = el('label', { class: 'switch', for: `snap-${Math.random().toString(36).slice(2, 7)}` });
    const snapIn = el('input', { type: 'checkbox', id: snap.getAttribute('for') });
    snapIn.checked = true;
    snap.append(snapIn, el('span', { text: 'Snap ratio to halves (keeps it musical)' }));
    this.snap = snapIn;
    snapIn.addEventListener('change', () => this._live());
    ctl.append(snap);
    box.append(ctl);

    this.kb = new Keyboard({ low: this.baseNote, onDown: (n, v) => this.noteOn(n, v), onUp: (n) => this.noteOff(n) });
    const hold = el('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', text: 'Hold a note' });
    hold.addEventListener('click', () => {
      const p = hold.getAttribute('aria-pressed') !== 'true';
      hold.setAttribute('aria-pressed', String(p));
      p ? this.noteOn(57, 0.8) : this.noteOff(57);
    });
    box.append(el('div', { class: 'keys-wrap' }, [el('div', { class: 'keys-bar' }, [el('span', { text: 'Play with the mouse or keys A–K.' }), el('span', { class: 'grow' }), hold]), this.kb.root]));
    this.append(box);

    onFrame(this.wave, () => this.drawWave());
    onFrame(this.spec, () => this.drawSpec());
    onFrame(this.diagram, () => this.drawDiagram());
  }

  _ratio() {
    const r = this.p.ratio;
    return this.snap?.checked ? Math.max(0.5, Math.round(r * 2) / 2) : r;
  }

  _modFreq(f) {
    return this.p.modRate > 0 ? 0.5 * Math.pow(60, this.p.modRate / 100) : f * this._ratio();
  }

  _ensureOut() {
    if (this.analyser) return;
    const { ctx, master } = audio();
    this.analyser = makeAnalyser(ctx, 8192, 0.5);
    this.analyser.connect(master);
  }

  noteOn(note, vel = 0.8) {
    resume();
    this._ensureOut();
    this.noteOff(note);
    const { ctx } = audio();
    const t = ctx.currentTime;
    const f = midiToHz(note);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const depth = ctx.createGain();
    const amp = ctx.createGain();
    car.frequency.value = f;
    mod.frequency.value = this._modFreq(f);
    // Index × modulator frequency = how far, in Hz, the carrier swings.
    const swing = this.p.index * (this.p.modRate > 0 ? f * 0.02 : mod.frequency.value);
    depth.gain.setValueAtTime(swing, t);
    if (this.p.indexDecay > 0) depth.gain.setTargetAtTime(swing * 0.08, t + 0.005, 0.05 * Math.pow(60, this.p.indexDecay / 100) / 3);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.22 * (0.5 + vel * 0.5), t + 0.005);
    mod.connect(depth).connect(car.frequency);
    car.connect(amp).connect(this.analyser);
    car.start(t); mod.start(t);
    this.voices.set(note, { car, mod, depth, amp, f });
    this.lastNote = note;
    this.kb.light(note, true);
  }

  noteOff(note) {
    const v = this.voices.get(note);
    if (!v) return;
    const { ctx } = audio();
    const t = ctx.currentTime;
    v.amp.gain.cancelScheduledValues(t);
    v.amp.gain.setTargetAtTime(0, t, 0.06);
    v.car.stop(t + 0.4); v.mod.stop(t + 0.4);
    this.voices.delete(note);
    this.kb.light(note, false);
  }

  showHardwareNote(note, on) { this.kb.light(note, on, 'data-hw'); }

  _live() {
    const { ctx } = audio();
    const t = ctx.currentTime;
    for (const v of this.voices.values()) {
      const mf = this._modFreq(v.f);
      v.mod.frequency.setTargetAtTime(mf, t, 0.02);
      const swing = this.p.index * (this.p.modRate > 0 ? v.f * 0.02 : mf);
      v.depth.gain.cancelScheduledValues(t);
      v.depth.gain.setTargetAtTime(swing, t, 0.02);
    }
  }

  drawWave() {
    const c = colors();
    const { g, w, h } = fit(this.wave);
    g.clearRect(0, 0, w, h);
    grid(g, w, h, 8, 4);
    if (fm1.analyser) drawWave(g, w, h, fm1.analyser, { color: c.hw, span: 900, lineWidth: 1.4 });
    if (this.analyser) drawWave(g, w, h, this.analyser, { color: c.sound, span: 900, gain: 1.8 });
  }

  drawSpec() {
    const c = colors();
    const { g, w, h } = fit(this.spec);
    g.clearRect(0, 0, w, h);
    freqGrid(g, w, h);
    const f = midiToHz(this.lastNote);
    if (this.p.modRate === 0) {
      const fm = f * this._ratio();
      g.strokeStyle = c.move;
      g.fillStyle = c.move;
      g.lineWidth = 1;
      for (let n = -8; n <= 8; n++) {
        const s = Math.abs(f + n * fm);
        if (s < 20 || s > 20000) continue;
        const x = xForFreq(s, w);
        g.globalAlpha = n === 0 ? 0.9 : 0.45;
        g.beginPath(); g.moveTo(x, 18); g.lineTo(x, 30); g.stroke();
      }
      g.globalAlpha = 1;
    }
    if (fm1.analyser) drawSpectrum(g, w, h, fm1.analyser, { color: c.hw, fill: false, lineWidth: 1.2 });
    if (this.analyser) drawSpectrum(g, w, h, this.analyser, { color: c.sound });
    const txt = this.p.modRate > 0 ? 'Slow modulator: you hear vibrato, not new tones'
      : `Carrier ${noteName(this.lastNote)} (${f.toFixed(0)} Hz), modulator ${(f * this._ratio()).toFixed(0)} Hz`;
    if (this.legend.textContent !== txt) this.legend.textContent = txt;
  }

  drawDiagram() {
    const c = colors();
    const { g, w, h } = fit(this.diagram);
    g.clearRect(0, 0, w, h);
    const bw = 110; const bh = 40;
    const cx = w / 2;
    const box = (y, label, sub, col) => {
      g.strokeStyle = col; g.lineWidth = 2;
      g.beginPath(); g.roundRect(cx - bw / 2, y, bw, bh, 8); g.stroke();
      g.fillStyle = c.ink; g.font = '600 13px Archivo, sans-serif'; g.textAlign = 'center';
      g.fillText(label, cx, y + 17);
      g.fillStyle = c.ink2; g.font = '11px Archivo, sans-serif';
      g.fillText(sub, cx, y + 32);
    };
    const y1 = h * 0.16; const y2 = h * 0.6;
    const f = midiToHz(this.lastNote);
    box(y1, 'Modulator', this.p.modRate > 0 ? 'slow' : `${this._ratio().toFixed(2)} × pitch`, c.move);
    box(y2, 'Carrier', `${f.toFixed(0)} Hz, you hear this`, c.sound);
    g.strokeStyle = c.move; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, y1 + bh); g.lineTo(cx, y2 - 6); g.stroke();
    g.beginPath(); g.moveTo(cx - 5, y2 - 11); g.lineTo(cx, y2 - 3); g.lineTo(cx + 5, y2 - 11); g.stroke();
    g.fillStyle = c.ink2; g.font = '11px Archivo, sans-serif'; g.textAlign = 'left';
    g.fillText(`index ${this.p.index.toFixed(2)}`, cx + 10, (y1 + bh + y2) / 2 + 4);
    g.textAlign = 'start';
    void clamp;
  }
}

customElements.define('fm-lab', FMLab);
