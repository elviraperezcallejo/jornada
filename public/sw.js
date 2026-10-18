/*
 * Service worker: guarda la aplicación para que se abra sin conexión.
 * Solo toca ficheros de la propia app. Nunca guarda ni intercepta las
 * llamadas a la API de GitHub (ahí van los datos y el token).
 */
const CACHE = "jornada-app-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(["./", "./manifest.webmanifest", "./icon-192.png"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// La página avisa de los ficheros que ha cargado para guardarlos ya en la primera visita.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-urls" || !Array.isArray(event.data.urls)) return;
  const same = event.data.urls.filter((u) => {
    try { return new URL(u).origin === self.location.origin; } catch { return false; }
  });
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(same)).catch(() => undefined));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    // Página: primero la red (para recibir versiones nuevas); sin red, la guardada.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./", copy));
          return res;
        })
        .catch(() => caches.match("./")),
    );
    return;
  }
  // Ficheros con nombre versionado: primero la caché.
  event.respondWith(
    caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
