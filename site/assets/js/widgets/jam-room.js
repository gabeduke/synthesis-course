// <jam-room>: the Jam page. Pick a key and a mode, press Play, and the page
// makes a drone that follows a slow chord progression in that key. A plugged
// in (or Bluetooth) instrument can play a part over it from a pattern the
// page sends a bar at a time, and the guitar neck shows where the notes are.
//
// One clock drives everything: a lookahead scheduler on the AudioContext's
// time. Each sixteenth note it schedules the drone's chord changes, the kit,
// the instrument's notes (as timestamped MIDI, so they land in time) and,
// if asked, MIDI clock for gear that can follow it.

import { audio, resume } from '../audio/core.js';
import { el, makeControl } from '../ui/controls.js';
import { fm1 } from '../hw/fm1.js';
import { aks } from '../hw/aks.js';
import { device, onDeviceChange } from '../ui/device.js';
import { VASynth } from '../audio/va-synth.js';
import { DroneEngine, Kit, TEXTURES, TEXTURE_IDS, VOICINGS, VOICING_IDS } from '../audio/drone.js';
import * as T from '../audio/theory.js';

const STORE = 'jam.settings';
const DEFAULTS = {
  key: 9, mode: 'dorian', prog: 'vamp', barsPer: 2, bpm: 84, seventh: false,
  drone: true, texture: 'warm', voicing: 'fifth', level: 60, brightness: 40, movement: 50, color: 40, space: 55,
  groove: 'off', kitLevel: 45,
  target: 'main', pattern: 'hold', octave: 0, clock: false, preview: false,
};

// The sounds the page's synth uses for a part, and the ones "Send a matching
// sound" sets on the instrument: lesson 10's drone for Hold, its pluck for
// the rest.
const PATCHES = {
  hold: { waveform: 'tri', super: 60, detune: 30, drift: 45, noise: 12, filterType: 'lp12', cutoff: 1400, resonance: 38, lfoWave: 'sine', lfoSpeed: 12, lfoToCutoff: 30, attack: 80, decay: 60, sustain: 100, release: 100, fx: { chorus: { on: true, rate: 15, depth: 60, mix: 50 }, delay: { on: true, rate: 15, feedback: 55, mix: 30 }, reverb: { on: true, type: 'hall', decay: 85, mix: 55 } } },
  pluck: { waveform: 'saw', sub: 20, filterType: 'lp24', cutoff: 550, resonance: 28, filterEnv: 75, filterDecay: 24, attack: 0, decay: 35, sustain: 0, release: 30, fx: { delay: { on: true, rate: 45, feedback: 35, mix: 30 }, reverb: { on: true, type: 'room', decay: 35, mix: 20 } } },
};
const patchFor = (pattern) => (pattern === 'hold' ? PATCHES.hold : PATCHES.pluck);

const LOOKAHEAD = 0.15; // seconds scheduled ahead
const TICK_MS = 25;

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (_) { return { ...DEFAULTS }; }
}

