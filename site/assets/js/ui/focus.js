// Focus: one panel fills the screen, for playing rather than reading.
//
// Every widget is a custom element holding a <section class="instrument">
// with an .instrument-head; enableFocus() gives it a Focus button. In focus
// the panel covers the page (and goes full screen where the browser allows),
// its pictures grow in proportion, and Esc brings the lesson back. The
// element gets a 'focuschange' event ({ detail: { on } }) so it can add
// pictures of its own: <synth-lab> and <aks-lab> show extra views.
//
// main.js calls enableFocusAll() once the widgets are built; a widget that
// wants the event early calls enableFocus(this) itself.

import { el } from './controls.js';

let current = null; // the host in focus, if any

// How big the pictures get, against their size in the lesson: bigger on a
// tall screen, a little smaller on a short one (a phone on its side).
const growth = () => Math.min(1.8, Math.max(0.9, innerHeight / 640));
const GAP = 12; // between views in a row (course.css)

// Size every picture from its lesson size, so a tall scope and a thin meter
// keep their proportions. Called again when the window changes size.
function grow(box, on) {
  const k = growth();
  // Text and line weights in the pictures grow too, a little less (ui/draw.js).
  const ks = on ? Math.min(1.6, Math.max(1, 1 + (k - 1) * 0.75)) : 1;
  for (const c of box.querySelectorAll('canvas')) c._focusK = ks;
  for (const v of box.querySelectorAll('.viz')) {
    if (on) {
      if (v.dataset.h === undefined) {
        v.dataset.h = v.style.height;
        v.dataset.px = parseFloat(v.style.height) || v.offsetHeight; // inline, or from the stylesheet
      }
      const px = Number(v.dataset.px);
      if (px) v.style.height = `${Math.round(px * k)}px`;
    } else if (v.dataset.h !== undefined) {
      v.style.height = v.dataset.h;
      delete v.dataset.h;
      delete v.dataset.px;
    }
  }
  for (const row of box.querySelectorAll(':scope > .viz-row')) if (!on) row.style.removeProperty('--cols');
  if (on) fill(box);
}

// On a screen wide enough, the pictures take the room the controls and keys
// leave, shared in proportion to their lesson sizes. A row of views is tiled
// in however many lines keeps each view widest for its height (five views on
// a short laptop screen sit in one line; on a tall monitor, three and two).
// Below 600 pixels the panel is a column that scrolls, as in the lesson.
function fill(box) {
  const rows = [...box.querySelectorAll(':scope > .viz-row')];
  const solo = [...box.querySelectorAll(':scope > .viz:not(.flow)')];
  const W = box.clientWidth;
  if (W < 600) { for (const row of rows) row.style.setProperty('--cols', 1); return; }
  const shown = (x) => getComputedStyle(x).display !== 'none';
  const vizOf = (x) => (x.classList.contains('viz') ? x : x.querySelector('.viz'));
  const blocks = [];
  for (const row of rows) {
    const items = [...row.children].filter(shown);
    if (!items.length) continue;
    const px = Math.max(150, ...items.map((x) => Number(vizOf(x)?.dataset.px) || 0));
    blocks.push({ el: row, items, px });
  }
  for (const v of solo) if (shown(v)) blocks.push({ el: v, px: Number(v.dataset.px) || 150 });
  if (!blocks.length) return;
  // What everything else needs, measured with the pictures at their grown size.
  const cs = getComputedStyle(box);
  const inner = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  let others = 0;
  for (const ch of box.children) {
    if (!shown(ch) || blocks.some((b) => b.el === ch)) continue;
    others += ch.getBoundingClientRect().height;
    // Only the pictures have margins of their own (the keys' is the leftover).
    if (ch.matches('.viz, .viz-row')) others += parseFloat(getComputedStyle(ch).marginTop) || 0;
  }
  for (const b of blocks) others += parseFloat(getComputedStyle(b.el).marginTop) || 0;
  const free = inner - others - 2;
  const total = blocks.reduce((s, b) => s + b.px, 0);
  const cap = inner * 0.62;
  for (const b of blocks) {
    const share = Math.min(cap, (free * b.px) / total);
    // Never smaller than in the lesson (a little bigger where there's room);
    // past that, the panel scrolls.
    const minH = Math.max(130, b.px * Math.min(1.15, growth()));
    const w = b.el.clientWidth;
    if (!b.items) {
      b.el.style.height = `${Math.round(Math.max(minH, share))}px`;
      continue;
    }
    const n = b.items.length;
    let best = null;
    for (let r = 1; r <= n; r++) {
      const cols = Math.ceil(n / r);
      if (best && cols === best.cols) continue;
      const vw = (w - GAP * (cols - 1)) / cols;
      const vh = (share - GAP * (r - 1)) / r;
      const score = Math.min(vw / 1.45, vh);
      if (!best || score > best.score) best = { r, cols, vw, score };
    }
    b.el.style.setProperty('--cols', best.cols);
    const vh = Math.round(Math.max(minH, Math.min((share - GAP * (best.r - 1)) / best.r, best.vw)));
    for (const it of b.items) {
      const v = vizOf(it);
      if (!v) continue;
      // A view with its own controls under it (the AKS joystick) keeps room for them.
      const extra = it === v ? 0 : it.getBoundingClientRect().height - v.getBoundingClientRect().height;
      v.style.height = `${Math.max(100, Math.round(vh - extra))}px`;
    }
  }
}

