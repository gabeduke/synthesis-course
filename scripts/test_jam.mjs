// Tests for the Jam page's music theory, modulation and USB connect check:
// node scripts/test_jam.mjs
import assert from 'node:assert/strict';
import * as T from '../site/assets/js/audio/theory.js';
import * as M from '../site/assets/js/audio/modulation.js';
import * as C from '../site/assets/js/hw/midi-check.js';
import { VA_CC, ccValue } from '../site/assets/js/hw/cc.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };

test('scales', () => {
  assert.deepEqual(T.scale(0, 'ionian'), [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(T.scale(9, 'dorian'), [9, 11, 0, 2, 4, 6, 7]); // A B C D E F♯ G
  assert.deepEqual(T.scale(4, 'phrygian'), [4, 5, 7, 9, 11, 0, 2]);
});

test('chord names in each mode', () => {
  const names = (k, m) => [0, 1, 2, 3, 4, 5, 6].map((d) => T.chordOn(k, m, d).name);
  assert.deepEqual(names(0, 'ionian'), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'B°']);
  assert.deepEqual(names(9, 'dorian'), ['Am', 'Bm', 'C', 'D', 'Em', 'F♯°', 'G']);
  assert.deepEqual(names(2, 'aeolian'), ['Dm', 'E°', 'F', 'Gm', 'Am', 'B♭', 'C']);
  assert.equal(T.chordOn(7, 'mixolydian', 0, { seventh: true }).name, 'G7');
  assert.equal(T.chordOn(0, 'ionian', 0, { seventh: true }).name, 'Cmaj7');
  assert.equal(T.chordOn(9, 'aeolian', 1, { seventh: true }).name, 'Bm7♭5');
});

test('numerals show borrowed degrees', () => {
  assert.equal(T.chordOn(7, 'mixolydian', 6).numeral, '♭VII');
  assert.equal(T.chordOn(4, 'phrygian', 1).numeral, '♭II');
  assert.equal(T.chordOn(9, 'dorian', 3).numeral, 'IV');
  assert.equal(T.chordOn(0, 'lydian', 1).numeral, 'II');
});

test('every progression exists for every mode', () => {
  for (const m of T.MODE_IDS) for (const p of T.PROGRESSION_IDS) {
    const ch = T.progression(0, m, p);
    assert.ok(ch.length >= 1, `${m} ${p}`);
    assert.equal(ch[0].degree, 0, 'starts on the root');
  }
  assert.deepEqual(T.progression(9, 'dorian', 'vamp').map((c) => c.name), ['Am', 'D']);
});

test('spelling follows the key', () => {
  assert.equal(T.keyLabel(10, 'ionian'), 'B♭ Major');
  assert.equal(T.keyLabel(6, 'ionian'), 'F♯ Major');
  assert.equal(T.keyLabel(2, 'dorian'), 'D Dorian');
  assert.equal(T.spell(10, 2, 'aeolian'), 'B♭'); // D minor has B♭
  assert.equal(T.spell(6, 9, 'dorian'), 'F♯');
});

test('color notes', () => {
  assert.equal(T.colorNote(9, 'dorian'), 6); // F♯, the bright 6th
  assert.equal(T.colorNote(0, 'lydian'), 6); // F♯, the ♯4
  assert.equal(T.colorNote(7, 'mixolydian'), 5); // F, the ♭7
});

test('patterns stay in the scale and inside the bar', () => {
  for (const m of T.MODE_IDS) for (const key of [0, 4, 9, 11]) {
    const chords = T.progression(key, m, 'journey');
    const sc = T.scale(key, m);
    for (const id of T.PATTERN_IDS) for (const chord of chords) for (let bar = 0; bar < 2; bar++) {
      const ev = T.patternBar(id, { chord, key, mode: m, bar, bars: 2 });
      for (const e of ev) {
        assert.ok(sc.includes(T.pc(e.note)), `${id} ${m} ${e.note} not in scale`);
        assert.ok(e.step >= 0 && e.step < 16, 'step in bar');
        assert.ok(e.len > 0, 'positive length');
        assert.ok(e.note >= 24 && e.note <= 96, `${id} note ${e.note} in range`);
        if (id !== 'hold') assert.ok(e.step + e.len <= 16, `${id} ends in its bar`);
      }
    }
  }
});

test('hold sounds once per chord, for the whole chord', () => {
  const chord = T.chordOn(0, 'ionian', 0);
  const first = T.patternBar('hold', { chord, key: 0, mode: 'ionian', bar: 0, bars: 4 });
  assert.ok(first.length >= 3);
  assert.ok(first.every((e) => e.len === 63));
  assert.equal(T.patternBar('hold', { chord, key: 0, mode: 'ionian', bar: 1, bars: 4 }).length, 0);
});

test('wander repeats its phrase every two bars', () => {
  const chord = T.chordOn(9, 'dorian', 0);
  const a = T.patternBar('wander', { chord, key: 9, mode: 'dorian', bar: 0, bars: 4, seed: 2 });
  const c = T.patternBar('wander', { chord, key: 9, mode: 'dorian', bar: 2, bars: 4, seed: 2 });
  assert.deepEqual(a, c);
  assert.ok(a.some((e) => e.step === 0), 'lands on the downbeat');
  // Downbeats are chord tones.
  for (const e of a.filter((x) => x.step % 8 === 0)) assert.ok(chord.pcs.includes(T.pc(e.note)));
});

test('grooves', () => {
  for (const g of T.GROOVE_IDS) for (const h of T.grooveBar(g)) assert.ok(h.step >= 0 && h.step < 16);
  assert.equal(T.grooveBar('off').length, 0);
});

test('drone notes for an instrument', () => {
  const am = T.chordOn(9, 'dorian', 0);
  assert.deepEqual(T.droneNotes(9, am, 'fifth'), [33, 40]);
  assert.deepEqual(T.droneNotes(9, am, 'root'), [33]);
  assert.deepEqual(T.droneNotes(9, am, 'chord'), [33, 40, 48]);
  const d = T.chordOn(9, 'dorian', 3);
  assert.deepEqual(T.droneNotes(9, d, 'fifth'), [38, 45]);
  const e = T.chordOn(9, 'dorian', 4);
  assert.ok(T.droneNotes(9, e, 'fifth')[0] < 38, 'the v drops an octave');
  // Under the part: a pulse or bass never shares the drone's notes.
  for (const c of T.progression(9, 'dorian', 'journey')) {
    const drone = new Set(T.droneNotes(9, c, 'fifth'));
    for (const id of ['pulse', 'bass', 'hold']) for (const ev of T.patternBar(id, { chord: c, key: 9, mode: 'dorian' })) assert.ok(!drone.has(ev.note), `${id} ${ev.note}`);
  }
});

const mod = (o = {}) => M.makeMod({ on: true, ...o });

test('every shape stays in -1..1 and is the same every time', () => {
  for (const shape of M.SHAPE_IDS) for (const rate of [0, 30, 100]) {
    const m = mod({ shape, rate, seed: 5 });
    let lo = 2; let hi = -2;
    for (let t = -30; t < 120; t += 0.07) {
      const v = M.value(m, t);
      assert.ok(v >= -1 && v <= 1, `${shape} ${v}`);
      assert.equal(v, M.value({ ...m }, t), 'deterministic');
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    assert.ok(hi - lo > 1, `${shape} at ${rate} moves (${lo}..${hi})`);
  }
});

test('shapes have the shape they are named for', () => {
  const hz = M.rateHz(30);
  const sine = mod({ shape: 'sine', seed: 3 });
  const cycle = 1 / hz;
  assert.ok(Math.abs(M.value(sine, 2) - M.value(sine, 2 + cycle)) < 1e-9, 'a sine repeats each cycle');
  const tri = mod({ shape: 'triangle', seed: 3 });
  assert.ok(Math.abs(M.value(tri, 2) - M.value(tri, 2 + cycle)) < 1e-9, 'so does a triangle');
  // Steps hold between moves; a walk never jumps.
  const steps = mod({ shape: 'steps', seed: 4, rate: 50 });
  let flat = 0; let n = 0;
  for (let t = 0; t < 200; t += 0.05) { n++; if (M.value(steps, t + 0.01) === M.value(steps, t)) flat++; }
  assert.ok(flat / n > 0.6, `steps hold their value (${flat}/${n})`);
  const walk = mod({ shape: 'walk', seed: 4, rate: 100 });
  for (let t = 0; t < 60; t += 0.01) assert.ok(Math.abs(M.value(walk, t + 0.01) - M.value(walk, t)) < 0.15, 'a walk is smooth');
});

test('seeds make different walks; the same seed the same walk', () => {
  const a = mod({ shape: 'walk', seed: 1 }); const b = mod({ shape: 'walk', seed: 2 });
  let same = 0;
  for (let t = 0; t < 60; t += 1) if (M.value(a, t) === M.value(b, t)) same++;
  assert.ok(same < 3);
});

test('rate runs from a slow drone to one cycle a second', () => {
  assert.ok(Math.abs(M.rateHz(0) - 0.02) < 1e-12);
  assert.ok(Math.abs(M.rateHz(100) - 1) < 1e-12);
  assert.equal(M.rateFor(M.rateHz(37)), 37);
});

test('a target moves around its resting value by its depth', () => {
  // Cutoff: depth 50 swings an octave either way, 100 two.
  assert.ok(Math.abs(M.place('cutoff', 1000, 0.5) - 2000) < 1e-9);
  assert.ok(Math.abs(M.place('cutoff', 1000, -1) - 250) < 1e-9);
  assert.equal(M.place('cutoff', 15000, 1), 20000, 'held inside the range');
  assert.equal(M.place('resonance', 40, 0.5), 65);
  assert.equal(M.place('resonance', 40, -1), 0);
  assert.equal(M.place('lfoSpeed', 50, 1), 99);
  assert.ok(M.norm('cutoff', 20) < 1e-9 && Math.abs(M.norm('cutoff', 20000) - 1) < 1e-9);
  assert.ok(Math.abs(M.norm('cutoff', Math.sqrt(20 * 20000)) - 0.5) < 1e-9, 'cutoff is on a log scale');
});

test('targets map onto the FM-1 CCs', () => {
  for (const id of M.TARGET_IDS) {
    const d = M.TARGETS[id];
    const lo = M.ccStep(id, d.min); const hi = M.ccStep(id, d.max);
    assert.ok(lo >= 0 && hi > lo, `${id} spans ${lo}..${hi}`);
    if (d.fx) assert.ok(hi === 100, `${id} is raw 0-100 on the effects channel`);
    else {
      assert.ok(VA_CC[d.key] !== undefined, `${id} has a CC`);
      assert.equal(hi, 127);
    }
  }
  assert.equal(M.ccStep('cutoff', 1000), ccValue('cutoff', 1000));
  assert.equal(M.ccStep('reverb', 55), 55);
});

test('resolve: only what is on, and modulators on one target add', () => {
  const base = (k) => ({ cutoff: 1000, resonance: 40, 'fx.reverb.mix': 50 })[k];
  const off = M.resolve([mod({ on: false }), mod({ depth: 0 })], base, 3);
  assert.deepEqual(off.entries, []);
  assert.deepEqual(off.values, {});
  const one = mod({ shape: 'sine', target: 'cutoff', depth: 50, seed: 1 });
  const r = M.resolve([one], base, 3);
  assert.equal(r.entries.length, 1);
  assert.equal(r.values.cutoff, r.entries[0].value);
  assert.ok(Math.abs(r.values.cutoff - 1000 * Math.pow(2, M.value(one, 3))) < 1e-6, 'depth 50 is an octave');
  const both = M.resolve([one, mod({ shape: 'sine', target: 'cutoff', depth: 50, seed: 1 })], base, 3);
  assert.ok(Math.abs(both.values.cutoff - 1000 * Math.pow(2, Math.max(-1, Math.min(1, 2 * M.value(one, 3) * 0.5)) * 2)) < 1e-6);
  const fx = M.resolve([mod({ target: 'reverb', depth: 100 })], base, 1);
  assert.ok(fx.values.reverb >= 0 && fx.values.reverb <= 100);
});

test('glow is nothing when nothing moves, and swings by depth', () => {
  assert.equal(M.glow([mod({ on: false })], 1), 0);
  assert.equal(M.glow([mod({ depth: 0 })], 1), 0);
  let lo = 2; let hi = -1;
  for (let t = 0; t < 50; t += 0.5) {
    const g = M.glow([mod({ depth: 40 })], t);
    lo = Math.min(lo, g); hi = Math.max(hi, g);
    assert.ok(g >= 0.3 - 1e-9 && g <= 0.7 + 1e-9, 'a depth of 40 swings 0.2 either way of half');
  }
  assert.ok(hi - lo > 0.3, 'and it does swing');
  const m = mod({ depth: 100, seed: 2 });
  assert.equal(M.glow([m], 5, 2), 0.5 + 0.5 * M.value(m, 3), 'lag looks back in time');
});

test('the old Movement setting becomes the first modulator', () => {
  const [a, b, c] = M.defaultMods(50);
  assert.deepEqual([a.on, a.shape, a.target, a.depth], [true, 'sine', 'cutoff', 25]);
  assert.ok(Math.abs(M.rateHz(a.rate) - 0.061) < 0.004);
  assert.ok(!b.on && !c.on);
  // At Movement m the cutoff swings m octaves either way, as it did.
  for (const m of [20, 50, 100]) {
    const x = M.defaultMods(m)[0];
    assert.ok(Math.abs(M.place('cutoff', 1000, x.depth / 100) - 1000 * Math.pow(2, m / 100)) < 1);
  }
  assert.equal(M.defaultMods(0)[0].on, false);
});

test('saved modulators are cleaned up', () => {
  assert.equal(M.cleanMods(undefined, 50).length, M.SLOTS);
  const list = M.cleanMods([{ on: 1, shape: 'zigzag', target: 'volume', rate: 900, depth: -5 }], 50);
  assert.equal(list.length, M.SLOTS);
  assert.deepEqual([list[0].on, list[0].shape, list[0].target, list[0].rate, list[0].depth], [true, 'sine', 'cutoff', 100, 0]);
  assert.ok(!list[1].on && !list[2].on);
});

// ---------- The USB connect check ----------
const facts = (attempt, more = {}) => ({
  midi: true, app: false, browser: 'Chrome 142 · Android 15', permission: 'granted',
  attempt: attempt && { at: Date.UTC(2026, 10, 1, 14, 3, 21), tries: 1, ...attempt },
  inputs: [], outputs: [], using: null, device: 'FM-1', sound: false, ...more,
});
const fm1Port = { name: 'FM-1', manufacturer: 'M-VAVE', state: 'connected' };

test('connect check: nothing to say before a try, and no MIDI says so', () => {
  assert.equal(C.explainConnect(facts(null)), null);
  const c = C.explainConnect(facts(null, { midi: false }));
  assert.equal(c.level, 'problem');
  assert.match(c.title, /no Web MIDI/);
});

test('connect check: waiting, then no answer', () => {
  assert.equal(C.explainConnect(facts({ state: 'waiting' })).level, 'wait');
  const c = C.explainConnect(facts({ state: 'waiting', slow: true }));
  assert.equal(c.level, 'problem');
  assert.match(c.title, /hasn’t answered/);
  assert.match(c.steps[1], /address bar/);
  assert.match(C.explainConnect(facts({ state: 'waiting', slow: true }, { app: true })).steps[1], /Chrome tab/);
});

test('connect check: Chrome’s init error, blocked, and anything else', () => {
  const init = C.explainConnect(facts({ state: 'failed', ms: 120, error: { name: 'UnknownError', message: 'Platform dependent initialization failed.' } }, { app: true }));
  assert.equal(init.level, 'problem');
  assert.match(init.title, /didn’t start/);
  assert.ok(init.steps.some((s) => /Unplug the FM-1/.test(s)));
  assert.match(init.details, /installed app/);
  assert.match(init.details, /Try 1: failed after 120 ms\n {2}UnknownError: Platform dependent initialization failed\./);
  const blocked = C.explainConnect(facts({ state: 'failed', error: { name: 'NotAllowedError', message: 'Permission denied' } }, { permission: 'denied' }));
  assert.match(blocked.title, /blocking MIDI/);
  assert.match(C.explainConnect(facts({ state: 'failed', error: { name: 'AbortError', message: 'x' } })).title, /AbortError/);
});

test('connect check: nothing plugged in, a port with another name, and connected', () => {
  const none = C.explainConnect(facts({ state: 'ok' }));
  assert.equal(none.level, 'problem');
  assert.match(none.title, /sees nothing plugged in/);
  assert.ok(none.steps.some((s) => /carries data/.test(s)));
  // A port that has gone away doesn't count as one Chrome sees.
  assert.match(C.explainConnect(facts({ state: 'ok' }, { outputs: [{ ...fm1Port, state: 'disconnected' }] })).title, /sees nothing/);
  const other = C.explainConnect(facts({ state: 'ok' }, { outputs: [{ name: 'USB MIDI Device', state: 'connected' }] }));
  assert.match(other.title, /a MIDI port, but none named FM-1/);
  assert.match(other.details, /Outputs:\n {2}USB MIDI Device\n/);
  const ok = C.explainConnect(facts({ state: 'ok', tries: 3 }, { outputs: [fm1Port], inputs: [fm1Port], using: 'FM-1' }));
  assert.equal(ok.level, 'ok');
  assert.match(ok.stamp, /^Try 3, /);
  assert.match(ok.details, /FM-1 \(M-VAVE\) ← in use/);
});

console.log(`\n${n} passed`);
