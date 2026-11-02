// <jam-room>: the Jam page. Pick a key and a mode, press Play, and the page
// makes a drone that follows a slow chord progression in that key. A plugged
// in (or Bluetooth) instrument can play a part over it from a pattern the
// page sends a bar at a time, and the guitar neck shows where the notes are.
//
// One clock drives everything: a lookahead scheduler on the AudioContext's
// time. Each sixteenth note it schedules the drone's chord changes, the kit,
// the instrument's notes (as timestamped MIDI, so they land in time) and,
// if asked, MIDI clock for gear that can follow it. The modulators (audio/
// modulation.js) run on the same clock: each tick they move the instrument's
// parameters over MIDI CC and the page's own synth, and the drawing (ui/
// mod-draw.js, and the glow on the neck) reads the same shapes at the same time.

import { audio, resume, setLatencyHint } from '../audio/core.js';
import { el, makeControl } from '../ui/controls.js';
import { fm1, ccValue } from '../hw/fm1.js';
import { explainConnect } from '../hw/midi-check.js';
import { aks } from '../hw/aks.js';
import { device, onDeviceChange, ctl as ctlName } from '../ui/device.js';
import { VASynth, DEFAULT_VA } from '../audio/va-synth.js';
import * as MOD from '../audio/modulation.js';
import { onFrame, fit } from '../ui/draw.js';
import { drawModulator } from '../ui/mod-draw.js';
import { formatValue } from '../ui/params.js';
import { DroneEngine, Kit, TEXTURES, TEXTURE_IDS, VOICINGS, VOICING_IDS } from '../audio/drone.js';
import * as T from '../audio/theory.js';

const STORE = 'jam.settings';
const DEFAULTS = {
  key: 9, mode: 'dorian', prog: 'vamp', barsPer: 2, bpm: 84, seventh: false,
  drone: true, texture: 'warm', voicing: 'fifth', level: 60, brightness: 40, movement: 50, color: 40, space: 55,
  groove: 'off', kitLevel: 45,
  target: 'main', pattern: 'pulse', octave: 0, clock: false, phone: false,
  modSel: 0, // `mods` (see MOD.defaultMods) is filled in on load, from Movement if need be
};

// The sounds the page's synth uses for a part, and the ones "Send a matching
// sound" sets on the instrument: lesson 10's drone for Hold, its pluck for
// the rest.
const PATCHES = {
  hold: { waveform: 'tri', super: 60, detune: 30, drift: 45, noise: 12, filterType: 'lp12', cutoff: 1400, resonance: 38, lfoWave: 'sine', lfoSpeed: 12, lfoToCutoff: 30, attack: 80, decay: 60, sustain: 100, release: 100, fx: { chorus: { on: true, rate: 15, depth: 60, mix: 50 }, delay: { on: true, rate: 15, feedback: 55, mix: 30 }, reverb: { on: true, type: 'hall', decay: 85, mix: 55 } } },
  pluck: { waveform: 'saw', sub: 20, filterType: 'lp24', cutoff: 550, resonance: 28, filterEnv: 75, filterDecay: 24, attack: 0, decay: 35, sustain: 0, release: 30, fx: { delay: { on: true, rate: 45, feedback: 35, mix: 30 }, reverb: { on: true, type: 'room', decay: 35, mix: 20 } } },
};
// One-tap sounds for the instrument, over lesson 10's drone pad: only what
// differs is listed. Each sets the whole Instrument sound panel and sends it.
const SOUND_PRESETS = {
  Pad: {},
  Swell: { waveform: 'saw', attack: 95, cutoff: 900, resonance: 30, super: 70, detune: 40, fx: { reverb: { mix: 65 }, delay: { mix: 25 } } },
  Glass: { waveform: 'sine', attack: 40, cutoff: 3500, resonance: 20, super: 30, detune: 20, fx: { reverb: { mix: 70 }, delay: { mix: 35 } } },
  Organ: { waveform: 'square', attack: 5, release: 20, cutoff: 2200, resonance: 10, super: 0, detune: 0, drift: 10, fx: { reverb: { mix: 25 }, delay: { on: false } } },
  Dark: { waveform: 'saw', attack: 70, cutoff: 500, resonance: 15, super: 50, fx: { reverb: { mix: 60 }, delay: { mix: 20 } } },
  Pluck: PATCHES.pluck,
};
const patchFor = (pattern) => (pattern === 'hold' ? PATCHES.hold : PATCHES.pluck);

// The instrument's sound, from the page: the settings that matter most for
// playing along, in groups. Each sends Baud Girl's CC for it as it moves (to
// the FM-1 or SMK-37's current preset), and also shapes the page's synth.
const SOUND = [
  ['Envelope', ['attack', 'decay', 'sustain', 'release']],
  ['Tone', ['waveform', 'cutoff', 'resonance']],
  ['Width', ['super', 'detune', 'drift']],
  ['Space', ['fx.reverb.on', 'fx.reverb.mix', 'fx.delay.on', 'fx.delay.mix']],
];
const SOUND_KEYS = SOUND.flatMap(([, keys]) => keys);
const getPath = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);

// The panel's values from a patch (missing ones from the synth's defaults).
function soundFrom(patch) {
  const out = {};
  for (const k of SOUND_KEYS) out[k] = getPath(patch, k) ?? getPath(DEFAULT_VA, k);
  return out;
}
// The other way: flat panel values to a patch, with effects nested.
function toPatch(sound) {
  const out = {};
  for (const [k, v] of Object.entries(sound)) {
    if (!k.startsWith('fx.')) { out[k] = v; continue; }
    const [, fx, field] = k.split('.');
    ((out.fx ||= {})[fx] ||= {})[field] = v;
  }
  return out;
}
function mergePatch(base, over) {
  const fx = { ...(base.fx || {}) };
  for (const [k, v] of Object.entries(over.fx || {})) fx[k] = { ...(fx[k] || {}), ...v };
  return { ...base, ...over, fx };
}

const LOOKAHEAD = 0.15; // seconds scheduled ahead
const TICK_MS = 25;

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch (_) { return { ...DEFAULTS }; }
}

