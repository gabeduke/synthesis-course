// On-screen keyboard, computer-keyboard playing, and routing of the FM-1's
// keys to whichever instrument on the page you used last.

import { noteName } from '../audio/core.js';
import { fm1 } from '../hw/fm1.js';
import { el } from './controls.js';

const BLACK = new Set([1, 3, 6, 8, 10]);

// ---------- Active instrument ----------
const instruments = new Set();
let active = null;

export function registerInstrument(inst) {
  instruments.add(inst);
  if (!active) active = inst;
  const claim = () => setActive(inst);
  inst.root.addEventListener('pointerdown', claim, { capture: true });
  inst.root.addEventListener('focusin', claim);
}

export function setActive(inst) {
  if (active === inst) return;
  active = inst;
  for (const i of instruments) i.root.toggleAttribute('data-active', i === inst);
}

export function activeInstrument() { return active; }

// ---------- Computer keyboard ----------
// Bottom two letter rows play like piano keys: A = C, W = C♯, S = D ...
const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
const held = new Map();

function typingTarget(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  if (t.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'radio'].includes(t.type)) return true;
  return false;
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typingTarget(e) || !active) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'x') {
    active.shiftOctave?.(k === 'z' ? -1 : 1);
    e.preventDefault();
    return;
  }
  if (!(k in KEYMAP) || e.repeat) { if (k in KEYMAP) e.preventDefault(); return; }
  const note = (active.baseNote ?? 48) + KEYMAP[k];
  held.set(k, { inst: active, note });
  active.noteOn(note, 0.8, 'qwerty');
  e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  const h = held.get(k);
  if (!h) return;
  held.delete(k);
  h.inst.noteOff(h.note, 'qwerty');
});

window.addEventListener('blur', () => {
  for (const { inst, note } of held.values()) inst.noteOff(note, 'qwerty');
  held.clear();
});

// ---------- FM-1 keys ----------
fm1.addEventListener('noteon', (e) => {
  if (!active) return;
  active.showHardwareNote?.(e.detail.note, true);
  if (fm1.keysPlayPage) active.noteOn(e.detail.note, e.detail.velocity, 'fm1');
});
fm1.addEventListener('noteoff', (e) => {
  if (!active) return;
  active.showHardwareNote?.(e.detail.note, false);
  if (fm1.keysPlayPage) active.noteOff(e.detail.note, 'fm1');
});

// ---------- Drawn keyboard ----------
export class Keyboard {
  constructor({ low = 48, octaves = 2, onDown, onUp }) {
    this.low = low;
    this.octaves = octaves;
    this.onDown = onDown;
    this.onUp = onUp;
    this.keys = new Map();
    this.root = el('div', { class: 'keys', role: 'group', 'aria-label': 'Keyboard' });
    this.pointerNotes = new Map();
    this._build();
  }

  _build() {
    this.root.replaceChildren();
    this.keys.clear();
    const n = this.octaves * 12 + 1;
    const whites = [];
    for (let i = 0; i < n; i++) if (!BLACK.has((this.low + i) % 12)) whites.push(this.low + i);
    const ww = 100 / whites.length;
    for (let i = 0; i < n; i++) {
      const note = this.low + i;
      const isBlack = BLACK.has(note % 12);
      const k = el('div', { class: `key${isBlack ? ' black' : ''}`, 'data-note': note, 'aria-label': noteName(note) });
      if (isBlack) {
        const leftWhites = whites.filter((w) => w < note).length;
        k.style.left = `calc(${leftWhites * ww}% - ${ww * 0.3}%)`;
        k.style.width = `${ww * 0.6}%`;
      } else if (note % 12 === 0) {
        k.append(el('span', { class: 'kname', text: noteName(note) }));
      }
      this.keys.set(note, k);
      this.root.append(k);
    }

    const noteAt = (x, y) => {
      const t = document.elementFromPoint(x, y);
      const k = t?.closest?.('.key');
      return k && this.root.contains(k) ? Number(k.dataset.note) : null;
    };
    this.root.onpointerdown = (e) => {
      const note = noteAt(e.clientX, e.clientY);
      if (note == null) return;
      this.root.setPointerCapture(e.pointerId);
      this.pointerNotes.set(e.pointerId, note);
      const rect = this.keys.get(note).getBoundingClientRect();
      const vel = Math.min(1, 0.45 + ((e.clientY - rect.top) / rect.height) * 0.6);
      this.onDown(note, vel);
      e.preventDefault();
    };
    this.root.onpointermove = (e) => {
      if (!this.pointerNotes.has(e.pointerId)) return;
      const note = noteAt(e.clientX, e.clientY);
      const prev = this.pointerNotes.get(e.pointerId);
      if (note != null && note !== prev) {
        this.onUp(prev);
        this.pointerNotes.set(e.pointerId, note);
        this.onDown(note, 0.75);
      }
    };
    const end = (e) => {
      const prev = this.pointerNotes.get(e.pointerId);
      if (prev != null) { this.onUp(prev); this.pointerNotes.delete(e.pointerId); }
    };
    this.root.onpointerup = end;
    this.root.onpointercancel = end;
  }

  setLow(low) { this.low = low; this._build(); }

  light(note, on, attr = 'data-on') {
    const k = this.keys.get(note);
    if (k) k.toggleAttribute(attr, on);
  }
}
