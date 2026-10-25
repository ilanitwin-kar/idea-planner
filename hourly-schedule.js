/** לו״ז יומי — חלונות שעה, רשימת עסק, ותזכורות אופציונליות */

export const HOURLY_SCHEDULE_STORAGE_KEY = "idea-planner:hourly-schedule:v1";
export const HOURLY_DIGEST_MIN = 10 * 60;

/** עד 02:00 בלילה שאחרי (21:00–02:00), בדקות מתחילת יום התכנון */
export const HOURLY_MAX_MIN = 26 * 60;

export const DAY_WINDOWS = [
  {
    id: "morning",
    label: "בוקר בממלכה",
    sub: "עשייה שקטה — מה שבאמת צריך לזוז",
    from: "09:00",
    to: "12:00",
    kind: "focus",
    start: 9 * 60,
    end: 12 * 60,
    noteHint: "מה היום בבוקר: לימוד, מסמך, שיחה, רשימת עמודים…",
    addPlaceholder: "שורת עשייה לבוקר…",
  },
  {
    id: "midday",
    label: "צהריים בממלכה",
    sub: "המשך עשייה עד שתיים",
    from: "12:00",
    to: "14:00",
    kind: "focus",
    start: 12 * 60,
    end: 14 * 60,
    noteHint: "מה ממשיכים עד שתיים…",
    addPlaceholder: "שורת עשייה לצהריים…",
  },
  {
    id: "lunch",
    label: "צהריים בבית",
    sub: "אוכל, שנ״צ, מה שמכינים היום",
    from: "15:00",
    to: "18:00",
    kind: "life",
    start: 15 * 60,
    end: 18 * 60,
    noteHint: "מה מבשלים / מה אוכלים / מתי שנ״צ…",
    addPlaceholder: "מנה, קניות למטבח, תזכורת לשנ״צ…",
  },
  {
    id: "house",
    label: "הבית מלא",
    sub: "לא שקט — ועדיין יש מקום לרשום",
    from: "18:00",
    to: "21:00",
    kind: "life",
    start: 18 * 60,
    end: 21 * 60,
    noteHint: "מה קורה כשהבית מלא: סידור, ילדים, מה לא לשכוח…",
    addPlaceholder: "מה לזכור בערב…",
  },
  {
    id: "night",
    label: "לילה בממלכה",
    sub: "עשייה ארוכה — חוצה חצות",
    from: "21:00",
    to: "02:00",
    kind: "focus",
    start: 21 * 60,
    end: 26 * 60,
    noteHint: "מה בלילה: לימוד, עסק, רשימה ארוכה…",
    addPlaceholder: "שורת עשייה ללילה…",
  },
];

export const WORK_LANE = {
  id: "work",
  label: "עסק",
  sub: "רשימה חיה — עם וי, בלי שעה או עם שעה",
  noteHint: "הערות לעסק להיום — מה שצריך לראות במבט אחד.",
  addPlaceholder: "משימת עסק…",
};

const WINDOW_IDS = new Set(DAY_WINDOWS.map((w) => w.id));

export function loadHourlySchedule() {
  try {
    const raw = localStorage.getItem(HOURLY_SCHEDULE_STORAGE_KEY);
    if (!raw) return { days: {}, headings: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { days: {}, headings: {} };
    const days = parsed.days;
    if (!days || typeof days !== "object") return { days: {}, headings: normalizeHeadings(parsed.headings) };
    const out = { days: {}, headings: normalizeHeadings(parsed.headings) };
    for (const [k, day] of Object.entries(days)) {
      const blocks = Array.isArray(day?.blocks) ? day.blocks.map(normalizeBlock).filter(Boolean) : [];
      const windowNotes = normalizeWindowNotes(day?.windowNotes);
      if (blocks.length || Object.keys(windowNotes).length) out.days[k] = { blocks, windowNotes };
    }
    return out;
  } catch {
    return { days: {}, headings: {} };
  }
}

export function saveHourlySchedule(state) {
  localStorage.setItem(HOURLY_SCHEDULE_STORAGE_KEY, JSON.stringify(state));
}

function headingKeyOk(id) {
  return WINDOW_IDS.has(id) || id === "work";
}

function normalizeHeadings(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const key of [...WINDOW_IDS, "work"]) {
    const t = String(raw[key] ?? "").trim().slice(0, 200);
    if (t) out[key] = t;
  }
  return out;
}

function normalizeWindowNotes(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const key of [...WINDOW_IDS, "work"]) {
    const t = String(raw[key] ?? "").trim();
    if (t) out[key] = String(raw[key]).slice(0, 8000);
  }
  return out;
}

