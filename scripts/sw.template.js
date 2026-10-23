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

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `signal-path-${VERSION}`;
const FONTS = 'signal-path-fonts';
const OFFLINE = 'offline.html';

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's own HTTP cache. GitHub Pages lets
  // browsers keep files for ten minutes, and a plain addAll() would happily
  // store the old copies of a file it fetched just before a deploy, leaving
  // the new version "installed" but still showing the old course.
  event.waitUntil(caches.open(CACHE).then((cache) =>
    cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))));
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
