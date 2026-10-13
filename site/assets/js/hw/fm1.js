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

import { audio, clamp } from '../audio/core.js';

const PORT_MATCH = /fm-?1|ota-fm|felucca|usb composite device|usb-midi/i;
const AUDIO_MATCH = /fm-?1/i;

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
    this.stream = null;
    this.analyser = null;
    this.monitorGain = null;
    this.lastNote = null;
    this.supported = { midi: 'requestMIDIAccess' in navigator, audio: !!navigator.mediaDevices?.getUserMedia };
    this._pending = new Map();
    this._timers = new Map();
  }

  get status() {
    return {
      midiIn: !!this.input, midiOut: !!this.output, audio: !!this.stream,
      inputName: this.input?.name, outputName: this.output?.name,
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
      if (this.supported.audio && navigator.permissions && storage('fm1.audioId')) {
        const s = await navigator.permissions.query({ name: 'microphone' });
        if (s.state === 'granted') await this.connectAudio(storage('fm1.audioId'));
      }
    } catch (_) { /* ignore */ }
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
    const pick = (list, saved) => list.find((p) => p.id === saved && p.state === 'connected')
      || list.find((p) => PORT_MATCH.test(p.name) && p.state === 'connected') || null;
    this.selectInput(pick(inputs, savedIn)?.id ?? null, false);
    this.output = pick(outputs, savedOut);
  }

  selectInput(id, remember = true) {
    if (this.input) this.input.onmidimessage = null;
    this.input = id ? this.ports().inputs.find((p) => p.id === id) || null : null;
    if (this.input) this.input.onmidimessage = (e) => this._onMessage(e.data);
    if (remember && id) storage('fm1.inId', id);
    this._emit('change');
  }

  selectOutput(id) {
    this.output = id ? this.ports().outputs.find((p) => p.id === id) || null : null;
    if (id) storage('fm1.outId', id);
    this._emit('change');
  }

  setChannels(midi, fx) {
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

  _onMessage(data) {
    const [status, d1, d2] = data;
    const type = status & 0xf0;
    if (type === 0x90 && d2 > 0) { this.lastNote = d1; this._emit('noteon', { note: d1, velocity: d2 / 127 }); }
    else if (type === 0x80 || (type === 0x90 && d2 === 0)) this._emit('noteoff', { note: d1 });
    else if (type === 0xb0) this._emit('cc', { cc: d1, value: d2 });
  }

  _send(bytes) { if (this.output) this.output.send(bytes); }

  noteOn(note, velocity = 0.8) {
    this._send([0x90 | (this.midiChannel - 1), note & 127, clamp(Math.round(velocity * 127), 1, 127)]);
  }

  noteOff(note) { this._send([0x80 | (this.midiChannel - 1), note & 127, 0]); }

  allNotesOff() { this._send([0xb0 | (this.midiChannel - 1), 123, 0]); }

  cc(num, value, channel = this.midiChannel) {
    this._send([0xb0 | (channel - 1), num & 127, clamp(Math.round(value), 0, 127)]);
  }

  // Send one setting now, but no more than ~30 times a second per CC, so a
  // dragged slider doesn't flood the FM-1.
  ccThrottled(num, value, channel = this.midiChannel) {
    const key = `${channel}:${num}`;
    this._pending.set(key, [num, value, channel]);
    if (this._timers.has(key)) return;
    this.cc(num, value, channel);
    this._pending.delete(key);
    this._timers.set(key, setTimeout(() => {
      this._timers.delete(key);
      const p = this._pending.get(key);
      if (p) { this._pending.delete(key); this.cc(...p); }
    }, 33));
  }

  // Set one course parameter on the FM-1. Returns false if it has no CC.
  sendParam(key, value, throttled = true) {
    if (!this.output) return false;
    const num = VA_CC[key];
    if (num === undefined) return false;
    (throttled ? this.ccThrottled : this.cc).call(this, num, ccValue(key, value));
    return true;
  }

  sendFx(effect, key, value) {
    if (!this.output) return false;
    const num = FX_CC[effect]?.[key];
    if (num === undefined) return false;
    let raw = value;
    if (key === 'on') raw = value ? 127 : 0;
    else if (key === 'type') raw = Math.max(0, REVERB_TYPES.indexOf(value));
    this.ccThrottled(num, raw, this.fxChannel);
    return true;
  }

  // Send a whole patch. Returns how many settings went out.
  sendPatch(params) {
    if (!this.output) return 0;
    let n = 0;
    for (const key of Object.keys(VA_CC)) {
      if (params[key] === undefined) continue;
      this.cc(VA_CC[key], ccValue(key, params[key]));
      n++;
    }
    for (const effect of Object.keys(FX_CC)) {
      const fx = params.fx?.[effect];
      if (!fx) continue;
      for (const key of Object.keys(FX_CC[effect])) {
        if (fx[key] === undefined) continue;
        let raw = fx[key];
        if (key === 'on') raw = fx[key] ? 127 : 0;
        else if (key === 'type') raw = Math.max(0, REVERB_TYPES.indexOf(fx[key]));
        this.cc(FX_CC[effect][key], raw, this.fxChannel);
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
    const constraints = {
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };
    this.disconnectAudio(false);
    let stream = await navigator.mediaDevices.getUserMedia(constraints);
    // First time through, labels appear only after permission. If the FM-1
    // is plugged in but we opened the default mic, switch to the FM-1.
    if (!deviceId) {
      const fm = (await this.audioInputs()).find((d) => AUDIO_MATCH.test(d.label));
      const current = stream.getAudioTracks()[0]?.getSettings().deviceId;
      if (fm && fm.deviceId !== current) {
        stream.getTracks().forEach((t) => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...constraints.audio, deviceId: { exact: fm.deviceId } } });
      }
    }
    const { ctx, master } = audio();
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.6;
    this.source.connect(this.analyser);
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.source.connect(this.monitorGain).connect(master);
    const id = stream.getAudioTracks()[0]?.getSettings().deviceId;
    if (id) storage('fm1.audioId', id);
    stream.getAudioTracks()[0].onended = () => this.disconnectAudio();
    this._emit('change');
    return this.status;
  }

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
    if (this.monitorGain) this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, audio().ctx.currentTime, 0.02);
  }

  // Record a few seconds of FM-1 audio into a buffer (used by the granular lab).
  async capture(seconds = 3) {
    if (!this.source) throw new Error('Connect the FM-1’s audio first.');
    const { ctx } = audio();
    const frames = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const out = buffer.getChannelData(0);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    let pos = 0;
    return new Promise((resolve) => {
      proc.onaudioprocess = (e) => {
        const inp = e.inputBuffer.getChannelData(0);
        const n = Math.min(inp.length, frames - pos);
        out.set(inp.subarray(0, n), pos);
        pos += n;
        if (pos >= frames) {
          proc.disconnect(); this.source.disconnect(proc); sink.disconnect();
          resolve(buffer);
        }
      };
      this.source.connect(proc);
      proc.connect(sink).connect(ctx.destination);
    });
  }
}

export const fm1 = new FM1Link();
