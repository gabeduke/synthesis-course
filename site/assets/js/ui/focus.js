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

// Size every picture from its lesson size, so a tall scope and a thin meter
// keep their proportions. Called again when the window changes size.
function grow(box, on) {
  const k = growth();
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
