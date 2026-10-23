// <aks-lab> — a playable model of the Behringer AKS Mini, laid out like its
// panel (VCO, VCF, LFO, envelope shaper, output), with the real AKS Mini
// played alongside over MIDI when it's connected.
//
//   heading   panel title
//   intro     one line under the title
//   controls  space-separated control keys and/or group names
//             (VCO Voices VCF LFO Envelope Output); see audio/aks-core.js
//   preset    JSON of starting settings, on the panel's 0–10 scale
//   views     any of: wave spectrum trap voices joystick (default "wave trap")
//   filter-curve   overlay the filter's response on the spectrum
//   joystick  the two controls the joystick moves, x then y (default "cutoff response")
//   chord     notes for the Hold button, e.g. "48 55 60"
//   low       lowest key on the drawn keyboard (default 48)
//
// <aks-panel> — just the AKS Mini's MIDI connection, for the lesson that
// introduces it.

import { audio, resume, clamp, noteName, midiToHz } from '../audio/core.js';
import { AKSSynth } from '../audio/aks-synth.js';
import {
  AKS_PARAMS, AKS_GROUPS, AKS_DEFAULTS, AKS_CC, cutoffHz, trapezoidTimes, trapezoidAt,
  loops, vcaGain, allocate, pickNotes, lfoHz,
} from '../audio/aks-core.js';
import { aks } from '../hw/aks.js';
import { fm1 } from '../hw/fm1.js';
import { el, makeControl } from '../ui/controls.js';
import { Keyboard, registerInstrument } from '../ui/keyboard.js';
import {
  onFrame, fit, colors, grid, drawWave, drawSpectrum, freqGrid, xForFreq, freqForX, makeAnalyser, drawFlow, flowPointer,
} from '../ui/draw.js';
import { enableFocus } from '../ui/focus.js';

let uid = 0;
const PREFIX = 'aks:'; // keeps these keys apart from the VA controls in ui/params.js
const def = (key) => AKS_PARAMS[key];
const continuous = Object.keys(AKS_PARAMS).filter((k) => def(k).type !== 'choice');
const FOCUS_VIEWS = ['wave', 'spectrum', 'trap', 'voices']; // added in focus mode

// The AKS Mini's fixed signal path, and what moves it. Clicking a stage points
// at its controls on the panel.
const STAGES = {
  vcos: { name: 'VCOs', about: 'the three oscillators mixed, before anything shapes them', keys: AKS_GROUPS.VCO },
  filter: { name: 'VCF', about: 'one filter for every key; Response makes it ring, and near the top whistle by itself', keys: AKS_GROUPS.VCF },
  vca: { name: 'VCA', about: 'Signal sets how far it’s open without the envelope, Trapez how much the envelope adds', keys: ['trapez', 'signal'] },
  spring: { name: 'Spring', about: 'the spring reverb, then out to the headphones', keys: ['reverb'] },
  hw: { name: 'Audio in', about: 'the real AKS Mini, through an audio interface', keys: [] },
  env: { name: 'Trapezoid', about: 'one envelope for every key: Attack, On, Decay, then Off before it fires again', keys: AKS_GROUPS.Envelope },
  lfo: { name: 'LFO', about: 'a slow wave on the pitch and the filter', keys: AKS_GROUPS.LFO },
  stick: { name: 'Joystick', about: 'moves two knobs at once', keys: [] },
};
// Where a joystick axis lands in the picture: the stage, or the modulator,
// whose control it moves.
const stageOf = (key) => ['vcos', 'filter', 'vca', 'spring', 'lfo', 'env'].find((s) => STAGES[s].keys.includes(key)) || 'vca';

