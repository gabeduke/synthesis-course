# Signal Path

A free, hands-on synthesis course built around the **M-VAVE FM-1** running
**Baud Girl's FM-1+VA** firmware.

Every lesson makes sound and draws it in the browser, so the course works on its
own. Plug an FM-1 in over USB and the page can also play it, set its Virtual
Analog controls live, and draw the hardware's real output next to the page's
model.

The course can also be read for other boards that run Baud Girl's firmware:
pick the instrument in the page header and button names, hands-on steps and
the USB link follow it (see [Supported devices](#supported-devices)).

**Live site:** https://gabeduke.github.io/synthesis-course/

## Lessons

| # | Lesson | What you play with |
|---|--------|--------------------|
| 0 | Start here | Connecting an FM-1 or SMK-37, the four moves that reach every setting |
| 1 | Sound you can see | Oscilloscope, spectrum, a drag-to-build harmonics editor |
| 2 | Oscillators | Waveforms, Sub, Noise, PWM |
| 3 | Filters | Cutoff and resonance with the filter curve drawn over a live spectrum |
| 4 | Envelopes | ADSR shape with a moving playhead, measured loudness, filter envelope |
| 5 | LFOs and modulation | The LFO drawn over time, moving pitch, loudness and cutoff |
| 6 | Super, Detune and Drift | Beating between two tones; seven oscillators drawn lane by lane |
| 7 | Space | Dry vs detune vs chorus vs delay vs reverb, loudness plotted after key-up |
| 8 | FM synthesis | Two-operator FM with sidebands marked on the spectrum |
| 9 | 8-Bit | Pulse widths, stepped triangle, console noise, arpeggios |
| 10 | Five patches to build | Full recipes, sendable to the FM-1 in one click |
| 11 | Playing it live | Knob banks, macros, hands-free tricks, controllers |
| 12 | Drones | Holding a note, slow movement, latching, sending it to other gear |
| | **AKS Mini** | |
| 13 | The AKS Mini | The EMS lineage and the pin matrix it dropped, its signal path, connecting it, its MIDI numbers |
| 14 | Three VCOs, one filter | Saw/square/Shape, Detune, voice modes, paraphony, the Response filter |
| 15 | The trapezoid and the joystick | Attack/On/Decay/Off, the looping envelope, Trapez vs Signal, the joystick |

Plus a filterable history timeline with sources.

Every lesson panel shows its **signal path** along the top (the sound after the
oscillators, the filter, the amp and the effects, with the envelope and LFO
drawn to what they move), and every playable panel has a **Focus** button that
fills the screen with it; the synth and AKS panels add a scope, spectrum and
spectrogram (or the trapezoid and the three VCOs) there.

## Supported devices

| Device | Firmware | Status |
|--------|----------|--------|
| M-VAVE FM-1 | FM-1+VA | The course's source of truth. Written against version 97; envelope times rechecked against 102. |
| M-VAVE SMK-37 (Pro, Elite) | SMK-37+VA | Control names and SMK-only notes from the version 102 manual and quick start. USB and Bluetooth MIDI tested on a real unit (below). |
| Behringer AKS Mini | its own | A separate track (lessons 13–15) with its own model and MIDI link; see [AKS Mini](#aks-mini-lessons-1315). Not a translation of the FM-1 lessons. |

The SMK-37+VA firmware also runs on the Donner Starrykey-37 Play and the EROK
MKE-P37; they aren't separate entries yet.

Checked on an SMK-37 running SMK-37+VA, from a Mac (October 2026):

- **USB:** the MIDI port is named `SMK-37+VA` (in and out) and the audio
  device `SMK-37+VA Audio` (2 channels in, 2 out, 44.1 kHz). The page picks
  both by name. From Chrome, the page's own code found the port and played
  notes on it, including from a lesson panel set to Play on: SMK-37
  (confirmed by recording the SMK's USB audio).
- **Bluetooth:** in BT Device mode it advertises standard BLE MIDI as
  `SMK-37+VA_BLE` (the MIDI characteristic offers read, write without
  response and notify). The panel's Connect over Bluetooth button connected
  to it in about 2.5 s and the page's notes played; a manual disconnect was
  clean.
- **Not yet checked:** its own keys, knobs and wheels arriving at the page
  (USB or Bluetooth), Elite-specific differences, and pad aftertouch after
  version 101. The MIDI monitor in the connection panel shows what arrives.

From the SMK-37+VA version 102 manual's MIDI chapter: it sends notes with
velocity on its Out Channel (1), pitch bend, the mod wheel as CC 1 and the
pedal as CC 64; with GLOBE › MIDI › Send CC on, every panel change goes out as
the CC the firmware receives for it; on the MIDI CC bank K5–K8 send CC 74, 71,
73 and 72 and the faders CC 7, 10, 91 and 93. Its Bend Up/Down default to 12
semitones, which the page's synth copies (`bendRange` in the profile).

### How the device switch works

The lesson HTML stays in FM-1 terms; other devices are a translation of it.

- `site/assets/js/hw/devices.js` holds one profile per device: its label,
  firmware name, a map from FM-1 control names to its own (`EDIT` → `PARA`,
  `KNOB1` → `K5` …), regexes for its USB MIDI port and audio input, its
  Bluetooth name and pitch-bend range, any CC overrides, and notes.
- `site/assets/js/ui/device.js` keeps the choice (localStorage
  `course.device`, or `?device=smk37` in the address, which is remembered),
  draws the picker in the header, and rewrites the page when it changes:
  - `<span class="btn-name">` and `<span class="ctl-name">` get the device's
    name for that control. The FM-1 text is kept in `data-fm1`, so switching
    back is exact.
  - `<span class="dev-name">FM-1</span>` becomes the device's label and
    `<span class="fw-name">FM-1+VA</span>` its firmware's name. These are used
    only where a sentence is true of every device; prose about the FM-1's own
    hardware is left alone.
  - The "where it lives" paths in `ui/params.js` are translated as they're
    shown.
  - `<html data-device="…">` shows elements marked `data-device="smk37"`
    (or a space-separated list of ids) and hides the ones marked for other
    devices. Device-only boxes use `<aside class="on-device" data-device="…">`.
- The USB link (`hw/fm1.js`) picks ports with the active profile's regexes,
  preferring a port with the model's name over a generic one (`USB-MIDI`) and
  a cable over a Bluetooth port the OS has paired. Ports chosen by hand in the
  connection panel are remembered and win.

Without JavaScript, or before it runs, a page reads exactly as it did for the
FM-1. If storage is blocked the page starts on the FM-1 each time.

### Adding a device

1. Add an entry to `DEVICES` in `site/assets/js/hw/devices.js`. Any control
   not in its `controls` map keeps its FM-1 name.
2. Search the lessons for `data-device="smk37"`. Where the new device shares
   that text, add its id (`data-device="smk37 starrykey"`); where it differs,
   add its own element next to it.
3. Run `python3 scripts/build_pwa.py` and check every lesson with the device
   selected: no FM-1 control names should be left in the steps.

## Bluetooth MIDI

The connection panel can also reach the instrument over **Bluetooth MIDI**,
without a cable. This is for setups where the operating system pairs with the
instrument but doesn't offer it to the browser as a MIDI port, which is common
with Chrome on Android.

- `site/assets/js/hw/ble-midi.js` speaks the standard BLE MIDI profile
  (service `03B80E5A-EDE8-4B33-A751-6CE34EC4C700`, characteristic
  `7772E5DB-3868-4112-A1A9-F2669D106BF3`) over Web Bluetooth: it parses the
  instrument's notifications into ordinary MIDI messages and packs the page's
  notes and CCs into 20-byte packets, written one at a time.
- `hw/fm1.js` treats it as another MIDI input and output. **While Bluetooth is
  connected it is the link**: the page sends only over Bluetooth and listens
  only to Bluetooth, so an instrument that's also plugged in by USB doesn't
  get every note and setting twice. The USB ports stay selected and take over
  again when Bluetooth disconnects. An unexpected drop is retried five times
  with growing pauses (0.5 s up to 20 s, each attempt abandoned after 12 s),
  and once more when the page comes back to the foreground. If that fails, the
  button turns into "Reconnect Bluetooth": one tap tries the same instrument
  without the chooser, and a second tap opens the chooser.
- The connection panel has a collapsed "Bluetooth log" (connects, drops,
  retries and failures, with times; kept in the browser across lessons, with
  Copy and Clear buttons) for working out why a link keeps dropping.
- Browser support: Chrome on Android, and Chrome or Edge on Windows, macOS
  and ChromeOS (Web Bluetooth). Not Firefox or Safari, and not on iOS. It
  needs https or `localhost`, and a tap on the button each time a page loads,
  since the lessons are separate pages.
- **Tested with an SMK-37** (BT Device mode, `SMK-37+VA_BLE`): connect, notes
  from the page, and disconnect, from Chrome on a Mac. Notes and CCs from the
  SMK-37 back to the page over Bluetooth, and the FM-1, are still untested.
  On a Mac the instrument can instead be paired once in Audio MIDI Setup,
  after which it's an ordinary MIDI port.

Run the parser tests with `node scripts/test_ble_midi.mjs`, and the browser
tests (a simulated device, the USB path, CCs and wheels into the page, the MIDI
monitor, the hardware check, the output chooser, the signal path and Focus, and
every page on both devices) with
`NODE_PATH=$(npm root -g) node scripts/test_ble_browser.mjs` (needs
Playwright and Chromium). The browser tests fake Web MIDI; for real hardware,
use an installed Chrome: Chrome for Testing 148 on macOS stalled on Web MIDI
sends to a real port, while Chrome 155 did not.

## Playing the page from the instrument

MIDI coming in goes to the panel you used last (or the first one on screen),
through `ui/keyboard.js`:

- **Notes** light the drawn keys, and play the page's synth when "keys also
  play the page's synth" is on.
- **Pitch bend, the mod wheel (and channel pressure) and the sustain pedal**
  always reach the panel: bend moves every oscillator by the device's
  `bendRange`, the wheel adds up to 60 cents of vibrato from the panel's LFO
  (the firmware's default mapping for the wheel is Pitch), and the pedal holds
  released keys. Small wheel gauges appear by the keyboard once they move.
- **Knobs:** `paramFromCc()` in `hw/fm1.js` is `ccValue()` run backwards. A CC
  the page knows moves the same setting on the panel (`hwParam`), the slider
  glows purple, and the line under the panel names it. Settings that come from
  the instrument are never mirrored back to it. CC 7, 91 and 93 (the SMK-37's
  faders on the MIDI CC bank) move Level, reverb mix and chorus mix. The
  connection panel's "knobs and wheels move the page" switch turns this off.
- The connection panel's **MIDI monitor** lists every incoming message,
  decoded, with clock counted rather than listed.
- **Try every control** (`<hw-check>`, in lesson 0) is a checklist that ticks
  itself off from what arrives: keys, wheels, pedal, Send CC, the CC banks,
  pads (it records the notes they send), preset changes, clock, Bluetooth, and
  the instrument's sound on its audio input. **Copy report** writes it up as
  text for `hw/devices.js` and this README. Incoming messages carry `via`
  (`usb` or `ble`) for it.
- **The page can play through the instrument.** Once audio is connected, the
  connection panel offers the computer's outputs (`AudioContext.setSinkId`,
  Chrome and Edge). The SMK-37 is also a USB audio output, and what it's sent
  comes back mixed into its own output (a tone sent to it was recorded on its
  USB input), so the page's synth and the SMK-37 can share its headphones.
  While the page plays through the instrument, "Also play it through this
  page" is switched off, since that would loop.

## How it works

Plain HTML, CSS and JavaScript modules. No build step, no dependencies, no
server: GitHub Pages serves the `site/` folder as is.

- `site/assets/js/audio/` — Web Audio engine. `va-synth.js` mirrors the
  FM-1+VA Virtual Analog parameter set (0–100 ranges, LP12/LP24/BP/HP filter,
  filter envelope, LFO, Super/Detune/Drift). `supersaw.js` models Super and
  Detune using Adam Szabo's measurements of the Roland JP-8000, which Baud Girl
  cites as the model for FM-1+VA's Super. `fx.js` is the effects chain.
- `site/assets/js/hw/fm1.js` — the FM-1 link: Web MIDI in and out, the CC map
  from Baud Girl's manual, and capture of the FM-1's USB audio input. It
  serves every device; `hw/devices.js` decides which port it looks for.
  `hw/ble-midi.js` adds Bluetooth MIDI (see [Bluetooth MIDI](#bluetooth-midi)).
- `site/assets/js/hw/devices.js` and `site/assets/js/ui/device.js` — device
  profiles and the translation layer (see above).
- `site/assets/js/ui/focus.js` — the Focus button every playable panel gets
  (`enableFocusAll()` from `main.js`); pictures grow in proportion, and the
  element gets a `focuschange` event.
- `site/assets/js/widgets/` — the custom elements used in lessons:
  `<synth-lab>`, `<voice-stack>`, `<beat-lab>`, `<harmonics-lab>`,
  `<space-lab>`, `<fm-lab>`, `<chip-lab>`, `<fm1-panel>`, `<history-timeline>`,
  `<hw-check>`, and `<aks-lab>` / `<aks-panel>` for the AKS Mini track.
- `site/assets/js/ui/params.js` — every control's range, color, and where it
  lives on the FM-1 (translated for other devices). Start here to add or
  change a control.
- `site/lessons/` — one HTML file per lesson. The header, lesson rail and
  previous/next links are filled in by `ui/shell.js` from `ui/lessons.js`.

A `<synth-lab>` is configured entirely from attributes, so most lesson panels
are one line of HTML:

```html
<synth-lab heading="A low-pass filter on a saw"
           controls="cutoff resonance filterType"
           preset='{"waveform":"saw","cutoff":1500}'
           views="spectrum wave" filter-curve chord="45 52 57"></synth-lab>
```

`controls` takes parameter keys or group names (`Oscillator`, `Filter`,
`Envelope`, `LFO`, `Chorus`, `Delay`, `Reverb`, `Distortion`). `views` takes any
of `wave`, `spectrum`, `sono` (a scrolling spectrogram), `env`, `shape`, `lfo`.
`flow="off"` hides the signal-path strip. The strip draws from analysers
`VASynth.taps()` hangs off the oscillator mix, the filter output, the amp and
the output; `ui/draw.js` has the spectrogram (`Sonogram`) and the auto-scaled
mini scope.

## AKS Mini (lessons 13–15)

A short track for the **Behringer AKS Mini**, a 3-VCO paraphonic analog synth
descended from EMS's VCS3 and Synthi AKS. It's a separate instrument, not
another device in the picker: the FM-1 lessons don't translate to it.

- `site/assets/js/audio/aks-core.js` holds the controls, ranges, CC map, voice
  allocation and trapezoid timing as pure functions. `aks-synth.js` is the Web
  Audio model: three always-running VCOs, one filter that self-oscillates near
  full Response, one trapezoid envelope that loops when Off is 6 or below,
  Trapez/Signal into the VCA, an LFO and a generated spring reverb.
- `hw/aks.js` plays the real AKS Mini over the same Web MIDI permission as the
  FM-1 link: notes, pitch bend and the guide's CCs (1, 32–51). It never sends
  SysEx.
- `<aks-lab>` takes `controls`, `preset` (0–10 knob scale), `views` (`wave
  spectrum trap voices joystick`), `filter-curve`, `joystick="x y"` and
  `chord`. `<aks-panel>` is just the port. An SMK-37 or FM-1 connected at the
  top right can play it through the page (keys, wheels and pedal), with the
  SMK-37's Local Control off so it doesn't sound itself.

Run `node scripts/test_aks.mjs`.

**Unverified.** Behringer has published only a draft Quick Start Guide (V 0.0).
Everything below needs a real unit:

- The USB MIDI port name (the page matches `/aks/i`).
- The CC map (CC 51 labelled "Sustain", the overlapping CC 40 bands).
- What the voice modes do, and whether the ring-modulation modes exist.
- Two keys in Poly mode (the page doubles the first).
- Whether holding a key stretches On.
- Whether the loop runs with no key held.
- Off times (borrowed from the original's 10 ms–5 s).
- Self-oscillation, the 12/24 dB slope selection, and bend range and velocity.

## Running locally

```sh
cd site
python3 -m http.server 8000
# open http://localhost:8000
```

Web MIDI and audio input need a secure context; `localhost` counts.

## Browser support

Chrome and Edge support everything, including Bluetooth MIDI. Firefox supports
Web MIDI with a site permission, but not Bluetooth. Safari plays the lessons but has no Web MIDI, so it can't talk to
the FM-1.

## Accuracy notes

- The page's synth is a model built from the FM-1+VA parameter list, not a copy
  of the firmware. It sounds related, not identical.
- The MIDI CC numbers come from the MIDI chapter of the FM-1+VA manual. They
  cover the Virtual Analog engine and four effects; FM and 8-Bit settings have
  no documented CCs, so those lessons use the FM-1 connection for playing and
  listening only. How the FM-1 maps CC values onto Cutoff's 20 Hz–20 kHz range
  isn't documented; the page uses a logarithmic spread.
- The course was written against FM-1+VA version 97. Attack and Decay times were
  rechecked against version 102 (5 ms to 10 s); the CC map is still the version 93
  one, with the envelope CCs (73, 75, 70, 72) confirmed in version 102. Baud Girl's manual is the
  authority when the firmware changes.
- The SMK-37 translation was checked against the SMK-37+VA version 102 manual
  and quick start. Its MIDI chapter lists the same Virtual Analog and effect
  CCs as the FM-1+VA map, so the page sends that map to both. It adds a Filter
  and a Phaser on the FX channel (CC 0–3, 20–23), and panel CCs on the MIDI
  channel: 85–88 turn K5–K8, 89/90 and 102–119 step K1–K3 and press its
  buttons (all but PATCH).

## Credits

The FM-1+VA and SMK-37+VA firmware and their manuals are Baud Girl's work:
https://baudgirl.com/work/FM-1+VA and https://baudgirl.com/work/SMK-37+VA. This course is independent and isn't
affiliated with M-VAVE or Baud Girl.
