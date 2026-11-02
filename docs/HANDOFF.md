# Handoff: Jam, to take further on a stronger model

Written 2026-11-01 at the end of a long session run on Sonnet 5.5. Read this,
then `docs/VISION.md`, `docs/flows.md` and `STATE.md`. Nothing from the
session was committed at the time; it went in later as 5ac6ecd.

## What Jam is

A page in this repo (`site/jam.html`, `site/assets/js/widgets/jam-room.js`):
pick a key and mode, press Play, and a drone moves through chords in that key.
Plugged into an M-VAVE FM-1 (or SMK-37) the synth makes the sound and the phone
runs the clock; with nothing connected the phone makes it. A guitar neck shows
the chord and scale. Gabe plays guitar over it.

## What Gabe wants (his words, in order of importance)

1. **Instant ambient drone to jam over, set and forget.** Phone and synth on the
   arm of a chair, hands on the guitar. Campfire use: reliable, on batteries.
2. **Modulation over MIDI CC** ("make it weird"), and to **see** the modulation.
3. **Visuals on the guitar neck:** linked note sets, lines that fade in and out,
   gently cycling patterns, randomized or algorithmic, following the modulation.
4. **Eventually it plays on its own, with no phone or app connected, and draws
   its own visuals.** That may mean its own firmware, or a small always-on
   device. Not decided.
5. **A split into its own project.** Latest word: it may be **better as part of
   Woodshed** (`~/repos/song-course`) than its own repo. Undecided; see below.

## How Gabe wants to work (read this)

- **Only ship what has been tried on the hardware.** He had me remove the
  sequencer export because it was never tested; untested features "make the
  whole thing messy". Keep untested things out of the UI.
- **No slop.** His first message was "I assume we slopped some code without
  proper interfaces or design decisions". He wants clean boundaries: pure logic
  in `audio/`, drawing separate from MIDI, hardware link separate again.
- He prefers a conversation about how he would use it to a pile of options. He
  said he wished he'd been quizzed on his usage. Ask about use before building.
- He is not a developer-mode Android user; don't ask him to run adb or remote
  debugging. Put diagnostics on screen instead.
- Keep replies short and plain. He reads on a terminal.

## State of the code (all uncommitted, on branch `main`)

Run `git status` and `git diff --stat`. In short:
- **Phone layout:** sound presets (Pad, Swell, Glass, Organ, Dark, Pluck), a
  bottom dock with the chord and Play, panels ordered by use. Gabe tried it on
  the real FM-1 and called it perfect.
- **Sequencer export removed:** `audio/smf.js` deleted (staged), the Keep-it
  panel, the count-in recording pass, their tests, README and `jam.html` text.
- **Modulation (built by a sub-agent, checked only on fake MIDI):**
  `audio/modulation.js` (pure), `hw/cc.js`, `ui/mod-draw.js`, a Modulation
  panel with three slots (shape, target, rate, depth), neck glow, and Movement
  migrated to slot 1. Read it critically: it passed its own tests, nobody has
  heard it.
- Docs: `docs/VISION.md`, `docs/flows.md`, `STATE.md`, this file.
- Tests: `node scripts/test_jam.mjs` passes (21). `scripts/test_ble_browser.mjs`
  needs the full `playwright` package and was **not run** after the changes.
  Run it before committing.

## What is verified, and what is not

| Thing | Status |
|---|---|
| Desktop Chrome connects to the FM-1 over USB; drone plays; audio recorded back | verified on this Mac, 2026-11-01 |
| Phone over **Bluetooth** to the FM-1 | works, Gabe's own test |
| Phone over **USB** to the FM-1 | **fails** (below) |
| Modulation sounds right (CC steps, zipper noise, depth and rate ranges) | **not heard** |
| Neck glow looks and feels right on a phone | screenshots only |
| MIDI clock toggle | untested on hardware |
| FM-1 sequencer takes CC automation / Device Manager imports CC from MIDI | **unknown**, never tested |

## The open bug: USB from the phone

