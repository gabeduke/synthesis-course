// Standard MIDI Files for the Jam page: the part it plays, written out so it
// can go into an instrument's sequencer (Baud Girl's Device Manager has a
// MIDI Files section), a groovebox or a DAW. Pure functions, tested in Node.
//
// Baud Girl's sequencer patterns are up to 64 steps (four bars of
// sixteenths), so a loop longer than that is split into patterns of four
// bars to chain on the instrument. A note that crosses from one pattern into
// the next is cut at the line and struck again at the start of the next, so
// each pattern stands on its own.

import { patternBar, STEPS_PER_BAR } from './theory.js';

export const PATTERN_STEPS = 64;
export const PPQ = 96;
const TICKS_PER_STEP = PPQ / 4;

// Every note of one pass through the progression, as { step, note, len, vel }
// with step counted from the start of the loop.
export function loopEvents({ chords, barsPer, pattern, key, mode, octave = 0, voicing = 'fifth', seed = 1 }) {
  const out = [];
  chords.forEach((chord, ci) => {
    for (let b = 0; b < barsPer; b++) {
      const bar = ci * barsPer + b;
      for (const e of patternBar(pattern, { chord, key, mode, octave, bar: b, bars: barsPer, seed, voicing })) {
        out.push({ ...e, step: bar * STEPS_PER_BAR + e.step });
      }
    }
  });
  return { events: out, steps: chords.length * barsPer * STEPS_PER_BAR };
}

// Cut a loop into patterns of at most `size` steps.
export function splitPatterns({ events, steps }, size = PATTERN_STEPS) {
  const count = Math.max(1, Math.ceil(steps / size));
  const parts = Array.from({ length: count }, (_, i) => ({
    index: i,
    start: i * size,
    steps: Math.min(size, steps - i * size),
    events: [],
  }));
  for (const e of events) {
    let at = e.step;
    let left = Math.min(e.len, steps - e.step);
    while (left > 0) {
      const p = parts[Math.floor(at / size)];
      const local = at - p.start;
      const len = Math.min(left, p.steps - local);
      p.events.push({ step: local, note: e.note, len, vel: e.vel });
      at += len;
      left -= len;
    }
  }
  for (const p of parts) p.events.sort((a, b) => a.step - b.step || a.note - b.note);
  return parts;
}

// A format 0 MIDI file: tempo, 4/4, a name, then the notes on one channel,
// ending exactly at the pattern's length so it loops cleanly.
export function writeSmf({ events, steps, bpm = 120, name = 'Jam', channel = 1 }) {
  const ch = (Math.max(1, Math.min(16, channel)) - 1) & 15;
  const msgs = [];
  for (const e of events) {
    const on = Math.round(e.step * TICKS_PER_STEP);
    // A hair short of the full length, so a note doesn't touch its neighbour.
    const off = Math.max(on + 1, Math.round((e.step + e.len) * TICKS_PER_STEP) - 1);
    const vel = Math.max(1, Math.min(127, Math.round(e.vel * 127)));
    msgs.push({ t: on, order: 1, bytes: [0x90 | ch, e.note & 127, vel] });
    msgs.push({ t: off, order: 0, bytes: [0x80 | ch, e.note & 127, 0] });
  }
  // Note-offs before note-ons at the same tick, so a repeated note re-strikes.
  msgs.sort((a, b) => a.t - b.t || a.order - b.order);

  const track = [];
  const text = (type, s) => {
    const b = [...new TextEncoder().encode(s)];
    return [0x00, 0xff, type, ...vlq(b.length), ...b];
  };
  track.push(...text(0x03, name));
  const us = Math.round(60000000 / bpm);
  track.push(0x00, 0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255);
  track.push(0x00, 0xff, 0x58, 0x04, 4, 2, 24, 8);
  let last = 0;
  for (const m of msgs) {
    track.push(...vlq(m.t - last), ...m.bytes);
    last = m.t;
  }
  const end = steps * TICKS_PER_STEP;
  track.push(...vlq(Math.max(0, end - last)), 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255];
  const len = track.length;
  return new Uint8Array([...header, 0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...track]);
}

// MIDI's variable-length numbers: seven bits a byte, high bit = more.
export function vlq(n) {
  const out = [n & 0x7f];
  n >>>= 7;
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  return out;
}

// Read one back, for the tests: the notes as { tick, note, on } and the end.
export function readSmf(bytes) {
  let i = 14 + 8;
  const notes = [];
  let t = 0;
  let tempo;
  const readVlq = () => { let v = 0; let b; do { b = bytes[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  while (i < bytes.length) {
    t += readVlq();
    const s = bytes[i++];
    if (s === 0xff) {
      const type = bytes[i++];
      const len = readVlq();
      if (type === 0x51) tempo = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      i += len;
      if (type === 0x2f) return { notes, end: t, tempo };
    } else {
      const note = bytes[i++];
      const vel = bytes[i++];
      notes.push({ tick: t, note, on: (s & 0xf0) === 0x90 && vel > 0, channel: (s & 15) + 1 });
    }
  }
  return { notes, end: t, tempo };
}
