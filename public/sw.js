const CACHE = "idea-planner-cache-v12";

/** קבצים שקיימים תמיד אחרי build — בלי נתיבי hashed שלא ייכשלו ב־addAll */
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      for (const url of PRECACHE) {
        try {
          const res = await fetch(url, { cache: "reload" });
          if (res.ok) await cache.put(url, res);
        } catch {
          /* התקנה לא נכשלת בגלל קובץ בודד */
        }
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/* רשת קודם — עדכוני אפליקציה נטענים; במצב offline נופלים למטמון */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const path = new URL(req.url).pathname;
  /* API דינמי — לא שומרים במטמון (אחרת 404 ישן מ־/api/firebase-config ננעל עד ניקוי מלא) */
  if (path.startsWith("/api/")) {
    event.respondWith(fetch(req));
    return;
  }
  event.respondWith(
    fetch(req)
      .then((res) => {
        try {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        } catch {
          /* ignore */
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data?.json?.() ?? {};
  } catch {
    data = { title: "תזכורת", body: event.data?.text?.() ?? "" };
  }
  const title = data.title || "תזכורת";
  const body = data.body || "";
  const url = data.url || "/";
  const icon = data.icon || "/icons/icon-192.png";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: data.badge || icon,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  const url = event.notification?.data?.url || "/";
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const c of clientsArr) {
        if ("focus" in c) {
          c.postMessage({ type: "navigate", url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