function normalizeSub(s) {
  if (!s || typeof s !== "object" || !s.id) return null;
  const title = String(s.title ?? s.text ?? "").trim();
  if (!title) return null;
  return { id: String(s.id), title, done: !!s.done };
}

function validSlot(id) {
  const s = String(id ?? "");
  return WINDOW_IDS.has(s) ? s : null;
}

function normalizeBlock(b) {
  if (!b || typeof b !== "object" || !b.id) return null;
  const title = String(b.title ?? b.text ?? "").trim();
  if (!title) return null;
  const startRaw = b.startMin;
  const startMin = startRaw == null || startRaw === "" ? null : clampMinutes(startRaw);
  const subs = Array.isArray(b.subs) ? b.subs.map(normalizeSub).filter(Boolean) : [];
  let slot = validSlot(b.slot);
  let lane = b.lane === "work" ? "work" : b.lane === "slot" ? "slot" : null;
  if (!lane) {
    if (slot) lane = "slot";
    else if (startMin == null) lane = "work";
    else {
      slot = windowIdForStartMin(startMin);
      lane = slot ? "slot" : "work";
    }
  }
  if (lane === "work") slot = null;
  if (lane === "slot" && !slot) {
    slot = startMin != null ? windowIdForStartMin(startMin) : null;
    if (!slot) lane = "work";
  }
  return { id: String(b.id), title, startMin, done: !!b.done, subs, lane, slot };
}

function ensureDay(state, dateKey) {
  if (!state.days[dateKey]) state.days[dateKey] = { blocks: [], windowNotes: {} };
  const day = state.days[dateKey];
  if (!Array.isArray(day.blocks)) day.blocks = [];
  if (!day.windowNotes || typeof day.windowNotes !== "object") day.windowNotes = {};
  return day;
}

function pruneDay(state, dateKey) {
  const day = state.days[dateKey];
  if (!day) return;
  const hasBlocks = Array.isArray(day.blocks) && day.blocks.length > 0;
  const hasNotes = day.windowNotes && Object.values(day.windowNotes).some((n) => String(n ?? "").trim());
  if (!hasBlocks && !hasNotes) delete state.days[dateKey];
}

