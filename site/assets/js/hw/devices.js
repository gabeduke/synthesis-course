// Device profiles: the instruments the course can be read for.
//
// The course is written for the M-VAVE FM-1 running Baud Girl's FM-1+VA
// firmware, and the lesson HTML stays in FM-1 terms. Every other device is a
// translation of that text: same synthesis engine, same 0–100 settings, only
// the names printed on the panel and the hardware link differ.
//
// To add a device, add one entry below. Each entry has:
//
//   id          short key, used in the URL (?device=id) and in localStorage
//   label       short name for buttons and headings ("SMK-37")
//   name        full product name
//   firmware    the firmware's name ("SMK-37+VA")
//   article     "a" or "an", as said before the label ("an FM-1")
//   cable       the USB connector, if known, for "Plug it in with a … cable"
//   manual      link to that firmware's manual
//   controls    FM-1 control name -> this device's name. Anything not listed
//               keeps its FM-1 name. Used for <span class="btn-name"> and
//               <span class="ctl-name"> in the lessons, and for the
//               "where it lives" paths in ui/params.js.
//   portMatch   regex for the USB MIDI port name, to pick it automatically
//   audioMatch  regex for the USB audio input name, to listen to it
//   bleName     the name it advertises over Bluetooth MIDI, if known
//   bendRange   semitones each way the firmware bends by default, so the
//               page's synth bends as far as the instrument does
//   cc          overrides for ../hw/fm1.js's CC maps, as { VA: {...}, FX: {...} }
//               (none known: the SMK-37+VA manual lists the same numbers)
//   notes       short facts and open questions about the device, for the README
//               and for anyone adding to this file
//
// Text that only makes sense on one device goes in the lesson HTML inside an
// element with data-device="id" (see ui/device.js); it is shown only while
// that device is selected.

export const DEVICES = {
  fm1: {
    id: 'fm1',
    label: 'FM-1',
    name: 'M-VAVE FM-1',
    firmware: 'FM-1+VA',
    article: 'an',
    cable: 'USB-C',
    manual: 'https://baudgirl.com/work/FM-1+VA/manual',
    controls: {},
    portMatch: /fm-?1|ota-fm|felucca|usb composite device|usb-midi/i,
    audioMatch: /fm-?1/i,
    cc: {},
    notes: [
      'The course was written against FM-1+VA version 97; envelope times rechecked against version 102.',
      'Shows up as a USB audio interface named "FM-1 Audio".',
    ],
  },

  smk37: {
    id: 'smk37',
    label: 'SMK-37',
    name: 'M-VAVE SMK-37',
    firmware: 'SMK-37+VA',
    article: 'an',
    manual: 'https://baudgirl.com/work/SMK-37+VA/manual',
    // From the SMK-37+VA version 102 manual and quick start: K1 scrolls, K2
    // changes the highlighted value (and on HOME steps Waveform, Algorithm or
    // the lead's Wave, as ALGORITHM does on the FM-1), K3 is the preset dial,
    // K4 is volume, K5–K8 play the knob bank. NOTE REPEAT opens the Envelope
    // list (hold about a second to switch it on or off) and SCALE the LFO
    // list, whatever their printed names say.
    controls: {
      SELECT: 'K1',
      ALGORITHM: 'K2',
      PRESETS: 'K3',
      MASTER: 'K4',
      KNOB1: 'K5',
      KNOB2: 'K6',
      KNOB3: 'K7',
      KNOB4: 'K8',
      HOME: '<',
      SEL: '>',
      EDIT: 'PARA',
      ENV: 'NOTE REPEAT',
      LFO: 'SCALE',
      SAVE: 'PATCH',
      GLO: 'GLOBE',
      PLAY: 'SEQ PLAY',
      REC: 'SEQ REC',
      'OCT−': 'OCTAVE−',
      'OCT+': 'OCTAVE+',
      'OCT-': 'OCTAVE−',
    },
    // Seen on a Mac with an SMK-37 on SMK-37+VA: the USB MIDI port is named
    // "SMK-37+VA" and the USB audio device "SMK-37+VA Audio" (2 channels in,
    // 2 out, 44.1 kHz). The other names cover the boards the same firmware
    // runs on, and the generic names many USB MIDI devices use; ports with
    // the model's name are preferred over generic ones (see fm1.js).
    portMatch: /smk-?37|starrykey|mke-?p37|usb-midi|usb composite device/i,
    audioMatch: /smk-?37|starrykey/i,
    // Advertised in Bluetooth Device mode, with the standard BLE MIDI service.
    bleName: 'SMK-37+VA_BLE',
    // GLOBE › Bend Up / Bend Down, 1–24, start at 12.
    bendRange: 12,
    cc: {},
    notes: [
      'Checked against the SMK-37+VA version 102 manual (October 2026). The same firmware also runs on the SMK-37 Pro, Donner Starrykey-37 Play and EROK MKE-P37.',
      'Four faders with their own bank (FADER BANK), starting on the Mixer bank. Eleven banks: the FM-1’s ten plus MIDI CC.',
      'Sixteen pads in three banks (Sequencer, Notes, Presets), switched with KNOB BANK and FADER BANK together.',
      'PITCH and MOD wheels; a sustain pedal jack read at power-on. It sends pitch bend, the mod wheel as CC 1 and the pedal as CC 64; with GLOBE › MIDI › Send CC on, every panel change goes out as the CC it receives for it.',
      'Tested from a Mac: USB MIDI port "SMK-37+VA", USB audio "SMK-37+VA Audio", and standard BLE MIDI advertised as "SMK-37+VA_BLE" in BT Device mode (read, write-without-response and notify; notes sent over it played).',
      'Unverified: Elite-specific differences, how the wheels and sustain pedal interact with the Virtual Analog engine, pad aftertouch after version 101.',
    ],
  },
};

export const DEFAULT_DEVICE = 'fm1';

// Control names that only ever mean a physical control, so they can be
// translated anywhere in a "where" path. Others (HOME is also the name of a
// screen, LFO and EDIT are also words for the things they open) are only
// translated as the first step of a path, where they are the button pressed.
const ALWAYS_CONTROLS = /\b(SELECT|ALGORITHM|PRESETS|MASTER|KNOB[1-4]|ENV|SAVE|GLO)\b/g;

// Name of one control on a device.
export function controlName(device, fm1Name) {
  return device.controls[fm1Name] ?? fm1Name;
}

// Translate a "where it lives" path such as "EDIT › Filter › Cutoff (KNOB1 on
// a new VA preset)" into the device's names.
export function translateWhere(device, path) {
  if (!Object.keys(device.controls).length) return path;
  const swap = (text) => text.replace(ALWAYS_CONTROLS, (m) => controlName(device, m));
  const m = path.match(/^([A-Z][A-Z0-9+−-]*)(?=$| )/);
  if (!m) return swap(path);
  return controlName(device, m[1]) + swap(path.slice(m[1].length));
}
