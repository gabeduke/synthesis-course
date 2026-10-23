// Every control in the course, in one place: its range, its signal color, how
// to read its value, and where the same setting lives on the FM-1. The "where"
// paths are in FM-1 names; ui/device.js translates them for other devices.

import { attackTime, decayTime, releaseTime, lfoHz, filterDecayTime } from '../audio/va-synth.js';
import { vaCc, fxCc } from '../hw/fm1.js';

const sec = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(s < 10 ? 2 : 1)} s`);
const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${f < 10 ? f.toFixed(2) : Math.round(f)} Hz`);

export const PARAMS = {
  waveform: { label: 'Waveform', type: 'choice', options: ['sine', 'saw', 'tri', 'square'], names: ['Sine', 'Saw', 'Tri', 'Square'], kind: 'sound', where: 'EDIT › Oscillator › Waveform (or turn ALGORITHM on HOME)' },
  super: { label: 'Super', min: 0, max: 100, kind: 'sound', where: 'EDIT › Oscillator › Super' },
  detune: { label: 'Detune', min: 0, max: 100, kind: 'sound', where: 'EDIT › Oscillator › Detune' },
  drift: { label: 'Drift', min: 0, max: 100, kind: 'sound', where: 'EDIT › Oscillator › Drift' },
  sub: { label: 'Sub', min: 0, max: 100, kind: 'sound', where: 'EDIT › Oscillator › Sub' },
  noise: { label: 'Noise', min: 0, max: 100, kind: 'sound', where: 'EDIT › Oscillator › Noise' },
  pwm: { label: 'PWM', min: 0, max: 100, kind: 'move', where: 'EDIT › Oscillator › PWM (Square only)' },

  filterType: { label: 'Filter type', type: 'choice', options: ['lp12', 'lp24', 'bp', 'hp'], names: ['LP12', 'LP24', 'BP', 'HP'], kind: 'sound', where: 'EDIT › Filter › Type' },
  cutoff: { label: 'Cutoff', type: 'log', min: 20, max: 20000, kind: 'sound', format: hz, where: 'EDIT › Filter › Cutoff (KNOB1 on a new VA preset)' },
  resonance: { label: 'Resonance', min: 0, max: 100, kind: 'sound', where: 'EDIT › Filter › Resonance (KNOB2 on a new VA preset)' },
  filterEnv: { label: 'Filter envelope', min: 0, max: 100, kind: 'time', where: 'EDIT › Filter › Envelope (KNOB3 on a new VA preset)' },
  filterDecay: { label: 'Filter decay', min: 0, max: 100, kind: 'time', format: (v) => sec(filterDecayTime(v)), where: 'EDIT › Filter › Decay (KNOB4 on a new VA preset)' },
  filterVelocity: { label: 'Filter velocity', min: 0, max: 100, kind: 'sound', where: 'EDIT › Filter › Velocity' },
  keyTrack: { label: 'Key tracking', type: 'choice', options: [0, 33, 67, 100], names: ['0', '33', '67', '100'], kind: 'sound', where: 'EDIT › Filter › Key Tracking' },
  lfoToCutoff: { label: 'LFO to cutoff', min: 0, max: 100, kind: 'move', where: 'EDIT › Filter › LFO to Cutoff' },

  attack: { label: 'Attack', min: 0, max: 100, kind: 'time', format: (v) => sec(attackTime(v)), where: 'ENV › Attack (hold ENV to switch the envelope on)' },
  decay: { label: 'Decay', min: 0, max: 100, kind: 'time', format: (v) => sec(decayTime(v)), where: 'ENV › Decay' },
  sustain: { label: 'Sustain', min: 0, max: 100, kind: 'time', format: (v) => `${Math.round(v)}%`, where: 'ENV › Sustain' },
  release: { label: 'Release', min: 0, max: 100, kind: 'time', format: (v) => sec(releaseTime(v)), where: 'ENV › Release' },

  lfoWave: { label: 'LFO wave', type: 'choice', options: ['triangle', 'sine', 'square', 'saw up', 'saw down', 's&h'], names: ['Tri', 'Sine', 'Square', 'Saw up', 'Saw down', 'S&H'], kind: 'move', where: 'LFO › Wave' },
  lfoSpeed: { label: 'LFO speed', min: 0, max: 99, kind: 'move', format: (v) => hz(lfoHz(v)), where: 'LFO › Speed' },
  lfoPitch: { label: 'Pitch depth', min: 0, max: 99, kind: 'move', where: 'LFO › Pitch Mod Depth' },
  lfoAmp: { label: 'Amp depth', min: 0, max: 99, kind: 'move', where: 'LFO › Amp Mod Depth' },
  lfoDelay: { label: 'LFO delay', min: 0, max: 99, kind: 'move', where: 'LFO › Delay' },

  mono: { label: 'Mono', type: 'bool', kind: 'sound', where: 'EDIT › Mono' },
  glide: { label: 'Glide', min: 0, max: 100, kind: 'time', where: 'GLO › Glide › Glide Time (Mono presets)' },
  level: { label: 'Level', min: 0, max: 99, kind: 'sound', where: 'EDIT › Level' },

  'fx.distortion.on': { label: 'Distortion', type: 'bool', kind: 'space', where: 'FX › Distortion' },
  'fx.distortion.type': { label: 'Type', type: 'choice', options: ['soft', 'hard', 'fold'], names: ['Soft', 'Hard', 'Fold'], kind: 'space', where: 'FX › Distortion › Distortion Type' },
  'fx.distortion.gain': { label: 'Gain', min: 0, max: 100, kind: 'space', where: 'FX › Distortion › Gain' },
  'fx.distortion.tone': { label: 'Tone', min: 0, max: 100, kind: 'space', where: 'FX › Distortion › Tone' },
  'fx.distortion.level': { label: 'Level', min: 0, max: 100, kind: 'space', where: 'FX › Distortion › Level' },
  'fx.chorus.on': { label: 'Chorus', type: 'bool', kind: 'space', where: 'FX › Chorus' },
  'fx.chorus.rate': { label: 'Rate', min: 0, max: 100, kind: 'space', format: (v) => `${(0.1 + v / 100 * 0.9).toFixed(2)} Hz`, where: 'FX › Chorus › Rate' },
  'fx.chorus.depth': { label: 'Depth', min: 0, max: 100, kind: 'space', where: 'FX › Chorus › Depth' },
  'fx.chorus.mix': { label: 'Mix', min: 0, max: 100, kind: 'space', where: 'FX › Chorus › Mix' },
  'fx.delay.on': { label: 'Delay', type: 'bool', kind: 'space', where: 'FX › Delay' },
  'fx.delay.rate': { label: 'Rate', min: 0, max: 100, kind: 'space', format: (v) => sec(0.8 - v / 100 * 0.7), where: 'FX › Delay › Rate (higher is a shorter gap)' },
  'fx.delay.feedback': { label: 'Feedback', min: 0, max: 100, kind: 'space', where: 'FX › Delay › Feedback' },
  'fx.delay.mix': { label: 'Mix', min: 0, max: 100, kind: 'space', where: 'FX › Delay › Mix' },
  'fx.reverb.on': { label: 'Reverb', type: 'bool', kind: 'space', where: 'FX › Reverb' },
  'fx.reverb.type': { label: 'Type', type: 'choice', options: ['room', 'hall', 'plate'], names: ['Room', 'Hall', 'Plate'], kind: 'space', where: 'FX › Reverb › Reverb Type' },
  'fx.reverb.decay': { label: 'Decay', min: 0, max: 100, kind: 'space', where: 'FX › Reverb › Decay' },
  'fx.reverb.mix': { label: 'Mix', min: 0, max: 100, kind: 'space', where: 'FX › Reverb › Mix' },
};

