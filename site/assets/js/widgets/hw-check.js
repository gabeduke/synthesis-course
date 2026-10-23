// <hw-check> — try each control on the instrument and watch it arrive.
//
// A checklist that ticks itself off from the MIDI coming in: keys, wheels,
// pedal, knobs, faders, pads, program changes, clock, Bluetooth, and the
// instrument's sound on its USB audio input. Each row says what to do on
// the selected device and shows what was seen (note range, wheel range, the
// numbers the pads send …). "Copy report" writes it all up as plain text, so
// what a unit really does can go back into hw/devices.js and the README.
//
// Rows marked for one device appear only while it's selected.

import { fm1, paramFromCc } from '../hw/fm1.js';
import { noteName, playingLevel } from '../audio/core.js';
import { el } from '../ui/controls.js';
import { PARAMS } from '../ui/params.js';
import { device, deviceLabel, onDeviceChange } from '../ui/device.js';

const range = (lo, hi, fmt = String) => (lo === hi ? fmt(lo) : `${fmt(lo)} to ${fmt(hi)}`);
const nameOf = (key) => (key.startsWith('fx.') ? `${key.split('.')[1]} ${PARAMS[key]?.label.toLowerCase()}` : PARAMS[key]?.label || key);

// Each row: id, what to do (per device), and how to read the messages.
// update(state, msg, all) returns true when it changed something; `all` is
// every row's state, keyed by id.
const ROWS = [
  {
    id: 'keys', label: 'Keys',
    how: { fm1: 'Play a few keys, soft and hard.', smk37: 'Play a few keys, soft and hard, low and high.' },
    update(s, m, all) {
      if (m.type !== 'noteon' || all.pads?.padListen) return false; // a pad, not a key
      s.lo = Math.min(s.lo ?? 127, m.note); s.hi = Math.max(s.hi ?? 0, m.note);
      s.vlo = Math.min(s.vlo ?? 127, m.vel); s.vhi = Math.max(s.vhi ?? 0, m.vel);
      s.n = (s.n || 0) + 1;
      s.done = s.n >= 3;
      return true;
    },
    show: (s) => s.n && `${range(s.lo, s.hi, noteName)}, velocity ${range(s.vlo, s.vhi)}`,
  },
  {
    id: 'bend', label: 'Pitch wheel', devices: ['smk37'],
    how: { smk37: 'Push the PITCH wheel all the way up, then all the way down.' },
    update(s, m) {
      if (m.type !== 'bend') return false;
      s.lo = Math.min(s.lo ?? 0, m.raw); s.hi = Math.max(s.hi ?? 0, m.raw);
      s.done = s.lo <= -8000 && s.hi >= 8000;
      s.partial = !s.done;
      return true;
    },
    show: (s) => s.lo !== undefined && `${range(s.lo, s.hi, (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0'))} (of −8192 to +8191)`,
  },
  {
    id: 'mod', label: 'Mod wheel', devices: ['smk37'],
    how: { smk37: 'Roll the MOD wheel from the bottom to the top.' },
    update(s, m) {
      if (m.type !== 'cc' || m.cc !== 1) return false;
      s.lo = Math.min(s.lo ?? 127, m.value); s.hi = Math.max(s.hi ?? 0, m.value);
      s.done = s.lo === 0 && s.hi === 127;
      s.partial = !s.done;
      return true;
    },
    show: (s) => s.lo !== undefined && `CC 1, ${range(s.lo, s.hi)}`,
  },
  {
    id: 'pedal', label: 'Sustain pedal', devices: ['smk37'],
    how: { smk37: 'Press and release the pedal (plugged in before switching on).' },
    update(s, m) {
      if (m.type !== 'cc' || m.cc !== 64) return false;
      if (m.value >= 64) s.down = true; else s.up = true;
      s.done = s.down && s.up;
      s.partial = !s.done;
      return true;
    },
    show: (s) => (s.down || s.up) && `CC 64${s.down ? ', down' : ''}${s.up ? ', up' : ''}`,
  },
  {
    id: 'sendcc', label: 'Settings sent as controls',
    how: {
      fm1: 'Change a few settings on the FM-1: Super, Detune, an effect’s Mix. If nothing arrives, the FM-1+VA version on your unit may not send them.',
      smk37: 'Switch on GLOBE › MIDI › Send CC, then change a few settings in PARA or FX: Super, Detune, an effect’s Mix. (Cutoff, Resonance, Attack and Release send the same numbers as the CC bank below, so they count there.)',
    },
    update(s, m) {
      if (m.type !== 'cc') return false;
      const p = paramFromCc(m.cc, m.value, m.channel, fm1.fxChannel);
      const bank = m.channel !== fm1.fxChannel && [74, 71, 73, 72, 7, 91, 93].includes(m.cc);
      if (!p || bank) return false; // those could be the knob or fader bank
      (s.keys ||= new Set()).add(p.key);
      s.done = s.keys.size >= 2;
      s.partial = !s.done;
      return true;
    },
    show: (s) => s.keys && [...s.keys].map(nameOf).join(', '),
  },
  {
    id: 'ccbank', label: 'K5–K8 on the MIDI CC bank', devices: ['smk37'],
    how: { smk37: 'Put the knobs on the MIDI CC bank (KNOB BANK, then choose MIDI CC) and turn K5, K6, K7 and K8.' },
    update(s, m) {
      if (m.type !== 'cc' || ![74, 71, 73, 72].includes(m.cc)) return false;
      (s.seen ||= new Set()).add(m.cc);
      s.done = s.seen.size === 4;
      s.partial = !s.done;
      return true;
    },
    show: (s) => s.seen && [74, 71, 73, 72].map((n) => `${s.seen.has(n) ? '✓' : '·'} CC ${n}`).join('  '),
  },
  {
    id: 'faders', label: 'Faders on the MIDI CC bank', devices: ['smk37'],
    how: { smk37: 'Put the faders on the MIDI CC bank (FADER BANK, then MIDI CC) and move all four.' },
    update(s, m) {
      if (m.type !== 'cc' || ![7, 10, 91, 93].includes(m.cc) || m.channel === fm1.fxChannel) return false;
      (s.seen ||= new Set()).add(m.cc);
      s.done = s.seen.size === 4;
      s.partial = !s.done;
      return true;
    },
    show: (s) => s.seen && [7, 10, 91, 93].map((n) => `${s.seen.has(n) ? '✓' : '·'} CC ${n}`).join('  '),
  },
  {
    id: 'pads', label: 'Pads', devices: ['smk37'], listen: true,
    how: { smk37: 'Switch the pads to their Notes bank (KNOB BANK and FADER BANK together), press Listen for pads, then tap all sixteen from the first to the last.' },
    update(s, m) {
      if (!s.padListen) return false;
      if (m.type === 'pressure' || m.type === 'keypressure') { s.pressure = true; return true; }
      if (m.type !== 'noteon') return false;
      (s.notes ||= []);
      if (!s.notes.includes(m.note)) s.notes.push(m.note);
      s.done = s.notes.length >= 16;
      s.partial = !s.done;
      if (s.done) s.padListen = false;
      return true;
    },
    show: (s) => s.notes?.length && `${s.notes.map((n) => `${noteName(n)} (${n})`).join(' ')}${s.pressure ? '; pressure arrives too' : ''}`,
  },
  {
    id: 'program', label: 'Preset changes',
    how: {
      fm1: 'Turn PRESETS. If nothing arrives, the FM-1 doesn’t send preset changes.',
      smk37: 'Switch on GLOBE › MIDI › Send Prog Chg, then turn K3 to another preset (save your changes first: K3 drops them).',
    },
    update(s, m) {
      if (m.type !== 'program') return false;
      (s.seen ||= []).push(m.program + 1);
      s.done = true;
      return true;
    },
    show: (s) => s.seen && `preset ${s.seen.slice(-6).map((n) => String(n).padStart(3, '0')).join(', ')}`,
  },
  {
    id: 'clock', label: 'Clock',
    how: { fm1: 'Start the sequencer or arpeggiator with clock out on in GLO › MIDI.', smk37: 'Set GLOBE › MIDI › Clock Out to Always (or Playing, and press SEQ PLAY).' },
    update(s, m) {
      if (m.type !== 'clock') return false;
      const now = performance.now();
      (s.ticks ||= []).push(now);
      while (s.ticks.length > 49) s.ticks.shift();
      if (s.ticks.length > 24) {
        const per = (s.ticks[s.ticks.length - 1] - s.ticks[0]) / (s.ticks.length - 1);
        s.bpm = Math.round(60000 / (per * 24));
      }
      s.done = !!s.bpm;
      s.count = (s.count || 0) + 1;
      return s.count % 24 === 1; // repaint about once a beat
    },
    show: (s) => s.bpm && `about ${s.bpm} BPM`,
  },
  {
    id: 'ble', label: 'Over Bluetooth',
    how: {
      fm1: 'Connect over Bluetooth in the panel above, then play a key.',
      smk37: 'Connect over Bluetooth in the panel above (BT in Device mode), then play keys and turn a knob.',
    },
    update(s, m) {
      if (m.via !== 'ble' || m.type === 'clock') return false;
      if (m.type === 'noteon') s.notes = (s.notes || 0) + 1;
      else s.other = (s.other || 0) + 1;
      s.done = !!s.notes;
      s.partial = !s.done;
      return true;
    },
    show: (s) => (s.notes || s.other) && `${s.notes || 0} note${s.notes === 1 ? '' : 's'}, ${s.other || 0} other message${s.other === 1 ? '' : 's'}`,
  },
  {
    id: 'audio', label: 'Its sound reaches the page', auto: true,
    how: {
      fm1: 'Press Listen to its audio in the panel above, then play a key.',
      smk37: 'Press Listen to its audio in the panel above, then play a key.',
    },
    update(s, m) {
      if (m.type !== 'level') return false;
      s.peak = Math.max(s.peak || 0, m.level);
      s.done = s.peak > 0.01;
      return true;
    },
    show: (s) => s.peak > 0 && `${Math.round(20 * Math.log10(s.peak))} dBFS loudest, on “${fm1.status.audioName || 'audio input'}”`,
  },
];

