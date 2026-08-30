/** לו״ז יומי — רשימת משימות ליום, עם שעת התחלה אופציונלית ותתי־משימות */

export const HOURLY_SCHEDULE_STORAGE_KEY = "idea-planner:hourly-schedule:v1";
export const HOURLY_DIGEST_MIN = 10 * 60;

export function loadHourlySchedule() {
  try {
    const raw = localStorage.getItem(HOURLY_SCHEDULE_STORAGE_KEY);
    if (!raw) return { days: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { days: {} };
    const days = parsed.days;
    if (!days || typeof days !== "object") return { days: {} };
    const out = { days: {} };
    for (const [k, day] of Object.entries(days)) {
      const blocks = Array.isArray(day?.blocks) ? day.blocks.map(normalizeBlock).filter(Boolean) : [];
      if (blocks.length) out.days[k] = { blocks };
    }
    return out;
  } catch {
    return { days: {} };
  }
}

export function saveHourlySchedule(state) {
  localStorage.setItem(HOURLY_SCHEDULE_STORAGE_KEY, JSON.stringify(state));
}

function normalizeSub(s) {
  if (!s || typeof s !== "object" || !s.id) return null;
  const title = String(s.title ?? s.text ?? "").trim();
  if (!title) return null;
  return { id: String(s.id), title, done: !!s.done };
}

function normalizeBlock(b) {
  if (!b || typeof b !== "object" || !b.id) return null;
  const title = String(b.title ?? b.text ?? "").trim();
  if (!title) return null;
  const startRaw = b.startMin;
  const startMin = startRaw == null || startRaw === "" ? null : clampMinutes(startRaw);
  const subs = Array.isArray(b.subs) ? b.subs.map(normalizeSub).filter(Boolean) : [];
  return { id: String(b.id), title, startMin, done: !!b.done, subs };
}

function ensureDay(state, dateKey) {
  if (!state.days[dateKey]) state.days[dateKey] = { blocks: [] };
  const day = state.days[dateKey];
  if (!Array.isArray(day.blocks)) day.blocks = [];
  return day;
}

function clampMinutes(m) {
  const x = Number(m);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(24 * 60 - 1, Math.round(x)));
}

export function blockHasTime(blk) {
  return blk != null && Number.isFinite(blk.startMin);
}

export function timeStringToMinutes(hhmm) {
  const s = String(hhmm ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min < 0 || min > 59 || h < 0 || h > 23) return null;
  return h * 60 + min;
}

export function minutesToTimeString(totalMin) {
  const m = clampMinutes(totalMin);
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function formatMinutesHebrew(totalMin) {
  return minutesToTimeString(totalMin);
}

function sortBlocks(blocks) {
  return [...blocks].sort((a, b) => {
    const at = blockHasTime(a);
    const bt = blockHasTime(b);
    if (at && bt) return a.startMin - b.startMin;
    if (at && !bt) return -1;
    if (!at && bt) return 1;
    return 0;
  });
}

function resortDay(day) {
  day.blocks = sortBlocks(day.blocks);
}

export function addScheduleBlock(state, dateKey, id, title, startMin = null) {
  const day = ensureDay(state, dateKey);
  const t = String(title ?? "").trim();
  if (!t) return false;
  const start = startMin == null || startMin === "" ? null : clampMinutes(startMin);
  day.blocks.push({ id, title: t, startMin: start, done: false, subs: [] });
  resortDay(day);
  return true;
}

export function updateScheduleBlock(state, dateKey, blockId, patch) {
  const day = state.days[dateKey];
  if (!day?.blocks) return false;
  const blk = day.blocks.find((x) => x.id === blockId);
  if (!blk) return false;
  if ("title" in patch) {
    const t = String(patch.title ?? "").trim();
    if (!t) return false;
    blk.title = t;
  }
  if ("startMin" in patch) {
    blk.startMin = patch.startMin == null || patch.startMin === "" ? null : clampMinutes(patch.startMin);
  }
  if ("done" in patch) blk.done = !!patch.done;
  if (!Array.isArray(blk.subs)) blk.subs = [];
  resortDay(day);
  return true;
}

export function deleteScheduleBlock(state, dateKey, blockId) {
  const day = state.days[dateKey];
  if (!day?.blocks) return;
  day.blocks = day.blocks.filter((x) => x.id !== blockId);
  if (day.blocks.length === 0) delete state.days[dateKey];
}

export function toggleScheduleBlockDone(state, dateKey, blockId) {
  const day = state.days[dateKey];
  const blk = day?.blocks?.find((x) => x.id === blockId);
  if (!blk) return;
  blk.done = !blk.done;
}

export function addScheduleSub(state, dateKey, blockId, subId, title) {
  const blk = state.days[dateKey]?.blocks?.find((x) => x.id === blockId);
  if (!blk) return false;
  const t = String(title ?? "").trim();
  if (!t) return false;
  if (!Array.isArray(blk.subs)) blk.subs = [];
  blk.subs.push({ id: subId, title: t, done: false });
  return true;
}

export function toggleScheduleSubDone(state, dateKey, blockId, subId) {
  const sub = state.days[dateKey]?.blocks?.find((x) => x.id === blockId)?.subs?.find((s) => s.id === subId);
  if (!sub) return;
  sub.done = !sub.done;
}

export function deleteScheduleSub(state, dateKey, blockId, subId) {
  const blk = state.days[dateKey]?.blocks?.find((x) => x.id === blockId);
  if (!blk?.subs) return;
  blk.subs = blk.subs.filter((s) => s.id !== subId);
}

export function blocksForDay(state, dateKey) {
  return sortBlocks(state.days[dateKey]?.blocks ?? []);
}

export function scheduleDayProgress(state, dateKey) {
  const blocks = state.days[dateKey]?.blocks ?? [];
  const done = blocks.filter((x) => x.done).length;
  return { total: blocks.length, done };
}

export function collectAllScheduleBlocks(state) {
  const out = [];
  for (const [dateKey, day] of Object.entries(state?.days ?? {})) {
    for (const blk of day?.blocks ?? []) {
      if (!blk?.id) continue;
      out.push({ dateKey, block: blk });
    }
  }
  return out;
}

export function hourlyBlockFireAtMs(dateKey, startMin) {
  if (!Number.isFinite(startMin)) return null;
  const [y, m, d] = String(dateKey).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  dt.setMinutes(Number(startMin) || 0);
  const t = dt.getTime();
  return Number.isFinite(t) ? t : null;
}
