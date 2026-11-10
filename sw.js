/**
 * Service Worker for Wheels Collection PWA.
 *
 * Provides offline support on static hosts (Hostinger, GitHub Pages) and
 * caches the PP-OCRv4 ONNX models and WebAssembly binaries in Cache Storage.
 */

/**
 * Static shell cache. `tools/lib/build.mjs` rewrites this line with a short
 * content hash of the HTML/CSS/JS/lang assets, so every deploy gets a fresh
 * cache and `activate` removes the previous one.
 */
const STATIC_CACHE = 'wheels-static-v1';
/**
 * Model cache name. `tools/lib/build.mjs` rewrites this line with a short
 * content hash of the .onnx/.txt/ORT bundle, so deploying new models
 * invalidates the cache while `activate` removes the previous version.
 */
const MODEL_CACHE = 'wheels-models-v1';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './css/tailwind.css',
  './js/controller.js',
  './js/app.js',
  './js/ocr.js',
  './js/ocr-onnx.js',
  './js/ocr-worker.js',
  './js/image-crop.js',
  './js/preferences.js',
  './js/router.js',
  './js/i18n.js',
  './js/firebase.js',
  './js/firebase-config.js',
  './lang/en-CA.json',
  './lang/fr-CA.json',
  './lang/pt-BR.json',
  './assets/app_icon.png',
  './assets/app_icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Precache partial error (will resolve on demand):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== STATIC_CACHE && key !== MODEL_CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Skip Firebase APIs, Google Auth and browser extensions
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.protocol.startsWith('chrome-extension')
  ) {
    return;
  }

  // 1. Heavy ONNX models, WASM binaries & model dictionaries: Cache-First
  const isModelOrBinary =
    url.pathname.endsWith('.onnx') ||
    url.pathname.endsWith('.wasm') ||
    url.pathname.endsWith('.mjs') ||
    url.pathname.includes('ppocr_keys') ||
    url.hostname.includes('onnxruntime') ||
    url.pathname.includes('/models/');

  if (isModelOrBinary) {
    event.respondWith(
      caches.open(MODEL_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;

        try {
          const response = await fetch(request);
          if (response && (response.status === 200 || response.type === 'opaque')) {
            cache.put(request, response.clone());
          }
          return response;
        } catch (fetchError) {
          // If offline and request not cached, fail gracefully
          throw fetchError;
        }
      })
    );
    return;
  }

  // 2. App assets & CDNs: Stale-While-Revalidate with offline fallback
  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(request);

      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

