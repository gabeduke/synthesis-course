// Which instrument the course is being read for, and the translation of the
// page into that instrument's control names.
//
// The lesson HTML is written for the FM-1 and stays that way. On load and
// whenever the device changes, this module:
//
//   * sets <html data-device="id">, which shows elements marked
//     data-device="id" and hides those marked for other devices;
//   * rewrites the text of .btn-name and .ctl-name elements from their FM-1
//     name (kept in data-fm1, so switching back is exact) to the device's;
//   * rewrites .dev-name to the device's short label and .fw-name to its
//     firmware name;
//   * tells everything listening (onDeviceChange) so widgets can update.
//
// The choice is kept in localStorage under course.device. ?device=id in the
// address picks a device too, and is remembered. Storage can be unavailable
// (private windows, blocked site data); then the page simply starts on the
// FM-1 each time.

import { DEVICES, DEFAULT_DEVICE, controlName, translateWhere } from '../hw/devices.js';

const KEY = 'course.device';
const listeners = new Set();

function read() {
  try { return localStorage.getItem(KEY); } catch (_) { return null; }
}
function write(id) {
  try { localStorage.setItem(KEY, id); } catch (_) { /* storage blocked */ }
}

function fromUrl() {
  try { return new URLSearchParams(location.search).get('device'); } catch (_) { return null; }
}

const known = (id) => (typeof id === 'string' && Object.hasOwn(DEVICES, id) ? DEVICES[id] : null);

let current = DEVICES[DEFAULT_DEVICE];
{
  const asked = known(fromUrl());
  if (asked) { current = asked; write(asked.id); }
  else current = known(read()) || current;
}

export function device() { return current; }
export function deviceLabel() { return current.label; }
export function ctl(fm1Name) { return controlName(current, fm1Name); }
export function where(path) { return translateWhere(current, path); }

export function onDeviceChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setDevice(id) {
  const next = known(id);
  if (!next || next === current) return;
  current = next;
  write(id);
  // Keep the address in step if it named a device, so a reload or a shared
  // link shows what is on screen.
  try {
    if (fromUrl()) {
      const url = new URL(location.href);
      url.searchParams.set('device', id);
      history.replaceState(history.state, '', url);
    }
  } catch (_) { /* ignore */ }
  applyDevice();
  for (const fn of listeners) {
    try { fn(current); } catch (err) { console.error(err); }
  }
}

// Keep the original (FM-1) text the first time we touch an element.
function original(node) {
  if (node.dataset.fm1 === undefined) node.dataset.fm1 = node.textContent;
  return node.dataset.fm1;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// A button label on the page itself ("Send settings to FM-1") names the device.
const withLabel = (text) => text.replace(/\bFM-1\b/g, current.label);

// Rewrite one subtree (the whole document by default) for the current device.
export function translate(root = document) {
  for (const node of root.querySelectorAll('.btn-name, .ctl-name')) {
    if (node.children.length) continue; // only plain-text names
    const fm1Text = original(node);
    const mapped = controlName(current, fm1Text);
    setText(node, mapped !== fm1Text ? mapped : withLabel(fm1Text));
  }
  for (const node of root.querySelectorAll('.dev-name')) {
    original(node);
    setText(node, current.label);
  }
  for (const node of root.querySelectorAll('.fw-name')) {
    original(node);
    setText(node, current.firmware);
  }
}

// Show and hide device-specific elements. The static stylesheet covers the
// FM-1 before this runs; this rule covers whichever device is selected, so a
// new device needs no CSS of its own.
function showHide() {
  const html = document.documentElement;
  html.dataset.device = current.id;
  let style = document.getElementById('device-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'device-style';
    document.head.append(style);
  }
  const id = CSS.escape(current.id);
  style.textContent = `html[data-device="${id}"] body [data-device]:not([data-device~="${id}"]) { display: none !important; }`;
}

export function applyDevice() {
  showHide();
  translate(document);
}

// The device's short name as a live element: built widgets use it so their
// labels follow later device changes along with the lesson text.
export function devName() {
  const span = document.createElement('span');
  span.className = 'dev-name';
  span.dataset.fm1 = 'FM-1';
  span.textContent = current.label;
  return span;
}

// A labelled <select> for the header.
export function deviceSelect(el) {
  const id = 'device-select';
  const select = el('select', { id, class: 'device-select', title: 'Which instrument the lessons describe' },
    Object.values(DEVICES).map((d) => el('option', { value: d.id, text: d.label })));
  select.value = current.id;
  select.addEventListener('change', () => setDevice(select.value));
  onDeviceChange((d) => { select.value = d.id; });
  const label = el('label', { for: id, class: 'device-label' }, [el('span', { class: 'visually-hidden', text: 'Instrument' }), select]);
  return label;
}

showHide();
