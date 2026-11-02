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
import { device, onDeviceChange, ctl as ctlName } from '../ui/device.js';
import { VASynth, DEFAULT_VA } from '../audio/va-synth.js';
import { DroneEngine, Kit, TEXTURES, TEXTURE_IDS, VOICINGS, VOICING_IDS } from '../audio/drone.js';
import * as T from '../audio/theory.js';
import { loopEvents, splitPatterns, writeSmf, PATTERN_STEPS } from '../audio/smf.js';

const STORE = 'jam.settings';
const DEFAULTS = {
  key: 9, mode: 'dorian', prog: 'vamp', barsPer: 2, bpm: 84, seventh: false,
  drone: true, texture: 'warm', voicing: 'fifth', level: 60, brightness: 40, movement: 50, color: 40, space: 55,
  groove: 'off', kitLevel: 45,
  target: 'main', pattern: 'pulse', octave: 0, clock: false, phone: false,
};

// The sounds the page's synth uses for a part, and the ones "Send a matching
// sound" sets on the instrument: lesson 10's drone for Hold, its pluck for
// the rest.
const PATCHES = {
  hold: { waveform: 'tri', super: 60, detune: 30, drift: 45, noise: 12, filterType: 'lp12', cutoff: 1400, resonance: 38, lfoWave: 'sine', lfoSpeed: 12, lfoToCutoff: 30, attack: 80, decay: 60, sustain: 100, release: 100, fx: { chorus: { on: true, rate: 15, depth: 60, mix: 50 }, delay: { on: true, rate: 15, feedback: 55, mix: 30 }, reverb: { on: true, type: 'hall', decay: 85, mix: 55 } } },
  pluck: { waveform: 'saw', sub: 20, filterType: 'lp24', cutoff: 550, resonance: 28, filterEnv: 75, filterDecay: 24, attack: 0, decay: 35, sustain: 0, release: 30, fx: { delay: { on: true, rate: 45, feedback: 35, mix: 30 }, reverb: { on: true, type: 'room', decay: 35, mix: 20 } } },
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
    this.s = load();
    if (!T.MODES[this.s.mode]) this.s.mode = DEFAULTS.mode;
    this.s.sound = { ...soundFrom(PATCHES.hold), ...(this.s.sound || {}) };
    // Older settings called "also play on this phone" `preview`.
    if (this.s.preview !== undefined) { this.s.phone = !!this.s.preview; delete this.s.preview; }
    this.running = false;
    this.queue = []; // what the screen should show, and when
    this.pending = []; // note-offs not yet sent
    this.book = new Map(); // note -> how many voices hold it on the instrument
    this.idrone = { on: false, held: new Set(), nextBloom: Infinity, sentCutoff: 0, sentAt: 0 };
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
    onDeviceChange(() => { this.paintTargets(); this.paintLink(); this.paintPatterns(); });
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
    this.paintPatterns();
    this.save();
  }

  harmony(i) {
    return { key: this.s.key, mode: this.s.mode, chord: this.chords[i], color: this.colorPc };
  }

  // ---------- Transport ----------
  // `once`: { index, events, bars, startBar } plays one sequencer pattern a
  // single time after a bar of count-in, with MIDI Start, clock and Stop
  // around it, for an instrument recording in time with the page.
  async start(once = null) {
    if (this.running) this.stop();
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
    this.running = true;
    this.curChord = 0;
    this.phoneDrone = false;
    this.idrone.on = false;
    this.idrone.held = new Set();
    this.step = 0;
    this.once = once;
    this.origin = once ? 1 : 0; // one bar of count-in before a recording pass
    this.dirty = false;
    this.nextTime = ctx.currentTime + 0.12;
    this.queue = [];
    this.pending = [];
    this.book.clear();
    if (this.s.clock && !once) this.link().sendRaw?.([0xfa], this.midiAt(this.nextTime));
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
    if (this.s.clock || (this.once && !this.once.stopped)) this.link().sendRaw?.([0xfc]);
    this.once = null;
    this.paintPatterns();
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
  // by both. Each note is counted: a second voice re-strikes it, and it's
  // only let go when the last voice holding it lets go.
  noteOn(note, vel, at) {
    const link = this.link();
    const n = this.book.get(note) || 0;
    if (n > 0) link.noteOff(note, at);
    link.noteOn(note, vel, at);
    this.book.set(note, n + 1);
  }

  noteOff(note, at) {
    const n = (this.book.get(note) || 0) - 1;
    if (n > 0) { this.book.set(note, n); return; }
    this.book.delete(note);
    this.link().noteOff(note, at);
  }

  // Start, stop or follow the two drones as the instrument comes and goes.
  syncOutputs(t) {
    const phone = this.s.drone && this.phoneOn();
    if (phone !== this.phoneDrone) {
      this.phoneDrone = phone;
      phone ? this.drone.start() : this.drone.stop();
    }
    const inst = this.s.drone && this.linkReady() && !this.once;
    if (inst && !this.idrone.on) this.instrumentDroneOn(t);
    else if (!inst && this.idrone.on) this.instrumentDroneOff();
  }

  // The drone on the instrument: the chord held (gliding on common notes),
  // now and then a color note, and Movement sweeping its cutoff slowly.
  instrumentDroneOn(t) {
    const d = this.idrone;
    d.on = true;
    d.held = new Set();
    d.t0 = t;
    d.nextBloom = this.s.color > 0 ? t + 3 + Math.random() * 3 : Infinity;
    this.instrumentDroneChord(this.curChord ?? 0, t);
  }

  instrumentDroneChord(idx, t) {
    const d = this.idrone;
    if (!d.on) return;
    const want = new Set(T.droneNotes(this.s.key, this.chords[idx], this.s.voicing, this.s.octave));
    const at = this.midiAt(t);
    for (const n of d.held) if (!want.has(n)) this.noteOff(n, at);
    for (const n of want) if (!d.held.has(n)) this.noteOn(n, 0.62, at);
    d.held = want;
  }

  instrumentDroneOff() {
    const d = this.idrone;
    if (!d.on) return;
    d.on = false;
    for (const n of d.held) this.noteOff(n);
    d.held = new Set();
    d.nextBloom = Infinity;
    // Put the cutoff back where the Instrument sound panel says.
    if (d.sentCutoff && this.s.target !== 'aks') fm1.sendParam('cutoff', this.s.sound.cutoff, false);
    d.sentCutoff = 0;
  }

  instrumentDroneTick(until) {
    const d = this.idrone;
    if (!d.on) return;
    const { ctx } = audio();
    // Color notes: a chord tone or the mode's color note, high and soft,
    // held for a few seconds. The preset's envelope decides how it swells.
    while (d.nextBloom < until) {
      const chord = this.chords[this.curChord ?? 0];
      const pool = [...chord.pcs, this.colorPc, this.colorPc];
      const p = pool[Math.floor(Math.random() * pool.length)];
      const base = T.baseNote(this.s.key, this.s.octave) + 12;
      const note = base + T.pc(p - this.s.key) + (Math.random() < 0.3 ? 12 : 0);
      this.noteOn(note, 0.42, this.midiAt(d.nextBloom));
      this.pending.push({ note, off: d.nextBloom + 3 + Math.random() * 4, sent: false });
      const c = Math.max(1, this.s.color) / 100;
      d.nextBloom += 14 * Math.pow(2.5 / 14, c) * (0.5 + Math.random());
    }
    // Movement: the cutoff breathes around the panel's value, a cycle every
    // ~16 seconds, up to about an octave and a half each way. Only on Baud
    // Girl's firmware (the CC means something else on stock).
    const m = this.s.movement / 100;
    if (m <= 0 || this.s.target === 'aks' || !fm1.canSetSound) return;
    const now = performance.now();
    if (now - d.sentAt < 120) return;
    const base = this.s.sound.cutoff;
    const v = Math.min(20000, Math.max(40, base * Math.pow(2, 1.5 * m * Math.sin(2 * Math.PI * 0.061 * (ctx.currentTime - d.t0)))));
    if (Math.abs(Math.log2(v / (d.sentCutoff || 1))) < 0.03) return;
    fm1.sendParam('cutoff', v);
    d.sentCutoff = v;
    d.sentAt = now;
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
    if (this.once) {
      const o = this.once;
      const ready = this.linkReady();
      if (bar < 0) {
        // Count-in: clicks on the beats, and clock so the instrument is
        // already following the page's tempo when Start arrives.
        if (sub % 4 === 0) this.kit.hit('rim', t, sub === 0 ? 1 : 0.65);
        if (ready) clock();
        if (sub % 4 === 0) this.queue.push({ t, beat: sub / 4 });
        return;
      }
      if (bar >= o.bars) {
        if (!o.stopped) {
          o.stopped = true;
          if (ready) this.link().sendRaw([0xfc], this.midiAt(t));
          const { ctx } = audio();
          setTimeout(() => { if (this.once === o) this.stop(); }, Math.max(0, (t - ctx.currentTime) * 1000) + 80);
        }
        return;
      }
      if (bar === 0 && sub === 0 && ready) this.link().sendRaw([0xfa], this.midiAt(t));
      const pbar = bar + o.startBar;
      const idx = Math.floor(pbar / per) % this.chords.length;
      if (sub === 0) {
        if (pbar % per === 0 || bar === 0) { this.curChord = idx; this.drone.setHarmony(this.harmony(idx), bar === 0, t); }
        // Exactly the notes the downloaded file for this pattern holds.
        const from = bar * T.STEPS_PER_BAR;
        this.playEvents(o.events.filter((e) => e.step >= from && e.step < from + T.STEPS_PER_BAR).map((e) => ({ ...e, step: e.step - from })), t);
        this.queue.push({ t, chord: idx, bar, inChord: pbar % per, per });
      }
      if (this.phoneOn()) for (const h of T.grooveBar(this.s.groove)) if (h.step === sub) this.kit.hit(h.drum, t, h.vel);
      if (ready) clock();
      if (sub % 4 === 0) this.queue.push({ t, beat: sub / 4 });
      return;
    }
    const idx = Math.floor(bar / per) % this.chords.length;
    const inChord = bar % per;
    const chord = this.chords[idx];

    if (sub === 0) {
      if (inChord === 0) {
        this.curChord = idx;
        this.drone.setHarmony(this.harmony(idx), false, t);
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
    if (this.phoneOn()) for (const h of T.grooveBar(this.s.groove)) if (h.step === sub) this.kit.hit(h.drum, t, h.vel);
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
      this.noteOn(e.note, e.vel, this.midiAt(on));
      // The instrument's note-off waits here until its time comes into the
      // lookahead, rather than going to the port bars in advance, so Stop
      // always knows what is still sounding (a held chord can last 8 bars).
      this.pending.push({ note: e.note, off, sent: false });
    }
  }

  // Send the note-offs due before `until`. Each stays listed until its time
  // has passed, so Stop can repeat it at once if the port drops it.
  flushOffs(until) {
    const { ctx } = audio();
    for (const p of this.pending) {
      if (p.sent || p.off >= until) continue;
      p.sent = true;
      this.noteOff(p.note, this.midiAt(p.off));
    }
    this.pending = this.pending.filter((p) => !p.sent || p.off > ctx.currentTime - 0.05);
  }

  // Everything still sounding ends now: the instrument (note by note, then
  // All Notes Off) and the page's synth.
  silence() {
    const link = this.link();
    for (const p of this.pending) if (!p.sent) link.noteOff(p.note);
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

  // ---------- Patterns for the instrument's sequencer ----------
  // One pass through the progression, cut into patterns of up to 64 steps.
  patterns() {
    return splitPatterns(loopEvents({
      chords: this.chords, barsPer: this.s.barsPer, pattern: this.s.pattern,
      key: this.s.key, mode: this.s.mode, octave: this.s.octave,
      voicing: this.s.voicing === 'chord' ? 'chord' : 'fifth',
    }), PATTERN_STEPS);
  }

  fileStem() {
    const key = T.spell(this.s.key, this.s.key, this.s.mode).replace('♭', 'b').replace('♯', 's');
    return `jam-${key}-${this.s.mode}-${this.s.prog}-${this.s.pattern}`;
  }

  download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  downloadPattern(p, total) {
    const name = total > 1 ? `${this.fileStem()}-pattern${p.index + 1}of${total}.mid` : `${this.fileStem()}.mid`;
    const label = `${T.keyLabel(this.s.key, this.s.mode)} ${T.PATTERNS[this.s.pattern].name}${total > 1 ? ` ${p.index + 1}/${total}` : ''}`;
    this.download(writeSmf({ events: p.events, steps: p.steps, bpm: this.s.bpm, name: label, channel: this.s.target === 'aks' ? aks.channel : fm1.midiChannel }), name);
  }

  // The whole loop as one file, for a groovebox or a DAW that has room.
  downloadLoop() {
    const loop = loopEvents({
      chords: this.chords, barsPer: this.s.barsPer, pattern: this.s.pattern,
      key: this.s.key, mode: this.s.mode, octave: this.s.octave,
      voicing: this.s.voicing === 'chord' ? 'chord' : 'fifth',
    });
    this.download(writeSmf({ ...loop, bpm: this.s.bpm, name: `${T.keyLabel(this.s.key, this.s.mode)} loop`, channel: fm1.midiChannel }), `${this.fileStem()}-loop.mid`);
  }

  async recordPass(p) {
    await this.start({ index: p.index, events: p.events, bars: p.steps / T.STEPS_PER_BAR, startBar: p.start / T.STEPS_PER_BAR });
    this.paintPatterns();
  }

  paintPatterns() {
    if (!this.patternList) return;
    const parts = this.patterns();
    const bars = (p) => {
      const a = p.start / T.STEPS_PER_BAR + 1;
      const b = (p.start + p.steps) / T.STEPS_PER_BAR;
      return a === b ? `bar ${a}` : `bars ${a}–${b}`;
    };
    this.patternList.replaceChildren(...parts.map((p) => {
      const dl = el('button', { type: 'button', class: 'btn', text: 'Download .mid' });
      dl.addEventListener('click', () => this.downloadPattern(p, parts.length));
      const rec = el('button', { type: 'button', class: 'btn hw', text: this.once?.index === p.index ? 'Playing…' : 'Play into sequencer' });
      rec.disabled = !!this.once;
      rec.addEventListener('click', () => this.recordPass(p));
      return el('li', {}, [
        el('div', {}, [el('strong', { text: parts.length > 1 ? `Pattern ${p.index + 1}` : 'One pattern' }), el('span', { text: ` · ${bars(p)}, ${p.steps} steps, ${p.events.length} notes` })]),
        el('div', { class: 'jam-pattern-btns' }, [dl, rec]),
      ]);
    }));
    const stockNote = device().stock && this.s.target !== 'aks'
      ? ' On stock firmware the instrument has its own sequencer, not Baud Girl’s, so the files are for a Bento, MPC or DAW; Play into sequencer still works with anything that follows MIDI clock and records the notes it receives.'
      : '';
    this.chainNote.textContent = (parts.length > 1
      ? `The loop is longer than one pattern holds, so it comes as ${parts.length}. Load them into consecutive patterns, chain each to the next and the last back to the first.`
      : 'The whole loop fits in one pattern. Set the pattern to repeat and it plays until you stop it.') + stockNote;
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
    const droneSec = this.panel('Drone', 'With an instrument connected, it plays the drone: the chord held, gliding between chords, color notes now and then, and Movement slowly sweeping its Cutoff. Its sound is the Instrument sound panel. With nothing connected, the phone makes one.', [
      this.toggle('drone', 'Drone on', () => { if (this.running) this.tick(); }),
      el('p', { class: 'jam-hint jam-wide', text: 'Texture, Level, Brightness and Space shape the phone’s drone only. Voicing, Movement and Color notes shape both.' }),
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
    const instSec = this.panel('Your instrument', 'Plug the FM-1, SMK-37 or AKS Mini into the phone (or pair it over Bluetooth) and it makes the sound: the drone, and a part over it.', [
      this.targetCtl,
      el('div', { class: 'jam-wide' }, [this.linkLine]),
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
    this.soundSec = this.panel('Instrument sound', 'The instrument’s preset, set from here: it plays both the drone and the part. A long Attack and full Sustain make the drone swell in.', [
      this.soundNote,
      ...groups,
    ], [this.patchBtn, this.sendAllBtn]);

    // Taking the part away on the instrument.
    this.patternList = el('ol', { class: 'jam-patterns' });
    this.chainNote = el('p', { class: 'jam-hint' });
    const loopBtn = el('button', { type: 'button', class: 'btn', text: 'Whole loop as one .mid' });
    loopBtn.addEventListener('click', () => this.downloadLoop());
    const keepSec = this.panel('Keep it on the instrument', 'Save the part so the instrument plays it unplugged. A Baud Girl pattern holds 64 steps (four bars), so a longer loop comes as several patterns to chain.', [
      el('div', { class: 'jam-wide' }, [this.patternList, this.chainNote]),
      el('div', { class: 'jam-wide' }, [
        el('p', { class: 'jam-hint', text: 'Download: a MIDI file per pattern, for the MIDI Files section of Baud Girl’s Device Manager (or a Bento, MPC or DAW). Play into sequencer: one bar of clicks, then MIDI Start, the pattern in time with clock, and Stop, for an instrument following clock and recording. Neither has been tried on the hardware yet; see the notes below the page.' }),
      ]),
    ], [loopBtn]);

    // The neck.
    this.neck = el('div', { class: 'jam-neck' });
    this.scaleLine = el('p', { class: 'jam-scale' });
    const neckSec = el('section', { class: 'instrument jam-neck-panel', 'aria-label': 'Notes on the guitar neck' }, [
      el('div', { class: 'instrument-head' }, [el('h3', { text: 'On the neck' }), el('p', { text: 'Standard tuning, frets 0 to 12. Filled: the chord playing now. Ringed: the key’s root. Hollow: the rest of the scale.' })]),
      this.scaleLine,
      this.neck,
    ]);

    const side = el('div', { class: 'jam-side' }, [now, neckSec]);
    const controls = el('div', { class: 'jam-controls' }, [keySec, instSec, this.soundSec, keepSec, droneSec, kitSec]);
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

  // The part's whole sound: the pad or pluck for the pattern, with the
  // panel's settings on top.
  fullPatch() { return mergePatch(patchFor(this.s.pattern), toPatch(this.s.sound)); }

  // One setting from the panel ('page'), or from the instrument's own knob
  // ('hw', which is only shown here and never sent back).
  setSound(key, value, source = 'page') {
    this.s.sound[key] = value;
    this.save();
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
    this.paintPatterns();
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
      this.instrumentDroneOff();
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
    const midi = fm1.supported.midi;
    this.usbBtn.hidden = !midi || (aksT ? aks.connected : !!fm1.output);
    this.usbBtn.textContent = fm1.access ? `Find the ${name}` : 'Connect USB MIDI';
    this.bleBtn.hidden = aksT || !fm1.supported.bluetooth;
    this.bleBtn.textContent = fm1.bleActive ? 'Disconnect Bluetooth' : fm1.ble?.device ? 'Reconnect Bluetooth' : 'Connect over Bluetooth';
    // The sound panel is for the FM-1 and SMK-37 (the AKS Mini has its own
    // lessons); on stock firmware it shapes only the page's synth.
    this.soundSec.hidden = aksT;
    this.sendAllBtn.hidden = !!device().stock;
    this.sendAllBtn.disabled = !fm1.canSetSound;
    this.paintSoundNote();
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