// ---------- The AKS Mini's MIDI port: shared by the lab and the panel ----------
function portRow(say) {
  const light = el('span', { class: 'light' }, el('span', { text: 'AKS Mini: not connected' }));
  const connect = el('button', { class: 'btn hw', type: 'button', text: 'Connect MIDI' });
  const select = el('select', { 'aria-label': 'MIDI output to the AKS Mini' });
  const ch = el('input', { type: 'number', min: 1, max: 16, value: aks.channel, 'aria-label': 'AKS Mini MIDI channel' });
  const test = el('button', { class: 'btn', type: 'button', text: 'Test note' });
  const node = el('div', { class: 'aks-port' }, [
    light, connect,
    el('label', { class: 'aks-port-field' }, [el('span', { text: 'Port' }), select]),
    el('label', { class: 'aks-port-field aks-port-ch' }, [el('span', { text: 'Ch' }), ch]),
    test,
  ]);

  const refresh = () => {
    const on = aks.connected;
    light.toggleAttribute('data-on', on);
    light.firstChild.textContent = on ? `AKS Mini: ${aks.output.name}` : aks.access ? 'AKS Mini: pick its port' : 'AKS Mini: not connected';
    connect.hidden = !!aks.access || !aks.supported;
    select.parentElement.hidden = !aks.access;
    ch.parentElement.hidden = !aks.access;
    test.hidden = !aks.access;
    test.disabled = !on;
    select.replaceChildren(el('option', { value: '', text: 'None' }),
      ...aks.outputs().map((p) => el('option', { value: p.id, text: p.name })));
    select.value = aks.output?.id || '';
    if (document.activeElement !== ch) ch.value = aks.channel;
  };
  connect.addEventListener('click', async () => {
    try {
      const found = await aks.connect();
      say(found ? `Found “${aks.output.name}”. The page can now play the AKS Mini.`
        : 'MIDI is on, but no port named AKS was found. Plug the AKS Mini in by USB, or pick its port from the list.');
    } catch (err) { say(err.message || 'MIDI permission was refused.', true); }
  });
  select.addEventListener('change', () => aks.selectOutput(select.value || null));
  ch.addEventListener('change', () => aks.setChannel(ch.value));
  test.addEventListener('click', () => {
    aks.noteOn(60, 0.8);
    setTimeout(() => aks.noteOff(60), 600);
    say('Sent middle C. If the AKS Mini played it, the port and channel are right. If not, check the channel it receives on.');
  });
  if (!aks.supported) say('This browser has no Web MIDI, so it can’t play the AKS Mini. Chrome, Edge or Firefox on a computer will.', true);
  aks.addEventListener('change', refresh);
  refresh();
  return node;
}

class AksPanel extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    const msg = el('p', { class: 'msg', role: 'status' });
    const say = (text, error = false) => { msg.textContent = text; msg.toggleAttribute('data-error', error); };
    this.append(el('section', { class: 'instrument aks-panel' }, [
      el('div', { class: 'instrument-head' }, [
        el('h3', { text: 'Connect an AKS Mini' }),
        el('p', { text: 'USB-C carries MIDI and power. No driver needed.' }),
      ]),
      portRow(say),
      el('div', { class: 'where' }, msg),
    ]));
  }
}

