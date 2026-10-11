/**
 * Versioned shell cache. Hazard state and route decisions (/v1) are never cached
 * here - the app keeps its own labelled snapshot - and map tiles are never
 * bulk-cached (OSM tile policy). Cache-first for the shell, the wasm runtime
 * and the model. Once installed, a ride works with no connection at all.
 */
const CACHE = "dillijalnav-edge-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // The hashed bundles load before this worker controls the page, so they
      // would never reach the cache by themselves - an offline reload would get
      // the shell without its script. Precache whatever index.html references.
      const html = await (await fetch("/index.html", { cache: "no-store" })).text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(["/", "/index.html", "/manifest.webmanifest", ...assets]);
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  // hazard data and route decisions must always be live; everything else may come from cache
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/") || path.startsWith("/v1/")) return;

  // The HTML shell goes network-first: it names the content-hashed asset
  // bundles, so a stale copy would point at files that no longer exist and
  // strand the rider on a broken page with no way to recover. Falls back to
  // cache when there is no connection, which is the whole point of the SW.
  // The assets themselves are hashed, so cache-first stays safe for them.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match("/index.html"))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