- Installed PWA: Connect gives "UnknownError: Platform dependent initialization
  failed" (Chrome's native MIDI layer). In a normal Chrome tab Gabe sees no
  error and no MIDI permission prompt.
- Desktop Chrome works. I tried fake port names a phone might report; the
  port-picking logic selects correctly. Not reproduced.
- Service worker and cache are consistent (`sw.js` rebuilds identically).
- **Lag and dropped keys** on the FM-1 when it is on the phone. Gabe has seen
  the phone routing audio to the FM-1's USB audio interface. The FM-1 has its
  own battery; whether it charges from the phone is not known. Suggested, not
  tried: Android Developer options → "Disable USB audio routing"; check the
  MIDI site permission isn't blocked; try a data-capable cable.
- The page's connect buttons did nothing visible on a refused request in the
  tab. A blocked or refused connect must show a message and a retry (flow F2.3).
  This is the best next fix: it turns the mystery into a diagnosis.
- A pre-existing gap: the port matcher recognises "usb-midi" (hyphen) but not
  "USB MIDI Device". Android may name the port differently; the Jam page has a
  manual "MIDI port" dropdown for this.

## The Woodshed question (decide this first)

Gabe: "our drone app might be better suited to live in the Woodshed app".
Woodshed is `~/repos/song-course`: a no-build static site (`js/`, `songs/*.json`,
`docs/flows.md` with a flow runner in `scripts/flows.mjs`), already plays songs,
drives the SMK-37 over MIDI, has a neck and keyboard view, a band engine and
an FM lab. Jam shares ideas with it (neck, MIDI link, device profiles) and would
gain its flow runner. Things to weigh before moving anything:
- Both apps have their own MIDI link and device profile code. A merge should
  produce one, not two.
- Jam's constraint is a single phone-first screen with no song file; Woodshed is
  song-centric. The drone may be a new kind of "song" or its own view.
- Woodshed's flows are the validation framework Gabe wants this held to.
Do not move code until he has chosen. Ask him one plain question about it.

## Safety with his hardware

- **Never send MIDI to the real FM-1 unasked.** CC messages overwrite its
  unsaved preset, and Gabe tunes the sound by hand on the unit. Test with fake
  Web MIDI ports. Notes alone are harmless. Don't send Program Change.
- A test run killed partway through playing can leave notes stuck. Always stop
  cleanly (the page's Stop sends note-offs).
- Another Claude session (`song-course`) may use the same hardware.

## How to test here

- Real Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
  through `playwright-core` (install it in a scratch dir; the repo has no
  `node_modules`). Chrome for Testing stalls on real MIDI sends.
- Grant MIDI with CDP `Browser.setPermission` for `{name:'midi', sysex:false}`
  and `{sysex:true}`, with `browserContextId` from `Target.getTargetInfo`.
- Fake MIDI for anything that sends: override `navigator.requestMIDIAccess` in an
  init script with ports that record `send()`.
- Hearing the FM-1 here: `ffmpeg -f avfoundation -i ":0"` records "FM-1 Audio".
  Analyse RMS with a stdlib Python script.
- Phone size: viewport 390×844, `isMobile`, `hasTouch`. A full-page screenshot
  shows canvases blank; use viewport shots.
- `python3 scripts/build_pwa.py` after any site change regenerates `site/sw.js`
  (the PWA only updates when the user taps Reload on the notice).
- Memory notes for this project are in
  `~/.claude/projects/-Users-gabeduke-repos-synthesis-course/memory/`.

## Suggested first steps

1. Ask Gabe the Woodshed question; record the answer in VISION.md.
2. Read `git diff` for the modulation work as a reviewer, not a continuer.
   Check its interfaces against his "proper design" bar.
3. Add the on-screen connect error and retry (F2.3).
4. Commit in sensible pieces once he's happy (he hasn't asked yet; ask).
5. Write the flow runner (model: Woodshed's `scripts/flows.mjs` and
   `scripts/flows/harness.mjs`), then run F1.1–F1.3, F3.x, F4.1, F6.1.
6. Only then neck visuals (stage 2), which need his taste more than code.
