// Unit tests for the AKS Mini model's pure parts: CC values, how held keys
// are shared among the three VCOs, and the trapezoid envelope's timing.
//
//     node scripts/test_aks.mjs
//
// No dependencies; exits non-zero on the first failure.

import assert from 'node:assert/strict';
import {
  AKS_CC, AKS_PARAMS, AKS_DEFAULTS, AKS_GROUPS, MODE_BANDS, aksCcValue, bendBytes, pickNotes, allocate,
  trapezoidAt, trapezoidTimes, cycleLength, loops, vcaGain, offSec, attackSec, decaySec, onSec,
  pulseWidth, sawRise, detuneCents, cutoffHz, lfoHz, OFF_MANUAL,
} from '../site/assets/js/audio/aks-core.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (err) { console.error(`FAIL ${name}`); console.error(err); process.exit(1); }
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

// ---------- CC map ----------
test('every CC number is a valid controller, used once', () => {
  const nums = Object.values(AKS_CC);
  assert.equal(new Set(nums).size, nums.length);
  for (const n of nums) assert.ok(Number.isInteger(n) && n >= 0 && n <= 119);
});

test('every control has a definition, a default and a group', () => {
  const grouped = new Set(Object.values(AKS_GROUPS).flat());
  for (const k of Object.keys(AKS_PARAMS)) {
    assert.ok(k in AKS_DEFAULTS, `${k} has no default`);
    if (k !== 'pitchEg') assert.ok(grouped.has(k), `${k} is in no group`);
  }
  for (const k of Object.keys(AKS_CC)) if (k !== 'mod') assert.ok(AKS_PARAMS[k], `CC for unknown control ${k}`);
});

test('0–10 knobs span 0–127', () => {
  assert.equal(aksCcValue('cutoff', 0), 0);
  assert.equal(aksCcValue('cutoff', 10), 127);
  assert.equal(aksCcValue('cutoff', 5), 64);
  assert.equal(aksCcValue('attack', -3), 0);
  assert.equal(aksCcValue('attack', 12), 127);
});

test('controls with no CC give undefined', () => {
  for (const k of ['response', 'signal', 'reverb', 'lfoWave', 'slope', 'priority', 'trigger']) {
    assert.equal(aksCcValue(k, 5), undefined, k);
  }
});

test('Detune is centered at 64', () => {
  assert.equal(aksCcValue('detune', -5), 0);
  assert.equal(aksCcValue('detune', 0), 64);
  assert.equal(aksCcValue('detune', 5), 127);
});

test('voice modes land inside their bands', () => {
  for (const mode of ['poly', 'unison', 'octave', 'fifth']) {
    const v = aksCcValue('mode', mode);
    const [lo, hi] = MODE_BANDS[mode];
    assert.ok(v >= lo && v <= hi, `${mode} → ${v}`);
  }
  assert.equal(aksCcValue('mode', 'nonsense'), undefined);
});

test('octave maps onto the six footage steps, 8′ in the third', () => {
  const step = (v) => Math.floor(v / (128 / 6));
  assert.equal(step(aksCcValue('oct', -2)), 0); // 32′
  assert.equal(step(aksCcValue('oct', 0)), 2); // 8′
  assert.equal(step(aksCcValue('oct', 3)), 5); // 1′
  assert.equal(step(aksCcValue('oct', -3)), 0); // no step below 32′
});

test('mod wheel goes out as CC 1, 0–1 to 0–127', () => {
  assert.equal(AKS_CC.mod, 1);
  assert.equal(aksCcValue('mod', 0), 0);
  assert.equal(aksCcValue('mod', 1), 127);
});

test('pitch bend bytes', () => {
  assert.deepEqual(bendBytes(0), [0, 64]); // 8192
  assert.deepEqual(bendBytes(1), [127, 127]); // 16383
  assert.deepEqual(bendBytes(-1), [1, 0]); // 1
  assert.deepEqual(bendBytes(-5), [1, 0]);
});

// ---------- Voices ----------
test('note priority picks the last, lowest or highest keys', () => {
  const held = [60, 64, 48, 67, 55]; // in the order pressed
  assert.deepEqual(pickNotes(held, 'last', 3), [48, 67, 55]);
  assert.deepEqual(pickNotes(held, 'low', 3), [48, 55, 60]);
  assert.deepEqual(pickNotes(held, 'high', 3), [67, 64, 60]);
  assert.deepEqual(pickNotes([], 'last', 3), []);
});

test('poly: one key sounds on all three VCOs', () => {
  assert.deepEqual(allocate([60], 'poly'), [60, 60, 60]);
});

test('poly: two keys, the first is doubled', () => {
  assert.deepEqual(allocate([60, 64], 'poly'), [60, 64, 60]);
});

