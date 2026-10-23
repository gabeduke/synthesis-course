// The Behringer AKS Mini, as numbers: its controls, their ranges, how held
// keys are shared among its three oscillators, the trapezoid envelope's
// timing, and the MIDI CC numbers that reach it. Pure functions only, so
// Node can test them (scripts/test_aks.mjs); the sound is in aks-synth.js.
//
// Sources. Behringer has published only a Quick Start Guide for the AKS Mini,
// marked "V 0.0" (cdn-media.empowertribe.com, QSG_BE_0722-AAY_AKS-MINI.pdf).
// Its control ranges and CC chart are used here as given, but it is a draft:
// its spec sheet calls the envelope an "ADSR", it lists the same key for both
// joystick axes, and its Voice Mode CC bands overlap. Everything below that
// rests only on that guide is provisional until checked on a real unit.
//
// The panel's knobs are drawn 0–10, as EMS marked theirs. Where the guide
// gives a range (Attack 3 ms–1.5 s, On 0–2.5 s, Decay 1 ms–15 s, LFO
// 0.1–30 Hz, Detune ±1 tone) the knob spans it; the curve between the ends
// isn't documented, so times and rates are spread exponentially.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const exp = (v, min, max) => min * Math.pow(max / min, clamp(v, 0, 10) / 10);

const sec = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(s < 10 ? 2 : 1)} s`);
const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${f < 10 ? f.toFixed(2) : Math.round(f)} Hz`);
const knob = (v) => (Math.round(v * 10) / 10).toFixed(1);

// ---------- Ranges ----------
export const cutoffHz = (v) => exp(v, 20, 16000);
export const lfoHz = (v) => exp(v, 0.1, 30);
export const attackSec = (v) => exp(v, 0.003, 1.5);
export const onSec = (v) => (clamp(v, 0, 10) / 10) * 2.5;
export const decaySec = (v) => exp(v, 0.001, 15);
// OFF from 0 to 6 sets the gap before the envelope fires again by itself; past
// 6 it waits to be fired. The guide gives no times for OFF, so the page uses
// the original Synthi's 10 ms to 5 s across that part of the knob.
export const OFF_MANUAL = 6;
export const offSec = (v) => (v > OFF_MANUAL ? Infinity : 0.01 * Math.pow(500, clamp(v, 0, OFF_MANUAL) / OFF_MANUAL));
// DETUNE moves VCO 2 up and VCO 3 down, up to a whole tone each.
export const detuneCents = (v) => (clamp(v, -5, 5) / 5) * 200;

export const AKS_DEFAULTS = {
  saw: 8, square: 0, shape: 0, detune: 0, oct: 0,
  mode: 'poly', priority: 'last',
  cutoff: 7, response: 2, egInt: 0, slope: '24',
  lfoWave: 'sine', lfoRate: 5, lfoPitch: 0, lfoCutoff: 0,
  attack: 1, on: 3, decay: 5, off: 10, trapez: 10, trigger: 'multi', pitchEg: 0,
  signal: 7, reverb: 0,
};

