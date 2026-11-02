/**
 * Service Worker de Mis Cuentas (PWA Offline-First).
 *
 * REGLAS ESTRICTAS DE PRIVACIDAD Y CACHÉ:
 *  1. Almacena únicamente recursos estáticos de la aplicación (App Shell: HTML, JS, CSS,
 *     iconos, manifest.json) para permitir abrir y usar la aplicación sin internet.
 *  2. JAMÁS almacena en CacheStorage respuestas de `/api/*`, `/rest/v1/*`, `/auth/v1/*`,
 *     dominios externos (`*.supabase.co`) ni peticiones con cabecera `Authorization`.
 *  3. Los registros financieros residen exclusivamente en IndexedDB y se sincronizan
 *     mediante la cola local autenticada con RLS.
 */
const VERSION_CACHE = 'mis-cuentas-shell-v1';
const RECURSOS_BASE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/manifest.json',
  '/icono-192.png',
  '/icono-512.png',
  '/apple-touch-icon.png',
  '/icono-192.svg',
  '/icono-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION_CACHE).then((cache) => cache.addAll(RECURSOS_BASE)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((nombres) =>
        Promise.all(
          nombres
            .filter((n) => n.startsWith('mis-cuentas-shell-') && n !== VERSION_CACHE)
            .map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.tipo === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function esPeticionPrivadaNoCacheable(request, url) {
  if (request.method !== 'GET') return true;
  if (request.headers.get('Authorization')) return true;
  if (url.origin !== self.location.origin) return true;
  const p = url.pathname.toLowerCase();
  if (
    p.startsWith('/api/') ||
    p === '/api' ||
    p.startsWith('/rest/v1') ||
    p.startsWith('/auth/v1') ||
    p.endsWith('.db') ||
    p.endsWith('.csv') ||
    p.endsWith('.enc.json')
  ) {
    return true;
  }
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (esPeticionPrivadaNoCacheable(req, url)) {
    return;
  }

  // Navegación principal SPA: red primero con respaldo inmediato al App Shell en caché cuando no hay internet
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copia = res.clone();
            caches.open(VERSION_CACHE).then((c) => c.put('/index.html', copia));
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Recursos estáticos del App Shell (JS, CSS, SVG, manifest): Cache-First con actualización en segundo plano
  event.respondWith(
    caches.match(req).then((enCache) => {
      const promesaRed = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copia = res.clone();
            caches.open(VERSION_CACHE).then((c) => c.put(req, copia));
          }
          return res;
        })
        .catch(() => enCache);

      return enCache || promesaRed;
    }),
  );
});
