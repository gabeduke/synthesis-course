/* Signal Path service worker.
 *
 * Built into site/sw.js by scripts/build_pwa.py, which fills in VERSION (a hash
 * of every file below) and PRECACHE (every file in the site). Don't edit
 * site/sw.js by hand; edit this template and rebuild.
 *
 * The whole course is static and needs no live data, so unlike most sites it
 * can work completely offline, which is handy in a practice room with no Wi-Fi:
 *
 *   - Installing downloads every page, script, style and icon in one go.
 *   - Our own files are served from that cache first, so pages open instantly
 *     and keep working offline. A page that somehow isn't cached falls back to
 *     the network, then to offline.html.
 *   - Google Fonts are cached the first time they load and refreshed in the
 *     background after that.
 *   - When a new version is published, the new worker downloads it all and
 *     then waits. The page shows "A new version is ready" and switches only
 *     when you choose, so a lesson never changes under you mid-session.
 */
'use strict';

const VERSION = '94f63dd6ee93';
const PRECACHE = [
  "./",
  "assets/css/course.css",
  "assets/favicon.svg",
  "assets/js/audio/core.js",
  "assets/js/audio/fx.js",
  "assets/js/audio/supersaw.js",
  "assets/js/audio/va-synth.js",
  "assets/js/hw/fm1.js",
  "assets/js/main.js",
  "assets/js/ui/controls.js",
  "assets/js/ui/draw.js",
  "assets/js/ui/keyboard.js",
  "assets/js/ui/lessons.js",
  "assets/js/ui/params.js",
  "assets/js/ui/pwa.js",
  "assets/js/ui/shell.js",
  "assets/js/widgets/basics.js",
  "assets/js/widgets/chip-lab.js",
  "assets/js/widgets/fm-lab.js",
  "assets/js/widgets/fm1-panel.js",
  "assets/js/widgets/history-timeline.js",
  "assets/js/widgets/space-lab.js",
  "assets/js/widgets/synth-lab.js",
  "assets/js/widgets/voice-stack.js",
  "history.html",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-192.png",
  "icons/maskable-512.png",
  "index.html",
  "lessons/00-start.html",
  "lessons/01-sound.html",
  "lessons/02-oscillators.html",
  "lessons/03-filters.html",
  "lessons/04-envelopes.html",
  "lessons/05-lfo.html",
  "lessons/06-unison.html",
  "lessons/07-space.html",
  "lessons/08-fm.html",
  "lessons/09-8bit.html",
  "lessons/10-recipes.html",
  "lessons/11-live.html",
  "manifest.webmanifest",
  "offline.html"
];
const CACHE = `signal-path-${VERSION}`;
const FONTS = 'signal-path-fonts';
const OFFLINE = 'offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('signal-path-') && key !== CACHE && key !== FONTS)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// The page asks for this when you press "Reload" on the update notice.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function fromCacheFirst(request) {
  const cache = await caches.open(CACHE);
  // Lessons are plain files, so a ?source=pwa or #section never changes what
  // they contain.
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    return await fetch(request);
  } catch (err) {
    if (request.mode === 'navigate') return cache.match(OFFLINE);
    throw err;
  }
}

async function fontsStaleWhileRevalidate(request) {
  const cache = await caches.open(FONTS);
  const hit = await cache.match(request);
  const refresh = fetch(request).then((response) => {
    if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
    return response;
  });
  if (hit) {
    refresh.catch(() => {}); // offline: the cached copy already answered
    return hit;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(fromCacheFirst(request));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(fontsStaleWhileRevalidate(request));
  }
  // Anything else (links to Baud Girl's site, GitHub) goes straight to the network.
});
