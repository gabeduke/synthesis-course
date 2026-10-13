// App behaviour that isn't about sound: the service worker and update notice,
// the install banner, sharing, keeping the screen awake while you play,
// picking up where you left off, and the colour theme.

import { el } from './controls.js';
import { LESSONS } from './lessons.js';
import { playingLevel } from '../audio/core.js';
import { fm1 } from '../hw/fm1.js';

const root = document.documentElement.dataset.root || '.';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } },
};

// ---------- Long presses ----------
// Holding a finger on a key, a drawn wave or the home-page picture is playing,
// not asking for the browser's menu. Text and links keep their menus.
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest?.('.keys, .viz, canvas, hero-stack')) e.preventDefault();
});

// ---------- Installed? ----------
// iOS reports it through navigator.standalone; everyone else via display-mode.
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (standalone) document.documentElement.classList.add('is-standalone');

// ---------- Toasts ----------
let toastHost;
export function toast(message, { action, onAction, duration = 6000 } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const close = el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', text: '×' });
  const t = el('div', { class: 'toast' }, [el('span', { text: message })]);
  if (action) {
    const b = el('button', { type: 'button', class: 'btn primary', text: action });
    b.addEventListener('click', () => { onAction?.(); t.remove(); });
    t.append(b);
  }
  t.append(close);
  close.addEventListener('click', () => t.remove());
  toastHost.append(t);
  if (duration) setTimeout(() => t.remove(), duration);
  return t;
}

