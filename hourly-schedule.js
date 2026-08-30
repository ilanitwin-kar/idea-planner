/** לו״ז יומי לפי שעות — נשמר מקומית לפי מפתח תאריך */

export const HOURLY_SCHEDULE_STORAGE_KEY = "idea-planner:hourly-schedule:v1";

export function loadHourlySchedule() {
  try {
    const raw = localStorage.getItem(HOURLY_SCHEDULE_STORAGE_KEY);
    if (!raw) return { days: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { days: {} };
    const days = parsed.days;
    if (!days || typeof days !== "object") return { days: {} };
    return { days: { ...days } };
  } catch {
    return { days: {} };
  }
}

export function saveHourlySchedule(state) {
  localStorage.setItem(HOURLY_SCHEDULE_STORAGE_KEY, JSON.stringify(state));
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

/** "HH:MM" → דקות מחצות */
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

export function addScheduleBlock(state, dateKey, id, title, startMin, endMin) {
  const day = ensureDay(state, dateKey);
  const start = clampMinutes(startMin);
  let end = clampMinutes(endMin);
  if (end <= start) end = Math.min(start + 60, 24 * 60 - 1);
  const t = String(title ?? "").trim();
  if (!t) return false;
  day.blocks.push({ id, title: t, startMin: start, endMin: end, done: false });
  day.blocks.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
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
  if ("startMin" in patch) blk.startMin = clampMinutes(patch.startMin);
  if ("endMin" in patch) blk.endMin = clampMinutes(patch.endMin);
  if (blk.endMin <= blk.startMin) blk.endMin = Math.min(blk.startMin + 60, 24 * 60 - 1);
  if ("done" in patch) blk.done = !!patch.done;
  day.blocks.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
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

export function blocksForDay(state, dateKey) {
  return [...(state.days[dateKey]?.blocks ?? [])].sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin,
  );
}

export function scheduleDayProgress(state, dateKey) {
  const blocks = state.days[dateKey]?.blocks ?? [];
  const done = blocks.filter((x) => x.done).length;
  return { total: blocks.length, done };
}

/** כל הבלוקים בכל הימים — לתזכורות */
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

/** חצות מקומית + דקות → epoch ms */
export function hourlyBlockFireAtMs(dateKey, startMin) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  dt.setMinutes(Number(startMin) || 0);
  const t = dt.getTime();
  return Number.isFinite(t) ? t : null;
}
