// <synth-lab> — the course's main instrument panel.
//
//   heading   panel title
//   intro     one line under the title
//   controls  space-separated param keys and/or group names (Oscillator, Filter …)
//   preset    JSON of starting params
//   views     any of: wave spectrum env shape lfo   (default "wave spectrum")
//   filter-curve   overlay the filter's response on the spectrum
//   chord     notes for the Hold button, e.g. "48 55 60 64"
//   low       lowest key on the drawn keyboard (default 48)
//   span      samples across the oscilloscope (default 1024)
//   flow      "off" hides the signal-path strip above the scopes
//
// views also takes "sono", a spectrogram. Focus fills the screen with the
// panel and adds the scope, spectrum and spectrogram if it doesn't have them.
// With an instrument connected, its wheels, sustain pedal and knobs play the
// panel you used last (ui/keyboard.js routes them to hwBend, hwMod,
// hwSustain and hwParam below).

import { audio, resume, clamp } from '../audio/core.js';
import { VASynth, attackTime, decayTime, releaseTime, lfoHz } from '../audio/va-synth.js';
import { fm1 } from '../hw/fm1.js';
import { deviceLabel, devName, ctl, where as whereOn, onDeviceChange } from '../ui/device.js';
import { GROUPS, PARAMS, getParam, toPartial, ccFor, formatValue } from '../ui/params.js';
import { el, makeControl } from '../ui/controls.js';
import { Keyboard, registerInstrument } from '../ui/keyboard.js';
import { share } from '../ui/pwa.js';
import { enableFocus } from '../ui/focus.js';
import {
  onFrame, fit, colors, grid, drawWave, drawSpectrum, freqGrid, xForFreq, freqForX, yForDb, rms, makeAnalyser,
  Sonogram, drawFlow, flowPointer,
} from '../ui/draw.js';

const HISTORY = 240; // frames of level / LFO history (~4 s)
const FOCUS_VIEWS = ['wave', 'spectrum', 'sono']; // added in focus mode

// The signal path, left to right, and what moves it. Clicking a stage points
// at its controls on the panel.
const STAGES = {
  osc: { name: 'Oscillators', about: 'the raw tone, before anything shapes it', keys: GROUPS.Oscillator },
  filter: { name: 'Filter', about: 'takes part of the spectrum away; this is the sound after it', keys: GROUPS.Filter },
  amp: { name: 'Amp', about: 'the envelope sets each note’s loudness, moment by moment', keys: [...GROUPS.Envelope, 'level'] },
  fx: { name: 'Effects', about: 'distortion, chorus, delay and reverb, then out to your ears', keys: [...GROUPS.Distortion, ...GROUPS.Chorus, ...GROUPS.Delay, ...GROUPS.Reverb] },
  hw: { name: '', about: 'the instrument’s real output, through its USB audio', keys: [] },
  env: { name: 'Envelope', about: 'the shape of each note over time; it always drives the amp, and the filter if Filter envelope is up', keys: [...GROUPS.Envelope, 'filterEnv', 'filterDecay'] },
  lfo: { name: 'LFO', about: 'a slow wave that moves pitch, cutoff or loudness', keys: [...GROUPS.LFO, 'lfoToCutoff'] },
};

