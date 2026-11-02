// Music theory for the Jam page, as pure functions so they can be tested in
// Node: keys and modes, the chords a mode gives you, the progressions the
// page cycles through, and the bar-by-bar patterns sent to an instrument.
//
// Notes are MIDI numbers; pitch classes are 0–11 with C = 0. A bar is 16
// steps of a sixteenth note each.

export const STEPS_PER_BAR = 16;

const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

// The keys as a guitarist reads them: B♭ and E♭ rather than A♯ and D♯.
export const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// Ordered from brightest to darkest, the way the modes are usually taught.
export const MODES = {
  lydian: { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11], color: 3, feel: 'Bright and floating. The raised 4th never quite lands.' },
  ionian: { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11], color: 2, feel: 'Plain and settled: the major scale.' },
  mixolydian: { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10], color: 6, feel: 'Major with a flat 7th. Bluesy, rock, open-string guitar.' },
  dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10], color: 5, feel: 'Minor with a bright 6th. Cool rather than sad.' },
  aeolian: { name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10], color: 5, feel: 'The natural minor scale. Sad, serious, cinematic.' },
  phrygian: { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10], color: 1, feel: 'Dark, with a flat 2nd right next to the root. Flamenco and metal.' },
};
export const MODE_IDS = Object.keys(MODES);

// Where each mode sits inside a major scale, to choose sharps or flats.
const MODE_OFFSET = { ionian: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, aeolian: 9 };
const FLAT_MAJORS = new Set([5, 10, 3, 8, 1]); // F, B♭, E♭, A♭, D♭

export const pc = (n) => ((n % 12) + 12) % 12;

// Spell a pitch class the way this key would: flats in flat keys.
export function spell(pitchClass, root = 0, mode = 'ionian') {
  const major = pc(root - (MODE_OFFSET[mode] ?? 0));
  return (FLAT_MAJORS.has(major) ? FLATS : SHARPS)[pc(pitchClass)];
}

export function keyLabel(root, mode) {
  return `${spell(root, root, mode)} ${MODES[mode]?.name ?? mode}`;
}

// The scale's pitch classes, starting on the root.
export function scale(root, mode) {
  return MODES[mode].steps.map((s) => pc(root + s));
}

