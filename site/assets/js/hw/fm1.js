// FM-1 link: talks to an M-VAVE FM-1 running Baud Girl's FM-1+VA firmware.
//
//  * MIDI in:  notes from the FM-1's keys (it sends notes on channel 1).
//  * MIDI out: notes, plus Control Change messages that set Virtual Analog
//              parameters and effects on whichever preset is selected.
//  * Audio in: the FM-1 is also a USB audio interface ("FM-1 Audio"), so the
//              page can draw the hardware's real output next to its own.
//
// Nothing here ever saves on the FM-1: the firmware deliberately has no CC for
// SAVE. Changes are lost when you turn PRESETS unless you press SAVE yourself.
//
// The CC numbers come from the FM-1+VA manual's MIDI chapter (documented in
// version 93; later versions add to it). Check them against the manual for
// the version on your FM-1 if something doesn't respond.

// The link isn't only for the FM-1: the same firmware family runs on other
// boards (see devices.js). The selected device profile decides which MIDI
// port and audio input to pick automatically; the CC maps below are the
// FM-1+VA ones, with any per-device overrides from the profile applied when
// a message is sent. Ports can always be chosen by hand in <fm1-panel>.
//
// Bluetooth: the link can also reach the instrument over Bluetooth MIDI
// (hw/ble-midi.js), for when the operating system doesn't list it as a MIDI
// port. While Bluetooth is connected it is the link: everything the page sends
// goes over Bluetooth only, and only Bluetooth's incoming notes are heard, so
// an instrument plugged in by USB as well never gets (or gives) everything
// twice. The USB ports stay selected and take over again when Bluetooth
// disconnects.

import { audio, clamp } from '../audio/core.js';
import { device, onDeviceChange } from '../ui/device.js';
import { BleMidi } from './ble-midi.js';

const portMatch = () => device().portMatch;
const audioMatch = () => device().audioMatch;
const GENERIC_PORT = /usb-midi|usb composite device/i;
const WIRELESS_PORT = /ble|bluetooth/i;

// Preset settings, sent on the FM-1's MIDI channel. Values 0–127 cover each
// setting's whole range; lists split 0–127 into equal bands.
export const VA_CC = {
  waveform: 24, super: 25, detune: 26, drift: 27, sub: 28, noise: 29, pwm: 30,
  filterType: 31, cutoff: 74, resonance: 71,
  filterEnv: 52, filterDecay: 53, filterShape: 54, filterVelocity: 55, keyTrack: 56, lfoToCutoff: 57,
  attack: 73, decay: 75, sustain: 70, release: 72,
  lfoSpeed: 76, lfoPitch: 77, lfoDelay: 78,
};

// Effects, sent on the FX channel (default 2). These take raw values, 0–100,
// not 0–127.
export const FX_CC = {
  reverb: { on: 4, type: 5, decay: 6, mix: 7 },
  delay: { on: 8, feedback: 9, rate: 10, mix: 11 },
  distortion: { on: 12, gain: 13, tone: 14, level: 15 },
  chorus: { on: 16, rate: 17, depth: 18, mix: 19 },
};
const REVERB_TYPES = ['room', 'hall', 'plate'];

// The CC for a setting on the selected device: the profile's override if it
// has one (a number, or null for "not available"), otherwise the map above.
export function vaCc(key) {
  const o = device().cc?.VA;
  return o && Object.hasOwn(o, key) ? (o[key] ?? undefined) : VA_CC[key];
}
export function fxCc(effect, field) {
  const o = device().cc?.FX?.[effect];
  return o && Object.hasOwn(o, field) ? (o[field] ?? undefined) : FX_CC[effect]?.[field];
}

// The FM-1's own panel, also on the MIDI channel.
export const PANEL_CC = { knob1: 85, knob2: 86, knob3: 87, knob4: 88 };

const band = (index, count) => Math.round((index + 0.5) * (128 / count));
const pct = (v, max = 100) => Math.round(clamp(v, 0, max) / max * 127);

