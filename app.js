import {
  DAY_JOURNAL_STORAGE_KEY,
  loadDayJournal,
  saveDayJournal,
  localDateKey,
  addDayItem,
  toggleDayItem,
  deleteDayItem,
  pastDayKeysWithItems,
  futureDayKeysWithItems,
  dayProgress,
} from "./daily-journal.js";

const STORAGE_KEY = "idea-planner:v1";
const CLOUD_DEBOUNCE_MS = 400;

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ideas: [], selectedIdeaId: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ideas: [], selectedIdeaId: null };
    const state = {
      ideas: Array.isArray(parsed.ideas) ? parsed.ideas : [],
      selectedIdeaId: typeof parsed.selectedIdeaId === "string" ? parsed.selectedIdeaId : null,
    };
    // Migration: scheduledAt -> startsAt/endsAt
    for (const idea of state.ideas) {
      if (!idea || typeof idea !== "object") continue;
      if (!Array.isArray(idea.tasks)) idea.tasks = [];
      for (const task of idea.tasks) {
        if (!task || typeof task !== "object") continue;
        if (!Array.isArray(task.subtasks)) task.subtasks = [];
        for (const sub of task.subtasks) {
          if (!sub || typeof sub !== "object") continue;
          if (!("startsAt" in sub) && "scheduledAt" in sub) {
            sub.startsAt = sub.scheduledAt ?? null;
            sub.endsAt = null;
            delete sub.scheduledAt;
          } else {
            if (!("startsAt" in sub)) sub.startsAt = null;
            if (!("endsAt" in sub)) sub.endsAt = null;
          }
        }
      }
      if (!("strategy" in idea)) idea.strategy = "";
    }
    return state;
  } catch {
    return { ideas: [], selectedIdeaId: null };
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function computeIdeaDone(idea) {
  const tasks = idea.tasks ?? [];
  if (tasks.length === 0) return false;
  return tasks.every((t) => computeTaskDone(t));
}

function computeTaskDone(task) {
  const subtasks = task.subtasks ?? [];
  if (subtasks.length === 0) return false;
  return subtasks.every((s) => !!s.done);
}

function setTaskDone(task, done) {
  task.subtasks = task.subtasks ?? [];
  for (const sub of task.subtasks) sub.done = !!done;
}

function setIdeaDone(idea, done) {
  idea.tasks = idea.tasks ?? [];
  for (const task of idea.tasks) setTaskDone(task, done);
}

function countTaskSubtasks(task) {
  const subtasks = task.subtasks ?? [];
  const done = subtasks.filter((s) => !!s.done).length;
  return { total: subtasks.length, done };
}

function countIdeaTasks(idea) {
  const tasks = idea.tasks ?? [];
  const done = tasks.filter((t) => computeTaskDone(t)).length;
  return { total: tasks.length, done };
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatWhen(isoStart, isoEnd) {
  const s = isoToDate(isoStart);
  if (!s) return "";
  const d = s.toLocaleDateString("he-IL", { year: "numeric", month: "2-digit", day: "2-digit" });
  const t = s.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  const e = isoToDate(isoEnd);
  if (!e) return `${d} ${t}`;
  const t2 = e.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  return `${d} ${t}–${t2}`;
}

function ideaToExportText(idea) {
  const lines = [];
  lines.push(`רעיון: ${idea.title || "ללא שם"}`);
  if ((idea.strategy || "").trim()) {
    lines.push("");
    lines.push("אסטרטגיה:");
    lines.push(idea.strategy.trim());
  }
  lines.push("");
  lines.push("משימות:");
  const tasks = idea.tasks ?? [];
  if (tasks.length === 0) {
    lines.push("- (אין משימות)");
    return lines.join("\n");
  }
  for (const task of tasks) {
    const doneTask = computeTaskDone(task) ? "✓" : "☐";
    const subs = task.subtasks ?? [];
    lines.push(`${doneTask} ${task.title || "ללא שם"}  (${subs.filter((s) => !!s.done).length}/${subs.length})`);
    if (subs.length === 0) {
      lines.push("  - (אין תתי־משימות)");
      continue;
    }
    for (const sub of subs) {
      const done = sub.done ? "✓" : "☐";
      const when = formatWhen(sub.startsAt, sub.endsAt);
      const whenTxt = when ? ` — ${when}` : "";
      lines.push(`  - ${done} ${sub.title || "ללא שם"}${whenTxt}`);
    }
  }
  return lines.join("\n");
}

function openExportDialog() {
  const dlg = document.getElementById("exportDialog");
  const txt = document.getElementById("exportText");
  const hint = document.getElementById("exportHint");
  const idea = getSelectedIdea();
  if (!dlg || !txt || !idea) return;
  txt.value = ideaToExportText(idea);
  if (hint) hint.textContent = "";
  dlg.showModal();
}

function formatDateTimeValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function fromLocalInputToIso(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function debounce(ms, fn) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let state = loadState();
let cloud = null;
let pushCloudDebounced = null;
let currentUserUid = null;
let pushServer = {
  baseUrl: "http://localhost:8787",
  vapidPublicKey: null,
  subscribed: false,
};

const SETTINGS_KEY = "idea-planner:settings:v1";
let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const x = raw ? JSON.parse(raw) : null;
    const defaultPushUrl = window.location.port?.startsWith("517") ? "http://localhost:8787" : window.location.origin;
    return {
      pushServerUrl: typeof x?.pushServerUrl === "string" && x.pushServerUrl ? x.pushServerUrl : defaultPushUrl,
      remindAtTime: x?.remindAtTime !== false,
      remindBefore30: x?.remindBefore30 !== false,
      defaultCalMode: x?.defaultCalMode === "day" || x?.defaultCalMode === "month" ? x.defaultCalMode : "week",
    };
  } catch {
    const defaultPushUrl = window.location.port?.startsWith("517") ? "http://localhost:8787" : window.location.origin;
    return { pushServerUrl: defaultPushUrl, remindAtTime: true, remindBefore30: true, defaultCalMode: "week" };
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const APP_MODE_KEY = "idea-planner:app-mode:v1";
const FUTURE_DAY_KEY = "idea-planner:future-day-key:v1";

function loadAppMode() {
  try {
    const v = localStorage.getItem(APP_MODE_KEY);
    if (v === "ideas" || v === "daily-today" || v === "daily-future" || v === "daily-history") return v;
  } catch {
    /* ignore */
  }
  return "daily-today";
}

let appMode = loadAppMode();
let dayJournal = loadDayJournal();
let historySelectedKey = null;
let lastKnownCalendarDayKey = localDateKey();

function nextDayKeyAfter(todayKey) {
  const [y, m, d] = todayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return localDateKey(dt);
}

function loadFutureDayKey(todayKey) {
  try {
    const v = localStorage.getItem(FUTURE_DAY_KEY);
    if (v && typeof v === "string" && v > todayKey) return v;
  } catch {
    /* ignore */
  }
  return nextDayKeyAfter(todayKey);
}

function saveFutureDayKey(k) {
  localStorage.setItem(FUTURE_DAY_KEY, k);
}

function formatHebrewDateLabel(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("he-IL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function setAppMode(mode) {
  appMode = mode;
  try {
    localStorage.setItem(APP_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
  document.body.classList.toggle("app-mode-ideas", mode === "ideas");
  if (mode === "ideas" && isMobile()) mobile.screen = "ideas";
  syncAppNavActive();
  window.scrollTo({ top: 0, behavior: "smooth" });
  render();
}

function syncAppNavActive() {
  const pairs = [
    ["daily-today", "tnDailyToday"],
    ["daily-today", "bnDailyToday"],
    ["ideas", "tnIdeas"],
    ["ideas", "bnIdeas"],
    ["daily-future", "tnDailyFuture"],
    ["daily-future", "bnDailyFuture"],
    ["daily-history", "tnDailyHistory"],
    ["daily-history", "bnDailyHistory"],
  ];
  for (const [m, id] of pairs) {
    document.getElementById(id)?.classList.toggle("active", appMode === m);
  }
}

function updateAppViewsVisibility() {
  document.getElementById("viewIdeas")?.classList.toggle("hidden", appMode !== "ideas");
  document.getElementById("viewDailyToday")?.classList.toggle("hidden", appMode !== "daily-today");
  document.getElementById("viewDailyFuture")?.classList.toggle("hidden", appMode !== "daily-future");
  document.getElementById("viewDailyHistory")?.classList.toggle("hidden", appMode !== "daily-history");
}

function dayItemLabel(it) {
  return String(it?.title ?? it?.text ?? "").trim();
}

function renderDayItemsList(container, dateKey) {
  if (!container) return;
  container.innerHTML = "";
  const day = dayJournal.days[dateKey];
  const items = day?.items ?? [];
  if (items.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `<div class="empty-text">אין משימות. הוסיפי שורה למעלה.</div>`;
    container.appendChild(div);
    return;
  }
  for (const it of items) {
    const label = escapeHtml(dayItemLabel(it));
    const row = document.createElement("div");
    row.className = `daily-item ${it.done ? "done" : ""}`;
    row.innerHTML = `
      <label class="daily-check">
        <input type="checkbox" ${it.done ? "checked" : ""} data-action="daily-toggle" data-date-key="${dateKey}" data-item-id="${it.id}" />
        <span class="daily-item-text">${label}</span>
      </label>
      <button type="button" class="btn-daily-del" data-action="daily-delete" data-date-key="${dateKey}" data-item-id="${it.id}" aria-label="מחיקה">×</button>
    `;
    container.appendChild(row);
  }
}

function renderDailyTodayPage() {
  const tk = localDateKey();
  const titleEl = document.getElementById("dailyTodayTitle");
  const subEl = document.getElementById("dailyTodaySub");
  const progEl = document.getElementById("dailyTodayProgress");
  if (titleEl) titleEl.textContent = formatHebrewDateLabel(tk);
  if (subEl) subEl.textContent = "היום שלי — ברגע שעובר חצות נטען יום חדש (לפי השעון במכשיר).";
  renderDayItemsList(document.getElementById("dailyTodayList"), tk);
  const pr = dayProgress(dayJournal, tk);
  if (progEl) progEl.textContent = pr.total ? `${pr.done}/${pr.total} הושלמו` : "אין עדיין משימות — אפשר להוסיף למעלה.";
}

function renderDailyFuturePage() {
  const tk = localDateKey();
  const next = nextDayKeyAfter(tk);
  let fk = loadFutureDayKey(tk);
  if (fk <= tk) {
    fk = next;
    saveFutureDayKey(fk);
  }
  const picker = document.getElementById("dailyFuturePicker");
  if (picker) {
    picker.min = next;
    const pv = picker.value;
    if (pv && pv > tk) fk = pv;
    else picker.value = fk;
  }

  const quick = document.getElementById("dailyFutureQuick");
  if (quick) {
    quick.innerHTML = "";
    const keys = futureDayKeysWithItems(dayJournal, tk);
    const show = [...new Set([fk, ...keys])].sort();
    for (const k of show) {
      if (k <= tk) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = `daily-chip ${k === fk ? "active" : ""}`;
      const [y, m, d] = k.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      b.textContent = dt.toLocaleDateString("he-IL", { day: "numeric", month: "short" });
      b.addEventListener("click", () => {
        saveFutureDayKey(k);
        if (picker) picker.value = k;
        render();
      });
      quick.appendChild(b);
    }
  }

  renderDayItemsList(document.getElementById("dailyFutureList"), fk);
  const pr = dayProgress(dayJournal, fk);
  const progEl = document.getElementById("dailyFutureProgress");
  if (progEl) {
    progEl.textContent = pr.total ? `${formatHebrewDateLabel(fk)} • ${pr.done}/${pr.total} הושלמו` : `תאריך: ${formatHebrewDateLabel(fk)}`;
  }
}

function renderDailyHistoryPage() {
  const tk = localDateKey();
  const past = pastDayKeysWithItems(dayJournal, tk);
  const chips = document.getElementById("historyDaysList");
  const panel = document.getElementById("historyDayPanel");
  const empty = document.getElementById("historyEmpty");
  if (!chips || !panel || !empty) return;

  chips.innerHTML = "";
  if (past.length === 0) {
    empty.classList.remove("hidden");
    panel.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");

  if (!historySelectedKey || !past.includes(historySelectedKey)) historySelectedKey = past[0];

  for (const k of past) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `daily-chip ${k === historySelectedKey ? "active" : ""}`;
    const [y, m, d] = k.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    b.textContent = dt.toLocaleDateString("he-IL", { day: "numeric", month: "short", year: "2-digit" });
    b.addEventListener("click", () => {
      historySelectedKey = k;
      render();
    });
    chips.appendChild(b);
  }

  panel.classList.remove("hidden");
  const ht = document.getElementById("historyDayTitle");
  if (ht) ht.textContent = formatHebrewDateLabel(historySelectedKey);
  renderDayItemsList(document.getElementById("historyDayList"), historySelectedKey);
  const pr = dayProgress(dayJournal, historySelectedKey);
  const hp = document.getElementById("historyDayProgress");
  if (hp) hp.textContent = pr.total ? `${pr.done}/${pr.total} הושלמו` : "";
}

const els = {
  resetBtn: document.getElementById("resetBtn"),
  addIdeaForm: document.getElementById("addIdeaForm"),
  ideaTitleInput: document.getElementById("ideaTitleInput"),
  ideasList: document.getElementById("ideasList"),
  tabIdea: document.getElementById("tabIdea"),
  tabCalendar: document.getElementById("tabCalendar"),
  tabTasks: document.getElementById("tabTasks"),
  emptyState: document.getElementById("emptyState"),
  ideaView: document.getElementById("ideaView"),
  calendarView: document.getElementById("calendarView"),
  tasksView: document.getElementById("tasksView"),
  currentIdeaTitle: document.getElementById("currentIdeaTitle"),
  currentIdeaMeta: document.getElementById("currentIdeaMeta"),
  ideaStrategyInput: document.getElementById("ideaStrategyInput"),
  addTaskForm: document.getElementById("addTaskForm"),
  taskTitleInput: document.getElementById("taskTitleInput"),
  tasksList: document.getElementById("tasksList"),

  calModeDay: document.getElementById("calModeDay"),
  calModeWeek: document.getElementById("calModeWeek"),
  calModeMonth: document.getElementById("calModeMonth"),
  calPrev: document.getElementById("calPrev"),
  calNext: document.getElementById("calNext"),
  calToday: document.getElementById("calToday"),
  calTitle: document.getElementById("calTitle"),
  calendarGrid: document.getElementById("calendarGrid"),

  tasksSearch: document.getElementById("tasksSearch"),
  tasksListAll: document.getElementById("tasksListAll"),

  hsIdeas: document.getElementById("hsIdeas"),
  hsTasks: document.getElementById("hsTasks"),
  hsToday: document.getElementById("hsToday"),
  hsNext: document.getElementById("hsNext"),

  authStatus: document.getElementById("authStatus"),
  authBtn: document.getElementById("authBtn"),
  authDialog: document.getElementById("authDialog"),
  authEmail: document.getElementById("authEmail"),
  authPassword: document.getElementById("authPassword"),
  authLogin: document.getElementById("authLogin"),
  authSignup: document.getElementById("authSignup"),
  authLogout: document.getElementById("authLogout"),
  authHint: document.getElementById("authHint"),
};

let ui = {
  tab: "idea", // idea | calendar | tasks
  calMode: settings.defaultCalMode, // day | week | month
  calAnchorIso: new Date().toISOString(),
  calFilterIdeaId: "",
  calFilterTaskId: "",
  calShowDone: true,
};

let mobile = {
  screen: "ideas", // ideas | detail
};

function isMobile() {
  return window.matchMedia?.("(max-width: 920px)")?.matches ?? false;
}

function applyMobileLayout() {
  if (!isMobile()) {
    document.body.classList.remove("m-ideas", "m-detail");
    return;
  }
  if (appMode !== "ideas") {
    document.body.classList.remove("m-ideas", "m-detail");
    return;
  }
  document.body.classList.toggle("m-ideas", mobile.screen === "ideas");
  document.body.classList.toggle("m-detail", mobile.screen === "detail");
}

let dragSubtaskId = null;

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2600);
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function ensurePushSubscription() {
  if (!("serviceWorker" in navigator)) throw new Error("אין Service Worker בדפדפן הזה.");
  if (!("PushManager" in window)) throw new Error("הדפדפן לא תומך Push.");
  if (Notification.permission !== "granted") throw new Error("צריך לאשר התראות קודם.");

  pushServer.baseUrl = settings.pushServerUrl;
  if (!pushServer.vapidPublicKey) {
    const res = await fetch(`${pushServer.baseUrl}/vapidPublicKey`);
    if (!res.ok) {
      throw new Error(
        "השרת לא סיפק מפתח VAPID. בדקי שבהגדרות יש כתובת שרת נכונה, ושבקובץ server\\.env מוגדרים VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.",
      );
    }
    const json = await res.json();
    pushServer.vapidPublicKey = json.publicKey;
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(pushServer.vapidPublicKey),
    });
  }

  const resp = await fetch(`${pushServer.baseUrl}/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub, userKey: currentUserUid ?? "local" }),
  });
  if (!resp.ok) throw new Error("הרשמה לשרת נכשלה.");
  pushServer.subscribed = true;
  return sub;
}

async function upsertReminderForSubtask(subtaskId) {
  const found = findSubtaskById(subtaskId);
  if (!found) return;
  const { idea, task, sub } = found;
  const start = isoToDate(sub.startsAt);
  if (!start) return;
  if (sub.done) {
    await fetch(`${pushServer.baseUrl}/reminders/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtaskId, userKey: currentUserUid ?? "local" }),
    }).catch(() => {});
    return;
  }

  const reminders = [];
  const base = {
    title: `תזכורת: ${sub.title || "תת־משימה"}`,
    body: `${idea.title || "רעיון"} • ${task.title || "משימה"}`,
    url: "/",
  };
  const at = start.getTime();
  const before30 = at - 30 * 60 * 1000;

  if (settings.remindBefore30 && before30 > Date.now() - 60_000) {
    reminders.push({ key: "before30", ...base, fireAt: before30 });
  }
  if (settings.remindAtTime && at > Date.now() - 60_000) {
    reminders.push({ key: "at", ...base, fireAt: at });
  }
  if (reminders.length === 0) {
    await fetch(`${pushServer.baseUrl}/reminders/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtaskId, userKey: currentUserUid ?? "local" }),
    }).catch(() => {});
    return;
  }

  const payload = { subtaskId, reminders, userKey: currentUserUid ?? "local" };
  await fetch(`${pushServer.baseUrl}/reminders/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function findSubtaskById(subtaskId) {
  for (const idea of state.ideas) {
    for (const task of idea.tasks ?? []) {
      const sub = (task.subtasks ?? []).find((s) => s.id === subtaskId);
      if (sub) return { idea, task, sub };
    }
  }
  return null;
}

function shiftIsoToDateKeepingTime(iso, targetDate) {
  const d = isoToDate(iso);
  if (!d) return iso;
  const x = new Date(targetDate);
  x.setHours(d.getHours(), d.getMinutes(), 0, 0);
  return x.toISOString();
}

function getSelectedIdea() {
  return state.ideas.find((i) => i.id === state.selectedIdeaId) ?? null;
}

function ensureSelection() {
  if (state.selectedIdeaId && getSelectedIdea()) return;
  state.selectedIdeaId = state.ideas[0]?.id ?? null;
}

function persistAndRender() {
  ensureSelection();
  saveState(state);
  if (pushCloudDebounced) pushCloudDebounced();
  render();
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function computeHomeSummary() {
  const ideasCount = state.ideas.length;
  let tasksTotal = 0;
  let tasksDone = 0;
  for (const idea of state.ideas) {
    const tasks = idea.tasks ?? [];
    tasksTotal += tasks.length;
    tasksDone += tasks.filter((t) => computeTaskDone(t)).length;
  }

  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const allSubs = collectAllSubtasks().filter((x) => isoToDate(x.startsAt));

  const dueToday = allSubs.filter((x) => {
    const d = new Date(x.startsAt);
    return d >= today && d < tomorrow;
  }).length;

  const next = allSubs
    .filter((x) => !x.done && new Date(x.startsAt) >= now)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];

  const nextText = next
    ? `${new Date(next.startsAt).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" })} ${new Date(next.startsAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`
    : "—";

  return { ideasCount, tasksDone, tasksTotal, dueToday, nextText };
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function isoToDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function collectAllSubtasks() {
  const items = [];
  for (const idea of state.ideas) {
    for (const task of idea.tasks ?? []) {
      for (const sub of task.subtasks ?? []) {
        items.push({
          ideaId: idea.id,
          ideaTitle: idea.title || "ללא שם",
          taskId: task.id,
          taskTitle: task.title || "ללא שם",
          subtaskId: sub.id,
          subtaskTitle: sub.title || "ללא שם",
          done: !!sub.done,
          startsAt: sub.startsAt ?? null,
          endsAt: sub.endsAt ?? null,
        });
      }
    }
  }
  return items;
}

function filteredSubtasks() {
  const all = collectAllSubtasks().filter((x) => isoToDate(x.startsAt));
  return all.filter((x) => {
    if (!ui.calShowDone && x.done) return false;
    if (ui.calFilterIdeaId && x.ideaId !== ui.calFilterIdeaId) return false;
    if (ui.calFilterTaskId && x.taskId !== ui.calFilterTaskId) return false;
    return true;
  });
}

function formatHebrewDayTitle(d) {
  return d.toLocaleDateString("he-IL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
function formatHebrewMonthTitle(d) {
  return d.toLocaleDateString("he-IL", { year: "numeric", month: "long" });
}

function renderCalendarItem(it, opts = {}) {
  const compact = !!opts.compact;
  const starts = new Date(it.startsAt);
  const ends = isoToDate(it.endsAt);
  const time = starts.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  const time2 = ends ? ends.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : null;
  const when = time2 ? `${time}–${time2}` : time;

  const el = document.createElement("div");
  el.className = "cal-item";
  el.setAttribute("draggable", "true");
  el.setAttribute("data-subtask-id", it.subtaskId);
  el.innerHTML = `
    <div class="cal-item-top">
      <div class="cal-item-title">${escapeHtml(it.subtaskTitle)}</div>
      <div class="cal-item-actions">
        <div class="pill">${escapeHtml(when)}</div>
        <input class="cal-checkbox" type="checkbox" ${it.done ? "checked" : ""} data-action="toggle-subtask-from-calendar" data-subtask-id="${it.subtaskId}" aria-label="סימון תת־משימה" />
      </div>
    </div>
    ${compact ? "" : `<div class="cal-item-meta">רעיון: ${escapeHtml(it.ideaTitle)} • משימה: ${escapeHtml(it.taskTitle)}</div>`}
  `;

  el.addEventListener("dragstart", () => {
    dragSubtaskId = it.subtaskId;
  });
  el.addEventListener("click", (e) => {
    if (e.target?.closest?.('input[type="checkbox"]')) return;
    openEventDialog(it.subtaskId);
  });
  return el;
}

function renderCalendar() {
  const anchor = isoToDate(ui.calAnchorIso) ?? new Date();
  const mode = ui.calMode;
  const now = new Date();
  els.calendarGrid.innerHTML = "";

  const all = filteredSubtasks();
  all.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));

  const setModeButtons = () => {
    const map = { day: els.calModeDay, week: els.calModeWeek, month: els.calModeMonth };
    for (const [k, el] of Object.entries(map)) el.classList.toggle("active", k === ui.calMode);
  };
  setModeButtons();

  if (mode === "day") {
    const day = startOfDay(anchor);
    els.calTitle.textContent = formatHebrewDayTitle(day);
    const list = document.createElement("div");
    list.className = "cal-list";
    const items = all.filter((x) => sameDay(startOfDay(new Date(x.startsAt)), day));
    if (items.length === 0) {
      list.innerHTML = `<div class="empty"><div class="empty-text">אין תתי־משימות מתוזמנות ליום הזה.</div></div>`;
    } else {
      for (const it of items) list.appendChild(renderCalendarItem(it));
    }
    els.calendarGrid.appendChild(list);
    return;
  }

  if (mode === "week") {
    const day = startOfDay(anchor);
    const start = addDays(day, -day.getDay()); // שבוע מתחיל ביום א׳
    const end = addDays(start, 7);
    els.calTitle.textContent = `${formatHebrewDayTitle(start)} — ${formatHebrewDayTitle(addDays(end, -1))}`;
    const list = document.createElement("div");
    list.className = "cal-list";
    const items = all.filter((x) => {
      const d = new Date(x.startsAt);
      return d >= start && d < end;
    });
    if (items.length === 0) {
      list.innerHTML = `<div class="empty"><div class="empty-text">אין תתי־משימות מתוזמנות בשבוע הזה.</div></div>`;
    } else {
      for (const it of items) list.appendChild(renderCalendarItem(it));
    }
    els.calendarGrid.appendChild(list);
    return;
  }

  const monthStart = startOfDay(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  els.calTitle.textContent = formatHebrewMonthTitle(monthStart);
  const grid = document.createElement("div");
  grid.className = "month-grid";
  const firstCell = addDays(monthStart, -monthStart.getDay());
  const cells = 42;
  for (let i = 0; i < cells; i++) {
    const cellDay = addDays(firstCell, i);
    const cell = document.createElement("div");
    cell.className = `month-cell ${sameDay(startOfDay(cellDay), startOfDay(now)) ? "today" : ""}`;
    cell.setAttribute("data-day-iso", startOfDay(cellDay).toISOString());
    const items = all.filter((x) => sameDay(startOfDay(new Date(x.startsAt)), cellDay));
    cell.innerHTML = `
      <div class="month-cell-header">
        <div>${cellDay.getDate()}</div>
        <div class="month-badge">${items.length}</div>
      </div>
    `;
    if (items.length) {
      const mini = document.createElement("div");
      mini.className = "cal-list";
      for (const it of items.slice(0, 3)) mini.appendChild(renderCalendarItem(it, { compact: true }));
      if (items.length > 3) {
        const more = document.createElement("div");
        more.className = "cal-item-meta";
        more.textContent = `+ עוד ${items.length - 3}`;
        mini.appendChild(more);
      }
      cell.appendChild(mini);
    }

    cell.addEventListener("dragover", (e) => {
      if (!dragSubtaskId) return;
      e.preventDefault();
      cell.classList.add("drop");
    });
    cell.addEventListener("dragleave", () => cell.classList.remove("drop"));
    cell.addEventListener("drop", (e) => {
      e.preventDefault();
      cell.classList.remove("drop");
      if (!dragSubtaskId) return;
      const info = findSubtaskById(dragSubtaskId);
      dragSubtaskId = null;
      if (!info?.sub?.startsAt) return;
      const targetIso = cell.getAttribute("data-day-iso");
      const targetDate = isoToDate(targetIso);
      if (!targetDate) return;
      const oldStart = info.sub.startsAt;
      const oldEnd = info.sub.endsAt;
      info.sub.startsAt = shiftIsoToDateKeepingTime(oldStart, targetDate);
      if (oldEnd) info.sub.endsAt = shiftIsoToDateKeepingTime(oldEnd, targetDate);
      persistAndRender();
      if (pushServer.subscribed) upsertReminderForSubtask(info.sub.id).catch(() => {});
      toast("עודכן בלוח: התת־משימה הוזזה ליום אחר.");
    });

    grid.appendChild(cell);
  }
  els.calendarGrid.appendChild(grid);
}

function renderIdeas() {
  els.ideasList.innerHTML = "";

  if (state.ideas.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `<div class="empty-title">אין רעיונות עדיין</div><div class="empty-text">הוסיפי רעיון ראשון כדי להתחיל לבנות אסטרטגיה.</div>`;
    els.ideasList.appendChild(div);
    return;
  }

  for (const idea of state.ideas) {
    const done = computeIdeaDone(idea);
    const counts = countIdeaTasks(idea);

    const row = document.createElement("div");
    row.className = `row ${idea.id === state.selectedIdeaId ? "selected" : ""}`;
    row.setAttribute("role", "listitem");

    row.innerHTML = `
      <input class="check" type="checkbox" ${done ? "checked" : ""} data-action="toggle-idea-done" data-idea-id="${idea.id}" aria-label="סימון רעיון (מסמן/מבטל את כל המשימות)" />
      <div class="row-main">
        <div class="row-title">${escapeHtml(idea.title || "ללא שם")}</div>
        <div class="row-meta">
          <span class="pill">משימות: ${counts.done}/${counts.total}</span>
        </div>
      </div>
      <div class="row-actions">
        <button class="icon-btn danger" type="button" data-action="delete-idea" data-idea-id="${idea.id}" title="מחיקת רעיון">🗑</button>
      </div>
    `;

    row.addEventListener("click", (e) => {
      const target = e.target;
      if (target?.closest?.("button")) return;
      if (target?.closest?.('input[type="checkbox"]')) return;
      state.selectedIdeaId = idea.id;
      if (isMobile()) {
        mobile.screen = "detail";
        ui.tab = "idea";
      }
      persistAndRender();
    });

    els.ideasList.appendChild(row);
  }
}

function renderIdeaView() {
  const idea = getSelectedIdea();
  if (!idea) {
    els.emptyState.classList.remove("hidden");
    els.ideaView.classList.add("hidden");
    els.calendarView.classList.add("hidden");
    els.tasksView.classList.add("hidden");
    return;
  }

  els.emptyState.classList.add("hidden");
  els.ideaView.classList.remove("hidden");
  els.ideaView.classList.toggle("hidden", ui.tab !== "idea");
  els.calendarView.classList.toggle("hidden", ui.tab !== "calendar");
  els.tasksView.classList.toggle("hidden", ui.tab !== "tasks");

  const counts = countIdeaTasks(idea);
  els.currentIdeaTitle.textContent = idea.title || "ללא שם";
  els.currentIdeaMeta.textContent = `משימות שהושלמו: ${counts.done}/${counts.total} • סימון רעיון מתבצע אוטומטית כשכל המשימות הושלמו`;
  els.ideaStrategyInput.value = idea.strategy || "";

  renderTasks(idea);
  if (ui.tab === "calendar") renderCalendar();
  if (ui.tab === "tasks") renderTasksAll();
}

function renderTasksAll() {
  const q = String(els.tasksSearch?.value ?? "").trim().toLowerCase();
  const items = filteredSubtasks().sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const filtered = q
    ? items.filter((x) => (x.subtaskTitle + " " + x.taskTitle + " " + x.ideaTitle).toLowerCase().includes(q))
    : items;

  els.tasksListAll.innerHTML = "";
  if (filtered.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `<div class="empty-text">אין תתי־משימות להצגה.</div>`;
    els.tasksListAll.appendChild(div);
    return;
  }

  for (const it of filtered) {
    const row = document.createElement("div");
    row.className = "row";
    const d = new Date(it.startsAt);
    const dateText = d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
    const timeText = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    row.innerHTML = `
      <input class="check" type="checkbox" ${it.done ? "checked" : ""} data-action="toggle-subtask-from-calendar" data-subtask-id="${it.subtaskId}" aria-label="סימון תת־משימה" />
      <div class="row-main">
        <div class="row-title">${escapeHtml(it.subtaskTitle)}</div>
        <div class="row-meta">
          <span class="pill">${escapeHtml(dateText)} ${escapeHtml(timeText)}</span>
          <span class="pill">${escapeHtml(it.ideaTitle)}</span>
          <span class="pill">${escapeHtml(it.taskTitle)}</span>
        </div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" type="button" data-action="open-subtask" data-subtask-id="${it.subtaskId}" title="עריכה">✎</button>
      </div>
    `;
    els.tasksListAll.appendChild(row);
  }
}

function rebuildCalendarFiltersUI() {
  const ideaSel = document.getElementById("calFilterIdea");
  const taskSel = document.getElementById("calFilterTask");
  const showDone = document.getElementById("calShowDone");
  if (!ideaSel || !taskSel || !showDone) return;

  const prevIdea = ui.calFilterIdeaId;
  const prevTask = ui.calFilterTaskId;

  ideaSel.innerHTML = `<option value="">כל הרעיונות</option>`;
  for (const idea of state.ideas) {
    const opt = document.createElement("option");
    opt.value = idea.id;
    opt.textContent = idea.title || "ללא שם";
    ideaSel.appendChild(opt);
  }
  ideaSel.value = prevIdea;

  taskSel.innerHTML = `<option value="">כל המשימות</option>`;
  const tasks = [];
  for (const idea of state.ideas) {
    if (ui.calFilterIdeaId && idea.id !== ui.calFilterIdeaId) continue;
    for (const task of idea.tasks ?? []) tasks.push(task);
  }
  for (const task of tasks) {
    const opt = document.createElement("option");
    opt.value = task.id;
    opt.textContent = task.title || "ללא שם";
    taskSel.appendChild(opt);
  }
  taskSel.value = prevTask;

  showDone.checked = !!ui.calShowDone;
}

function openEventDialog(subtaskId) {
  const dlg = document.getElementById("eventDialog");
  const titleEl = document.getElementById("eventTitle");
  const metaEl = document.getElementById("eventMeta");
  const startEl = document.getElementById("eventStart");
  const endEl = document.getElementById("eventEnd");
  const doneEl = document.getElementById("eventDone");
  const hintEl = document.getElementById("eventHint");
  const saveBtn = document.getElementById("eventSave");
  if (!dlg || !titleEl || !metaEl || !startEl || !endEl || !doneEl || !hintEl || !saveBtn) return;

  const found = findSubtaskById(subtaskId);
  if (!found) return;
  const { idea, task, sub } = found;

  titleEl.textContent = sub.title || "תת־משימה";
  metaEl.textContent = `רעיון: ${idea.title || "ללא שם"} • משימה: ${task.title || "ללא שם"}`;
  startEl.value = formatDateTimeValue(sub.startsAt);
  endEl.value = formatDateTimeValue(sub.endsAt);
  doneEl.checked = !!sub.done;
  hintEl.textContent = "";

  saveBtn.onclick = () => {
    sub.startsAt = fromLocalInputToIso(startEl.value);
    sub.endsAt = fromLocalInputToIso(endEl.value);
    sub.done = !!doneEl.checked;
    persistAndRender();
    if (pushServer.subscribed) upsertReminderForSubtask(subtaskId).catch(() => {});
    dlg.close();
    toast("עודכן מהלוח.");
  };

  dlg.showModal();
}

function renderTasks(idea) {
  els.tasksList.innerHTML = "";

  if ((idea.tasks ?? []).length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `<div class="empty-title">אין משימות עדיין</div><div class="empty-text">הוסיפי משימה ואז צרי לה תתי־משימות עם תאריך ושעה.</div>`;
    els.tasksList.appendChild(div);
    return;
  }

  for (const task of idea.tasks) {
    const done = computeTaskDone(task);
    const { total, done: doneSubs } = countTaskSubtasks(task);

    const row = document.createElement("div");
    row.className = "row";

    const isOpen = !!task.uiOpen;
    row.innerHTML = `
      <input class="check" type="checkbox" ${done ? "checked" : ""} data-action="toggle-task-done" data-task-id="${task.id}" aria-label="סימון משימה (מסמן/מבטל את כל תתי־המשימות)" />
      <div class="row-main">
        <div class="row-title">${escapeHtml(task.title || "ללא שם")}</div>
        <div class="row-meta">
          <span class="pill">תתי־משימות: ${doneSubs}/${total}</span>
        </div>
        <div class="task-details ${isOpen ? "" : "hidden"}" data-task-details="${task.id}">
          <div class="subtasks-header">
            <div>תתי־משימות (סימון המשימה מתבצע אוטומטית כשכולן מסומנות)</div>
          </div>
          <form class="add-row" data-add-subtask-form="${task.id}" autocomplete="off">
            <input class="input" name="subtaskTitle" type="text" placeholder="תת־משימה חדשה…" maxlength="160" required />
            <input class="dt" name="subtaskStart" type="datetime-local" title="התחלה" />
            <input class="dt" name="subtaskEnd" type="datetime-local" title="סיום (אופציונלי)" />
            <button class="btn" type="submit">הוספה</button>
          </form>
          <div class="subtasks-list" data-subtasks-list="${task.id}"></div>
        </div>
      </div>
      <div class="row-actions">
        <button class="icon-btn" type="button" data-action="toggle-task" data-task-id="${task.id}" title="פתיחה/סגירה">${isOpen ? "▾" : "▸"}</button>
        <button class="icon-btn danger" type="button" data-action="delete-task" data-task-id="${task.id}" title="מחיקת משימה">🗑</button>
      </div>
    `;

    els.tasksList.appendChild(row);

    const subtasksListEl = row.querySelector(`[data-subtasks-list="${task.id}"]`);
    renderSubtasks(idea, task, subtasksListEl);

    const addSubtaskForm = row.querySelector(`[data-add-subtask-form="${task.id}"]`);
    addSubtaskForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(addSubtaskForm);
      const title = String(fd.get("subtaskTitle") ?? "").trim();
      const startLocal = String(fd.get("subtaskStart") ?? "").trim();
      const endLocal = String(fd.get("subtaskEnd") ?? "").trim();
      if (!title) return;

      task.subtasks = task.subtasks ?? [];
      task.subtasks.push({
        id: uid("sub"),
        title,
        done: false,
        startsAt: fromLocalInputToIso(startLocal),
        endsAt: fromLocalInputToIso(endLocal),
      });
      task.uiOpen = true;
      persistAndRender();
      if (pushServer.subscribed) upsertReminderForSubtask(task.subtasks[task.subtasks.length - 1].id).catch(() => {});
    });
  }
}

function renderSubtasks(idea, task, subtasksListEl) {
  subtasksListEl.innerHTML = "";
  const subtasks = task.subtasks ?? [];

  if (subtasks.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `<div class="empty-text">הוסיפי תת־משימה ראשונה למשימה הזו.</div>`;
    subtasksListEl.appendChild(div);
    return;
  }

  for (const sub of subtasks) {
    const row = document.createElement("div");
    row.className = "subtask-row";
    row.innerHTML = `
      <input class="check" type="checkbox" ${sub.done ? "checked" : ""} aria-label="סימון תת־משימה" data-action="toggle-subtask" data-subtask-id="${sub.id}" />
      <div class="subtask-title">${escapeHtml(sub.title || "ללא שם")}</div>
      <input class="dt" type="datetime-local" value="${escapeHtml(formatDateTimeValue(sub.startsAt))}" data-action="set-subtask-start" data-subtask-id="${sub.id}" title="התחלה" />
      <input class="dt" type="datetime-local" value="${escapeHtml(formatDateTimeValue(sub.endsAt))}" data-action="set-subtask-end" data-subtask-id="${sub.id}" title="סיום" />
      <button class="icon-btn danger" type="button" data-action="delete-subtask" data-subtask-id="${sub.id}" title="מחיקת תת־משימה">🗑</button>
    `;
    subtasksListEl.appendChild(row);
  }

  subtasksListEl.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action !== "delete-subtask") return;

    const id = btn.getAttribute("data-subtask-id");
    if (!id) return;
    task.subtasks = (task.subtasks ?? []).filter((s) => s.id !== id);
    persistAndRender();
    if (pushServer.subscribed) fetch(`${pushServer.baseUrl}/reminders/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subtaskId: id, userKey: currentUserUid ?? "local" }) }).catch(() => {});
  });

  subtasksListEl.addEventListener("change", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return;
    const action = el.getAttribute("data-action");
    const id = el.getAttribute("data-subtask-id");
    if (!id) return;

    const sub = (task.subtasks ?? []).find((s) => s.id === id);
    if (!sub) return;

    if (action === "toggle-subtask") {
      sub.done = el.checked;
      persistAndRender();
      if (pushServer.subscribed) upsertReminderForSubtask(id).catch(() => {});
      return;
    }

    if (action === "set-subtask-start") {
      sub.startsAt = fromLocalInputToIso(el.value);
      persistAndRender();
      if (pushServer.subscribed) upsertReminderForSubtask(id).catch(() => {});
      return;
    }

    if (action === "set-subtask-end") {
      sub.endsAt = fromLocalInputToIso(el.value);
      persistAndRender();
      if (pushServer.subscribed) upsertReminderForSubtask(id).catch(() => {});
    }
  });
}

function wireGlobalHandlers() {
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsDialog = document.getElementById("settingsDialog");
  const setBefore30 = document.getElementById("setRemindBefore30");
  const setAtTime = document.getElementById("setRemindAtTime");
  const setPushUrl = document.getElementById("setPushUrl");
  const setDefaultCalMode = document.getElementById("setDefaultCalMode");
  const settingsSave = document.getElementById("settingsSave");

  if (settingsBtn && settingsDialog && setBefore30 && setAtTime && setPushUrl && setDefaultCalMode && settingsSave) {
    settingsBtn.addEventListener("click", () => {
      setBefore30.checked = !!settings.remindBefore30;
      setAtTime.checked = !!settings.remindAtTime;
      setPushUrl.value = settings.pushServerUrl;
      setDefaultCalMode.value = settings.defaultCalMode;
      settingsDialog.showModal();
    });

    settingsSave.addEventListener("click", async () => {
      settings.remindBefore30 = !!setBefore30.checked;
      settings.remindAtTime = !!setAtTime.checked;
      settings.pushServerUrl = String(setPushUrl.value ?? "").trim() || "http://localhost:8787";
      settings.defaultCalMode = String(setDefaultCalMode.value ?? "week");
      saveSettings();

      pushServer.baseUrl = settings.pushServerUrl;
      pushServer.vapidPublicKey = null;
      pushServer.subscribed = false;
      ui.calMode = settings.defaultCalMode;

      settingsDialog.close();
      toast("ההגדרות נשמרו.");

      // If already granted, re-subscribe to the new server URL
      if (Notification.permission === "granted") {
        try {
          await ensurePushSubscription();
          toast("מחובר לשרת התזכורות לפי ההגדרות.");
        } catch {
          // ignore
        }
      }
      persistAndRender();
    });
  }

  const notifyBtn = document.getElementById("notifyBtn");
  if (notifyBtn) {
    notifyBtn.addEventListener("click", async () => {
      try {
        if (!("Notification" in window)) throw new Error("הדפדפן לא תומך בהתראות.");
        const res = await Notification.requestPermission();
        if (res !== "granted") {
          toast("התראות לא הופעלו (לא אושר).");
          return;
        }
        await ensurePushSubscription();
        toast("התראות הופעלו + נרשמת לתזכורות אמיתיות.");
      } catch (e) {
        toast(String(e?.message ?? e));
      }
    });
  }

  els.authBtn.addEventListener("click", () => {
    els.authHint.textContent = "";
    els.authDialog.showModal();
  });

  const authError = (err) => {
    els.authHint.textContent = String(err?.message ?? err ?? "שגיאה");
  };

  els.authLogin.addEventListener("click", async () => {
    try {
      if (!cloud) throw new Error("סנכרון לא מאותחל");
      await cloud.login(String(els.authEmail.value ?? "").trim(), String(els.authPassword.value ?? "").trim());
      els.authHint.textContent = "התחברת. הסנכרון פעיל.";
    } catch (e) {
      authError(e);
    }
  });
  els.authSignup.addEventListener("click", async () => {
    try {
      if (!cloud) throw new Error("סנכרון לא מאותחל");
      await cloud.signup(String(els.authEmail.value ?? "").trim(), String(els.authPassword.value ?? "").trim());
      els.authHint.textContent = "נרשמת והתחברת. הסנכרון פעיל.";
    } catch (e) {
      authError(e);
    }
  });
  els.authLogout.addEventListener("click", async () => {
    try {
      if (!cloud) throw new Error("סנכרון לא מאותחל");
      await cloud.logout();
      els.authHint.textContent = "התנתקת.";
    } catch (e) {
      authError(e);
    }
  });

  els.resetBtn.addEventListener("click", () => {
    const ok = confirm("למחוק את כל הנתונים? (רעיונות + יומן יומי — איפוס מלא)");
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(DAY_JOURNAL_STORAGE_KEY);
    localStorage.removeItem(FUTURE_DAY_KEY);
    state = loadState();
    dayJournal = loadDayJournal();
    historySelectedKey = null;
    persistAndRender();
  });

  els.addIdeaForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = els.ideaTitleInput.value.trim();
    if (!title) return;
    const idea = { id: uid("idea"), title, strategy: "", tasks: [] };
    state.ideas.unshift(idea);
    state.selectedIdeaId = idea.id;
    els.ideaTitleInput.value = "";
    persistAndRender();
  });

  const saveStrategy = debounce(250, () => {
    const idea = getSelectedIdea();
    if (!idea) return;
    idea.strategy = els.ideaStrategyInput.value ?? "";
    persistAndRender();
  });
  els.ideaStrategyInput.addEventListener("input", saveStrategy);

  els.addTaskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const idea = getSelectedIdea();
    if (!idea) return;
    const title = els.taskTitleInput.value.trim();
    if (!title) return;
    idea.tasks = idea.tasks ?? [];
    idea.tasks.unshift({ id: uid("task"), title, subtasks: [], uiOpen: true });
    els.taskTitleInput.value = "";
    persistAndRender();
  });

  const setTab = (tab) => {
    ui.tab = tab;
    els.tabIdea.classList.toggle("active", tab === "idea");
    els.tabCalendar.classList.toggle("active", tab === "calendar");
    els.tabTasks.classList.toggle("active", tab === "tasks");
    els.tabIdea.setAttribute("aria-selected", tab === "idea" ? "true" : "false");
    els.tabCalendar.setAttribute("aria-selected", tab === "calendar" ? "true" : "false");
    els.tabTasks.setAttribute("aria-selected", tab === "tasks" ? "true" : "false");
    persistAndRender();
  };
  els.tabIdea.addEventListener("click", () => setTab("idea"));
  els.tabCalendar.addEventListener("click", () => setTab("calendar"));
  els.tabTasks.addEventListener("click", () => setTab("tasks"));

  const bindAppMode = (id, mode) => {
    document.getElementById(id)?.addEventListener("click", () => setAppMode(mode));
  };
  bindAppMode("tnDailyToday", "daily-today");
  bindAppMode("tnIdeas", "ideas");
  bindAppMode("tnDailyFuture", "daily-future");
  bindAppMode("tnDailyHistory", "daily-history");
  bindAppMode("bnDailyToday", "daily-today");
  bindAppMode("bnIdeas", "ideas");
  bindAppMode("bnDailyFuture", "daily-future");
  bindAppMode("bnDailyHistory", "daily-history");
  document.getElementById("bnSettings")?.addEventListener("click", () => {
    document.getElementById("settingsBtn")?.click();
  });

  document.getElementById("mobileBack")?.addEventListener("click", () => {
    mobile.screen = "ideas";
    persistAndRender();
  });

  document.getElementById("ideaExportBtn")?.addEventListener("click", openExportDialog);
  document.getElementById("ideaExportBtnMobile")?.addEventListener("click", openExportDialog);

  const exportCopy = document.getElementById("exportCopy");
  const exportWhatsApp = document.getElementById("exportWhatsApp");
  const exportEmail = document.getElementById("exportEmail");
  const exportPrint = document.getElementById("exportPrint");
  const exportText = document.getElementById("exportText");
  const exportHint = document.getElementById("exportHint");

  exportCopy?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(String(exportText?.value ?? ""));
      if (exportHint) exportHint.textContent = "הועתק ללוח.";
    } catch {
      if (exportHint) exportHint.textContent = "לא הצלחתי להעתיק אוטומטית. אפשר לסמן ולהעתיק ידנית.";
    }
  });

  exportWhatsApp?.addEventListener("click", () => {
    const text = encodeURIComponent(String(exportText?.value ?? ""));
    window.open(`https://wa.me/?text=${text}`, "_blank");
  });

  exportEmail?.addEventListener("click", () => {
    const idea = getSelectedIdea();
    const subject = encodeURIComponent(`Idea Planner: ${idea?.title || "רעיון"}`);
    const body = encodeURIComponent(String(exportText?.value ?? ""));
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  });

  exportPrint?.addEventListener("click", () => {
    const idea = getSelectedIdea();
    const content = String(exportText?.value ?? "");
    const w = window.open("", "_blank");
    if (!w) {
      if (exportHint) exportHint.textContent = "חלון הדפסה נחסם. אפשר לאפשר Popups לדפדפן.";
      return;
    }
    const html = `
      <html lang="he" dir="rtl">
        <head>
          <meta charset="UTF-8" />
          <title>${escapeHtml(idea?.title || "Idea Planner")}</title>
          <style>
            body{ font-family: Arial, sans-serif; padding: 18px; direction: rtl; }
            h1{ margin:0 0 8px; }
            pre{ white-space: pre-wrap; font-size: 14px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <h1>${escapeHtml(idea?.title || "רעיון")}</h1>
          <pre>${escapeHtml(content)}</pre>
          <script>window.print();</script>
        </body>
      </html>
    `;
    w.document.open();
    w.document.write(html);
    w.document.close();
  });

  els.tasksSearch?.addEventListener("input", debounce(120, () => persistAndRender()));

  const setCalMode = (mode) => {
    ui.calMode = mode;
    persistAndRender();
  };
  els.calModeDay.addEventListener("click", () => setCalMode("day"));
  els.calModeWeek.addEventListener("click", () => setCalMode("week"));
  els.calModeMonth.addEventListener("click", () => setCalMode("month"));

  const ideaSel = document.getElementById("calFilterIdea");
  const taskSel = document.getElementById("calFilterTask");
  const showDone = document.getElementById("calShowDone");
  if (ideaSel && taskSel && showDone) {
    ideaSel.addEventListener("change", () => {
      ui.calFilterIdeaId = ideaSel.value;
      ui.calFilterTaskId = "";
      persistAndRender();
    });
    taskSel.addEventListener("change", () => {
      ui.calFilterTaskId = taskSel.value;
      persistAndRender();
    });
    showDone.addEventListener("change", () => {
      ui.calShowDone = !!showDone.checked;
      persistAndRender();
    });
  }

  const shiftAnchor = (dir) => {
    const a = isoToDate(ui.calAnchorIso) ?? new Date();
    if (ui.calMode === "day") ui.calAnchorIso = addDays(a, dir).toISOString();
    else if (ui.calMode === "week") ui.calAnchorIso = addDays(a, dir * 7).toISOString();
    else ui.calAnchorIso = new Date(a.getFullYear(), a.getMonth() + dir, 1).toISOString();
    persistAndRender();
  };
  els.calPrev.addEventListener("click", () => shiftAnchor(-1));
  els.calNext.addEventListener("click", () => shiftAnchor(1));
  els.calToday.addEventListener("click", () => {
    ui.calAnchorIso = new Date().toISOString();
    persistAndRender();
  });

  document.body.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button");
    if (!btn) return;
    const action = btn.getAttribute("data-action");

    if (action === "daily-delete") {
      const dk = btn.getAttribute("data-date-key");
      const id = btn.getAttribute("data-item-id");
      if (!dk || !id) return;
      deleteDayItem(dayJournal, dk, id);
      saveDayJournal(dayJournal);
      render();
      return;
    }

    if (action === "open-subtask") {
      const subId = btn.getAttribute("data-subtask-id");
      if (subId) openEventDialog(subId);
      return;
    }

    if (action === "delete-idea") {
      const id = btn.getAttribute("data-idea-id");
      if (!id) return;
      const idea = state.ideas.find((i) => i.id === id);
      if (!idea) return;
      const ok = confirm(`למחוק את הרעיון "${idea.title || "ללא שם"}"?`);
      if (!ok) return;
      state.ideas = state.ideas.filter((i) => i.id !== id);
      if (state.selectedIdeaId === id) state.selectedIdeaId = state.ideas[0]?.id ?? null;
      persistAndRender();
      return;
    }

    if (action === "toggle-task") {
      const taskId = btn.getAttribute("data-task-id");
      const idea = getSelectedIdea();
      if (!idea || !taskId) return;
      const task = (idea.tasks ?? []).find((t) => t.id === taskId);
      if (!task) return;
      task.uiOpen = !task.uiOpen;
      persistAndRender();
      return;
    }

    if (action === "delete-task") {
      const taskId = btn.getAttribute("data-task-id");
      const idea = getSelectedIdea();
      if (!idea || !taskId) return;
      const task = (idea.tasks ?? []).find((t) => t.id === taskId);
      if (!task) return;
      const ok = confirm(`למחוק את המשימה "${task.title || "ללא שם"}"?`);
      if (!ok) return;
      idea.tasks = (idea.tasks ?? []).filter((t) => t.id !== taskId);
      persistAndRender();
    }
  });

  document.body.addEventListener("change", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement)) return;
    const action = el.getAttribute("data-action");

    if (action === "daily-toggle") {
      const dk = el.getAttribute("data-date-key");
      const id = el.getAttribute("data-item-id");
      if (!dk || !id) return;
      toggleDayItem(dayJournal, dk, id);
      saveDayJournal(dayJournal);
      render();
      return;
    }

    if (action === "toggle-idea-done") {
      const id = el.getAttribute("data-idea-id");
      if (!id) return;
      const idea = state.ideas.find((i) => i.id === id);
      if (!idea) return;
      setIdeaDone(idea, el.checked);
      persistAndRender();
      return;
    }

    if (action === "toggle-task-done") {
      const taskId = el.getAttribute("data-task-id");
      const idea = getSelectedIdea();
      if (!idea || !taskId) return;
      const task = (idea.tasks ?? []).find((t) => t.id === taskId);
      if (!task) return;
      setTaskDone(task, el.checked);
      persistAndRender();
    }

    if (action === "toggle-subtask-from-calendar") {
      const subId = el.getAttribute("data-subtask-id");
      if (!subId) return;
      const found = findSubtaskById(subId);
      if (!found) return;
      found.sub.done = el.checked;
      persistAndRender();
      if (pushServer.subscribed) upsertReminderForSubtask(subId).catch(() => {});
    }
  });

  document.getElementById("dailyTodayForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("dailyTodayInput");
    const t = String(input?.value ?? "").trim();
    if (!t) return;
    addDayItem(dayJournal, localDateKey(), uid("ditem"), t);
    saveDayJournal(dayJournal);
    input.value = "";
    render();
  });

  document.getElementById("dailyFutureForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const tk = localDateKey();
    const picker = document.getElementById("dailyFuturePicker");
    let dateKey = picker?.value && picker.value > tk ? picker.value : loadFutureDayKey(tk);
    if (dateKey <= tk) dateKey = nextDayKeyAfter(tk);
    const input = document.getElementById("dailyFutureInput");
    const t = String(input?.value ?? "").trim();
    if (!t) return;
    addDayItem(dayJournal, dateKey, uid("ditem"), t);
    saveDayJournal(dayJournal);
    saveFutureDayKey(dateKey);
    if (picker) picker.value = dateKey;
    input.value = "";
    render();
  });

  document.getElementById("dailyFuturePicker")?.addEventListener("change", (e) => {
    const tk = localDateKey();
    const v = e.target?.value;
    if (v && v > tk) {
      saveFutureDayKey(v);
      render();
    }
  });
}

