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
  return { entries: [], active: null, paused: [], chores: cloneChores(DEFAULT_CHORES) };
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

function sanitizeSession(a, { running }) {
  if (!a || typeof a !== "object") return null;
  if (!a.dateKey || !a.itemId) return null;
  const startedAt = a.startedAt ? String(a.startedAt) : "";
  if (running && !startedAt) return null;
  const accumulatedMs = Math.max(0, Number(a.accumulatedMs) || 0);
  return {
    dateKey: String(a.dateKey),
    itemId: String(a.itemId),
    title: String(a.title ?? "").trim() || "משימה",
    startedAt: running ? startedAt : null,
    accumulatedMs,
    firstStartedAt: String(a.firstStartedAt || a.startedAt || new Date().toISOString()),
  };
}

function sanitizePausedList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = sanitizeSession(raw, { running: false });
    if (!s || seen.has(s.itemId)) continue;
    seen.add(s.itemId);
    out.push(s);
  }
  return out;
}

export function sessionElapsedMs(session) {
  if (!session) return 0;
  let ms = Math.max(0, Number(session.accumulatedMs) || 0);
  if (session.startedAt) {
    const t0 = new Date(session.startedAt).getTime();
    if (!Number.isNaN(t0)) ms += Math.max(0, Date.now() - t0);
  }
  return ms;
}

export function findOpenSession(state, itemId) {
  if (state.active?.itemId === itemId) return state.active;
  return (state.paused ?? []).find((s) => s.itemId === itemId) ?? null;
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
    const active = sanitizeSession(p.active, { running: true });
    const paused = sanitizePausedList(p.paused);
    if (!Array.isArray(p.chores) || p.chores.length === 0) {
      const migrated = { entries, active, paused, chores: cloneChores(DEFAULT_CHORES) };
      saveTimingState(migrated);
      return migrated;
    }
    return { entries, active, paused, chores: cloneChores(p.chores) };
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

function dropOpenForItem(state, itemId) {
  if (state.active?.itemId === itemId) state.active = null;
  state.paused = (state.paused ?? []).filter((s) => s.itemId !== itemId);
}

export function deleteChore(state, choreId) {
  state.chores = (state.chores ?? []).filter((c) => c.id !== choreId);
  const prefix = `chore:${choreId}`;
  if (state.active?.itemId === prefix || state.active?.itemId?.startsWith(`${prefix}:`)) state.active = null;
  state.paused = (state.paused ?? []).filter(
    (s) => s.itemId !== prefix && !s.itemId.startsWith(`${prefix}:`),
  );
  saveTimingState(state);
}

export function deleteChoreSub(state, choreId, subId) {
  const c = findChore(state, choreId);
  if (!c) return;
  c.subs = (c.subs ?? []).filter((s) => s.id !== subId);
  dropOpenForItem(state, choreItemId(choreId, subId));
  saveTimingState(state);
}

function ensurePausedArray(state) {
  if (!Array.isArray(state.paused)) state.paused = [];
}

export function pauseActiveTimer(state) {
  if (!state.active) return null;
  const paused = {
    dateKey: state.active.dateKey,
    itemId: state.active.itemId,
    title: state.active.title,
    startedAt: null,
    accumulatedMs: sessionElapsedMs(state.active),
    firstStartedAt: state.active.firstStartedAt || state.active.startedAt,
  };
  ensurePausedArray(state);
  state.paused = state.paused.filter((s) => s.itemId !== paused.itemId);
  state.paused.unshift(paused);
  state.active = null;
  saveTimingState(state);
  return paused;
}

export function resumeTimer(state, itemId) {
  ensurePausedArray(state);
  const idx = state.paused.findIndex((s) => s.itemId === itemId);
  if (idx < 0) return false;
  if (state.active?.itemId && state.active.itemId !== itemId) pauseActiveTimer(state);
  const sess = state.paused.find((s) => s.itemId === itemId);
  if (!sess) return false;
  state.paused = state.paused.filter((s) => s.itemId !== itemId);
  sess.startedAt = new Date().toISOString();
  state.active = sess;
  saveTimingState(state);
  return true;
}

export function startDayItemTimer(state, { dateKey, itemId, title }) {
  if (state.active?.itemId === itemId) return;
  if ((state.paused ?? []).some((s) => s.itemId === itemId)) {
    resumeTimer(state, itemId);
    return;
  }
  if (state.active) pauseActiveTimer(state);
  const t = String(title ?? "").trim() || "משימה";
  const now = new Date().toISOString();
  state.active = {
    dateKey,
    itemId,
    title: t,
    startedAt: now,
    accumulatedMs: 0,
    firstStartedAt: now,
  };
  saveTimingState(state);
}

export function stopOpenTimer(state, itemId = null) {
  const targetId = itemId || state.active?.itemId;
  if (!targetId) return null;
  let sess = null;
  if (state.active?.itemId === targetId) {
    sess = state.active;
    state.active = null;
  } else {
    ensurePausedArray(state);
    const idx = state.paused.findIndex((s) => s.itemId === targetId);
    if (idx < 0) return null;
    sess = state.paused[idx];
    state.paused.splice(idx, 1);
  }
  const end = new Date();
  const durationMinutes = Math.round((sessionElapsedMs(sess) / 60000) * 10) / 10;
  const entry = {
    id: uidTiming(),
    title: sess.title,
    dateKey: sess.dateKey,
    itemId: sess.itemId,
    startedAt: sess.firstStartedAt || sess.startedAt || end.toISOString(),
    endedAt: end.toISOString(),
    durationMinutes,
  };
  if (!Array.isArray(state.entries)) state.entries = [];
  state.entries.unshift(entry);
  saveTimingState(state);
  return entry;
}

export function stopDayItemTimer(state) {
  return stopOpenTimer(state, state.active?.itemId || null);
}

export function cancelOpenTimer(state, itemId = null) {
  const targetId = itemId || state.active?.itemId;
  if (!targetId) return;
  dropOpenForItem(state, targetId);
  saveTimingState(state);
}

export function cancelActiveTimer(state) {
  cancelOpenTimer(state, state.active?.itemId || null);
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