// Convert one course parameter into the CC value the FM-1 expects.
export function ccValue(key, value) {
  switch (key) {
    case 'waveform': return band(['sine', 'saw', 'tri', 'square'].indexOf(value), 4);
    case 'filterType': return band(['lp12', 'lp24', 'bp', 'hp'].indexOf(value), 4);
    // Cutoff spans 20 Hz–20 kHz on the FM-1. The CC curve isn't documented;
    // a logarithmic spread is the closest match to how cutoff is heard.
    case 'cutoff': return Math.round(Math.log(clamp(value, 20, 20000) / 20) / Math.log(1000) * 127);
    case 'lfoSpeed': case 'lfoPitch': case 'lfoDelay': return pct(value, 99);
    default: return pct(value, 100);
  }
}

// The other way: an incoming CC back into a course parameter, so turning a
// control on the instrument can move the page. Returns { key, value } or null.
// The SMK-37+VA sends these with GLOBE › MIDI › Send CC on (each panel change
// goes out as the CC the firmware receives for it), and from K5–K8 on its MIDI
// CC bank (CC 74, 71, 73 and 72: Cutoff, Resonance, Attack and Release).
const LIST_VALUES = { waveform: ['sine', 'saw', 'tri', 'square'], filterType: ['lp12', 'lp24', 'bp', 'hp'] };
const KEY_TRACK = [0, 33, 67, 100];
// General MIDI numbers the SMK-37's faders send on its MIDI CC bank (CC 10,
// pan, has nothing to move on the page).
const GM_CC = { 7: ['level', 99], 91: ['fx.reverb.mix', 100], 93: ['fx.chorus.mix', 100] };

export function valueFromCc(key, raw) {
  const v = clamp(raw, 0, 127);
  if (LIST_VALUES[key]) return LIST_VALUES[key][Math.min(3, Math.floor(v / 32))];
  if (key === 'cutoff') return 20 * Math.pow(1000, v / 127);
  if (key === 'keyTrack') return KEY_TRACK.reduce((a, b) => (Math.abs(b - v / 1.27) < Math.abs(a - v / 1.27) ? b : a));
  if (key === 'lfoSpeed' || key === 'lfoPitch' || key === 'lfoDelay') return Math.round(v / 127 * 99);
  return Math.round(v / 127 * 100);
}

export function paramFromCc(num, raw, channel, fxChannel) {
  // The FX channel carries CC 0–23 for the effects, as raw 0–100 values.
  if (channel === fxChannel && num < 24) {
    for (const effect of Object.keys(FX_CC)) {
      for (const field of Object.keys(FX_CC[effect])) {
        if (fxCc(effect, field) !== num) continue;
        let value = clamp(raw, 0, 100);
        if (field === 'on') value = raw >= 64;
        else if (field === 'type') value = REVERB_TYPES[Math.min(2, raw)];
        return { key: `fx.${effect}.${field}`, value };
      }
    }
    return null;
  }
  for (const key of Object.keys(VA_CC)) {
    if (vaCc(key) === num && key !== 'filterShape') return { key, value: valueFromCc(key, raw) };
  }
  const gm = GM_CC[num];
  return gm ? { key: gm[0], value: Math.round(clamp(raw, 0, 127) / 127 * gm[1]) } : null;
}

// Short readable text for one MIDI message, for the connection panel's monitor.
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const note = (n) => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
export function describeMidi(data, fxChannel = 2) {
  const [status, d1 = 0, d2 = 0] = data;
  if (status >= 0xf0) return ({ 0xf8: 'Clock', 0xfa: 'Start', 0xfb: 'Continue', 0xfc: 'Stop', 0xfe: 'Active sensing' })[status] || `System ${status.toString(16).toUpperCase()}`;
  const ch = (status & 15) + 1;
  const type = status & 0xf0;
  const at = `ch ${ch}`;
  if (type === 0x90 && d2 > 0) return `Note on  ${note(d1)}  velocity ${d2}  (${at})`;
  if (type === 0x80 || type === 0x90) return `Note off ${note(d1)}  (${at})`;
  if (type === 0xe0) {
    const v = ((d2 << 7) | d1) - 8192;
    return `Pitch bend ${v > 0 ? '+' : ''}${v}  (${at})`;
  }
  if (type === 0xd0) return `Pressure ${d1}  (${at})`;
  if (type === 0xc0) return `Program ${d1} (preset ${String(d1 + 1).padStart(3, '0')})  (${at})`;
  if (type === 0xa0) return `Key pressure ${note(d1)} ${d2}  (${at})`;
  if (type === 0xb0) {
    const named = { 1: 'Mod wheel', 64: 'Sustain pedal', 10: 'Pan', 123: 'All notes off' }[d1];
    const p = paramFromCc(d1, d2, ch, fxChannel);
    const what = named || (p ? p.key.replace(/^fx\./, '').replace('.', ' ') : '');
    return `CC ${d1} = ${d2}${what ? `  ${what}` : ''}  (${at})`;
  }
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (_) { /* storage blocked: preferences just won't persist */ }
  return null;
}

