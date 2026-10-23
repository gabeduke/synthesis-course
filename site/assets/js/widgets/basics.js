// <beat-lab>        two sine waves a few hertz apart, and the beating they make
// <harmonics-lab>   build a waveform out of sine-wave harmonics

import { audio, resume, prefersReducedMotion } from '../audio/core.js';
import { el, makeControl } from '../ui/controls.js';
import { onFrame, fit, colors, grid, makeAnalyser, drawSpectrum, freqGrid, font, alpha, lineScale } from '../ui/draw.js';

// ---------- Beating ----------
class BeatLab extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.f1 = 220;
    this.f2 = 222;
    this.t0 = performance.now();
    const box = el('section', { class: 'instrument', 'aria-label': 'Beating between two tones' });
    box.append(el('div', { class: 'instrument-head' }, [
      el('h3', { text: 'Two tones, almost the same' }),
      el('p', { text: 'Pull the second tone a little away from 220 Hz and listen for the pulse.' }),
    ]));
    this.wave = el('canvas', { role: 'img', 'aria-label': 'Two sine waves and their sum over one second' });
    this.readout = el('div', { class: 'viz-legend' });
    box.append(el('div', { class: 'viz', style: 'height:230px' }, [this.wave, el('div', { class: 'viz-label', text: 'One second of sound, squeezed to fit' }), this.readout]));

    const ctl = el('div', { class: 'controls' });
    const def = { label: 'Second tone', min: 220, max: 232, step: 0.1, kind: 'sound', format: (v) => `${v.toFixed(1)} Hz` };
    ctl.append(makeControl('beat.f2', this.f2, (_, v) => {
      this.f2 = v;
      if (this.o2) this.o2.frequency.setTargetAtTime(v, audio().ctx.currentTime, 0.02);
    }, { def }));
    box.append(ctl);

    const play = el('button', { class: 'btn primary', type: 'button', 'aria-pressed': 'false', text: 'Play both tones' });
    play.addEventListener('click', () => {
      const on = play.getAttribute('aria-pressed') !== 'true';
      play.setAttribute('aria-pressed', String(on));
      play.textContent = on ? 'Stop' : 'Play both tones';
      on ? this.start() : this.stop();
    });
    box.append(el('div', { class: 'instrument-foot' }, [play]));
    this.append(box);
    onFrame(this.wave, () => this.draw());
  }

  start() {
    resume();
    const { ctx, master } = audio();
    this.g = ctx.createGain();
    this.g.gain.value = 0;
    this.g.gain.setTargetAtTime(0.18, ctx.currentTime, 0.05);
    this.o1 = ctx.createOscillator(); this.o1.frequency.value = this.f1;
    this.o2 = ctx.createOscillator(); this.o2.frequency.value = this.f2;
    this.o1.connect(this.g); this.o2.connect(this.g);
    this.g.connect(master);
    this.o1.start(); this.o2.start();
  }

  stop() {
    const { ctx } = audio();
    this.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    this.o1.stop(ctx.currentTime + 0.3); this.o2.stop(ctx.currentTime + 0.3);
    this.o1 = this.o2 = null;
  }

  draw() {
    const c = colors();
    const { g, w, h, k } = fit(this.wave);
    g.clearRect(0, 0, w, h);
    grid(g, w, h, 10, 4, { axis: false });
    const beat = Math.abs(this.f2 - this.f1);
    const txt = beat < 0.05 ? 'Same pitch: no beating' : `Beats: ${beat.toFixed(1)} per second`;
    if (this.readout.textContent !== txt) this.readout.textContent = txt;

    // Draw one second as a min/max band per pixel: individual cycles are too
    // dense to see, but the swell and fade of the beating is plain.
    const top = h * 0.12; const mid = h * 0.56; const amp = h * 0.36;
    const t0 = prefersReducedMotion() ? 0 : (performance.now() - this.t0) / 1000;
    // Each pixel's band spans at least one whole cycle, so it reads as one
    // smooth shape rather than a comb of slices.
    const samplesPerPx = 40;
    const span = Math.max(1 / w, 1.05 / Math.min(this.f1, this.f2));
    const step = 1;
    const n = Math.ceil(w / step) + 1;
    const his = new Float32Array(n); const los = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let lo = 2; let hi = -2;
      for (let j = 0; j < samplesPerPx; j++) {
        const t = t0 + (i * step) / w + (j / samplesPerPx) * span;
        const s = 0.5 * (Math.sin(2 * Math.PI * this.f1 * t) + Math.sin(2 * Math.PI * this.f2 * t));
        lo = Math.min(lo, s); hi = Math.max(hi, s);
      }
      his[i] = hi; los[i] = lo;
    }
    const band = new Path2D();
    for (let i = 0; i < n; i++) band[i ? 'lineTo' : 'moveTo'](Math.min(w, i * step), mid - his[i] * amp);
    for (let i = n - 1; i >= 0; i--) band.lineTo(Math.min(w, i * step), mid - los[i] * amp);
    band.closePath();
    const grad = g.createLinearGradient(0, mid - amp, 0, mid + amp);
    grad.addColorStop(0, alpha(c.sound, 0.85)); grad.addColorStop(0.5, alpha(c.sound, 0.55)); grad.addColorStop(1, alpha(c.sound, 0.85));
    g.fillStyle = grad;
    g.fill(band);
    g.strokeStyle = c.sound; g.lineWidth = 1; g.lineJoin = 'round';
    g.stroke(band);
    // The envelope the ear hears as a slow pulse: |cos(π·Δf·t)|.
    g.strokeStyle = c.time;
    g.lineWidth = 1.6 * lineScale(k);
    g.setLineDash([4 * k, 4 * k]);
    g.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const t = t0 + x / w;
      const e = Math.abs(Math.cos(Math.PI * (this.f2 - this.f1) * t));
      const y = mid - e * amp;
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = c.axis; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, Math.round(mid) + 0.5); g.lineTo(w, Math.round(mid) + 0.5); g.stroke();
    g.fillStyle = c.ink3;
    g.font = font(10.5 * k);
    g.textBaseline = 'bottom';
    g.fillText('0 s', 6 * k, h - 5 * k);
    g.textAlign = 'right';
    g.fillText('1 s', w - 6 * k, h - 5 * k);
    g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    void top;
  }
}
customElements.define('beat-lab', BeatLab);

