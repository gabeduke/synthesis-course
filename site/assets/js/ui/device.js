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

import { DEVICES, DEFAULT_DEVICE, FIRMWARES, profileFor, controlName, translateWhere } from '../hw/devices.js';

const KEY = 'course.device';
// The firmware is a separate choice ('bg' for Baud Girl's, or 'stock'), kept
// under its own key so the one-line device script in each page's head, which
// only knows device ids, needs no change. ?firmware=stock picks it too.
const FW_KEY = 'course.firmware';
const listeners = new Set();

function read(key = KEY) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}
function write(id, key = KEY) {
  try { localStorage.setItem(key, id); } catch (_) { /* storage blocked */ }
}

function fromUrl(name = 'device') {
  try { return new URLSearchParams(location.search).get(name); } catch (_) { return null; }
}

const known = (id) => (typeof id === 'string' && Object.hasOwn(DEVICES, id) ? DEVICES[id] : null);
const knownFw = (fw) => (typeof fw === 'string' && Object.hasOwn(FIRMWARES, fw) ? fw : null);

let current = DEVICES[DEFAULT_DEVICE];
let firmware = 'bg';
{
  const asked = known(fromUrl());
  if (asked) { current = asked; write(asked.id); }
  else current = known(read()) || current;
  const fw = knownFw(fromUrl('firmware'));
  if (fw) { firmware = fw; write(fw, FW_KEY); }
  else firmware = knownFw(read(FW_KEY)) || 'bg';
  current = profileFor(current.id, firmware);
}

export function device() { return current; }
export function firmwareId() { return firmware; }
export function deviceLabel() { return current.label; }
export function ctl(fm1Name) { return controlName(current, fm1Name); }
export function where(path) { return translateWhere(current, path); }

export function onDeviceChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setDevice(id, fw = firmware) {
  const next = known(id);
  const nextFw = knownFw(fw) || firmware;
  if (!next || (next.id === current.id && nextFw === firmware)) return;
  firmware = nextFw;
  current = profileFor(next.id, firmware);
  write(next.id);
  write(firmware, FW_KEY);
  // Keep the address in step if it named a device, so a reload or a shared
  // link shows what is on screen.
  try {
    if (fromUrl() || fromUrl('firmware')) {
      const url = new URL(location.href);
      url.searchParams.set('device', next.id);
      if (fromUrl('firmware') || firmware !== 'bg') url.searchParams.set('firmware', firmware);
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
  html.dataset.firmware = firmware;
  try { html.toggleAttribute('data-show-steps', localStorage.getItem('course.showSteps') === '1'); } catch (_) { /* storage blocked */ }
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
  foldSteps();
}

// Steps on the hardware that only make sense on Baud Girl's firmware: the
// lessons' "On the FM-1" boxes and the SMK-37's own boxes. Asides marked
// data-any-firmware (the AKS Mini's, say) stay. On stock firmware each one
// is folded behind a line that says why, with a button to show them all.
const STEPS = 'main :is(.on-fm1, aside.on-device[data-device]):not([data-any-firmware])';
function foldSteps() {
  for (const n of document.querySelectorAll('.stock-fold')) n.remove();
  if (firmware !== 'stock') return;
  const shown = (n) => !n.dataset.device || n.dataset.device.split(/\s+/).includes(current.id);
  for (const aside of document.querySelectorAll(STEPS)) {
    if (!shown(aside)) continue;
    // One line for a run of boxes: skip back over boxes for other devices.
    let prev = aside.previousElementSibling;
    while (prev && prev.matches(STEPS.replace('main ', '')) && !shown(prev)) prev = prev.previousElementSibling;
    if (prev?.matches('.stock-fold') || (prev?.matches(STEPS.replace('main ', '')) && shown(prev))) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = 'Show them anyway';
    btn.addEventListener('click', () => showSteps(true));
    const p = document.createElement('p');
    p.className = 'stock-fold';
    p.append(`Steps on the ${current.label} here are for Baud Girl’s ${current.firmware} firmware, which yours isn’t running.`, btn);
    aside.before(p);
  }
}

export function showSteps(on) {
  document.documentElement.toggleAttribute('data-show-steps', !!on);
  try { localStorage.setItem('course.showSteps', on ? '1' : '0'); } catch (_) { /* storage blocked */ }
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
  // One list: each device on Baud Girl's firmware, then on its stock one.
  const value = () => (firmware === 'stock' ? `${current.id}:stock` : current.id);
  const select = el('select', { id, class: 'device-select', title: 'Which instrument (and firmware) the lessons describe' }, [
    el('optgroup', { label: 'Baud Girl firmware' }, Object.values(DEVICES).map((d) => el('option', { value: d.id, text: d.label }))),
    el('optgroup', { label: 'Stock firmware' }, Object.values(DEVICES).map((d) => el('option', { value: `${d.id}:stock`, text: `${d.label} (stock)` }))),
  ]);
  select.value = value();
  select.addEventListener('change', () => {
    const [devId, fw = 'bg'] = select.value.split(':');
    setDevice(devId, fw);
  });
  onDeviceChange(() => { select.value = value(); });
  const label = el('label', { for: id, class: 'device-label' }, [el('span', { class: 'visually-hidden', text: 'Instrument' }), select]);
  return label;
}

showHide();
