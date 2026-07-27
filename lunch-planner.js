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

export function normalizePartList(partsRaw) {
  const raw = Array.isArray(partsRaw) ? partsRaw : [partsRaw];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const p = String(x ?? "").trim();
    if (!p) continue;
    const k = p.toLocaleLowerCase("he");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** רכיבי מנה להצגה */
export function dishParts(dish) {
  if (!dish) return [];
  if (Array.isArray(dish.parts) && dish.parts.length) {
    return normalizePartList(dish.parts);
  }
  const n = String(dish.name ?? "").trim();
  return n ? [n] : [];
}

export function mealTitleForParts(parts) {
  const p = normalizePartList(parts);
  if (p.length === 0) return "";
  if (p.length === 1) return p[0];
  return "ארוחה";
}

export function partsSignature(parts) {
  return normalizePartList(parts)
    .map((x) => x.toLocaleLowerCase("he"))
    .join("|");
}

export function findOrCreateMealFromParts(state, partsRaw) {
  const parts = normalizePartList(partsRaw);
  if (!parts.length) return null;
  const sig = partsSignature(parts);
  const existing = state.dishes.find((d) => partsSignature(dishParts(d)) === sig);
  if (existing) return { dish: existing, created: false };
  const dish = {
    id: `dish_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`,
    name: mealTitleForParts(parts),
  };
  if (parts.length > 1) dish.parts = [...parts];
  state.dishes.push(dish);
  state.dishes.sort((a, b) => a.name.localeCompare(b.name, "he"));
  return { dish, created: true };
}

export function applyPartsToDish(dish, partsRaw) {
  const parts = normalizePartList(partsRaw);
  if (!parts.length || !dish) return;
  if (parts.length === 1) {
    dish.name = parts[0];
    delete dish.parts;
  } else {
    dish.name = "ארוחה";
    dish.parts = [...parts];
  }
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

export function mealSnapshotFromDish(dish) {
  const parts = dishParts(dish);
  return { name: mealTitleForParts(parts), parts: [...parts] };
}

export function planEntryMealParts(state, entry) {
  if (!entry) return [];
  const dish = entry.dishId ? findDish(state, entry.dishId) : null;
  if (dish) return dishParts(dish);
  const snap = entry.mealSnapshot;
  if (snap && Array.isArray(snap.parts) && snap.parts.length) return normalizePartList(snap.parts);
  if (snap?.name) return normalizePartList([snap.name]);
  return ["—"];
}

function attachMealSnapshotToEntry(state, entry) {
  if (!entry?.dishId) return;
  const dish = findDish(state, entry.dishId);
  if (dish) entry.mealSnapshot = mealSnapshotFromDish(dish);
}

/** אותה ארוחה (לפי רכיבים) ביום אחר בשבוע */
export function findMealPlannedElsewhereInWeek(state, weekStartKey, partsRaw, exceptDateKey) {
  const sig = partsSignature(partsRaw);
  if (!sig) return null;
  const w = state.weeks[weekStartKey];
  if (!w?.days) return null;
  for (const [dk, entries] of Object.entries(w.days)) {
    if (dk === exceptDateKey || !Array.isArray(entries)) continue;
    for (const ent of entries) {
      if (partsSignature(planEntryMealParts(state, ent)) === sig) return dk;
    }
  }
  return null;
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
  attachMealSnapshotToEntry(state, entry);
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

export function updateHomeStockItem(state, category, itemId, nameRaw) {
  if (!LUNCH_STOCK_CATEGORIES.includes(category)) return false;
  const n = String(nameRaw ?? "").trim();
  if (!n) return false;
  const list = state.homeStock[category];
  const it = list.find((x) => x.id === itemId);
  if (!it) return false;
  const norm = n.toLocaleLowerCase("he");
  if (list.some((x) => x.id !== itemId && String(x.name).trim().toLocaleLowerCase("he") === norm)) {
    return false;
  }
  it.name = n;
  list.sort((a, b) => a.name.localeCompare(b.name, "he"));
  return true;
}

export function updateDishName(state, dishId, nameRaw) {
  const n = String(nameRaw ?? "").trim();
  if (!n) return false;
  const dish = state.dishes.find((d) => d.id === dishId);
  if (!dish) return false;
  const oldName = dish.name;
  const norm = n.toLocaleLowerCase("he");
  if (state.dishes.some((d) => d.id !== dishId && String(d.name).trim().toLocaleLowerCase("he") === norm)) {
    return false;
  }
  dish.name = n;
  const rec = state.recipes.find((r) => r.dishId === dishId);
  if (rec && String(rec.title).trim() === String(oldName).trim()) rec.title = n;
  state.dishes.sort((a, b) => a.name.localeCompare(b.name, "he"));
  return true;
}

export function updatePlanEntryDish(state, weekStartKey, dateKey, entryId, dishId) {
  const week = state.weeks[weekStartKey];
  const entry = week?.days?.[dateKey]?.find((e) => e.id === entryId);
  if (!entry) return null;
  entry.dishId = dishId;
  attachMealSnapshotToEntry(state, entry);
  const duplicateOnDateKey = findDishPlannedElsewhereInWeek(state, weekStartKey, dishId, dateKey);
  return { entry, duplicateOnDateKey };
}

/** הסרה מ«מנות שלי» בלבד — תכנון השבוע נשמר (עותק ב-mealSnapshot) */
export function deleteDish(state, dishId) {
  const dish = findDish(state, dishId);
  if (dish) {
    const snap = mealSnapshotFromDish(dish);
    for (const wk of Object.keys(state.weeks)) {
      const w = state.weeks[wk];
      if (!w?.days) continue;
      for (const dk of Object.keys(w.days)) {
        for (const ent of w.days[dk]) {
          if (ent?.dishId === dishId) {
            ent.mealSnapshot = snap;
            delete ent.dishId;
          }
        }
      }
    }
  }
  state.dishes = state.dishes.filter((d) => d.id !== dishId);
  state.recipes = state.recipes.filter((r) => r.dishId !== dishId);
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
