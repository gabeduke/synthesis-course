// AKS link: plays a Behringer AKS Mini from the page over USB (or DIN) MIDI.
//
//  * MIDI out: notes, pitch bend, and the Control Change numbers in Behringer's
//              Quick Start Guide (see AKS_CC in ../audio/aks-core.js).
//  * MIDI in:  not used. The AKS Mini has no DIN MIDI Out; whether it sends
//              anything over USB isn't documented.
//
// It shares the page's one Web MIDI permission with the FM-1 link (fm1.js):
// connecting either connects both, and each picks its own port. The page never
// sends SysEx, so it can't overwrite the AKS Mini's memories.
//
// UNVERIFIED: the name the AKS Mini gives its USB MIDI port. The page picks
// any output with "AKS" in its name; if that misses, choose the port by hand.

import { fm1 } from './fm1.js';
import { AKS_CC, aksCcValue, bendBytes } from '../audio/aks-core.js';

export const AKS_PORT = /aks/i;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (_) { /* storage blocked: preferences just won't persist */ }
  return null;
}

class AksLink extends EventTarget {
  constructor() {
    super();
    this.output = null;
    this.channel = clamp(Number(storage('aks.ch')) || 1, 1, 16);
    this.sounding = new Set();
    this._pending = new Map();
    this._timers = new Map();
    fm1.addEventListener('change', () => this._refresh());
    window.addEventListener('pagehide', () => this.releaseAll());
  }

  get supported() { return fm1.supported.midi; }
  get access() { return fm1.access; }
  get connected() { return !!this.output && this.output.state === 'connected'; }
  outputs() { return fm1.ports().outputs; }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // Ask for MIDI (once per site; the browser remembers) and pick the port.
  async connect() {
    await fm1.connectMidi();
    this._refresh();
    return this.connected;
  }

  // A port appeared or went away, or MIDI was just switched on.
  _refresh() {
    if (!fm1.access) return;
    const outs = this.outputs().filter((p) => p.state === 'connected');
    const saved = storage('aks.outId');
    const pick = outs.find((p) => p.id === saved) || outs.find((p) => AKS_PORT.test(p.name)) || null;
    if (this.output && !outs.includes(this.output)) this.output = null;
    if (!this.output && pick) this.output = pick;
    this._emit('change');
  }

  selectOutput(id) {
    this.releaseAll();
    this.output = id ? this.outputs().find((p) => p.id === id) || null : null;
    if (id) storage('aks.outId', id);
    this._emit('change');
  }

  setChannel(ch) {
    this.releaseAll();
    this.channel = clamp(Number(ch) || 1, 1, 16);
    storage('aks.ch', String(this.channel));
    this._emit('change');
  }

  _send(bytes) {
    if (!this.output) return;
    // A port can vanish mid-send (cable pulled); don't let that break the page.
    try { this.output.send(bytes); } catch (_) { /* port went away */ }
  }

  noteOn(note, velocity = 0.8) {
    const ch = this.channel;
    this._send([0x90 | (ch - 1), note & 127, clamp(Math.round(velocity * 127), 1, 127)]);
    this.sounding.add(`${ch}:${note & 127}`);
  }

  noteOff(note) {
    const ch = this.channel;
    this._send([0x80 | (ch - 1), note & 127, 0]);
    this.sounding.delete(`${ch}:${note & 127}`);
  }

  // Note-offs for everything we started, then All Notes Off for good measure.
  releaseAll() {
    if (!this.output) { this.sounding.clear(); return; }
    for (const key of this.sounding) {
      const [ch, note] = key.split(':').map(Number);
      this._send([0x80 | (ch - 1), note, 0]);
    }
    this.sounding.clear();
    this._send([0xb0 | (this.channel - 1), 123, 0]);
  }

  // Pitch bend, −1 to 1. How far that bends is the AKS Mini's business.
  bend(x) {
    const [lsb, msb] = bendBytes(x);
    this._send([0xe0 | (this.channel - 1), lsb, msb]);
  }

  cc(num, value) {
    this._pending.delete(num);
    this._send([0xb0 | (this.channel - 1), num & 127, clamp(Math.round(value), 0, 127)]);
  }

  // At most ~30 messages a second per CC, so a dragged slider or the
  // joystick doesn't flood the AKS Mini. The last value always gets through.
  ccThrottled(num, value) {
    this._pending.set(num, value);
    if (this._timers.has(num)) return;
    this._pending.delete(num);
    this.cc(num, value);
    this._timers.set(num, setTimeout(() => {
      this._timers.delete(num);
      if (this._pending.has(num)) {
        const v = this._pending.get(num);
        this._pending.delete(num);
        this.ccThrottled(num, v);
      }
    }, 33));
  }

  // Set one control on the AKS Mini. Returns false if it has no CC.
  sendParam(key, value, throttled = true) {
    if (!this.output) return false;
    const v = aksCcValue(key, value);
    if (v === undefined) return false;
    (throttled ? this.ccThrottled : this.cc).call(this, AKS_CC[key], v);
    return true;
  }

  // Send every control that has a CC. Returns how many went out.
  sendPatch(params) {
    if (!this.output) return 0;
    let n = 0;
    for (const key of Object.keys(AKS_CC)) {
      if (params[key] === undefined) continue;
      if (this.sendParam(key, params[key], false)) n++;
    }
    return n;
  }
}

export const aks = new AksLink();
