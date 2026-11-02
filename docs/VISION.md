# Jam: where this is going

Jam started as a page in the Signal Path course: pick a key and mode, press
Play, and a drone drifts through a few chords while you play guitar over it.
This file records what it is meant to become, so that it can be split out into
its own project when it's ready. It is a direction, not a spec; the staging at
the end says what is real, what is next and what is only an idea.

## The end goal

A drone-and-modulation instrument for practicing improvisation.

- **A phone runs the show.** Plug it into a synth (FM-1, SMK-37) and the synth
  makes the sound: the drone, a part over it, and a slowly changing sound.
- **Modulation is the second instrument.** Shapes you choose (a sine, a slow
  random walk, steps) move the synth's parameters over MIDI CC, so the drone
  keeps changing without you touching it. You can make it weird on purpose.
- **The guitar neck shows what is going on.** The current chord and scale are
  drawn on a fretboard, and so is the modulation: lines that fade in and out
  between note sets, patterns that cycle gently between notes, driven by the
  same shapes that move the sound. Seeing how note sets relate to each other
  is how you learn to move between scales.
- **Eventually it plays by itself.** With no phone or app connected, a small
  always-on device holds the drone, the modulation and the visuals, and you
  just pick up the guitar.

## What the app is for (and what it isn't)

It is for practicing along to something alive. It is not a sequencer editor, a
patch librarian or a course. Anything that doesn't serve the practice session
stays out. The sequencer export was removed for this reason: it was never
tried on the hardware, and an untested feature in the UI costs more than it
gives.

## Principles

1. **Only ship what has been tried on the hardware.** Say "untested" in the
   code and the docs, and keep it out of the interface until it isn't.
2. **One clock.** The sound, the MIDI modulation and the drawing all follow
   the same timeline, so what you see is what you hear.
3. **Modulation is data, not code.** A shape, a target parameter, a rate and a
   depth. The same description drives the MIDI, the drawing and, later, a
   device with no phone.
4. **Phone first.** One hand, a guitar in the other. The chord, Play and the
   sound presets are always in reach.
5. **Never write to the synth's unsaved preset unasked.** CC messages change
   it. The page says when it is sending them.

## Stages

1. **Modulation over MIDI, with visuals (built, not yet heard on the hardware).** Assign shapes to the CCs the
   FM-1 already takes (cutoff, resonance, detune, drift, LFO, effects). Draw
   each shape live, in the style of the course's LFO and envelope lessons, and
   draw its effect on the neck. Works with the hardware as it is today.
2. **Neck visuals.** Linked note sets, fading lines, cycling patterns,
   randomized or algorithmic, locked to the same clock.
3. **Its own project.** Split out of the course: its own repository, a small
   core (theory, drone engine, modulation, drawing) with the hardware link and
   the screen as separate pieces behind clear interfaces.
4. **Standalone.** A small computer with a screen (a Raspberry Pi is the cheap
   way to try it) runs the same core without a phone. Whether it needs its own
   firmware depends on stage 5.
5. **Own firmware, maybe.** Only if the unit must play it alone. This depends
   on whether the FM-1's firmware is open to change, which is not known. Find
   out before planning it.

## Open questions

- Does Jam move into Woodshed (`~/repos/song-course`) or become its own
  project? Asked 2026-11-01: not yet. Work stays in this repo until decided.
- Can the FM-1's sequencer record CC automation, and does the Device Manager
  import CC events from a MIDI file? Not known. Test with an empty pattern slot
  before building anything on it.
- Is Baud Girl's firmware source-available? Is the hardware documented enough
  to write firmware for?
- Which modulation shapes feel good on a drone? Needs your ears, not a spec.
- Does the Android PWA connect over USB? A report from the phone says the
  Connect buttons do nothing; desktop Chrome connects fine. Not yet reproduced
  (see STATE.md).
