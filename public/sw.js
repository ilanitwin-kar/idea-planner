const CACHE = "idea-planner-cache-v14";

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

const HOURLY_IDB = "idea-planner-hourly-v1";
const HOURLY_DIGEST_MIN = 10 * 60;

function hourlyIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HOURLY_IDB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function hourlyIdbGet(key) {
  return hourlyIdbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const r = tx.objectStore("kv").get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
  );
}

function hourlyIdbSet(key, value) {
  return hourlyIdbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function localDateKeySw(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function fireAtMs(dateKey, startMin) {
  if (!Number.isFinite(Number(startMin))) return null;
  const [y, m, d] = String(dateKey).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  dt.setMinutes(Number(startMin) || 0);
  const t = dt.getTime();
  return Number.isFinite(t) ? t : null;
}

function pad2sw(n) {
  return String(n).padStart(2, "0");
}

function minutesLabel(totalMin) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(totalMin) || 0)));
  return `${pad2sw(Math.floor(m / 60))}:${pad2sw(m % 60)}`;
}

async function tickHourlyFromIdb() {
  const schedule = await hourlyIdbGet("schedule");
  if (!schedule || typeof schedule !== "object") return;
  const now = Date.now();
  const today = localDateKeySw(new Date());
  let fired = (await hourlyIdbGet("fired")) || {};
  if (typeof fired !== "object") fired = {};
  let changed = false;

  const days = schedule.days && typeof schedule.days === "object" ? schedule.days : {};
  const digestTitles = [];

  for (const blk of days[today]?.blocks || []) {
    if (!blk || blk.done) continue;
    const title = String(blk.title || "").trim() || "משימה";
    const hasTime = Number.isFinite(blk.startMin);
    if (hasTime) {
      const fireAt = fireAtMs(today, blk.startMin);
      if (fireAt == null || now < fireAt) continue;
      const key = `hourly:${today}:${blk.id}:${blk.startMin}`;
      if (fired[key]) continue;
      fired[key] = now;
      changed = true;
      const late = now - fireAt > 2 * 60 * 1000;
      const when = minutesLabel(blk.startMin);
      await self.registration.showNotification(late ? "תזכורת מלו״ז (פיגור)" : "תזכורת מלו״ז", {
        body: late ? `פג הזמן: ${title} · ${when}` : `עכשיו: ${title} (${when})`,
        tag: key,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url: "/" },
      });
      continue;
    }
    digestTitles.push(title);
  }

  const digestAt = fireAtMs(today, HOURLY_DIGEST_MIN);
  if (digestTitles.length && digestAt != null && now >= digestAt) {
    const key = `hourly:digest:${today}`;
    if (!fired[key]) {
      fired[key] = now;
      changed = true;
      const body = digestTitles.join(" · ").slice(0, 220);
      await self.registration.showNotification("הלו״ז להיום", {
        body,
        tag: key,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url: "/" },
      });
    }
  }

  if (changed) await hourlyIdbSet("fired", fired);
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "hourly-reminders") event.waitUntil(tickHourlyFromIdb());
});

self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "hourly-tick" || type === "hourly-sync") {
    event.waitUntil(tickHourlyFromIdb());
  }
});
