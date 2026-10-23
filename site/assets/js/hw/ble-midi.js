// Bluetooth MIDI: the standard "MIDI over Bluetooth Low Energy" profile, spoken
// directly from the page with Web Bluetooth.
//
// Why this exists: Chrome on Android only lists a Bluetooth MIDI instrument as
// a Web MIDI port when the operating system has opened it as one, which a
// plain Bluetooth pairing doesn't do. Talking GATT ourselves skips that step.
//
// The protocol (BLE-MIDI 1.0) in brief. One characteristic carries everything:
// the instrument notifies it with packets, and we write packets to it.
//
//   packet   = header, then one or more messages
//   header   = 1 0 t t t t t t   (the top 6 bits of a 13-bit ms timestamp)
//   message  = timestamp-low, status, data…
//   ts-low   = 1 t t t t t t t   (the low 7 bits)
//
// Inside a packet, running status lets data bytes follow without a new status
// (with or without a fresh ts-low before them). SysEx starts with ts-low F0,
// continues in later packets as plain data right after the header, and ends
// with ts-low F7. Real-time bytes (F8–FF) may appear anywhere, each with its
// own ts-low, even in the middle of a SysEx.
//
// The parser and packet builder below are pure functions so they can be
// tested in Node (scripts/test_ble_midi.mjs).

export const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
export const BLE_MIDI_CHARACTERISTIC = '7772e5db-3868-4112-a1a9-f2669d106bf3';

// Bytes per write. Web Bluetooth doesn't expose the negotiated MTU; 20 bytes
// (the BLE minimum ATT MTU of 23, less 3 bytes of overhead) always fits.
export const BLE_PACKET_SIZE = 20;

const MAX_SYSEX = 4096; // longer SysEx is dropped rather than buffered forever

// Data bytes after a status byte. F4/F5 are undefined and F6 has none.
function dataLength(status) {
  if (status < 0xf0) {
    const t = status & 0xf0;
    return t === 0xc0 || t === 0xd0 ? 1 : 2;
  }
  if (status === 0xf1 || status === 0xf3) return 1;
  if (status === 0xf2) return 2;
  return 0;
}

export function createParserState() {
  return { running: 0, sysex: null, lastTime: 0 };
}

// Parse one notification. Returns [{ data: Uint8Array, time }] where time is
// the packet's 13-bit millisecond timestamp. Never throws: malformed input
// stops parsing that packet and is otherwise ignored. `state` carries running
// status and an unfinished SysEx from one packet to the next. SysEx comes out
// whole (F0 … F7) as one message once its end arrives.
export function parseBlePacket(input, state = createParserState()) {
  const out = [];
  let bytes;
  try {
    bytes = input instanceof Uint8Array ? input
      : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
  } catch (_) { return out; }
  const n = bytes.length;
  // Bit 6 of the header is reserved (0); don't reject a device that sets it.
  if (n < 2 || !(bytes[0] & 0x80)) return out;

  let high = bytes[0] & 0x3f;
  let lastLow = -1;
  let time = state.lastTime;
  const stamp = (low) => {
    // ts-low going backwards inside a packet means it wrapped: carry into high.
    if (lastLow >= 0 && low < lastLow) high = (high + 1) & 0x3f;
    lastLow = low;
    time = (high << 7) | low;
    state.lastTime = time;
  };
  const emit = (arr) => out.push({ data: Uint8Array.from(arr), time });

  // Read one channel / system-common message for `status` whose data starts
  // at i. Returns the index after it, or -1 if the packet ran out.
  const readData = (status, i) => {
    const len = dataLength(status);
    if (i + len > n) return -1;
    const msg = [status];
    for (let k = 0; k < len; k++) {
      const b = bytes[i + k];
      if (b & 0x80) return -1;
      msg.push(b);
    }
    emit(msg);
    return i + len;
  };

  let i = 1;
  while (i < n) {
    const b = bytes[i];
    if (!(b & 0x80)) {
      // Data with no timestamp: SysEx continuing, or running status.
      if (state.sysex) {
        if (state.sysex.length < MAX_SYSEX) state.sysex.push(b);
        else state.sysex = null; // too long: drop it
        i++;
      } else if (state.running) {
        const next = readData(state.running, i);
        if (next < 0) break;
        i = next;
      } else i++; // stray data byte
      continue;
    }

    // A timestamp byte. The next byte is a status, or data under running status.
    stamp(b & 0x7f);
    i++;
    if (i >= n) break;
    const s = bytes[i];
    if (!(s & 0x80)) {
      if (state.sysex) continue; // ts-low only precedes F7 or real-time in SysEx
      if (!state.running) { i++; continue; }
      const next = readData(state.running, i);
      if (next < 0) break;
      i = next;
      continue;
    }
    i++;
    if (s >= 0xf8) { emit([s]); continue; } // real-time: touches nothing else
    if (s === 0xf7) {
      if (state.sysex) { state.sysex.push(0xf7); emit(state.sysex); }
      state.sysex = null;
      continue;
    }
    if (s === 0xf0) { state.sysex = [0xf0]; state.running = 0; continue; }
    state.sysex = null; // any other status ends an unfinished SysEx
    state.running = s < 0xf0 ? s : 0;
    const next = readData(s, i);
    if (next < 0) break;
    i = next;
  }
  return out;
}