class HwCheck extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.state = {};
    this.list = el('ul', { class: 'hw-check-list' });
    this.rows = new Map();
    for (const r of ROWS) {
      const light = el('span', { class: 'light' }, el('span', { class: 'visually-hidden', text: 'Not seen yet' }));
      const seen = el('span', { class: 'hw-check-seen' });
      const how = el('span', { class: 'hw-check-how' });
      const extra = [];
      if (r.listen) {
        const b = el('button', { class: 'btn', type: 'button', text: 'Listen for pads' });
        b.addEventListener('click', () => {
          const s = this.state.pads ||= {};
          s.padListen = !s.padListen;
          if (s.padListen) { s.notes = []; s.done = false; s.partial = false; }
          this._paint('pads');
        });
        extra.push(b);
        this.padBtn = b;
      }
      const li = el('li', { 'data-row': r.id }, [light, el('div', {}, [el('strong', { text: r.label }), ' ', seen, el('br'), how, ...extra])]);
      if (r.devices) li.dataset.device = r.devices.join(' ');
      this.rows.set(r.id, { li, light, seen, how });
      this.list.append(li);
    }
    this.summary = el('p', { class: 'hw-check-summary', role: 'status' });
    const copy = el('button', { class: 'btn hw', type: 'button', text: 'Copy report' });
    const reset = el('button', { class: 'btn', type: 'button', text: 'Start over' });
    this.out = el('pre', { class: 'midi-mon', hidden: true, tabindex: '0', 'aria-label': 'Report' });
    copy.addEventListener('click', () => this._copy());
    reset.addEventListener('click', () => { this.state = {}; this.out.hidden = true; for (const r of ROWS) this._paint(r.id); });
    this.append(el('section', { class: 'instrument hw-check', 'data-nofocus': '' }, [
      el('div', { class: 'instrument-head' }, [el('h3', {}, ['Try every control on the ', this._label = el('span', { text: deviceLabel() })]),
        el('p', { text: 'Rows tick themselves off as the messages arrive. Nothing is sent to the instrument.' })]),
      this.list,
      el('div', { class: 'instrument-foot' }, [this.summary, el('span', { class: 'grow' }), copy, reset]),
      this.out,
    ]));

    // Everything the instrument sends, as one stream of small records.
    fm1.addEventListener('midi', (e) => {
      const { data, via } = e.detail;
      const [st, d1, d2] = data;
      const type = st & 0xf0;
      const channel = (st & 15) + 1;
      let m;
      if (st === 0xf8) m = { type: 'clock' };
      else if (st >= 0xf0) return;
      else if (type === 0x90 && d2 > 0) m = { type: 'noteon', note: d1, vel: d2 };
      else if (type === 0xb0) m = { type: 'cc', cc: d1, value: d2, channel };
      else if (type === 0xe0) m = { type: 'bend', raw: ((d2 << 7) | d1) - 8192 };
      else if (type === 0xc0) m = { type: 'program', program: d1 };
      else if (type === 0xd0) m = { type: 'pressure', value: d1 };
      else if (type === 0xa0) m = { type: 'keypressure', note: d1, value: d2 };
      else return;
      m.via = via;
      this._feed(m);
    });
    // The instrument's sound on its audio input: sampled a few times a second,
    // and only while the page itself is quiet, since the page playing through
    // the instrument comes back on that input too.
    const buf = new Float32Array(2048);
    setInterval(() => {
      const a = fm1.analyser;
      if (!a || !this.isConnected || playingLevel() > 0.002) return;
      a.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      if (peak > 0.002) this._feed({ type: 'level', level: peak });
    }, 250);
    onDeviceChange(() => {
      // Pads are listened for on one device only; don't leave Keys deaf on the next.
      if (this.state.pads) this.state.pads.padListen = false;
      this._label.textContent = deviceLabel();
      for (const r of ROWS) this._paint(r.id);
    });
    for (const r of ROWS) this._paint(r.id);
  }

  _feed(m) {
    for (const r of ROWS) {
      if (r.devices && !r.devices.includes(device().id)) continue;
      const s = this.state[r.id] ||= {};
      if (r.update(s, m, this.state)) this._paint(r.id);
    }
  }

  _active() { return ROWS.filter((r) => !r.devices || r.devices.includes(device().id)); }

  _paint(id) {
    const r = ROWS.find((x) => x.id === id);
    const { light, seen, how } = this.rows.get(id);
    const s = this.state[id] || {};
    light.toggleAttribute('data-on', !!s.done);
    light.toggleAttribute('data-partial', !s.done && !!s.partial);
    light.firstChild.textContent = s.done ? 'Seen' : s.partial ? 'Partly seen' : 'Not seen yet';
    seen.textContent = r.show(s) || '';
    how.textContent = r.how[device().id] || r.how.smk37 || r.how.fm1;
    if (id === 'pads' && this.padBtn) {
      this.padBtn.textContent = s.padListen ? `Listening: ${s.notes?.length || 0} of 16 (tap to stop)` : 'Listen for pads';
      this.padBtn.setAttribute('aria-pressed', String(!!s.padListen));
    }
    const rows = this._active();
    const done = rows.filter((x) => this.state[x.id]?.done).length;
    this.summary.textContent = `${done} of ${rows.length} seen`;
  }

  _report() {
    const st = fm1.status;
    const d = device();
    const lines = [
      `Signal Path hardware check, ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      `Device: ${d.name} (${d.firmware})`,
      `Browser: ${navigator.userAgent}`,
      `MIDI in: ${st.inputName || 'none'} · out: ${st.outputName || 'none'} · Bluetooth: ${st.bluetooth}${st.bluetoothName ? ` (${st.bluetoothName})` : ''}`,
      `Audio in: ${st.audioName || 'not listening'}`,
      `MIDI channel ${fm1.midiChannel}, FX channel ${fm1.fxChannel}`,
      '',
    ];
    for (const r of this._active()) {
      const s = this.state[r.id] || {};
      lines.push(`${s.done ? '[x]' : s.partial ? '[~]' : '[ ]'} ${r.label}: ${r.show(s) || 'not seen'}`);
    }
    return lines.join('\n');
  }

  async _copy() {
    const text = this._report();
    this.out.textContent = text;
    this.out.hidden = false;
    try { await navigator.clipboard.writeText(text); this.summary.textContent = 'Copied the report.'; }
    catch (_) { this.summary.textContent = 'Couldn’t copy; select the report below instead.'; }
  }
}

customElements.define('hw-check', HwCheck);