function render() {
  const tk = localDateKey();
  if (tk !== lastKnownCalendarDayKey) lastKnownCalendarDayKey = tk;

  updateAppViewsVisibility();
  syncAppNavActive();
  document.body.classList.toggle("app-mode-ideas", appMode === "ideas");

  if (appMode === "ideas") {
    ensureSelection();
    renderIdeas();
    renderIdeaView();
    rebuildCalendarFiltersUI();

    const s = computeHomeSummary();
    if (els.hsIdeas) els.hsIdeas.textContent = String(s.ideasCount);
    if (els.hsTasks) els.hsTasks.textContent = `${s.tasksDone}/${s.tasksTotal}`;
    if (els.hsToday) els.hsToday.textContent = String(s.dueToday);
    if (els.hsNext) els.hsNext.textContent = s.nextText;
  }

  if (appMode === "daily-today") renderDailyTodayPage();
  if (appMode === "daily-future") renderDailyFuturePage();
  if (appMode === "daily-history") renderDailyHistoryPage();

  applyMobileLayout();
}

ensureSelection();
wireGlobalHandlers();

setInterval(() => {
  const k = localDateKey();
  if (k !== lastKnownCalendarDayKey) {
    lastKnownCalendarDayKey = k;
    render();
  }
}, 60_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});

