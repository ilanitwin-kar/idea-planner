import {
  DAY_JOURNAL_STORAGE_KEY,
  loadDayJournal,
  saveDayJournal,
  localDateKey,
  addDaysToDateKey,
  addDayItem,
  toggleDayItem,
  deleteDayItem,
  updateDayItemTitle,
  dayProgress,
} from "./daily-journal.js";
import {
  TIMING_LOG_KEY,
  loadTimingState,
  startDayItemTimer,
  stopDayItemTimer,
  cancelActiveTimer,
  timersMatch,
  setAfterTimingPersist,
} from "./daily-timing-log.js";
import {
  isCloudBackupConfigured,
  initCloudBackup,
  setupCloudBackupListeners,
  uploadCloudSnapshot,
  fetchCloudSnapshot,
  applyCloudSnapshotToLocalStorage,
  signInCloudWithGoogle,
  signOutCloud,
  getCloudUser,
} from "./cloud-backup.js";
import {
  PANTRY_STORAGE_KEY,
  PANTRY_LOCATIONS,
  pantryLocationLabel,
  loadPantry,
  addPantryItem,
  deletePantryItem,
  updatePantryItem,
  consumePantry,
  restockPantry,
  applyPantryImportRows,
} from "./pantry.js";
import { lookupOpenFoodFactsProduct, normalizeBarcodeInput } from "./pantry-barcode.js";
import {
  HOURLY_SCHEDULE_STORAGE_KEY,
  loadHourlySchedule,
  saveHourlySchedule,
  addScheduleBlock,
  updateScheduleBlock,
  deleteScheduleBlock,
  toggleScheduleBlockDone,
  addScheduleSub,
  toggleScheduleSubDone,
  deleteScheduleSub,
  blocksForDay,
  blockHasTime,
  scheduleDayProgress,
  minutesToTimeString,
} from "./hourly-schedule.js";
import {
  enableHourlyPush,
  syncHourlyRemindersToServer,
  tickLocalHourlyReminders,
  notificationPermission,
  pushStatusText,
  iosNeedsHomeScreenForPush,
} from "./push-client.js";
import {
  LUNCH_PLANNER_STORAGE_KEY,
  loadLunchPlanner,
  saveLunchPlanner,
  weekStartKeyFromDateKey,
  weekDayKeys,
  planEntriesForDay,
  findOrCreateMealFromParts,
  normalizePartList,
  dishParts,
  mealTitleForParts,
  partsSignature,
  applyPartsToDish,
  findDishPlannedElsewhereInWeek,
  findMealPlannedElsewhereInWeek,
  planEntryMealParts,
  addPlanEntry,
  addPlanEntryFromParts,
  updatePlanEntryFromParts,
  removePlanEntry,
  listStockCategories,
  stockCategoryLabel,
  addStockCategory,
  addHomeStockItem,
  removeHomeStockItem,
  updateHomeStockItem,
  updateDishName,
  updatePlanEntryDish,
  deleteDish,
  findDish,
  getRecipeForDish,
  upsertRecipeForDish,
  deleteRecipe,
} from "./lunch-planner.js";

const APP_DISPLAY_NAME = "מרכז הרעיונות של אילנית";

const UI_EMPTY = `<div class="empty"></div>`;

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

function formatPantryQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0";
  if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
  const s = x.toFixed(2).replace(/\.?0+$/, "");
  return s;
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