// The current time as the protocol's 13-bit millisecond counter.
export function bleTimestamp(now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
  return Math.floor(now) & 0x1fff;
}

// Pack short MIDI messages (1–3 bytes each, no SysEx) into BLE-MIDI packets of
// at most `size` bytes, all stamped with `time`. Every message gets its own
// ts-low and full status byte, which is valid and keeps receivers simple.
// Invalid messages are skipped.
export function buildBlePackets(messages, time = bleTimestamp(), size = BLE_PACKET_SIZE) {
  const header = 0x80 | ((time >> 7) & 0x3f);
  const low = 0x80 | (time & 0x7f);
  const packets = [];
  let cur = null;
  for (const m of messages) {
    if (!m || !m.length || m.length > 3 || !(m[0] & 0x80) || m[0] === 0xf0 || m[0] === 0xf7) continue;
    if (m.length - 1 < dataLength(m[0]) && m[0] < 0xf8) continue;
    const need = 1 + m.length;
    if (!cur || cur.length + need > size) {
      if (cur) packets.push(Uint8Array.from(cur));
      cur = [header];
    }
    cur.push(low);
    for (let k = 0; k < m.length; k++) cur.push(k === 0 ? m[k] : m[k] & 0x7f);
  }
  if (cur && cur.length > 1) packets.push(Uint8Array.from(cur));
  return packets;
}