class FM1Link extends EventTarget {
  constructor() {
    super();
    this.access = null;
    this.input = null;
    this.output = null;
    this.midiChannel = Number(storage('fm1.midiCh') || 1);
    this.fxChannel = Number(storage('fm1.fxCh') || 2);
    this.keysPlayPage = storage('fm1.keysPlayPage') === '1';
    // Turning a control on the instrument moves the same control on the page.
    this.followHw = storage('fm1.followHw') !== '0';
    this.stream = null;
    this.analyser = null;
    this.monitorGain = null;
    this.lastNote = null;
    this.supported = {
      midi: 'requestMIDIAccess' in navigator,
      audio: !!navigator.mediaDevices?.getUserMedia,
      bluetooth: BleMidi.supported,
    };
    this.ble = null;
    this._pending = new Map();
    this._timers = new Map();
    this.sounding = new Set(); // "channel:note" pairs we've sent note-ons for
    this.monitoring = false;
    // Leaving the page mid-chord shouldn't leave the FM-1 droning.
    window.addEventListener('pagehide', () => this.releaseAll());
    // A different device may match a port the last one didn't. Ports the
    // user picked by hand are remembered by id and still win.
    onDeviceChange(() => { if (this.access && !this.output) { this._pickPorts(); this._emit('change'); } });
  }

  // True while a Bluetooth MIDI connection is up (it then outranks USB).
  get bleActive() { return !!this.ble?.connected; }
  // True when there is somewhere to send to: Bluetooth or a USB output port.
  get canSend() { return this.bleActive || !!this.output; }

