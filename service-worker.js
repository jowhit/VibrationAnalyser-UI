// Shell PWA — chemins relatifs au dossier du service worker
// (fonctionne a la racine ESP32 et sous /VibrationAnalyser-UI/ sur GitHub Pages).

const CACHE_NAME = 'vibanalyser-v89';
const FILES = [
  './index.html',
  './i18n.js',
  './lang/fr.json',
  './lang/en.json',
  './app.js',
  './analyse.js',
  './anal-session.js',
  './bump-session.js',
  './balance.js',
  './balance-session.js',
  './fft.js',
  './fft-session.js',
  './harmonic.js',
  './phase-session.js',
  './demod.js',
  './calc.js',
  './menu.js',
  './terminal.js',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png'
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

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Network-first : sinon Android garde l'ancien JS (pause / UI invisibles)
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  var isNav = event.request.mode === 'navigate';
  var indexUrl = _url('./index.html');

  event.respondWith(
    fetch(event.request, { cache: 'no-cache' }).then(function (response) {
      if (response && response.ok) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          if (isNav) cache.put(indexUrl, clone);
          else cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function () {
      return caches.open(CACHE_NAME).then(function (cache) {
        var lookup = isNav ? indexUrl : event.request;
        return cache.match(lookup, { ignoreSearch: true }).then(function (cached) {
          return cached || cache.match(indexUrl);
        });
      });
    })
  );
});
