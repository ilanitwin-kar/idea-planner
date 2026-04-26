const CACHE = "idea-planner-cache-v10";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./daily-journal.js",
  "./manifest.webmanifest",
  "./icons/app-icon.svg",
  "./cloud-sync.js",
  "./firebase-config.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: data.icon || undefined,
      badge: data.badge || undefined,
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

