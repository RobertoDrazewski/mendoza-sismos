// Service worker minimo: solo cachea el "shell" estatico de la app para que
// sea instalable como PWA y abra rapido. Los datos de sismos (/api/sismos)
// y el websocket NUNCA se cachean — siempre van a la red, porque tienen que
// ser en vivo.

const CACHE = 'mendoza-sismos-v1';
const ARCHIVOS_SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARCHIVOS_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((claves) =>
      Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Nunca cachear la API de sismos/incendios/catastrofes, ni /config.js
  // (depende de variables de entorno del servidor), ni nada que no sea
  // GET del mismo origen.
  if (url.pathname.startsWith('/api/') || url.pathname === '/config.js' || event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cacheado) => {
      return (
        cacheado ||
        fetch(event.request)
          .then((respuesta) => {
            const copia = respuesta.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copia));
            return respuesta;
          })
          .catch(() => cacheado)
      );
    })
  );
});