// Each control: its label, range and color (kind), how its value reads, and
// where it sits on the AKS Mini. `cc` is filled in from AKS_CC below.
export const AKS_PARAMS = {
  saw: { label: 'Saw', min: 0, max: 10, step: 0.1, kind: 'sound', format: knob, where: 'VCO › SAW' },
  square: { label: 'Square', min: 0, max: 10, step: 0.1, kind: 'sound', format: knob, where: 'VCO › SQUARE' },
  shape: { label: 'Shape', min: 0, max: 10, step: 0.1, kind: 'sound', format: (v) => `${knob(v)} · ${Math.round(pulseWidth(v) * 100)}% pulse`, where: 'VCO › SHAPE' },
  detune: { label: 'Detune', min: -5, max: 5, step: 0.1, kind: 'sound', format: (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.round(Math.abs(detuneCents(v)))} cents`, where: 'VCO › DETUNE' },
  oct: { label: 'Octave', type: 'choice', options: [-3, -2, -1, 0, 1, 2, 3], names: ['−3', '−2', '−1', '0', '+1', '+2', '+3'], kind: 'sound', where: 'OCT − and OCT +' },
  mode: { label: 'Voice mode', type: 'choice', options: ['poly', 'unison', 'octave', 'fifth'], names: ['Poly', 'Unison', 'Octave', 'Fifth'], kind: 'sound', where: 'Voice mode (CC 40; the guide doesn’t say where it is on the panel)' },
  priority: { label: 'Note priority', type: 'choice', options: ['last', 'low', 'high'], names: ['Last', 'Low', 'High'], kind: 'sound', where: 'Power-up menu: hold FUNC while switching on' },

  cutoff: { label: 'Frequency', min: 0, max: 10, step: 0.1, kind: 'sound', format: (v) => `${knob(v)} · ${hz(cutoffHz(v))}`, where: 'VCF › FREQUENCY' },
  response: { label: 'Response', min: 0, max: 10, step: 0.1, kind: 'sound', format: knob, where: 'VCF › RESPONSE (no CC)' },
  egInt: { label: 'EG int', min: 0, max: 10, step: 0.1, kind: 'time', format: knob, where: 'VCF › EG INT' },
  slope: { label: 'Slope', type: 'choice', options: ['12', '24'], names: ['12 dB', '24 dB'], kind: 'sound', where: 'Not documented: the spec sheet lists 12 and 24 dB but not how to choose' },

  lfoWave: { label: 'LFO wave', type: 'choice', options: ['sine', 'saw', 'square', 'random'], names: ['Sine', 'Saw', 'Square', 'Random'], kind: 'move', where: 'FUNC + a white key (no CC)' },
  lfoRate: { label: 'LFO rate', min: 0, max: 10, step: 0.1, kind: 'move', format: (v) => `${knob(v)} · ${hz(lfoHz(v))}`, where: 'LFO › RATE' },
  lfoPitch: { label: 'Pitch int', min: 0, max: 10, step: 0.1, kind: 'move', format: knob, where: 'LFO › PITCH INT' },
  lfoCutoff: { label: 'Cutoff int', min: 0, max: 10, step: 0.1, kind: 'move', format: knob, where: 'LFO › CUTOFF INT' },

  attack: { label: 'Attack', min: 0, max: 10, step: 0.1, kind: 'time', format: (v) => `${knob(v)} · ${sec(attackSec(v))}`, where: 'ENVELOPE › ATTACK' },
  on: { label: 'On', min: 0, max: 10, step: 0.1, kind: 'time', format: (v) => `${knob(v)} · ${sec(onSec(v))}`, where: 'ENVELOPE › ON' },
  decay: { label: 'Decay', min: 0, max: 10, step: 0.1, kind: 'time', format: (v) => `${knob(v)} · ${sec(decaySec(v))}`, where: 'ENVELOPE › DECAY' },
  off: { label: 'Off', min: 0, max: 10, step: 0.1, kind: 'time', format: (v) => (v > OFF_MANUAL ? `${knob(v)} · fires on keys` : `${knob(v)} · loops, ${sec(offSec(v))} gap`), where: 'ENVELOPE › OFF (0–6 loops by itself)' },
  trapez: { label: 'Trapez', min: 0, max: 10, step: 0.1, kind: 'time', format: knob, where: 'ENVELOPE › TRAPEZ' },
  trigger: { label: 'Retrigger', type: 'choice', options: ['multi', 'single'], names: ['Every key', 'First key'], kind: 'time', where: 'Power-up menu: multi-trigger or retrigger' },
  pitchEg: { label: 'EG to pitch', min: 0, max: 10, step: 0.1, kind: 'time', format: knob, where: 'CC 43 (VCO EG Mod) only, in the guide' },

  signal: { label: 'Signal', min: 0, max: 10, step: 0.1, kind: 'sound', format: knob, where: 'SIGNAL (no CC)' },
  reverb: { label: 'Reverb', min: 0, max: 10, step: 0.1, kind: 'space', format: knob, where: 'REVERB (no CC)' },
};

export const AKS_GROUPS = {
  VCO: ['saw', 'square', 'shape', 'detune', 'oct'],
  Voices: ['mode', 'priority'],
  VCF: ['cutoff', 'response', 'egInt', 'slope'],
  LFO: ['lfoWave', 'lfoRate', 'lfoPitch', 'lfoCutoff'],
  Envelope: ['attack', 'on', 'decay', 'off', 'trapez', 'trigger'],
  Output: ['signal', 'reverb'],
};

// SHAPE: the square's pulse width (10% to 90%), and the saw's rise as a share
// of each cycle (all rise: a saw; half: a triangle; none: a falling ramp).
// The guide says SHAPE "sets pulse width from 10% to 90% and reverses saw into
// ramp"; that it passes through a triangle on the way is the page's reading.
export const pulseWidth = (v) => 0.1 + (clamp(v, 0, 10) / 10) * 0.8;
export const sawRise = (v) => clamp(1 - clamp(v, 0, 10) / 10, 0.02, 0.98);

// ---------- MIDI ----------
// The guide's CC chart (QSG V 0.0). No CC is listed for RESPONSE, SIGNAL,
// reverb, the LFO's wave or tempo. Behringer's product page promises
// "NRPN/CC control of all parameters" but publishes no NRPN numbers.
export const AKS_CC = {
  mod: 1,
  trapez: 32, square: 33, saw: 34, shape: 35,
  off: 39, mode: 40, oct: 41, detune: 42, pitchEg: 43,
  cutoff: 44, egInt: 45,
  lfoRate: 46, lfoPitch: 47, lfoCutoff: 48,
  attack: 49, decay: 50,
  on: 51, // the guide says "EG Sustain"; the panel has no sustain, so ON is the likely meaning
};

// Voice Mode bands from the guide's CC 40 chart. Its last two overlap at 112
// (a typo); the page sends the middle of each band, which stays clear of it.
export const MODE_BANDS = {
  poly: [0, 12], unison: [13, 37], octave: [38, 62], fifth: [63, 87],
  unisonRing: [88, 111], polyRing: [113, 127],
};

// CC 41 "Scale" has six steps, 32′ to 1′. The panel's OCT reaches three
// octaves each way; −3 has no step on the chart, so it sends 32′.
const SCALE_STEPS = 6;

// One control's value as the CC value the AKS Mini expects (0–127), or
// undefined when it has no CC.
export function aksCcValue(key, value) {
  if (!Object.hasOwn(AKS_CC, key)) return undefined;
  switch (key) {
    case 'mod': return Math.round(clamp(value, 0, 1) * 127);
    case 'mode': {
      const b = MODE_BANDS[value];
      return b ? Math.round((b[0] + b[1]) / 2) : undefined;
    }
    case 'oct': {
      const step = clamp(Math.round(value) + 2, 0, SCALE_STEPS - 1); // 8′ (0) is step 2
      return Math.round((step + 0.5) * (128 / SCALE_STEPS));
    }
    case 'detune': return Math.round(((clamp(value, -5, 5) + 5) / 10) * 127);
    default: return Math.round((clamp(value, 0, 10) / 10) * 127);
  }
}

// Pitch bend, −1 to 1, as the two data bytes of a MIDI pitch-bend message.
export function bendBytes(x) {
  const v = clamp(Math.round(8192 + clamp(x, -1, 1) * 8191), 0, 16383);
  return [v & 127, v >> 7];
}

// ---------- Voices ----------
// The AKS Mini has three VCOs but one filter and one envelope: it is
// paraphonic. In Poly mode the keys you hold share out the three VCOs; the
// envelope and filter are shared by all of them. Note priority decides which
// keys win when you hold more than three, and which one leads in the
// one-note modes.
export const VCOS = 3;

// Up to `count` of the held keys (in the order they went down), by priority.
export function pickNotes(held, priority = 'last', count = VCOS) {
  if (!held.length) return [];
  if (priority === 'low') return [...held].sort((a, b) => a - b).slice(0, count);
  if (priority === 'high') return [...held].sort((a, b) => b - a).slice(0, count);
  return held.slice(-count);
}

// The note each VCO plays for the held keys, or null when no key is held (the
// VCOs then keep their last pitch, as analog oscillators do).
//   poly    one held key per VCO; with fewer keys than VCOs the keys are
//           doubled, so one key still sounds all three (the page's choice;
//           check on your unit)
//   unison  all three on the leading key
//   octave  the leading key, an octave above it, and the key again
//   fifth   the leading key, a fifth above it, and the key again
// The guide names Octave and Fifth but doesn't say which VCO moves; this is
// the page's reading. Its two ring-modulation modes aren't modelled.
export function allocate(held, mode = 'poly', priority = 'last') {
  if (!held.length) return null;
  if (mode === 'poly') {
    const notes = pickNotes(held, priority, VCOS);
    // Keep the keys in the order they went down, so VCO 1 holds the oldest.
    const ordered = held.filter((n) => notes.includes(n));
    return Array.from({ length: VCOS }, (_, i) => ordered[i % ordered.length]);
  }
  const [n] = pickNotes(held, priority, 1);
  if (mode === 'octave') return [n, n + 12, n];
  if (mode === 'fifth') return [n, n + 7, n];
  return [n, n, n];
}

// ---------- Trapezoid envelope ----------
// The EMS envelope shaper isn't an ADSR. It rises over Attack, stays up for
// On, falls over Decay, then waits for Off before it can start again. Every
// stage is a time: nothing waits for you to let go of a key. With Off between
// 0 and 6 it fires again by itself, so it loops; past 6 it waits for a key
// (or the joystick's button).

export function trapezoidTimes(p) {
  return { a: attackSec(p.attack), on: onSec(p.on), d: decaySec(p.decay), off: offSec(p.off) };
}

export const loops = (p) => p.off <= OFF_MANUAL;

// Level (0–1) and stage `dt` seconds into a cycle that started at level
// `from`. A cycle fired mid-way up starts its Attack from where it is, so
// Attack takes only the remaining share of its time.
export function trapezoidAt(dt, { a, on, d }, from = 0) {
  const start = clamp(from, 0, 1);
  const rise = a * (1 - start);
  if (dt < 0) return { level: start, stage: 'off' };
  if (dt < rise) return { level: start + (1 - start) * (dt / Math.max(rise, 1e-6)), stage: 'attack' };
  if (dt < rise + on) return { level: 1, stage: 'on' };
  if (dt < rise + on + d) return { level: 1 - (dt - rise - on) / Math.max(d, 1e-6), stage: 'decay' };
  return { level: 0, stage: 'off' };
}

// Seconds from the start of one cycle to the start of the next, when looping.
export function cycleLength({ a, on, d, off }, from = 0) {
  return a * (1 - clamp(from, 0, 1)) + on + d + off;
}

// How loud the VCA is let through (0–1) for an envelope level: SIGNAL sets the
// most it can open, TRAPEZ how much of that the envelope controls. With
// TRAPEZ at 0 the sound runs at SIGNAL all the time, a drone.
export function vcaGain(level, p) {
  const signal = Math.pow(clamp(p.signal, 0, 10) / 10, 2);
  const depth = clamp(p.trapez, 0, 10) / 10;
  return signal * (1 - depth + depth * clamp(level, 0, 1));
}
