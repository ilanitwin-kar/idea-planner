/** לוג מדידות זמן — קטלוג משימות (ניקיון וכו') + היסטוריה וממוצע */

export const TIMING_LOG_KEY = "idea-planner:daily-timing-log:v1";

export const DEFAULT_CHORES = [
  {
    id: "chore_salon",
    title: "ניקיון סלון",
    subs: [
      { id: "dust", title: "אבק ולסדר" },
      { id: "sofas", title: "לשאוב ספות ושטיחים" },
      { id: "floor", title: "רצפה" },
      { id: "putback", title: "להחזיר הכל למקום" },
    ],
  },
  {
    id: "chore_bath",
    title: "שירותים",
    subs: [],
  },
  {
    id: "chore_kitchen",
    title: "מטבח",
    subs: [
      { id: "sink", title: "כלים וכיור" },
      { id: "counters", title: "משטחים" },
      { id: "floor", title: "רצפה" },
      { id: "stove", title: "כיריים / תנור" },
    ],
  },
  {
    id: "chore_bedroom",
    title: "חדר שינה",
    subs: [
      { id: "bed", title: "מיטה" },
      { id: "dust", title: "אבק" },
      { id: "floor", title: "רצפה" },
      { id: "clothes", title: "להחזיר בגדים" },
    ],
  },
];

export function defaultTimingState() {
  return { entries: [], active: null, chores: cloneChores(DEFAULT_CHORES) };
}

function cloneChores(list) {
  return (list ?? []).map((c) => ({
    id: String(c.id),
    title: String(c.title ?? "").trim() || "משימה",
    subs: Array.isArray(c.subs)
      ? c.subs
          .map((s) => ({
            id: String(s.id),
            title: String(s.title ?? "").trim(),
          }))
          .filter((s) => s.id && s.title)
      : [],
  }));
}

function validEntry(e) {
  return (
    e &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    typeof e.title === "string" &&
    typeof e.dateKey === "string" &&
    typeof e.itemId === "string" &&
    typeof e.startedAt === "string" &&
    typeof e.endedAt === "string" &&
    typeof e.durationMinutes === "number" &&
    !Number.isNaN(e.durationMinutes)
  );
}

function sanitizeActive(a) {
  if (!a || typeof a !== "object") return null;
  if (!a.startedAt || !a.dateKey || !a.itemId) return null;
  return {
    dateKey: String(a.dateKey),
    itemId: String(a.itemId),
    title: String(a.title ?? "").trim() || "משימה",
    startedAt: String(a.startedAt),
  };
}

export function loadTimingState() {
  try {
    const raw = localStorage.getItem(TIMING_LOG_KEY);
    if (!raw) {
      const fresh = defaultTimingState();
      saveTimingState(fresh);
      return fresh;
    }
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object") return defaultTimingState();
    const entries = Array.isArray(p.entries) ? p.entries.filter(validEntry) : [];
    const active = sanitizeActive(p.active);
    if (!Array.isArray(p.chores) || p.chores.length === 0) {
      const migrated = { entries, active, chores: cloneChores(DEFAULT_CHORES) };
      saveTimingState(migrated);
      return migrated;
    }
    return { entries, active, chores: cloneChores(p.chores) };
  } catch {
    return defaultTimingState();
  }
}

let afterTimingPersist = null;
/** @param {null | (() => void)} cb */
export function setAfterTimingPersist(cb) {
  afterTimingPersist = typeof cb === "function" ? cb : null;
}

