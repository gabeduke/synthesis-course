// Modulators for the Jam page, as data and pure functions (no browser, so they
// are tested in Node): a modulator is { on, shape, target, rate, depth, seed }.
// value() gives its shape at a time, resolve() turns a few of them into the
// parameter values to send, and the drawing reads the very same functions, so
// what is drawn is what is sent. Time is in seconds on one clock (the page's).
//
// Everything is a function of time and the seed, never of a running state, so
// any moment can be asked for: the past and the future of a trace, a moment
// a little earlier (for a note further along the neck), or the same run again.

import { ccValue } from '../hw/cc.js';

export const SHAPES = {
  sine: { name: 'Sine' },
  triangle: { name: 'Tri' },
  walk: { name: 'Drift' },
  steps: { name: 'Steps' },
};
export const SHAPE_IDS = Object.keys(SHAPES);

// What a modulator can move. `span` is how far depth 100 reaches: octaves
// either way for a log target (cutoff), otherwise half the range either way
// (so 100 sweeps the whole range from the middle). `fx` targets go on the
// effects channel as raw 0–100; the rest are the preset's.
export const TARGETS = {
  cutoff: { label: 'Cutoff', key: 'cutoff', min: 20, max: 20000, log: true, span: 2 },
  resonance: { label: 'Resonance', key: 'resonance', min: 0, max: 100 },
  super: { label: 'Super', key: 'super', min: 0, max: 100 },
  detune: { label: 'Detune', key: 'detune', min: 0, max: 100 },
  drift: { label: 'Drift', key: 'drift', min: 0, max: 100 },
  lfoSpeed: { label: 'LFO speed', key: 'lfoSpeed', min: 0, max: 99 },
  reverb: { label: 'Reverb mix', key: 'fx.reverb.mix', min: 0, max: 100, fx: ['reverb', 'mix'] },
  delay: { label: 'Delay mix', key: 'fx.delay.mix', min: 0, max: 100, fx: ['delay', 'mix'] },
};
export const TARGET_IDS = Object.keys(TARGETS);

export const SLOTS = 3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Rate is a 0–100 slider: 0.02 Hz (a cycle every 50 s) to 1 Hz, spread evenly
// in pitch, since a drone is moved slowly and most of the slider should be slow.
export const rateHz = (rate) => 0.02 * Math.pow(50, clamp(rate, 0, 100) / 100);
export const rateFor = (hz) => clamp(Math.round(100 * Math.log(hz / 0.02) / Math.log(50)), 0, 100);

export function makeMod(partial = {}, seed = 1) {
  const m = { on: false, shape: 'sine', target: 'cutoff', rate: 30, depth: 40, seed, ...partial };
  if (!SHAPES[m.shape]) m.shape = 'sine';
  if (!TARGETS[m.target]) m.target = 'cutoff';
  m.rate = clamp(+m.rate || 0, 0, 100);
  m.depth = clamp(+m.depth || 0, 0, 100);
  m.seed = Math.trunc(+m.seed) || seed;
  m.on = !!m.on;
  return m;
}

// The modulators a page starts with. The first is what "Movement" used to do
// to the instrument's cutoff (a sine, one cycle every ~16 s, Movement/2 as its
// depth, which is Movement octaves either way), so older settings sound the
// same. The others wait, off, with different shapes ready.
export function defaultMods(movement = 50) {
  const m = clamp(+movement || 0, 0, 100);
  return [
    makeMod({ on: m > 0, shape: 'sine', target: 'cutoff', rate: rateFor(0.061), depth: Math.round(m / 2) }, 1),
    makeMod({ shape: 'walk', target: 'resonance', rate: 20, depth: 35 }, 2),
    makeMod({ shape: 'steps', target: 'detune', rate: 35, depth: 40 }, 3),
  ];
}

// Saved settings back into modulators: unknown values fall back, and the list
// is always SLOTS long.
export function cleanMods(list, movement) {
  if (!Array.isArray(list)) return defaultMods(movement);
  const fresh = defaultMods(0);
  return Array.from({ length: SLOTS }, (_, i) => makeMod(list[i] ?? { ...fresh[i], on: false }, i + 1));
}