// Which CC (if any) carries a setting to the selected device, for the status line.
export function ccFor(key) {
  if (key.startsWith('fx.')) {
    const [, effect, field] = key.split('.');
    const n = fxCc(effect, field);
    return n === undefined ? null : `CC ${n} on the FX channel`;
  }
  const n = vaCc(key);
  return n === undefined ? null : `CC ${n}`;
}

// Read and write nested params like "fx.reverb.mix".
export function getParam(params, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), params);
}

export function toPartial(key, value) {
  const parts = key.split('.');
  const out = {};
  let o = out;
  parts.forEach((k, i) => { if (i === parts.length - 1) o[k] = value; else o = o[k] = {}; });
  return out;
}

export function formatValue(key, value) {
  const def = PARAMS[key];
  if (!def) return String(value);
  if (def.type === 'choice') return def.names[def.options.indexOf(value)] ?? String(value);
  if (def.type === 'bool') return value ? 'On' : 'Off';
  if (def.format) return def.format(value);
  return String(Math.round(value));
}

// Named groups, so panels can lay controls out the way the FM-1 does.
export const GROUPS = {
  Oscillator: ['waveform', 'super', 'detune', 'drift', 'sub', 'noise', 'pwm'],
  Filter: ['filterType', 'cutoff', 'resonance', 'filterEnv', 'filterDecay', 'filterVelocity', 'keyTrack', 'lfoToCutoff'],
  Envelope: ['attack', 'decay', 'sustain', 'release'],
  LFO: ['lfoWave', 'lfoSpeed', 'lfoPitch', 'lfoAmp', 'lfoDelay'],
  Voice: ['mono', 'glide', 'level'],
  Distortion: ['fx.distortion.on', 'fx.distortion.type', 'fx.distortion.gain', 'fx.distortion.tone', 'fx.distortion.level'],
  Chorus: ['fx.chorus.on', 'fx.chorus.rate', 'fx.chorus.depth', 'fx.chorus.mix'],
  Delay: ['fx.delay.on', 'fx.delay.rate', 'fx.delay.feedback', 'fx.delay.mix'],
  Reverb: ['fx.reverb.on', 'fx.reverb.type', 'fx.reverb.decay', 'fx.reverb.mix'],
};

export function groupOf(key) {
  return Object.keys(GROUPS).find((g) => GROUPS[g].includes(key)) || 'Other';
}