test('poly: three keys, one each, oldest on VCO 1', () => {
  assert.deepEqual(allocate([60, 64, 67], 'poly'), [60, 64, 67]);
});

test('poly: a fourth key drops one by priority', () => {
  assert.deepEqual(allocate([60, 64, 67, 71], 'poly', 'last'), [64, 67, 71]);
  assert.deepEqual(allocate([60, 64, 67, 48], 'poly', 'low'), [60, 64, 48]);
  assert.deepEqual(allocate([60, 64, 67, 48], 'poly', 'high'), [60, 64, 67]);
});

test('unison, octave and fifth follow the leading key', () => {
  assert.deepEqual(allocate([60, 55], 'unison', 'last'), [55, 55, 55]);
  assert.deepEqual(allocate([60, 55], 'unison', 'high'), [60, 60, 60]);
  assert.deepEqual(allocate([60], 'octave'), [60, 72, 60]);
  assert.deepEqual(allocate([60], 'fifth'), [60, 67, 60]);
});

test('no keys held: no new notes (the VCOs keep their last)', () => {
  assert.equal(allocate([], 'poly'), null);
  assert.equal(allocate([], 'unison'), null);
});

// ---------- Envelope ----------
test('time ranges match the guide', () => {
  near(attackSec(0), 0.003); near(attackSec(10), 1.5);
  near(onSec(0), 0); near(onSec(10), 2.5);
  near(decaySec(0), 0.001); near(decaySec(10), 15);
  near(lfoHz(0), 0.1); near(lfoHz(10), 30);
  near(cutoffHz(0), 20); near(cutoffHz(10), 16000, 1e-6);
});

test('Off loops up to 6 and waits past it', () => {
  assert.equal(OFF_MANUAL, 6);
  assert.ok(loops({ off: 6 }));
  assert.ok(!loops({ off: 6.1 }));
  near(offSec(0), 0.01);
  near(offSec(6), 5, 1e-9);
  assert.equal(offSec(7), Infinity);
});

test('trapezoid stages from silence', () => {
  const t = { a: 1, on: 2, d: 4 };
  assert.deepEqual(trapezoidAt(-0.1, t), { level: 0, stage: 'off' });
  assert.equal(trapezoidAt(0.5, t).stage, 'attack');
  near(trapezoidAt(0.5, t).level, 0.5);
  assert.deepEqual(trapezoidAt(1.5, t), { level: 1, stage: 'on' });
  assert.equal(trapezoidAt(5, t).stage, 'decay');
  near(trapezoidAt(5, t).level, 0.5);
  assert.deepEqual(trapezoidAt(7.5, t), { level: 0, stage: 'off' });
});

test('a retrigger part-way up only rises the rest of the way', () => {
  const t = { a: 1, on: 0, d: 1 };
  // From 0.5, the remaining half of Attack takes half the time.
  near(trapezoidAt(0, t, 0.5).level, 0.5);
  near(trapezoidAt(0.25, t, 0.5).level, 0.75);
  assert.equal(trapezoidAt(0.5, t, 0.5).stage, 'decay');
  near(cycleLength({ a: 1, on: 0, d: 1, off: 0.5 }, 0.5), 2);
});

test('zero-length stages don’t divide by zero', () => {
  const t = { a: 0, on: 0, d: 0 };
  assert.equal(trapezoidAt(0, t).stage, 'off');
  assert.ok(Number.isFinite(trapezoidAt(0, { a: 0, on: 1, d: 0 }).level));
});

test('trapezoidTimes reads the knobs', () => {
  const t = trapezoidTimes({ attack: 0, on: 10, decay: 10, off: 10 });
  near(t.a, 0.003); near(t.on, 2.5); near(t.d, 15);
  assert.equal(t.off, Infinity);
});

test('VCA: Trapez down is a drone at Signal, up follows the envelope', () => {
  near(vcaGain(0, { signal: 10, trapez: 0 }), 1);
  near(vcaGain(1, { signal: 10, trapez: 0 }), 1);
  near(vcaGain(0, { signal: 10, trapez: 10 }), 0);
  near(vcaGain(1, { signal: 10, trapez: 10 }), 1);
  near(vcaGain(0, { signal: 10, trapez: 5 }), 0.5);
  near(vcaGain(1, { signal: 0, trapez: 5 }), 0);
});

// ---------- Oscillators ----------
test('Shape: pulse width 10–90%, saw through triangle to ramp', () => {
  near(pulseWidth(0), 0.1); near(pulseWidth(5), 0.5); near(pulseWidth(10), 0.9);
  near(sawRise(0), 0.98); near(sawRise(5), 0.5); near(sawRise(10), 0.02);
});

test('Detune: up to a whole tone', () => {
  near(detuneCents(5), 200); near(detuneCents(-5), -200); near(detuneCents(0), 0);
});

console.log(`\n${passed} tests passed`);
