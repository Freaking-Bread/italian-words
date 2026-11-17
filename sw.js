// Офлайн-оболочка приложения.
// Свой сайт: сначала сеть (обновления приходят сразу), если сети нет или она
// висит дольше 3 с — сохранённая копия. Шрифты Google — из кэша, обновляются фоном.
// Запросы к api.github.com не трогаем: данные и синхронизацию ведёт само приложение.
const CACHE = "it-shell-v1";
const FONTS = "it-fonts-v1";

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/styles.css",
  "js/app.js",
  "js/config.js",
  "js/github.js",
  "js/player.js",
  "js/store.js",
  "data/words.json",
  "data/songs.json",
  "data/texts.json",
  "data/assoc.json",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  ...["word", "linker", "rule", "swear", "song", "text", "assoc", "train"]
    .flatMap((s) => [`img/${s}.webp`, `img/${s}-sm.webp`]),
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith("it-") && k !== CACHE && k !== FONTS && !k.startsWith("it-assets"))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function networkFirst(req) {
  return new Promise((resolve) => {
    let done = false;
    const fallback = () => caches.match(req, { ignoreSearch: req.mode === "navigate" })
      .then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : undefined))
      .then((hit) => hit || Response.error());
    const timer = setTimeout(() => { if (!done) { done = true; fallback().then(resolve); } }, 3000);

    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }).catch(() => {
      if (!done) { done = true; clearTimeout(timer); fallback().then(resolve); }
    });
  });
}

function fontsCacheFirst(req) {
  return caches.open(FONTS).then((c) => c.match(req).then((hit) => {
    const net = fetch(req).then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; });
    return hit || net;
  }));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = new URL(req.url);
  if (url.origin === location.origin) e.respondWith(networkFirst(req));
  else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") e.respondWith(fontsCacheFirst(req));
});