// ---------- Service worker ----------
// Every lesson is saved on first visit so the course works offline. A new
// version downloads in the background and waits until you choose to switch.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  // Reload only when you asked for the new version. (The very first install
  // also takes control of the page, and that shouldn't reload anything.)
  let wantReload = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wantReload) return;
    wantReload = false;
    location.reload();
  });
  const offerUpdate = (worker) => {
    toast('A new version of the course is ready.', {
      action: 'Reload', duration: 0,
      onAction: () => { wantReload = true; worker.postMessage({ type: 'SKIP_WAITING' }); },
    });
  };
  // No controller yet means this is the first visit (or a hard reload).
  const firstVisit = !navigator.serviceWorker.controller;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${root}/sw.js`, { scope: `${root}/` }).then((reg) => {
      if (firstVisit && !store.get('course.saved')) {
        navigator.serviceWorker.ready.then(() => {
          store.set('course.saved', '1');
          toast('The whole course is now saved on this device, so it works offline.');
        });
      }
      // A newer version that finished downloading while you were away.
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
      // Long practice sessions: look for updates now and then.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => { /* no service worker: the site still works online */ });
  });
}

// ---------- Install banner ----------
// Chrome, Edge and Android get a real Install button; iOS can't be prompted,
// so it gets the two taps spelled out. Dismissing hides it for 45 days.
const DISMISS_KEY = 'course.install-dismissed';
const DISMISS_DAYS = 45;
let deferredPrompt = null;
const slots = [...document.querySelectorAll('[data-install-slot]')];
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function recentlyDismissed() {
  const at = Number(store.get(DISMISS_KEY) || 0);
  return at && Date.now() - at < DISMISS_DAYS * 864e5;
}

function showBanner(mode) {
  if (standalone || recentlyDismissed() || !slots.length) return;
  for (const slot of slots) {
    if (slot.firstChild) continue;
    const pitch = mode === 'ios'
      ? el('span', {}, ['Tap ', el('strong', { text: 'Share' }), ', then ', el('strong', { text: 'Add to Home Screen' }), '.'])
      : el('span', { text: 'Opens full screen, works offline, and keeps your place.' });
    const install = el('button', { type: 'button', class: 'btn primary', text: 'Install' });
    install.hidden = mode === 'ios';
    install.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
      hideBanner();
    });
    const dismiss = el('button', { type: 'button', class: 'install-close', 'aria-label': 'Not now', text: '×' });
    dismiss.addEventListener('click', () => { store.set(DISMISS_KEY, String(Date.now())); hideBanner(); });
    slot.append(el('div', { class: 'install-banner' }, [
      el('img', { src: `${root}/icons/icon-192.png`, alt: '', width: 44, height: 44 }),
      el('div', { class: 'install-copy' }, [el('strong', { text: 'Put Signal Path on your home screen' }), pitch]),
      install, dismiss,
    ]));
  }
}

function hideBanner() { for (const slot of slots) slot.replaceChildren(); }

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showBanner('prompt');
});
window.addEventListener('appinstalled', () => {
  hideBanner();
  toast('Installed. Find Signal Path on your home screen.');
});
if (isIOS && !standalone) showBanner('ios');

// ---------- Continue where you left off ----------
const current = LESSONS.find((l) => location.pathname.endsWith(`/${l.file}`));
if (current) store.set('course.last', current.file);
const last = LESSONS.find((l) => l.file === store.get('course.last'));
const params = new URLSearchParams(location.search);
if (params.has('continue')) {
  location.replace(`${root}/${(last || LESSONS[0]).file}`);
} else if (last && last.n > 0 && document.querySelector('main.home')) {
  const actions = document.querySelector('.hero-actions');
  const resume = el('a', { class: 'btn primary', href: `${root}/${last.file}`, text: `Continue: ${last.title}` });
  actions?.prepend(resume);
  actions?.querySelector('a[href$="00-start.html"]')?.classList.remove('primary');
}

// ---------- Share ----------
// The native share sheet where there is one (phones, tablets), otherwise copy.
export async function share({ title, text, url }) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return 'shared'; } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied.');
    return 'copied';
  } catch (_) {
    window.prompt('Copy this link:', url);
    return 'shown';
  }
}

const pager = document.querySelector('.pager');
if (pager || current) {
  const btn = el('button', { type: 'button', class: 'btn', text: current ? 'Share this lesson' : 'Share this page' });
  btn.addEventListener('click', () => share({
    title: document.title,
    text: current ? `${current.title}: ${current.blurb}` : document.querySelector('meta[name="description"]')?.content,
    url: location.href.split('#')[0],
  }));
  const row = el('div', { class: 'share-row' }, btn);
  if (pager) pager.before(row); else document.querySelector('main')?.append(row);
}

// ---------- Keep the screen awake while you play ----------
// A tablet on a music stand shouldn't dim mid-chord. Hold a wake lock while
// the page is making sound or the FM-1's keys are being played, and let it go
// after three quiet minutes.
const QUIET_MS = 3 * 60 * 1000;
let lastActive = 0;
let lock = null;
fm1.addEventListener('noteon', () => { lastActive = Date.now(); });
async function updateWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  if (playingLevel() > 0.002) lastActive = Date.now();
  const wanted = Date.now() - lastActive < QUIET_MS;
  if (wanted && !lock) {
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch (_) { lock = null; }
  } else if (!wanted && lock) {
    lock.release().catch(() => {});
    lock = null;
  }
}
setInterval(updateWakeLock, 2000);
document.addEventListener('visibilitychange', updateWakeLock);

// ---------- Colour theme ----------
// Auto follows the device; Light and Dark override it. The choice is applied
// by a one-line script in each page's head, before anything draws.
const THEMES = ['auto', 'light', 'dark'];
const PAPER = { light: '#e9edf1', dark: '#1d2229' };
function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = meta.media.includes('dark') ? 'dark' : 'light';
    meta.content = PAPER[theme === 'auto' ? scheme : theme];
  }
}
const ICONS = {
  auto: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  dark: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};
let theme = THEMES.includes(store.get('course.theme')) ? store.get('course.theme') : 'auto';
applyTheme(theme);
const header = document.getElementById('site-header');
if (header) {
  const btn = el('button', { type: 'button', class: 'theme-toggle' });
  const label = { auto: 'Theme: match device', light: 'Theme: light', dark: 'Theme: dark' };
  const paint = () => {
    btn.innerHTML = ICONS[theme];
    btn.setAttribute('aria-label', `${label[theme]}. Click to change.`);
    btn.title = label[theme];
  };
  btn.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set('course.theme', theme);
    applyTheme(theme);
    paint();
  });
  paint();
  const chip = header.querySelector('fm1-panel');
  if (chip) chip.before(btn); else header.append(btn);
}