class SynthLab extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.preset = JSON.parse(this.getAttribute('preset') || '{}');
    this.params = structuredClone(this.preset);
    this.views = (this.getAttribute('views') || 'wave spectrum').split(/\s+/).filter(Boolean);
    this.chord = (this.getAttribute('chord') || '48 55 60 64').split(/\s+/).map(Number);
    this.baseNote = Number(this.getAttribute('low') || 48);
    this.span = Number(this.getAttribute('span') || 1024);
    this.target = 'page';
    this.mirror = false;
    this.held = new Set();
    this.levelHist = new Float32Array(HISTORY);
    this.hwLevelHist = new Float32Array(HISTORY);
    this.lfoHist = new Float32Array(HISTORY);
    this.histPos = 0;
    this.lastOn = null;
    this.lastOff = null;
    this.pedal = false;
    this.pedalNotes = new Map(); // note -> where it came from
    this.bendAmount = 0;
    this.modAmount = 0;
    this._hwPending = new Map();
    this._build();
    registerInstrument(this);
  }

  get root() { return this; }

  // ---------- Audio ----------
  ensure() {
    if (this.synth) return this.synth;
    const { ctx, master } = audio();
    // Start from the panel's current settings (a shared patch, or the lesson's).
    this.synth = new VASynth(this._full());
    this.synth.taps();
    this.synth.setBend(this.bendAmount * fm1.bendRange);
    this.synth.setMod(this.modAmount);
    this.analyser = makeAnalyser(ctx, 8192, 0.5);
    this.synth.output.connect(this.analyser).connect(master);
    this.lfoAnalyser = makeAnalyser(ctx, 256, 0);
    this.synth.lfoOut.connect(this.lfoAnalyser);
    // Hidden filters used only to draw the response curve.
    this.curveFilters = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    return this.synth;
  }

  noteOn(note, vel = 0.8, source) {
    resume();
    const toPage = this.target !== 'fm1';
    const toHw = this.target !== 'page' && source !== 'fm1';
    if (toPage) this.ensure().noteOn(note, vel);
    if (toHw) fm1.noteOn(note, vel);
    this.pedalNotes.delete(note);
    this.held.add(note);
    this.kb.light(note, true);
    this.lastOn = performance.now();
    this.lastOff = null;
  }

  noteOff(note, source) {
    // The sustain pedal keeps a released key sounding until the pedal comes up.
    if (this.pedal && source !== 'reset' && this.held.has(note)) {
      this.pedalNotes.set(note, source);
      this.held.delete(note);
      this.kb.light(note, false);
      if (!this.held.size) this.lastOff = performance.now();
      return;
    }
    const toPage = this.target !== 'fm1';
    const toHw = this.target !== 'page' && source !== 'fm1';
    if (toPage && this.synth) this.synth.noteOff(note);
    if (toHw) fm1.noteOff(note);
    this.held.delete(note);
    this.kb.light(note, false);
    if (!this.held.size) this.lastOff = performance.now();
  }

  showHardwareNote(note, on) { this.kb.light(note, on, 'data-hw'); }

  shiftOctave(d) {
    this.baseNote = clamp(this.baseNote + d * 12, 24, 84);
    this.kb.setLow(this.baseNote);
    this.say(`Keyboard starts at C${this.baseNote / 12 - 1}.`);
  }

  // source 'hw': the instrument itself sent this, so don't send it back.
  set(key, value, source) {
    const partial = toPartial(key, value);
    if (partial.fx) {
      this.params.fx ||= {};
      for (const k of Object.keys(partial.fx)) this.params.fx[k] = { ...(this.params.fx[k] || {}), ...partial.fx[k] };
    } else Object.assign(this.params, partial);
    if (this.synth) this.synth.set(partial);
    if (this.mirror && source !== 'hw') {
      if (key.startsWith('fx.')) { const [, fx, field] = key.split('.'); fm1.sendFx(fx, field, value); }
      else fm1.sendParam(key, value);
    }
  }

  // ---------- Hardware wheels, pedal and knobs ----------
  hwBend(x) {
    this.bendAmount = x;
    this.synth?.setBend(x * fm1.bendRange);
    this._showWheels();
  }

  hwMod(x) {
    this.modAmount = x;
    this.synth?.setMod(x);
    this._showWheels();
  }

  hwSustain(on) {
    this.pedal = on;
    this.pedalLight.toggleAttribute('data-on', on);
    this.pedalLight.hidden = false;
    if (on) return;
    for (const [n, source] of [...this.pedalNotes]) if (!this.held.has(n)) this.noteOff(n, source);
    this.pedalNotes.clear();
  }

  // A knob on the instrument moved a setting: follow it here, and light up
  // the control so you can see which one it was.
  hwParam(key, value, { cc } = {}) {
    if (!PARAMS[key]) return;
    this.set(key, value, 'hw');
    this._hwPending.set(key, { value, cc });
    if (!this._hwRaf) this._hwRaf = requestAnimationFrame(() => this._showHwParams());
  }

  _showHwParams() {
    this._hwRaf = 0;
    let last = null;
    for (const [key, { value, cc }] of this._hwPending) {
      last = { key, value, cc };
      const c = this.ctls.get(key);
      if (!c) continue;
      c.update(value);
      c.setAttribute('data-hw-touch', '');
      clearTimeout(c._hwTouch);
      c._hwTouch = setTimeout(() => c.removeAttribute('data-hw-touch'), 700);
    }
    this._hwPending.clear();
    if (!last) return;
    const { key, value, cc } = last;
    const name = key.startsWith('fx.') ? `${key.split('.')[1][0].toUpperCase()}${key.split('.')[1].slice(1)} ${PARAMS[key].label.toLowerCase()}` : PARAMS[key].label;
    this.where.replaceChildren(`From the ${deviceLabel()}: `, el('b', { text: `${name} ${formatValue(key, value)}` }), ` (CC ${cc})`,
      this.ctls.has(key) ? '' : '. Not one of this panel’s sliders, but the sound follows it.');
    this._flowPulse = { stage: Object.keys(STAGES).find((s) => STAGES[s].keys.includes(key)), at: performance.now() };
  }

  _showWheels() {
    this.wheels.hidden = false;
    this.bendThumb.style.setProperty('--v', String(this.bendAmount));
    this.modThumb.style.setProperty('--v', String(this.modAmount));
  }

  // ---------- UI ----------
  _keys() {
    const spec = (this.getAttribute('controls') || '').split(/\s+/).filter(Boolean);
    const out = [];
    for (const s of spec) {
      if (GROUPS[s]) out.push({ group: s, keys: GROUPS[s] });
      else if (PARAMS[s]) {
        const last = out[out.length - 1];
        if (last && last.loose) last.keys.push(s); else out.push({ loose: true, keys: [s] });
      }
    }
    return out;
  }

  _build() {
    const heading = this.getAttribute('heading') || 'Try it';
    const intro = this.getAttribute('intro');
    const box = el('section', { class: 'instrument', 'aria-label': heading });

    this.box = box;
    box.append(el('div', { class: 'instrument-head' }, [el('h3', { text: heading }), intro ? el('p', { text: intro }) : null]));

    // Signal path
    if (this.getAttribute('flow') !== 'off') {
      this.flowCanvas = el('canvas', { role: 'img', 'aria-label': 'Signal path: oscillators, filter, amp and effects, and the envelope and LFO that move them. Click a stage to find its controls.' });
      box.append(el('div', { class: 'viz flow' }, this.flowCanvas));
      this._flowHits = [];
      flowPointer(this.flowCanvas, () => this._flowHits, {
        onHover: (id) => {
          this._flowHover = id;
          if (id) this.where.replaceChildren(el('b', { text: id === 'hw' ? deviceLabel() : STAGES[id].name }), `: ${STAGES[id].about}.`);
        },
        onClick: (id) => this._pointAt(id),
      });
    }

    // Visualizations
    const row = el('div', { class: 'viz-row' });
    this.canvases = {};
    const labels = { wave: 'Waveform', spectrum: 'Spectrum (low to high frequencies)', env: 'Loudness over time', shape: 'Envelope shape', lfo: 'LFO over time', sono: 'Spectrogram (time runs left, pitch up)' };
    const all = [...this.views, ...FOCUS_VIEWS.filter((v) => !this.views.includes(v))];
    for (const v of all) {
      if (!labels[v]) continue;
      const c = el('canvas', { role: 'img', 'aria-label': labels[v] });
      const legend = el('div', { class: 'viz-legend' });
      const viz = el('div', { class: 'viz', 'data-view': v, style: `height:${v === 'wave' || v === 'spectrum' || v === 'sono' ? 190 : 150}px` }, [c, el('div', { class: 'viz-label', text: labels[v] }), legend]);
      if (!this.views.includes(v)) viz.setAttribute('data-extra', '');
      row.append(viz);
      this.canvases[v] = { c, legend };
      if (v === 'sono') this.sono = new Sonogram();
    }
    box.append(row);

    // Controls
    const ctlWrap = el('div', { class: 'controls' });
    this.ctls = new Map();
    const onChange = (k, v) => this.set(k, v);
    const groups = this._keys();
    const many = groups.filter((g) => g.group).length > 1;
    for (const g of groups) {
      const target = many && g.group ? el('div', { class: 'control-group' }, el('div', { class: 'group-name', text: g.group })) : ctlWrap;
      for (const k of g.keys) {
        let v = getParam(this.params, k);
        if (v === undefined) v = getParam(this._defaults(), k);
        const c = makeControl(k, v, onChange);
        this.ctls.set(k, c);
        target.append(c);
        const where = () => {
          const cc = ccFor(k);
          this.where.innerHTML = '';
          this.where.append(`On the ${deviceLabel()}: `, el('b', { text: whereOn(PARAMS[k].where) }), cc ? ` (${cc})` : '');
        };
        c.addEventListener('pointerenter', where);
        c.addEventListener('focusin', where);
      }
      if (target !== ctlWrap) ctlWrap.append(target);
    }
    if (this.ctls.size) box.append(ctlWrap);
    this.where = el('div', { class: 'where' });
    if (this.ctls.size) box.append(this.where);

    // Keyboard
    this.kb = new Keyboard({ low: this.baseNote, onDown: (n, v) => this.noteOn(n, v, 'mouse'), onUp: (n) => this.noteOff(n, 'mouse') });
    const holdBtn = el('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', text: 'Hold a chord' });
    holdBtn.addEventListener('click', () => {
      const on = holdBtn.getAttribute('aria-pressed') !== 'true';
      holdBtn.setAttribute('aria-pressed', String(on));
      for (const n of this.chord) on ? this.noteOn(n, 0.75, 'hold') : this.noteOff(n, 'hold');
    });
    this.holdBtn = holdBtn;
    // The instrument's wheels and pedal, shown once it uses them.
    this.bendThumb = el('i');
    this.modThumb = el('i');
    this.wheels = el('span', { class: 'wheels', hidden: true, title: 'Pitch and mod wheels on the instrument' }, [
      el('span', { class: 'wheel bend' }, [this.bendThumb]), el('span', { class: 'wheel mod' }, [this.modThumb]),
    ]);
    this.pedalLight = el('span', { class: 'light pedal', hidden: true }, el('span', { text: 'Pedal' }));
    const keysBar = el('div', { class: 'keys-bar' }, [
      el('span', { text: 'Play with the mouse, or click this panel and use keys A–K (Z and X shift octaves).' }),
      el('span', { class: 'grow' }),
      this.wheels,
      this.pedalLight,
      holdBtn,
    ]);
    box.append(el('div', { class: 'keys-wrap' }, [keysBar, this.kb.root]));

    // Footer: where notes go, FM-1 mirroring
    const seg = el('div', { class: 'seg neutral', role: 'group', 'aria-label': 'Play on' });
    const targets = [['page', 'This page'], ['fm1', devName()], ['both', 'Both']];
    const segBtns = targets.map(([val, label]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(val === this.target) }, label);
      b.addEventListener('click', () => {
        this._releaseAll();
        this.target = val;
        segBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(targets[i][0] === val)));
      });
      seg.append(b);
      return b;
    });
    const mirrorId = `mir-${Math.random().toString(36).slice(2, 8)}`;
    const mirror = el('input', { type: 'checkbox', id: mirrorId });
    mirror.addEventListener('change', () => {
      this.mirror = mirror.checked;
      if (this.mirror) this._send(`Mirroring: each control you move here moves on the ${deviceLabel()} too.`);
    });
    const sendBtn = el('button', { class: 'btn hw', type: 'button' }, ['Send settings to ', devName()]);
    sendBtn.addEventListener('click', () => this._send());
    const resetBtn = el('button', { class: 'btn', type: 'button', text: 'Reset' });
    resetBtn.addEventListener('click', () => this.reset());
    const shareBtn = el('button', { class: 'btn', type: 'button', text: 'Share patch' });
    shareBtn.title = 'A link that opens this page with these exact settings';
    shareBtn.addEventListener('click', () => this.sharePatch());
    this.hwBits = [seg, mirror.parentElement, sendBtn];

    const foot = el('div', { class: 'instrument-foot' }, [
      el('span', { class: 'label', text: 'Play on' }), seg,
      el('label', { class: 'switch', for: mirrorId, style: '--c: var(--hw)' }, [mirror, el('span', {}, ['Mirror to ', devName()])]),
      el('span', { class: 'grow' }),
      sendBtn, shareBtn, resetBtn,
    ]);
    box.append(foot);
    this.status = el('div', { class: 'where', role: 'status' });
    box.append(this.status);
    this.append(box);
    // Focus (ui/focus.js) also shows the scope, spectrum and spectrogram, so start the sound.
    enableFocus(this);
    this.addEventListener('focuschange', (e) => { if (e.detail.on) { resume(); this.ensure(); } });

    const syncHw = () => {
      const out = fm1.canSend;
      sendBtn.disabled = !out;
      mirror.disabled = !out;
      segBtns[1].disabled = !out;
      segBtns[2].disabled = !out;
      if (!out && this.target !== 'page') {
        this._releaseAll();
        this.target = 'page';
        segBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(i === 0)));
      }
      sendBtn.title = out ? '' : `Connect the ${deviceLabel()} (top right) to use this`;
    };
    fm1.addEventListener('change', syncHw);
    onDeviceChange(() => { syncHw(); this.where.textContent = ''; });
    syncHw();

    this.addEventListener('pointerdown', () => { resume(); this.ensure(); }, { once: true });
    this.addEventListener('focusin', () => this.ensure(), { once: true });

    for (const [v, { c, legend }] of Object.entries(this.canvases)) {
      onFrame(c, (now) => this._draw(v, c, legend, now));
    }
    if (this.flowCanvas) onFrame(this.flowCanvas, (now) => this._drawFlow(now));
    this._loadSharedPatch();
  }

  // ---------- Patch links ----------
  // A patch travels in the address: page.html#patch2=<settings>, where 2 is
  // which panel on the page it belongs to. Nothing is stored on a server.
  get _index() { return [...document.querySelectorAll('synth-lab')].indexOf(this); }

  async sharePatch() {
    const json = JSON.stringify(this.params);
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}${location.pathname}#patch${this._index}=${b64}`;
    const heading = this.getAttribute('heading') || 'Synth';
    const how = await share({ title: `${heading} patch | Signal Path`, text: `A patch for “${heading}” on Signal Path`, url });
    if (how === 'copied' || how === 'shared') this.say('Anyone who opens the link gets this panel with these settings.');
  }

  _loadSharedPatch() {
    const m = location.hash.match(new RegExp(`^#patch${this._index}=([A-Za-z0-9_-]+)$`));
    if (!m) return;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const patch = this._clean(JSON.parse(new TextDecoder().decode(bytes)));
      this._applyParams(patch);
      this.say('Loaded a shared patch. Reset brings back the lesson’s starting settings.');
      requestAnimationFrame(() => this.scrollIntoView({ block: 'center' }));
    } catch (_) {
      this.say('That patch link looks damaged, so the lesson’s own settings are shown.');
    }
  }

  // Only accept settings this panel knows, with values of the right kind.
  _clean(input) {
    const d = this._defaults();
    const out = {};
    const ok = (key, def, v) => {
      const spec = PARAMS[key];
      if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v)
        ? Math.min(spec?.max ?? 20000, Math.max(spec?.min ?? 0, v)) : undefined;
      if (typeof def === 'boolean') return typeof v === 'boolean' ? v : undefined;
      if (typeof def === 'string') return spec?.options ? (spec.options.includes(v) ? v : undefined) : undefined;
      return undefined;
    };
    for (const [k, v] of Object.entries(input || {})) {
      if (k === 'fx' && v && typeof v === 'object') {
        out.fx = {};
        for (const [fx, fields] of Object.entries(v)) {
          if (!d.fx[fx] || !fields || typeof fields !== 'object') continue;
          out.fx[fx] = {};
          for (const [f, fv] of Object.entries(fields)) {
            if (!(f in d.fx[fx])) continue;
            const clean = ok(`fx.${fx}.${f}`, d.fx[fx][f], fv);
            if (clean !== undefined) out.fx[fx][f] = clean;
          }
        }
      } else if (k in d && k !== 'fx') {
        const clean = ok(k, d[k], v);
        if (clean !== undefined) out[k] = clean;
      }
    }
    return out;
  }

  _full() {
    const d = this._defaults();
    const fx = {};
    for (const k of Object.keys(d.fx)) fx[k] = { ...d.fx[k], ...(this.params.fx?.[k] || {}) };
    return { ...d, ...this.params, fx };
  }

  _applyParams(params) {
    this.params = structuredClone(params);
    const full = this._full();
    if (this.synth) this.synth.set(full);
    for (const [k, c] of this.ctls) c.update(getParam(full, k));
  }

  _defaults() {
    return { waveform: 'saw', super: 0, detune: 0, drift: 0, sub: 0, noise: 0, pwm: 0, filterType: 'lp24', cutoff: 20000, resonance: 0, filterEnv: 0, filterDecay: 35, filterVelocity: 0, keyTrack: 0, lfoToCutoff: 0, attack: 0, decay: 40, sustain: 100, release: 20, lfoWave: 'triangle', lfoSpeed: 35, lfoPitch: 0, lfoAmp: 0, lfoDelay: 0, level: 78, mono: false, glide: 0, fx: { distortion: { on: false, type: 'soft', gain: 30, tone: 55, level: 70 }, chorus: { on: false, rate: 30, depth: 25, mix: 40 }, delay: { on: false, feedback: 30, rate: 30, mix: 25 }, reverb: { on: false, type: 'room', decay: 30, mix: 30 } } };
  }

  _send(message) {
    if (!fm1.canSend) return;
    const n = fm1.sendPatch(this._full());
    this.say(message || `Sent ${n} settings to the ${deviceLabel()}. Pick a Virtual Analog preset first (113–128 with the VA pack). Press ${ctl('SAVE')} on the ${deviceLabel()} to keep them.`);
  }

  say(text) { this.status.textContent = text; }

  _releaseAll() {
    for (const n of [...this.held, ...this.pedalNotes.keys()]) this.noteOff(n, 'reset');
    this.pedalNotes.clear();
    this.holdBtn?.setAttribute('aria-pressed', 'false');
  }

  reset() {
    this._releaseAll();
    this._applyParams(this.preset);
    if (location.hash.startsWith(`#patch${this._index}=`)) history.replaceState(null, '', location.pathname + location.search);
    if (this.mirror) this._send(`Reset, and sent the starting settings to the ${deviceLabel()}.`);
  }

  // ---------- Drawing ----------
  _record(now) {
    // Once per frame (however many views draw), sample level and LFO.
    if (this._recAt === now) return;
    this._recAt = now;
    this.histPos = (this.histPos + 1) % HISTORY;
    this.levelHist[this.histPos] = this.analyser ? rms(this.analyser) : 0;
    this.hwLevelHist[this.histPos] = fm1.analyser ? rms(fm1.analyser) : 0;
    if (this.lfoAnalyser) {
      const d = new Float32Array(this.lfoAnalyser.fftSize);
      this.lfoAnalyser.getFloatTimeDomainData(d);
      this.lfoHist[this.histPos] = d[d.length - 1];
    }
  }

  _legend(legend, items) {
    const key = items.map((i) => i[0]).join('|');
    if (legend.dataset.key === key) return;
    legend.dataset.key = key;
    legend.replaceChildren(...items.map(([label, color]) => el('span', {}, [Object.assign(el('i'), { style: `background:${color}` }), label])));
  }

  _draw(view, canvas, legend, now) {
    const { g, w, h } = fit(canvas);
    const c = colors();
    g.clearRect(0, 0, w, h);
    this._record(now);
    const hw = fm1.analyser;
    const items = [['This page', c.sound]];
    if (hw) items.push([deviceLabel(), c.hw]);

    if (view === 'wave') {
      grid(g, w, h, 8, 4);
      if (hw) drawWave(g, w, h, hw, { color: c.hw, span: this.span, lineWidth: 1.6 });
      if (this.analyser) drawWave(g, w, h, this.analyser, { color: c.sound, span: this.span });
      else { g.strokeStyle = c.sound; g.lineWidth = 2; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); }
      this._legend(legend, items);
    } else if (view === 'spectrum') {
      freqGrid(g, w, h);
      if (hw) drawSpectrum(g, w, h, hw, { color: c.hw, fill: false, lineWidth: 1.2 });
      if (this.analyser) drawSpectrum(g, w, h, this.analyser, { color: c.sound });
      if (this.hasAttribute('filter-curve')) { this._drawFilterCurve(g, w, h, c); items.push(['Filter', c.ink]); }
      this._legend(legend, items);
    } else if (view === 'env') {
      grid(g, w, h, 8, 3);
      this._drawHistory(g, w, h, this.hwLevelHist, c.hw, 4, 1.4, hw);
      this._drawHistory(g, w, h, this.levelHist, c.time, 4, 2, true);
      this._legend(legend, hw ? [['This page', c.time], [deviceLabel(), c.hw]] : [['This page', c.time]]);
    } else if (view === 'lfo') {
      grid(g, w, h, 8, 2);
      g.strokeStyle = c.rule; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
      this._drawHistory(g, w, h, this.lfoHist, c.move, 1, 2, true, true);
      this._legend(legend, [['LFO', c.move]]);
    } else if (view === 'shape') {
      this._drawShape(g, w, h, c);
      this._legend(legend, [['Envelope', c.time]]);
    } else if (view === 'sono') {
      this.sono.draw(canvas, g, w, h, [{ analyser: hw, color: c.hw }, { analyser: this.analyser, color: c.sound }]);
      this._legend(legend, items);
    }
  }

  // Light up the controls for one stage of the signal path.
  _pointAt(id) {
    const stage = STAGES[id];
    const found = stage.keys.map((k) => this.ctls.get(k)).filter(Boolean);
    for (const c of found) {
      c.setAttribute('data-flash', '');
      clearTimeout(c._flash);
      c._flash = setTimeout(() => c.removeAttribute('data-flash'), 1200);
    }
    if (found.length) {
      const r = found[0].getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) found[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    const name = id === 'hw' ? deviceLabel() : stage.name;
    this.where.replaceChildren(el('b', { text: name }), found.length
      ? `: ${found.map((c) => c.querySelector('label, .ctl-name, .switch span')?.textContent).filter(Boolean).join(', ')}.`
      : id === 'hw' ? `: ${stage.about}.` : ': none of its controls are on this panel; the sound uses the lesson’s settings.');
  }

  // ---------- Signal path ----------
  // Four stages left to right, with the envelope and LFO above them and a line
  // to each thing they move (ui/draw.js's drawFlow does the drawing).
  _drawFlow(now) {
    const { g, w, h } = fit(this.flowCanvas);
    const c = colors();
    g.clearRect(0, 0, w, h);
    const s = this.synth;
    const p = s ? s.p : this._full();
    const taps = s?._taps;
    const fxOn = Object.entries(p.fx || {}).filter(([, f]) => f.on).map(([k]) => k[0].toUpperCase() + k.slice(1));
    const open = p.filterType !== 'hp' && p.filterType !== 'bp' && p.cutoff >= 19000 && !p.filterEnv && !p.lfoToCutoff;
    const choice = (key) => PARAMS[key].names[PARAMS[key].options.indexOf(p[key])];
    const stages = [
      { id: 'osc', name: STAGES.osc.name, color: c.sound, tap: taps?.osc, sub: `${choice('waveform')}${p.super ? ' ×7' : ''}` },
      { id: 'filter', name: STAGES.filter.name, color: c.sound, tap: taps?.filter, sub: open ? 'open' : `${choice('filterType')} ${formatValue('cutoff', p.cutoff)}`, dim: open },
      { id: 'amp', name: STAGES.amp.name, color: c.time, tap: taps?.amp, sub: `A ${formatValue('attack', p.attack)} · R ${formatValue('release', p.release)}` },
      { id: 'fx', name: STAGES.fx.name, color: c.space, tap: taps?.out, sub: fxOn.length ? fxOn.join(' + ') : 'off', dim: !fxOn.length },
    ];
    if (fm1.analyser) stages.push({ id: 'hw', name: deviceLabel(), color: c.hw, tap: fm1.analyser, sub: 'real output', aside: true });
    const mods = [
      { id: 'env', name: STAGES.env.name, color: c.time, over: 'amp', at: 0.5, land: 0.62, targets: [['amp', 1], ['filter', p.filterEnv / 100]], active: !!s?.voices.some((v) => !v.released) },
      { id: 'lfo', name: STAGES.lfo.name, color: c.move, over: 'osc', at: 0.9, land: 0.38, rate: lfoHz(p.lfoSpeed), targets: [['osc', Math.max(p.lfoPitch / 99, this.modAmount)], ['filter', p.lfoToCutoff / 100], ['amp', p.lfoAmp / 99]] },
    ];
    const pulse = this._flowPulse && now - this._flowPulse.at < 700 ? this._flowPulse.stage : null;
    this._flowState ||= {};
    this._flowHits = drawFlow(g, w, h, now, { stages, mods, state: this._flowState, hover: this._flowHover, pulse });
  }

  _drawHistory(g, w, h, hist, color, gain, lw, show, bipolar = false) {
    if (!show) return;
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.beginPath();
    for (let i = 0; i < HISTORY; i++) {
      const v = hist[(this.histPos + 1 + i) % HISTORY];
      const x = (i / (HISTORY - 1)) * w;
      const y = bipolar ? h / 2 - v * h * 0.42 : h - 6 - Math.min(1, v * gain) * (h - 14);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }

  _drawFilterCurve(g, w, h, c) {
    const s = this.synth;
    const p = s ? s.p : { ...this._defaults(), ...this.params };
    const [f1, f2] = this.curveFilters || [];
    if (!f1) return;
    // Where is the cutoff right now? Include the filter envelope and the LFO.
    let cents = 0;
    const live = s?.voices.filter((v) => !v.released).pop();
    if (live) cents = live.filters[1].detune.value;
    if (this.lfoAnalyser) cents += this.lfoHist[this.histPos] * (p.lfoToCutoff / 100) * 4800;
    const cutoff = clamp(p.cutoff * Math.pow(2, cents / 1200), 20, 20000);
    const resDb = -3 + 31 * Math.pow(p.resonance / 100, 1.6);
    const resQ = 0.6 + 18 * Math.pow(p.resonance / 100, 2);
    const ft = p.filterType;
    f1.type = ft === 'hp' ? 'highpass' : ft === 'bp' ? 'bandpass' : 'lowpass';
    f1.frequency.value = cutoff;
    f1.Q.value = ft === 'lp24' ? -3 : ft === 'bp' ? resQ : resDb;
    f2.type = ft === 'lp24' ? 'lowpass' : 'allpass';
    f2.frequency.value = cutoff;
    f2.Q.value = ft === 'lp24' ? resDb : 0.0001;
    const N = 240;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = freqForX((i / (N - 1)) * w, w);
    const m1 = new Float32Array(N); const m2 = new Float32Array(N); const ph = new Float32Array(N);
    f1.getFrequencyResponse(freqs, m1, ph);
    f2.getFrequencyResponse(freqs, m2, ph);
    g.strokeStyle = c.ink;
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const db = 20 * Math.log10(Math.max(1e-6, m1[i] * m2[i]));
      // Draw the curve on its own scale: 0 dB sits near the top.
      const y = clamp(h * 0.18 - db * (h / 90), 0, h);
      const x = xForFreq(freqs[i], w);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.setLineDash([]);
    const x = xForFreq(cutoff, w);
    g.fillStyle = c.ink;
    g.beginPath(); g.arc(x, clamp(h * 0.18, 4, h), 3.5, 0, Math.PI * 2); g.fill();
  }

  _drawShape(g, w, h, c) {
    const p = this.synth ? this.synth.p : { ...this._defaults(), ...this.params };
    const a = attackTime(p.attack); const d = decayTime(p.decay); const r = releaseTime(p.release);
    const s = p.sustain / 100;
    const hold = Math.max(0.4, (a + d) * 0.6);
    const total = a + d + hold + r;
    const X = (t) => 10 + (t / total) * (w - 20);
    const Y = (v) => h - 12 - v * (h - 28);
    grid(g, w, h, 8, 3);
    // Shape
    g.strokeStyle = c.time; g.lineWidth = 2.2; g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(X(0), Y(0));
    g.lineTo(X(a), Y(1));
    for (let i = 1; i <= 24; i++) { const t = (i / 24) * d; g.lineTo(X(a + t), Y(s + (1 - s) * Math.exp(-4 * t / d))); }
    g.lineTo(X(a + d + hold), Y(s));
    for (let i = 1; i <= 24; i++) { const t = (i / 24) * r; g.lineTo(X(a + d + hold + t), Y(s * Math.exp(-5 * t / r))); }
    g.stroke();
    // Stage labels
    g.fillStyle = c.ink3; g.font = '11px Archivo, sans-serif';
    g.fillText('A', X(a / 2) - 3, h - 2);
    g.fillText('D', X(a + d / 2) - 3, h - 2);
    g.fillText('S', X(a + d + hold / 2) - 3, h - 2);
    g.fillText('R', X(a + d + hold + r / 2) - 3, h - 2);
    // Playhead for the note you're holding.
    if (this.lastOn != null) {
      const now = performance.now();
      let t;
      if (this.lastOff == null) t = Math.min((now - this.lastOn) / 1000, a + d + hold * 0.5);
      else t = a + d + hold + Math.min((now - this.lastOff) / 1000, r);
      if (this.lastOff == null || (now - this.lastOff) / 1000 < r + 0.3) {
        g.fillStyle = c.time;
        g.beginPath();
        let v;
        if (t < a) v = t / a; else if (t < a + d) v = s + (1 - s) * Math.exp(-4 * (t - a) / d);
        else if (t < a + d + hold) v = s; else v = s * Math.exp(-5 * (t - a - d - hold) / r);
        g.arc(X(t), Y(v), 5, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

customElements.define('synth-lab', SynthLab);