/** טקסט גיבוי מלא ל־PDF: כל הרעיונות + יומן יומי */
function fullAppToExportPlainText(state, dayJournal) {
  const parts = [];
  parts.push(`נוצר: ${new Date().toLocaleString("he-IL")}`);
  parts.push("");
  parts.push("————————————————");
  parts.push("רעיונות ומשימות");
  parts.push("————————————————");
  const ideas = state.ideas ?? [];
  if (ideas.length === 0) {
    parts.push("(אין רעיונות)");
  } else {
    for (const idea of ideas) {
      parts.push("");
      parts.push(ideaToExportText(idea));
    }
  }
  parts.push("");
  parts.push("————————————————");
  parts.push("יומן יומי (היום שלי)");
  parts.push("————————————————");
  const keys = Object.keys(dayJournal?.days ?? {})
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  if (keys.length === 0) {
    parts.push("(אין רשומות)");
  } else {
    for (const dk of keys) {
      const day = dayJournal.days[dk];
      parts.push("");
      parts.push(`תאריך ${dk}:`);
      const items = day?.items ?? [];
      if (!items.length) {
        parts.push("  (ריק)");
        continue;
      }
      for (const it of items) {
        const t = String(it.title ?? it.text ?? "").trim() || "ללא כותרת";
        if (it.kind === "place") {
          parts.push(`  📍 ${t}`);
          continue;
        }
        const mark = it.done ? "✓" : "☐";
        const pad = it.parentId ? "    " : "  ";
        parts.push(`${pad}${mark} ${t}`);
      }
    }
  }
  parts.push("");
  parts.push("————————————————");
  parts.push("תזמון (מדידות)");
  parts.push("————————————————");
  const tEntries = timingState.entries ?? [];
  if (tEntries.length === 0) {
    parts.push("(אין מדידות)");
  } else {
    for (const e of tEntries) {
      const st = new Date(e.startedAt).toLocaleString("he-IL");
      const en = new Date(e.endedAt).toLocaleString("he-IL");
      parts.push(
        `- ${e.title} | יום ${e.dateKey} | ${st} → ${en} | ${e.durationMinutes} דק׳`,
      );
    }
  }
  parts.push("");
  parts.push("————————————————");
  parts.push("מלאי בית (מזון)");
  parts.push("————————————————");
  const pitems = pantryState.items ?? [];
  if (pitems.length === 0) {
    parts.push("(אין פריטים)");
  } else {
    const byLoc = [...pitems].sort((a, b) => {
      const c = String(a.location).localeCompare(String(b.location), "he");
      if (c !== 0) return c;
      return a.name.localeCompare(b.name, "he");
    });
    for (const it of byLoc) {
      const loc = pantryLocationLabel(it.location);
      const q = formatPantryQty(it.quantity);
      const u = it.unit || "יח׳";
      const mark = it.quantity <= 0 ? "אזל" : "";
      parts.push(
        `- ${it.name} | ${loc} | ${q} ${u}${mark ? ` | ${mark}` : ""}`,
      );
    }
  }
  return parts.join("\n");
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

const SETTINGS_KEY = "idea-planner:settings:v1";
let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const x = raw ? JSON.parse(raw) : null;
    return {
      defaultCalMode: x?.defaultCalMode === "day" || x?.defaultCalMode === "month" ? x.defaultCalMode : "week",
      cloudAutoBackup: x?.cloudAutoBackup === true,
      pushServerUrl: typeof x?.pushServerUrl === "string" ? x.pushServerUrl : "",
    };
  } catch {
    return { defaultCalMode: "week", cloudAutoBackup: false, pushServerUrl: "" };
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

let cloudBackupUi = {
  status: "idle", // idle | working | ok | error
  message: "",
  lastOkAtIso: null,
};

function cloudTimeShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

function setCloudBackupHint(status, message, lastOkAtIso = cloudBackupUi.lastOkAtIso) {
  cloudBackupUi.status = status;
  cloudBackupUi.message = message || "";
  cloudBackupUi.lastOkAtIso = lastOkAtIso ?? null;
  const hint = document.getElementById("cloudBackupHint");
  if (hint) hint.textContent = cloudBackupUi.message;
}

const tryCloudAutoBackup = debounce(CLOUD_DEBOUNCE_MS, async () => {
  if (!settings.cloudAutoBackup) return;
  if (!isCloudBackupConfigured()) return;
  const inited = initCloudBackup();
  if (!inited.ok) return;
  const user = getCloudUser();
  if (!user) return;
  try {
    setCloudBackupHint("working", "מגבה אוטומטית…");
    await uploadCloudSnapshot(user.uid);
    const nowIso = new Date().toISOString();
    const timeStr = cloudTimeShort(nowIso);
    setCloudBackupHint("ok", `✓ גיבוי אוטומטי הועלה ב־${timeStr}`, nowIso);
    toast(`✓ גיבוי ענן אוטומטי הועלה (${timeStr})`, { durationMs: 3500 });
  } catch (e) {
    console.error(e);
    setCloudBackupHint("error", "⚠ גיבוי אוטומטי נכשל (בדקי חיבור / הרשאות).");
  }
});

function scheduleCloudBackupIfEnabled() {
  tryCloudAutoBackup();
}

const APP_MODE_KEY = "idea-planner:app-mode:v1";

const APP_MODES = [
  "ideas",
  "daily-today",
  "daily-future",
  "daily-history",
  "daily-master",
  "timing",
  "pantry",
  "hourly-schedule",
  "lunch-planner",
];

const APP_MODE_ALIASES = {
  "today-tasks": "daily-today",
};

function loadAppMode() {
  try {
    const v = localStorage.getItem(APP_MODE_KEY);
    if (APP_MODE_ALIASES[v]) return APP_MODE_ALIASES[v];
    if (APP_MODES.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return "daily-today";
}

const LAST_CALENDAR_DAY_KEY = "idea-planner:last-known-calendar-day:v1";

function loadPersistedCalendarDay() {
  try {
    const v = localStorage.getItem(LAST_CALENDAR_DAY_KEY);
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  } catch {
    /* ignore */
  }
  return null;
}

function persistLastKnownCalendarDay() {
  try {
    localStorage.setItem(LAST_CALENDAR_DAY_KEY, lastKnownCalendarDayKey);
  } catch {
    /* ignore */
  }
}

/**
 * אם מפתח idea-planner:last-known-calendar-day חסר (ניקוי חלקי, דפדפן, עדכון),
 * ברירת מחדל ל-localDateKey() גורמת לכך שלא ירוץ גלגול — והמשימות של אתמול נשארות על תאריך אתמול.
 * כאן מסיקים נקודת התחלה מהיומן: היום הקודם הישן ביותר שמופיע לפני היום — כדי לשרשר גלגול עד היום.
 */
function inferLastKnownCalendarDayFromJournal(journal, todayKey) {
  try {
    const keys = Object.keys(journal?.days ?? {})
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort();
    const strictlyBefore = keys.filter((k) => k < todayKey);
    if (strictlyBefore.length === 0) return todayKey;
    return strictlyBefore[0];
  } catch {
    return todayKey;
  }
}

let appMode = loadAppMode();
let dayJournal = loadDayJournal();

function persistDayJournal() {
  saveDayJournal(dayJournal);
  scheduleCloudBackupIfEnabled();
}

let timingState = loadTimingState();
let pantryState = loadPantry();
let hourlySchedule = loadHourlySchedule();
/** יום שמוצג בלו״ז */
let hourlyBrowseDateKey = localDateKey();

const scheduleHourlyPushSync = debounce(700, () => {
  if (notificationPermission() !== "granted") return;
  void syncHourlyRemindersToServer(settings, hourlySchedule).catch((e) => {
    console.warn("hourly push sync", e);
  });
});

function persistHourlySchedule() {
  saveHourlySchedule(hourlySchedule);
  scheduleCloudBackupIfEnabled();
  scheduleHourlyPushSync();
}

async function runEnableHourlyPushFromClick() {
  document.getElementById("settingsDialog")?.close?.();
  document.getElementById("topMenuDialog")?.close?.();
  const urlEl = document.getElementById("setPushServerUrl");
  if (urlEl) settings.pushServerUrl = String(urlEl.value ?? "").trim();
  saveSettings();
  try {
    const result = await enableHourlyPush(settings);
    try {
      await syncHourlyRemindersToServer(settings, hourlySchedule);
    } catch (syncErr) {
      if (!result?.localOnly) throw syncErr;
      console.warn("hourly push sync", syncErr);
    }
    const statusEl = document.getElementById("pushNotifyStatus");
    if (statusEl) statusEl.textContent = pushStatusText();
    toast("התראות אושרו. כשהאפליקציה פתוחה או ברקע תקבל תזכורת בלו״ז.");
    render();
  } catch (e) {
    console.error(e);
    const msg = String(e?.message || e);
    const statusEl = document.getElementById("pushNotifyStatus");
    if (statusEl) statusEl.textContent = pushStatusText();
    if (msg === "ios_homescreen") {
      toast("באייפון זה לא נפתח מספארי. שתף → הוספה למסך הבית, ואז לפתוח מהאייקון וללחוץ שוב.");
    } else if (msg === "denied") toast("ההרשאה נחסמה. אפשר לאשר בהגדרות הדפדפן/הטלפון.");
    else if (msg === "unsupported") toast("המכשיר לא תומך בהתראות Push (באייפון: הוסיפי למסך הבית).");
    else if (msg === "vapid_unavailable" || msg === "vapid_missing") {
      toast("עדיין אין חיבור לשרת התזכורות באתר. אחרי עדכון האתר נסי שוב «הפעלת התראות».");
    } else toast("הפעלת ההתראות נכשלה. בדקי חיבור ושרת התזכורות.");
    render();
  }
}

let lunchPlanner = loadLunchPlanner();
let lunchBrowseWeekStart = weekStartKeyFromDateKey(localDateKey());

const LUNCH_PLANNER_TAB_KEY = "idea-planner:lunch-tab:v1";
const LUNCH_PLANNER_TABS = ["week", "stock", "dishes", "recipes"];

function loadLunchPlannerTab() {
  try {
    const v = localStorage.getItem(LUNCH_PLANNER_TAB_KEY);
    if (LUNCH_PLANNER_TABS.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return "week";
}

let lunchPlannerTab = loadLunchPlannerTab();
/** רכיבים שטרם אוחדו למנה — לפי מפתח יום (תכנון שבוע) */
let lunchDayDraftParts = {};

const HOME_TAB_KEY = "idea-planner:home-tab:v1";
function loadHomeTab() {
  try {
    const v = localStorage.getItem(HOME_TAB_KEY);
    if (v === "pantry" || v === "lunch") return v;
  } catch {
    /* ignore */
  }
  return "lunch";
}
let homeTab = loadHomeTab();
if (appMode === "pantry") homeTab = "pantry";
else if (appMode === "lunch-planner") homeTab = "lunch";
function persistHomeTab() {
  try {
    localStorage.setItem(HOME_TAB_KEY, homeTab);
  } catch {
    /* ignore */
  }
}
function homeTabToMode(tab = homeTab) {
  return tab === "pantry" ? "pantry" : "lunch-planner";
}
function setHomeTab(tab) {
  homeTab = tab === "pantry" ? "pantry" : "lunch";
  persistHomeTab();
  setAppMode(homeTabToMode());
}

function persistLunchPlanner() {
  saveLunchPlanner(lunchPlanner);
  scheduleCloudBackupIfEnabled();
}
/** סינון מלאי: `all` או מזהה מיקום (fridge / pantry / freezer) */
let pantryLocFilter = "all";
/** סינון מצב מלאי: all | in_stock | out | low */
let pantryStockFilter = "all";
/** רק פריטים עם כמות שנותרה ≤ N (null = ללא הגבלה) */
let pantryMaxQtyCap = null;
/** חיפוש טקסט ברשימת המלאי המוצגת (אחרי סינון מיקום/⋮) */
let pantryListSearchQuery = "";
const PANTRY_LOW_THRESHOLD = 1;
const _calendarTodayInit = localDateKey();
let lastKnownCalendarDayKey =
  loadPersistedCalendarDay() ?? inferLastKnownCalendarDayFromJournal(dayJournal, _calendarTodayInit);
/** יום שמוצג במסך «היום שלי» (מחלקה / כפתורים) */
let dailyBrowseDateKey = localDateKey();

const DAILY_SWIPE_MIN_PX = 42;
const DAILY_SWIPE_MAX_MS = 900;

function rollIncompleteDailyTasksFromTo(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey >= toKey) return;
  const day = dayJournal.days[fromKey];
  if (!day?.items?.length) return;
  const items = day.items;
  const rollingIds = new Set();
  for (const x of items) {
    if (x.kind === "place") continue;
    if (!x.done) {
      rollingIds.add(x.id);
      if (x.parentId) {
        const p = items.find((y) => y.id === x.parentId);
        if (p?.kind === "place") rollingIds.add(p.id);
      }
    }
  }
  if (rollingIds.size === 0) return;

  const toRoll = [
    ...items.filter((x) => x.kind === "place" && rollingIds.has(x.id)),
    ...items.filter((x) => x.kind !== "place" && rollingIds.has(x.id)),
  ];

  const idMap = new Map();
  for (const it of toRoll) {
    const title = String(it.title ?? it.text ?? "").trim();
    if (!title) continue;
    idMap.set(it.id, uid("ditem"));
  }
  for (const it of toRoll) {
    const title = String(it.title ?? it.text ?? "").trim();
    if (!title || !idMap.has(it.id)) continue;
    const newId = idMap.get(it.id);
    let parentId;
    if (it.parentId && idMap.has(it.parentId)) parentId = idMap.get(it.parentId);
    const opts = {};
    if (it.kind === "place") {
      opts.kind = "place";
      if (it.collapsed === true) opts.collapsed = true;
    }
    if (parentId) opts.parentId = parentId;
    addDayItem(dayJournal, toKey, newId, title, opts);
  }
  const rolledOriginalIds = new Set(toRoll.map((x) => x.id));
  day.items = day.items.filter((x) => !rolledOriginalIds.has(x.id));
  if (day.items.length === 0) delete dayJournal.days[fromKey];
}

/** כשנכנס יום חדש בלוח: כל מה שלא סומן V ביום הקודם — מועתק ליום הבא (שרשרת אם היה פער) */
function maybeRollDailyJournalAtMidnight() {
  const today = localDateKey();
  if (today < lastKnownCalendarDayKey) {
    lastKnownCalendarDayKey = today;
    persistLastKnownCalendarDay();
    return;
  }
  if (today === lastKnownCalendarDayKey) {
    persistLastKnownCalendarDay();
    return;
  }

  let from = lastKnownCalendarDayKey;
  while (from < today) {
    const next = addDaysToDateKey(from, 1);
    rollIncompleteDailyTasksFromTo(from, next);
    from = next;
  }
  lastKnownCalendarDayKey = today;
  dailyBrowseDateKey = today;
  persistDayJournal();
  persistLastKnownCalendarDay();
}

function subtaskLocalDateKey(iso) {
  const d = isoToDate(iso);
  return d ? localDateKey(d) : null;
}

function sortSubtasksByStart(subs) {
  return [...subs].sort((a, b) => {
    const ta = isoToDate(a.startsAt)?.getTime() ?? 0;
    const tb = isoToDate(b.startsAt)?.getTime() ?? 0;
    return ta - tb;
  });
}

function subtaskTimeShort(iso) {
  const d = isoToDate(iso);
  if (!d) return "";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

/** תתי־משימות פתוחות לפי תאריך התחלה (מקומי), ועוד קבוצה בלי תאריך */
function collectOpenSubtasksByDate() {
  const todayK = localDateKey();
  /** @type {Map<string, Map<string, { ideaTitle: string, taskTitle: string, subs: any[] }>>} */
  const byDate = new Map();
  /** @type {Map<string, { ideaTitle: string, taskTitle: string, subs: any[] }>} */
  const noDate = new Map();

  for (const idea of state.ideas) {
    for (const task of idea.tasks ?? []) {
      for (const sub of task.subtasks ?? []) {
        if (sub.done) continue;
        const dk = subtaskLocalDateKey(sub.startsAt);
        const tkey = `${idea.id}::${task.id}`;
        const ideaTitle = idea.title || "ללא שם";
        const taskTitle = task.title || "ללא שם";
        if (!dk) {
          if (!noDate.has(tkey)) noDate.set(tkey, { ideaTitle, taskTitle, subs: [] });
          noDate.get(tkey).subs.push(sub);
          continue;
        }
        if (!byDate.has(dk)) byDate.set(dk, new Map());
        const tm = byDate.get(dk);
        if (!tm.has(tkey)) tm.set(tkey, { ideaTitle, taskTitle, subs: [] });
        tm.get(tkey).subs.push(sub);
      }
    }
  }

  const dateKeys = [...byDate.keys()].sort((a, b) => {
    const aOver = a < todayK;
    const bOver = b < todayK;
    if (aOver !== bOver) return aOver ? -1 : 1;
    return a.localeCompare(b);
  });

  const datedSections = dateKeys.map((dk) => ({
    dateKey: dk,
    tasks: [...byDate.get(dk).values()].map((x) => ({ ...x, subs: sortSubtasksByStart(x.subs) })),
  }));

  const noDateTasks = [...noDate.values()].map((x) => ({ ...x, subs: sortSubtasksByStart(x.subs) }));

  return { todayK, datedSections, noDateTasks };
}

/** תתי־משימות שבוצעו, לפי תאריך התחלה */
function collectDoneSubtasksByDate() {
  /** @type {Map<string, Map<string, { ideaTitle: string, taskTitle: string, subs: any[] }>>} */
  const byDate = new Map();
  /** @type {Map<string, { ideaTitle: string, taskTitle: string, subs: any[] }>} */
  const noDate = new Map();

  for (const idea of state.ideas) {
    for (const task of idea.tasks ?? []) {
      for (const sub of task.subtasks ?? []) {
        if (!sub.done) continue;
        const dk = subtaskLocalDateKey(sub.startsAt);
        const tkey = `${idea.id}::${task.id}`;
        const ideaTitle = idea.title || "ללא שם";
        const taskTitle = task.title || "ללא שם";
        if (!dk) {
          if (!noDate.has(tkey)) noDate.set(tkey, { ideaTitle, taskTitle, subs: [] });
          noDate.get(tkey).subs.push(sub);
          continue;
        }
        if (!byDate.has(dk)) byDate.set(dk, new Map());
        const tm = byDate.get(dk);
        if (!tm.has(tkey)) tm.set(tkey, { ideaTitle, taskTitle, subs: [] });
        tm.get(tkey).subs.push(sub);
      }
    }
  }

  const dateKeys = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  const datedSections = dateKeys.map((dk) => ({
    dateKey: dk,
    tasks: [...byDate.get(dk).values()].map((x) => ({ ...x, subs: sortSubtasksByStart(x.subs) })),
  }));
  const noDateTasks = [...noDate.values()].map((x) => ({ ...x, subs: sortSubtasksByStart(x.subs) }));

  return { datedSections, noDateTasks };
}

function renderSubtaskCheckboxRow(sub) {
  const time = subtaskTimeShort(sub.startsAt);
  const timeHtml = time ? `<span class="plan-sub-time">${escapeHtml(time)}</span>` : "";
  return `
    <label class="plan-sub-row">
      <input class="check" type="checkbox" ${sub.done ? "checked" : ""} data-action="toggle-subtask-from-calendar" data-subtask-id="${escapeHtml(sub.id)}" aria-label="ביצוע תת־משימה" />
      <span class="plan-sub-text">${escapeHtml(sub.title || "ללא שם")}</span>
      ${timeHtml}
    </label>
  `;
}

function renderAggregatedPlanSections(container, mode) {
  if (!container) return 0;
  container.innerHTML = "";

  if (mode === "future") {
    const { datedSections, noDateTasks, todayK: tk } = collectOpenSubtasksByDate();
    let totalOpen = 0;
    for (const sec of datedSections) for (const t of sec.tasks) totalOpen += t.subs.length;
    for (const t of noDateTasks) totalOpen += t.subs.length;

    if (datedSections.length === 0 && noDateTasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty plan-empty";
      empty.innerHTML = UI_EMPTY;
      container.appendChild(empty);
      return totalOpen;
    }

    for (const sec of datedSections) {
      const wrap = document.createElement("section");
      wrap.className = "plan-date-block";
      const late = sec.dateKey < tk;
      wrap.innerHTML = `
        <div class="plan-date-heading">
          <span class="plan-date-title">${escapeHtml(formatHebrewDateLabel(sec.dateKey))}</span>
          ${late ? `<span class="plan-badge-late">באיחור</span>` : ""}
        </div>
        <div class="plan-date-body"></div>
      `;
      const body = wrap.querySelector(".plan-date-body");
      for (const task of sec.tasks) {
        const blk = document.createElement("div");
        blk.className = "plan-task-block";
        blk.innerHTML = `
          <div class="plan-task-head">
            <span class="plan-task-name">${escapeHtml(task.taskTitle)}</span>
            <span class="plan-idea-pill">${escapeHtml(task.ideaTitle)}</span>
          </div>
          <div class="plan-subs">${task.subs.map((s) => renderSubtaskCheckboxRow(s)).join("")}</div>
        `;
        body.appendChild(blk);
      }
      container.appendChild(wrap);
    }

    if (noDateTasks.length > 0) {
      const wrap = document.createElement("section");
      wrap.className = "plan-date-block plan-date-block--nodate";
      wrap.innerHTML = `<div class="plan-date-heading"><span class="plan-date-title">בלי תאריך התחלה</span></div><div class="plan-date-body"></div>`;
      const body = wrap.querySelector(".plan-date-body");
      for (const task of noDateTasks) {
        const blk = document.createElement("div");
        blk.className = "plan-task-block";
        blk.innerHTML = `
          <div class="plan-task-head">
            <span class="plan-task-name">${escapeHtml(task.taskTitle)}</span>
            <span class="plan-idea-pill">${escapeHtml(task.ideaTitle)}</span>
          </div>
          <div class="plan-subs">${task.subs.map((s) => renderSubtaskCheckboxRow(s)).join("")}</div>
        `;
        body.appendChild(blk);
      }
      container.appendChild(wrap);
    }
    return totalOpen;
  }

  const { datedSections, noDateTasks } = collectDoneSubtasksByDate();
  let totalDone = 0;
  for (const sec of datedSections) for (const t of sec.tasks) totalDone += t.subs.length;
  for (const t of noDateTasks) totalDone += t.subs.length;

  if (datedSections.length === 0 && noDateTasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty plan-empty";
    empty.innerHTML = UI_EMPTY;
    container.appendChild(empty);
    return totalDone;
  }

  for (const sec of datedSections) {
    const wrap = document.createElement("section");
    wrap.className = "plan-date-block";
    wrap.innerHTML = `
      <div class="plan-date-heading">
        <span class="plan-date-title">${escapeHtml(formatHebrewDateLabel(sec.dateKey))}</span>
      </div>
      <div class="plan-date-body"></div>
    `;
    const body = wrap.querySelector(".plan-date-body");
    for (const task of sec.tasks) {
      const blk = document.createElement("div");
      blk.className = "plan-task-block";
      blk.innerHTML = `
        <div class="plan-task-head">
          <span class="plan-task-name">${escapeHtml(task.taskTitle)}</span>
          <span class="plan-idea-pill">${escapeHtml(task.ideaTitle)}</span>
        </div>
        <div class="plan-subs">${task.subs.map((s) => renderSubtaskCheckboxRow(s)).join("")}</div>
      `;
      body.appendChild(blk);
    }
    container.appendChild(wrap);
  }

  if (noDateTasks.length > 0) {
    const wrap = document.createElement("section");
    wrap.className = "plan-date-block plan-date-block--nodate";
    wrap.innerHTML = `<div class="plan-date-heading"><span class="plan-date-title">בוצע בלי תאריך התחלה</span></div><div class="plan-date-body"></div>`;
    const body = wrap.querySelector(".plan-date-body");
    for (const task of noDateTasks) {
      const blk = document.createElement("div");
      blk.className = "plan-task-block";
      blk.innerHTML = `
        <div class="plan-task-head">
          <span class="plan-task-name">${escapeHtml(task.taskTitle)}</span>
          <span class="plan-idea-pill">${escapeHtml(task.ideaTitle)}</span>
        </div>
        <div class="plan-subs">${task.subs.map((s) => renderSubtaskCheckboxRow(s)).join("")}</div>
      `;
      body.appendChild(blk);
    }
    container.appendChild(wrap);
  }

  return totalDone;
}

function formatHebrewDateShort(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("he-IL", { weekday: "short", day: "numeric", month: "short" });
}

function formatHebrewDateLabel(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("he-IL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function screenTitleForMode(mode) {
  switch (mode) {
    case "daily-today":
      return "היום";
    case "hourly-schedule":
      return "לו״ז";
    case "lunch-planner":
    case "pantry":
      return "בית";
    case "ideas":
      return "רעיונות";
    case "daily-master":
      return "כל הימים";
    case "timing":
      return "מדידות זמן";
    case "daily-future":
      return "בהמשך";
    case "daily-history":
      return "שבוצע";
    default:
      return "היום";
  }
}

function syncHeaderScreenTitle() {
  const el = document.getElementById("appScreenTitle");
  if (el) el.textContent = screenTitleForMode(appMode);
}

function syncHomeTabsBar() {
  const bar = document.getElementById("homeTabsBar");
  const onHome = appMode === "lunch-planner" || appMode === "pantry";
  bar?.classList.toggle("hidden", !onHome);
  const lunchBtn = document.getElementById("homeTabLunch");
  const pantryBtn = document.getElementById("homeTabPantry");
  const lunchOn = appMode === "lunch-planner";
  lunchBtn?.classList.toggle("active", lunchOn);
  pantryBtn?.classList.toggle("active", !lunchOn && appMode === "pantry");
  lunchBtn?.setAttribute("aria-selected", lunchOn ? "true" : "false");
  pantryBtn?.setAttribute("aria-selected", !lunchOn && appMode === "pantry" ? "true" : "false");
}

function setAppMode(mode) {
  if (APP_MODE_ALIASES[mode]) mode = APP_MODE_ALIASES[mode];
  if (mode === "lunch-planner") homeTab = "lunch";
  if (mode === "pantry") homeTab = "pantry";
  if (mode === "lunch-planner" || mode === "pantry") persistHomeTab();
  appMode = mode;
  try {
    localStorage.setItem(APP_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
  document.body.classList.toggle("app-mode-ideas", mode === "ideas");
  document.body.classList.toggle("app-mode-home", mode === "lunch-planner" || mode === "pantry");
  if (mode === "ideas" && isMobile()) mobile.screen = "ideas";
  syncAppNavActive();
  syncHeaderScreenTitle();
  syncHomeTabsBar();
  window.scrollTo({ top: 0, behavior: "smooth" });
  render();
}

function syncAppNavActive() {
  const pairs = [
    ["daily-today", "bnDailyToday"],
    ["hourly-schedule", "bnHourlySchedule"],
    ["ideas", "bnIdeas"],
    ["daily-future", "topNavFuture"],
    ["daily-history", "topNavHistory"],
    ["daily-master", "topNavDailyMaster"],
    ["timing", "topNavTiming"],
  ];
  for (const [m, id] of pairs) {
    document.getElementById(id)?.classList.toggle("active", appMode === m);
  }
  const homeOn = appMode === "lunch-planner" || appMode === "pantry";
  document.getElementById("bnHome")?.classList.toggle("active", homeOn);
}

function updateAppViewsVisibility() {
  document.getElementById("viewIdeas")?.classList.toggle("hidden", appMode !== "ideas");
  document.getElementById("viewDailyToday")?.classList.toggle("hidden", appMode !== "daily-today");
  document.getElementById("viewDailyFuture")?.classList.toggle("hidden", appMode !== "daily-future");
  document.getElementById("viewDailyHistory")?.classList.toggle("hidden", appMode !== "daily-history");
  document.getElementById("viewDailyMaster")?.classList.toggle("hidden", appMode !== "daily-master");
  document.getElementById("viewDailyTiming")?.classList.toggle("hidden", appMode !== "timing");
  document.getElementById("viewPantry")?.classList.toggle("hidden", appMode !== "pantry");
  document.getElementById("viewHourlySchedule")?.classList.toggle("hidden", appMode !== "hourly-schedule");
  document.getElementById("viewLunchPlanner")?.classList.toggle("hidden", appMode !== "lunch-planner");
  syncHeaderScreenTitle();
  syncHomeTabsBar();
}

function dayItemLabel(it) {
  return String(it?.title ?? it?.text ?? "").trim();
}

function openDailyEditDialog(dateKey, itemId) {
  const day = dayJournal.days[dateKey];
  const it = day?.items?.find((x) => x.id === itemId);
  if (!it) return;
  const dlg = document.getElementById("dailyEditDialog");
  const input = document.getElementById("dailyEditInput");
  if (!dlg || !input) return;
  input.value = dayItemLabel(it);
  dlg.dataset.editDateKey = dateKey;
  dlg.dataset.editItemId = itemId;
  dlg.showModal();
  queueMicrotask(() => input.focus());
}

function findDayJournalItem(dateKey, itemId) {
  const day = dayJournal.days[dateKey];
  return day?.items?.find((x) => x.id === itemId) ?? null;
}

function dayItemsRenderModel(items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const idx = new Map(items.map((it, i) => [it.id, i]));
  const isRoot = (it) => !it.parentId || !byId.has(it.parentId);
  const roots = items.filter(isRoot);
  const childMap = new Map();
  for (const it of items) {
    if (!it.parentId || !byId.has(it.parentId)) continue;
    if (!childMap.has(it.parentId)) childMap.set(it.parentId, []);
    childMap.get(it.parentId).push(it);
  }
  for (const arr of childMap.values()) {
    arr.sort((a, b) => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0));
  }
  return { roots, childMap };
}

function createDailyPlaceRow(dateKey, it) {
  const label = escapeHtml(dayItemLabel(it));
  const collapsed = !!it.collapsed;
  const row = document.createElement("div");
  row.className = "daily-item daily-item--place";
  row.innerHTML = `
    <div class="daily-place-head">
      <button type="button" class="daily-place-collapse" data-action="daily-place-collapse" data-date-key="${escapeHtml(String(dateKey))}" data-item-id="${escapeHtml(String(it.id))}" aria-expanded="${collapsed ? "false" : "true"}" title="${collapsed ? "הרחבה" : "כיווץ"}">${collapsed ? "▸" : "▾"}</button>
      <span class="daily-place-pin" aria-hidden="true">📍</span>
      <span class="daily-item-text daily-place-title">${label}</span>
    </div>
    <div class="daily-item-actions">
      <details class="daily-kebab">
        <summary class="daily-kebab-summary" aria-label="פעולות לכותרת מקום">⋮</summary>
        <div class="daily-kebab-menu" role="menu">
          <button type="button" class="daily-kebab-item" role="menuitem" data-action="daily-edit" data-date-key="${escapeHtml(String(dateKey))}" data-item-id="${escapeHtml(String(it.id))}">עריכה</button>
          <button type="button" class="daily-kebab-item daily-kebab-item--danger" role="menuitem" data-action="daily-delete" data-date-key="${escapeHtml(String(dateKey))}" data-item-id="${escapeHtml(String(it.id))}">מחיקה (גם מה שמתחת)</button>
        </div>
      </details>
    </div>
  `;
  return row;
}

function createDailyTaskRow(dateKey, it, { indent }) {
  const label = escapeHtml(dayItemLabel(it));
  const row = document.createElement("div");
  row.className = `daily-item ${it.done ? "done" : ""}${indent ? " daily-item--child" : ""}`;
  row.innerHTML = `
    <label class="daily-check">
      <input type="checkbox" ${it.done ? "checked" : ""} data-action="daily-toggle" data-date-key="${escapeHtml(String(dateKey))}" data-item-id="${escapeHtml(String(it.id))}" />
      <span class="daily-item-text">${label}</span>
    </label>
    <div class="daily-item-actions">
      <details class="daily-kebab">
        <summary class="daily-kebab-summary" aria-label="פעולות למשימה">⋮</summary>
        <div class="daily-kebab-menu" role="menu">
          <button type="button" class="daily-kebab-item" role="menuitem" data-action="daily-edit" data-date-key="${escapeHtml(String(dateKey))}" data-item-id="${escapeHtml(String(it.id))}">עריכה</button>
          <button type="button" class="daily-kebab-item" role="menuitem" data-action="daily-timer" data-date-key="${escapeHtml(String(dateKey))}" data-item-id="${escapeHtml(String(it.id))}">טיימר</button>
          <button type="button" class="daily-kebab-item daily-kebab-item--danger" role="menuitem" data-action="daily-delete" data-date-key="${escapeHtml(String(dateKey))}" data-item-id="${escapeHtml(String(it.id))}">מחיקה</button>
        </div>
      </details>
    </div>
  `;
  return row;
}

function renderDayItemsList(container, dateKey, { hideDone = false } = {}) {
  if (!container) return;
  container.innerHTML = "";
  const day = dayJournal.days[dateKey];
  const items = day?.items ?? [];

  // כאשר מסתירים done, בודקים שיש לפחות משהו להציג
  const visibleItems = hideDone ? items.filter((x) => !x.done) : items;
  if (visibleItems.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = UI_EMPTY;
    container.appendChild(div);
    return;
  }

  const { roots, childMap } = dayItemsRenderModel(hideDone ? visibleItems : items);
  for (const it of roots) {
    if (hideDone && it.done) continue;
    if (it.kind === "place") {
      // בדיקה: האם יש ילדים שאינם done תחת מקום זה
      const children = childMap.get(it.id) ?? [];
      const visibleChildren = hideDone ? children.filter((ch) => !ch.done) : children;
      if (hideDone && visibleChildren.length === 0) continue;
      container.appendChild(createDailyPlaceRow(dateKey, it));
      const hideChildren = !!it.collapsed;
      for (const ch of visibleChildren) {
        const childRow = createDailyTaskRow(dateKey, ch, { indent: true });
        if (hideChildren) childRow.classList.add("hidden");
        container.appendChild(childRow);
      }
    } else {
      container.appendChild(createDailyTaskRow(dateKey, it, { indent: false }));
    }
  }
}

function shiftDailyBrowse(deltaDays) {
  dailyBrowseDateKey = addDaysToDateKey(dailyBrowseDateKey, deltaDays);
  const swipeArea = document.getElementById("dailyTodaySwipeArea");
  if (swipeArea) {
    swipeArea.classList.remove("daily-changed");
    // reflow to restart animation
    void swipeArea.offsetWidth;
    swipeArea.classList.add("daily-changed");
    clearTimeout(shiftDailyBrowse._t);
    shiftDailyBrowse._t = setTimeout(() => swipeArea.classList.remove("daily-changed"), 320);
  }
  try {
    toast(formatHebrewDateLabel(dailyBrowseDateKey));
  } catch {
    /* ignore */
  }
  render();
}

function syncDailyTodayFormPlaceSelect(dateKey) {
  const kindEl = document.getElementById("dailyTodayKind");
  const underEl = document.getElementById("dailyTodayUnderPlace");
  const inputEl = document.getElementById("dailyTodayInput");
  if (!kindEl || !underEl) return;
  const isPlace = kindEl.value === "place";
  if (inputEl) {
    inputEl.placeholder = isPlace
      ? "שם המקום (למשל מכבי פארם)…"
      : "משימה או מה לקנות…";
  }
  const placeBtn = document.getElementById("dailyTodayAddPlaceBtn");
  if (placeBtn) placeBtn.textContent = isPlace ? "ביטול — חזרה למשימה" : "+ כותרת מקום";
  if (isPlace) {
    underEl.classList.add("hidden");
    return;
  }
  const day = dayJournal.days[dateKey];
  const places = (day?.items ?? []).filter((x) => x.kind === "place");
  underEl.classList.toggle("hidden", places.length === 0);
  const prev = underEl.value;
  underEl.innerHTML =
    `<option value="">— ברשימה הראשית (לא תחת חנות) —</option>` +
    places
      .map(
        (p) =>
          `<option value="${escapeHtml(String(p.id))}">${escapeHtml(String(p.title ?? ""))}</option>`,
      )
      .join("");
  const form = document.getElementById("dailyTodayForm");
  const pending = form?.dataset?.selectPlaceAfterRender;
  if (pending && [...underEl.options].some((o) => o.value === pending)) {
    underEl.value = pending;
    delete form.dataset.selectPlaceAfterRender;
  } else if (prev && [...underEl.options].some((o) => o.value === prev)) {
    underEl.value = prev;
  }
}

function renderDailyTodayPage() {
  const calendarToday = localDateKey();
  const viewKey = dailyBrowseDateKey;
  const titleEl = document.getElementById("dailyTodayTitle");
  const progEl = document.getElementById("dailyTodayProgress");
  const jumpBtn = document.getElementById("dailyJumpToday");

  if (titleEl) titleEl.textContent = formatHebrewDateShort(viewKey);
  if (jumpBtn) {
    const showJump = viewKey !== calendarToday;
    jumpBtn.classList.toggle("hidden", !showJump);
  }

  // צבע עדין משתנה לפי תאריך (כדי להרגיש שהיום התחלף)
  const swipeArea = document.getElementById("dailyTodaySwipeArea");
  if (swipeArea) {
    let h = 0;
    for (let i = 0; i < viewKey.length; i++) h = (h * 31 + viewKey.charCodeAt(i)) % 360;
    const accent = `hsla(${h}, 92%, 58%, 0.14)`;
    swipeArea.style.setProperty("--daily-accent", accent);
  }

  renderDayItemsList(document.getElementById("dailyTodayList"), viewKey, { hideDone: true });
  const pr = dayProgress(dayJournal, viewKey);
  if (progEl) {
    if (!pr.total) {
      progEl.textContent =
        viewKey === calendarToday ? "אין עדיין משימות — אפשר להוסיף למעלה." : "אין משימות ביום הזה.";
    } else {
      progEl.textContent = `${pr.done}/${pr.total} הושלמו`;
    }
  }
  syncDailyTodayFormPlaceSelect(viewKey);

  const nextEl = document.getElementById("dailyTodayNextHourly");
  if (nextEl) {
    if (viewKey !== calendarToday) {
      nextEl.classList.add("hidden");
      nextEl.textContent = "";
    } else {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const upcoming = blocksForDay(hourlySchedule, calendarToday)
        .filter((b) => !b.done && blockHasTime(b) && b.startMin >= nowMin)[0];
      if (!upcoming) {
        nextEl.classList.add("hidden");
        nextEl.textContent = "";
      } else {
        nextEl.classList.remove("hidden");
        nextEl.textContent = `הבא בלו״ז: ${upcoming.title} · ${minutesToTimeString(upcoming.startMin)}`;
      }
    }
  }

  const ideasBlock = document.getElementById("dailyTodayIdeasBlock");
  if (viewKey !== calendarToday) {
    ideasBlock?.classList.add("hidden");
  } else {
    renderTodayIdeasOnDailyPage();
  }
}

function shiftHourlyBrowse(deltaDays) {
  hourlyBrowseDateKey = addDaysToDateKey(hourlyBrowseDateKey, deltaDays);
  render();
}

function setHourlyBrowseDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
  hourlyBrowseDateKey = dateKey;
  render();
}

const HOURLY_MINUTE_STEPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fillHourlyMinuteSelect(sel, extraMin) {
  if (!(sel instanceof HTMLSelectElement)) return;
  const extra = Number.isFinite(extraMin) ? extraMin : null;
  const mins = [...HOURLY_MINUTE_STEPS];
  if (extra != null && extra >= 0 && extra <= 59 && !mins.includes(extra)) {
    mins.push(extra);
    mins.sort((a, b) => a - b);
  }
  const prev = sel.value;
  sel.innerHTML = mins.map((m) => `<option value="${m}">${pad2(m)}</option>`).join("");
  if (extra != null) sel.value = String(extra);
  else if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function fillHourlyHourSelect(sel) {
  if (!(sel instanceof HTMLSelectElement) || sel.options.length === 24) return;
  sel.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${pad2(h)}</option>`).join("");
}

function initHourlyTimeSelects() {
  for (const id of ["hourlyScheduleStartH", "hourlyScheduleEditStartH"]) {
    fillHourlyHourSelect(document.getElementById(id));
  }
  for (const id of ["hourlyScheduleStartM", "hourlyScheduleEditStartM"]) {
    fillHourlyMinuteSelect(document.getElementById(id));
  }
  setHourlyHmPair("hourlyScheduleStart", nearbyHourlyDefaultStart());
}

function nearbyHourlyDefaultStart() {
  const now = new Date();
  const raw = now.getHours() * 60 + now.getMinutes();
  const step = 5;
  let start = Math.round(raw / step) * step;
  return Math.max(0, Math.min(23 * 60, start));
}

function syncHourlyTimeRow(checkId, rowId, pairPrefix, startMin) {
  const on = !!document.getElementById(checkId)?.checked;
  document.getElementById(rowId)?.classList.toggle("hidden", !on);
  if (on) setHourlyHmPair(pairPrefix, Number.isFinite(startMin) ? startMin : nearbyHourlyDefaultStart());
}

function setHourlyHmPair(prefix, totalMin) {
  const t = Number(totalMin);
  if (!Number.isFinite(t)) return;
  const h = Math.max(0, Math.min(23, Math.floor(t / 60)));
  const m = Math.max(0, Math.min(59, t % 60));
  const hEl = document.getElementById(`${prefix}H`);
  const mEl = document.getElementById(`${prefix}M`);
  fillHourlyHourSelect(hEl);
  fillHourlyMinuteSelect(mEl, m);
  if (hEl instanceof HTMLSelectElement) hEl.value = String(h);
  if (mEl instanceof HTMLSelectElement) mEl.value = String(m);
}

function getHourlyHmPair(prefix) {
  const h = Number(document.getElementById(`${prefix}H`)?.value);
  const m = Number(document.getElementById(`${prefix}M`)?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function openHourlyScheduleEditDialog(dateKey, blockId) {
  const blk = hourlySchedule.days[dateKey]?.blocks?.find((x) => x.id === blockId);
  if (!blk) return;
  const dlg = document.getElementById("hourlyScheduleEditDialog");
  if (!(dlg instanceof HTMLDialogElement)) return;
  document.getElementById("hourlyScheduleEditTitle").value = blk.title;
  const hasTime = blockHasTime(blk);
  const hasEl = document.getElementById("hourlyEditHasTime");
  if (hasEl instanceof HTMLInputElement) hasEl.checked = hasTime;
  syncHourlyTimeRow("hourlyEditHasTime", "hourlyEditTimeRow", "hourlyScheduleEditStart", hasTime ? blk.startMin : nearbyHourlyDefaultStart());
  document.getElementById("hourlyScheduleEditDone").checked = !!blk.done;
  dlg.dataset.editDateKey = dateKey;
  dlg.dataset.editBlockId = blockId;
  dlg.showModal();
  queueMicrotask(() => document.getElementById("hourlyScheduleEditTitle")?.focus());
}

function hourlyTaskCardHtml(viewKey, blk) {
  const timed = blockHasTime(blk);
  const timeBadge = timed
    ? `<span class="hourly-task-time">${escapeHtml(minutesToTimeString(blk.startMin))}</span>`
    : "";
  const subs = Array.isArray(blk.subs) ? blk.subs : [];
  const subRows = subs
    .map(
      (s) => `
        <div class="hourly-sub ${s.done ? "done" : ""}">
          <label class="daily-check">
            <input type="checkbox" ${s.done ? "checked" : ""} data-action="hourly-toggle-sub" data-date-key="${escapeHtml(viewKey)}" data-block-id="${escapeHtml(blk.id)}" data-sub-id="${escapeHtml(s.id)}" />
            <span class="daily-item-text">${escapeHtml(s.title)}</span>
          </label>
          <button type="button" class="hourly-sub-del" data-action="hourly-delete-sub" data-date-key="${escapeHtml(viewKey)}" data-block-id="${escapeHtml(blk.id)}" data-sub-id="${escapeHtml(s.id)}" aria-label="מחיקת תת־משימה">×</button>
        </div>`,
    )
    .join("");
  return `
    <article class="hourly-task ${blk.done ? "done" : ""}">
      <div class="hourly-task-head">
        <label class="daily-check">
          <input type="checkbox" ${blk.done ? "checked" : ""} data-action="hourly-toggle-done" data-date-key="${escapeHtml(viewKey)}" data-block-id="${escapeHtml(blk.id)}" />
          <span class="daily-item-text">${escapeHtml(blk.title)}</span>
        </label>
        ${timeBadge}
        <div class="daily-item-actions">
          <details class="daily-kebab">
            <summary class="daily-kebab-summary" aria-label="פעולות למשימה">⋮</summary>
            <div class="daily-kebab-menu" role="menu">
              <button type="button" class="daily-kebab-item" role="menuitem" data-action="hourly-edit-block" data-date-key="${escapeHtml(viewKey)}" data-block-id="${escapeHtml(blk.id)}">עריכה</button>
              <button type="button" class="daily-kebab-item daily-kebab-item--danger" role="menuitem" data-action="hourly-delete-block" data-date-key="${escapeHtml(viewKey)}" data-block-id="${escapeHtml(blk.id)}">מחיקה</button>
            </div>
          </details>
        </div>
      </div>
      <div class="hourly-subs">${subRows}</div>
      <form class="hourly-sub-add" data-action="hourly-add-sub" data-date-key="${escapeHtml(viewKey)}" data-block-id="${escapeHtml(blk.id)}" autocomplete="off">
        <input class="input hourly-sub-input" type="text" maxlength="200" placeholder="תת־משימה (מסמך, שעה למייבש…)" />
        <button class="btn btn-ghost" type="submit">+</button>
      </form>
    </article>`;
}

function renderHourlySchedulePage() {
  const calendarToday = localDateKey();
  const viewKey = hourlyBrowseDateKey;
  const titleEl = document.getElementById("hourlyScheduleDateTitle");
  const dateInp = document.getElementById("hourlyScheduleDateInput");
  const jumpBtn = document.getElementById("hourlyScheduleJumpToday");
  const listEl = document.getElementById("hourlyScheduleList");
  const progEl = document.getElementById("hourlyScheduleProgress");

  if (titleEl) titleEl.textContent = formatHebrewDateShort(viewKey);
  if (dateInp instanceof HTMLInputElement && dateInp.value !== viewKey) dateInp.value = viewKey;
  if (jumpBtn) jumpBtn.classList.toggle("hidden", viewKey === calendarToday);
  if (!listEl) return;

  const blocks = blocksForDay(hourlySchedule, viewKey);
  const timed = blocks.filter((b) => blockHasTime(b));
  const untimed = blocks.filter((b) => !blockHasTime(b));

  const parts = [];
  if (timed.length) {
    parts.push(`<h3 class="hourly-section-title">עם שעה</h3>`);
    parts.push(...timed.map((b) => hourlyTaskCardHtml(viewKey, b)));
  }
  if (untimed.length) {
    parts.push(`<h3 class="hourly-section-title">בלי שעה · תזכורת ב־10:00</h3>`);
    parts.push(...untimed.map((b) => hourlyTaskCardHtml(viewKey, b)));
  }
  if (!blocks.length) {
    listEl.innerHTML = `<div class="empty">רשימה ליום — כמו במחברת. אפשר בלי שעה, ואפשר תתי־משימות.</div>`;
  } else {
    listEl.innerHTML = parts.join("");
  }

  const pr = scheduleDayProgress(hourlySchedule, viewKey);
  if (progEl) {
    if (!pr.total) progEl.textContent = "הוסיפי למעלה מה יש לעשות.";
    else progEl.textContent = `${pr.done}/${pr.total} משימות בלו״ז`;
    if (notificationPermission() === "granted") {
      progEl.textContent += " · התראות פעילות";
    }
  }

  const banner = document.getElementById("hourlyPushBanner");
  if (banner) {
    const granted = notificationPermission() === "granted";
    banner.classList.toggle("hidden", granted);
    const hint = document.getElementById("hourlyPushBannerHint");
    if (hint) {
      hint.textContent = iosNeedsHomeScreenForPush()
        ? "באייפון: קודם שתף → הוספה למסך הבית, ואז לפתוח מהאייקון. אחר כך לחצי כאן לאישור."
        : "כדי לקבל תזכורת שקופצת מלמעלה — לחצי לאישור במכשיר.";
    }
  }
}

function dateKeyToLocalDate(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function setLunchPlannerTab(tab) {
  if (!LUNCH_PLANNER_TABS.includes(tab)) tab = "week";
  lunchPlannerTab = tab;
  try {
    localStorage.setItem(LUNCH_PLANNER_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
  document.querySelectorAll(".lunch-tab").forEach((el) => {
    const t = el.getAttribute("data-lunch-tab");
    const on = t === tab;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  });
  for (const id of ["Week", "Stock", "Dishes", "Recipes"]) {
    const key = id.toLowerCase();
    document.getElementById(`lunchPanel${id}`)?.classList.toggle("hidden", lunchPlannerTab !== key);
  }
}

function openLunchRecipeDialog(dishId) {
  const dish = findDish(lunchPlanner, dishId);
  if (!dish) return;
  const dlg = document.getElementById("lunchRecipeDialog");
  if (!(dlg instanceof HTMLDialogElement)) return;
  const rec = getRecipeForDish(lunchPlanner, dishId);
  document.getElementById("lunchRecipeDishLine").textContent = `מנה: ${dish.name}`;
  document.getElementById("lunchRecipeTitle").value = rec?.title ?? dish.name;
  document.getElementById("lunchRecipeBody").value = rec?.body ?? "";
  dlg.dataset.dishId = dishId;
  document.getElementById("lunchRecipeDelete")?.classList.toggle("hidden", !rec);
  dlg.showModal();
  queueMicrotask(() => document.getElementById("lunchRecipeBody")?.focus());
}

function openLunchTextEditDialog(opts) {
  const dlg = document.getElementById("lunchTextEditDialog");
  const input = document.getElementById("lunchTextEditInput");
  const heading = document.getElementById("lunchTextEditHeading");
  if (!(dlg instanceof HTMLDialogElement) || !(input instanceof HTMLTextAreaElement)) return;
  heading.textContent = opts.heading ?? "עריכה";
  input.value = opts.value ?? "";
  dlg.dataset.editKind = opts.kind;
  dlg.dataset.stockCat = opts.stockCat ?? "";
  dlg.dataset.stockItemId = opts.stockItemId ?? "";
  dlg.dataset.dishId = opts.dishId ?? "";
  dlg.dataset.planDateKey = opts.planDateKey ?? "";
  dlg.dataset.planEntryId = opts.planEntryId ?? "";
  dlg.showModal();
  queueMicrotask(() => input.focus());
}

function saveLunchTextEditDialog() {
  const dlg = document.getElementById("lunchTextEditDialog");
  if (!(dlg instanceof HTMLDialogElement)) return;
  const kind = dlg.dataset.editKind;
  const raw = document.getElementById("lunchTextEditInput")?.value ?? "";
  const val = raw.trim();
  if (!val) {
    toast("נא להזין טקסט.");
    return;
  }
  if (kind === "stock") {
    const line = val.split(/\n/)[0]?.trim() ?? val;
    const ok = updateHomeStockItem(lunchPlanner, dlg.dataset.stockCat, dlg.dataset.stockItemId, line);
    if (!ok) {
      toast("לא נשמר — אולי השם ריק או כבר קיים.");
      return;
    }
    persistLunchPlanner();
    dlg.close();
    toast("עודכן.");
    render();
    return;
  }
  if (kind === "dish") {
    const dish = findDish(lunchPlanner, dlg.dataset.dishId);
    if (!dish) return;
    const parts = normalizePartList(val.split(/\n/));
    applyPartsToDish(dish, parts);
    persistLunchPlanner();
    dlg.close();
    toast("הארוחה עודכנה.");
    render();
    return;
  }
  if (kind === "plan") {
    const dateKey = dlg.dataset.planDateKey;
    const entryId = dlg.dataset.planEntryId;
    const parts = normalizePartList(val.split(/\n/));
    const updated = updatePlanEntryFromParts(
      lunchPlanner,
      lunchBrowseWeekStart,
      dateKey,
      entryId,
      parts,
    );
    if (!updated?.entry || !dateKey || !entryId) return;
    const dup = findMealPlannedElsewhereInWeek(lunchPlanner, lunchBrowseWeekStart, parts, dateKey);
    if (dup) {
      const ok = confirm(
        `ארוחה דומה כבר מתוכננת ל־${formatHebrewDateLabel(dup)}.\n\nלשמור בכל זאת?`,
      );
      if (!ok) return;
    }
    persistLunchPlanner();
    dlg.close();
    toast("הארוחה ביום עודכנה.");
    render();
  }
}

function renderLunchMealItemHtml(ent, dateKey) {
  const parts = planEntryMealParts(lunchPlanner, ent);
  const dish = ent.dishId ? findDish(lunchPlanner, ent.dishId) : null;
  const hasRec = dish ? !!getRecipeForDish(lunchPlanner, dish.id) : false;
  const dishId = dish?.id ?? "";
  const recipeBtn = dishId
    ? `<button type="button" class="btn btn-ghost" data-action="lunch-recipe" data-dish-id="${escapeHtml(dishId)}">מתכון</button>`
    : "";
  const actions = `
    <span class="lunch-day-item-actions">
      <button type="button" class="btn btn-ghost" data-action="lunch-edit-plan" data-date-key="${escapeHtml(dateKey)}" data-entry-id="${escapeHtml(ent.id)}" data-dish-id="${escapeHtml(dishId)}">עריכה</button>
      ${recipeBtn}
      <button type="button" class="btn btn-ghost hourly-edit-delete" data-action="lunch-remove-plan" data-date-key="${escapeHtml(dateKey)}" data-entry-id="${escapeHtml(ent.id)}">הסרה</button>
    </span>`;
  if (parts.length <= 1) {
    const name = parts[0] ?? "—";
    return `<li class="lunch-day-item">
      <span class="lunch-day-item-name">${escapeHtml(name)}${hasRec ? " 📖" : ""}</span>
      ${actions}
    </li>`;
  }
  const rows = parts
    .map(
      (p, i) =>
        `<li class="lunch-meal-part"><span class="lunch-meal-part-n">${i + 1}.</span> ${escapeHtml(p)}</li>`,
    )
    .join("");
  return `<li class="lunch-day-item lunch-day-meal-card">
    <div class="lunch-meal-card-top">
      <div class="lunch-meal-title">ארוחה${hasRec ? " 📖" : ""}</div>
      ${actions}
    </div>
    <ol class="lunch-meal-parts">${rows}</ol>
  </li>`;
}

function dishLabelForSelect(dish) {
  const parts = dishParts(dish);
  if (parts.length <= 1) return parts[0] ?? dish.name;
  return `${mealTitleForParts(parts)} (${parts.join(", ")})`;
}

function lunchComposeDialogEl() {
  return document.getElementById("lunchComposeDialog");
}

function lunchComposeDialogRoot() {
  const dlg = lunchComposeDialogEl();
  return dlg?.querySelector(".lunch-compose-dialog") ?? dlg;
}

function lunchCatalogMeals() {
  return lunchPlanner.dishes.filter((d) => dishParts(d).length > 1);
}

function mealPartsDataAttr(parts) {
  return escapeHtml(JSON.stringify(parts));
}

function renderLunchComposeStockCatSelect(preferredId = "") {
  const sel = document.getElementById("lunchComposeStockCat");
  if (!(sel instanceof HTMLSelectElement)) return;
  const prev = preferredId || sel.value;
  const cats = listStockCategories(lunchPlanner);
  sel.innerHTML = cats
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`)
    .join("");
  if (prev && cats.some((c) => c.id === prev)) sel.value = prev;
}

function lunchComposeSelectedStockCat(compose) {
  const sel = (compose ?? document).querySelector("#lunchComposeStockCat");
  return sel instanceof HTMLSelectElement ? sel.value : "";
}

function lunchEnsureComposeStockCategory(compose, { quiet = false } = {}) {
  const newInp = compose?.querySelector("#lunchComposeNewCatName");
  const newLabel = newInp instanceof HTMLInputElement ? newInp.value.trim() : "";
  if (newLabel) {
    const res = addStockCategory(lunchPlanner, newLabel);
    if (!res) return "";
    persistLunchPlanner();
    renderLunchComposeStockCatSelect(res.id);
    if (newInp instanceof HTMLInputElement) newInp.value = "";
    if (!quiet && res.created) toast("קטגוריה נוספה.");
    return res.id;
  }
  return lunchComposeSelectedStockCat(compose);
}

function lunchTryAddNameToHomeStock(name, catId) {
  const n = String(name ?? "").trim();
  if (!n || !catId) return false;
  if (!addHomeStockItem(lunchPlanner, catId, uid("lstk"), n)) return false;
  persistLunchPlanner();
  return true;
}

function splitComposeFreeTextParts(text) {
  return String(text ?? "")
    .split(/[\n,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function lunchComposeFreeTextEl(compose) {
  return compose?.querySelector("#lunchComposeFreeText") ?? compose?.querySelector(".lunch-day-dish-input");
}

function lunchComposeFreeTextValue(compose) {
  const el = lunchComposeFreeTextEl(compose);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim();
  return "";
}

function clearLunchComposeFreeText(compose) {
  const el = lunchComposeFreeTextEl(compose);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = "";
}

/** טקסט פתוח → מגש (+ מלאi); נדרשת קטגוריה אם יש טקסט */
function flushComposePendingToDraft(dateKey, compose) {
  const raw = lunchComposeFreeTextValue(compose);
  const typedParts = splitComposeFreeTextParts(raw);
  if (!typedParts.length) return { ok: true };
  const catId = lunchEnsureComposeStockCategory(compose, { quiet: true });
  if (!catId) return { ok: false };
  for (const name of typedParts) lunchTryAddNameToHomeStock(name, catId);
  for (const name of typedParts) lunchDraftAddPart(dateKey, name);
  clearLunchComposeFreeText(compose);
  return { ok: true };
}

function removeLunchDaySinglesIncludedInParts(dateKey, parts) {
  if (parts.length < 2) return;
  const weekStart = lunchBrowseWeekStart;
  const names = new Set(parts.map((p) => p.toLocaleLowerCase("he")));
  for (const ent of planEntriesForDay(lunchPlanner, weekStart, dateKey)) {
    const ep = planEntryMealParts(lunchPlanner, ent);
    if (ep.length === 1 && names.has(ep[0].toLocaleLowerCase("he"))) {
      removePlanEntry(lunchPlanner, weekStart, dateKey, ent.id);
    }
  }
}

function renderLunchDayPickerHtml(dateKey) {
  const catalogMeals = lunchCatalogMeals().sort((a, b) =>
    dishLabelForSelect(a).localeCompare(dishLabelForSelect(b), "he"),
  );
  let body = "";
  if (catalogMeals.length) {
    const mealRows = catalogMeals
      .map((d) => {
        const mealParts = dishParts(d);
        const label = dishLabelForSelect(d);
        return `<label class="lunch-day-pick lunch-day-pick--meal"><input type="checkbox" class="lunch-day-pick-cb lunch-day-pick-meal" data-date-key="${escapeHtml(dateKey)}" data-meal-parts="${mealPartsDataAttr(mealParts)}" /><span class="lunch-day-pick-label">${escapeHtml(label)}</span></label>`;
      })
      .join("");
    body += `<div class="lunch-day-pick-group"><div class="lunch-day-pick-group-title">מנות שלי</div>${mealRows}</div>`;
  }
  for (const cat of listStockCategories(lunchPlanner)) {
    const items = lunchPlanner.homeStock[cat.id] ?? [];
    if (!items.length) continue;
    const names = items.map((it) => it.name).sort((a, b) => a.localeCompare(b, "he"));
    const rows = names
      .map(
        (name) =>
          `<label class="lunch-day-pick"><input type="checkbox" class="lunch-day-pick-cb" data-date-key="${escapeHtml(dateKey)}" value="${escapeHtml(name)}" /><span class="lunch-day-pick-label">${escapeHtml(name)}</span></label>`,
      )
      .join("");
    body += `<div class="lunch-day-pick-group"><div class="lunch-day-pick-group-title">${escapeHtml(stockCategoryLabel(lunchPlanner, cat.id))}</div>${rows}</div>`;
  }
  if (!body) {
    return `<div class="lunch-day-picker lunch-day-picker--empty"></div>`;
  }
  return `<div class="lunch-day-picker"><div class="lunch-day-pick-scroll">${body}</div></div>`;
}

function gatherLunchCheckedParts(compose) {
  if (!compose) return [];
  const raw = [];
  compose.querySelectorAll("input.lunch-day-pick-cb:checked").forEach((cb) => {
    if (!(cb instanceof HTMLInputElement)) return;
    const encoded = cb.getAttribute("data-meal-parts");
    if (encoded) {
      try {
        const mealParts = JSON.parse(encoded);
        if (Array.isArray(mealParts)) {
          for (const p of mealParts) {
            const s = String(p ?? "").trim();
            if (s) raw.push(s);
          }
          return;
        }
      } catch {
        /* ignore */
      }
    }
    if (cb.value.trim()) raw.push(cb.value.trim());
  });
  return normalizePartList(raw);
}

function gatherLunchPartsFromCompose(compose, { includeDraft = false, dateKey = "", includeFreeText = true } = {}) {
  if (!compose) return [];
  const raw = includeDraft && dateKey ? [...lunchDraftGet(dateKey)] : [];
  raw.push(...gatherLunchCheckedParts(compose));
  if (includeFreeText) {
    const text = lunchComposeFreeTextValue(compose);
    if (text) raw.push(...splitComposeFreeTextParts(text));
  }
  return normalizePartList(raw);
}

function refreshLunchComposeDialogTray(dateKey) {
  const tray = document.getElementById("lunchComposeTray");
  if (!tray) return;
  tray.innerHTML = renderLunchDayTrayHtml(dateKey);
}

function mountLunchComposeDialog(dateKey) {
  const dlg = lunchComposeDialogEl();
  if (!(dlg instanceof HTMLDialogElement)) return;
  dlg.dataset.composeDateKey = dateKey;
  const title = document.getElementById("lunchComposeTitle");
  if (title) title.textContent = `ארוחה — ${formatHebrewDateLabel(dateKey)}`;
  const picker = document.getElementById("lunchComposePicker");
  if (picker) picker.innerHTML = renderLunchDayPickerHtml(dateKey);
  renderLunchComposeStockCatSelect();
  refreshLunchComposeDialogTray(dateKey);
  clearLunchComposeFreeText(lunchComposeDialogRoot());
}

function openLunchComposeDialog(dateKey) {
  const dlg = lunchComposeDialogEl();
  if (!(dlg instanceof HTMLDialogElement) || !dateKey) return;
  lunchDraftClear(dateKey);
  mountLunchComposeDialog(dateKey);
  dlg.showModal();
}

function clearLunchComposeDialogInputs(compose) {
  compose?.querySelectorAll("input.lunch-day-pick-cb:checked").forEach((cb) => {
    if (cb instanceof HTMLInputElement) cb.checked = false;
  });
  clearLunchComposeFreeText(compose);
}

function applyLunchDraftAdd(dateKey, compose) {
  const inp = lunchComposeFreeTextEl(compose);
  const typedParts = splitComposeFreeTextParts(lunchComposeFreeTextValue(compose));
  const fromChecks = gatherLunchCheckedParts(compose);

  if (!typedParts.length && !fromChecks.length) {
    toast("אין מה להוסיף.");
    return;
  }

  let stockCatId = "";
  if (typedParts.length) {
    stockCatId = lunchEnsureComposeStockCategory(compose, { quiet: true });
    if (!stockCatId) {
      toast("בחרי קטגוריה או הוסיפי שם לקטגוריה חדשה.");
      return;
    }
    for (const name of typedParts) lunchTryAddNameToHomeStock(name, stockCatId);
  }

  const partsToAdd = normalizePartList([...fromChecks, ...typedParts]);
  let added = 0;
  for (const part of partsToAdd) {
    if (lunchDraftAddPart(dateKey, part)) added++;
  }

  clearLunchComposeFreeText(compose);

  if (added === 0) {
    toast("כבר בארוחה.");
    return;
  }

  compose?.querySelectorAll("input.lunch-day-pick-cb:checked").forEach((cb) => {
    if (cb instanceof HTMLInputElement) cb.checked = false;
  });

  refreshLunchComposeDialogTray(dateKey);
  const picker = document.getElementById("lunchComposePicker");
  if (picker) picker.innerHTML = renderLunchDayPickerHtml(dateKey);
  if (stockCatId) renderLunchComposeStockCatSelect(stockCatId);

  toast(added === 1 ? "נוסף למגש." : `${added} נוספו למגש.`);
  queueMicrotask(() => {
    if (inp instanceof HTMLInputElement || inp instanceof HTMLTextAreaElement) inp.focus();
  });
}

function saveLunchComposeDialog() {
  const dlg = lunchComposeDialogEl();
  if (!(dlg instanceof HTMLDialogElement)) return;
  const dateKey = dlg.dataset.composeDateKey;
  if (!dateKey) return;
  const compose = lunchComposeDialogRoot();

  const flush = flushComposePendingToDraft(dateKey, compose);
  if (!flush.ok) {
    toast("בחרי קטגוריה או הוסיפי שם לקטגוריה חדשה.");
    return;
  }

  let parts = normalizePartList([...lunchDraftGet(dateKey), ...gatherLunchCheckedParts(compose)]);
  if (!parts.length) {
    toast("אין רכיבים — הוסיפי למגש או הקלידי רכיבים.");
    return;
  }

  if (parts.length >= 2) removeLunchDaySinglesIncludedInParts(dateKey, parts);

  compose?.querySelectorAll("input.lunch-day-pick-cb:checked").forEach((cb) => {
    if (cb instanceof HTMLInputElement) cb.checked = false;
  });

  if (!addLunchPlanForDay(dateKey, parts)) return;
  lunchDraftClear(dateKey);
  dlg.close();
}

function lunchDraftGet(dateKey) {
  return lunchDayDraftParts[dateKey] ?? [];
}

function lunchDraftAddPart(dateKey, part) {
  const p = String(part ?? "").trim();
  if (!p) return false;
  const norm = p.toLocaleLowerCase("he");
  const arr = lunchDayDraftGet(dateKey);
  if (arr.some((x) => x.toLocaleLowerCase("he") === norm)) return false;
  lunchDayDraftParts[dateKey] = [...arr, p];
  return true;
}

function lunchDraftRemovePart(dateKey, index) {
  const arr = lunchDraftGet(dateKey);
  if (index < 0 || index >= arr.length) return;
  const next = arr.filter((_, i) => i !== index);
  if (next.length) lunchDayDraftParts[dateKey] = next;
  else delete lunchDayDraftParts[dateKey];
}

function lunchDraftClear(dateKey) {
  delete lunchDayDraftParts[dateKey];
}

function renderLunchDayTrayHtml(dateKey) {
  const parts = lunchDraftGet(dateKey);
  if (!parts.length) {
    return `<div class="lunch-day-tray lunch-day-tray--empty"></div>`;
  }
  const chips = parts
    .map(
      (p, i) =>
        `<span class="lunch-draft-chip">${escapeHtml(p)}<button type="button" class="lunch-draft-chip-remove" data-action="lunch-draft-remove" data-date-key="${escapeHtml(dateKey)}" data-part-index="${i}" aria-label="הסרת רכיב">×</button></span>`,
    )
    .join("");
  const preview = mealTitleForParts(parts);
  return `<div class="lunch-day-tray"><div class="lunch-day-tray-preview">${escapeHtml(preview === "ארוחה" && parts.length > 1 ? `ארוחה — ${parts.length} רכיבים` : preview)}</div><div class="lunch-draft-chips">${chips}</div></div>`;
}

function renderLunchWeekPanel() {
  const weekStart = lunchBrowseWeekStart;
  const titleEl = document.getElementById("lunchWeekTitle");
  const grid = document.getElementById("lunchWeekGrid");
  if (!grid) return;

  const startD = dateKeyToLocalDate(weekStart);
  const endD = dateKeyToLocalDate(addDaysToDateKey(weekStart, 6));
  if (titleEl) titleEl.textContent = `${formatHebrewDayTitle(startD)} — ${formatHebrewDayTitle(endD)}`;

  const todayKey = localDateKey();
  grid.innerHTML = "";

  for (const dateKey of weekDayKeys(weekStart)) {
    const card = document.createElement("div");
    card.className = `lunch-day-card${dateKey === todayKey ? " is-today" : ""}`;
    const entries = planEntriesForDay(lunchPlanner, weekStart, dateKey);
    const itemsHtml = entries.map((ent) => renderLunchMealItemHtml(ent, dateKey)).join("");

    card.innerHTML = `
      <div class="lunch-day-head">${escapeHtml(formatHebrewDateLabel(dateKey))}</div>
      <ul class="lunch-day-list">${itemsHtml || ""}</ul>
      <button type="button" class="btn lunch-day-open-compose" data-action="lunch-open-compose" data-date-key="${escapeHtml(dateKey)}">ארוחה ליום</button>
    `;
    grid.appendChild(card);
  }
}

function renderLunchStockPanel() {
  const root = document.getElementById("lunchStockRoot");
  if (!root) return;
  root.innerHTML = "";
  const newCatWrap = document.createElement("div");
  newCatWrap.className = "lunch-stock-new-cat-wrap";
  newCatWrap.innerHTML = `
    <form class="add-row lunch-stock-new-cat" autocomplete="off">
      <input class="input" type="text" maxlength="40" placeholder="קטגוריה חדשה…" required />
      <button class="btn" type="submit">+ קטגוריה</button>
    </form>`;
  root.appendChild(newCatWrap);
  for (const cat of listStockCategories(lunchPlanner)) {
    const block = document.createElement("div");
    block.className = "lunch-stock-block";
    const items = lunchPlanner.homeStock[cat.id] ?? [];
    block.innerHTML = `
      <div class="lunch-stock-block-title">${escapeHtml(stockCategoryLabel(lunchPlanner, cat.id))}</div>
      <ul class="lunch-stock-list">
        ${items
          .map(
            (it) =>
              `<li><span>${escapeHtml(it.name)}</span><span class="lunch-stock-item-actions">
              <button type="button" class="btn btn-ghost" data-action="lunch-edit-stock" data-cat="${escapeHtml(cat.id)}" data-item-id="${escapeHtml(it.id)}" data-name="${escapeHtml(it.name)}">עריכה</button>
              <button type="button" class="btn btn-ghost hourly-edit-delete" data-action="lunch-remove-stock" data-cat="${escapeHtml(cat.id)}" data-item-id="${escapeHtml(it.id)}">×</button>
              </span></li>`,
          )
          .join("")}
      </ul>
      <form class="add-row lunch-stock-add" data-stock-cat="${escapeHtml(cat.id)}" autocomplete="off">
        <input class="input" type="text" maxlength="80" placeholder="הוספה…" required />
        <button class="btn" type="submit">+</button>
      </form>
    `;
    root.appendChild(block);
  }
}

function renderLunchDishesPanel() {
  const list = document.getElementById("lunchDishesList");
  if (!list) return;
  if (!lunchCatalogMeals().length) {
    list.innerHTML = UI_EMPTY;
    return;
  }
  list.innerHTML = lunchCatalogMeals()
    .map((d) => {
      const parts = dishParts(d);
      const hasRec = !!getRecipeForDish(lunchPlanner, d.id);
      const partsBlock =
        parts.length > 1
          ? `<ol class="lunch-meal-parts lunch-meal-parts--compact">${parts
              .map(
                (p, i) =>
                  `<li class="lunch-meal-part"><span class="lunch-meal-part-n">${i + 1}.</span> ${escapeHtml(p)}</li>`,
              )
              .join("")}</ol>`
          : "";
      const title = parts.length > 1 ? "ארוחה" : escapeHtml(parts[0] ?? d.name);
      return `<div class="lunch-dish-row lunch-dish-row--meal" role="listitem">
        <div class="lunch-dish-row-main">
          <div class="lunch-dish-row-title">${title}${hasRec ? " 📖" : ""}</div>
          ${partsBlock}
        </div>
        <span class="lunch-dish-row-actions">
          <button type="button" class="btn btn-ghost" data-action="lunch-edit-dish" data-dish-id="${escapeHtml(d.id)}">עריכה</button>
          <button type="button" class="btn btn-ghost" data-action="lunch-recipe" data-dish-id="${escapeHtml(d.id)}">${hasRec ? "עריכת מתכון" : "מתכון"}</button>
          <button type="button" class="btn btn-ghost hourly-edit-delete" data-action="lunch-delete-dish" data-dish-id="${escapeHtml(d.id)}">מחיקה</button>
        </span>
      </div>`;
    })
    .join("");
}

function renderLunchRecipesPanel() {
  const root = document.getElementById("lunchRecipesList");
  if (!root) return;
  if (!lunchPlanner.recipes.length) {
    root.innerHTML = UI_EMPTY;
    return;
  }
  root.innerHTML = lunchPlanner.recipes
    .map((r) => {
      const dish = findDish(lunchPlanner, r.dishId);
      return `<article class="lunch-recipe-card" role="listitem">
        <div class="lunch-recipe-card-title">${escapeHtml(r.title)}</div>
        <div class="lunch-recipe-card-dish">מנה: ${escapeHtml(dish?.name ?? "—")}</div>
        <div class="lunch-recipe-card-body">${escapeHtml(r.body)}</div>
        <div class="dialog-actions dialog-actions--wrap" style="margin-top:10px">
          <button type="button" class="btn btn-ghost" data-action="lunch-recipe" data-dish-id="${escapeHtml(r.dishId)}">עריכה</button>
        </div>
      </article>`;
    })
    .join("");
}

function renderLunchPlannerPage() {
  setLunchPlannerTab(lunchPlannerTab);
  renderLunchWeekPanel();
  renderLunchStockPanel();
  renderLunchDishesPanel();
  renderLunchRecipesPanel();
}

function addLunchPlanForDay(dateKey, partsRaw) {
  const weekStart = lunchBrowseWeekStart;
  const parts = normalizePartList(partsRaw);
  if (!parts.length) {
    toast("נא להזין לפחות רכיב אחד.");
    return false;
  }

  const sameDay = planEntriesForDay(lunchPlanner, weekStart, dateKey);
  const sig = partsSignature(parts);
  if (sameDay.some((ent) => partsSignature(planEntryMealParts(lunchPlanner, ent)) === sig)) {
    toast("ארוחה כזו כבר מתוכננת ליום הזה.");
    return false;
  }

  const created = parts.length > 1 ? findOrCreateMealFromParts(lunchPlanner, parts) : null;
  if (parts.length > 1 && !created?.dish) return false;

  const dup = findMealPlannedElsewhereInWeek(lunchPlanner, weekStart, parts, dateKey);
  if (dup) {
    const ok = confirm(
      `ארוחה דומה כבר מתוכננת ל־${formatHebrewDateLabel(dup)}.\n\nלהוסיף גם ל־${formatHebrewDateLabel(dateKey)}?`,
    );
    if (!ok) return false;
  }
  const added = addPlanEntryFromParts(lunchPlanner, weekStart, dateKey, parts);
  if (!added?.entry) return false;
  persistLunchPlanner();
  if (parts.length > 1) {
    toast(
      created?.created
        ? `נשמרה ארוחה (${parts.length} רכיבים) — גם ב«מנות שלי».`
        : `נשמרה ארוחה (${parts.length} רכיבים) ליום.`,
    );
  } else if (dup) toast("נוסף ליום.");
  else toast("נשמר.");
  render();
  return true;
}

function renderDailyFuturePage() {
  const root = document.getElementById("dailyFuturePlanRoot");
  const n = renderAggregatedPlanSections(root, "future");
  const progEl = document.getElementById("dailyFutureProgress");
  if (progEl) {
    progEl.textContent = n ? `${n} תתי־משימות נותרו (מתוך הרעיונות)` : "";
  }
}

function renderDailyHistoryPage() {
  const root = document.getElementById("dailyHistoryPlanRoot");
  const n = renderAggregatedPlanSections(root, "past");
  const progEl = document.getElementById("dailyHistoryProgress");
  if (progEl) {
    progEl.textContent = n ? `${n} תתי־משימות בארכיון` : "";
  }
}

function collectSubtasksForToday() {
  const todayK = localDateKey();
  /** @type {Map<string, { ideaTitle: string, taskTitle: string, subs: any[] }>} */
  const byTask = new Map();
  for (const idea of state.ideas) {
    for (const task of idea.tasks ?? []) {
      for (const sub of task.subtasks ?? []) {
        const dk = subtaskLocalDateKey(sub.startsAt);
        if (dk !== todayK) continue;
        const tkey = `${idea.id}::${task.id}`;
        if (!byTask.has(tkey))
          byTask.set(tkey, { ideaTitle: idea.title || "ללא שם", taskTitle: task.title || "ללא שם", subs: [] });
        byTask.get(tkey).subs.push(sub);
      }
    }
  }
  const tasks = [...byTask.values()];
  tasks.sort((a, b) => a.taskTitle.localeCompare(b.taskTitle));
  for (const t of tasks) t.subs = sortSubtasksByStart(t.subs);
  return { todayK, tasks };
}

function renderTodayIdeasOnDailyPage() {
  const ideasBlock = document.getElementById("dailyTodayIdeasBlock");
  const ideasRoot = document.getElementById("todayTasksIdeasRoot");
  if (!ideasRoot) return;
  ideasRoot.innerHTML = "";
  const { tasks } = collectSubtasksForToday();
  const openTasks = tasks
    .map((t) => ({ ...t, subs: (t.subs ?? []).filter((s) => !s.done) }))
    .filter((t) => t.subs.length > 0);
  if (openTasks.length === 0) {
    ideasBlock?.classList.add("hidden");
    return;
  }
  ideasBlock?.classList.remove("hidden");
  const wrap = document.createElement("section");
  wrap.className = "plan-date-block";
  wrap.innerHTML = `<div class="plan-date-body"></div>`;
  const body = wrap.querySelector(".plan-date-body");
  for (const task of openTasks) {
    const blk = document.createElement("div");
    blk.className = "plan-task-block";
    blk.innerHTML = `
      <div class="plan-task-head">
        <span class="plan-task-name">${escapeHtml(task.taskTitle)}</span>
        <span class="plan-idea-pill">${escapeHtml(task.ideaTitle)}</span>
      </div>
      <div class="plan-subs">${task.subs.map((s) => renderSubtaskCheckboxRow(s)).join("")}</div>
    `;
    body.appendChild(blk);
  }
  ideasRoot.appendChild(wrap);
}

function formatShortHebrewDate(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("he-IL", { day: "numeric", month: "short", year: "numeric" });
}

/** כל פריטי «היום שלי» לפי סדר תאריכים ואז סדר ברשימה */
function getAllDayJournalItemsChronological() {
  const days = dayJournal?.days ?? {};
  const keys = Object.keys(days).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
  keys.sort((a, b) => a.localeCompare(b));
  const rows = [];
  for (const dateKey of keys) {
    const items = days[dateKey]?.items ?? [];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object" || !item.id) continue;
      rows.push({ dateKey, item });
    }
  }
  return rows;
}

function renderDailyMasterPage() {
  const container = document.getElementById("dailyMasterList");
  const progEl = document.getElementById("dailyMasterProgress");
  if (!container) return;
  container.innerHTML = "";
  const rows = getAllDayJournalItemsChronological();

  if (rows.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = UI_EMPTY;
    container.appendChild(div);
    if (progEl) progEl.textContent = "";
    return;
  }

  const countable = rows.filter(({ item }) => item.kind !== "place");
  const total = countable.length;
  const doneC = countable.filter(({ item }) => item.done).length;

  let n = 0;
  for (const { dateKey, item } of rows) {
    n += 1;
    const label = dayItemLabel(item);
    const dateLabel = formatShortHebrewDate(dateKey);
    const row = document.createElement("div");
    row.setAttribute("role", "listitem");
    const isPlace = item.kind === "place";
    const isChild = !!item.parentId;
    if (isPlace) {
      row.className = "dm-row dm-row--place";
      row.innerHTML = `
        <span class="dm-num" aria-hidden="true">${n}.</span>
        <span class="dm-mark dm-mark--place" aria-hidden="true">📍</span>
        <div class="dm-main dm-main--place">
          <span class="dm-title">${escapeHtml(label || "ללא טקסט")}</span>
        </div>
        <span class="dm-date">${escapeHtml(dateLabel)}</span>
        <details class="daily-kebab dm-kebab">
          <summary class="daily-kebab-summary" aria-label="פעולות">⋮</summary>
          <div class="daily-kebab-menu" role="menu">
            <button type="button" class="daily-kebab-item" role="menuitem" data-action="daily-edit" data-date-key="${escapeHtml(dateKey)}" data-item-id="${escapeHtml(String(item.id))}">עריכה</button>
            <button type="button" class="daily-kebab-item daily-kebab-item--danger" role="menuitem" data-action="daily-delete" data-date-key="${escapeHtml(dateKey)}" data-item-id="${escapeHtml(String(item.id))}">מחיקה</button>
          </div>
        </details>
      `;
    } else {
      const mark = item.done ? "✓" : "✗";
      const markClass = item.done ? "dm-mark dm-mark--done" : "dm-mark dm-mark--open";
      row.className = `dm-row ${item.done ? "dm-row--done" : ""}${isChild ? " dm-row--child" : ""}`;
      row.innerHTML = `
        <span class="dm-num" aria-hidden="true">${n}.</span>
        <span class="${markClass}" title="${item.done ? "בוצע" : "לא בוצע"}" aria-hidden="true">${mark}</span>
        <label class="dm-main">
          <input type="checkbox" class="check" ${item.done ? "checked" : ""} data-action="daily-toggle" data-date-key="${escapeHtml(dateKey)}" data-item-id="${escapeHtml(String(item.id))}" aria-label="סימון ביצוע" />
          <span class="dm-title">${escapeHtml(label || "ללא טקסט")}</span>
        </label>
        <span class="dm-date">${escapeHtml(dateLabel)}</span>
        <details class="daily-kebab dm-kebab">
          <summary class="daily-kebab-summary" aria-label="פעולות למשימה">⋮</summary>
          <div class="daily-kebab-menu" role="menu">
            <button type="button" class="daily-kebab-item" role="menuitem" data-action="daily-edit" data-date-key="${escapeHtml(dateKey)}" data-item-id="${escapeHtml(String(item.id))}">עריכה</button>
            <button type="button" class="daily-kebab-item" role="menuitem" data-action="daily-timer" data-date-key="${escapeHtml(dateKey)}" data-item-id="${escapeHtml(String(item.id))}">טיימר</button>
            <button type="button" class="daily-kebab-item daily-kebab-item--danger" role="menuitem" data-action="daily-delete" data-date-key="${escapeHtml(dateKey)}" data-item-id="${escapeHtml(String(item.id))}">מחיקה</button>
          </div>
        </details>
      `;
    }
    container.appendChild(row);
  }

  if (progEl) {
    progEl.textContent = `סה״כ ${total} משימות • ${doneC} בוצעו • ${total - doneC} פתוחות (כותרות מקום לא נספרות)`;
  }
}

let dailyTimerTick = null;

function clearDailyTimerTick() {
  if (dailyTimerTick) {
    clearInterval(dailyTimerTick);
    dailyTimerTick = null;
  }
}

function formatElapsedMs(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function updateDailyTimerClock() {
  const el = document.getElementById("dailyTimerClock");
  if (!el) return;
  const a = timingState.active;
  if (!a?.startedAt) {
    el.textContent = "0:00";
    return;
  }
  const t0 = new Date(a.startedAt).getTime();
  if (Number.isNaN(t0)) {
    el.textContent = "0:00";
    return;
  }
  el.textContent = formatElapsedMs(Date.now() - t0);
}

function syncDailyTimerDialogUI() {
  const dlg = document.getElementById("dailyTimerDialog");
  const taskLine = document.getElementById("dailyTimerTaskLine");
  const meta = document.getElementById("dailyTimerMeta");
  const btnStart = document.getElementById("dailyTimerStart");
  const btnStop = document.getElementById("dailyTimerStop");
  const btnDiscard = document.getElementById("dailyTimerDiscard");
  if (!dlg || !taskLine || !meta || !btnStart || !btnStop || !btnDiscard) return;

  const dk = dlg.dataset.targetDateKey;
  const id = dlg.dataset.targetItemId;
  const it = dk && id ? findDayJournalItem(dk, id) : null;
  const label = dayItemLabel(it) || "משימה";

  const active = timingState.active;
  const same = timersMatch(timingState, dk, id);
  const runningHere = !!(active && same);

  taskLine.textContent = `משימה: ${label}`;

  if (!active) {
    meta.textContent =
      "לחצי «התחלה» כשמתחילות לעבוד, ו«סיום ושמירה» כשסיימת — המשך יופיע במסך «תזמון».";
  } else if (runningHere) {
    const st = new Date(active.startedAt).toLocaleString("he-IL");
    meta.textContent = `התחלה: ${st}`;
  } else {
    meta.textContent = `יש טיימר פעיל על «${active.title}». «סיום ושמירה» ישמור את המדידה שלו; אחר כך אפשר להפעיל כאן.`;
  }

  btnStart.disabled = !!active;
  btnStop.disabled = !active;
  btnDiscard.disabled = !active;

  updateDailyTimerClock();
}

function startDailyTimerTick() {
  clearDailyTimerTick();
  dailyTimerTick = setInterval(updateDailyTimerClock, 250);
}

function openDailyTimerDialog(dateKey, itemId) {
  const it = findDayJournalItem(dateKey, itemId);
  if (!it) {
    toast("המשימה לא נמצאה.");
    return;
  }
  if (it.kind === "place") {
    toast("טיימר זמין לשורות משימה / קנייה, לא לכותרת מקום.");
    return;
  }
  const dlg = document.getElementById("dailyTimerDialog");
  if (!(dlg instanceof HTMLDialogElement)) return;
  dlg.dataset.targetDateKey = dateKey;
  dlg.dataset.targetItemId = itemId;
  syncDailyTimerDialogUI();
  startDailyTimerTick();
  dlg.showModal();
}

function renderDailyTimingPage() {
  const root = document.getElementById("dailyTimingList");
  if (!root) return;
  root.innerHTML = "";
  const entries = timingState.entries ?? [];
  if (entries.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = UI_EMPTY;
    root.appendChild(div);
    return;
  }
  for (const e of entries) {
    const st = new Date(e.startedAt).toLocaleString("he-IL");
    const en = new Date(e.endedAt).toLocaleString("he-IL");
    const art = document.createElement("article");
    art.className = "timing-row";
    art.setAttribute("role", "listitem");
    art.innerHTML = `
      <div class="timing-title">${escapeHtml(e.title)}</div>
      <div class="timing-meta">יום במחברת: ${escapeHtml(e.dateKey)}</div>
      <div class="timing-times">התחלה: ${escapeHtml(st)}<br/>סיום: ${escapeHtml(en)}</div>
      <div class="timing-duration">משך: <strong>${escapeHtml(String(e.durationMinutes))}</strong> דק׳</div>
    `;
    root.appendChild(art);
  }
}

/**
 * סינון מלאי לפי מיקום, מצב מלאי ותקרת כמות.
 * `overrides` — אופציונלי להחלפת הערכים הגלובליים (לספירות בתפריט / בשבבים).
 */
function filterPantryItemsCombined(items, overrides = {}) {
  const loc = overrides.location ?? pantryLocFilter;
  const stock = overrides.stock ?? pantryStockFilter;
  const maxCap = "maxCap" in overrides ? overrides.maxCap : pantryMaxQtyCap;

  let list = items.filter((it) => loc === "all" || it.location === loc);
  if (stock === "in_stock") list = list.filter((it) => it.quantity > 0);
  else if (stock === "out") list = list.filter((it) => it.quantity <= 0);
  else if (stock === "low") {
    list = list.filter(
      (it) => it.quantity > 0 && it.quantity <= PANTRY_LOW_THRESHOLD,
    );
  }
  if (maxCap != null && Number.isFinite(maxCap)) {
    list = list.filter((it) => it.quantity <= maxCap);
  }
  return list;
}

function filterPantryItemsByStock(items) {
  return filterPantryItemsCombined(items);
}

/** רווח אחרי מילה או לפחות 3 תווים — לפני כן לא מציגים רשימה (פחות רעש) */
function shouldShowPantryNameSuggest(raw) {
  const t = String(raw ?? "").trim();
  if (t.length < 2) return false;
  if (/\s/.test(raw)) return true;
  return t.length >= 3;
}

function collectPantrySuggestMatches(query) {
  const raw = String(query ?? "");
  if (!shouldShowPantryNameSuggest(raw)) return [];
  const tokens = raw.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const list = pantryState.items.filter((it) => {
    const n = String(it.name ?? "").toLowerCase();
    return tokens.every((t) => n.includes(t));
  });
  const qflat = tokens.join(" ");
  list.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    const ae = an === qflat ? 0 : an.startsWith(qflat) ? 1 : 2;
    const be = bn === qflat ? 0 : bn.startsWith(qflat) ? 1 : 2;
    if (ae !== be) return ae - be;
    return a.name.localeCompare(b.name, "he");
  });
  return list.slice(0, 12);
}

function syncPantryNameSuggest() {
  const inp = document.getElementById("pantryNewName");
  const box = document.getElementById("pantryNewNameSuggest");
  if (!inp || !box) return;
  const matches = collectPantrySuggestMatches(inp.value);
  if (matches.length === 0) {
    box.hidden = true;
    box.innerHTML = "";
    inp.setAttribute("aria-expanded", "false");
    return;
  }
  box.hidden = false;
  inp.setAttribute("aria-expanded", "true");
  box.innerHTML = matches
    .map(
      (it) =>
        `<button type="button" class="pantry-suggest-item" role="option" data-pantry-suggest-id="${escapeHtml(it.id)}"><span class="pantry-suggest-name">${escapeHtml(it.name)}</span><span class="pantry-loc-pill pantry-suggest-loc">${escapeHtml(pantryLocationLabel(it.location))}</span></button>`,
    )
    .join("");
}

function wirePantryNameSuggest() {
  const inp = document.getElementById("pantryNewName");
  const box = document.getElementById("pantryNewNameSuggest");
  if (!inp || !box) return;

  let hideTimer = 0;
  const hideSoon = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      box.hidden = true;
      inp.setAttribute("aria-expanded", "false");
    }, 180);
  };

  inp.addEventListener("input", () => {
    window.clearTimeout(hideTimer);
    syncPantryNameSuggest();
  });
  inp.addEventListener("focus", () => syncPantryNameSuggest());
  inp.addEventListener("blur", hideSoon);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      window.clearTimeout(hideTimer);
      box.hidden = true;
      inp.setAttribute("aria-expanded", "false");
    }
  });

  box.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });
  box.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pantry-suggest-id]");
    if (!(btn instanceof HTMLElement)) return;
    const id = btn.getAttribute("data-pantry-suggest-id");
    if (!id) return;
    window.clearTimeout(hideTimer);
    inp.value = "";
    box.hidden = true;
    box.innerHTML = "";
    inp.setAttribute("aria-expanded", "false");
    openPantryEditDialog(id);
  });
}

