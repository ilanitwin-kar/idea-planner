/**
 * תזכורות Push ללו״ז היומי — הרשמה + סנכרון לשרת, וגם התראה מקומית כשהאפליקציה פתוחה.
 */
import {
  collectAllScheduleBlocks,
  hourlyBlockFireAtMs,
  minutesToTimeString,
  blockHasTime,
  HOURLY_DIGEST_MIN,
} from "./hourly-schedule.js";

const USER_KEY_LS = "idea-planner:push-user-key:v1";
const FIRED_LS = "idea-planner:hourly-local-fired:v1";

export function getPushUserKey() {
  try {
    let k = localStorage.getItem(USER_KEY_LS);
    if (!k) {
      k = globalThis.crypto?.randomUUID?.() || `u_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(USER_KEY_LS, k);
    }
    return k;
  } catch {
    return "local";
  }
}

export function pushApiBase(settings) {
  return String(settings?.pushServerUrl || import.meta.env.VITE_PUSH_SERVER_URL || "")
    .trim()
    .replace(/\/$/, "");
}

function apiUrl(settings, path) {
  return `${pushApiBase(settings)}${path}`;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function digestBodyForDay(titles) {
  const list = titles.filter(Boolean);
  if (!list.length) return "";
  const joined = list.join(" · ");
  if (joined.length <= 220) return joined;
  return `${joined.slice(0, 210)}…`;
}

export function remindersFromHourlySchedule(schedule) {
  const now = Date.now();
  const out = [];
  const digestTitles = new Map();
  for (const { dateKey, block: blk } of collectAllScheduleBlocks(schedule)) {
    if (blk.done) continue;
    const title = String(blk.title ?? "").trim() || "משימה";
    if (blockHasTime(blk)) {
      const fireAt = hourlyBlockFireAtMs(dateKey, blk.startMin);
      if (fireAt == null || fireAt < now - 45_000) continue;
      const startLabel = minutesToTimeString(blk.startMin);
      out.push({
        id: `hourly:${dateKey}:${blk.id}`,
        title: "תזכורת מלו״ז",
        body: `${title} · ${startLabel}`,
        url: "/",
        fireAt,
      });
      continue;
    }
    if (!digestTitles.has(dateKey)) digestTitles.set(dateKey, []);
    digestTitles.get(dateKey).push(title);
  }
  for (const [dateKey, titles] of digestTitles) {
    const body = digestBodyForDay(titles);
    const fireAt = hourlyBlockFireAtMs(dateKey, HOURLY_DIGEST_MIN);
    if (!body || fireAt == null || fireAt < now - 45_000) continue;
    out.push({
      id: `hourly:digest:${dateKey}`,
      title: "הלו״ז להיום",
      body,
      url: "/",
      fireAt,
    });
  }
  return out;
}

export async function fetchVapidPublicKey(settings) {
  const r = await fetch(apiUrl(settings, "/api/vapidPublicKey"), { cache: "no-store" });
  if (!r.ok) throw new Error("vapid_unavailable");
  const j = await r.json();
  const key = String(j?.publicKey || "").trim();
  if (!key) throw new Error("vapid_missing");
  return key;
}

export async function ensurePushServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("no_sw");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  return reg;
}

export function notificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export function isIosDevice() {
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export function isStandaloneDisplay() {
  try {
    if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
  } catch {
    /* ignore */
  }
  return !!window.navigator.standalone;
}

/** באייפון אישור Push מופיע רק באפליקציה ממסך הבית — לא בלשונית ספארי. */
export function iosNeedsHomeScreenForPush() {
  return isIosDevice() && !isStandaloneDisplay();
}

export async function enableHourlyPush(settings) {
  if (!("Notification" in window)) throw new Error("unsupported");
  if (iosNeedsHomeScreenForPush()) throw new Error("ios_homescreen");

  // חייבים לקרוא לזה מיד אחרי לחיצה — בלי await לפני, ובלי חלון dialog פתוח.
  let perm = Notification.permission;
  if (perm !== "granted") {
    perm = await Notification.requestPermission();
  }
  if (perm !== "granted") throw new Error("denied");

  if (!("serviceWorker" in navigator)) throw new Error("unsupported");

  const reg = await ensurePushServiceWorker();
  const canPush = "PushManager" in window && !!reg.pushManager;
  if (!canPush) return { ok: true, localOnly: true };

  const vapid = await fetchVapidPublicKey(settings);
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid),
    });
  }

  const r = await fetch(apiUrl(settings, "/api/subscribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userKey: getPushUserKey(),
      subscription: sub.toJSON(),
    }),
  });
  if (!r.ok) throw new Error("subscribe_failed");
  return { ok: true, localOnly: false };
}

export async function syncHourlyRemindersToServer(settings, schedule) {
  const reminders = remindersFromHourlySchedule(schedule);
  const r = await fetch(apiUrl(settings, "/api/reminders"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      op: "replace-hourly",
      userKey: getPushUserKey(),
      reminders,
    }),
  });
  if (!r.ok) throw new Error("reminders_failed");
  return { ok: true, count: reminders.length };
}

function loadFiredMap() {
  try {
    const raw = localStorage.getItem(FIRED_LS);
    const x = raw ? JSON.parse(raw) : {};
    return x && typeof x === "object" ? x : {};
  } catch {
    return {};
  }
}

function saveFiredMap(map) {
  try {
    localStorage.setItem(FIRED_LS, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function pruneFiredMap(map) {
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2).getTime();
  const next = {};
  for (const [k, v] of Object.entries(map)) {
    const t = Number(v);
    if (Number.isFinite(t) && t >= cutoff) next[k] = t;
  }
  return next;
}

function showLocalHourlyNotification(tag, title, body) {
  try {
    const n = new Notification(title, {
      body,
      tag,
      icon: "/icons/icon-192.png",
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* ignore */
  }
}

/** התראה מקומית — בשעת משימה, וב־10:00 סיכום של מה שבלי שעה */
export function tickLocalHourlyReminders(schedule) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  let fired = pruneFiredMap(loadFiredMap());
  let changed = false;
  const digestTitles = new Map();
  for (const { dateKey, block: blk } of collectAllScheduleBlocks(schedule)) {
    if (blk.done) continue;
    const title = String(blk.title ?? "").trim() || "משימה";
    if (blockHasTime(blk)) {
      const fireAt = hourlyBlockFireAtMs(dateKey, blk.startMin);
      if (fireAt == null) continue;
      if (now < fireAt || now > fireAt + 90_000) continue;
      const key = `hourly:${dateKey}:${blk.id}:${blk.startMin}`;
      if (fired[key]) continue;
      fired[key] = now;
      changed = true;
      const startLabel = minutesToTimeString(blk.startMin);
      showLocalHourlyNotification(key, "תזכורת מלו״ז", `עכשיו: ${title} (${startLabel})`);
      continue;
    }
    if (!digestTitles.has(dateKey)) digestTitles.set(dateKey, []);
    digestTitles.get(dateKey).push(title);
  }
  for (const [dateKey, titles] of digestTitles) {
    const fireAt = hourlyBlockFireAtMs(dateKey, HOURLY_DIGEST_MIN);
    if (fireAt == null) continue;
    if (now < fireAt || now > fireAt + 90_000) continue;
    const key = `hourly:digest:${dateKey}`;
    if (fired[key]) continue;
    const body = digestBodyForDay(titles);
    if (!body) continue;
    fired[key] = now;
    changed = true;
    showLocalHourlyNotification(key, "הלו״ז להיום", body);
  }
  if (changed) saveFiredMap(fired);
}

export function pushStatusText() {
  if (!("Notification" in window)) return "הדפדפן לא תומך בהתראות.";
  if (iosNeedsHomeScreenForPush()) {
    return "באייפון: שתף → הוספה למסך הבית, ואז לפתוח מהאייקון. רק אז יופיע אישור התראות.";
  }
  const p = Notification.permission;
  if (p === "granted") return "התראות מאושרות במכשיר.";
  if (p === "denied") return "התראות נחסמו במכשיר — אפשר לשנות בהגדרות הדפדפן.";
  return "עדיין לא אושרו התראות. לחצי «הפעלת התראות» — ייסגר החלון ויופיע אישור.";
}
