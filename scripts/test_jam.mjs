// Tests for the Jam page's music theory: node scripts/test_jam.mjs
import assert from 'node:assert/strict';
import * as T from '../site/assets/js/audio/theory.js';

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

console.log(`\n${n} passed`);