async function bootCloud() {
  try {
    const { initCloudSync } = await import("./cloud-sync.js");
    cloud = await initCloudSync({
      onRemoteState: (remoteState) => {
        // Remote is source of truth after login (last-write-wins at doc level)
        if (!remoteState || typeof remoteState !== "object") return;
        state = remoteState;
        persistAndRender();
      },
      onStatus: ({ mode, userEmail, userUid, enabled, error }) => {
        if (!enabled) {
          els.authStatus.textContent = "מצב: מקומי";
          els.authBtn.textContent = "התחברות";
          if (error) els.authHint.textContent = error;
          return;
        }
        if (mode === "cloud") {
          currentUserUid = userUid ?? null;
          els.authStatus.textContent = `מסונכרן: ${userEmail ?? "מחובר"}`;
          els.authBtn.textContent = "חשבון";
        } else {
          currentUserUid = null;
          els.authStatus.textContent = "מצב: מקומי";
          els.authBtn.textContent = "התחברות";
          if (error) els.authHint.textContent = error;
        }
      },
    });

    pushCloudDebounced = debounce(CLOUD_DEBOUNCE_MS, async () => {
      try {
        await cloud?.pushState?.(state);
      } catch (e) {
        // Don't break UX; show hint if dialog is open
        if (els.authDialog?.open) els.authHint.textContent = String(e?.message ?? e);
      }
    });
  } catch (e) {
    els.authStatus.textContent = "מצב: מקומי";
  }
}

bootCloud();
persistAndRender();