function openPantryEditDialog(itemId) {
  const it = pantryState.items.find((x) => x.id === itemId);
  if (!it) return;
  const dlg = document.getElementById("pantryEditDialog");
  const n = document.getElementById("pantryEditName");
  const l = document.getElementById("pantryEditLoc");
  const q = document.getElementById("pantryEditQty");
  const u = document.getElementById("pantryEditUnit");
  if (!dlg || !n || !l || !q || !u) return;
  n.value = it.name;
  l.value = it.location;
  q.value = String(it.quantity);
  u.value = it.unit || "יח׳";
  dlg.dataset.itemId = itemId;
  dlg.showModal();
  queueMicrotask(() => {
    document.getElementById(`pantry-item-${itemId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    n.focus();
  });
}

function renderPantryPage() {
  const bar = document.getElementById("pantryFilterBar");
  const root = document.getElementById("pantryListRoot");
  const sum = document.getElementById("pantrySummary");
  const menuInner = document.getElementById("pantryStockFilterMenuInner");
  const hintEl = document.getElementById("pantryFilterHint");
  if (!bar || !root) return;

  bar.innerHTML = "";
  const mkChip = (filterId, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `pantry-chip ${pantryLocFilter === filterId ? "active" : ""}`;
    b.setAttribute("data-pantry-filter", filterId);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", pantryLocFilter === filterId ? "true" : "false");
    const cnt = filterPantryItemsCombined(pantryState.items, { location: filterId }).length;
    b.textContent = `${label} (${cnt})`;
    b.setAttribute("aria-label", `${label}, ${cnt} פריטים לפי סינון המלאי והכמות (⋮)`);
    bar.appendChild(b);
  };
  mkChip("all", "הכל");
  for (const loc of PANTRY_LOCATIONS) {
    mkChip(loc.id, loc.label);
  }

  if (menuInner) {
    const stockOpts = [
      ["all", "כל הפריטים"],
      ["in_stock", "רק עם מלאי"],
      ["out", "רק שאזלו"],
      ["low", `מלאי נמוך (עד ${PANTRY_LOW_THRESHOLD} יח׳)`],
    ];
    const capOpts = [
      [null, "כל הכמויות (ללא הגבלה)"],
      [1, "עד יחידה אחת שנותרה"],
      [2, "עד 2 יחידות שנותרו"],
      [3, "עד 3 יחידות"],
      [5, "עד 5 יחידות"],
      [10, "עד 10 יחידות"],
    ];
    menuInner.innerHTML = `
      <div class="pantry-menu-heading">מצב מלאי</div>
      ${stockOpts
        .map(([id, label]) => {
          const cnt = filterPantryItemsCombined(pantryState.items, { stock: id }).length;
          const text = `${label} (${cnt})`;
          return `<button type="button" class="daily-kebab-item ${pantryStockFilter === id ? "is-active" : ""}" role="menuitem" data-action="pantry-stock-filter" data-filter="${id}">${escapeHtml(text)}</button>`;
        })
        .join("")}
      <div class="pantry-menu-heading">לפי כמות שנותרה (מקסימום)</div>
      ${capOpts
        .map(([cap, label]) => {
          const c = cap == null ? "none" : String(cap);
          const active = cap == null ? pantryMaxQtyCap == null : pantryMaxQtyCap === cap;
          const cnt = filterPantryItemsCombined(pantryState.items, {
            maxCap: cap == null ? null : cap,
          }).length;
          const text = `${label} (${cnt})`;
          return `<button type="button" class="daily-kebab-item ${active ? "is-active" : ""}" role="menuitem" data-action="pantry-max-cap" data-cap="${c}">${escapeHtml(text)}</button>`;
        })
        .join("")}
    `;
  }

  const filtered = filterPantryItemsByStock(pantryState.items);
  const searchRaw = pantryListSearchQuery.trim().toLowerCase();
  const searchTokens = searchRaw.split(/\s+/).filter(Boolean);
  const displayed =
    searchTokens.length === 0
      ? filtered
      : filtered.filter((it) => {
          const n = String(it.name ?? "").toLowerCase();
          return searchTokens.every((t) => n.includes(t));
        });
  displayed.sort((a, b) => a.name.localeCompare(b.name, "he"));

  if (hintEl) {
    const parts = [];
    if (pantryStockFilter !== "all") {
      const labels = {
        in_stock: "רק עם מלאי",
        out: "רק שאזלו",
        low: `מלאי נמוך (עד ${PANTRY_LOW_THRESHOLD} יח׳)`,
      };
      parts.push(labels[pantryStockFilter] ?? pantryStockFilter);
    }
    if (pantryMaxQtyCap != null) parts.push(`נותרו עד ${pantryMaxQtyCap} יח׳`);
    hintEl.textContent = parts.length ? `סינון פעיל: ${parts.join(" · ")}` : "";
    hintEl.classList.toggle("hidden", parts.length === 0);
  }

  root.innerHTML = "";
  const anyItems = pantryState.items.length > 0;
  const filtersOn =
    pantryLocFilter !== "all" ||
    pantryStockFilter !== "all" ||
    pantryMaxQtyCap != null;
  const searchOn = searchTokens.length > 0;
  if (filtered.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    if (!anyItems) {
      div.innerHTML = UI_EMPTY;
    } else if (filtersOn) {
      div.innerHTML = UI_EMPTY;
    } else {
      div.innerHTML = UI_EMPTY;
    }
    root.appendChild(div);
  } else if (displayed.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = UI_EMPTY;
    root.appendChild(div);
  } else {
    for (const it of displayed) {
      const row = document.createElement("article");
      row.id = `pantry-item-${it.id}`;
      row.className = `pantry-row ${it.quantity <= 0 ? "pantry-row--empty" : ""}`;
      row.setAttribute("role", "listitem");
      const locLabel = pantryLocationLabel(it.location);
      const qStr = formatPantryQty(it.quantity);
      const unitEsc = escapeHtml(it.unit || "יח׳");
      const lowBadge =
        it.quantity > 0 && it.quantity <= PANTRY_LOW_THRESHOLD
          ? '<span class="pantry-badge-out" style="background:#fff8e1;color:#b28704;border:1px solid rgba(180,150,4,0.35)">מעט נשאר</span>'
          : "";
      row.innerHTML = `
        <div class="pantry-row-main">
          <div class="pantry-row-title">${escapeHtml(it.name)}</div>
          <div class="pantry-row-meta">
            <span class="pantry-loc-pill">${escapeHtml(locLabel)}</span>
            ${it.quantity <= 0 ? '<span class="pantry-badge-out">אזל — לקנות</span>' : lowBadge}
          </div>
        </div>
        <div class="pantry-row-actions">
          <div class="pantry-qty-big">${qStr} <span style="font-size:0.65em;font-weight:600;color:var(--muted2)">${unitEsc}</span></div>
          <div class="pantry-btn-row">
            <button type="button" class="pantry-act pantry-act--primary" data-action="pantry-consume" data-item-id="${escapeHtml(it.id)}">השתמשתי (−1)</button>
            <button type="button" class="pantry-act" data-action="pantry-restock" data-item-id="${escapeHtml(it.id)}">+1</button>
            <button type="button" class="pantry-act" data-action="pantry-edit" data-item-id="${escapeHtml(it.id)}">עריכה</button>
            <button type="button" class="pantry-act pantry-act--danger" data-action="pantry-delete" data-item-id="${escapeHtml(it.id)}">מחיקה</button>
          </div>
        </div>
      `;
      root.appendChild(row);
    }
  }

  if (sum) {
    const total = displayed.length;
    const out = displayed.filter((x) => x.quantity <= 0).length;
    const low = displayed.filter(
      (x) => x.quantity > 0 && x.quantity <= PANTRY_LOW_THRESHOLD,
    ).length;
    const searchBit = searchOn ? " וחיפוש" : "";
    sum.textContent = `סה״כ ${total} פריטים בתצוגה (לפי הסינון${searchBit}) • ${out} אזלו • ${low} במלאי נמוך (עד ${PANTRY_LOW_THRESHOLD} יח׳)`;
  }
}

function openDailyMasterPdfExport() {
  const rows = getAllDayJournalItemsChronological();
  if (rows.length === 0) {
    toast("אין משימות לייצוא.");
    return;
  }
  const bodyRows = rows
    .map((r, i) => {
      const isPlace = r.item.kind === "place";
      const isChild = !!r.item.parentId;
      const mark = isPlace ? "📍" : r.item.done ? "✓" : "✗";
      const rawTitle = dayItemLabel(r.item) || "—";
      const t = escapeHtml(`${isChild ? "↳ " : ""}${rawTitle}`);
      const dl = escapeHtml(formatShortHebrewDate(r.dateKey));
      return `<tr><td>${i + 1}</td><td>${mark}</td><td>${t}</td><td>${dl}</td></tr>`;
    })
    .join("");
  const title = escapeHtml(APP_DISPLAY_NAME);
  const stamp = escapeHtml(new Date().toLocaleString("he-IL"));
  const w = window.open("", "_blank");
  if (!w) {
    toast("החלון נחסם — אפשר לאפשר חלונות קופצים ולנסות שוב.");
    return;
  }
  w.document.open();
  w.document.write(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"/><title>כל הימים</title>
<style>
  body{font-family:Segoe UI,Calibri,Arial,sans-serif;padding:22px;font-size:14px;line-height:1.45;color:#111;}
  h1{font-size:1.15rem;margin:0 0 6px;color:#b71c1c;}
  .meta{color:#555;font-size:0.9rem;margin:0 0 18px;}
  table{width:100%;border-collapse:collapse;}
  th,td{border:1px solid #ccc;padding:10px 8px;text-align:right;vertical-align:top;}
  th{background:#fff5f7;font-weight:700;}
  @media print{
    body{padding:12px;}
    @page{margin:12mm;}
  }
</style></head><body>
<h1>כל הימים</h1>
<p class="meta">${title} · ${stamp}</p>
<table>
<thead><tr><th>מס׳</th><th>סטטוס</th><th>משימה</th><th>תאריך</th></tr></thead>
<tbody>${bodyRows}</tbody>
</table>
</body></html>`);
  w.document.close();
  const doPrint = () => {
    try {
      w.focus();
      w.print();
    } catch {
      /* ignore */
    }
  };
  if (w.document.readyState === "complete") queueMicrotask(doPrint);
  else w.onload = doPrint;
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

function toast(msg, { durationMs = 3500 } = {}) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), durationMs);
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
  render();
  scheduleCloudBackupIfEnabled();
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
      list.innerHTML = UI_EMPTY;
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
      list.innerHTML = UI_EMPTY;
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
    div.innerHTML = UI_EMPTY;
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

  /** @type {Map<string, { ideaTitle: string, taskTitle: string, subs: any[] }>} */
  const groups = new Map();
  for (const it of filtered) {
    const key = `${it.ideaId}::${it.taskId}`;
    if (!groups.has(key)) groups.set(key, { ideaTitle: it.ideaTitle, taskTitle: it.taskTitle, subs: [] });
    groups.get(key).subs.push(it);
  }

  const grouped = [...groups.values()].sort((a, b) => {
    const aT = a.taskTitle.localeCompare(b.taskTitle);
    if (aT) return aT;
    return a.ideaTitle.localeCompare(b.ideaTitle);
  });

  els.tasksListAll.innerHTML = "";
  if (grouped.length === 0) {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = UI_EMPTY;
    els.tasksListAll.appendChild(div);
    return;
  }

  for (const g of grouped) {
    const section = document.createElement("section");
    section.className = "tasks-group";

    const head = document.createElement("div");
    head.className = "tasks-group-head";
    head.innerHTML = `
      <div class="tasks-group-title">${escapeHtml(g.taskTitle)}</div>
      <div class="tasks-group-meta">רעיון: <strong>${escapeHtml(g.ideaTitle)}</strong></div>
    `;
    section.appendChild(head);

    const list = document.createElement("div");
    list.className = "tasks-sub-list";
    const subsSorted = [...g.subs].sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
    for (const it of subsSorted) {
      const row = document.createElement("div");
      row.className = "tasks-sub-row";
      const d = new Date(it.startsAt);
      const dateText = d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "2-digit" });
      const timeText = d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      row.innerHTML = `
        <label class="tasks-sub-main">
          <input class="check" type="checkbox" ${it.done ? "checked" : ""} data-action="toggle-subtask-from-calendar" data-subtask-id="${escapeHtml(it.subtaskId)}" aria-label="סימון תת־משימה" />
          <span class="tasks-sub-title">${escapeHtml(it.subtaskTitle)}</span>
        </label>
        <div class="tasks-sub-meta">
          <span class="pill">תאריך: ${escapeHtml(dateText)}</span>
          <span class="pill">שעה: ${escapeHtml(timeText)}</span>
        </div>
        <div class="tasks-sub-actions">
          <button class="icon-btn" type="button" data-action="open-subtask" data-subtask-id="${escapeHtml(it.subtaskId)}" title="עריכה">✎</button>
        </div>
      `;
      list.appendChild(row);
    }
    section.appendChild(list);
    els.tasksListAll.appendChild(section);
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
    div.innerHTML = UI_EMPTY;
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
          <form class="add-row add-row--subtask" data-add-subtask-form="${task.id}" autocomplete="off">
            <input class="input" name="subtaskTitle" type="text" placeholder="תת־משימה חדשה…" maxlength="160" required />
            <label class="dt-label"><span class="dt-label-text">התחלה</span><input class="dt" name="subtaskStart" type="datetime-local" title="התחלה" /></label>
            <label class="dt-label"><span class="dt-label-text">סיום (רשות)</span><input class="dt" name="subtaskEnd" type="datetime-local" title="סיום (אופציונלי)" /></label>
            <button class="btn btn--subtask-add" type="submit">הוספת תת־משימה</button>
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
      // אחרי הוספת תת־משימה: לקפל כדי לחזור לרשימה נקייה
      task.uiOpen = false;
      persistAndRender();
    });
  }
}