// The chord on one degree of the scale (0 = the root's chord), stacked in
// thirds from the scale's own notes. Returns intervals above the chord's
// root, its pitch classes, and its name.
export function chordOn(root, mode, degree, { seventh = false } = {}) {
  const steps = MODES[mode].steps;
  const at = (k) => {
    const i = degree + k;
    return steps[i % 7] + 12 * Math.floor(i / 7);
  };
  const base = at(0);
  const intervals = [0, at(2) - base, at(4) - base];
  if (seventh) intervals.push(at(6) - base);
  const chordRoot = pc(root + base);
  const third = intervals[1]; const fifth = intervals[2];
  let quality = third === 4 ? (fifth === 8 ? '+' : '') : (fifth === 6 ? '°' : 'm');
  if (seventh) {
    const sev = intervals[3];
    if (quality === '') quality = sev === 11 ? 'maj7' : '7';
    else if (quality === 'm') quality = sev === 11 ? 'm(maj7)' : 'm7';
    else if (quality === '°') quality = sev === 10 ? 'm7♭5' : '°7';
  }
  return {
    degree,
    root: chordRoot,
    offset: base, // semitones above the key's root
    intervals,
    pcs: intervals.map((i) => pc(chordRoot + i)),
    name: `${spell(chordRoot, root, mode)}${quality}`,
    numeral: numeral(degree, third === 4, quality === '°' || quality === 'm7♭5', mode),
  };
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const MAJOR = MODES.ionian.steps;
function numeral(degree, major, dim, mode) {
  const diff = MODES[mode].steps[degree] - MAJOR[degree];
  const acc = diff < 0 ? '♭' : diff > 0 ? '♯' : '';
  const r = ROMAN[degree];
  return `${acc}${major ? r : r.toLowerCase()}${dim ? '°' : ''}`;
}

// Chord changes for each mode, as scale degrees. "Pedal" never moves, "Vamp"
// rocks between two chords that show the mode off, "Journey" takes four.
export const PROGRESSIONS = {
  pedal: { name: 'Pedal', by: () => [0] },
  vamp: {
    name: 'Vamp',
    by: (mode) => ({ ionian: [0, 3], aeolian: [0, 6], dorian: [0, 3], mixolydian: [0, 6], lydian: [0, 1], phrygian: [0, 1] })[mode],
  },
  journey: {
    name: 'Journey',
    by: (mode) => ({
      ionian: [0, 4, 5, 3], aeolian: [0, 5, 2, 6], dorian: [0, 2, 3, 0],
      mixolydian: [0, 6, 3, 0], lydian: [0, 1, 4, 1], phrygian: [0, 1, 6, 1],
    })[mode],
  },
};
export const PROGRESSION_IDS = Object.keys(PROGRESSIONS);

export function progression(root, mode, id, opts) {
  return PROGRESSIONS[id].by(mode).map((d) => chordOn(root, mode, d, opts));
}

// The mode's "color" note: the one degree that sets it apart from its
// neighbours (Dorian's 6th, Lydian's ♯4…). The drone leans on it.
export function colorNote(root, mode) {
  return pc(root + MODES[mode].steps[MODES[mode].color]);
}

// A small seeded random generator, so a pattern repeats itself where it
// should (a phrase played twice) instead of changing every bar.
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// The lowest note of the instrument's part: the key's root near C3, moved by
// whole octaves. Roots above F♯ drop an octave so every key sits alike.
export function baseNote(root, octave = 0) {
  return 48 + pc(root) - (pc(root) > 6 ? 12 : 0) + 12 * octave;
}

// What the instrument plays, one bar at a time. Each event is
// { step, note, len, vel } with step and len in sixteenths.
export const PATTERNS = {
  hold: { name: 'Hold', blurb: 'The chord, held until it changes. Lets the instrument be the drone.' },
  pulse: { name: 'Pulse', blurb: 'The root on every eighth note. A heartbeat to lock onto.' },
  bass: { name: 'Bass', blurb: 'Root, fifth and octave in a loose groove.' },
  arp: { name: 'Arp', blurb: 'The chord broken up and down, an eighth note at a time.' },
  wander: { name: 'Wander', blurb: 'A sparse melody in the scale that repeats every two bars. Answer it.' },
};
export const PATTERN_IDS = Object.keys(PATTERNS);

export function patternBar(id, { chord, key, mode, octave = 0, bar = 0, bars = 1, seed = 1, voicing = 'chord' }) {
  const low = baseNote(key, octave) + chord.offset - (chord.offset >= 7 ? 12 : 0);
  const tones = voicing === 'fifth'
    ? [low, low + 7, low + 12]
    : chord.intervals.map((i) => low + i);
  const ev = (step, note, len, vel = 0.8) => ({ step, note, len, vel });
  switch (id) {
    case 'hold': {
      if (bar !== 0) return [];
      // Leave the last sixteenth free so the next chord re-strikes cleanly.
      const len = bars * STEPS_PER_BAR - 1;
      const notes = voicing === 'fifth' ? tones : [low, low + chord.intervals[2], low + 12, low + 12 + chord.intervals[1]];
      return notes.map((n) => ev(0, n, len, 0.7));
    }
    case 'pulse':
      return Array.from({ length: 8 }, (_, i) => ev(i * 2, low, 1.5, i % 2 ? 0.55 : 0.8));
    case 'bass': {
      const f = low + chord.intervals[2];
      const o = low + 12;
      const last = bar === bars - 1;
      return [ev(0, low, 3, 0.9), ev(3, low, 2, 0.6), ev(6, f, 2, 0.7), ev(8, o, 2, 0.75),
        ev(10, low, 2, 0.6), ev(12, last ? f : low, 2, 0.75), ev(14, last ? o : f, 2, 0.6)];
    }
    case 'arp': {
      const up = [...tones, ...tones.map((n) => n + 12)].slice(0, 6);
      const seq = [...up, ...up.slice(1, -1).reverse()];
      return Array.from({ length: 8 }, (_, i) => ev(i * 2, seq[(bar * 8 + i) % seq.length], 1.8, i % 4 === 0 ? 0.85 : 0.65));
    }
    case 'wander': {
      // Two bars of phrase, then the same two again, for each chord.
      const r = rng(seed * 7919 + chord.degree * 131 + (bar % 2) * 17);
      const sc = scale(key, mode);
      const top = low + 12;
      // Notes of the scale across two octaves above the chord's root.
      const pool = [];
      for (let n = top; n <= top + 19; n++) if (sc.includes(pc(n))) pool.push(n);
      const chordTones = new Set(chord.pcs);
      let i = Math.floor(pool.length * 0.3);
      const out = [];
      const slots = [0, 3, 6, 8, 10, 12, 14];
      for (const s of slots) {
        const strong = s % 8 === 0;
        if (!strong && r() < 0.45) continue;
        i = Math.max(0, Math.min(pool.length - 1, i + Math.round((r() - 0.5) * 4)));
        // Land on a chord tone on the strong beats.
        if (strong) {
          let j = i;
          for (let d = 0; d < pool.length; d++) {
            const a = i + d; const b = i - d;
            if (a < pool.length && chordTones.has(pc(pool[a]))) { j = a; break; }
            if (b >= 0 && chordTones.has(pc(pool[b]))) { j = b; break; }
          }
          i = j;
        }
        out.push(ev(s, pool[i], strong ? 3 : 2, strong ? 0.8 : 0.6));
      }
      // Trim each note so it ends before the next one starts.
      for (let k = 0; k < out.length - 1; k++) out[k].len = Math.min(out[k].len, out[k + 1].step - out[k].step);
      return out;
    }
    default: return [];
  }
}

// Drum hits for the page's quiet percussion, one bar at a time.
// Each is { step, drum: 'kick' | 'shaker' | 'rim', vel }.
export const GROOVES = {
  off: { name: 'Off' },
  heart: { name: 'Heartbeat' },
  pulse: { name: 'Pulse' },
  half: { name: 'Half time' },
};
export const GROOVE_IDS = Object.keys(GROOVES);

export function grooveBar(id) {
  const h = (step, drum, vel) => ({ step, drum, vel });
  switch (id) {
    case 'heart': return [h(0, 'kick', 0.8), h(3, 'kick', 0.45), h(8, 'kick', 0.7), h(11, 'kick', 0.4)];
    case 'pulse': return [0, 4, 8, 12].map((s) => h(s, 'kick', 0.65)).concat([2, 6, 10, 14].map((s) => h(s, 'shaker', 0.6)));
    case 'half': return [h(0, 'kick', 0.85), h(10, 'kick', 0.55), h(8, 'rim', 0.6)]
      .concat(Array.from({ length: 16 }, (_, i) => h(i, 'shaker', i % 4 === 2 ? 0.55 : i % 2 ? 0.22 : 0.32)));
    default: return [];
  }
}

// Standard tuning, low string first, as MIDI notes.
export const GUITAR_TUNING = [40, 45, 50, 55, 59, 64];

// The drone's held notes for one chord, for an instrument to play. They sit
// an octave under the part (moved by `octave` with it), so the two rarely
// share a note: the chord's root, then its fifth, then for 'chord' its third
// an octave up. Chords on the 5th degree and up drop an octave so the bass
// stays near the key's root.
export function droneNotes(key, chord, voicing = 'fifth', octave = 0) {
  const r = baseNote(key, octave) - 12 + chord.offset - (chord.offset >= 7 ? 12 : 0);
  const third = chord.intervals[1];
  const fifth = chord.intervals[2];
  if (voicing === 'root') return [r];
  if (voicing === 'chord') return [r, r + fifth, r + 12 + third];
  return [r, r + fifth];
}
