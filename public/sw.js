// Service worker minimo: solo cachea el "shell" estatico de la app para que
// sea instalable como PWA y abra rapido offline. Los datos de sismos
// (/api/sismos) y el websocket NUNCA se cachean — siempre van a la red,
// porque tienen que ser en vivo.
//
// Estrategia "red primero, cache como respaldo": SIEMPRE intenta traer la
// version mas nueva del servidor primero. Si hay internet, se ve lo ultimo
// que se deployo. Si no hay internet (o el pedido falla), usa lo que haya
// guardado en cache para que la app igual abra. Asi, cuando se deployea una
// version nueva, se ve apenas se recarga la pagina con conexion — no hace
// falta desinstalar la PWA ni limpiar el cache a mano.
//
// IMPORTANTE: cada vez que cambie algo de public/ (index.html, app.js,
// style.css, etc.), subile la version a este nombre de cache (v2, v3, ...).
// Eso hace que el navegador detecte que este archivo cambio de contenido y
// reinstale el service worker, borrando el cache viejo en "activate".
const CACHE = 'mendoza-sismos-v2';
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
    fetch(event.request)
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copia));
        return respuesta;
      })
      .catch(() => caches.match(event.request))
  );
});
