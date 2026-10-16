/* Flood Explorer service worker: keeps the app working when the signal drops.
 *
 * - The app itself and the national data are fetched fresh when online and
 *   served from the cache when not.
 * - Map libraries and fonts are kept once fetched.
 * - Map tiles, terrain (Geoscience Australia elevation) and map-service
 *   answers (councils, states, census areas) are kept as they are used, so
 *   areas you have looked at and models you have built work offline. Each
 *   of these caches is trimmed to a set number of entries, oldest first.
 * The build stamps its version below, so each deploy refreshes the app.
 */
const VERSION = '__BUILD__';
const APP = `app-${VERSION}`;
const LIBS = 'libs-v1', TILES = 'tiles-v1', TERRAIN = 'terrain-v1', API = 'api-v1';
const LIMITS = { [TILES]: 4000, [TERRAIN]: 120, [API]: 600 };

const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'flood-core.js', 'flood-wasm.js', 'flood.wasm', 'flood-worker.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'data/national/gauges-core.min.json', 'data/national/storages.geojson', 'data/national/readings.json', 'data/national/meta.json',
];
const LIB_URLS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/esri-leaflet@3.0.12/dist/esri-leaflet.js',
  'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js',
];
const TILE_HOSTS = /(^|\.)basemaps\.cartocdn\.com$|^tile\.openstreetmap\.org$|^server\.arcgisonline\.com$|^tiles\.arcgis\.com$|^[a-c]\.tile\.opentopomap\.org$|^spatial-img\.information\.qld\.gov\.au$|^tilecache\.rainviewer\.com$/;
const LIB_HOSTS = /^(unpkg\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const app = await caches.open(APP);
    // one at a time, so a missing optional file doesn't stop the rest
    await Promise.all(SHELL.map((u) => app.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    const libs = await caches.open(LIBS);
    await Promise.all(LIB_URLS.map(async (u) => { if (!(await libs.match(u))) await libs.add(new Request(u, { mode: 'cors' })).catch(() => {}); }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([APP, LIBS, TILES, TERRAIN, API]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(name) {
  const max = LIMITS[name];
  if (!max) return;
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

// fresh when online (within a few seconds), the cached copy otherwise
async function networkFirst(req, name, waitMs) {
  const c = await caches.open(name);
  const net = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).then(() => trim(name)).catch(() => {});
    return res;
  });
  try {
    return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), waitMs))]);
  } catch (err) {
    const hit = await c.match(req, { ignoreVary: true }) || (name === APP ? await c.match(req, { ignoreSearch: true }) : null);
    // no copy: a slow network that eventually answers still wins over nothing
    return hit || net;
  }
}

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).then(() => trim(name)).catch(() => {});
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    e.respondWith(networkFirst(req, APP, url.pathname.includes('/data/') ? 6000 : 4000));
    return;
  }
  if (LIB_HOSTS.test(url.hostname)) { e.respondWith(cacheFirst(req, LIBS)); return; }
  if (TILE_HOSTS.test(url.hostname) || /\/tile\/\d+\/\d+\/\d+/.test(url.pathname)) { e.respondWith(cacheFirst(req, TILES)); return; }
  // terrain for models: the same window always returns the same heights
  if (url.hostname === 'services.ga.gov.au' && /GetCoverage/i.test(url.search)) { e.respondWith(cacheFirst(req, TERRAIN)); return; }
  // map-service answers (feature queries, exported images, census areas)
  if (/\/(MapServer|FeatureServer|ImageServer|wms|wfs|ows|WCSServer)\b/i.test(url.pathname) || url.hostname === 'ows.dea.ga.gov.au') {
    e.respondWith(networkFirst(req, API, 8000));
  }
});