function renderSubtasks(idea, task, subtasksListEl) {
  subtasksListEl.innerHTML = "";
  const subtasks = task.subtasks ?? [];

  if (subtasks.length === 0) {
    return;
  }

  for (const sub of subtasks) {
    const row = document.createElement("div");
    row.className = "subtask-row";
    row.innerHTML = `
      <input class="check" type="checkbox" ${sub.done ? "checked" : ""} aria-label="סימון תת־משימה" data-action="toggle-subtask" data-subtask-id="${sub.id}" />
      <div class="subtask-title">${escapeHtml(sub.title || "ללא שם")}</div>
      <label class="dt-label"><span class="dt-label-text">התחלה</span><input class="dt" type="datetime-local" value="${escapeHtml(formatDateTimeValue(sub.startsAt))}" data-action="set-subtask-start" data-subtask-id="${sub.id}" title="התחלה" /></label>
      <label class="dt-label"><span class="dt-label-text">סיום</span><input class="dt" type="datetime-local" value="${escapeHtml(formatDateTimeValue(sub.endsAt))}" data-action="set-subtask-end" data-subtask-id="${sub.id}" title="סיום" /></label>
      <button class="icon-btn danger subtask-delete" type="button" data-action="delete-subtask" data-subtask-id="${sub.id}" title="מחיקת תת־משימה">🗑</button>
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
      return;
    }

    if (action === "set-subtask-start") {
      sub.startsAt = fromLocalInputToIso(el.value);
      persistAndRender();
      return;
    }

    if (action === "set-subtask-end") {
      sub.endsAt = fromLocalInputToIso(el.value);
      persistAndRender();
    }
  });
}

function wirePantryImportUI() {
  const openBtn = document.getElementById("pantryImportOpenBtn");
  const pickBtn = document.getElementById("pantryImportPickBtn");
  const fileInp = document.getElementById("pantryImportFile");
  const dlg = document.getElementById("pantryImportDialog");
  const status = document.getElementById("pantryImportStatus");
  const tbody = document.getElementById("pantryImportTbody");
  const applyBtn = document.getElementById("pantryImportApply");
  const cancelBtn = document.getElementById("pantryImportCancel");
  const allChk = document.getElementById("pantryImportAll");
  const rawWrap = document.getElementById("pantryImportRawWrap");
  const rawPre = document.getElementById("pantryImportRaw");

  const pick = () => fileInp?.click();

  openBtn?.addEventListener("click", pick);
  pickBtn?.addEventListener("click", pick);

  allChk?.addEventListener("change", () => {
    const on = !!allChk.checked;
    tbody?.querySelectorAll(".pic-check").forEach((c) => {
      if (c instanceof HTMLInputElement) c.checked = on;
    });
  });

  cancelBtn?.addEventListener("click", () => {
    if (dlg instanceof HTMLDialogElement) dlg.close();
  });

  applyBtn?.addEventListener("click", () => {
    const loc = document.getElementById("pantryImportLoc")?.value ?? "pantry";
    const rows = [];
    tbody?.querySelectorAll("tr").forEach((tr) => {
      const ck = tr.querySelector(".pic-check");
      if (!(ck instanceof HTMLInputElement) || !ck.checked) return;
      const nameInp = tr.querySelector(".pic-name");
      const qtyInp = tr.querySelector(".pic-qty");
      const name = nameInp instanceof HTMLInputElement ? nameInp.value.trim() : "";
      const qty = Number(qtyInp instanceof HTMLInputElement ? qtyInp.value : 0);
      if (name && qty > 0) rows.push({ name, qty });
    });
    if (!rows.length) {
      toast("לא נבחרו שורות תקינות להוספה.");
      return;
    }
    applyPantryImportRows(pantryState, rows, loc, "יח׳");
    if (dlg instanceof HTMLDialogElement) dlg.close();
    toast(`עודכנו ${rows.length} שורות במלאי (מיזוג לפי שם ומיקום).`);
    render();
  });

  fileInp?.addEventListener("change", async () => {
    const f = fileInp.files?.[0];
    if (!f || !dlg || !status || !tbody) return;
    if (!(dlg instanceof HTMLDialogElement)) return;
    dlg.showModal();
    tbody.innerHTML = "";
    if (allChk instanceof HTMLInputElement) allChk.checked = true;
    if (rawWrap instanceof HTMLDetailsElement) {
      rawWrap.classList.add("hidden");
      rawWrap.open = false;
    }
    if (rawPre) rawPre.textContent = "";
    status.textContent = "מעבדים…";
    try {
      const mod = await import("./pantry-import.js");
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      let text;
      if (isPdf) {
        status.textContent = "קוראים PDF…";
        text = await mod.extractPdfPlainText(f);
      } else {
        status.textContent =
          "מזהים טקסט בתמונה (OCR). בפעם הראשונה נטענת שפה — זה עלול לקחת דקה-שתיים…";
        text = await mod.ocrImageToText(f, (msg) => {
          status.textContent = msg;
        });
      }
      const { rows, label } = mod.autoParseReceiptText(text, isPdf);
      const rawStr = String(text ?? "").trim();
      if (!rows.length && rawStr && rawPre && rawWrap instanceof HTMLDetailsElement) {
        const cap = 32000;
        rawPre.textContent =
          rawStr.length > cap
            ? `${rawStr.slice(0, cap)}\n\n… (הטקסט קוצר — הקובץ ארוך מאוד)`
            : rawStr;
        rawWrap.classList.remove("hidden");
        rawWrap.open = true;
      }
      if (!rows.length) {
        status.textContent = `לא נמצאו שורות (${label}). נסי קובץ אחר או הוסיפי ידנית.`;
      } else {
        status.textContent = `${rows.length} שורות — ${label}. סמני, תקני כמויות ולחצי «הוספה למלאי».`;
        for (const r of rows) {
          const tr = document.createElement("tr");
          const td0 = document.createElement("td");
          const ck = document.createElement("input");
          ck.type = "checkbox";
          ck.className = "pic-check";
          ck.checked = true;
          td0.appendChild(ck);
          const td1 = document.createElement("td");
          const inpN = document.createElement("input");
          inpN.type = "text";
          inpN.className = "input pic-name";
          inpN.value = r.name;
          td1.appendChild(inpN);
          const td2 = document.createElement("td");
          const inpQ = document.createElement("input");
          inpQ.type = "number";
          inpQ.className = "input pic-qty";
          inpQ.min = "0";
          inpQ.step = "1";
          inpQ.value = String(Math.round(r.qty));
          td2.appendChild(inpQ);
          tr.appendChild(td0);
          tr.appendChild(td1);
          tr.appendChild(td2);
          tbody.appendChild(tr);
        }
      }
    } catch (e) {
      console.error(e);
      status.textContent = `שגיאה: ${e?.message ?? e}`;
    }
    fileInp.value = "";
  });
}

function wirePantryBarcodeUI() {
  const openBtn = document.getElementById("pantryBarcodeOpenBtn");
  const dlg = document.getElementById("pantryBarcodeDialog");
  const video = document.getElementById("pantryBarcodeVideo");
  const videoWrap = document.getElementById("pantryBarcodeVideoWrap");
  const startCam = document.getElementById("pantryBarcodeStartCam");
  const stopCam = document.getElementById("pantryBarcodeStopCam");
  const codeInp = document.getElementById("pantryBarcodeCode");
  const lookupBtn = document.getElementById("pantryBarcodeLookup");
  const status = document.getElementById("pantryBarcodeStatus");
  const nameInp = document.getElementById("pantryBarcodeName");
  const qtyInp = document.getElementById("pantryBarcodeQty");
  const locSel = document.getElementById("pantryBarcodeLoc");
  const addBtn = document.getElementById("pantryBarcodeAdd");
  const cancelBtn = document.getElementById("pantryBarcodeCancel");

  if (
    !openBtn ||
    !dlg ||
    !(dlg instanceof HTMLDialogElement) ||
    !video ||
    !videoWrap ||
    !startCam ||
    !stopCam ||
    !codeInp ||
    !lookupBtn ||
    !status ||
    !nameInp ||
    !qtyInp ||
    !locSel ||
    !addBtn ||
    !cancelBtn
  ) {
    return;
  }

  let scanControls = null;

  const cleanupVideo = async () => {
    try {
      scanControls?.stop();
    } catch {
      /* ignore */
    }
    scanControls = null;
    try {
      const { BrowserCodeReader } = await import("@zxing/browser");
      if (video instanceof HTMLVideoElement) BrowserCodeReader.cleanVideoSource(video);
    } catch {
      /* ignore */
    }
    videoWrap.classList.add("hidden");
    startCam.classList.remove("hidden");
    stopCam.classList.add("hidden");
  };

  const resetForm = () => {
    codeInp.value = "";
    nameInp.value = "";
    qtyInp.value = "1";
    status.textContent = "";
    const defLoc = document.getElementById("pantryNewLoc")?.value;
    if (defLoc && locSel instanceof HTMLSelectElement) locSel.value = defLoc;
  };

  const runLookup = async () => {
    const code = normalizeBarcodeInput(codeInp.value);
    if (code.length < 8) {
      status.textContent = "הקלידי לפחות 8 ספרות של הברקוד, או סרקי במצלמה.";
      return;
    }
    codeInp.value = code;
    status.textContent = "מחפשים שם…";
    const res = await lookupOpenFoodFactsProduct(code);
    if (res.ok) {
      nameInp.value = res.name;
      status.textContent = "נמצא שם במאגר. בדקי, ערכי כמות והוסיפי.";
    } else {
      status.textContent = res.error;
    }
  };

  openBtn.addEventListener("click", async () => {
    resetForm();
    await cleanupVideo();
    dlg.showModal();
  });

  cancelBtn.addEventListener("click", () => {
    void cleanupVideo();
    dlg.close();
  });

  dlg.addEventListener("close", () => {
    void cleanupVideo();
  });

  startCam.addEventListener("click", async () => {
    await cleanupVideo();
    status.textContent = "";
    try {
      const { BrowserMultiFormatReader, BrowserCodeReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      videoWrap.classList.remove("hidden");
      startCam.classList.add("hidden");
      stopCam.classList.remove("hidden");
      status.textContent = "מסרקים… כוונו את הברקוד למרכז.";

      let settled = false;
      scanControls = await reader.decodeFromVideoDevice(
        undefined,
        video,
        (result, _err, controls) => {
          if (settled || !result) return;
          settled = true;
          const text = result.getText();
          codeInp.value = normalizeBarcodeInput(text);
          try {
            controls.stop();
          } catch {
            /* ignore */
          }
          scanControls = null;
          BrowserCodeReader.cleanVideoSource(video);
          videoWrap.classList.add("hidden");
          startCam.classList.remove("hidden");
          stopCam.classList.add("hidden");
          status.textContent = "נסרק. מחפשים שם…";
          void runLookup();
        },
      );
    } catch (e) {
      console.error(e);
      status.textContent =
        /permission|notallowed|denied/i.test(String(e?.message ?? e))
          ? "המצלמה חסומה — אפשר להקליד את הברקוד ידנית."
          : "לא ניתן להפעיל סריקה במצלמה.";
      await cleanupVideo();
    }
  });

  stopCam.addEventListener("click", () => {
    void cleanupVideo();
    status.textContent = "";
  });

  lookupBtn.addEventListener("click", () => {
    void runLookup();
  });

  codeInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runLookup();
    }
  });

  addBtn.addEventListener("click", () => {
    const name = nameInp.value.trim();
    const qty = Number(qtyInp.value);
    const loc = locSel.value ?? "pantry";
    if (!name) {
      toast("חסר שם מוצר — חפשי ברקוד או הקלידי שם מהאריזה.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      toast("כמות לא תקינה.");
      return;
    }
    applyPantryImportRows(pantryState, [{ name, qty }], loc, "יח׳");
    void cleanupVideo();
    dlg.close();
    render();
    toast(`נוסף למלאי: ${name} (${qty})`);
  });
}

function wireDailyTimerDialog() {
  const dlg = document.getElementById("dailyTimerDialog");
  const btnStart = document.getElementById("dailyTimerStart");
  const btnStop = document.getElementById("dailyTimerStop");
  const btnDiscard = document.getElementById("dailyTimerDiscard");
  const btnClose = document.getElementById("dailyTimerCloseBtn");
  if (!dlg || !btnStart || !btnStop || !btnDiscard || !btnClose) return;

  dlg.addEventListener("close", () => clearDailyTimerTick());

  btnClose.addEventListener("click", () => {
    if (dlg instanceof HTMLDialogElement) dlg.close();
  });

  btnStart.addEventListener("click", () => {
    if (!(dlg instanceof HTMLDialogElement)) return;
    const dk = dlg.dataset.targetDateKey;
    const id = dlg.dataset.targetItemId;
    if (!dk || !id) return;
    if (timingState.active) {
      toast("כבר רץ טיימר — סיימי אותו או בטלי מדידה.");
      return;
    }
    const it = findDayJournalItem(dk, id);
    if (!it) return;
    startDayItemTimer(timingState, { dateKey: dk, itemId: id, title: dayItemLabel(it) });
    syncDailyTimerDialogUI();
    render();
  });

  btnStop.addEventListener("click", () => {
    if (!timingState.active) return;
    const ent = stopDayItemTimer(timingState);
    syncDailyTimerDialogUI();
    render();
    if (ent) toast(`נשמר: ${ent.durationMinutes} דק׳`);
  });

  btnDiscard.addEventListener("click", () => {
    if (!timingState.active) return;
    const ok = confirm("למחוק את המדידה בלי לשמור?");
    if (!ok) return;
    cancelActiveTimer(timingState);
    syncDailyTimerDialogUI();
    render();
    toast("הטיימר בוטל.");
  });
}

function refreshCloudBackupPanel() {
  const noCfg = document.getElementById("cloudBackupNoConfig");
  const panel = document.getElementById("cloudBackupPanel");
  const userLine = document.getElementById("cloudBackupUserLine");
  const hint = document.getElementById("cloudBackupHint");
  const signIn = document.getElementById("cloudSignInBtn");
  const signOut = document.getElementById("cloudSignOutBtn");
  const backupNow = document.getElementById("cloudBackupNowBtn");
  const restore = document.getElementById("cloudRestoreBtn");
  if (!noCfg || !panel || !userLine) return;

  panel.classList.remove("hidden");

  if (!isCloudBackupConfigured()) {
    noCfg.classList.remove("hidden");
    userLine.textContent = "";
    signIn?.classList.remove("hidden");
    signOut?.classList.add("hidden");
    if (signIn) {
      signIn.disabled = true;
      signIn.removeAttribute("title");
    }
    if (signOut) signOut.disabled = true;
    if (backupNow) backupNow.disabled = true;
    if (restore) restore.disabled = true;
    if (hint) hint.textContent = "";
    return;
  }

  noCfg.classList.add("hidden");
  if (signIn) signIn.disabled = false;

  initCloudBackup();
  const user = getCloudUser();
  if (user) {
    userLine.textContent = `מחוברת: ${user.email || user.displayName || user.uid}`;
    signIn?.classList.add("hidden");
    signOut?.classList.remove("hidden");
    if (signOut) signOut.disabled = false;
    if (backupNow) backupNow.disabled = false;
    if (restore) restore.disabled = false;
  } else {
    userLine.textContent = "לא מחוברת";
    signIn?.classList.remove("hidden");
    signOut?.classList.add("hidden");
    if (backupNow) backupNow.disabled = true;
    if (restore) restore.disabled = true;
  }
  if (hint) hint.textContent = cloudBackupUi.message || "";
}

function wireGlobalHandlers() {
  setAfterTimingPersist(() => scheduleCloudBackupIfEnabled());

  const topMenuToggle = document.getElementById("topMenuToggle");
  const topMenuDialog = document.getElementById("topMenuDialog");
  if (topMenuToggle && topMenuDialog instanceof HTMLDialogElement) {
    const setExpanded = (open) => topMenuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    const openMenu = () => {
      try {
        topMenuDialog.showModal();
        setExpanded(true);
      } catch {
        // ignore
      }
    };
    const closeMenu = () => {
      try {
        topMenuDialog.close();
      } catch {
        // ignore
      }
      setExpanded(false);
    };

    topMenuToggle.addEventListener("click", () => {
      if (topMenuDialog.open) closeMenu();
      else openMenu();
    });
    topMenuDialog.addEventListener("close", () => setExpanded(false));
    topMenuDialog.addEventListener("click", (e) => {
      // click on backdrop
      if (e.target === topMenuDialog) closeMenu();
      // click any menu button
      if (e.target.closest?.("button")) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && topMenuDialog.open) closeMenu();
    });
  }

  document.addEventListener("click", (e) => {
    const inside = e.target.closest("details.daily-kebab");
    queueMicrotask(() => {
      document.querySelectorAll("details.daily-kebab[open]").forEach((d) => {
        if (d !== inside) d.open = false;
      });
    });
  });

  wireDailyTimerDialog();
  wirePantryImportUI();
  wirePantryBarcodeUI();

  const settingsBtn = document.getElementById("settingsBtn");
  const settingsDialog = document.getElementById("settingsDialog");
  const setDefaultCalMode = document.getElementById("setDefaultCalMode");
  const settingsSave = document.getElementById("settingsSave");

  if (settingsBtn && settingsDialog && setDefaultCalMode && settingsSave) {
    const cloudAutoBackupEl = document.getElementById("cloudAutoBackup");
    const cloudSignInBtn = document.getElementById("cloudSignInBtn");
    const cloudSignOutBtn = document.getElementById("cloudSignOutBtn");
    const cloudBackupNowBtn = document.getElementById("cloudBackupNowBtn");
    const cloudRestoreBtn = document.getElementById("cloudRestoreBtn");
    const pushNotifyEnableBtn = document.getElementById("pushNotifyEnableBtn");
    const pushNotifyStatus = document.getElementById("pushNotifyStatus");
    const setPushServerUrl = document.getElementById("setPushServerUrl");

    const refreshPushNotifyPanel = () => {
      if (pushNotifyStatus) pushNotifyStatus.textContent = pushStatusText();
      if (setPushServerUrl) setPushServerUrl.value = settings.pushServerUrl || "";
    };

    settingsBtn.addEventListener("click", () => {
      setDefaultCalMode.value = settings.defaultCalMode;
      if (cloudAutoBackupEl) cloudAutoBackupEl.checked = settings.cloudAutoBackup;
      refreshCloudBackupPanel();
      refreshPushNotifyPanel();
      settingsDialog.showModal();
    });

    settingsSave.addEventListener("click", () => {
      settings.defaultCalMode = String(setDefaultCalMode.value ?? "week");
      settings.cloudAutoBackup = !!(cloudAutoBackupEl && cloudAutoBackupEl.checked);
      settings.pushServerUrl = String(setPushServerUrl?.value ?? "").trim();
      saveSettings();
      ui.calMode = settings.defaultCalMode;

      settingsDialog.close();
      toast("ההגדרות נשמרו.");
      persistAndRender();
    });

    cloudSignInBtn?.addEventListener("click", async () => {
      try {
        await signInCloudWithGoogle();
        refreshCloudBackupPanel();
        toast("התחברת בהצלחה.");
      } catch (e) {
        console.error(e);
        toast("התחברות נכשלה. בדקי חוסם חלונות או הגדרות Firebase (Google provider, דומיין מאושר).");
      }
    });

    cloudSignOutBtn?.addEventListener("click", async () => {
      try {
        await signOutCloud();
        refreshCloudBackupPanel();
        toast("התנתקת מהענן.");
      } catch (e) {
        console.error(e);
        toast("התנתקות נכשלה.");
      }
    });

    cloudBackupNowBtn?.addEventListener("click", async () => {
      const user = getCloudUser();
      if (!user) {
        toast("נא להתחבר קודם.");
        return;
      }
      setCloudBackupHint("working", "מגבה…");
      if (cloudBackupNowBtn) cloudBackupNowBtn.disabled = true;
      try {
        await uploadCloudSnapshot(user.uid);
        const nowIso = new Date().toISOString();
        const timeStr = cloudTimeShort(nowIso);
        setCloudBackupHint("ok", `✓ גיבוי הועלה ב־${timeStr}`, nowIso);
        toast(`✓ הגיבוי הועלה לענן בהצלחה (${timeStr})`, { durationMs: 5000 });
      } catch (e) {
        console.error(e);
        setCloudBackupHint("error", "⚠ העלאת גיבוי נכשלה — בדקי חיבור והרשאות Firestore.");
        toast("⚠ העלאת גיבוי נכשלה.", { durationMs: 5000 });
      } finally {
        if (cloudBackupNowBtn) cloudBackupNowBtn.disabled = false;
      }
    });

    cloudRestoreBtn?.addEventListener("click", async () => {
      const user = getCloudUser();
      if (!user) {
        toast("נא להתחבר קודם.");
        return;
      }
      const ok = confirm(
        "שחזור מהענן יחליף את כל הנתונים המקומיים (רעיונות, יומן, מלאי, תזמון, הגדרות) בגרסה מהענן.\n\nלהמשיך?",
      );
      if (!ok) return;
      try {
        const data = await fetchCloudSnapshot(user.uid);
        if (!data?.keys || typeof data.keys !== "object") {
          toast("בענן אין גיבוי עדיין. לחצי קודם «גיבוי עכשיו».");
          return;
        }
        applyCloudSnapshotToLocalStorage(data);
        toast("הנתונים שוחזרו. הדף ייטען מחדש…");
        setTimeout(() => location.reload(), 400);
      } catch (e) {
        console.error(e);
        toast("שחזור נכשל. בדקי הרשאות וחיבור.");
      }
    });

    pushNotifyEnableBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void runEnableHourlyPushFromClick();
    });
  }

  const exportPdfBtn = document.getElementById("exportPdfBtn");
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener("click", async () => {
      document.getElementById("topMenuDialog")?.close?.();
      const plain = fullAppToExportPlainText(state, dayJournal);
      toast("מכינה PDF…");
      try {
        const { downloadFullBackupPdf } = await import("./pdf-export.js");
        await downloadFullBackupPdf({
          title: `${APP_DISPLAY_NAME} — גיבוי מלא`,
          plainText: plain,
        });
        toast("הקובץ הורד (תיקיית הורדות). אפשר לשלוח אותו לאן שרוצים.");
      } catch (err) {
        console.error(err);
        toast("יצירת PDF נכשלה. נסי מחשב או דפדפן אחר.");
      }
    });
  }

  els.resetBtn.addEventListener("click", () => {
    const ok = confirm("למחוק את כל הנתונים? (רעיונות, יומן, תזמון, מלאי — איפוס מלא)");
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(DAY_JOURNAL_STORAGE_KEY);
    localStorage.removeItem(LAST_CALENDAR_DAY_KEY);
    localStorage.removeItem(TIMING_LOG_KEY);
    localStorage.removeItem(PANTRY_STORAGE_KEY);
    localStorage.removeItem(HOURLY_SCHEDULE_STORAGE_KEY);
    localStorage.removeItem(LUNCH_PLANNER_STORAGE_KEY);
    state = loadState();
    dayJournal = loadDayJournal();
    timingState = loadTimingState();
    pantryState = loadPantry();
    hourlySchedule = loadHourlySchedule();
    hourlyBrowseDateKey = localDateKey();
    lunchPlanner = loadLunchPlanner();
    lunchBrowseWeekStart = weekStartKeyFromDateKey(localDateKey());
    lastKnownCalendarDayKey = localDateKey();
    dailyBrowseDateKey = lastKnownCalendarDayKey;
    persistLastKnownCalendarDay();
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
    // ברירת מחדל: משימות מקופלות כדי לא להעמיס
    idea.tasks.unshift({ id: uid("task"), title, subtasks: [], uiOpen: false });
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
  bindAppMode("bnDailyToday", "daily-today");
  bindAppMode("bnHourlySchedule", "hourly-schedule");
  bindAppMode("bnIdeas", "ideas");
  bindAppMode("topNavFuture", "daily-future");
  bindAppMode("topNavHistory", "daily-history");
  bindAppMode("topNavDailyMaster", "daily-master");
  bindAppMode("topNavTiming", "timing");
  document.getElementById("bnHome")?.addEventListener("click", () => setAppMode(homeTabToMode()));
  document.getElementById("homeTabLunch")?.addEventListener("click", () => setHomeTab("lunch"));
  document.getElementById("homeTabPantry")?.addEventListener("click", () => setHomeTab("pantry"));

  document.querySelectorAll(".lunch-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-lunch-tab");
      if (t) {
        setLunchPlannerTab(t);
        render();
        queueMicrotask(() => {
          document.querySelector(".lunch-tab.active")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
        });
      }
    });
  });

  document.getElementById("lunchWeekPrev")?.addEventListener("click", () => {
    lunchBrowseWeekStart = addDaysToDateKey(lunchBrowseWeekStart, -7);
    render();
  });
  document.getElementById("lunchWeekNext")?.addEventListener("click", () => {
    lunchBrowseWeekStart = addDaysToDateKey(lunchBrowseWeekStart, 7);
    render();
  });
  document.getElementById("lunchWeekThis")?.addEventListener("click", () => {
    lunchBrowseWeekStart = weekStartKeyFromDateKey(localDateKey());
    render();
  });

  document.getElementById("viewLunchPlanner")?.addEventListener("click", (e) => {
    const recipeBtn = e.target.closest("[data-action='lunch-recipe']");
    if (recipeBtn?.dataset.dishId) {
      openLunchRecipeDialog(recipeBtn.dataset.dishId);
      return;
    }
    const editStock = e.target.closest("[data-action='lunch-edit-stock']");
    if (editStock?.dataset.cat && editStock?.dataset.itemId) {
      openLunchTextEditDialog({
        kind: "stock",
        heading: `עריכה — ${stockCategoryLabel(lunchPlanner, editStock.dataset.cat)}`,
        value: editStock.dataset.name ?? "",
        stockCat: editStock.dataset.cat,
        stockItemId: editStock.dataset.itemId,
      });
      return;
    }
    const editDish = e.target.closest("[data-action='lunch-edit-dish']");
    if (editDish?.dataset.dishId) {
      const dish = findDish(lunchPlanner, editDish.dataset.dishId);
      const parts = dishParts(dish);
      openLunchTextEditDialog({
        kind: "dish",
        heading: parts.length > 1 ? "עריכת ארוחה (שורה לכל רכיב)" : "עריכת מנה",
        value: parts.join("\n"),
        dishId: editDish.dataset.dishId,
      });
      return;
    }
    const editPlan = e.target.closest("[data-action='lunch-edit-plan']");
    if (editPlan?.dataset.dateKey && editPlan?.dataset.entryId) {
      const entries = planEntriesForDay(lunchPlanner, lunchBrowseWeekStart, editPlan.dataset.dateKey);
      const ent = entries.find((e) => e.id === editPlan.dataset.entryId);
      const parts = planEntryMealParts(lunchPlanner, ent);
      openLunchTextEditDialog({
        kind: "plan",
        heading: "עריכת ארוחה ליום (שורה לכל רכיב)",
        value: parts.join("\n"),
        planDateKey: editPlan.dataset.dateKey,
        planEntryId: editPlan.dataset.entryId,
      });
      return;
    }
    const remPlan = e.target.closest("[data-action='lunch-remove-plan']");
    if (remPlan?.dataset.dateKey && remPlan?.dataset.entryId) {
      removePlanEntry(lunchPlanner, lunchBrowseWeekStart, remPlan.dataset.dateKey, remPlan.dataset.entryId);
      persistLunchPlanner();
      render();
      return;
    }
    const remStock = e.target.closest("[data-action='lunch-remove-stock']");
    if (remStock?.dataset.cat && remStock?.dataset.itemId) {
      removeHomeStockItem(lunchPlanner, remStock.dataset.cat, remStock.dataset.itemId);
      persistLunchPlanner();
      render();
      return;
    }
    const delDish = e.target.closest("[data-action='lunch-delete-dish']");
    if (delDish?.dataset.dishId) {
      const dish = findDish(lunchPlanner, delDish.dataset.dishId);
      if (!dish) return;
      if (!confirm(`למחוק את «${dish.name}» מ«מנות שלי»?\n\nהארוחות שכבר בתכנון השבוע יישארו (ללא קישור לרשימה).`)) return;
      deleteDish(lunchPlanner, delDish.dataset.dishId);
      persistLunchPlanner();
      render();
      return;
    }
    const openCompose = e.target.closest("[data-action='lunch-open-compose']");
    if (openCompose?.dataset.dateKey) {
      openLunchComposeDialog(openCompose.dataset.dateKey);
      return;
    }
  });

  document.getElementById("viewLunchPlanner")?.addEventListener("submit", (e) => {
    const newCatForm = e.target.closest("form.lunch-stock-new-cat");
    if (newCatForm instanceof HTMLFormElement) {
      e.preventDefault();
      const inp = newCatForm.querySelector("input");
      const label = inp instanceof HTMLInputElement ? inp.value.trim() : "";
      if (!label) return;
      const res = addStockCategory(lunchPlanner, label);
      if (!res) return;
      persistLunchPlanner();
      if (inp instanceof HTMLInputElement) inp.value = "";
      render();
      toast(res.created ? "קטגוריה נוספה." : "קטגוריה כבר קיימת.");
      return;
    }
    const stockForm = e.target.closest("form.lunch-stock-add");
    if (stockForm instanceof HTMLFormElement) {
      e.preventDefault();
      const cat = stockForm.dataset.stockCat;
      const inp = stockForm.querySelector("input");
      const name = inp instanceof HTMLInputElement ? inp.value.trim() : "";
      if (!cat || !name) return;
      if (addHomeStockItem(lunchPlanner, cat, uid("lstk"), name)) {
        persistLunchPlanner();
        if (inp instanceof HTMLInputElement) inp.value = "";
        render();
      } else toast("כבר קיים ברשימה.");
    }
  });

  document.getElementById("lunchComposeAddBtn")?.addEventListener("click", () => {
    const dlg = lunchComposeDialogEl();
    const dateKey = dlg instanceof HTMLDialogElement ? dlg.dataset.composeDateKey : "";
    if (!dateKey) return;
    applyLunchDraftAdd(dateKey, lunchComposeDialogRoot());
  });
  document.getElementById("lunchComposeNewCatBtn")?.addEventListener("click", () => {
    const compose = lunchComposeDialogRoot();
    const newInp = compose?.querySelector("#lunchComposeNewCatName");
    const label = newInp instanceof HTMLInputElement ? newInp.value.trim() : "";
    if (!label) {
      toast("שם קטגוריה.");
      return;
    }
    const res = addStockCategory(lunchPlanner, label);
    if (!res) return;
    persistLunchPlanner();
    renderLunchComposeStockCatSelect(res.id);
    if (newInp instanceof HTMLInputElement) newInp.value = "";
    const dlg = lunchComposeDialogEl();
    const dateKey = dlg instanceof HTMLDialogElement ? dlg.dataset.composeDateKey : "";
    if (dateKey) {
      const picker = document.getElementById("lunchComposePicker");
      if (picker) picker.innerHTML = renderLunchDayPickerHtml(dateKey);
    }
    toast(res.created ? "קטגוריה נוספה." : "נבחרה קטגוריה קיימת.");
  });
  document.getElementById("lunchComposeFreeText")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    document.getElementById("lunchComposeAddBtn")?.click();
  });
  document.getElementById("lunchComposeSaveBtn")?.addEventListener("click", () => saveLunchComposeDialog());
  document.getElementById("lunchComposeCancelBtn")?.addEventListener("click", () => {
    const dlg = lunchComposeDialogEl();
    if (dlg instanceof HTMLDialogElement) dlg.close();
  });
  document.getElementById("lunchComposeDialog")?.addEventListener("click", (e) => {
    const draftRemove = e.target.closest("[data-action='lunch-draft-remove']");
    if (draftRemove?.dataset.dateKey != null && draftRemove?.dataset.partIndex != null) {
      lunchDraftRemovePart(draftRemove.dataset.dateKey, Number(draftRemove.dataset.partIndex));
      refreshLunchComposeDialogTray(draftRemove.dataset.dateKey);
    }
  });

  document.getElementById("lunchRecipeSave")?.addEventListener("click", () => {
    const dlg = document.getElementById("lunchRecipeDialog");
    if (!(dlg instanceof HTMLDialogElement)) return;
    const dishId = dlg.dataset.dishId;
    const title = document.getElementById("lunchRecipeTitle")?.value?.trim();
    const body = document.getElementById("lunchRecipeBody")?.value ?? "";
    if (!dishId || !title) {
      toast("נא שם למתכון.");
      return;
    }
    upsertRecipeForDish(lunchPlanner, uid("lrec"), dishId, title, body);
    persistLunchPlanner();
    dlg.close();
    toast("מתכון נשמר.");
    render();
  });

  document.getElementById("lunchRecipeDelete")?.addEventListener("click", () => {
    const dlg = document.getElementById("lunchRecipeDialog");
    if (!(dlg instanceof HTMLDialogElement)) return;
    const dishId = dlg.dataset.dishId;
    const rec = dishId ? getRecipeForDish(lunchPlanner, dishId) : null;
    if (!rec) return;
    if (!confirm("למחוק את המתכון?")) return;
    deleteRecipe(lunchPlanner, rec.id);
    persistLunchPlanner();
    dlg.close();
    render();
  });

  document.getElementById("lunchTextEditSave")?.addEventListener("click", () => saveLunchTextEditDialog());
  document.getElementById("lunchTextEditInput")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      saveLunchTextEditDialog();
    }
  });

  initHourlyTimeSelects();
  document.getElementById("hourlyPushEnableBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    void runEnableHourlyPushFromClick();
  });
  document.getElementById("hourlyAddHasTime")?.addEventListener("change", () => {
    syncHourlyTimeRow("hourlyAddHasTime", "hourlyAddTimeRow", "hourlyScheduleStart");
  });
  document.getElementById("hourlyEditHasTime")?.addEventListener("change", () => {
    const dlg = document.getElementById("hourlyScheduleEditDialog");
    const dateKey = dlg?.dataset?.editDateKey;
    const blockId = dlg?.dataset?.editBlockId;
    const blk = dateKey && blockId ? hourlySchedule.days[dateKey]?.blocks?.find((x) => x.id === blockId) : null;
    syncHourlyTimeRow(
      "hourlyEditHasTime",
      "hourlyEditTimeRow",
      "hourlyScheduleEditStart",
      blockHasTime(blk) ? blk.startMin : nearbyHourlyDefaultStart(),
    );
  });
  document.getElementById("hourlyScheduleDayPrev")?.addEventListener("click", () => shiftHourlyBrowse(-1));
  document.getElementById("hourlyScheduleDayNext")?.addEventListener("click", () => shiftHourlyBrowse(1));
  document.getElementById("hourlyScheduleJumpToday")?.addEventListener("click", () => {
    hourlyBrowseDateKey = localDateKey();
    render();
  });
  document.getElementById("hourlyScheduleDateInput")?.addEventListener("change", (e) => {
    const v = e.target instanceof HTMLInputElement ? e.target.value : "";
    if (v) setHourlyBrowseDateKey(v);
  });

  document.getElementById("hourlyScheduleAddForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = document.getElementById("hourlyScheduleTitle")?.value?.trim();
    if (!title) {
      toast("נא למלא משימה.");
      return;
    }
    const withTime = !!document.getElementById("hourlyAddHasTime")?.checked;
    const startMin = withTime ? getHourlyHmPair("hourlyScheduleStart") : null;
    if (withTime && startMin == null) {
      toast("נא לבחור שעה.");
      return;
    }
    addScheduleBlock(hourlySchedule, hourlyBrowseDateKey, uid("hs"), title, startMin);
    persistHourlySchedule();
    document.getElementById("hourlyScheduleTitle").value = "";
    toast("נוסף ללו״ז.");
    render();
  });

  document.getElementById("hourlyScheduleList")?.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "checkbox") return;
    const action = t.getAttribute("data-action");
    const dk = t.getAttribute("data-date-key");
    const id = t.getAttribute("data-block-id");
    if (action === "hourly-toggle-done" && dk && id) {
      toggleScheduleBlockDone(hourlySchedule, dk, id);
      persistHourlySchedule();
      render();
      return;
    }
    const subId = t.getAttribute("data-sub-id");
    if (action === "hourly-toggle-sub" && dk && id && subId) {
      toggleScheduleSubDone(hourlySchedule, dk, id, subId);
      persistHourlySchedule();
      render();
    }
  });

  document.getElementById("hourlyScheduleList")?.addEventListener("click", (e) => {
    const subDel = e.target.closest("[data-action='hourly-delete-sub']");
    if (subDel) {
      e.preventDefault();
      const dk = subDel.getAttribute("data-date-key");
      const id = subDel.getAttribute("data-block-id");
      const subId = subDel.getAttribute("data-sub-id");
      if (dk && id && subId) {
        deleteScheduleSub(hourlySchedule, dk, id, subId);
        persistHourlySchedule();
        render();
      }
      return;
    }
    const edit = e.target.closest("[data-action='hourly-edit-block']");
    if (edit) {
      openHourlyScheduleEditDialog(edit.dataset.dateKey, edit.dataset.blockId);
      return;
    }
    const del = e.target.closest("[data-action='hourly-delete-block']");
    if (del) {
      const dk = del.getAttribute("data-date-key");
      const id = del.getAttribute("data-block-id");
      if (!dk || !id) return;
      if (!confirm("למחוק את המשימה מהלו״ז?")) return;
      deleteScheduleBlock(hourlySchedule, dk, id);
      persistHourlySchedule();
      render();
    }
  });

  document.getElementById("hourlyScheduleList")?.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-action='hourly-add-sub']");
    if (!form) return;
    e.preventDefault();
    const dk = form.getAttribute("data-date-key");
    const id = form.getAttribute("data-block-id");
    const input = form.querySelector(".hourly-sub-input");
    const title = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (!dk || !id || !title) return;
    addScheduleSub(hourlySchedule, dk, id, uid("hss"), title);
    persistHourlySchedule();
    render();
  });

  document.getElementById("hourlyScheduleEditSave")?.addEventListener("click", () => {
    const dlg = document.getElementById("hourlyScheduleEditDialog");
    if (!(dlg instanceof HTMLDialogElement)) return;
    const dateKey = dlg.dataset.editDateKey;
    const blockId = dlg.dataset.editBlockId;
    const title = document.getElementById("hourlyScheduleEditTitle")?.value?.trim();
    const withTime = !!document.getElementById("hourlyEditHasTime")?.checked;
    const startMin = withTime ? getHourlyHmPair("hourlyScheduleEditStart") : null;
    const done = !!document.getElementById("hourlyScheduleEditDone")?.checked;
    if (!dateKey || !blockId || !title || (withTime && startMin == null)) {
      toast("נא למלא כותרת, ואם יש תזכורת — גם שעה.");
      return;
    }
    const ok = updateScheduleBlock(hourlySchedule, dateKey, blockId, {
      title,
      startMin,
      done,
    });
    if (!ok) {
      toast("לא נשמר — בדקי את הטקסט.");
      return;
    }
    persistHourlySchedule();
    dlg.close();
    render();
  });

  document.getElementById("hourlyScheduleEditDelete")?.addEventListener("click", () => {
    const dlg = document.getElementById("hourlyScheduleEditDialog");
    if (!(dlg instanceof HTMLDialogElement)) return;
    const dateKey = dlg.dataset.editDateKey;
    const blockId = dlg.dataset.editBlockId;
    if (!dateKey || !blockId) return;
    if (!confirm("למחוק את המשימה מהלו״ז?")) return;
    deleteScheduleBlock(hourlySchedule, dateKey, blockId);
    persistHourlySchedule();
    dlg.close();
    render();
  });

  document.getElementById("hourlyScheduleEditTitle")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      document.getElementById("hourlyScheduleEditSave")?.click();
    }
  });

  document.getElementById("pantryFilterBar")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pantry-filter]");
    if (!b) return;
    const f = b.getAttribute("data-pantry-filter");
    if (f) {
      pantryLocFilter = f;
      render();
    }
  });

  wirePantryNameSuggest();

  document.getElementById("pantryListSearch")?.addEventListener("input", (e) => {
    pantryListSearchQuery = e.target instanceof HTMLInputElement ? e.target.value : "";
    render();
  });

  document.getElementById("pantryAddForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("pantryNewName")?.value?.trim();
    const loc = document.getElementById("pantryNewLoc")?.value ?? "pantry";
    const qtyRaw = document.getElementById("pantryNewQty")?.value ?? "1";
    const unit = document.getElementById("pantryNewUnit")?.value?.trim() || "יח׳";
    if (!name) {
      toast("נא להזין שם מוצר.");
      return;
    }
    const qty = Number(String(qtyRaw).replace(",", "."));
    if (!Number.isFinite(qty) || qty < 0) {
      toast("כמות לא תקינה.");
      return;
    }
    addPantryItem(pantryState, { name, location: loc, quantity: qty, unit });
    const nameInp = document.getElementById("pantryNewName");
    const qtyInp = document.getElementById("pantryNewQty");
    if (nameInp) nameInp.value = "";
    if (qtyInp) qtyInp.value = "1";
    toast("נוסף למלאי.");
    render();
  });

  document.getElementById("pantryEditSave")?.addEventListener("click", () => {
    const dlg = document.getElementById("pantryEditDialog");
    const id = dlg?.dataset.itemId;
    if (!id) return;
    const name = document.getElementById("pantryEditName")?.value?.trim();
    const loc = document.getElementById("pantryEditLoc")?.value;
    const qtyRaw = document.getElementById("pantryEditQty")?.value ?? "0";
    const unit = document.getElementById("pantryEditUnit")?.value?.trim() || "יח׳";
    if (!name) {
      toast("נא להזין שם.");
      return;
    }
    const qty = Number(String(qtyRaw).replace(",", "."));
    if (!Number.isFinite(qty) || qty < 0) {
      toast("כמות לא תקינה.");
      return;
    }
    updatePantryItem(pantryState, id, { name, location: loc, quantity: qty, unit });
    if (dlg instanceof HTMLDialogElement) dlg.close();
    toast("עודכן.");
    render();
  });

  document.getElementById("dailyMasterExportPdf")?.addEventListener("click", () => openDailyMasterPdfExport());

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
    const subject = encodeURIComponent(`${APP_DISPLAY_NAME}: ${idea?.title || "רעיון"}`);
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
          <title>${escapeHtml(idea?.title || APP_DISPLAY_NAME)}</title>
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
      const kab = btn.closest("details.daily-kebab");
      if (kab) kab.open = false;
      if (timingState.active?.dateKey === dk && timingState.active?.itemId === id) {
        cancelActiveTimer(timingState);
      }
      deleteDayItem(dayJournal, dk, id);
      persistDayJournal();
      render();
      return;
    }

    if (action === "daily-place-collapse") {
      const dk = btn.getAttribute("data-date-key");
      const id = btn.getAttribute("data-item-id");
      if (!dk || !id) return;
      const it = findDayJournalItem(dk, id);
      if (!it || it.kind !== "place") return;
      if (it.collapsed) {
        delete it.collapsed;
      } else {
        it.collapsed = true;
      }
      persistDayJournal();
      render();
      return;
    }

    if (action === "daily-edit") {
      const dk = btn.getAttribute("data-date-key");
      const id = btn.getAttribute("data-item-id");
      if (!dk || !id) return;
      const kab = btn.closest("details.daily-kebab");
      if (kab) kab.open = false;
      openDailyEditDialog(dk, id);
      return;
    }

    if (action === "daily-timer") {
      const dk = btn.getAttribute("data-date-key");
      const id = btn.getAttribute("data-item-id");
      if (!dk || !id) return;
      const kab = btn.closest("details.daily-kebab");
      if (kab) kab.open = false;
      openDailyTimerDialog(dk, id);
      return;
    }

    if (action === "pantry-consume") {
      const id = btn.getAttribute("data-item-id");
      if (!id) return;
      consumePantry(pantryState, id, 1);
      render();
      toast("עודכן במלאי.");
      return;
    }

    if (action === "pantry-restock") {
      const id = btn.getAttribute("data-item-id");
      if (!id) return;
      restockPantry(pantryState, id, 1);
      render();
      toast("נוספה יחידה.");
      return;
    }

    if (action === "pantry-edit") {
      const id = btn.getAttribute("data-item-id");
      if (!id) return;
      openPantryEditDialog(id);
      return;
    }

    if (action === "pantry-delete") {
      const id = btn.getAttribute("data-item-id");
      if (!id) return;
      const it = pantryState.items.find((x) => x.id === id);
      const ok = confirm(`להסיר את «${it?.name ?? "הפריט"}» מהמלאי?`);
      if (!ok) return;
      deletePantryItem(pantryState, id);
      render();
      toast("הוסר מהרשימה.");
      return;
    }

    if (action === "pantry-stock-filter") {
      const f = btn.getAttribute("data-filter");
      if (f === "all" || f === "in_stock" || f === "out" || f === "low") {
        pantryStockFilter = f;
        const kab = btn.closest("details.daily-kebab");
        if (kab) kab.open = false;
        render();
      }
      return;
    }

    if (action === "pantry-max-cap") {
      const c = btn.getAttribute("data-cap");
      pantryMaxQtyCap = c === "none" || c == null || c === "" ? null : Number(c);
      if (pantryMaxQtyCap != null && !Number.isFinite(pantryMaxQtyCap)) pantryMaxQtyCap = null;
      const kab = btn.closest("details.daily-kebab");
      if (kab) kab.open = false;
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
      persistDayJournal();
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
    }
  });

  document.getElementById("dailyTodayKind")?.addEventListener("change", () => {
    syncDailyTodayFormPlaceSelect(dailyBrowseDateKey);
  });
  document.getElementById("dailyTodayAddPlaceBtn")?.addEventListener("click", () => {
    const kindEl = document.getElementById("dailyTodayKind");
    if (!kindEl) return;
    kindEl.value = kindEl.value === "place" ? "task" : "place";
    syncDailyTodayFormPlaceSelect(dailyBrowseDateKey);
    document.getElementById("dailyTodayInput")?.focus();
  });

  document.getElementById("dailyTodayForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("dailyTodayInput");
    const t = String(input?.value ?? "").trim();
    if (!t) return;
    const kind = document.getElementById("dailyTodayKind")?.value === "place" ? "place" : "task";
    const underRaw = document.getElementById("dailyTodayUnderPlace")?.value ?? "";
    const newId = uid("ditem");
    if (kind === "place") {
      addDayItem(dayJournal, dailyBrowseDateKey, newId, t, { kind: "place" });
      persistDayJournal();
      input.value = "";
      const kindEl = document.getElementById("dailyTodayKind");
      if (kindEl) kindEl.value = "task";
      const form = document.getElementById("dailyTodayForm");
      if (form) form.dataset.selectPlaceAfterRender = newId;
      toast("המקום נוסף. עכשיו באותה שורה: כתבי מה להביא — המקום כבר נבחר ברשימה האמצעית.");
      render();
      queueMicrotask(() => document.getElementById("dailyTodayInput")?.focus());
      return;
    }
    const opts = underRaw ? { parentId: underRaw } : {};
    addDayItem(dayJournal, dailyBrowseDateKey, newId, t, opts);
    persistDayJournal();
    input.value = "";
    render();
  });

  document.getElementById("dailyDayPrev")?.addEventListener("click", () => shiftDailyBrowse(-1));
  document.getElementById("dailyDayNext")?.addEventListener("click", () => shiftDailyBrowse(1));
  document.getElementById("dailyJumpToday")?.addEventListener("click", () => {
    dailyBrowseDateKey = localDateKey();
    render();
  });

  const swipeArea = document.getElementById("dailyTodaySwipeArea");
  if (swipeArea) {
    let sx = 0;
    let sy = 0;
    let st = 0;
    let moved = false;
    let skipSwipeGesture = false;
    swipeArea.addEventListener(
      "touchstart",
      (e) => {
        moved = false;
        skipSwipeGesture = false;
        if (e.touches.length !== 1) return;
        // לא חוסמים סוויפ על כל ה־labelים כדי שלא ירגיש “לא עובד”.
        // חוסמים רק כשמתחילים ממש על רכיב קלט/כפתור/לינק.
        const el = e.target?.closest?.("button, input, textarea, a, select");
        if (el) skipSwipeGesture = true;
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        st = Date.now();
      },
      { passive: true },
    );
    swipeArea.addEventListener(
      "touchmove",
      (e) => {
        if (skipSwipeGesture) return;
        if (e.touches.length !== 1) return;
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        const dx = x - sx;
        const dy = y - sy;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;

        // אם זה נראה כמו גלילה אנכית — מבטלים; אם זה נראה אופקי — נועלים לסוויפ.
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (absY > absX * 1.25) {
          skipSwipeGesture = true;
          return;
        }
        if (absX > absY * 1.05) {
          // כשזה אופקי ברור, מונעים מהדפדפן “למשוך” גלילה
          try {
            e.preventDefault();
          } catch {
            /* ignore */
          }
        }
      },
      { passive: false },
    );
    swipeArea.addEventListener(
      "touchend",
      (e) => {
        if (skipSwipeGesture) return;
        if (!moved) return;
        if (!e.changedTouches.length) return;
        const dt = Date.now() - st;
        if (dt > DAILY_SWIPE_MAX_MS) return;
        const x = e.changedTouches[0].clientX;
        const y = e.changedTouches[0].clientY;
        const dx = x - sx;
        const dy = y - sy;
        if (Math.abs(dx) < DAILY_SWIPE_MIN_PX) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
        // כיוון סוויפ: ימינה = יום אחרי, שמאלה = יום לפני
        if (dx < 0) shiftDailyBrowse(-1);
        else shiftDailyBrowse(1);
      },
      { passive: true },
    );
  }

  document.getElementById("dailyEditSave")?.addEventListener("click", () => {
    const dlg = document.getElementById("dailyEditDialog");
    const input = document.getElementById("dailyEditInput");
    const dk = dlg?.dataset.editDateKey;
    const id = dlg?.dataset.editItemId;
    const t = String(input?.value ?? "").trim();
    if (!dk || !id) return;
    if (!t) {
      toast("נא להזין טקסט למשימה.");
      return;
    }
    updateDayItemTitle(dayJournal, dk, id, t);
    persistDayJournal();
    dlg?.close();
    render();
  });

  document.getElementById("dailyEditInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("dailyEditSave")?.click();
    }
  });
}

function render() {
  maybeRollDailyJournalAtMidnight();

  const restoreLunchScroll = appMode === "lunch-planner";
  const lunchScrollY = restoreLunchScroll ? window.scrollY : 0;

  updateAppViewsVisibility();
  syncAppNavActive();
  document.body.classList.toggle("app-mode-ideas", appMode === "ideas");
  document.body.classList.toggle("app-mode-home", appMode === "lunch-planner" || appMode === "pantry");

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
  if (appMode === "daily-master") renderDailyMasterPage();
  if (appMode === "timing") renderDailyTimingPage();
  if (appMode === "pantry") renderPantryPage();
  if (appMode === "hourly-schedule") renderHourlySchedulePage();
  if (appMode === "lunch-planner") renderLunchPlannerPage();

  const timerDlg = document.getElementById("dailyTimerDialog");
  if (timerDlg instanceof HTMLDialogElement && timerDlg.open) syncDailyTimerDialogUI();

  applyMobileLayout();

  if (restoreLunchScroll) {
    queueMicrotask(() => {
      window.scrollTo(0, lunchScrollY);
    });
  }
}

async function boot() {
  ensureSelection();
  await setupCloudBackupListeners(() => refreshCloudBackupPanel());
  wireGlobalHandlers();

  setInterval(() => {
    if (localDateKey() !== lastKnownCalendarDayKey) render();
    tickLocalHourlyReminders(hourlySchedule);
  }, 20_000);
  tickLocalHourlyReminders(hourlySchedule);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      render();
      tickLocalHourlyReminders(hourlySchedule);
    }
  });

  persistAndRender();
}

boot().catch((err) => {
  console.error(err);
  ensureSelection();
  wireGlobalHandlers();
  persistAndRender();
});