// Sort a Web Bluetooth error into what the page should say. `phase` is where
// it happened: 'pick' (the chooser), 'gatt' (connecting) or 'service'.
export function bleErrorKind(err) {
  const name = err?.name;
  if (err?.blePhase === 'pick') {
    if (name === 'NotFoundError' || name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
    if (name === 'SecurityError') return 'insecure';
    return 'gatt';
  }
  if (err?.blePhase === 'service' || name === 'NotFoundError') return 'no-service';
  if (name === 'SecurityError') return 'insecure';
  return 'gatt';
}

const MAX_QUEUE = 512;

// One Bluetooth MIDI instrument. Events: 'change' whenever `state` changes,
// with detail { state, reason } where reason is 'manual', 'lost' or
// 'reconnected' for the disconnect path.
//   state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'
export class BleMidi extends EventTarget {
  constructor({ onMessage, onSysex } = {}) {
    super();
    this.onMessage = onMessage || (() => {});
    this.onSysex = onSysex || (() => {});
    this.device = null;
    this.characteristic = null;
    this.state = 'idle';
    this._parser = createParserState();
    this._queue = [];
    this._flushing = false;
    this._manual = false;
    this._onValue = (e) => this._receive(e.target.value);
    this._onGone = () => this._disconnected();
  }

  static get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  get connected() { return this.state === 'connected'; }
  get name() { return this.device?.name || 'Bluetooth MIDI device'; }
  get id() { return this.device?.id || null; }

  _set(state, reason) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('change', { detail: { state, reason } }));
  }

  // Open the browser's device chooser and connect to what the user picks.
  // Must be called straight from a click or key press: requestDevice is the
  // first thing it does, so the user gesture is still live.
  async connect() {
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE_MIDI_SERVICE] }],
        optionalServices: [BLE_MIDI_SERVICE],
      });
    } catch (err) { err.blePhase = 'pick'; throw err; }
    if (this.device && this.device !== device) this.disconnect();
    await this.open(device);
    return device;
  }

  // Connect to a device already chosen (from connect(), or getDevices()).
  async open(device) {
    this._manual = false;
    this._retried = false;
    if (this.device !== device) {
      this.device?.removeEventListener('gattserverdisconnected', this._onGone);
      this.device = device;
      device.addEventListener('gattserverdisconnected', this._onGone);
    }
    this._set('connecting');
    try {
      await this._attach();
    } catch (err) {
      this._detachCharacteristic();
      this._manual = true; // our own clean-up, not a lost connection
      try { device.gatt?.connected && device.gatt.disconnect(); } catch (_) { /* ignore */ }
      this._set('idle');
      throw err;
    }
    this._set('connected');
  }

  async _attach() {
    let server;
    try { server = await this.device.gatt.connect(); } catch (err) { err.blePhase ||= 'gatt'; throw err; }
    let ch;
    try {
      const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
      ch = await service.getCharacteristic(BLE_MIDI_CHARACTERISTIC);
    } catch (err) { err.blePhase = err.name === 'NotFoundError' ? 'service' : 'gatt'; throw err; }
    this._detachCharacteristic();
    this._parser = createParserState();
    ch.addEventListener('characteristicvaluechanged', this._onValue);
    this.characteristic = ch;
    try { await ch.startNotifications(); } catch (err) { err.blePhase = 'gatt'; throw err; }
  }

  _detachCharacteristic() {
    this.characteristic?.removeEventListener('characteristicvaluechanged', this._onValue);
    this.characteristic = null;
    this._queue.length = 0;
  }

  disconnect() {
    if (!this.device) return;
    this._manual = true;
    const gatt = this.device.gatt;
    this._detachCharacteristic();
    try { if (gatt?.connected) gatt.disconnect(); } catch (_) { /* ignore */ }
    // Some platforms don't fire gattserverdisconnected for our own disconnect.
    if (this.state !== 'idle') this._set('idle', 'manual');
  }

  async _disconnected() {
    this._detachCharacteristic();
    if (this._manual) { if (this.state !== 'idle') this._set('idle', 'manual'); return; }
    // Only a live connection can be lost: a drop while connecting is reported
    // by open() itself, and one during the retry by the retry.
    if (this.state !== 'connected') return;
    // One quiet retry: reconnecting to a device the user already picked needs
    // no new gesture. If that fails, report it and stop.
    if (!this._retried && this.device) {
      this._retried = true;
      this._set('reconnecting', 'lost');
      try {
        await this._attach();
        if (this._manual) return;
        this._retried = false; // a later drop gets its own retry
        this._set('connected', 'reconnected');
        return;
      } catch (_) {
        this._detachCharacteristic();
      }
    }
    if (!this._manual) this._set('disconnected', 'lost');
  }

  _receive(view) {
    if (!view) return;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (const { data } of parseBlePacket(bytes, this._parser)) {
      try {
        if (data[0] === 0xf0) this.onSysex(data); else this.onMessage(data);
      } catch (err) { console.error(err); }
    }
  }

  // Queue one short MIDI message. Messages sent in the same task are packed
  // together, and writes go out one at a time: a second GATT write started
  // before the first resolves fails with "GATT operation already in progress".
  send(bytes) {
    if (!this.connected || !this.characteristic) return false;
    if (this._queue.length >= MAX_QUEUE) this._queue.shift(); // the link is stalled; keep the newest
    this._queue.push(Array.from(bytes));
    if (!this._flushing) {
      this._flushing = true;
      this._drained = new Promise((resolve) => { this._resolveDrained = resolve; });
      queueMicrotask(() => this._flush());
    }
    return true;
  }

  // Resolves once everything queued has been written (or after `ms`).
  drain(ms = 500) {
    if (!this._flushing) return Promise.resolve();
    return Promise.race([this._drained, new Promise((r) => setTimeout(r, ms))]);
  }

  async _flush() {
    try {
      while (this._queue.length && this.characteristic) {
        const batch = this._queue.splice(0, this._queue.length);
        for (const packet of buildBlePackets(batch)) {
          const ch = this.characteristic;
          if (!ch) return;
          try {
            if (ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(packet);
            else await ch.writeValue(packet);
          } catch (err) {
            // Disconnected mid-write: drop what's left. Anything else: skip
            // this packet and carry on.
            if (!this.device?.gatt?.connected) { this._queue.length = 0; return; }
          }
        }
      }
    } finally {
      this._flushing = false;
      this._resolveDrained?.();
    }
  }
}
