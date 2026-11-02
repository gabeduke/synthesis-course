# User flows

How Gabe uses Jam, written as stories. This is the goal a change is checked
against: a change that passes `node scripts/test_jam.mjs` and breaks a flow is
not done. The format follows Woodshed's `docs/flows.md` in the `song-course`
repo, so these can move there, or into a shared runner, without a rewrite.
Whether Jam's flows live here or in Woodshed is not decided.

## Status

- `core`: built, with a runnable check; a failure is a regression.
- `todo`: agreed, not built. No check exists yet, so it proves nothing.
- `rig`: needs the real instrument, the phone or ears. Checked by hand and
  noted with the date. A `rig` flow is never reported as passing by a script.

No flow here is `core` yet: Jam has unit tests for its music theory and
modulation (`scripts/test_jam.mjs`), but no flow runner. Writing it is the
first job (see Next).

## Who and where

- **Main device: an Android phone in Chrome**, by touch, with an M-VAVE FM-1
  beside it (battery-powered, USB-C). The laptop is where code gets written.
- **Where it is used:** sitting down with a guitar. A campfire, an arm of a
  chair. The phone and the synth are set down and left running; the hands are
  on the guitar. It has to keep working untouched for a long stretch, on
  batteries, outdoors.
- The synth makes the sound; the phone runs the clock, the modulation and the
  screen.

## The flows

| Id | Story: as Gabe I want to… | Flow | Status |
|---|---|---|---|
| F1.1 | pick a key and mode, press Play, and hear a drone move through chords in that key; the chord and where I am in it show large on the screen | `f1.1-play-drone` | todo |
| F1.2 | change key, mode, chords or bars per chord while it plays and have the next bar follow, with no stop | `f1.2-change-while-playing` | todo |
| F1.3 | choose a sound with one tap (Pad, Swell, Glass, Organ, Dark, Pluck) and hear the instrument change | `f1.3-sound-presets` | todo (sends CCs; the presets are guesses) |
| F2.1 | plug the FM-1 into the phone over **USB**, tap Connect, and have the synth play the drone with the phone silent | `f2.1-usb-connect` | rig, **failing**: Android Chrome gives no prompt in a tab and "platform dependent initialization failed" in the installed app (2026-11-01) |
| F2.2 | connect over **Bluetooth** and have the drone, the part and the modulation play for as long as the page stays up | `f2.2-ble-connect` | rig, **works**: tried on the FM-1 from the phone, 2026-11-01 |
| F2.3 | be told on screen when a connect is blocked or refused, and what to do, with a Try again button | `f2.3-connect-errors` | todo (built 2026-11-01: `hw/midi-check.js` and the box under the link line, with Copy details; checked in `scripts/test_ble_browser.mjs` against fake ports, not yet seen on the phone) |
| F2.4 | leave the phone and synth running on the arm of a chair for an hour without lag, dropped keys or a drained phone | `f2.4-long-session` | rig, **not met over USB**: lag and dropped keys with the phone routing audio to the FM-1 (2026-11-01) |
| F3.1 | assign a shape (sine, triangle, drift, steps) to a parameter, set its rate and depth, and hear it move the sound | `f3.1-modulate` | todo (built; only checked on fake MIDI, not yet by ear) |
| F3.2 | see each modulator as a live trace with the value going out, in time with what I hear | `f3.2-mod-visual` | todo |
| F3.3 | stop, or switch a modulator off, and have the instrument return to the panel's values | `f3.3-mod-stop` | todo |
| F3.4 | never have the page change the instrument's sound on stock firmware or the AKS Mini | `f3.4-no-cc-on-stock` | todo |
| F4.1 | pick up the guitar and see on the neck the notes of the chord now and the scale around it, moving with the chord | `f4.1-neck` | todo |
| F4.2 | see the modulation on the neck: a glow that breathes and ripples with it | `f4.2-neck-glow` | todo |
| F4.3 | see linked note sets, fading lines and cycling note patterns that follow the modulation | `f4.3-neck-links` | todo (not built; stage 2) |
| F5.1 | have the whole thing play with no phone and no app connected, and draw its own visuals | `f5.1-standalone` | todo (not built; stage 4) |
| F6.1 | find everything I use in reach of one thumb: chord, Play, sound presets and the modulators | `f6.1-phone-reach` | todo |

## Next

1. Write the runner and the first flows: F1.1–F1.3, F3.1–F3.4, F4.1, F6.1 can
   run in Chrome at 390×844 against a fake Web MIDI port. They make these
   statuses real. Use Woodshed's harness as the model.
2. Fix F2.3 first among the connect flows: a blocked or refused connect must
   say so on screen. It is what turns F2.1 from a mystery into a diagnosis.
3. Until F2.1 and F2.4 pass over USB, Bluetooth (F2.2) is the way to play. The
   standalone stage (F5.1) removes the phone from the setup altogether.
