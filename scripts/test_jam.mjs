// Tests for the Jam page's music theory: node scripts/test_jam.mjs
import assert from 'node:assert/strict';
import * as T from '../site/assets/js/audio/theory.js';
import { loopEvents, splitPatterns, writeSmf, readSmf, vlq } from '../site/assets/js/audio/smf.js';

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

test('variable-length numbers', () => {
  assert.deepEqual(vlq(0), [0]);
  assert.deepEqual(vlq(127), [0x7f]);
  assert.deepEqual(vlq(128), [0x81, 0x00]);
  assert.deepEqual(vlq(1536), [0x8c, 0x00]);
});

const loopFor = (prog, barsPer, pattern) => loopEvents({ chords: T.progression(9, 'dorian', prog), barsPer, pattern, key: 9, mode: 'dorian' });

test('a short loop is one pattern', () => {
  const parts = splitPatterns(loopFor('vamp', 2, 'pulse'));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].steps, 64);
  assert.equal(parts[0].events.length, 32); // 8 eighths x 4 bars
});

test('a long loop splits into 64-step patterns, re-striking held notes', () => {
  // Four chords of four bars, held: 16 bars, four patterns.
  const loop = loopFor('journey', 4, 'hold');
  assert.equal(loop.steps, 256);
  const parts = splitPatterns(loop);
  assert.equal(parts.length, 4);
  for (const p of parts) {
    assert.equal(p.steps, 64);
    assert.ok(p.events.every((e) => e.step + e.len <= 64), 'inside the pattern');
    assert.ok(p.events.some((e) => e.step === 0), 'something sounds at the start');
  }
  // Eight bars a chord: the second pattern re-strikes the first chord.
  const long = splitPatterns(loopFor('vamp', 8, 'hold'));
  assert.equal(long.length, 4);
  assert.deepEqual(long[1].events.map((e) => e.note), long[0].events.map((e) => e.note));
  const total = (ps) => ps.reduce((n, p) => n + p.events.reduce((m, e) => m + e.len, 0), 0);
  assert.equal(total(long), loop.events.length ? total(splitPatterns(loopFor('vamp', 8, 'hold'), 1e9)) : 0, 'no length lost');
});

test('one bar, odd sizes', () => {
  const parts = splitPatterns(loopFor('pedal', 1, 'arp'));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].steps, 16);
});

test('MIDI file round trip', () => {
  const [p] = splitPatterns(loopFor('vamp', 2, 'bass'));
  const bytes = writeSmf({ events: p.events, steps: p.steps, bpm: 84, name: 'A Dorian Bass', channel: 1 });
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  assert.equal(bytes[9], 0, 'format 0');
  const r = readSmf(bytes);
  assert.equal(r.end, 64 * 24, 'ends at the pattern length');
  assert.equal(Math.round(60000000 / r.tempo), 84);
  const ons = r.notes.filter((x) => x.on);
  assert.equal(ons.length, p.events.length);
  assert.deepEqual(ons.map((x) => x.tick), p.events.map((e) => e.step * 24));
  assert.ok(r.notes.every((x) => x.channel === 1));
  // Every note-on has a later note-off.
  const open = new Map();
  for (const x of r.notes) {
    if (x.on) open.set(x.note, (open.get(x.note) || 0) + 1);
    else open.set(x.note, open.get(x.note) - 1);
  }
  assert.ok([...open.values()].every((v) => v === 0), 'balanced');
});

test('drone notes for an instrument', () => {
  const am = T.chordOn(9, 'dorian', 0);
  assert.deepEqual(T.droneNotes(9, am, 'fifth'), [45, 52, 57]);
  assert.deepEqual(T.droneNotes(9, am, 'root'), [45, 57]);
  assert.deepEqual(T.droneNotes(9, am, 'chord'), [45, 52, 57, 60]);
  const d = T.chordOn(9, 'dorian', 3);
  assert.deepEqual(T.droneNotes(9, d, 'fifth'), [50, 57, 62]); // A stays common
  const e = T.chordOn(9, 'dorian', 4);
  assert.ok(T.droneNotes(9, e, 'fifth')[0] < 50, 'the v drops an octave');
});

console.log(`\n${n} passed`);