// ---------- The lab ----------
class AksLab extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.preset = JSON.parse(this.getAttribute('preset') || '{}');
    this.params = { ...this.preset };
    this.views = (this.getAttribute('views') || 'wave trap').split(/\s+/).filter(Boolean);
    this.chord = (this.getAttribute('chord') || '48 55 60').split(/\s+/).map(Number);
    this.baseNote = Number(this.getAttribute('low') || 48);
    const [jx, jy] = (this.getAttribute('joystick') || 'cutoff response').split(/\s+/);
    this.axes = { x: continuous.includes(jx) ? jx : 'cutoff', y: continuous.includes(jy) ? jy : 'response' };
    this.target = 'page';
    this.mirror = false;
    this.held = new Set();
    this.sustain = false;
    this.sustained = new Set();
    this.trail = [];
    this._build();
    registerInstrument(this);
  }

  get root() { return this; }

  full() { return { ...AKS_DEFAULTS, ...this.params }; }

  // ---------- Audio ----------
  ensure() {
    if (this.synth) return this.synth;
    const { ctx, master } = audio();
    this.synth = new AKSSynth(this.full());
    this.analyser = makeAnalyser(ctx, 8192, 0.5);
    this.synth.output.connect(this.analyser).connect(master);
    this.lfoAnalyser = makeAnalyser(ctx, 256, 0);
    this.synth.lfoOut.connect(this.lfoAnalyser);
    this.curveFilters = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    this._applyTarget();
    return this.synth;
  }

  // With notes going only to the real AKS Mini, the model still runs (so the
  // pictures follow along) but stays quiet.
  _applyTarget() {
    if (!this.synth) return;
    const g = this.target === 'aks' || this.muted ? 0 : 0.9;
    this.synth.output.gain.setTargetAtTime(g, this.synth.ctx.currentTime, 0.03);
  }

  noteOn(note, vel = 0.8, source) {
    resume();
    this.sustained.delete(note);
    if (this.held.has(note)) this._noteOffNow(note);
    this.ensure().noteOn(note, vel);
    if (this.target !== 'page') aks.noteOn(note, vel);
    this.held.add(note);
    this.kb.light(note, true);
    this.lastSource = source;
  }

  noteOff(note, source) {
    // A held sustain pedal keeps notes down until it comes up.
    if (this.sustain && source !== 'reset' && this.held.has(note)) {
      this.sustained.add(note);
      this.kb.light(note, false);
      return;
    }
    this._noteOffNow(note);
  }

  _noteOffNow(note) {
    if (this.synth) this.synth.noteOff(note);
    if (this.target !== 'page') aks.noteOff(note);
    this.held.delete(note);
    this.sustained.delete(note);
    this.kb.light(note, false);
  }

  showHardwareNote(note, on) { this.kb.light(note, on, 'data-hw'); }

  shiftOctave(d) {
    this.baseNote = clamp(this.baseNote + d * 12, 24, 84);
    this.kb.setLow(this.baseNote);
    this.say(`Keyboard starts at C${this.baseNote / 12 - 1}.`);
  }

  // A keyboard plugged into the page (ui/keyboard.js calls these).
  hwBend(x) {
    this.synth?.bend(x);
    if (this.target !== 'page') aks.bend(x);
  }

  hwMod(x) {
    this.synth?.mod(x);
    if (this.target !== 'page') aks.sendParam('mod', x);
  }

  hwSustain(on) {
    this.sustain = !!on;
    if (!on) for (const n of [...this.sustained]) this._noteOffNow(n);
  }

  // One control changed: from its slider ('ui'), the joystick, or code.
  set(key, value, source = 'ui') {
    this.params[key] = value;
    if (this.synth) this.synth.set({ [key]: value });
    if (source !== 'ui') this.ctls.get(key)?.update(value);
    if (this.mirror) aks.sendParam(key, value);
  }

  // ---------- UI ----------
  _keys() {
    const spec = (this.getAttribute('controls') || '').split(/\s+/).filter(Boolean);
    const out = [];
    for (const s of spec) {
      if (AKS_GROUPS[s]) out.push({ group: s, keys: AKS_GROUPS[s] });
      else if (AKS_PARAMS[s]) {
        const last = out[out.length - 1];
        if (last && last.loose) last.keys.push(s); else out.push({ loose: true, keys: [s] });
      }
    }
    return out;
  }

  _build() {
    const heading = this.getAttribute('heading') || 'AKS Mini';
    const intro = this.getAttribute('intro');
    const box = el('section', { class: 'instrument aks', 'aria-label': heading });
    this.box = box;

    const powerId = `aks-pow-${++uid}`;
    const power = el('input', { type: 'checkbox', id: powerId, role: 'switch' });
    power.checked = true;
    power.addEventListener('change', () => { this.muted = !power.checked; this._applyTarget(); });
    box.append(el('div', { class: 'instrument-head' }, [
      el('h3', { text: heading }), intro ? el('p', { text: intro }) : null,
      el('span', { class: 'grow' }),
      el('label', { class: 'switch aks-power', for: powerId, title: 'Mute the page’s model (the real AKS Mini isn’t affected)' }, [power, el('span', { text: 'Sound' })]),
    ]));

    // Signal path
    if (this.getAttribute('flow') !== 'off') {
      this.flowCanvas = el('canvas', { role: 'img', 'aria-label': 'Signal path: VCOs, filter, VCA and spring, and the trapezoid, LFO and joystick that move them. Click a stage to find its controls.' });
      box.append(el('div', { class: 'viz flow' }, this.flowCanvas));
      this._flowHits = [];
      flowPointer(this.flowCanvas, () => this._flowHits, {
        onHover: (id) => {
          this._flowHover = id;
          if (id && this.where) this.where.replaceChildren(el('b', { text: STAGES[id].name }), `: ${STAGES[id].about}.`);
        },
        onClick: (id) => this._pointAt(id),
      });
    }

    // Visualizations
    const row = el('div', { class: 'viz-row' });
    this.canvases = {};
    const labels = { wave: 'Waveform', spectrum: 'Spectrum', trap: 'Envelope shaper', voices: 'Three VCOs', joystick: 'Joystick' };
    for (const v of [...this.views, ...FOCUS_VIEWS.filter((x) => !this.views.includes(x))]) {
      if (!labels[v]) continue;
      const c = el('canvas', { role: 'img', 'aria-label': labels[v] });
      const legend = el('div', { class: 'viz-legend' });
      const viz = el('div', { class: `viz aks-viz-${v}`, style: `height:${v === 'joystick' ? 220 : 190}px` }, [c, el('div', { class: 'viz-label', text: labels[v] }), legend]);
      if (!this.views.includes(v)) viz.setAttribute('data-extra', '');
      if (v === 'joystick') row.append(this._joystick(viz, c));
      else row.append(viz);
      this.canvases[v] = { c, legend };
    }
    box.append(row);

    // Controls, grouped like the panel.
    const ctlWrap = el('div', { class: 'controls' });
    this.ctls = new Map();
    const groups = this._keys();
    const many = groups.filter((g) => g.group).length > 1;
    for (const g of groups) {
      const target = many && g.group ? el('div', { class: 'control-group' }, el('div', { class: 'group-name', text: g.group })) : ctlWrap;
      for (const k of g.keys) {
        const d = def(k);
        const c = makeControl(PREFIX + k, this.full()[k], (_, v) => this.set(k, v), { label: d.label, def: d });
        this.ctls.set(k, c);
        target.append(c);
        const where = () => {
          this.where.replaceChildren('On the AKS Mini: ', el('b', { text: d.where }),
            Object.hasOwn(AKS_CC, k) ? ` (CC ${AKS_CC[k]})` : '');
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
    const fire = el('button', { class: 'btn', type: 'button', text: 'Fire envelope' });
    fire.title = 'Like the AKS Mini’s joystick button: starts the envelope without a key';
    fire.addEventListener('click', () => {
      resume();
      const s = this.ensure();
      if (s.cycling) { s.stopCycling(); this.say('Stopped the loop. It runs again from the next key or Fire envelope while Off is 6 or below.'); return; }
      s.trigger();
      if (s.cycling) this.say('Looping: Off is 6 or below, so the envelope fires itself again after each Off gap. Press again to stop it.');
    });
    this.fireBtn = fire;
    const holdBtn = el('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', text: 'Hold a chord' });
    holdBtn.addEventListener('click', () => {
      const on = holdBtn.getAttribute('aria-pressed') !== 'true';
      holdBtn.setAttribute('aria-pressed', String(on));
      for (const n of this.chord) on ? this.noteOn(n, 0.75, 'hold') : this.noteOff(n, 'reset');
    });
    this.holdBtn = holdBtn;
    box.append(el('div', { class: 'keys-wrap' }, [
      el('div', { class: 'keys-bar' }, [
        el('span', { text: 'Play with the mouse, or click this panel and use keys A–K (Z and X shift octaves).' }),
        el('span', { class: 'grow' }), fire, holdBtn,
      ]),
      this.kb.root,
    ]));

    // Footer: where notes go, mirroring, and the AKS Mini's port.
    const seg = el('div', { class: 'seg neutral', role: 'group', 'aria-label': 'Play on' });
    const targets = [['page', 'This page'], ['aks', 'AKS Mini'], ['both', 'Both']];
    const segBtns = targets.map(([val, label]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(val === this.target), text: label });
      b.addEventListener('click', () => {
        this._releaseAll();
        this.target = val;
        segBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(targets[i][0] === val)));
        this._applyTarget();
      });
      seg.append(b);
      return b;
    });
    const mirrorId = `aks-mir-${uid}`;
    const mirror = el('input', { type: 'checkbox', id: mirrorId });
    mirror.addEventListener('change', () => {
      this.mirror = mirror.checked;
      if (this.mirror) this._send('Mirroring: each control with a MIDI number moves on the AKS Mini too. Response, Signal, Reverb and the LFO wave have none, so set those by hand.');
    });
    const sendBtn = el('button', { class: 'btn hw', type: 'button', text: 'Send settings to AKS Mini' });
    sendBtn.addEventListener('click', () => this._send());
    const resetBtn = el('button', { class: 'btn', type: 'button', text: 'Reset' });
    resetBtn.addEventListener('click', () => this.reset());
    box.append(el('div', { class: 'instrument-foot' }, [
      el('span', { class: 'label', text: 'Play on' }), seg,
      el('label', { class: 'switch', for: mirrorId, style: '--c: var(--hw)' }, [mirror, el('span', { text: 'Mirror to AKS Mini' })]),
      el('span', { class: 'grow' }), sendBtn, resetBtn,
    ]));
    this.status = el('div', { class: 'where', role: 'status' });
    const say = (text, error = false) => { this.status.textContent = text; this.status.toggleAttribute('data-error', error); };
    box.append(el('div', { class: 'instrument-foot aks-foot' }, portRow(say)));
    box.append(this.status);
    this.append(box);

    const syncHw = () => {
      const out = aks.connected;
      sendBtn.disabled = !out;
      mirror.disabled = !out;
      segBtns[1].disabled = !out;
      segBtns[2].disabled = !out;
      if (!out && this.target !== 'page') {
        this._releaseAll();
        this.target = 'page';
        segBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(i === 0)));
        this._applyTarget();
      }
      sendBtn.title = out ? '' : 'Connect the AKS Mini below to use this';
    };
    aks.addEventListener('change', syncHw);
    syncHw();

    this.addEventListener('pointerdown', () => { resume(); this.ensure(); }, { once: true });
    this.addEventListener('focusin', () => this.ensure(), { once: true });
    for (const [v, { c, legend }] of Object.entries(this.canvases)) onFrame(c, (now) => this._draw(v, c, legend, now));
    if (this.flowCanvas) onFrame(this.flowCanvas, (now) => this._drawFlow(now));
    enableFocus(this);
    this.addEventListener('focuschange', (e) => { if (e.detail.on) { resume(); this.ensure(); } });
  }

  // Light up the controls for one stage of the signal path.
  _pointAt(id) {
    const keys = id === 'stick' ? [this.axes.x, this.axes.y] : STAGES[id].keys;
    const found = keys.map((k) => this.ctls.get(k)).filter(Boolean);
    for (const c of found) {
      c.setAttribute('data-flash', '');
      clearTimeout(c._flash);
      c._flash = setTimeout(() => c.removeAttribute('data-flash'), 1200);
    }
    if (found.length) {
      const r = found[0].getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) found[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    if (!this.where) return;
    this.where.replaceChildren(el('b', { text: STAGES[id].name }), found.length
      ? `: ${found.map((c) => c.querySelector('label, .ctl-name, .switch span')?.textContent).filter(Boolean).join(', ')}.`
      : id === 'hw' ? `: ${STAGES.hw.about}.` : ': none of its controls are on this panel.');
  }

  // ---------- Signal path ----------
  _drawFlow(now) {
    const { g, w, h } = fit(this.flowCanvas);
    const c = colors();
    g.clearRect(0, 0, w, h);
    const p = this.full();
    const taps = this.synth?.taps();
    const n1 = (v) => (Math.round(v * 10) / 10).toString();
    const stages = [
      { id: 'vcos', name: STAGES.vcos.name, color: c.sound, tap: taps?.vcos, sub: `${def('mode').names[def('mode').options.indexOf(p.mode)]} · saw ${n1(p.saw)} sq ${n1(p.square)}` },
      { id: 'filter', name: STAGES.filter.name, color: c.sound, tap: taps?.filter, sub: `${def('cutoff').format(p.cutoff).split(' · ')[1]} · R ${n1(p.response)}` },
      { id: 'vca', name: STAGES.vca.name, color: c.time, tap: taps?.vca, sub: `trap ${n1(p.trapez)} · sig ${n1(p.signal)}` },
      { id: 'spring', name: STAGES.spring.name, color: c.space, tap: taps?.out, sub: p.reverb ? `reverb ${n1(p.reverb)}` : 'dry', dim: !p.reverb },
    ];
    if (fm1.analyser) stages.push({ id: 'hw', name: STAGES.hw.name, color: c.hw, tap: fm1.analyser, sub: 'real output', aside: true });
    const mods = [
      { id: 'lfo', name: STAGES.lfo.name, color: c.move, over: 'vcos', at: 0.85, land: 0.35, rate: lfoHz(p.lfoRate), targets: [['vcos', p.lfoPitch / 10], ['filter', p.lfoCutoff / 10]] },
      { id: 'env', name: STAGES.env.name, color: c.time, over: 'vca', at: 0.5, land: 0.62, active: (this.synth?.envAt().level ?? 0) > 0.01, targets: [['vca', p.trapez / 10], ['filter', p.egInt / 10], ['vcos', p.pitchEg / 10]] },
    ];
    if (this.views.includes('joystick')) {
      mods.push({ id: 'stick', name: STAGES.stick.name, color: c.ink2, over: 'spring', at: 0.5, land: 0.5, targets: [[stageOf(this.axes.x), 0.6], [stageOf(this.axes.y), 0.6]] });
    }
    this._flowState ||= {};
    this._flowHits = drawFlow(g, w, h, now, { stages, mods, state: this._flowState, hover: this._flowHover });
  }

  _send(message) {
    if (!aks.connected) return;
    const n = aks.sendPatch(this.full());
    this.say(message || `Sent ${n} settings to the AKS Mini. Response, Signal, Reverb and the LFO wave have no MIDI number, so set those on its panel.`);
  }

  say(text) { this.status.textContent = text; this.status.removeAttribute('data-error'); }

  _releaseAll() {
    this.sustained.clear();
    for (const n of [...this.held]) this._noteOffNow(n);
    this.holdBtn?.setAttribute('aria-pressed', 'false');
  }

  reset() {
    this._releaseAll();
    this.synth?.stopCycling();
    this.params = { ...this.preset };
    const full = this.full();
    if (this.synth) this.synth.set(full);
    for (const [k, c] of this.ctls) c.update(full[k]);
    if (this.mirror) this._send('Reset, and sent the starting settings to the AKS Mini.');
  }

  // ---------- Joystick ----------
  _joystick(viz, canvas) {
    const id = `aks-joy-${++uid}`;
    const choose = (axis) => {
      const s = el('select', { 'aria-label': `Joystick ${axis.toUpperCase()} moves` },
        continuous.map((k) => el('option', { value: k, text: def(k).label })));
      s.value = this.axes[axis];
      s.addEventListener('change', () => { this.axes[axis] = s.value; });
      return el('label', { class: 'aks-port-field' }, [el('span', { text: axis.toUpperCase() }), s]);
    };
    const spring = el('input', { type: 'checkbox', id });
    spring.checked = true;
    const opts = el('div', { class: 'aks-joy-opts' }, [
      choose('x'), choose('y'),
      el('label', { class: 'switch', for: id, style: '--c: var(--move)' }, [spring, el('span', { text: 'Spring back' })]),
    ]);

    const norm = (k) => { const d = def(k); return (this.full()[k] - d.min) / (d.max - d.min); };
    const value = (k, t) => { const d = def(k); return Math.round((d.min + clamp(t, 0, 1) * (d.max - d.min)) * 10) / 10; };
    let start = null;
    let anim = 0;
    const move = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = 1 - (e.clientY - r.top) / r.height;
      this.set(this.axes.x, value(this.axes.x, x), 'joystick');
      this.set(this.axes.y, value(this.axes.y, y), 'joystick');
    };
    canvas.addEventListener('pointerdown', (e) => {
      cancelAnimationFrame(anim);
      resume(); this.ensure();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
      start = { x: this.full()[this.axes.x], y: this.full()[this.axes.y] };
      viz.toggleAttribute('data-grab', true);
      move(e);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => { if (start) move(e); });
    const end = () => {
      if (!start) return;
      viz.removeAttribute('data-grab');
      const from = { x: this.full()[this.axes.x], y: this.full()[this.axes.y] };
      const to = start;
      start = null;
      if (!spring.checked) return;
      // Spring back to where the stick was picked up, over a quarter second.
      const t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / 250);
        const e2 = 1 - Math.pow(1 - k, 3);
        this.set(this.axes.x, from.x + (to.x - from.x) * e2, 'joystick');
        this.set(this.axes.y, from.y + (to.y - from.y) * e2, 'joystick');
        if (k < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
    this._joyNorm = norm;
    return el('div', { class: 'aks-joy' }, [viz, opts]);
  }

  // ---------- Drawing ----------
  _legend(legend, items) {
    const key = items.map((i) => i[0]).join('|');
    if (legend.dataset.key === key) return;
    legend.dataset.key = key;
    legend.replaceChildren(...items.map(([label, color]) => el('span', {}, [Object.assign(el('i'), { style: `background:${color}` }), label])));
  }

  _lfoNow() {
    if (!this.lfoAnalyser) return 0;
    const d = this._lfoBuf ||= new Float32Array(this.lfoAnalyser.fftSize);
    this.lfoAnalyser.getFloatTimeDomainData(d);
    return d[d.length - 1];
  }

  _draw(view, canvas, legend) {
    const { g, w, h } = fit(canvas);
    const c = colors();
    g.clearRect(0, 0, w, h);
    const hw = fm1.analyser;
    if (view === 'wave') {
      grid(g, w, h, 8, 4);
      if (hw) drawWave(g, w, h, hw, { color: c.hw, lineWidth: 1.6 });
      if (this.analyser) drawWave(g, w, h, this.analyser, { color: c.sound });
      else { g.strokeStyle = c.sound; g.lineWidth = 2; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke(); }
      this._legend(legend, hw ? [['This page', c.sound], ['Audio in', c.hw]] : [['This page', c.sound]]);
    } else if (view === 'spectrum') {
      freqGrid(g, w, h);
      if (hw) drawSpectrum(g, w, h, hw, { color: c.hw, fill: false, lineWidth: 1.2 });
      if (this.analyser) drawSpectrum(g, w, h, this.analyser, { color: c.sound });
      const items = [['This page', c.sound]];
      if (hw) items.push(['Audio in', c.hw]);
      if (this.hasAttribute('filter-curve')) { this._drawFilterCurve(g, w, h, c); items.push(['Filter', c.ink]); }
      this._legend(legend, items);
    } else if (view === 'trap') {
      this._drawTrap(g, w, h, c);
      this._legend(legend, [['Envelope', c.time], ['VCA', c.sound]]);
    } else if (view === 'voices') {
      this._drawVoices(g, w, h, c);
      this._legend(legend, [[(AKS_PARAMS.mode.names[AKS_PARAMS.mode.options.indexOf(this.full().mode)] || 'Poly') + ' mode', c.sound]]);
    } else if (view === 'joystick') {
      this._drawJoystick(g, w, h, c);
    }
  }

  _drawFilterCurve(g, w, h, c) {
    const p = this.full();
    const [f1, f2] = this.curveFilters || [];
    if (!f1) return;
    // Where the cutoff is right now: the knob, the envelope and the LFO.
    const env = this.synth ? this.synth.envAt().level : 0;
    const cents = env * (p.egInt / 10) * 6000 + this._lfoNow() * (p.lfoCutoff / 10) * 4800;
    const cutoff = clamp(cutoffHz(p.cutoff) * Math.pow(2, cents / 1200), 20, 20000);
    const q = -3 + 30 * Math.pow(p.response / 10, 1.5);
    f1.type = 'lowpass'; f1.frequency.value = cutoff; f1.Q.value = p.slope === '12' ? q : -3;
    f2.type = p.slope === '12' ? 'allpass' : 'lowpass'; f2.frequency.value = cutoff; f2.Q.value = p.slope === '12' ? 0.0001 : q;
    const N = 200;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = freqForX((i / (N - 1)) * w, w);
    const m1 = new Float32Array(N); const m2 = new Float32Array(N); const ph = new Float32Array(N);
    f1.getFrequencyResponse(freqs, m1, ph);
    f2.getFrequencyResponse(freqs, m2, ph);
    g.strokeStyle = c.ink; g.lineWidth = 1.5; g.setLineDash([5, 4]);
    g.beginPath();
    for (let i = 0; i < N; i++) {
      const db = 20 * Math.log10(Math.max(1e-6, m1[i] * m2[i]));
      const y = clamp(h * 0.18 - db * (h / 90), 0, h);
      const x = xForFreq(freqs[i], w);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.setLineDash([]);
  }

  // The trapezoid: Attack, On, Decay, then Off. Two cycles when it loops, one
  // with a dashed wait when it waits for a key. The blue line is what the VCA
  // lets through: SIGNAL caps it, TRAPEZ sets how far the envelope moves it.
  _drawTrap(g, w, h, c) {
    const p = this.full();
    const t = trapezoidTimes(p);
    const looping = loops(p);
    const offShown = looping ? t.off : Math.max(0.25, (t.a + t.on + t.d) * 0.35);
    const cycle = t.a + t.on + t.d + offShown;
    const total = looping ? cycle * 2 : cycle;
    const X = (s) => 10 + (s / total) * (w - 20);
    const Y = (v) => h - 18 - v * (h - 60);
    grid(g, w, h, 8, 3);
    const shapeAt = (s) => {
      const k = looping ? s % cycle : s;
      return trapezoidAt(k, t).level;
    };
    const N = 300;
    const line = (color, f, width, dash) => {
      g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round';
      g.setLineDash(dash || []);
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const s = (i / N) * total;
        const y = Y(f(shapeAt(s)));
        if (i === 0) g.moveTo(X(s), y); else g.lineTo(X(s), y);
      }
      g.stroke();
      g.setLineDash([]);
    };
    line(c.sound, (v) => vcaGain(v, p), 1.4, [4, 3]);
    line(c.time, (v) => v, 2.2);
    // Stage names under the first cycle.
    g.fillStyle = c.ink3; g.font = '11px Archivo, sans-serif';
    const label = (text, s0, s1) => { if (X(s1) - X(s0) > 18) g.fillText(text, (X(s0) + X(s1)) / 2 - g.measureText(text).width / 2, h - 3); };
    label('Attack', 0, t.a);
    label('On', t.a, t.a + t.on);
    label('Decay', t.a + t.on, t.a + t.on + t.d);
    label(looping ? 'Off' : 'waits', t.a + t.on + t.d, cycle);
    if (!looping) {
      g.strokeStyle = c.time; g.setLineDash([3, 4]); g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(X(t.a + t.on + t.d), Y(0)); g.lineTo(X(cycle), Y(0)); g.stroke(); g.setLineDash([]);
    }
    // Playhead: where the running envelope is.
    if (this.synth?.cycle) {
      const now = this.synth.ctx.currentTime;
      const e = this.synth.envAt(now);
      const { a, on, d } = this.synth.cycle.times;
      const from = this.synth.cycle.from;
      const rise = a * (1 - from);
      // Map the live cycle onto the drawn one, stage by stage.
      let s;
      if (e.stage === 'attack') s = (from + (1 - from) * (e.dt / Math.max(rise, 1e-6))) * t.a;
      else if (e.stage === 'on') s = t.a + (e.dt - rise) / Math.max(on, 1e-6) * t.on;
      else if (e.stage === 'decay') s = t.a + t.on + (e.dt - rise - on) / Math.max(d, 1e-6) * t.d;
      else s = t.a + t.on + t.d + Math.min(offShown, e.dt - rise - on - d);
      if (e.stage !== 'off' || e.dt - rise - on - d < offShown + 0.4 || this.synth.cycling) {
        g.fillStyle = c.time;
        g.beginPath(); g.arc(X(s), Y(e.level), 5, 0, Math.PI * 2); g.fill();
      }
      // A level bar at the right edge.
      g.fillStyle = c.time;
      g.globalAlpha = 0.25;
      g.fillRect(w - 6, Y(1), 4, Y(0) - Y(1));
      g.globalAlpha = 1;
      g.fillRect(w - 6, Y(e.level), 4, Y(0) - Y(e.level));
    }
    g.fillStyle = c.ink3;
    g.fillText(looping ? 'Loops by itself (Off ≤ 6)' : 'Fires on each key', 10, 34);
  }

  // Three lanes, one per VCO, each with the note it's playing. Keys held but
  // not sounding (more keys than VCOs) are listed struck through.
  _drawVoices(g, w, h, c) {
    const p = this.full();
    const notes = this.synth ? this.synth.notes : (allocate([...this.held], p.mode, p.priority) || [48, 48, 48]);
    const env = this.synth ? this.synth.envAt().level : 0;
    const lane = (h - 50) / 3;
    const top = 26;
    const playing = this.synth ? this.synth.held : [...this.held];
    const sounding = new Set(p.mode === 'poly' ? pickNotes(playing, p.priority, 3) : pickNotes(playing, p.priority, 1));
    const now = performance.now() / 1000;
    g.font = '600 12px Archivo, sans-serif';
    notes.forEach((n, i) => {
      const y = top + i * lane;
      const live = vcaGain(env, p) > 0.001;
      g.fillStyle = c.surface;
      g.globalAlpha = 1;
      g.fillRect(8, y + 3, w - 16, lane - 6);
      g.strokeStyle = c.rule; g.lineWidth = 1;
      g.strokeRect(8.5, y + 3.5, w - 17, lane - 7);
      // A small moving wave at the VCO's pitch, brighter while the VCA is open.
      const f = midiToHz(n + 12 * (p.oct || 0));
      const cyclesShown = clamp(f / 110, 1, 10);
      g.strokeStyle = c.sound;
      g.globalAlpha = live ? 0.35 + 0.65 * Math.min(1, vcaGain(env, p) * 3) : 0.25;
      g.lineWidth = 1.6;
      g.beginPath();
      const x0 = 120; const x1 = w - 16;
      for (let x = x0; x <= x1; x += 2) {
        const ph = ((x - x0) / (x1 - x0)) * cyclesShown + now * 0.5 * (i + 1);
        const v = Math.sin(2 * Math.PI * ph);
        const yy = y + lane / 2 - v * (lane / 2 - 9);
        if (x === x0) g.moveTo(x, yy); else g.lineTo(x, yy);
      }
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = c.ink;
      g.fillText(`VCO ${i + 1}`, 18, y + lane / 2 - 2);
      g.fillStyle = c.sound;
      g.fillText(`${noteName(n + 12 * (p.oct || 0))}  ${Math.round(f)} Hz`, 18, y + lane / 2 + 13);
    });
    // Held keys, with the ones left out by note priority struck through.
    g.font = '11px Archivo, sans-serif';
    let x = 10;
    g.fillStyle = c.ink3;
    g.fillText('Held:', x, h - 8);
    x += g.measureText('Held: ').width;
    if (!playing.length) { g.fillText('none (the VCOs keep their last notes)', x, h - 8); return; }
    for (const n of playing) {
      const name = noteName(n);
      const width = g.measureText(name).width;
      g.fillStyle = sounding.has(n) ? c.ink : c.ink3;
      g.fillText(name, x, h - 8);
      if (!sounding.has(n)) { g.strokeStyle = c.move; g.lineWidth = 1.4; g.beginPath(); g.moveTo(x - 1, h - 12); g.lineTo(x + width + 1, h - 12); g.stroke(); }
      x += width + 8;
    }
  }

  _drawJoystick(g, w, h, c) {
    const p = this.full();
    grid(g, w, h, 6, 6);
    const nx = this._joyNorm ? this._joyNorm(this.axes.x) : 0.5;
    const ny = this._joyNorm ? this._joyNorm(this.axes.y) : 0.5;
    const px = 10 + nx * (w - 20);
    const py = h - 10 - ny * (h - 20);
    this.trail.push([px, py]);
    if (this.trail.length > 40) this.trail.shift();
    g.strokeStyle = c.move;
    for (let i = 1; i < this.trail.length; i++) {
      g.globalAlpha = (i / this.trail.length) * 0.5;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(...this.trail[i - 1]); g.lineTo(...this.trail[i]); g.stroke();
    }
    g.globalAlpha = 1;
    g.strokeStyle = c.rule; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.moveTo(0, py); g.lineTo(w, py); g.stroke();
    g.setLineDash([]);
    g.fillStyle = c.move;
    g.beginPath(); g.arc(px, py, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = c.surface;
    g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = c.ink3; g.font = '11px Archivo, sans-serif';
    const dx = def(this.axes.x); const dy = def(this.axes.y);
    const fx = `X ${dx.label}: ${dx.format ? dx.format(p[this.axes.x]) : p[this.axes.x]}`;
    const fy = `Y ${dy.label}: ${dy.format ? dy.format(p[this.axes.y]) : p[this.axes.y]}`;
    g.fillText(fx, w - 10 - g.measureText(fx).width, h - 8);
    g.fillText(fy, w - 10 - g.measureText(fy).width, 26);
  }
}

customElements.define('aks-lab', AksLab);
customElements.define('aks-panel', AksPanel);