function clampMinutes(m) {
  const x = Number(m);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(HOURLY_MAX_MIN, Math.round(x)));
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
  const x = Number(totalMin);
  if (!Number.isFinite(x)) return "00:00";
  const m = ((Math.round(x) % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function formatMinutesHebrew(totalMin) {
  return minutesToTimeString(totalMin);
}

export function windowIdForStartMin(startMin) {
  if (!Number.isFinite(startMin)) return null;
  const m = Number(startMin);
  if (m >= 0 && m < 2 * 60) return "night";
  for (const w of DAY_WINDOWS) {
    if (m >= w.start && m < w.end) return w.id;
  }
  return null;
}

export function getDayWindow(id) {
  return DAY_WINDOWS.find((w) => w.id === id) || null;
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

export function addScheduleBlock(state, dateKey, id, title, startMin = null, meta = null) {
  const day = ensureDay(state, dateKey);
  const t = String(title ?? "").trim();
  if (!t) return false;
  const start = startMin == null || startMin === "" ? null : clampMinutes(startMin);
  const lane = meta?.lane === "work" ? "work" : "slot";
  const slot = lane === "slot" ? validSlot(meta?.slot) : null;
  if (lane === "slot" && !slot) return false;
  day.blocks.push({
    id,
    title: t,
    startMin: start,
    done: false,
    subs: [],
    lane,
    slot,
  });
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
  if ("lane" in patch) blk.lane = patch.lane === "work" ? "work" : "slot";
  if ("slot" in patch) blk.slot = validSlot(patch.slot);
  if (blk.lane === "work") blk.slot = null;
  if (!Array.isArray(blk.subs)) blk.subs = [];
  resortDay(day);
  return true;
}

export function deleteScheduleBlock(state, dateKey, blockId) {
  const day = state.days[dateKey];
  if (!day?.blocks) return;
  day.blocks = day.blocks.filter((x) => x.id !== blockId);
  pruneDay(state, dateKey);
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

export function getWindowNote(state, dateKey, windowId) {
  return String(state.days[dateKey]?.windowNotes?.[windowId] ?? "");
}

export function setWindowNote(state, dateKey, windowId, text) {
  const key = WINDOW_IDS.has(windowId) || windowId === "work" ? windowId : null;
  if (!key) return;
  const day = ensureDay(state, dateKey);
  const t = String(text ?? "").slice(0, 8000);
  if (t.trim()) day.windowNotes[key] = t;
  else delete day.windowNotes[key];
  pruneDay(state, dateKey);
}

export function blocksForDay(state, dateKey) {
  return sortBlocks(state.days[dateKey]?.blocks ?? []);
}

export function workBlocksForDay(state, dateKey) {
  return sortBlocks((state.days[dateKey]?.blocks ?? []).filter((b) => b.lane === "work"));
}

export function blocksForWindow(state, dateKey, windowId) {
  const all = state.days[dateKey]?.blocks ?? [];
  return sortBlocks(
    all.filter((b) => {
      if (b.lane === "slot" && b.slot === windowId) return true;
      if (b.lane === "work" && blockHasTime(b) && windowIdForStartMin(b.startMin) === windowId) return true;
      return false;
    }),
  );
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

export function nowMinutesInPlanDay() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export function isWindowActiveNow(windowId, nowMin = nowMinutesInPlanDay()) {
  const w = getDayWindow(windowId);
  if (!w) return false;
  if (w.id === "night") return nowMin >= 21 * 60;
  return nowMin >= w.start && nowMin < w.end;
}

/** אחרי חצות (עד 02:00) נשארים ביום התכנון של אתמול */
export function planMinutesNow(now = new Date()) {
  const min = now.getHours() * 60 + now.getMinutes();
  if (min < 2 * 60) return min + 24 * 60;
  return min;
}

function ymd(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function planDateKeyNow(now = new Date()) {
  if (now.getHours() < 2) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return ymd(dt);
  }
  return ymd(now);
}

export function getWindowHeading(state, windowId) {
  if (!headingKeyOk(windowId)) return "";
  return String(state.headings?.[windowId] ?? "");
}

export function setWindowHeading(state, windowId, text) {
  if (!headingKeyOk(windowId)) return;
  if (!state.headings || typeof state.headings !== "object") state.headings = {};
  const t = String(text ?? "").trim().slice(0, 200);
  if (t) state.headings[windowId] = t;
  else delete state.headings[windowId];
}

function ownWindowBlocks(state, dateKey, windowId) {
  if (windowId === "work") return workBlocksForDay(state, dateKey);
  return sortBlocks((state.days[dateKey]?.blocks ?? []).filter((b) => b.lane === "slot" && b.slot === windowId));
}

export function findPreviousWindowDay(state, beforeDateKey, windowId) {
  if (!headingKeyOk(windowId)) return null;
  const keys = Object.keys(state.days ?? {})
    .filter((k) => k < beforeDateKey)
    .sort()
    .reverse();
  for (const k of keys) {
    if (ownWindowBlocks(state, k, windowId).length) return k;
    if (String(state.days[k]?.windowNotes?.[windowId] ?? "").trim()) return k;
  }
  return null;
}

export function copyWindowTitlesFromDay(state, fromKey, toKey, windowId, newId) {
  if (!headingKeyOk(windowId) || fromKey === toKey) return { copied: 0, skipped: 0 };
  const src = ownWindowBlocks(state, fromKey, windowId);
  const existing = new Set(ownWindowBlocks(state, toKey, windowId).map((b) => b.title));
  let copied = 0;
  let skipped = 0;
  for (const b of src) {
    if (existing.has(b.title)) {
      skipped += 1;
      continue;
    }
    const meta = windowId === "work" ? { lane: "work" } : { lane: "slot", slot: windowId };
    const ok = addScheduleBlock(state, toKey, newId(), b.title, b.startMin, meta);
    if (ok) {
      copied += 1;
      existing.add(b.title);
    }
  }
  return { copied, skipped, fromKey };
}

export function nowAndNextOnDay(state, dateKey, nowPlanMin) {
  const timed = blocksForDay(state, dateKey).filter((b) => blockHasTime(b) && !b.done);
  const current = [...timed].reverse().find((b) => b.startMin <= nowPlanMin) || null;
  const next = timed.find((b) => b.startMin > nowPlanMin) || null;
  const winNow = DAY_WINDOWS.find((w) => {
    if (w.id === "night") return nowPlanMin >= 21 * 60 && nowPlanMin < 26 * 60;
    return nowPlanMin >= w.start && nowPlanMin < w.end;
  }) || null;
  const winNext = DAY_WINDOWS.find((w) => w.start > nowPlanMin) || null;
  return { current, next, winNow, winNext };
}
