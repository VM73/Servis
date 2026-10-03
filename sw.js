// Servisní záznamy – service worker
// Aplikace se načte i bez signálu (data ale potřebují připojení).
// Při změně souborů zvyš číslo verze.
const CACHE = "servis-v2";
const SOUBORY = ["./", "index.html", "manifest.webmanifest", "icon-180.png", "icon-512.png"];
const KNIHOVNA = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SOUBORY).then(() => c.add(KNIHOVNA).catch(() => {})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((k) => Promise.all(k.filter((x) => x !== CACHE).map((x) => caches.delete(x))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const vlastni = url.origin === self.location.origin;
  const knihovna = req.url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/");
  if (!vlastni && !knihovna) return; // Supabase API vždy přímo ze sítě

  // nejdřív síť (aby se projevily aktualizace), bez signálu z cache
  e.respondWith(
    fetch(req)
      .then((r) => {
        if (r.ok) {
          const kopie = r.clone();
          caches.open(CACHE).then((c) => c.put(req, kopie));
        }
        return r;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});