  get status() {
    const ble = this.bleActive ? `Bluetooth: ${this.ble.name}` : undefined;
    return {
      midiIn: this.bleActive || !!this.input, midiOut: this.canSend, audio: !!this.stream,
      inputName: ble ?? this.input?.name, outputName: ble ?? this.output?.name,
      bluetooth: this.ble?.state || 'idle', bluetoothName: this.ble?.device ? this.ble.name : undefined,
      audioName: this.stream?.getAudioTracks()[0]?.label,
    };
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // Reconnect quietly on page load if permission was already given.
  async autoConnect() {
    try {
      if (this.supported.midi && navigator.permissions) {
        const s = await navigator.permissions.query({ name: 'midi' });
        if (s.state === 'granted') await this.connectMidi();
      }
    } catch (_) { /* some browsers can't query MIDI permission */ }
    try {
      // Only reopen audio by itself if it was the FM-1 last time, never a laptop mic.
      if (this.supported.audio && navigator.permissions && storage('fm1.audioId') && storage('fm1.audioIsFm1') === '1') {
        const s = await navigator.permissions.query({ name: 'microphone' });
        if (s.state === 'granted') await this.connectAudio(storage('fm1.audioId'));
      }
    } catch (_) { /* ignore */ }
    // Bluetooth normally needs a tap on every page load. Where the browser
    // can hand back devices picked before (getDevices, not yet on by default
    // in Chrome), quietly reconnect to the last one.
    try {
      const id = storage('fm1.bleId');
      if (id && this.supported.bluetooth && navigator.bluetooth.getDevices && !this.ble?.device) {
        const dev = (await navigator.bluetooth.getDevices()).find((d) => d.id === id);
        if (dev) {
          const ble = this._bleLink();
          const timer = setTimeout(() => { if (ble.state === 'connecting') ble.disconnect(); }, 10000);
          try { await ble.open(dev); } finally { clearTimeout(timer); }
        }
      }
    } catch (_) { /* not reachable now: the button still works */ }
  }

  // ---------- Bluetooth MIDI ----------
  _bleLink() {
    if (this.ble) return this.ble;
    this.ble = new BleMidi({ onMessage: (data) => this._onMessage(data, 'ble'), retryDelays: globalThis.__bleRetryDelays, attemptTimeout: globalThis.__bleAttemptTimeout });
    let was = 'idle';
    this.ble.addEventListener('change', (e) => {
      const { state, reason } = e.detail;
      // Notes started over USB end over USB before Bluetooth takes over;
      // notes started over Bluetooth are let go of when it goes away (and
      // USB, if it's the same instrument, gets All Notes Off too).
      if (state === 'connecting' && was !== 'connected') this.releaseAll();
      if (was === 'connected' && state !== 'connected') this.releaseAll();
      if (state === 'connected' && this.ble.id) storage('fm1.bleId', this.ble.id);
      was = state;
      this._emit('bluetooth', { state, reason, name: this.ble.name });
      this._emit('change');
    });
    return this.ble;
  }

  // Open the browser's Bluetooth chooser. Call straight from a click handler:
  // Web Bluetooth only opens its chooser during a user gesture.
  connectBluetooth() {
    if (!this.supported.bluetooth) return Promise.reject(Object.assign(new Error('No Web Bluetooth'), { name: 'NotSupportedError' }));
    return this._bleLink().connect();
  }

  // Reconnect to the instrument chosen earlier, no chooser. For a tap after
  // the link was lost.
  resumeBluetooth() {
    return this._bleLink().resume();
  }

  // Let go of any notes over Bluetooth, wait for that to be written, then
  // disconnect. Forgets the device for the quiet reconnect on page load.
  async disconnectBluetooth() {
    storage('fm1.bleId', '');
    if (!this.ble) return;
    if (this.bleActive) {
      this.releaseAll();
      await this.ble.drain();
    }
    this.ble.disconnect();
  }

  // ---------- MIDI ----------
  async connectMidi() {
    if (!this.supported.midi) throw new Error('This browser has no Web MIDI. Use Chrome, Edge or Firefox.');
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => { this._pickPorts(); this._emit('change'); };
    }
    this._pickPorts();
    this._emit('change');
    return this.status;
  }

  ports() {
    if (!this.access) return { inputs: [], outputs: [] };
    return { inputs: [...this.access.inputs.values()], outputs: [...this.access.outputs.values()] };
  }

  _pickPorts() {
    const { inputs, outputs } = this.ports();
    const savedIn = storage('fm1.inId');
    const savedOut = storage('fm1.outId');
    // Among ports that match, prefer the model's own name over a generic one
    // ("USB-MIDI"), and a cable over Bluetooth: macOS lists an instrument
    // paired in Audio MIDI Setup as a port of its own, and USB is quicker.
    const rank = (p) => (GENERIC_PORT.test(p.name) ? 2 : 0) + (WIRELESS_PORT.test(p.name) ? 1 : 0);
    const pick = (list, saved) => list.find((p) => p.id === saved && p.state === 'connected')
      || list.filter((p) => portMatch().test(p.name) && p.state === 'connected').sort((a, b) => rank(a) - rank(b))[0] || null;
    this.selectInput(pick(inputs, savedIn)?.id ?? null, false);
    const out = pick(outputs, savedOut);
    if (out !== this.output && !this.bleActive) this.releaseAll();
    this.output = out;
  }

  selectInput(id, remember = true) {
    if (this.input) this.input.onmidimessage = null;
    this.input = id ? this.ports().inputs.find((p) => p.id === id) || null : null;
    // While Bluetooth is the link, USB input is ignored so an instrument on
    // both doesn't play every note twice.
    if (this.input) this.input.onmidimessage = (e) => { if (!this.bleActive) this._onMessage(e.data, 'usb'); };
    if (remember && id) storage('fm1.inId', id);
    this._emit('change');
  }