// ---------- Shapes ----------
// A deterministic number in [0, 1) for a seed and an integer.
function rnd(seed, k) {
  let h = Math.imul(k | 0, 0x9e3779b1) ^ Math.imul((seed | 0) + 0x7f4a7c15, 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const ease = (x) => { const u = clamp(x, 0, 1); return u * u * (3 - 2 * u); };
const frac = (x) => x - Math.floor(x);

// Smooth noise: random values at whole numbers, eased between.
function noise(seed, x) {
  const k = Math.floor(x);
  const a = rnd(seed, k) * 2 - 1;
  const b = rnd(seed, k + 1) * 2 - 1;
  return a + (b - a) * ease(x - k);
}

// The shape at time t, from -1 to 1.
export function value(mod, t) {
  const p = t * rateHz(mod.rate) + rnd(mod.seed, 9999);
  switch (mod.shape) {
    case 'triangle': return 4 * Math.abs(frac(p - 0.25) - 0.5) - 1;
    case 'walk': return clamp(1.25 * (0.75 * noise(mod.seed, p) + 0.25 * noise(mod.seed + 7, p * 2.3)), -1, 1);
    case 'steps': {
      // Four levels a cycle, five heights, with a short glide from one to the next.
      const s = p * 4;
      const k = Math.floor(s);
      const level = (n) => Math.round(rnd(mod.seed, n) * 4) / 2 - 1;
      const a = level(k - 1);
      return a + (level(k) - a) * ease((s - k) / 0.15);
    }
    default: return Math.sin(2 * Math.PI * p);
  }
}

// ---------- Targets ----------
// Where a modulator puts a parameter: `amount` (-1 to 1, a shape's value times
// its depth) either side of `base`, held inside the parameter's range.
export function place(target, base, amount) {
  const d = TARGETS[target];
  if (d.log) return clamp(base * Math.pow(2, amount * d.span), d.min, d.max);
  return clamp(base + amount * (d.max - d.min) / 2, d.min, d.max);
}

// A parameter's place in its range, 0 to 1 (on the log scale for cutoff).
export function norm(target, v) {
  const d = TARGETS[target];
  const x = clamp(v, d.min, d.max);
  return d.log ? Math.log(x / d.min) / Math.log(d.max / d.min) : (x - d.min) / (d.max - d.min);
}

// The CC value that goes out for it: the preset's CC 0–127, or the effects
// channel's raw 0–100 (see hw/fm1.js sendParam and sendFx).
export function ccStep(target, v) {
  const d = TARGETS[target];
  return d.fx ? Math.round(clamp(v, 0, 100)) : ccValue(d.key, v);
}

// The modulators at time t. `base(key)` gives each target's resting value (the
// panel's). Returns one entry per modulator that is on, { slot, shape: -1..1,
// amount, target, value }, where value is that modulator alone; and `values`,
// the final value of each moved target (modulators on the same target add).
export function resolve(mods, base, t) {
  const entries = [];
  const sum = {};
  mods.forEach((m, slot) => {
    if (!m.on || m.depth <= 0) return;
    const shape = value(m, t);
    const amount = shape * m.depth / 100;
    sum[m.target] = (sum[m.target] || 0) + amount;
    entries.push({ slot, shape, amount, target: m.target, value: place(m.target, base(TARGETS[m.target].key), amount) });
  });
  const values = {};
  for (const target of Object.keys(sum)) values[target] = place(target, base(TARGETS[target].key), clamp(sum[target], -1, 1));
  return { entries, values };
}

// How bright something that glows with the modulation should be, 0 to 1: it
// follows the strongest modulator that is on, resting at half and swinging
// either way by its depth (a shallow one breathes a little, a deep one fades
// right out and back). Nothing on is nothing: 0. `lag` looks back in time,
// so a ripple can run across what it lights.
export function glow(mods, t, lag = 0) {
  let g = 0;
  for (const m of mods) if (m.on && m.depth > 0) g = Math.max(g, 0.5 + 0.5 * value(m, t - lag) * (m.depth / 100));
  return g;
}
