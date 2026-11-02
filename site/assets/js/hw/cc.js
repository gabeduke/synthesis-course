// What the FM-1 takes over MIDI: Baud Girl's CC numbers for the preset and the
// effects, and the conversion from a course parameter to a CC value. Pure data
// and arithmetic, so the tests and the modulation module can use it in Node.
// (Which numbers a given device really uses is hw/fm1.js's vaCc and fxCc.)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Preset settings, sent on the FM-1's MIDI channel. Values 0–127 cover each
// setting's whole range; lists split 0–127 into equal bands.
export const VA_CC = {
  waveform: 24, super: 25, detune: 26, drift: 27, sub: 28, noise: 29, pwm: 30,
  filterType: 31, cutoff: 74, resonance: 71,
  filterEnv: 52, filterDecay: 53, filterShape: 54, filterVelocity: 55, keyTrack: 56, lfoToCutoff: 57,
  attack: 73, decay: 75, sustain: 70, release: 72,
  lfoSpeed: 76, lfoPitch: 77, lfoDelay: 78,
};

// Effects, sent on the FX channel (default 2). These take raw values, 0–100,
// not 0–127.
export const FX_CC = {
  reverb: { on: 4, type: 5, decay: 6, mix: 7 },
  delay: { on: 8, feedback: 9, rate: 10, mix: 11 },
  distortion: { on: 12, gain: 13, tone: 14, level: 15 },
  chorus: { on: 16, rate: 17, depth: 18, mix: 19 },
};
export const REVERB_TYPES = ['room', 'hall', 'plate'];

const band = (index, count) => Math.round((index + 0.5) * (128 / count));
const pct = (v, max = 100) => Math.round(clamp(v, 0, max) / max * 127);

// Convert one course parameter into the CC value the FM-1 expects.
export function ccValue(key, value) {
  switch (key) {
    case 'waveform': return band(['sine', 'saw', 'tri', 'square'].indexOf(value), 4);
    case 'filterType': return band(['lp12', 'lp24', 'bp', 'hp'].indexOf(value), 4);
    // Cutoff spans 20 Hz–20 kHz on the FM-1. The CC curve isn't documented;
    // a logarithmic spread is the closest match to how cutoff is heard.
    case 'cutoff': return Math.round(Math.log(clamp(value, 20, 20000) / 20) / Math.log(1000) * 127);
    case 'lfoSpeed': case 'lfoPitch': case 'lfoDelay': return pct(value, 99);
    default: return pct(value, 100);
  }
}