  selectOutput(id) {
    if (!this.bleActive) this.releaseAll();
    this.output = id ? this.ports().outputs.find((p) => p.id === id) || null : null;
    if (id) storage('fm1.outId', id);
    this._emit('change');
  }

  setChannels(midi, fx) {
    this.releaseAll();
    this.midiChannel = clamp(Number(midi) || 1, 1, 16);
    this.fxChannel = clamp(Number(fx) || 2, 1, 16);
    storage('fm1.midiCh', String(this.midiChannel));
    storage('fm1.fxCh', String(this.fxChannel));
    this._emit('change');
  }

  setKeysPlayPage(on) {
    this.keysPlayPage = !!on;
    storage('fm1.keysPlayPage', on ? '1' : '0');
    this._emit('change');
  }

  setFollowHw(on) {
    this.followHw = !!on;
    storage('fm1.followHw', on ? '1' : '0');
    this._emit('change');
  }

  // Pitch bend range in semitones each way, for the page's synth: the
  // instrument's own default when its profile gives one.
  get bendRange() { return device().bendRange ?? 2; }

  // Events: noteon, noteoff, cc (every Control Change, with its channel),
  // param (a CC the page knows, as a course parameter), bend (−1…1), mod and
  // pressure (0…1), sustain, program, and midi (every message, raw, with
  // `via`: 'usb' for a MIDI port, 'ble' for Bluetooth).
  _onMessage(data, via = 'usb') {
    const [status, d1, d2] = data;
    this._emit('midi', { data, via });
    if (status >= 0xf0) return; // clock and other system messages
    const type = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    if (type === 0x90 && d2 > 0) { this.lastNote = d1; this._emit('noteon', { note: d1, velocity: d2 / 127 }); }
    else if (type === 0x80 || (type === 0x90 && d2 === 0)) this._emit('noteoff', { note: d1 });
    else if (type === 0xb0) {
      this._emit('cc', { cc: d1, value: d2, channel });
      if (d1 === 1) this._emit('mod', { value: d2 / 127 });
      else if (d1 === 64) this._emit('sustain', { on: d2 >= 64 });
      else {
        const p = paramFromCc(d1, d2, channel, this.fxChannel);
        if (p) this._emit('param', { ...p, cc: d1, channel });
      }
    } else if (type === 0xe0) this._emit('bend', { value: clamp((((d2 << 7) | d1) - 8192) / 8191, -1, 1) });
    else if (type === 0xd0) this._emit('pressure', { value: d1 / 127 });
    else if (type === 0xc0) this._emit('program', { program: d1 });
  }

  _send(bytes) {
    if (this.bleActive) { this.ble.send(bytes); return; }
    if (!this.output) return;
    // A port can vanish mid-send (cable pulled); don't let that break the page.
    try { this.output.send(bytes); } catch (_) { /* port went away */ }
  }

  noteOn(note, velocity = 0.8) {
    const ch = this.midiChannel;
    this._send([0x90 | (ch - 1), note & 127, clamp(Math.round(velocity * 127), 1, 127)]);
    this.sounding.add(`${ch}:${note & 127}`);
  }

  noteOff(note) {
    const ch = this.midiChannel;
    this._send([0x80 | (ch - 1), note & 127, 0]);
    this.sounding.delete(`${ch}:${note & 127}`);
  }

  // Note-offs for everything we started, then All Notes Off for good measure.
  releaseAll() {
    if (!this.canSend) { this.sounding.clear(); return; }
    for (const key of this.sounding) {
      const [ch, note] = key.split(':').map(Number);
      this._send([0x80 | (ch - 1), note, 0]);
    }
    this.sounding.clear();
    this._send([0xb0 | (this.midiChannel - 1), 123, 0]);
  }

  cc(num, value, channel = this.midiChannel) {
    // A direct send supersedes any throttled value still waiting for this CC.
    this._pending.delete(`${channel}:${num}`);
    this._send([0xb0 | (channel - 1), num & 127, clamp(Math.round(value), 0, 127)]);
  }

