'use strict';
/* RS1 Recordings — offline service worker (no build step, no external deps).
 *
 * Strategy:
 * - App shell (index, styles, app code, manifest, probe) is cached at
 *   install. Shell files are network-first with a cache fallback, so code
 *   updates reach online visitors without a version bump.
 * - manifest.json is network-first with a cache fallback: the fresh folder
 *   list online, the last-known list offline.
 * - recordings/*.enc are cache-first; on a miss the worker fetches from the
 *   network and caches the response, so any track played once is available
 *   offline afterwards. Decryption still happens in memory after the PIN.
 * - probe.enc is cache-first: PIN verification must work fully offline.
 */
const CACHE = 'rs1-rec-v1';
const SHELL = ['index.html', 'styles.css', 'app.js', 'manifest.json', 'probe.enc', './'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {}) // first visit while offline: shell fills in lazily
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isRecording(url) { return url.pathname.includes('/recordings/'); }
function isManifest(url) { return url.pathname.endsWith('/manifest.json'); }
function isProbe(url) { return url.pathname.endsWith('/probe.enc'); }
function isShell(url) { return /\/(index\.html|styles\.css|app\.js)?$/.test(url.pathname); }

function cachePut(req, res) {
  if (!res.ok) return;
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isRecording(url)) {
    // Cache-first: offline tracks load instantly; new tracks cache on first play.
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then(hit => {
        if (hit) return hit;
        return fetch(req).then(res => { cachePut(req, res); return res; });
      })
    );
    return;
  }
  if (isManifest(url)) {
    // Network-first: fresh list online, last-known list offline.
    event.respondWith(
      fetch(req).then(res => { cachePut(req, res); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }
  if (isProbe(url)) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then(hit =>
        hit || fetch(req).then(res => { cachePut(req, res); return res; }))
    );
    return;
  }
  if (isShell(url)) {
    // Network-first so code updates propagate; cached copy serves offline.
    event.respondWith(
      fetch(req).then(res => { cachePut(req, res); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
  }
});