// ---------- Harmonics ----------
const N_HARM = 16;
const SHAPES = {
  sine: () => [1, ...new Array(N_HARM - 1).fill(0)],
  saw: () => Array.from({ length: N_HARM }, (_, i) => 1 / (i + 1)),
  square: () => Array.from({ length: N_HARM }, (_, i) => ((i + 1) % 2 ? 1 / (i + 1) : 0)),
  triangle: () => Array.from({ length: N_HARM }, (_, i) => ((i + 1) % 2 ? 1 / ((i + 1) ** 2) : 0)),
};
// The triangle's odd harmonics alternate in sign; the others don't.
const signFor = (shape, n) => (shape === 'triangle' && n % 4 === 3 ? -1 : 1);

class HarmonicsLab extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.shape = this.getAttribute('shape') || 'sine';
    this.amps = SHAPES[this.shape]();
    this.freq = 110;
    const box = el('section', { class: 'instrument', 'aria-label': 'Harmonics builder' });
    box.append(el('div', { class: 'instrument-head' }, [
      el('h3', { text: 'Build a wave from sines' }),
      el('p', { text: 'Each bar is one sine wave, at 1×, 2×, 3× … the note’s pitch. Drag the bars.' }),
    ]));
    this.bars = el('canvas', { role: 'img', 'aria-label': 'Harmonic levels; drag to change' });
    this.wave = el('canvas', { role: 'img', 'aria-label': 'The resulting waveform' });
    this.spec = el('canvas', { role: 'img', 'aria-label': 'Spectrum of the sound' });
    const row = el('div', { class: 'viz-row' }, [
      el('div', { class: 'viz', style: 'height:200px;touch-action:none;cursor:ns-resize' }, [this.bars, el('div', { class: 'viz-label', text: 'Harmonics 1 to 16' })]),
      el('div', { class: 'viz', style: 'height:200px' }, [this.wave, el('div', { class: 'viz-label', text: 'The wave they add up to' })]),
    ]);
    box.append(row);
    if (this.hasAttribute('spectrum')) box.append(el('div', { class: 'viz', style: 'height:150px' }, [this.spec, el('div', { class: 'viz-label', text: 'Spectrum, measured from the sound' })]));

    const presets = el('div', { class: 'seg', role: 'group', 'aria-label': 'Start from' });
    const btns = Object.keys(SHAPES).map((k) => {
      const b = el('button', { type: 'button', text: k[0].toUpperCase() + k.slice(1), 'aria-pressed': String(k === this.shape) });
      b.addEventListener('click', () => { clearInterval(this._buildTimer); this.shape = k; this.amps = SHAPES[k](); this._update(); btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
      presets.append(b);
      return b;
    });
    const build = el('button', { class: 'btn', type: 'button', text: 'Add them one at a time' });
    build.addEventListener('click', () => this.buildUp(btns));
    const play = el('button', { class: 'btn primary', type: 'button', 'aria-pressed': 'false', text: 'Play' });
    play.addEventListener('click', () => {
      const on = play.getAttribute('aria-pressed') !== 'true';
      play.setAttribute('aria-pressed', String(on));
      play.textContent = on ? 'Stop' : 'Play';
      on ? this.start() : this.stop();
    });
    box.append(el('div', { class: 'instrument-foot' }, [play, el('span', { class: 'label', text: 'Start from' }), presets, el('span', { class: 'grow' }), build]));
    this.append(box);

    // Dragging the bars
    let dragging = false;
    const setFrom = (e) => {
      clearInterval(this._buildTimer);
      const r = this.bars.getBoundingClientRect();
      const i = Math.floor(((e.clientX - r.left) / r.width) * N_HARM);
      if (i < 0 || i >= N_HARM) return;
      const v = 1 - (e.clientY - r.top - 24) / (r.height - 34);
      this.amps[i] = Math.max(0, Math.min(1, v < 0.03 ? 0 : v));
      this.shape = 'custom';
      btns.forEach((x) => x.setAttribute('aria-pressed', 'false'));
      this._update();
    };
    this.bars.addEventListener('pointerdown', (e) => { dragging = true; this.bars.setPointerCapture(e.pointerId); setFrom(e); });
    this.bars.addEventListener('pointermove', (e) => { if (dragging) setFrom(e); });
    this.bars.addEventListener('pointerup', () => { dragging = false; });

    onFrame(this.bars, () => this.drawBars());
    onFrame(this.wave, () => this.drawWave());
    if (this.hasAttribute('spectrum')) onFrame(this.spec, () => this.drawSpec());
  }

  _periodic() {
    const { ctx } = audio();
    const real = new Float32Array(N_HARM + 1);
    const imag = new Float32Array(N_HARM + 1);
    for (let i = 0; i < N_HARM; i++) imag[i + 1] = this.amps[i] * signFor(this.shape, i + 1);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  _update() {
    if (this.osc) this.osc.setPeriodicWave(this._periodic());
  }

  start() {
    resume();
    const { ctx, master } = audio();
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.gain.setTargetAtTime(0.22, ctx.currentTime, 0.04);
    this.osc = ctx.createOscillator();
    this.osc.frequency.value = this.freq;
    this.osc.setPeriodicWave(this._periodic());
    this.analyser = makeAnalyser(ctx, 8192, 0.6);
    this.osc.connect(this.gain).connect(this.analyser).connect(master);
    this.osc.start();
  }

  stop() {
    const { ctx } = audio();
    this.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
    this.osc.stop(ctx.currentTime + 0.25);
    this.osc = null;
  }

  buildUp(btns) {
    const target = SHAPES[this.shape === 'custom' || this.shape === 'sine' ? 'saw' : this.shape]();
    const shape = this.shape === 'custom' || this.shape === 'sine' ? 'saw' : this.shape;
    this.shape = shape;
    btns.forEach((x) => x.setAttribute('aria-pressed', String(x.textContent.toLowerCase() === shape)));
    this.amps = new Array(N_HARM).fill(0);
    let i = 0;
    clearInterval(this._buildTimer);
    const step = () => {
      this.amps[i] = target[i];
      this._update();
      i++;
      if (i >= N_HARM) clearInterval(this._buildTimer);
    };
    step();
    this._buildTimer = setInterval(step, prefersReducedMotion() ? 0 : 450);
  }

  drawBars() {
    const c = colors();
    const { g, w, h } = fit(this.bars);
    g.clearRect(0, 0, w, h);
    const bw = w / N_HARM;
    // A baseline, then each bar with a rounded top, the fundamental in ink.
    g.strokeStyle = c.axis; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, h - 9.5); g.lineTo(w, h - 9.5); g.stroke();
    for (let i = 0; i < N_HARM; i++) {
      const v = this.amps[i];
      const bh = Math.max(2, v * (h - 34));
      const x = i * bw + bw * 0.18; const width = bw * 0.64;
      const r = Math.min(4, width / 2, bh);
      g.fillStyle = v > 0 ? (i === 0 ? c.ink : c.sound) : alpha(c.ink3, 0.35);
      g.globalAlpha = v > 0 ? 0.92 : 1;
      g.beginPath(); g.roundRect(x, h - 10 - bh, width, bh, [r, r, 0, 0]); g.fill();
    }
    g.globalAlpha = 1;
  }

  drawWave() {
    const c = colors();
    const { g, w, h, k } = fit(this.wave);
    g.clearRect(0, 0, w, h);
    grid(g, w, h, 4, 4);
    const N = Math.floor(w);
    const vals = new Float32Array(N + 1);
    let peak = 0.0001;
    for (let j = 0; j <= N; j++) {
      const x = (j / N) * 2; // two cycles
      let s = 0;
      for (let i = 0; i < N_HARM; i++) s += this.amps[i] * signFor(this.shape, i + 1) * Math.sin(2 * Math.PI * (i + 1) * x);
      vals[j] = s;
      peak = Math.max(peak, Math.abs(s));
    }
    g.lineJoin = 'round';
    g.beginPath();
    for (let j = 0; j <= N; j++) {
      const y = h / 2 - (vals[j] / peak) * h * 0.38;
      if (j === 0) g.moveTo((j / N) * w, y); else g.lineTo((j / N) * w, y);
    }
    g.strokeStyle = alpha(c.sound, c.dark ? 0.18 : 0.1);
    g.lineWidth = 6.6 * lineScale(k);
    g.stroke();
    g.strokeStyle = c.sound;
    g.lineWidth = 2.2 * lineScale(k);
    g.stroke();
  }

  drawSpec() {
    const c = colors();
    const { g, w, h } = fit(this.spec);
    g.clearRect(0, 0, w, h);
    freqGrid(g, w, h);
    if (this.analyser && this.osc) drawSpectrum(g, w, h, this.analyser, { color: c.sound });
  }
}
customElements.define('harmonics-lab', HarmonicsLab);