  // Send one setting now, but no more than ~30 times a second per CC, so a
  // dragged slider doesn't flood the FM-1.
  ccThrottled(num, value, channel = this.midiChannel) {
    const key = `${channel}:${num}`;
    this._pending.set(key, [num, value, channel]);
    if (this._timers.has(key)) return;
    this._pending.delete(key);
    this._send([0xb0 | (channel - 1), num & 127, clamp(Math.round(value), 0, 127)]);
    this._timers.set(key, setTimeout(() => {
      this._timers.delete(key);
      const p = this._pending.get(key);
      if (p) { this._pending.delete(key); this.ccThrottled(...p); }
    }, 33));
  }

  // Set one course parameter on the FM-1. Returns false if it has no CC.
  sendParam(key, value, throttled = true) {
    if (!this.canSend) return false;
    const num = vaCc(key);
    if (num === undefined) return false;
    (throttled ? this.ccThrottled : this.cc).call(this, num, ccValue(key, value));
    return true;
  }

  sendFx(effect, key, value) {
    if (!this.canSend) return false;
    const num = fxCc(effect, key);
    if (num === undefined) return false;
    let raw = value;
    if (key === 'on') raw = value ? 127 : 0;
    else if (key === 'type') raw = Math.max(0, REVERB_TYPES.indexOf(value));
    this.ccThrottled(num, raw, this.fxChannel);
    return true;
  }

  // Send a whole patch. Returns how many settings went out.
  sendPatch(params) {
    if (!this.canSend) return 0;
    let n = 0;
    for (const key of Object.keys(VA_CC)) {
      const num = vaCc(key);
      if (params[key] === undefined || num === undefined) continue;
      this.cc(num, ccValue(key, params[key]));
      n++;
    }
    for (const effect of Object.keys(FX_CC)) {
      const fx = params.fx?.[effect];
      if (!fx) continue;
      for (const key of Object.keys(FX_CC[effect])) {
        const num = fxCc(effect, key);
        if (fx[key] === undefined || num === undefined) continue;
        let raw = fx[key];
        if (key === 'on') raw = fx[key] ? 127 : 0;
        else if (key === 'type') raw = Math.max(0, REVERB_TYPES.indexOf(fx[key]));
        this.cc(num, raw, this.fxChannel);
        n++;
      }
    }
    return n;
  }

  // ---------- Audio ----------
  async audioInputs() {
    if (!this.supported.audio) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  async connectAudio(deviceId) {
    if (!this.supported.audio) throw new Error('This browser can’t record audio input.');
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } });
      // First time through, device names appear only after permission. If the
      // FM-1 is plugged in but we opened the default mic, switch to the FM-1.
      if (!deviceId) {
        const fm = (await this.audioInputs()).find((d) => audioMatch().test(d.label));
        const current = stream.getAudioTracks()[0]?.getSettings().deviceId;
        if (fm && fm.deviceId !== current) {
          stream.getTracks().forEach((t) => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: fm.deviceId } } });
        }
      }
    } catch (err) {
      this._emit('change');
      throw err;
    }
    // The new stream is open; only now let go of the old one.
    this.disconnectAudio(false);
    const { ctx, master } = audio();
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.6;
    this.source.connect(this.analyser);
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = this.monitoring ? 1 : 0;
    this.source.connect(this.monitorGain).connect(master);
    const track = stream.getAudioTracks()[0];
    const id = track?.getSettings().deviceId;
    if (id) storage('fm1.audioId', id);
    storage('fm1.audioIsFm1', audioMatch().test(track?.label || '') ? '1' : '0');
    if (track) track.onended = () => this.disconnectAudio();
    this._emit('change');
    return this.status;
  }

  // True when the open audio input looks like the selected device.
  get isDeviceAudio() { return audioMatch().test(this.stream?.getAudioTracks()[0]?.label || ''); }
  get isFm1Audio() { return this.isDeviceAudio; }

  disconnectAudio(emit = true) {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.monitorGain?.disconnect();
    this.stream = null;
    this.source = null;
    this.analyser = null;
    if (emit) this._emit('change');
  }

  // Play the FM-1's input through the page's speakers. Off by default: if the
  // FM-1 is already in your headphones you'd hear it twice.
  monitor(on) {
    this.monitoring = !!on;
    if (this.monitorGain) this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, audio().ctx.currentTime, 0.02);
  }
}

export const fm1 = new FM1Link();
