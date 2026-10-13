// The "Super" model: seven oscillators per note, spread by "Detune".
//
// The curves follow Adam Szabo's measurements of the Roland JP-8000 Super Saw
// ("How to Emulate the Super Saw", KTH, 2010). Baud Girl says the FM-1+VA Super
// is modeled on that same '90s synth, so this is a close cousin of what the
// hardware does, not a bit-exact copy of it.

// Relative frequency offset of each of the seven oscillators at full detune.
export const OFFSETS = [-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242];
export const CENTER = 3;

const DETUNE_POLY = [
  10028.7312891634, -50818.8652045924, 111363.4808729368, -138150.6761080548,
  106649.6679158292, -53046.9642751875, 17019.9518580080, -3425.0836591318,
  404.2703938388, -24.1878824391, 0.6717417634, 0.0030115596,
];

// Detune knob (0–1) to detune amount (0–1). Gentle for most of the range,
// then steep near the top, as on the original.
export function detuneCurve(x) {
  if (x <= 0) return 0;
  let y = 0;
  for (let i = 0; i < DETUNE_POLY.length; i++) y += DETUNE_POLY[i] * Math.pow(x, 11 - i);
  return Math.max(0, y);
}

// Super knob (0–1) to the levels of the centre oscillator and each side oscillator.
// At Super 0 the side copies are silent, so Detune alone does nothing audible.
export function mixLevels(x) {
  if (x <= 0) return { center: 1, side: 0 };
  return {
    center: -0.55366 * x + 0.99785,
    side: -0.73764 * x * x + 1.2841 * x + 0.044372,
  };
}

// Frequency ratio of oscillator i for a given detune knob value (0–100).
export function ratioFor(i, detune) {
  return 1 + OFFSETS[i] * detuneCurve(detune / 100);
}

// Overall gain so the patch doesn't jump in volume as Super rises.
//
// With Detune at 0 the copies start in step and stay in step, so they add up
// by amplitude: normalizing by the plain sum keeps the sound identical to one
// oscillator. That matches the FM-1+VA, where Super without Detune does
// nothing audible. Once the copies are detuned they drift in and out of step
// and add up roughly by power instead, so the normalization blends across.
export function normalize(center, side, detune = 100) {
  const amp = center + 6 * side;
  const power = Math.sqrt(center * center + 6 * side * side);
  const b = Math.min(1, Math.max(0, detune / 15));
  return (1 - b) / (amp || 1) + b / (power || 1);
}
