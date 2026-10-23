# Signal Path

A free, hands-on synthesis course built around the **M-VAVE FM-1** running
**Baud Girl's FM-1+VA** firmware.

Every lesson makes sound and draws it in the browser, so the course works on its
own. Plug an FM-1 in over USB and the page can also play it, set its Virtual
Analog controls live, and draw the hardware's real output next to the page's
model.

**Live site:** https://gabeduke.github.io/synthesis-course/

## Lessons

| # | Lesson | What you play with |
|---|--------|--------------------|
| 0 | Start here | Connecting an FM-1, the four moves that reach every setting |
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

## How it works

Plain HTML, CSS and JavaScript modules. No build step, no dependencies, no
server: GitHub Pages serves the `site/` folder as is.

- `site/assets/js/audio/` — Web Audio engine. `va-synth.js` mirrors the
  FM-1+VA Virtual Analog parameter set (0–100 ranges, LP12/LP24/BP/HP filter,
  filter envelope, LFO, Super/Detune/Drift). `supersaw.js` models Super and
  Detune using Adam Szabo's measurements of the Roland JP-8000, which Baud Girl
  cites as the model for FM-1+VA's Super. `fx.js` is the effects chain.
- `site/assets/js/hw/fm1.js` — the FM-1 link: Web MIDI in and out, the CC map
  from Baud Girl's manual, and capture of the FM-1's USB audio input.
- `site/assets/js/widgets/` — the custom elements used in lessons:
  `<synth-lab>`, `<voice-stack>`, `<beat-lab>`, `<harmonics-lab>`,
  `<space-lab>`, `<fm-lab>`, `<chip-lab>`, `<fm1-panel>`, `<history-timeline>`.
- `site/assets/js/ui/params.js` — every control's range, color, and where it
  lives on the FM-1. Start here to add or change a control.
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

Chrome and Edge support everything. Firefox supports Web MIDI with a site
permission. Safari plays the lessons but has no Web MIDI, so it can't talk to
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

## Credits

The FM-1+VA firmware and its manual are Baud Girl's work:
https://baudgirl.com/work/FM-1+VA. This course is independent and isn't
affiliated with M-VAVE or Baud Girl.
