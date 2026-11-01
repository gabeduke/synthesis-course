// The course outline. Order here is the order of the rail and the pager.
export const LESSONS = [
  { n: 0, file: 'lessons/00-start.html', title: 'Start here', blurb: 'What you need, how the lessons work, and connecting an FM-1 or SMK-37 if you have one.' },
  { n: 1, file: 'lessons/01-sound.html', title: 'Sound you can see', blurb: 'Pitch, loudness and tone, and why every sound is a stack of simple waves.' },
  { n: 2, file: 'lessons/02-oscillators.html', title: 'Oscillators', blurb: 'The four classic waveforms, plus sub, noise and pulse width.' },
  { n: 3, file: 'lessons/03-filters.html', title: 'Filters', blurb: 'Carving a bright wave into a darker, rounder or thinner one.' },
  { n: 4, file: 'lessons/04-envelopes.html', title: 'Envelopes', blurb: 'How a note starts, holds and fades: plucks, pads and swells.' },
  { n: 5, file: 'lessons/05-lfo.html', title: 'LFOs and modulation', blurb: 'Slow waves that move other controls for you: vibrato, tremolo, wobble.' },
  { n: 6, file: 'lessons/06-unison.html', title: 'Super, Detune and Drift', blurb: 'One note, seven voices. Beating, width, and the trance supersaw.' },
  { n: 7, file: 'lessons/07-space.html', title: 'Space: chorus, delay, reverb', blurb: 'Is a detuned stack a reverb? Pitch tricks versus time tricks.' },
  { n: 8, file: 'lessons/08-fm.html', title: 'FM synthesis', blurb: 'Wobbling a wave so fast it becomes tone. The FM-1’s home engine.' },
  { n: 9, file: 'lessons/09-8bit.html', title: '8-Bit: the chiptune engine', blurb: 'Pulse waves, stepped triangles, noise drums and the console arpeggio trick.' },
  { n: 10, file: 'lessons/10-recipes.html', title: 'Five patches to build', blurb: 'Pad, supersaw lead, acid bass, pluck and drone, with exact settings.' },
  { n: 11, file: 'lessons/11-live.html', title: 'Playing it live', blurb: 'Knob banks, macros, and getting your left hand free for the knobs.' },
  { n: 12, file: 'lessons/12-drones.html', title: 'Drones', blurb: 'Hold a note, keep it moving, fill the room. Long envelopes, slow LFOs, latching and feeding other gear.' },
  { n: 13, part: 'AKS Mini', file: 'lessons/13-aks-mini.html', title: 'The AKS Mini', blurb: 'Behringer’s small analog synth in the EMS tradition: what it kept, what it left out, and playing it over MIDI.' },
  { n: 14, part: 'AKS Mini', file: 'lessons/14-aks-oscillators.html', title: 'Three VCOs, one filter', blurb: 'Saw, square and Shape; Detune and voice modes; paraphony; the EMS-style filter and its Response.' },
  { n: 15, part: 'AKS Mini', file: 'lessons/15-aks-trapezoid.html', title: 'The trapezoid and the joystick', blurb: 'An envelope made of times, not stages; looping it; Trapez against Signal; two hands on one stick.' },
];

// Lessons with a `part` belong to a track after the main course. The rail and
// the home page put this heading before the first lesson of each part.
export const PARTS = {
  'AKS Mini': { blurb: 'A short track for the Behringer AKS Mini, an analog synth descended from EMS’s VCS3 and Synthi AKS. Play it on the page, or on the real one over MIDI, with any of the keyboards above.' },
};

export const EXTRAS = [
  { file: 'history.html', title: 'A short history of synthesis' },
];