export function enableFocus(host) {
  if (host._focus) return host._focus;
  const box = host.querySelector(':scope > section.instrument');
  const head = box?.querySelector(':scope > .instrument-head');
  if (!head) return null;
  const btn = el('button', { class: 'btn focus-btn', type: 'button', 'aria-pressed': 'false', title: 'Fill the screen with this panel (Esc to leave)', text: 'Focus' });
  if (!head.querySelector(':scope > .grow')) head.append(el('span', { class: 'grow' }));
  head.append(btn);
  box.tabIndex = -1;
  let wasFullscreen = false;

  const set = async (on) => {
    on = on ?? !box.hasAttribute('data-focus');
    if (on === box.hasAttribute('data-focus')) return;
    if (on && current && current !== host) await current._focus.set(false);
    current = on ? host : null;
    box.toggleAttribute('data-focus', on);
    document.documentElement.classList.toggle('has-focus', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Exit focus' : 'Focus';
    grow(box, on);
    host.dispatchEvent(new CustomEvent('focuschange', { detail: { on } }));
    if (on) {
      try { if (host.requestFullscreen && !document.fullscreenElement) await host.requestFullscreen({ navigationUI: 'hide' }); } catch (_) { /* the overlay is enough */ }
      grow(box, true); // full screen is taller
      box.focus({ preventScroll: true });
    } else {
      if (document.fullscreenElement === host) { try { await document.exitFullscreen(); } catch (_) { /* ignore */ } }
      host.scrollIntoView({ block: 'nearest' });
    }
  };

  btn.addEventListener('click', () => set());
  document.addEventListener('fullscreenchange', () => {
    // Esc in full screen leaves full screen without a key event: leave focus too.
    if (!document.fullscreenElement && wasFullscreen && box.hasAttribute('data-focus')) set(false);
    wasFullscreen = document.fullscreenElement === host;
  });
  host._focus = { set, button: btn, box };
  return host._focus;
}

export function enableFocusAll(root = document) {
  for (const box of root.querySelectorAll('section.instrument')) {
    const host = box.parentElement;
    // Connection panels and checklists aren't for playing.
    if (!host?.localName.includes('-') || host.localName.endsWith('-panel') || box.hasAttribute('data-nofocus')) continue;
    enableFocus(host);
  }
}

// Esc leaves focus wherever the keyboard focus is (the panel's own keys too),
// unless something else is open that Esc should close first, such as the
// connection panel.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !current || e.defaultPrevented) return;
  let open;
  try { open = document.querySelector(':popover-open, dialog[open]'); } catch (_) { open = document.querySelector('dialog[open]'); } // no popovers here
  if (open) return;
  current._focus.set(false);
});
window.addEventListener('resize', () => { if (current) grow(current._focus.box, true); });
