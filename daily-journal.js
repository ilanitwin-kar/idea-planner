/** יומן משימות יומי (מקומי) — מפתח תאריך לפי אזור הזמן המקומי */

export const DAY_JOURNAL_STORAGE_KEY = "idea-planner:day-journal:v1";

export function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function loadDayJournal() {
  try {
    const raw = localStorage.getItem(DAY_JOURNAL_STORAGE_KEY);
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

export function saveDayJournal(journal) {
  localStorage.setItem(DAY_JOURNAL_STORAGE_KEY, JSON.stringify(journal));
}

export function ensureDay(journal, dateKey) {
  if (!journal.days[dateKey]) journal.days[dateKey] = { items: [] };
  const day = journal.days[dateKey];
  if (!Array.isArray(day.items)) day.items = [];
  return day;
}

export function addDayItem(journal, dateKey, id, title) {
  const day = ensureDay(journal, dateKey);
  day.items.push({ id, title: String(title ?? "").trim(), done: false });
}

export function toggleDayItem(journal, dateKey, itemId) {
  const day = journal.days[dateKey];
  if (!day?.items) return;
  const it = day.items.find((x) => x.id === itemId);
  if (it) it.done = !it.done;
}

export function deleteDayItem(journal, dateKey, itemId) {
  const day = journal.days[dateKey];
  if (!day?.items) return;
  day.items = day.items.filter((x) => x.id !== itemId);
  if (day.items.length === 0) delete journal.days[dateKey];
}

/** תאריכים בעבר (לפני todayKey) שיש בהם פריטים, מהחדש לישן */
export function pastDayKeysWithItems(journal, todayKey) {
  const keys = Object.keys(journal.days).filter((k) => k < todayKey);
  const withItems = keys.filter((k) => (journal.days[k]?.items?.length ?? 0) > 0);
  withItems.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return withItems;
}

/** תאריכים בעתיד (אחרי todayKey) שיש בהם פריטים, מהקרוב לרחוק */
export function futureDayKeysWithItems(journal, todayKey) {
  const keys = Object.keys(journal.days).filter((k) => k > todayKey);
  const withItems = keys.filter((k) => (journal.days[k]?.items?.length ?? 0) > 0);
  withItems.sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  return withItems;
}

export function dayProgress(journal, dateKey) {
  const items = journal.days[dateKey]?.items ?? [];
  const done = items.filter((x) => x.done).length;
  return { total: items.length, done };
}
