/** לוג מדידות זמן למשימות יומיות (מקומי) */

export const TIMING_LOG_KEY = "idea-planner:daily-timing-log:v1";

export function defaultTimingState() {
  return { entries: [], active: null };
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
    if (!raw) return defaultTimingState();
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object") return defaultTimingState();
    const entries = Array.isArray(p.entries) ? p.entries.filter(validEntry) : [];
    const active = sanitizeActive(p.active);
    return { entries, active };
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