export function saveTimingState(state) {
  try {
    localStorage.setItem(TIMING_LOG_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  try {
    afterTimingPersist?.();
  } catch {
    /* ignore */
  }
}

function uidTiming(prefix = "tlog") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

export function choreItemId(choreId, subId = null) {
  const c = String(choreId || "");
  const s = String(subId || "").trim();
  return s ? `chore:${c}:${s}` : `chore:${c}`;
}

export function findChore(state, choreId) {
  return (state.chores ?? []).find((c) => c.id === choreId) ?? null;
}

export function findChoreSub(state, choreId, subId) {
  const c = findChore(state, choreId);
  if (!c || !subId) return null;
  return (c.subs ?? []).find((s) => s.id === subId) ?? null;
}

export function choreLabel(state, choreId, subId = null) {
  const c = findChore(state, choreId);
  if (!c) return "משימה";
  if (!subId) return c.title;
  const s = findChoreSub(state, choreId, subId);
  return s ? `${c.title} · ${s.title}` : c.title;
}

export function addChore(state, id, title) {
  const t = String(title ?? "").trim();
  if (!t) return false;
  if (!Array.isArray(state.chores)) state.chores = [];
  state.chores.push({ id, title: t, subs: [] });
  saveTimingState(state);
  return true;
}

export function addChoreSub(state, choreId, subId, title) {
  const c = findChore(state, choreId);
  if (!c) return false;
  const t = String(title ?? "").trim();
  if (!t) return false;
  if (!Array.isArray(c.subs)) c.subs = [];
  c.subs.push({ id: subId, title: t });
  saveTimingState(state);
  return true;
}

export function deleteChore(state, choreId) {
  state.chores = (state.chores ?? []).filter((c) => c.id !== choreId);
  if (state.active?.itemId?.startsWith(`chore:${choreId}`)) state.active = null;
  saveTimingState(state);
}

export function deleteChoreSub(state, choreId, subId) {
  const c = findChore(state, choreId);
  if (!c) return;
  c.subs = (c.subs ?? []).filter((s) => s.id !== subId);
  if (state.active?.itemId === choreItemId(choreId, subId)) state.active = null;
  saveTimingState(state);
}

export function startDayItemTimer(state, { dateKey, itemId, title }) {
  const t = String(title ?? "").trim() || "משימה";
  state.active = { dateKey, itemId, title: t, startedAt: new Date().toISOString() };
  saveTimingState(state);
}

export function stopDayItemTimer(state) {
  if (!state.active?.startedAt) return null;
  const end = new Date();
  const start = new Date(state.active.startedAt);
  if (Number.isNaN(start.getTime())) {
    state.active = null;
    saveTimingState(state);
    return null;
  }
  const diffMs = Math.max(0, end.getTime() - start.getTime());
  const durationMinutes = Math.round((diffMs / 60000) * 10) / 10;
  const entry = {
    id: uidTiming(),
    title: state.active.title,
    dateKey: state.active.dateKey,
    itemId: state.active.itemId,
    startedAt: state.active.startedAt,
    endedAt: end.toISOString(),
    durationMinutes,
  };
  if (!Array.isArray(state.entries)) state.entries = [];
  state.entries.unshift(entry);
  state.active = null;
  saveTimingState(state);
  return entry;
}

export function cancelActiveTimer(state) {
  state.active = null;
  saveTimingState(state);
}

export function timersMatch(state, dateKey, itemId) {
  return !!(state.active && state.active.dateKey === dateKey && state.active.itemId === itemId);
}

export function entriesForItem(state, itemId) {
  return (state.entries ?? []).filter((e) => e.itemId === itemId);
}

export function statsForItem(state, itemId) {
  const list = entriesForItem(state, itemId);
  if (!list.length) return { count: 0, lastMinutes: null, avgMinutes: null, lastDateKey: null };
  const last = list[0];
  const sum = list.reduce((a, e) => a + Number(e.durationMinutes || 0), 0);
  const avg = Math.round((sum / list.length) * 10) / 10;
  return {
    count: list.length,
    lastMinutes: last.durationMinutes,
    avgMinutes: avg,
    lastDateKey: last.dateKey,
  };
}

/** סכום ממוצעי התתי־משימות — כמה בערך לוקח כל החדר */
export function estimatedParentMinutes(state, chore) {
  const subs = chore?.subs ?? [];
  if (!subs.length) return statsForItem(state, choreItemId(chore.id));
  let sum = 0;
  let any = false;
  for (const s of subs) {
    const st = statsForItem(state, choreItemId(chore.id, s.id));
    if (st.count) {
      sum += st.avgMinutes;
      any = true;
    }
  }
  if (!any) return { count: 0, avgMinutes: null, lastMinutes: null, lastDateKey: null };
  return { count: 1, avgMinutes: Math.round(sum * 10) / 10, lastMinutes: null, lastDateKey: null };
}

export function formatMinutesShort(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = Math.round(n * 10) / 10;
  return Number.isInteger(v) ? `${v}` : String(v);
}