class JamRoom extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.s = load();
    if (!T.MODES[this.s.mode]) this.s.mode = DEFAULTS.mode;
    this.running = false;
    this.queue = []; // what the screen should show, and when
    this.build();
    this.recompute();
    this.paintAll();
    fm1.addEventListener('change', () => this.paintLink());
    aks.addEventListener('change', () => this.paintLink());
    fm1.addEventListener('noteon', (e) => this.onInstrumentNote(e.detail.note));
    onDeviceChange(() => { this.paintTargets(); this.paintLink(); });
    document.addEventListener('visibilitychange', () => this.wake());
    window.addEventListener('pagehide', () => this.stop());
  }

  save() {
    try { localStorage.setItem(STORE, JSON.stringify(this.s)); } catch (_) { /* storage blocked */ }
  }

  // ---------- Harmony ----------
  recompute() {
    const { key, mode, prog, seventh } = this.s;
    this.chords = T.progression(key, mode, prog, { seventh });
    this.scale = T.scale(key, mode);
    this.colorPc = T.colorNote(key, mode);
    if (this.shown === undefined || this.shown >= this.chords.length) this.shown = 0;
  }

  // A setting that changes what's played: the progression starts again from
  // its first chord at the next bar line.
  restart() {
    this.recompute();
    this.dirty = true;
    if (!this.running) { this.shown = 0; this.drone?.setHarmony(this.harmony(0), true); }
    this.paintChord();
    this.paintStrip();
    this.paintNeck();
    this.save();
  }

  harmony(i) {
    return { key: this.s.key, mode: this.s.mode, chord: this.chords[i], color: this.colorPc };
  }

  // ---------- Transport ----------
  async start() {
    const ctx = await resume();
    const { master } = audio();
    if (!this.drone) {
      this.drone = new DroneEngine();
      this.kit = new Kit(this.drone.send);
    }
    this.drone.set(this.droneSettings());
    this.kit.setLevel(this.s.kitLevel);
    this.ensurePreview(master);
    this.recompute();
    this.drone.setHarmony(this.harmony(0), true);
    if (this.s.drone) this.drone.start();
    this.running = true;
    this.step = 0;
    this.origin = 0;
    this.dirty = false;
    this.nextTime = ctx.currentTime + 0.12;
    this.queue = [];
    if (this.s.clock) this.link().sendRaw?.([0xfa], this.midiAt(this.nextTime));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
    this.wake();
    this.paintPlay();
    const draw = () => {
      if (!this.running) return;
      this.drawFrame();
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.timer);
    this.drone?.stop();
    if (this.s.clock) this.link().sendRaw?.([0xfc]);
    fm1.releaseAll();
    aks.releaseAll();
    this.preview?.allOff();
    this.queue = [];
    this.wake();
    this.paintPlay();
    for (const d of this.beatDots) d.removeAttribute('data-on');
  }

  stepDur() { return 60 / this.s.bpm / 4; }

  // The performance.now() time at which a sound scheduled for AudioContext
  // time t is actually heard, so MIDI and the page's audio line up.
  midiAt(t) {
    const { ctx } = audio();
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) return ts.performanceTime + (t - ts.contextTime) * 1000;
    return performance.now() + (t - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
  }

  link() { return this.s.target === 'aks' ? aks : fm1; }
  linkReady() { return this.s.target === 'aks' ? aks.connected : fm1.canSend; }

  tick() {
    const { ctx } = audio();
    const until = ctx.currentTime + LOOKAHEAD;
    // Asleep in the background, the timer can fall behind; skip ahead rather
    // than firing a burst of late notes.
    if (this.nextTime < ctx.currentTime - 0.25) {
      const behind = Math.ceil((ctx.currentTime - this.nextTime) / this.stepDur());
      this.step += behind;
      this.nextTime += behind * this.stepDur();
    }
    while (this.nextTime < until) {
      this.scheduleStep(this.step, this.nextTime);
      this.nextTime += this.stepDur();
      this.step++;
    }
    if (this.s.drone) this.drone.tick(until);
  }

  scheduleStep(step, t) {
    const sub = step % T.STEPS_PER_BAR;
    const dur = this.stepDur();
    if (sub === 0 && this.dirty) {
      // A new key, mode or pattern: start the progression over from here.
      this.dirty = false;
      this.origin = Math.floor(step / T.STEPS_PER_BAR);
      fm1.releaseAll();
      aks.releaseAll();
      this.preview?.allOff();
    }
    const bar = Math.floor(step / T.STEPS_PER_BAR) - this.origin;
    const per = this.s.barsPer;
    const idx = Math.floor(bar / per) % this.chords.length;
    const inChord = bar % per;
    const chord = this.chords[idx];

    if (sub === 0) {
      if (inChord === 0) this.drone.setHarmony(this.harmony(idx), false, t);
      const events = T.patternBar(this.s.pattern, {
        chord, key: this.s.key, mode: this.s.mode, octave: this.s.octave,
        bar: inChord, bars: per, seed: 1 + Math.floor(bar / (per * this.chords.length)) % 3,
        voicing: this.s.voicing === 'chord' ? 'chord' : 'fifth',
      });
      const link = this.link();
      const send = this.linkReady();
      const hear = this.s.preview || !send;
      for (const e of events) {
        const on = t + e.step * dur;
        const off = on + e.len * dur;
        if (send) {
          link.noteOn(e.note, e.vel, this.midiAt(on));
          link.noteOff(e.note, this.midiAt(off));
        }
        if (hear && this.preview) {
          this.preview.noteOn(e.note, e.vel, on);
          this.preview.noteOff(e.note, off);
        }
      }
      this.queue.push({ t, chord: idx, bar });
    }
    for (const h of T.grooveBar(this.s.groove)) if (h.step === sub) this.kit.hit(h.drum, t, h.vel);
    if (this.s.clock && this.linkReady()) {
      // 24 clocks to a quarter note: six to each sixteenth.
      for (let k = 0; k < 6; k++) this.link().sendRaw([0xf8], this.midiAt(t + (k * dur) / 6));
    }
    if (sub % 4 === 0) this.queue.push({ t, beat: sub / 4 });
  }

  // The part also plays on the page when no instrument is connected (or
  // when asked to), with a sound to suit the pattern.
  ensurePreview(master = audio().master) {
    const want = this.s.pattern === 'hold' ? 'hold' : 'pluck';
    if (this.preview && this.previewKind === want) return;
    this.preview?.dispose();
    this.preview = new VASynth({ ...patchFor(this.s.pattern), level: 62 });
    this.preview.output.connect(master);
    this.previewKind = want;
  }

  droneSettings() {
    const { texture, voicing, level, brightness, movement, color, space } = this.s;
    return { texture, voicing, level, brightness, movement, color, space };
  }

  // Keep the phone's screen on while the jam is running: nothing on the page
  // is touched while both hands are on a guitar.
  async wake() {
    if (!('wakeLock' in navigator)) return;
    if (this.running && document.visibilityState === 'visible' && !this.lock) {
      try {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => { this.lock = null; });
      } catch (_) { this.lock = null; }
    } else if (!this.running && this.lock) {
      this.lock.release().catch(() => {});
      this.lock = null;
    }
  }

  // The screen follows the music, not the scheduler, which runs ahead.
  drawFrame() {
    const { ctx } = audio();
    const now = ctx.currentTime - (ctx.outputLatency || 0);
    while (this.queue.length && this.queue[0].t <= now) {
      const q = this.queue.shift();
      if (q.chord !== undefined && q.chord !== this.shown) {
        this.shown = q.chord;
        this.paintChord();
        this.paintStrip();
        this.paintNeck();
      }
      if (q.beat !== undefined) this.beatDots.forEach((d, i) => d.toggleAttribute('data-on', i === q.beat));
    }
  }

  onInstrumentNote(note) {
    if (!this.listening) return;
    this.listening = false;
    this.s.key = T.pc(note);
    this.paintKeys();
    this.listenBtn.setAttribute('aria-pressed', 'false');
    this.listenBtn.textContent = 'Set key from instrument';
    this.restart();
  }

  // ---------- Building the page ----------
  build() {
    // Now playing.
    this.chordName = el('strong', { class: 'jam-chord-name' });
    this.numeral = el('span', { class: 'jam-numeral' });
    this.keyLine = el('p', { class: 'jam-keyline' });
    this.beatDots = [0, 1, 2, 3].map(() => el('i'));
    this.strip = el('ol', { class: 'jam-strip', 'aria-label': 'The progression' });
    this.playBtn = el('button', { type: 'button', class: 'btn primary jam-play', 'aria-pressed': 'false' });
    this.playBtn.addEventListener('click', () => (this.running ? this.stop() : this.start()));
    this.bpmOut = el('output', { class: 'jam-bpm' });
    const bump = (d) => () => { this.setBpm(this.s.bpm + d); };
    const minus = el('button', { type: 'button', class: 'btn', 'aria-label': 'Slower', text: '−' });
    const plus = el('button', { type: 'button', class: 'btn', 'aria-label': 'Faster', text: '+' });
    minus.addEventListener('click', bump(-2));
    plus.addEventListener('click', bump(2));
    const tap = el('button', { type: 'button', class: 'btn', text: 'Tap' });
    tap.addEventListener('click', () => this.tap());

    const now = el('section', { class: 'instrument jam-now', 'aria-label': 'Now playing' }, [
      el('div', { class: 'jam-hero' }, [
        el('div', { class: 'jam-chord', 'aria-live': 'polite' }, [this.numeral, this.chordName]),
        this.keyLine,
        el('div', { class: 'jam-beats', 'aria-hidden': 'true' }, this.beatDots),
      ]),
      this.strip,
      el('div', { class: 'instrument-foot jam-transport' }, [
        this.playBtn,
        el('div', { class: 'jam-tempo' }, [minus, this.bpmOut, plus, tap]),
      ]),
    ]);

    // Key and mode.
    this.keyBtns = T.KEY_NAMES.map((name, i) => {
      const b = el('button', { type: 'button', text: name });
      b.addEventListener('click', () => { this.s.key = i; this.paintKeys(); this.restart(); });
      return b;
    });
    this.listenBtn = el('button', { type: 'button', class: 'btn hw', 'aria-pressed': 'false', text: 'Set key from instrument' });
    this.listenBtn.addEventListener('click', () => {
      this.listening = !this.listening;
      this.listenBtn.setAttribute('aria-pressed', String(this.listening));
      this.listenBtn.textContent = this.listening ? 'Play a note on it…' : 'Set key from instrument';
    });
    this.modeFeel = el('p', { class: 'jam-hint' });
    this.modeCtl = this.choice('mode', 'Mode', T.MODE_IDS, T.MODE_IDS.map((m) => T.MODES[m].name), () => this.restart());
    this.progCtl = this.choice('prog', 'Chords', T.PROGRESSION_IDS, T.PROGRESSION_IDS.map((p) => T.PROGRESSIONS[p].name), () => this.restart());
    this.barsCtl = this.choice('barsPer', 'Bars per chord', [1, 2, 4, 8], ['1', '2', '4', '8'], () => this.restart());
    this.seventhCtl = this.toggle('seventh', 'Sevenths', () => this.restart());

    const keySec = this.panel('Key and mode', 'Where the drone sits and which notes sound right over it.', [
      el('div', { class: 'ctl jam-wide' }, [
        el('div', { class: 'ctl-top' }, [el('span', { class: 'ctl-name', text: 'Key' })]),
        el('div', { class: 'seg jam-keys', role: 'group', 'aria-label': 'Key' }, this.keyBtns),
      ]),
      el('div', { class: 'jam-wide' }, [this.modeCtl, this.modeFeel]),
      this.progCtl, this.barsCtl, this.seventhCtl,
    ], [this.listenBtn]);

    // The drone.
    this.textureFeel = el('p', { class: 'jam-hint' });
    const droneSec = this.panel('Drone', 'Made on this page from the key and the chord. Use the phone speaker, headphones, or the instrument’s own output.', [
      this.toggle('drone', 'Drone on', (on) => { if (!this.running) return; on ? this.drone.start() : this.drone.stop(); }),
      el('div', { class: 'jam-wide' }, [
        this.choice('texture', 'Texture', TEXTURE_IDS, TEXTURE_IDS.map((t) => TEXTURES[t].name), () => { this.applyDrone(); this.paintFeel(); }),
        this.textureFeel,
      ]),
      this.choice('voicing', 'Voicing', VOICING_IDS, VOICING_IDS.map((v) => VOICINGS[v].name), () => { this.applyDrone(); this.restart(); }),
      this.slider('level', 'Level', 'sound'),
      this.slider('brightness', 'Brightness', 'sound'),
      this.slider('movement', 'Movement', 'move'),
      this.slider('color', 'Color notes', 'move', (v) => (v < 1 ? 'none' : String(Math.round(v)))),
      this.slider('space', 'Space', 'space'),
    ]);

    // The kit.
    const kitSec = this.panel('Pulse', 'A quiet kit to keep time, if the drone alone is too free.', [
      this.choice('groove', 'Groove', T.GROOVE_IDS, T.GROOVE_IDS.map((g) => T.GROOVES[g].name), () => this.save()),
      this.slider('kitLevel', 'Kit level', 'time', undefined, (v) => this.kit?.setLevel(v)),
    ]);

    // The instrument.
    this.targetCtl = el('div', { class: 'ctl jam-wide', 'data-kind': 'hw' });
    this.linkLine = el('p', { class: 'jam-link' });
    this.usbBtn = el('button', { type: 'button', class: 'btn hw' });
    this.usbBtn.addEventListener('click', () => this.connectUsb());
    this.bleBtn = el('button', { type: 'button', class: 'btn hw', text: 'Connect over Bluetooth' });
    this.bleBtn.addEventListener('click', () => this.connectBle());
    this.patchBtn = el('button', { type: 'button', class: 'btn', text: 'Send a matching sound' });
    this.patchBtn.addEventListener('click', () => this.sendPatch());
    this.patternFeel = el('p', { class: 'jam-hint' });
    this.linkNote = el('p', { class: 'jam-hint jam-wide' });
    const instSec = this.panel('Your instrument', 'Plug the FM-1, SMK-37 or AKS Mini into the phone (or pair it over Bluetooth) and it plays a part, one bar at a time.', [
      this.targetCtl,
      el('div', { class: 'jam-wide' }, [this.linkLine]),
      el('div', { class: 'jam-wide' }, [
        this.choice('pattern', 'Part', T.PATTERN_IDS, T.PATTERN_IDS.map((p) => T.PATTERNS[p].name), () => { this.paintFeel(); this.ensurePreview(); this.restart(); }),
        this.patternFeel,
      ]),
      this.choice('octave', 'Octave', [-2, -1, 0, 1], ['−2', '−1', '0', '+1'], () => this.restart()),
      this.toggle('clock', 'Send MIDI clock', (on) => { if (this.running) this.link().sendRaw?.([on ? 0xfa : 0xfc]); }),
      this.toggle('preview', 'Also play the part here', () => { this.save(); }),
      this.linkNote,
    ], [this.usbBtn, this.bleBtn, this.patchBtn]);

    // The neck.
    this.neck = el('div', { class: 'jam-neck' });
    this.scaleLine = el('p', { class: 'jam-scale' });
    const neckSec = el('section', { class: 'instrument jam-neck-panel', 'aria-label': 'Notes on the guitar neck' }, [
      el('div', { class: 'instrument-head' }, [el('h3', { text: 'On the neck' }), el('p', { text: 'Standard tuning, frets 0 to 12. Filled: the chord playing now. Ringed: the key’s root. Hollow: the rest of the scale.' })]),
      this.scaleLine,
      this.neck,
    ]);

    const side = el('div', { class: 'jam-side' }, [now, neckSec]);
    const controls = el('div', { class: 'jam-controls' }, [keySec, instSec, droneSec, kitSec]);
    this.append(el('div', { class: 'jam-grid' }, [side, controls]));
    this.paintTargets();
  }

  panel(title, intro, kids, foot) {
    const box = el('section', { class: 'instrument jam-panel', 'aria-label': title }, [
      el('div', { class: 'instrument-head' }, [el('h3', { text: title }), el('p', { text: intro })]),
      el('div', { class: 'controls' }, kids),
    ]);
    if (foot) box.append(el('div', { class: 'instrument-foot' }, foot));
    return box;
  }

  choice(key, label, options, names, after) {
    const c = makeControl(`jam.${key}`, this.s[key], (_, v) => { this.s[key] = v; this.save(); after?.(v); }, {
      def: { label, type: 'choice', options, names, kind: key === 'pattern' || key === 'octave' ? 'hw' : 'sound' },
    });
    (this._ctls ||= {})[key] = c;
    return c;
  }

  toggle(key, label, after) {
    const c = makeControl(`jam.${key}`, this.s[key], (_, v) => { this.s[key] = v; this.save(); after?.(v); }, { def: { label, type: 'bool' } });
    (this._ctls ||= {})[key] = c;
    return c;
  }

  slider(key, label, kind, format = (v) => String(Math.round(v)), after) {
    const c = makeControl(`jam.${key}`, this.s[key], (_, v) => {
      this.s[key] = v;
      this.save();
      if (after) after(v); else this.applyDrone();
    }, { def: { label, min: 0, max: 100, step: 1, kind, format } });
    (this._ctls ||= {})[key] = c;
    return c;
  }

  applyDrone() { this.drone?.set(this.droneSettings()); this.save(); }

  setBpm(v) {
    this.s.bpm = Math.round(Math.min(180, Math.max(40, v)));
    this.bpmOut.textContent = `${this.s.bpm} BPM`;
    this.save();
  }

  tap() {
    const now = performance.now();
    this.taps = (this.taps || []).filter((x) => now - x < 2500);
    this.taps.push(now);
    if (this.taps.length >= 3) {
      const gaps = this.taps.slice(1).map((x, i) => x - this.taps[i]);
      this.setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
    }
  }

  async connectUsb() {
    try {
      if (this.s.target === 'aks') await aks.connect();
      else await fm1.connectMidi();
    } catch (e) {
      this.say(e?.message || 'The browser refused MIDI access.');
    }
    this.paintLink();
  }

  async connectBle() {
    try {
      if (fm1.bleActive) await fm1.disconnectBluetooth();
      else if (fm1.ble?.device && fm1.ble.state !== 'connected') await fm1.resumeBluetooth();
      else await fm1.connectBluetooth();
    } catch (e) {
      if (e?.name !== 'NotFoundError') this.say(`Bluetooth: ${e?.message || 'couldn’t connect.'}`);
    }
    this.paintLink();
  }

  sendPatch() {
    if (this.s.target === 'aks' || !fm1.canSend) return;
    const n = fm1.sendPatch(patchFor(this.s.pattern));
    this.say(`Sent ${n} settings to the ${device().label}’s current preset. It isn’t saved there until you press ${device().controls?.SAVE || 'SAVE'}.`);
  }

  // A message under the instrument's controls that stays until the next one.
  say(msg) {
    delete this.linkNote.dataset.auto;
    this.linkNote.textContent = msg;
  }

  // ---------- Painting ----------
  paintAll() {
    this.setBpm(this.s.bpm);
    this.paintKeys();
    this.paintPlay();
    this.paintChord();
    this.paintStrip();
    this.paintFeel();
    this.paintNeck();
    this.paintLink();
  }

  paintPlay() {
    this.playBtn.setAttribute('aria-pressed', String(this.running));
    this.playBtn.textContent = this.running ? 'Stop' : 'Play';
  }

  paintKeys() {
    this.keyBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === this.s.key)));
  }

  paintChord() {
    const c = this.chords[this.shown] || this.chords[0];
    const next = this.chords.length > 1 ? this.chords[(this.shown + 1) % this.chords.length] : null;
    this.chordName.textContent = c.name;
    this.numeral.textContent = c.numeral;
    this.keyLine.textContent = `${T.keyLabel(this.s.key, this.s.mode)}${next ? ` · next ${next.name}` : ''}`;
  }

  paintStrip() {
    this.strip.replaceChildren(...this.chords.map((c, i) => {
      const li = el('li', {}, [el('strong', { text: c.name }), el('span', { text: c.numeral })]);
      if (i === this.shown) li.setAttribute('aria-current', 'true');
      return li;
    }));
  }

  paintFeel() {
    this.modeFeel.textContent = T.MODES[this.s.mode].feel;
    this.textureFeel.textContent = TEXTURES[this.s.texture].blurb;
    this.patternFeel.textContent = T.PATTERNS[this.s.pattern].blurb;
  }

  paintTargets() {
    const main = device().label;
    const c = makeControl('jam.target', this.s.target, (_, v) => {
      this.s.target = v;
      this.save();
      fm1.releaseAll();
      aks.releaseAll();
      this.paintLink();
      this.restart();
    }, { def: { label: 'Send the part to', type: 'choice', options: ['main', 'aks'], names: [main, 'AKS Mini'], kind: 'hw' } });
    this.targetCtl.replaceChildren(...c.childNodes);
  }

  paintLink() {
    const aksT = this.s.target === 'aks';
    const name = aksT ? 'AKS Mini' : device().label;
    let line;
    if (aksT) {
      line = aks.connected ? `${name}: connected (${aks.output.name}, channel ${aks.channel}).` : `${name}: not connected. The part plays on this page instead.`;
    } else if (fm1.bleActive) {
      line = `${name}: connected over Bluetooth (${fm1.ble.name}).`;
    } else if (fm1.output) {
      line = `${name}: connected over USB (${fm1.output.name}).`;
    } else {
      line = `${name}: not connected. The part plays on this page instead.`;
    }
    this.linkLine.textContent = line;
    this.linkLine.toggleAttribute('data-on', this.linkReady());
    const midi = fm1.supported.midi;
    this.usbBtn.hidden = !midi || (aksT ? aks.connected : !!fm1.output);
    this.usbBtn.textContent = fm1.access ? `Find the ${name}` : 'Connect USB MIDI';
    this.bleBtn.hidden = aksT || !fm1.supported.bluetooth;
    this.bleBtn.textContent = fm1.bleActive ? 'Disconnect Bluetooth' : fm1.ble?.device ? 'Reconnect Bluetooth' : 'Connect over Bluetooth';
    this.patchBtn.hidden = aksT;
    this.patchBtn.disabled = !fm1.canSend;
    if (!midi && !fm1.supported.bluetooth) {
      this.linkNote.textContent = 'This browser can’t talk to instruments. Chrome on Android (or Chrome or Edge on a computer) can, over USB or Bluetooth.';
    } else if (!this.linkNote.textContent || this.linkNote.dataset.auto) {
      this.linkNote.dataset.auto = '1';
      this.linkNote.textContent = aksT
        ? 'The AKS Mini plays over USB only. The page never changes its sound; set it by hand.'
        : 'Bluetooth needs the instrument in BT Device mode, and a tap here each time the page opens. Over USB, a phone needs a USB-C cable or an OTG adapter.';
    }
  }

  // A vertical neck, low E on the left, like a chord chart.
  paintNeck() {
    const chord = this.chords[this.shown] || this.chords[0];
    const { key, mode } = this.s;
    const names = this.scale.map((p) => T.spell(p, key, mode));
    this.scaleLine.replaceChildren(
      el('span', { text: `${T.keyLabel(key, mode)}: ` }),
      ...this.scale.map((p, i) => {
        const b = el('b', { text: names[i] });
        if (chord.pcs.includes(p)) b.dataset.chord = '';
        if (p === this.colorPc) b.dataset.color = '';
        return b;
      }),
    );
    const FRETS = 12; const sx = 46; const x0 = 52; const row = 38; const nut = 40;
    const W = x0 + sx * 5 + 30; const H = nut + row * FRETS + 12;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${chord.name} and the ${T.keyLabel(key, mode)} scale on a guitar neck`);
    const add = (tag, attrs, text) => {
      const n = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text !== undefined) n.textContent = text;
      svg.append(n);
      return n;
    };
    const xs = (s) => x0 + s * sx;
    // Inlays, frets, the nut, strings.
    for (const f of [3, 5, 7, 9]) add('circle', { class: 'inlay', cx: xs(2.5), cy: nut + row * (f - 0.5), r: 5 });
    add('circle', { class: 'inlay', cx: xs(1.5), cy: nut + row * 11.5, r: 5 });
    add('circle', { class: 'inlay', cx: xs(3.5), cy: nut + row * 11.5, r: 5 });
    for (let f = 0; f <= FRETS; f++) {
      add('line', { class: f === 0 ? 'nut' : 'fret', x1: xs(0), x2: xs(5), y1: nut + row * f, y2: nut + row * f });
      if (f > 0 && [1, 3, 5, 7, 9, 12].includes(f)) add('text', { class: 'fretno', x: 16, y: nut + row * (f - 0.5) + 4 }, String(f));
    }
    for (let s = 0; s < 6; s++) add('line', { class: 'string', x1: xs(s), x2: xs(s), y1: nut, y2: nut + row * FRETS, 'stroke-width': 2.2 - s * 0.3 });
    for (let s = 0; s < 6; s++) {
      for (let f = 0; f <= FRETS; f++) {
        const p = T.pc(T.GUITAR_TUNING[s] + f);
        if (!this.scale.includes(p)) continue;
        const y = f === 0 ? nut / 2 : nut + row * (f - 0.5);
        const inChord = chord.pcs.includes(p);
        const cls = ['dot', inChord ? 'chord' : 'scale', p === chord.root ? 'chordroot' : '', p === key ? 'key' : ''].filter(Boolean).join(' ');
        add('circle', { class: cls, cx: xs(s), cy: y, r: inChord ? 14 : 11 });
        add('text', { class: `dotname${inChord ? ' on' : ''}`, x: xs(s), y: y + 4 }, T.spell(p, key, mode));
      }
    }
    this.neck.replaceChildren(svg);
  }
}

customElements.define('jam-room', JamRoom);