class JamRoom extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    setLatencyHint('playback');
    this.s = load();
    if (!T.MODES[this.s.mode]) this.s.mode = DEFAULTS.mode;
    this.s.sound = { ...soundFrom(PATCHES.hold), ...(this.s.sound || {}) };
    // Older settings called "also play on this phone" `preview`.
    if (this.s.preview !== undefined) { this.s.phone = !!this.s.preview; delete this.s.preview; }
    this.running = false;
    this.queue = []; // what the screen should show, and when
    this.pending = []; // note-offs not yet sent
    this.book = new Map(); // note -> how many voices hold it on the instrument
    this.idrone = { on: false, held: new Set(), nextBloom: Infinity };
    this.s.mods = MOD.cleanMods(this.s.mods, this.s.movement);
    this.s.modSel = Math.min(MOD.SLOTS - 1, Math.max(0, +this.s.modSel || 0));
    // The modulators' state on the clock: when they started, what has gone to
    // the instrument (target -> last CC value and when), what the page's synth has.
    this.mod = { t0: 0, at: 0, sent: new Map(), heard: new Set(), frame: null };
    this.phoneDrone = false;
    this.build();
    this.recompute();
    this.paintAll();
    fm1.addEventListener('change', () => { this.paintLink(); this.paintSource(); });
    aks.addEventListener('change', () => { this.paintLink(); this.paintSource(); });
    fm1.addEventListener('noteon', (e) => this.onInstrumentNote(e.detail.note));
    // Turning a knob on the instrument moves the same slider here.
    fm1.addEventListener('param', (e) => {
      if (!fm1.followHw || this.s.target === 'aks' || !this.soundCtls.has(e.detail.key)) return;
      this.setSound(e.detail.key, e.detail.value, 'hw');
    });
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
    if (!this.running) { this.shown = 0; this.drone?.setHarmony(this.harmony(0), true); this.paintBars(-1, this.s.barsPer); }
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
    if (this.running) this.stop();
    const ctx = await resume();
    const { master } = audio();
    // The phone's own sound (drone, kit, synth) is only built once the phone
    // has to play, so a phone that's just running an instrument does no
    // audio work that could stutter.
    this.recompute();
    this.drone?.setHarmony(this.harmony(0), true);
    if (this.phoneOn()) this.ensurePhone(master);
    this.running = true;
    this.curChord = 0;
    this.phoneDrone = false;
    this.idrone.on = false;
    this.idrone.held = new Set();
    this.step = 0;
    this.origin = 0;
    this.dirty = false;
    this.nextTime = ctx.currentTime + 0.12;
    this.mod.t0 = ctx.currentTime;
    this.mod.at = 0;
    this.mod.sent.clear();
    this.mod.heard.clear();
    this.queue = [];
    this.pending = [];
    this.book.clear();
    if (this.s.clock) this.link().sendRaw?.([0xfa], this.midiAt(this.nextTime));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
    this.wake();
    this.paintPlay();
    this.paintSource();
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
    this.phoneDrone = false;
    this.instrumentDroneOff();
    this.modApply({}, performance.now());
    if (this.s.clock) this.link().sendRaw?.([0xfc]);
    this.silence();
    this.queue = [];
    this.wake();
    this.paintPlay();
    for (const d of this.beatDots) d.removeAttribute('data-on');
    this.paintBars(-1, this.s.barsPer);
    this.paintSource();
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

  // Where the sound comes from. With an instrument connected it plays the
  // drone and the part, and the phone is silent unless "Also play on this
  // phone" is on. With nothing connected, the phone plays it all.
  phoneOn() { return this.s.phone || !this.linkReady(); }

  // ---------- Notes on the instrument ----------
  // The drone and the part share one preset, so the same note can be held
  // by both. Each note is counted: a second voice joins it without striking
  // it again (an off and on at the same moment clicks), and it's only let go
  // when the last voice holding it lets go.
  noteOn(note, vel, at) {
    const n = this.book.get(note) || 0;
    if (n === 0) this.link().noteOn(note, vel, at);
    this.book.set(note, n + 1);
  }

  // Notes for the instrument wait in one list, ons and offs together, and
  // are counted in the order they'll sound as their time comes into the
  // lookahead. (Counted when planned, a bar of repeated notes would look
  // like one long one.)
  queueNote(note, vel, on, off) {
    this.pending.push({ t: on, kind: 1, note, vel }, { t: off, kind: 0, note });
  }

  noteOff(note, at) {
    const n = (this.book.get(note) || 0) - 1;
    if (n > 0) { this.book.set(note, n); return; }
    this.book.delete(note);
    this.link().noteOff(note, at);
  }

  // The phone's drone, kit and synth, built the first time they're needed.
  ensurePhone(master = audio().master) {
    if (!this.drone) {
      this.drone = new DroneEngine();
      this.kit = new Kit(this.drone.send);
      this.drone.setHarmony(this.harmony(this.curChord ?? 0), true);
    }
    this.drone.set(this.droneSettings());
    this.kit.setLevel(this.s.kitLevel);
    this.ensurePreview(master);
  }

  // Start, stop or follow the two drones as the instrument comes and goes.
  syncOutputs(t) {
    const phone = this.s.drone && this.phoneOn();
    if (phone !== this.phoneDrone) {
      this.phoneDrone = phone;
      if (phone) { this.ensurePhone(); this.drone.start(); } else this.drone?.stop();
    }
    const inst = this.s.drone && this.linkReady();
    if (inst && !this.idrone.on) this.instrumentDroneOn(t);
    else if (!inst && this.idrone.on) this.instrumentDroneOff();
  }

  // The drone on the instrument: the chord held (gliding on common notes)
  // and now and then a color note. The modulators move its sound (modulate()).
  instrumentDroneOn(t) {
    const d = this.idrone;
    d.on = true;
    d.held = new Set();
    d.nextBloom = this.s.color > 0 ? t + 3 + Math.random() * 3 : Infinity;
    this.instrumentDroneChord(this.curChord ?? 0, t);
  }

  instrumentDroneChord(idx, t) {
    const d = this.idrone;
    if (!d.on) return;
    const want = new Set(T.droneNotes(this.s.key, this.chords[idx], this.s.voicing, this.s.octave));
    for (const n of d.held) if (!want.has(n)) this.pending.push({ t, kind: 0, note: n });
    for (const n of want) if (!d.held.has(n)) this.pending.push({ t, kind: 1, note: n, vel: 0.62 });
    d.held = want;
  }

  instrumentDroneOff() {
    const d = this.idrone;
    if (!d.on) return;
    d.on = false;
    // Let go of the drone's notes now, and of any it hasn't started yet.
    for (const n of d.held) {
      if (this.book.has(n)) this.noteOff(n);
    }
    const held = d.held;
    this.pending = this.pending.filter((p) => !(held.has(p.note) && p.kind === 1));
    d.held = new Set();
    d.nextBloom = Infinity;
  }

  instrumentDroneTick(until) {
    const d = this.idrone;
    if (!d.on) return;
    // Color notes: a chord tone or the mode's color note, high and soft,
    // held for a few seconds. The preset's envelope decides how it swells.
    while (d.nextBloom < until) {
      const chord = this.chords[this.curChord ?? 0];
      const pool = [...chord.pcs, this.colorPc, this.colorPc];
      const p = pool[Math.floor(Math.random() * pool.length)];
      const base = T.baseNote(this.s.key, this.s.octave) + 12;
      const note = base + T.pc(p - this.s.key) + (Math.random() < 0.3 ? 12 : 0);
      this.queueNote(note, 0.42, d.nextBloom, d.nextBloom + 3 + Math.random() * 4);
      const c = Math.max(1, this.s.color) / 100;
      d.nextBloom += 14 * Math.pow(2.5 / 14, c) * (0.5 + Math.random());
    }
  }

  // ---------- Modulation ----------
  // The resting value of each parameter a modulator can move: the panel's
  // (or, for ones the panel doesn't have, the part's patch).
  modBase() {
    const patch = this.fullPatch();
    return (key) => getPath(patch, key) ?? getPath(DEFAULT_VA, key);
  }

  // Whether the modulators can move the instrument's preset right now: it has
  // to be connected, on Baud Girl's firmware (the CCs mean other things on
  // stock), and not the AKS Mini, whose sound the page never changes.
  modSending() { return this.s.target !== 'aks' && this.linkReady() && fm1.canSetSound; }

  // Where the modulators are on the page's clock (seconds since Play), as
  // heard: the same moment the sound is at, less the output latency.
  modTime() {
    if (!this.running) return 0;
    const { ctx } = audio();
    return ctx.currentTime - (ctx.outputLatency || 0) - this.mod.t0;
  }

  // Once a tick: work out every moved parameter and send it. About 25 times a
  // second at most; the instrument gets a parameter only when its CC value
  // changes (a CC has 128 steps, so a slow move is a staircase of small jumps)
  // and no more than ~12 times a second each.
  modulate() {
    const wall = performance.now();
    if (wall - this.mod.at < 40) return;
    this.mod.at = wall;
    const { ctx } = audio();
    const { values } = MOD.resolve(this.s.mods, this.modBase(), ctx.currentTime - this.mod.t0);
    this.modApply(values, wall);
  }

  // Set the moved parameters on the instrument and the page's synth, and put
  // back (to the panel's value) any that were moved a moment ago but no longer are.
  modApply(values, wall) {
    const m = this.mod;
    const base = this.modBase();
    const send = this.modSending();
    const put = (target, v, soft) => {
      const d = MOD.TARGETS[target];
      if (d.fx) fm1.sendFx(d.fx[0], d.fx[1], v);
      else fm1.sendParam(d.key, v, soft);
    };
    for (const [target, v] of Object.entries(values)) {
      if (!send) break;
      const step = MOD.ccStep(target, v);
      const was = m.sent.get(target);
      if (was && (was.step === step || wall - was.at < 80)) continue;
      put(target, v, true);
      m.sent.set(target, { step, at: wall });
    }
    for (const target of [...m.sent.keys()]) {
      if (send && target in values) continue;
      if (send) put(target, base(MOD.TARGETS[target].key), false);
      m.sent.delete(target);
    }
    // The page's synth and drone, so it moves with nothing connected too.
    const now = {};
    for (const target of Object.keys(values)) now[MOD.TARGETS[target].key] = values[target];
    const back = [...m.heard].filter((k) => !(k in now));
    for (const k of back) now[k] = base(k);
    m.heard = new Set(Object.keys(now).filter((k) => !back.includes(k)));
    if (this.preview && Object.keys(now).length) this.preview.set(toPatch(now));
    if (this.phoneDrone) this.drone.setCutoffMod('cutoff' in values ? Math.log2(values.cutoff / base('cutoff')) : 0);
  }

  // One modulator's setting changed (or its switch was tapped).
  setMod(i, change) {
    this.s.mods[i] = MOD.makeMod({ ...this.s.mods[i], ...change }, i + 1);
    this.save();
    this.paintMods();
  }

  selectMod(i) {
    this.s.modSel = i;
    this.save();
    this.paintMods();
  }

  // The values and time the pictures need, worked out once a frame however
  // many of them draw.
  modFrame(now) {
    const f = this.mod.frame;
    if (f && f.stamp === now) return f;
    const t = this.modTime();
    const base = this.modBase();
    return (this.mod.frame = { stamp: now, t, base, ...MOD.resolve(this.s.mods, base, t) });
  }

  drawMod(i, canvas, now) {
    const { g, w, h } = fit(canvas);
    const m = this.s.mods[i];
    const f = this.modFrame(now);
    const key = MOD.TARGETS[m.target].key;
    const v = f.values[m.target];
    drawModulator(g, w, h, {
      mod: m, t: f.t, base: f.base(key), now: v,
      label: MOD.TARGETS[m.target].label,
      readout: v === undefined ? '' : formatValue(key, v),
      sending: this.running && this.mod.sent.has(m.target),
      selected: i === this.s.modSel,
    });
  }

  // The glow on the neck: each chord note breathes with the modulation, the
  // same shapes and the same clock, a little behind the one before so it
  // ripples across the neck rather than flashing. Only while playing.
  drawNeck(now) {
    const halos = this.halos;
    if (!halos?.length) return;
    const mods = this.s.mods;
    const live = this.running && mods.some((m) => m.on && m.depth > 0);
    if (!live && !this.lit) return;
    this.lit = live;
    const t = this.modTime();
    // The ripple takes half a cycle of the deepest modulator to cross the neck.
    const lead = mods.filter((m) => m.on && m.depth > 0).sort((a, b) => b.depth - a.depth)[0];
    const half = lead ? 0.5 / MOD.rateHz(lead.rate) : 0;
    for (const h of halos) {
      const g = live ? MOD.glow(mods, t, h.pos * half) : 0;
      const o = (g * 0.8).toFixed(2);
      if (h.o !== o) {
        h.o = o;
        h.el.setAttribute('fill-opacity', o);
        h.el.setAttribute('r', (h.r + 2 + g * 8).toFixed(1));
      }
    }
  }

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
    this.syncOutputs(ctx.currentTime + 0.05);
    this.flushOffs(until);
    if (this.phoneDrone) this.drone.tick(until);
    this.instrumentDroneTick(until);
    this.modulate();
  }

  scheduleStep(step, t) {
    const sub = step % T.STEPS_PER_BAR;
    const dur = this.stepDur();
    if (sub === 0 && this.dirty) {
      // A new key, mode or pattern: start the progression over from here.
      this.dirty = false;
      this.origin = Math.floor(step / T.STEPS_PER_BAR);
      this.silence();
      this.idrone.held = new Set();
    }
    const bar = Math.floor(step / T.STEPS_PER_BAR) - this.origin;
    const per = this.s.barsPer;
    const clock = () => {
      // 24 clocks to a quarter note: six to each sixteenth.
      for (let k = 0; k < 6; k++) this.link().sendRaw([0xf8], this.midiAt(t + (k * dur) / 6));
    };
    const idx = Math.floor(bar / per) % this.chords.length;
    const inChord = bar % per;
    const chord = this.chords[idx];

    if (sub === 0) {
      if (inChord === 0) {
        this.curChord = idx;
        this.drone?.setHarmony(this.harmony(idx), false, t);
        this.instrumentDroneChord(idx, t);
      }
      const events = T.patternBar(this.s.pattern, {
        chord, key: this.s.key, mode: this.s.mode, octave: this.s.octave,
        bar: inChord, bars: per, seed: 1 + Math.floor(bar / (per * this.chords.length)) % 3,
        voicing: this.s.voicing === 'chord' ? 'chord' : 'fifth',
      });
      this.playEvents(events, t);
      this.queue.push({ t, chord: idx, bar, inChord, per });
    }
    if (this.phoneOn() && this.kit) for (const h of T.grooveBar(this.s.groove)) if (h.step === sub) this.kit.hit(h.drum, t, h.vel);
    if (this.s.clock && this.linkReady()) clock();
    if (sub % 4 === 0) this.queue.push({ t, beat: sub / 4 });
  }

  // One bar's notes, from time t: to the instrument, and to the page's synth
  // when there's no instrument (or when asked).
  playEvents(events, t) {
    const dur = this.stepDur();
    const send = this.linkReady();
    const hear = this.phoneOn();
    for (const e of events) {
      const on = t + e.step * dur;
      const off = on + e.len * dur;
      // The page's synth takes the whole note now; Stop swaps in a fresh
      // synth, so nothing scheduled on this one can outlive it.
      if (hear && this.preview) {
        this.preview.noteOn(e.note, e.vel, on);
        this.preview.noteOff(e.note, off);
      }
      if (!send) continue;
      // Held here until its time comes into the lookahead, rather than going
      // to the port bars in advance, so Stop always knows what's sounding
      // (a held chord can last 8 bars).
      this.queueNote(e.note, e.vel, on, off);
    }
  }

  // Send the notes due before `until`, in time order, offs before ons at the
  // same moment (so a repeated note is let go and struck again).
  flushOffs(until) {
    const due = this.pending.filter((p) => p.t < until).sort((a, b) => a.t - b.t || a.kind - b.kind);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.t >= until);
    for (const p of due) {
      if (p.kind) this.noteOn(p.note, p.vel, this.midiAt(p.t));
      else this.noteOff(p.note, this.midiAt(p.t));
    }
  }

  // Everything still sounding ends now: the instrument (note by note, then
  // All Notes Off) and the page's synth.
  silence() {
    const link = this.link();
    // Notes not yet sent are simply dropped; those sounding are let go.
    for (const n of this.book.keys()) link.noteOff(n);
    this.pending = [];
    this.book.clear();
    fm1.releaseAll();
    aks.releaseAll();
    if (this.preview) {
      this.preview.dispose();
      this.preview = null;
      if (this.running) this.ensurePreview();
    }
  }

  // The part also plays on the page when no instrument is connected (or
  // when asked to), with a sound to suit the pattern.
  ensurePreview(master = audio().master) {
    const want = this.s.pattern === 'hold' ? 'hold' : 'pluck';
    if (this.preview && this.previewKind === want) return;
    this.preview?.dispose();
    this.preview = new VASynth({ ...this.fullPatch(), level: 62 });
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
      if (q.inChord !== undefined) this.paintBars(q.inChord, q.per);
      if (q.beat !== undefined) this.beatDots.forEach((d, i) => d.toggleAttribute('data-on', i === q.beat));
    }
  }

  // How far through the chord it is: one mark a bar, so a long chord is
  // plainly moving even though it hasn't changed yet.
  paintBars(inChord, per) {
    if (this.barMarks.length !== per) {
      this.barMarks = Array.from({ length: per }, () => el('i'));
      this.barLine.replaceChildren(...this.barMarks);
    }
    this.barLine.hidden = per < 2;
    this.barMarks.forEach((m, i) => m.toggleAttribute('data-on', i <= inChord));
    this.barText.textContent = inChord >= 0 && per > 1 ? `bar ${inChord + 1} of ${per}` : '';
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
    this.barMarks = [];
    this.barLine = el('div', { class: 'jam-bars', 'aria-hidden': 'true' });
    this.barText = el('span', { class: 'jam-bartext' });
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

    this.sourceLine = el('p', { class: 'jam-source' });
    this.phoneCtl = this.toggle('phone', 'Also play on this phone', () => { this.paintSource(); if (this.running) this.tick(); });
    const now = el('section', { class: 'instrument jam-now', 'aria-label': 'Now playing' }, [
      el('div', { class: 'jam-hero' }, [
        el('div', { class: 'jam-chord', 'aria-live': 'polite' }, [this.numeral, this.chordName]),
        this.keyLine,
        el('div', { class: 'jam-meter' }, [el('div', { class: 'jam-beats', 'aria-hidden': 'true' }, this.beatDots), this.barText]),
        this.barLine,
      ]),
      this.strip,
      el('div', { class: 'instrument-foot jam-transport' }, [
        this.playBtn,
        el('div', { class: 'jam-tempo' }, [minus, this.bpmOut, plus, tap]),
      ]),
      el('div', { class: 'jam-sourcebar' }, [this.sourceLine, this.phoneCtl]),
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
    const droneSec = this.panel('Drone', 'With an instrument connected, it plays the drone: the chord held, gliding between chords, with color notes now and then. Its sound is the Instrument sound panel, moved by Modulation. With nothing connected, the phone makes one.', [
      this.toggle('drone', 'Drone on', () => { if (this.running) this.tick(); }),
      el('p', { class: 'jam-hint jam-wide', text: 'Texture, Level, Brightness, Movement and Space shape the phone’s drone only. Voicing and Color notes shape both.' }),
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
    const kitSec = this.panel('Pulse', 'A quiet kit to keep time. It plays on the phone, so it’s silent while an instrument plays unless “Also play on this phone” is on.', [
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
    this.patchBtn = el('button', { type: 'button', class: 'btn', text: 'Load a matching sound' });
    this.patchBtn.addEventListener('click', () => this.loadSound());
    this.sendAllBtn = el('button', { type: 'button', class: 'btn hw', text: 'Send all' });
    this.sendAllBtn.addEventListener('click', () => this.sendSound());
    this.patternFeel = el('p', { class: 'jam-hint' });
    this.linkNote = el('p', { class: 'jam-hint jam-wide' });
    // Every MIDI port the phone sees, to pick the instrument by hand when
    // its name isn't one the page knows.
    this.portSel = el('select', { class: 'device-select jam-portsel', 'aria-label': 'MIDI port' });
    this.portSel.addEventListener('change', () => this.choosePort(this.portSel.value));
    this.portRow = el('label', { class: 'ctl jam-wide jam-port' }, [el('span', { class: 'ctl-name', text: 'MIDI port' }), this.portSel]);
    // When a USB connect doesn't work: what Chrome answered and what to try
    // (hw/midi-check.js), with the facts to copy.
    this.checkTitle = el('strong');
    this.checkStamp = el('span', { class: 'jam-check-stamp' });
    this.checkSteps = el('ol');
    this.checkDetails = el('pre');
    this.retryBtn = el('button', { type: 'button', class: 'btn hw', text: 'Try again' });
    this.retryBtn.addEventListener('click', () => this.connectUsb());
    const copyBtn = el('button', { type: 'button', class: 'btn', text: 'Copy details' });
    copyBtn.addEventListener('click', () => this.copyCheck(copyBtn));
    this.checkBox = el('div', { class: 'jam-check jam-wide', role: 'status' }, [
      el('div', { class: 'jam-check-head' }, [this.checkTitle, this.checkStamp]),
      this.checkSteps,
      el('div', { class: 'jam-check-btns' }, [this.retryBtn, copyBtn]),
      el('details', {}, [el('summary', { text: 'What Chrome reports' }), this.checkDetails]),
    ]);
    this.checkBox.hidden = true;
    const instSec = this.panel('Your instrument', 'Plug the FM-1, SMK-37 or AKS Mini into the phone (or pair it over Bluetooth) and it makes the sound: the drone, and a part over it.', [
      this.targetCtl,
      el('div', { class: 'jam-wide' }, [this.linkLine]),
      this.checkBox,
      this.portRow,
      el('div', { class: 'jam-wide' }, [
        this.choice('pattern', 'Part', T.PATTERN_IDS, T.PATTERN_IDS.map((p) => T.PATTERNS[p].name), () => { this.paintFeel(); this.ensurePreview(); this.restart(); }),
        this.patternFeel,
      ]),
      this.choice('octave', 'Octave', [-2, -1, 0, 1], ['−2', '−1', '0', '+1'], () => this.restart()),
      this.toggle('clock', 'Send MIDI clock', (on) => { if (this.running) this.link().sendRaw?.([on ? 0xfa : 0xfc]); }),
      this.linkNote,
    ], [this.usbBtn, this.bleBtn]);

    // The instrument's sound, set from here over MIDI.
    this.soundCtls = new Map();
    this.soundNote = el('p', { class: 'jam-hint jam-wide' });
    const groups = SOUND.map(([name, keys]) => el('div', { class: 'control-group' }, [
      el('span', { class: 'group-name', text: name }),
      ...keys.map((k) => {
        const c = makeControl(k, this.s.sound[k], (key, v) => this.setSound(key, v));
        this.soundCtls.set(k, c);
        return c;
      }),
    ]));
    this.presetBtns = Object.keys(SOUND_PRESETS).map((name) => {
      const b = el('button', { type: 'button', text: name, 'aria-pressed': 'false' });
      b.addEventListener('click', () => this.loadPreset(name));
      return b;
    });
    const presets = el('div', { class: 'ctl jam-wide' }, [
      el('div', { class: 'ctl-top' }, [el('span', { class: 'ctl-name', text: 'Sound' })]),
      el('div', { class: 'seg jam-presets', role: 'group', 'aria-label': 'Instrument sound' }, this.presetBtns),
    ]);
    this.presetSec = this.panel('Sound', 'One tap sets the instrument’s whole preset from the page.', [presets, this.soundNote]);
    this.soundSec = this.panel('Instrument sound', 'The instrument’s preset, set from here: it plays both the drone and the part. A long Attack and full Sustain make the drone swell in.', groups, [this.patchBtn, this.sendAllBtn]);

    // Modulation: a few slots, each a shape on a parameter. Tap a trace to
    // edit it; the switch beside it turns it on.
    this.modStatus = el('p', { class: 'jam-modstatus' });
    this.modRows = this.s.mods.map((m, i) => {
      const sw = el('button', { type: 'button', class: 'jam-mod-on', role: 'switch', 'aria-label': `Modulator ${i + 1} on` });
      sw.addEventListener('click', () => this.setMod(i, { on: !this.s.mods[i].on }));
      const cv = el('canvas', { 'aria-hidden': 'true' });
      const pick = el('button', { type: 'button', class: 'jam-mod-pick', 'aria-label': `Edit modulator ${i + 1}` }, [cv]);
      pick.addEventListener('click', () => this.selectMod(i));
      onFrame(cv, (now) => this.drawMod(i, cv, now));
      return { sw, pick, row: el('div', { class: 'jam-mod' }, [sw, pick]) };
    });
    const edit = (key) => (_, v) => this.setMod(this.s.modSel, { [key]: v });
    const hzText = (v) => { const hz = MOD.rateHz(v); return hz < 0.1 ? `${hz.toFixed(3)} Hz` : `${hz.toFixed(2)} Hz`; };
    const cur = this.s.mods[this.s.modSel];
    this.modCtls = {
      shape: makeControl('jam.modShape', cur.shape, edit('shape'), { def: { label: 'Shape', type: 'choice', options: MOD.SHAPE_IDS, names: MOD.SHAPE_IDS.map((k) => MOD.SHAPES[k].name), kind: 'move' } }),
      target: makeControl('jam.modTarget', cur.target, edit('target'), { def: { label: 'Moves', type: 'choice', options: MOD.TARGET_IDS, names: MOD.TARGET_IDS.map((k) => MOD.TARGETS[k].label), kind: 'move' } }),
      rate: makeControl('jam.modRate', cur.rate, edit('rate'), { def: { label: 'Rate', min: 0, max: 100, step: 1, kind: 'move', format: hzText } }),
      depth: makeControl('jam.modDepth', cur.depth, edit('depth'), { def: { label: 'Depth', min: 0, max: 100, step: 1, kind: 'move' } }),
    };
    this.modSec = this.panel('Modulation', 'Shapes that move the instrument’s sound by themselves while it plays. Not yet tried on the hardware: how it sounds on the FM-1 or SMK-37 is still to be heard.', [
      el('div', { class: 'jam-wide' }, [this.modStatus]),
      el('div', { class: 'jam-wide jam-mods' }, this.modRows.map((r) => r.row)),
      this.modCtls.shape, this.modCtls.target, this.modCtls.rate, this.modCtls.depth,
    ]);
    for (const k of ['shape', 'target']) this.modCtls[k].classList.add('jam-wide', 'jam-modctl');

    // The neck.
    this.neck = el('div', { class: 'jam-neck' });
    this.scaleLine = el('p', { class: 'jam-scale' });
    const neckSec = el('section', { class: 'instrument jam-neck-panel', 'aria-label': 'Notes on the guitar neck' }, [
      el('div', { class: 'instrument-head' }, [el('h3', { text: 'On the neck' }), el('p', { text: 'Standard tuning, frets 0 to 12. Filled: the chord playing now. Ringed: the key’s root. Hollow: the rest of the scale.' })]),
      this.scaleLine,
      this.neck,
    ]);

    const side = el('div', { class: 'jam-side' }, [now, neckSec]);
    // On a phone the order is the order of use: the chord and Play, key and
    // mode, the sound, what moves it, the neck to watch it on, the
    // instrument, then the rest (jam.css).
    now.classList.add('jam-o0'); keySec.classList.add('jam-o1'); this.presetSec.classList.add('jam-o2');
    this.modSec.classList.add('jam-o3'); neckSec.classList.add('jam-o4'); instSec.classList.add('jam-o5');
    this.soundSec.classList.add('jam-o6');
    const controls = el('div', { class: 'jam-controls' }, [keySec, this.presetSec, this.modSec, this.soundSec, instSec, droneSec, kitSec]);

    // A bar pinned to the bottom of a phone screen: the chord and Play stay
    // in reach however far down the settings you are.
    this.dockChord = el('strong', { class: 'jam-dock-chord' });
    this.dockBtn = el('button', { type: 'button', class: 'btn primary jam-dock-play', 'aria-pressed': 'false' });
    this.dockBtn.addEventListener('click', () => (this.running ? this.stop() : this.start()));
    this.dock = el('div', { class: 'jam-dock' }, [this.dockChord, this.dockBtn]);
    this.append(el('div', { class: 'jam-grid' }, [side, controls]), this.dock);
    onFrame(this.neck, (now) => this.drawNeck(now));
    this.paintTargets();
    this.paintMods();
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
    } catch (_) { /* the check under the link says what happened (paintCheck) */ }
    this.paintLink();
  }

  async copyCheck(btn) {
    const text = this.checkDetails.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch (_) {
      // No clipboard: open the details and select them to copy by hand.
      this.checkDetails.parentElement.open = true;
      getSelection().selectAllChildren(this.checkDetails);
      btn.textContent = 'Selected: copy it';
    }
    setTimeout(() => { btn.textContent = 'Copy details'; }, 2500);
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

  // The part's whole sound: the pad or pluck for the pattern, with the
  // panel's settings on top.
  fullPatch() { return mergePatch(patchFor(this.s.pattern), toPatch(this.s.sound)); }

  // One setting from the panel ('page'), or from the instrument's own knob
  // ('hw', which is only shown here and never sent back).
  setSound(key, value, source = 'page') {
    this.s.sound[key] = value;
    this.save();
    // A slider that sets what a modulator moves puts it back at the slider's
    // value, so the modulator's next step must be sent again.
    for (const id of MOD.TARGET_IDS) if (MOD.TARGETS[id].key === key) this.mod.sent.delete(id);
    if (source === 'hw') this.soundCtls.get(key)?.update(value);
    else if (this.s.target !== 'aks') {
      if (key.startsWith('fx.')) { const [, fx, field] = key.split('.'); fm1.sendFx(fx, field, value); }
      else fm1.sendParam(key, value);
    }
    this.preview?.set(toPatch({ [key]: value }));
    if (key === 'attack' || key === 'release') this.paintSoundNote();
  }

  // Set the panel to the pad (Hold) or pluck (everything else) and send it.
  loadSound() {
    this.s.sound = soundFrom(patchFor(this.s.pattern));
    for (const [k, c] of this.soundCtls) c.update(this.s.sound[k]);
    this.save();
    if (this.preview) { this.preview.dispose(); this.preview = null; this.ensurePreview(); }
    this.sendSound(`Loaded the ${this.s.pattern === 'hold' ? 'drone pad' : 'pluck'} from lesson 10`);
  }

  // A one-tap sound: the whole panel, then sent to the instrument.
  loadPreset(name) {
    this.s.sound = soundFrom(mergePatch(PATCHES.hold, SOUND_PRESETS[name]));
    for (const [k, c] of this.soundCtls) c.update(this.s.sound[k]);
    this.presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === name)));
    this.save();
    if (this.preview) { this.preview.dispose(); this.preview = null; this.ensurePreview(); }
    this.sendSound(`Loaded ${name}`);
  }

  // Send everything on the panel, so the instrument matches it.
  sendSound(what = 'Sent the panel') {
    if (this.s.target === 'aks') return;
    if (!fm1.canSetSound) {
      this.soundNote.textContent = `${what} to the page’s synth. Connect the ${device().label} to send it there too.`;
      return;
    }
    const n = fm1.sendPatch(this.fullPatch());
    this.soundNote.textContent = `${what}: ${n} settings sent to the ${device().label}’s current preset. Press ${ctlName('SAVE')} on it to keep them.`;
  }

  paintSoundNote() {
    if (!this.soundNote) return;
    const label = device().label;
    let text;
    if (device().stock) text = `On stock firmware these only shape the page’s synth: the ${label} doesn’t take Baud Girl’s settings.`;
    else if (!fm1.canSend) text = `These shape the page’s synth now, and the ${label} too once it’s connected. They start from the page’s last settings, not the instrument’s: Send all makes the two match.`;
    else text = `Each slider sets the ${label}’s current preset as it moves (a Virtual Analog preset; the FM and 8-Bit engines don’t take these). If Attack and Release change nothing, its envelope is off: hold ${ctlName('ENV')} on the ${label} to switch it on. Turning its knobs moves these sliders too.`;
    this.soundNote.textContent = text;
  }

  // A port chosen by hand: its output, and the input with the same name.
  choosePort(id) {
    if (this.s.target === 'aks') { aks.selectOutput(id || null); this.paintLink(); return; }
    fm1.selectOutput(id || null);
    const out = fm1.ports().outputs.find((p) => p.id === id);
    const inp = out && fm1.ports().inputs.find((p) => p.name === out.name);
    if (inp) fm1.selectInput(inp.id);
    this.paintLink();
    this.paintSource();
  }

  paintPorts() {
    const aksT = this.s.target === 'aks';
    const access = fm1.access;
    this.portRow.hidden = !access || (!aksT && fm1.bleActive);
    if (this.portRow.hidden) return;
    const outs = fm1.ports().outputs.filter((p) => p.state === 'connected');
    const current = aksT ? aks.output?.id : fm1.output?.id;
    this.portSel.replaceChildren(
      el('option', { value: '', text: outs.length ? 'None chosen' : 'No MIDI ports found: check the cable' }),
      ...outs.map((p) => el('option', { value: p.id, text: p.name || '(no name)' })),
    );
    this.portSel.value = current || '';
  }

  // A message under the instrument's controls that stays until the next one.
  say(msg) {
    delete this.linkNote.dataset.auto;
    this.linkNote.textContent = msg;
  }

  // ---------- Painting ----------
  paintAll() {
    this.paintBars(-1, this.s.barsPer);
    this.setBpm(this.s.bpm);
    this.paintKeys();
    this.paintPlay();
    this.paintChord();
    this.paintStrip();
    this.paintFeel();
    this.paintNeck();
    this.paintLink();
    this.paintSource();
  }

  // Under the Play button: where the sound is coming from right now.
  paintSource() {
    if (!this.sourceLine) return;
    const name = this.s.target === 'aks' ? 'AKS Mini' : device().label;
    const inst = this.linkReady();
    let text;
    if (inst && this.s.phone) text = `Sound: the ${name} and this phone.`;
    else if (inst) text = `Sound: the ${name}. The phone is silent.`;
    else text = `Sound: this phone. Connect the ${name} below and it plays instead.`;
    this.sourceLine.textContent = text;
    this.sourceLine.toggleAttribute('data-on', inst);
    this.phoneCtl.hidden = !inst;
  }

  // The modulator slots and the editor under them, and the line that says
  // whether they are going out over MIDI.
  paintMods() {
    if (!this.modRows) return;
    const sel = this.s.modSel;
    this.s.mods.forEach((m, i) => {
      const r = this.modRows[i];
      r.sw.setAttribute('aria-checked', String(m.on));
      r.pick.setAttribute('aria-pressed', String(i === sel));
    });
    const m = this.s.mods[sel];
    for (const k of ['shape', 'target', 'rate', 'depth']) this.modCtls[k].update(m[k]);
    const name = this.s.target === 'aks' ? 'AKS Mini' : device().label;
    let text;
    if (this.modSending()) text = `Moving the ${name}’s current preset${this.phoneOn() ? ' and this phone’s sound' : ''}.`;
    else if (this.s.target === 'aks') text = 'The AKS Mini isn’t changed from here. Moves this phone’s sound.';
    else if (device().stock) text = `Stock firmware takes none of this. Moves this phone’s sound.`;
    else text = `Moves this phone’s sound. Connect the ${name} to move it too.`;
    this.modStatus.textContent = text;
    this.modStatus.toggleAttribute('data-on', this.modSending());
  }

  paintPlay() {
    this.playBtn.setAttribute('aria-pressed', String(this.running));
    this.playBtn.textContent = this.running ? 'Stop' : 'Play';
    this.dockBtn.setAttribute('aria-pressed', String(this.running));
    this.dockBtn.textContent = this.running ? 'Stop' : 'Play';
  }

  paintKeys() {
    this.keyBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === this.s.key)));
  }

  paintChord() {
    const c = this.chords[this.shown] || this.chords[0];
    const next = this.chords.length > 1 ? this.chords[(this.shown + 1) % this.chords.length] : null;
    this.chordName.textContent = c.name;
    this.dockChord.textContent = c.name;
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
      this.instrumentDroneOff();
      this.modApply({}, performance.now());
      this.silence();
      this.s.target = v;
      this.save();
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
    this.paintCheck();
    this.paintPorts();
    const midi = fm1.supported.midi;
    this.usbBtn.hidden = !midi || (aksT ? aks.connected : !!fm1.output);
    this.usbBtn.textContent = fm1.access ? `Find the ${name}` : 'Connect USB MIDI';
    this.bleBtn.hidden = aksT || !fm1.supported.bluetooth;
    this.bleBtn.textContent = fm1.bleActive ? 'Disconnect Bluetooth' : fm1.ble?.device ? 'Reconnect Bluetooth' : 'Connect over Bluetooth';
    // The sound panel is for the FM-1 and SMK-37 (the AKS Mini has its own
    // lessons); on stock firmware it shapes only the page's synth.
    this.soundSec.hidden = aksT;
    this.presetSec.hidden = aksT;
    this.sendAllBtn.hidden = !!device().stock;
    this.sendAllBtn.disabled = !fm1.canSetSound;
    this.paintSoundNote();
    this.paintMods();
    if (!midi && !fm1.supported.bluetooth) {
      this.linkNote.textContent = 'This browser can’t talk to instruments. Chrome on Android (or Chrome or Edge on a computer) can, over USB or Bluetooth.';
    } else if (!this.linkNote.textContent || this.linkNote.dataset.auto) {
      this.linkNote.dataset.auto = '1';
      this.linkNote.textContent = aksT
        ? 'The AKS Mini plays over USB only. The page never changes its sound; set it by hand.'
        : device().stock
          ? 'On stock firmware the page sends notes only; set the sound on the instrument. Over USB, a phone needs a USB-C cable or an OTG adapter. Bluetooth needs the instrument’s Bluetooth MIDI switched on, and a tap here each time the page opens.'
          : 'Bluetooth needs the instrument in BT Device mode, and a tap here each time the page opens. Over USB, a phone needs a USB-C cable or an OTG adapter.';
    }
  }

  // The check under the link line: only after a tap on Connect (not the
  // quiet reconnect on load), and only while USB isn't working.
  paintCheck() {
    const aksT = this.s.target === 'aks';
    const facts = { ...fm1.midiFacts(), device: aksT ? 'AKS Mini' : device().label, sound: this.phoneOn() };
    if (aksT) facts.using = aks.connected ? aks.output.name : null;
    const c = explainConnect(facts);
    const show = !!c && c.level !== 'ok' && !fm1.midiTry?.quiet && !(fm1.bleActive && !aksT);
    this.checkBox.hidden = !show;
    if (!show) return;
    this.checkBox.dataset.level = c.level;
    this.checkTitle.textContent = c.title;
    this.checkStamp.textContent = c.stamp;
    this.checkSteps.replaceChildren(...c.steps.map((s) => el('li', { text: s })));
    this.checkSteps.hidden = !c.steps.length;
    this.checkDetails.textContent = c.details;
    this.retryBtn.hidden = c.level === 'wait';
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
    // The glow under the chord notes (drawNeck): soft discs, in the
    // modulation color, behind the dots.
    const defs = add('defs', {});
    const blur = document.createElementNS(ns, 'filter');
    blur.setAttribute('id', 'jam-glow');
    blur.setAttribute('x', '-50%'); blur.setAttribute('y', '-50%'); blur.setAttribute('width', '200%'); blur.setAttribute('height', '200%');
    const sd = document.createElementNS(ns, 'feGaussianBlur');
    sd.setAttribute('stdDeviation', '4');
    blur.append(sd); defs.append(blur);
    const glowLayer = add('g', { class: 'halos', filter: 'url(#jam-glow)' });
    this.halos = [];
    for (let s = 0; s < 6; s++) {
      for (let f = 0; f <= FRETS; f++) {
        const p = T.pc(T.GUITAR_TUNING[s] + f);
        if (!this.scale.includes(p)) continue;
        const y = f === 0 ? nut / 2 : nut + row * (f - 0.5);
        const inChord = chord.pcs.includes(p);
        const cls = ['dot', inChord ? 'chord' : 'scale', p === chord.root ? 'chordroot' : '', p === key ? 'key' : ''].filter(Boolean).join(' ');
        if (inChord) {
          const halo = document.createElementNS(ns, 'circle');
          for (const [k, v] of Object.entries({ class: 'halo', cx: xs(s), cy: y, r: 16, 'fill-opacity': 0 })) halo.setAttribute(k, v);
          glowLayer.append(halo);
          // How far along the neck it is, 0 to 1, for the ripple.
          this.halos.push({ el: halo, r: 14, pos: (s * (FRETS + 1) + f) / (6 * (FRETS + 1) - 1), o: '0.00' });
        }
        add('circle', { class: cls, cx: xs(s), cy: y, r: inChord ? 14 : 11 });
        add('text', { class: `dotname${inChord ? ' on' : ''}`, x: xs(s), y: y + 4 }, T.spell(p, key, mode));
      }
    }
    this.neck.replaceChildren(svg);
  }
}

customElements.define('jam-room', JamRoom);
