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

Plus a filterable history timeline with sources.

## Supported devices

| Device | Firmware | Status |
|--------|----------|--------|
| M-VAVE FM-1 | FM-1+VA | The course's source of truth. Written against version 97; envelope times rechecked against 102. |
| M-VAVE SMK-37 (Pro, Elite) | SMK-37+VA | Control names and SMK-only notes from the version 102 manual and quick start. |

The SMK-37+VA firmware also runs on the Donner Starrykey-37 Play and the EROK
MKE-P37; they aren't separate entries yet. Still unconfirmed for the SMK-37,
and worded as "check on your unit" on the site: the names of its USB MIDI port
and USB audio input (the page guesses, and you can pick the port by hand),
differences on the Elite, what the wheels and sustain pedal do beyond what the
manual says, and pad aftertouch after version 101.

### How the device switch works

The lesson HTML stays in FM-1 terms; other devices are a translation of it.

- `site/assets/js/hw/devices.js` holds one profile per device: its label,
  firmware name, a map from FM-1 control names to its own (`EDIT` → `PARA`,
  `KNOB1` → `K5` …), regexes for its USB MIDI port and audio input, any CC
  overrides, and notes.
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
- The USB link (`hw/fm1.js`) picks ports with the active profile's regexes.
  Ports chosen by hand in the connection panel are remembered and win.

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
- Browser support: Chrome on Android, and Chrome or Edge on Windows, macOS
  and ChromeOS (Web Bluetooth). Not Firefox or Safari, and not on iOS. It
  needs https or `localhost`, and a tap on the button each time a page loads,
  since the lessons are separate pages.
- **Untested against real hardware.** The parser and builder are unit-tested
  and the panel is tested against a simulated device, but no FM-1 or SMK-37
  has been connected this way yet. The SMK-37 has a Bluetooth button; whether
  it speaks standard BLE MIDI (and in which mode) is unconfirmed.

Run the parser tests with `node scripts/test_ble_midi.mjs`, and the browser
tests (a simulated device, plus the USB path and every page on both devices)
with `NODE_PATH=$(npm root -g) node scripts/test_ble_browser.mjs` (needs
Playwright and Chromium).

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
- `site/assets/js/widgets/` — the custom elements used in lessons:
  `<synth-lab>`, `<voice-stack>`, `<beat-lab>`, `<harmonics-lab>`,
  `<space-lab>`, `<fm-lab>`, `<chip-lab>`, `<fm1-panel>`, `<history-timeline>`.
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
of `wave`, `spectrum`, `env`, `shape`, `lfo`.

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
  and quick start. That manual lists the same envelope CCs and the MIDI CC
  knob bank's 74, 71, 73 and 72; nothing in it suggests different numbers, so
  the page sends the FM-1+VA map to both. It doesn't list the FM-1's CC 85–88
  for the panel knobs.

## Credits

The FM-1+VA and SMK-37+VA firmware and their manuals are Baud Girl's work:
https://baudgirl.com/work/FM-1+VA and https://baudgirl.com/work/SMK-37+VA. This course is independent and isn't
affiliated with M-VAVE or Baud Girl.
