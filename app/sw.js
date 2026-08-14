/* Paper Deck service worker.
 * - Precaches the app shell so the app launches offline.
 * - Runtime-caches CDN modules (React, PDF.js) and PDFs already opened once.
 * - Receives Web Share Target POSTs, stashes the payload in the Cache API,
 *   and redirects into the app's Add view.
 * - Never caches Worker API calls (they must stay fresh).
 */

// Bump these suffixes on every app.js/styles.css/index.html change. Browsers
// only re-check this file for a service-worker update by byte-comparing it —
// if only the shell files change and this string doesn't, returning users can
// keep getting a stale cached app.js indefinitely via stale-while-revalidate,
// since nothing ever forces the old cache to be dropped.
const SHELL_CACHE = 'pd-shell-v6';
const RUNTIME_CACHE = 'pd-runtime-v6';
const PDF_CACHE = 'pd-pdfs-v6';
const SHARE_CACHE = 'pd-shared';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const CDN_HOSTS = ['cdnjs.cloudflare.com', 'esm.sh'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => ![SHELL_CACHE, RUNTIME_CACHE, PDF_CACHE, SHARE_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Web Share Target: stash payload, bounce into the app.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(e.request));
    return;
  }

  if (e.request.method !== 'GET') return;

  // App shell: stale-while-revalidate for instant offline launches.
  if (url.origin === self.location.origin) {
    e.respondWith(staleWhileRevalidate(e.request, SHELL_CACHE));
    return;
  }

  // CDN libraries: stale-while-revalidate so the reader works offline too.
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(staleWhileRevalidate(e.request, RUNTIME_CACHE));
    return;
  }

  // PDFs (R2, arXiv, Worker /file or /fetchpdf): cache-first once fetched.
  if (
    url.pathname.toLowerCase().endsWith('.pdf') ||
    url.pathname.includes('/file/') ||
    url.pathname.includes('/fetchpdf') ||
    url.hostname.endsWith('r2.dev')
  ) {
    e.respondWith(cacheFirst(e.request, PDF_CACHE));
    return;
  }

  // Everything else (Worker API): network only.
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(SHARE_CACHE);
    const meta = {
      title: form.get('title') || '',
      text: form.get('text') || '',
      url: form.get('url') || '',
      hasFile: false,
      ts: Date.now(),
    };
    const file = form.get('pdf');
    if (file && typeof file !== 'string' && file.size > 0) {
      meta.hasFile = true;
      meta.fileName = file.name || 'shared.pdf';
      await cache.put(
        './pd-shared-file',
        new Response(file, {
          headers: { 'Content-Type': file.type || 'application/pdf' },
        })
      );
    }
    await cache.put(
      './pd-shared-meta',
      new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } })
    );
  } catch {
    // fall through to the app either way
  }
  return Response.redirect('./?shared=1', 303);
}
