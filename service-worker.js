// Shell PWA — chemins relatifs au dossier du service worker
// (fonctionne a la racine ESP32 et sous /VibrationAnalyser-UI/ sur GitHub Pages).

const CACHE_NAME = 'vibanalyser-v27';
const FILES = [
  './index.html',
  './app.js',
  './analyse.js',
  './balance.js',
  './fft.js',
  './harmonic.js',
  './demod.js',
  './calc.js',
  './menu.js',
  './terminal.js',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

function _url(name) {
  return new URL(name, self.location).href;
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(FILES.map(function (name) {
        return fetch(_url(name), { cache: 'no-cache' }).then(function (response) {
          if (response && response.ok) return cache.put(_url(name), response);
        }).catch(function () {});
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  var isNav = event.request.mode === 'navigate';
  var isManifest = /\/manifest\.json$/i.test(url.pathname);
  var indexUrl = _url('./index.html');

  // Navigation + manifest : reseau d'abord (sinon Android reste bloque sur ancienne UI)
  if (isNav || isManifest) {
    event.respondWith(
      fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            if (isNav) cache.put(indexUrl, copy);
            else cache.put(event.request, copy);
          });
        }
        return response;
      }).catch(function () {
        return caches.open(CACHE_NAME).then(function (cache) {
          return cache.match(isNav ? indexUrl : event.request, { ignoreSearch: true })
            .then(function (cached) { return cached || cache.match(indexUrl); });
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(event.request, { ignoreSearch: true }).then(function (cached) {
        var network = fetch(event.request).then(function (response) {
          if (response && response.ok) cache.put(event.request, response.clone());
          return response;
        }).catch(function () { return null; });
        if (cached) return cached;
        return network.then(function (response) {
          return response || cache.match(indexUrl);
        });
      });
    })
  );
});
