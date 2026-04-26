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

const APP_DISPLAY_NAME = "מרכז הרעיונות של אילנית";

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

const SETTINGS_KEY = "idea-planner:settings:v1";
let settings = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const x = raw ? JSON.parse(raw) : null;
    return {
      defaultCalMode: x?.defaultCalMode === "day" || x?.defaultCalMode === "month" ? x.defaultCalMode : "week",
    };
  } catch {
    return { defaultCalMode: "week" };
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

const APP_MODE_KEY = "idea-planner:app-mode:v1";

function loadAppMode() {
  try {
    const v = localStorage.getItem(APP_MODE_KEY);
    if (
      v === "ideas" ||
      v === "daily-today" ||
      v === "today-tasks" ||
      v === "daily-future" ||
      v === "daily-history" ||
      v === "daily-master"
    )
      return v;
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

let appMode = loadAppMode();
let dayJournal = loadDayJournal();
let lastKnownCalendarDayKey = loadPersistedCalendarDay() ?? localDateKey();
/** יום שמוצג במסך «היום שלי» (מחלקה / כפתורים) */
let dailyBrowseDateKey = localDateKey();

const DAILY_SWIPE_MIN_PX = 42;
const DAILY_SWIPE_MAX_MS = 900;

function rollIncompleteDailyTasksFromTo(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey >= toKey) return;
  const day = dayJournal.days[fromKey];
  if (!day?.items?.length) return;
  const undone = day.items.filter((x) => !x.done);
  if (undone.length === 0) return;
  for (const it of undone) {
    const title = String(it.title ?? it.text ?? "").trim();
    if (!title) continue;
    addDayItem(dayJournal, toKey, uid("ditem"), title);
  }
  day.items = day.items.filter((x) => x.done);
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
  saveDayJournal(dayJournal);
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
      empty.innerHTML = `<div class="empty-text">אין תתי־משימות פתוחות עם תזמון. הוסיפי תתי־משימות ותאריכים במסך הרעיונות (לשונית משימות או לוח שנה).</div>`;
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
    empty.innerHTML = `<div class="empty-text">עדיין לא סימנת תתי־משימות כבוצע. כשתסמני V ב«עתידי» או במסך הרעיונות — הן יופיעו כאן.</div>`;
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
    ["today-tasks", "bnTodayTasks"],
    ["ideas", "tnIdeas"],
    ["ideas", "bnIdeas"],
    ["daily-future", "tnDailyFuture"],
    ["daily-future", "topNavFuture"],
    ["daily-history", "tnDailyHistory"],
    ["daily-history", "topNavHistory"],
    ["daily-master", "topNavDailyMaster"],
  ];
  for (const [m, id] of pairs) {
    document.getElementById(id)?.classList.toggle("active", appMode === m);
  }
}

function updateAppViewsVisibility() {
  document.getElementById("viewIdeas")?.classList.toggle("hidden", appMode !== "ideas");
  document.getElementById("viewDailyToday")?.classList.toggle("hidden", appMode !== "daily-today");
  document.getElementById("viewTodayTasks")?.classList.toggle("hidden", appMode !== "today-tasks");
  document.getElementById("viewDailyFuture")?.classList.toggle("hidden", appMode !== "daily-future");
  document.getElementById("viewDailyHistory")?.classList.toggle("hidden", appMode !== "daily-history");
  document.getElementById("viewDailyMaster")?.classList.toggle("hidden", appMode !== "daily-master");
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
      <div class="daily-item-actions">
        <button type="button" class="btn-daily-edit" data-action="daily-edit" data-date-key="${dateKey}" data-item-id="${it.id}" aria-label="עריכה">עריכה</button>
        <button type="button" class="btn-daily-del" data-action="daily-delete" data-date-key="${dateKey}" data-item-id="${it.id}" aria-label="מחיקה">×</button>
      </div>
    `;
    container.appendChild(row);
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

function renderDailyTodayPage() {
  const calendarToday = localDateKey();
  const viewKey = dailyBrowseDateKey;
  const titleEl = document.getElementById("dailyTodayTitle");
  const subEl = document.getElementById("dailyTodaySub");
  const progEl = document.getElementById("dailyTodayProgress");
  const jumpBtn = document.getElementById("dailyJumpToday");

  if (titleEl) titleEl.textContent = formatHebrewDateLabel(viewKey);
  if (subEl) subEl.textContent = "";
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

  renderDayItemsList(document.getElementById("dailyTodayList"), viewKey);
  const pr = dayProgress(dayJournal, viewKey);
  if (progEl) {
    if (!pr.total) {
      progEl.textContent =
        viewKey === calendarToday ? "אין עדיין משימות — אפשר להוסיף למעלה." : "אין משימות ביום הזה.";
    } else {
      progEl.textContent = `${pr.done}/${pr.total} הושלמו`;
    }
  }
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

function renderTodayTasksPage() {
  const todayK = localDateKey();
  const progEl = document.getElementById("todayTasksProgress");

  // Ideas subtasks scheduled today
  const ideasRoot = document.getElementById("todayTasksIdeasRoot");
  if (ideasRoot) {
    ideasRoot.innerHTML = "";
    const { tasks } = collectSubtasksForToday();
    if (tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty plan-empty";
      empty.innerHTML = `<div class="empty-text">אין תתי־משימות מתוזמנות להיום מתוך הרעיונות.</div>`;
      ideasRoot.appendChild(empty);
    } else {
      // one "date block" for today, grouped by task
      const wrap = document.createElement("section");
      wrap.className = "plan-date-block";
      wrap.innerHTML = `
        <div class="plan-date-heading">
          <span class="plan-date-title">${escapeHtml(formatHebrewDateLabel(todayK))}</span>
        </div>
        <div class="plan-date-body"></div>
      `;
      const body = wrap.querySelector(".plan-date-body");
      for (const task of tasks) {
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
  }

  // Daily journal tasks for today
  renderDayItemsList(document.getElementById("todayTasksDailyRoot"), todayK);

  if (progEl) {
    const ideaCount = collectSubtasksForToday().tasks.reduce((acc, t) => acc + (t.subs?.length ?? 0), 0);
    const dayPr = dayProgress(dayJournal, todayK);
    const dayCount = dayPr.total ?? 0;
    const doneToday = dayPr.done ?? 0;
    progEl.textContent = `מהרעיונות: ${ideaCount} • מהיום שלי: ${doneToday}/${dayCount} הושלמו`;
  }
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
    div.innerHTML = `<div class="empty-text">עדיין אין משימות ב«היום שלי». הוסיפי משימות שם — והן יופיעו כאן ממוספרות.</div>`;
    container.appendChild(div);
    if (progEl) progEl.textContent = "";
    return;
  }

  let doneC = 0;
  for (const { item } of rows) {
    if (item.done) doneC += 1;
  }
  const total = rows.length;

  let n = 0;
  for (const { dateKey, item } of rows) {
    n += 1;
    const label = dayItemLabel(item);
    const mark = item.done ? "✓" : "✗";
    const markClass = item.done ? "dm-mark dm-mark--done" : "dm-mark dm-mark--open";
    const dateLabel = formatShortHebrewDate(dateKey);
    const row = document.createElement("div");
    row.className = `dm-row ${item.done ? "dm-row--done" : ""}`;
    row.setAttribute("role", "listitem");
    row.innerHTML = `
      <span class="dm-num" aria-hidden="true">${n}.</span>
      <span class="${markClass}" title="${item.done ? "בוצע" : "לא בוצע"}" aria-hidden="true">${mark}</span>
      <label class="dm-main">
        <input type="checkbox" class="check" ${item.done ? "checked" : ""} data-action="daily-toggle" data-date-key="${escapeHtml(dateKey)}" data-item-id="${escapeHtml(String(item.id))}" aria-label="סימון ביצוע" />
        <span class="dm-title">${escapeHtml(label || "ללא טקסט")}</span>
      </label>
      <span class="dm-date">${escapeHtml(dateLabel)}</span>
    `;
    container.appendChild(row);
  }

  if (progEl) {
    progEl.textContent = `סה״כ ${total} • ${doneC} בוצעו • ${total - doneC} פתוחות`;
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
      const mark = r.item.done ? "✓" : "✗";
      const t = escapeHtml(dayItemLabel(r.item) || "—");
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
  w.document.write(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8"/><title>משימות יומיומיות</title>
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
<h1>משימות יומיומיות</h1>
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

function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2600);
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
    div.innerHTML = `<div class="empty-text">אין תתי־משימות עם תאריך/שעה להצגה.</div>`;
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
          <form class="add-row add-row--subtask" data-add-subtask-form="${task.id}" autocomplete="off">
            <input class="input" name="subtaskTitle" type="text" placeholder="תת־משימה חדשה…" maxlength="160" required />
            <label class="dt-label"><span class="dt-label-text">התחלה</span><input class="dt" name="subtaskStart" type="datetime-local" title="התחלה" /></label>
            <label class="dt-label"><span class="dt-label-text">סיום (רשות)</span><input class="dt" name="subtaskEnd" type="datetime-local" title="סיום (אופציונלי)" /></label>
            <button class="btn btn--subtask-add" type="submit">הוספת תת־משימה</button>
          </form>
          <div class="subtask-form-hint">אפשר למלא רק כותרת — התאריכים עוזרים ללוח השנה והתזכורות. לסיום לוחצים על הכפתור או Enter בשדה הטקסט.</div>
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

function wireGlobalHandlers() {
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

  const settingsBtn = document.getElementById("settingsBtn");
  const settingsDialog = document.getElementById("settingsDialog");
  const setDefaultCalMode = document.getElementById("setDefaultCalMode");
  const settingsSave = document.getElementById("settingsSave");

  if (settingsBtn && settingsDialog && setDefaultCalMode && settingsSave) {
    settingsBtn.addEventListener("click", () => {
      setDefaultCalMode.value = settings.defaultCalMode;
      settingsDialog.showModal();
    });

    settingsSave.addEventListener("click", () => {
      settings.defaultCalMode = String(setDefaultCalMode.value ?? "week");
      saveSettings();
      ui.calMode = settings.defaultCalMode;

      settingsDialog.close();
      toast("ההגדרות נשמרו.");
      persistAndRender();
    });
  }

  els.resetBtn.addEventListener("click", () => {
    const ok = confirm("למחוק את כל הנתונים? (רעיונות + יומן יומי — איפוס מלא)");
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(DAY_JOURNAL_STORAGE_KEY);
    localStorage.removeItem(LAST_CALENDAR_DAY_KEY);
    state = loadState();
    dayJournal = loadDayJournal();
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
  bindAppMode("tnDailyToday", "daily-today");
  bindAppMode("tnIdeas", "ideas");
  bindAppMode("tnDailyFuture", "daily-future");
  bindAppMode("tnDailyHistory", "daily-history");
  bindAppMode("bnDailyToday", "daily-today");
  bindAppMode("bnTodayTasks", "today-tasks");
  bindAppMode("bnIdeas", "ideas");
  bindAppMode("topNavFuture", "daily-future");
  bindAppMode("topNavHistory", "daily-history");
  bindAppMode("topNavDailyMaster", "daily-master");

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
      deleteDayItem(dayJournal, dk, id);
      saveDayJournal(dayJournal);
      render();
      return;
    }

    if (action === "daily-edit") {
      const dk = btn.getAttribute("data-date-key");
      const id = btn.getAttribute("data-item-id");
      if (!dk || !id) return;
      openDailyEditDialog(dk, id);
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
    }
  });

  document.getElementById("dailyTodayForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("dailyTodayInput");
    const t = String(input?.value ?? "").trim();
    if (!t) return;
    addDayItem(dayJournal, dailyBrowseDateKey, uid("ditem"), t);
    saveDayJournal(dayJournal);
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
    saveDayJournal(dayJournal);
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
  if (appMode === "today-tasks") renderTodayTasksPage();
  if (appMode === "daily-future") renderDailyFuturePage();
  if (appMode === "daily-history") renderDailyHistoryPage();
  if (appMode === "daily-master") renderDailyMasterPage();

  applyMobileLayout();
}

ensureSelection();
wireGlobalHandlers();

setInterval(() => {
  if (localDateKey() !== lastKnownCalendarDayKey) render();
}, 60_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});

persistAndRender();

