/** תכנון צהריים שבועי — מנות, מלאי בית, מתכונים */

export const LUNCH_PLANNER_STORAGE_KEY = "idea-planner:lunch-planner:v1";

export const LUNCH_STOCK_CATEGORIES = ["carbs", "proteins", "vegetables", "extras"];

export const LUNCH_STOCK_LABELS = {
  carbs: "פחמימות בבית",
  proteins: "חלבונים בבית",
  vegetables: "ירקות בבית",
  extras: "נוספים בבית",
};

function emptyStock() {
  return { carbs: [], proteins: [], vegetables: [], extras: [] };
}

export function loadLunchPlanner() {
  try {
    const raw = localStorage.getItem(LUNCH_PLANNER_STORAGE_KEY);
    if (!raw) return { homeStock: emptyStock(), dishes: [], recipes: [], weeks: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { homeStock: emptyStock(), dishes: [], recipes: [], weeks: {} };
    }
    const homeStock = emptyStock();
    for (const cat of LUNCH_STOCK_CATEGORIES) {
      const arr = parsed.homeStock?.[cat];
      homeStock[cat] = Array.isArray(arr)
        ? arr.filter((x) => x && typeof x === "object" && x.id && x.name)
        : [];
    }
    return {
      homeStock,
      dishes: Array.isArray(parsed.dishes) ? parsed.dishes.filter((d) => d?.id && d?.name) : [],
      recipes: Array.isArray(parsed.recipes) ? parsed.recipes.filter((r) => r?.id) : [],
      weeks: parsed.weeks && typeof parsed.weeks === "object" ? { ...parsed.weeks } : {},
    };
  } catch {
    return { homeStock: emptyStock(), dishes: [], recipes: [], weeks: {} };
  }
}

export function saveLunchPlanner(state) {
  localStorage.setItem(LUNCH_PLANNER_STORAGE_KEY, JSON.stringify(state));
}

/** יום ראשון של השבוע (יום א׳) לפי מפתח yyyy-mm-dd */
export function weekStartKeyFromDateKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay();
  dt.setDate(dt.getDate() - day);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function addDaysToDateKey(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const x = new Date(y, m - 1, d);
  x.setDate(x.getDate() + deltaDays);
  const yy = x.getFullYear();
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** שבעת מפתחות התאריך של השבוע (ראשון → שבת) */
export function weekDayKeys(weekStartKey) {
  const keys = [];
  for (let i = 0; i < 7; i++) keys.push(addDaysToDateKey(weekStartKey, i));
  return keys;
}

function ensureWeek(state, weekStartKey) {
  if (!state.weeks[weekStartKey]) state.weeks[weekStartKey] = { days: {} };
  const w = state.weeks[weekStartKey];
  if (!w.days || typeof w.days !== "object") w.days = {};
  return w;
}

export function planEntriesForDay(state, weekStartKey, dateKey) {
  const w = state.weeks[weekStartKey];
  const arr = w?.days?.[dateKey];
  return Array.isArray(arr) ? arr : [];
}

export function findDish(state, dishId) {
  return state.dishes.find((d) => d.id === dishId) ?? null;
}

export function findOrCreateDish(state, nameRaw) {
  const name = String(nameRaw ?? "").trim();
  if (!name) return null;
  const norm = name.toLocaleLowerCase("he");
  const existing = state.dishes.find((d) => String(d.name).trim().toLocaleLowerCase("he") === norm);
  if (existing) return { dish: existing, created: false };
  const dish = { id: `dish_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`, name };
  state.dishes.push(dish);
  state.dishes.sort((a, b) => a.name.localeCompare(b.name, "he"));
  return { dish, created: true };
}

/** יום אחר בשבוע שכבר מתוכנן אותה מנה (לא כולל exceptDateKey) */
export function findDishPlannedElsewhereInWeek(state, weekStartKey, dishId, exceptDateKey) {
  const w = state.weeks[weekStartKey];
  if (!w?.days) return null;
  for (const [dk, entries] of Object.entries(w.days)) {
    if (dk === exceptDateKey || !Array.isArray(entries)) continue;
    if (entries.some((e) => e?.dishId === dishId)) return dk;
  }
  return null;
}

/**
 * @returns {{ entry, duplicateOnDateKey: string | null }}
 */
export function addPlanEntry(state, weekStartKey, dateKey, dishId) {
  const week = ensureWeek(state, weekStartKey);
  if (!week.days[dateKey]) week.days[dateKey] = [];
  const duplicateOnDateKey = findDishPlannedElsewhereInWeek(state, weekStartKey, dishId, dateKey);
  const entry = {
    id: `plan_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`,
    dishId,
  };
  week.days[dateKey].push(entry);
  return { entry, duplicateOnDateKey };
}

export function removePlanEntry(state, weekStartKey, dateKey, entryId) {
  const week = state.weeks[weekStartKey];
  if (!week?.days?.[dateKey]) return;
  week.days[dateKey] = week.days[dateKey].filter((e) => e.id !== entryId);
  if (week.days[dateKey].length === 0) delete week.days[dateKey];
  if (Object.keys(week.days).length === 0) delete state.weeks[weekStartKey];
}

export function addHomeStockItem(state, category, id, name) {
  if (!LUNCH_STOCK_CATEGORIES.includes(category)) return false;
  const n = String(name ?? "").trim();
  if (!n) return false;
  const list = state.homeStock[category];
  const norm = n.toLocaleLowerCase("he");
  if (list.some((x) => String(x.name).trim().toLocaleLowerCase("he") === norm)) return false;
  list.push({ id, name: n });
  list.sort((a, b) => a.name.localeCompare(b.name, "he"));
  return true;
}

export function removeHomeStockItem(state, category, itemId) {
  if (!LUNCH_STOCK_CATEGORIES.includes(category)) return;
  state.homeStock[category] = state.homeStock[category].filter((x) => x.id !== itemId);
}

export function deleteDish(state, dishId) {
  state.dishes = state.dishes.filter((d) => d.id !== dishId);
  state.recipes = state.recipes.filter((r) => r.dishId !== dishId);
  for (const wk of Object.keys(state.weeks)) {
    const w = state.weeks[wk];
    if (!w?.days) continue;
    for (const dk of Object.keys(w.days)) {
      w.days[dk] = w.days[dk].filter((e) => e.dishId !== dishId);
      if (w.days[dk].length === 0) delete w.days[dk];
    }
    if (Object.keys(w.days).length === 0) delete state.weeks[wk];
  }
}

export function getRecipeForDish(state, dishId) {
  return state.recipes.find((r) => r.dishId === dishId) ?? null;
}

export function upsertRecipeForDish(state, recipeId, dishId, title, body) {
  const t = String(title ?? "").trim();
  const b = String(body ?? "").trim();
  if (!dishId || !t) return null;
  let rec = state.recipes.find((r) => r.dishId === dishId);
  if (rec) {
    rec.title = t;
    rec.body = b;
    return rec;
  }
  rec = {
    id: recipeId,
    dishId,
    title: t,
    body: b,
  };
  state.recipes.push(rec);
  state.recipes.sort((a, b) => a.title.localeCompare(b.title, "he"));
  return rec;
}

export function deleteRecipe(state, recipeId) {
  state.recipes = state.recipes.filter((r) => r.id !== recipeId);
}
