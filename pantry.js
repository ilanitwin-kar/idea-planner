/** מלאי מזון ביתי — מקרר / מזווה / מקפיא */

export const PANTRY_STORAGE_KEY = "idea-planner:pantry:v1";

export const PANTRY_LOCATIONS = [
  { id: "fridge", label: "מקרר" },
  { id: "pantry", label: "מזווה" },
  { id: "freezer", label: "מקפיא" },
];

export function pantryLocationLabel(id) {
  return PANTRY_LOCATIONS.find((x) => x.id === id)?.label ?? id;
}

function roundQty(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}

export function defaultPantryState() {
  return { items: [] };
}

export function loadPantry() {
  try {
    const raw = localStorage.getItem(PANTRY_STORAGE_KEY);
    if (!raw) return defaultPantryState();
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object") return defaultPantryState();
    const items = Array.isArray(p.items) ? p.items.map(normalizeItem).filter(Boolean) : [];
    return { items };
  } catch {
    return defaultPantryState();
  }
}

function normalizeItem(it) {
  if (!it || typeof it !== "object") return null;
  const id = typeof it.id === "string" ? it.id : null;
  const name = String(it.name ?? "").trim();
  if (!id || !name) return null;
  const loc = PANTRY_LOCATIONS.some((l) => l.id === it.location) ? it.location : "pantry";
  const quantity = roundQty(it.quantity);
  const unit = String(it.unit ?? "יח׳").trim() || "יח׳";
  return { id, name, location: loc, quantity: Math.max(0, quantity), unit };
}

export function savePantry(state) {
  try {
    localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function pantryUid(prefix = "pantry") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

export function addPantryItem(state, { name, location, quantity, unit }) {
  const loc = PANTRY_LOCATIONS.some((l) => l.id === location) ? location : "pantry";
  const q = roundQty(quantity);
  const u = String(unit ?? "יח׳").trim() || "יח׳";
  state.items.push({
    id: pantryUid(),
    name: String(name ?? "").trim() || "פריט",
    location: loc,
    quantity: Math.max(0, q),
    unit: u,
  });
  savePantry(state);
}

export function deletePantryItem(state, itemId) {
  state.items = state.items.filter((x) => x.id !== itemId);
  savePantry(state);
}

export function updatePantryItem(state, itemId, patch) {
  const it = state.items.find((x) => x.id === itemId);
  if (!it) return;
  if (patch.name != null) it.name = String(patch.name).trim() || it.name;
  if (patch.location != null && PANTRY_LOCATIONS.some((l) => l.id === patch.location)) {
    it.location = patch.location;
  }
  if (patch.quantity != null) it.quantity = Math.max(0, roundQty(patch.quantity));
  if (patch.unit != null) it.unit = String(patch.unit).trim() || "יח׳";
  savePantry(state);
}

/** ירידה במלאי (פתיחה / שימוש) */
export function consumePantry(state, itemId, amount = 1) {
  const it = state.items.find((x) => x.id === itemId);
  if (!it) return;
  const a = Math.max(0, roundQty(amount));
  it.quantity = roundQty(Math.max(0, it.quantity - a));
  savePantry(state);
}

/** הוספת יחידות (מילוי מחדש) */
export function restockPantry(state, itemId, amount = 1) {
  const it = state.items.find((x) => x.id === itemId);
  if (!it) return;
  const a = Math.max(0, roundQty(amount));
  it.quantity = roundQty(it.quantity + a);
  savePantry(state);
}

function normalizePantryNameKey(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** מיזוג שורות ייבוא למלאי — אותו שם באותו מיקום מגדיל כמות */
export function applyPantryImportRows(state, rows, location, unit = "יח׳") {
  const loc = PANTRY_LOCATIONS.some((l) => l.id === location) ? location : "pantry";
  const u = String(unit ?? "יח׳").trim() || "יח׳";
  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    const qty = roundQty(row.qty);
    if (!name || qty <= 0) continue;
    const key = normalizePantryNameKey(name);
    const existing = state.items.find(
      (x) => x.location === loc && normalizePantryNameKey(x.name) === key,
    );
    if (existing) {
      existing.quantity = roundQty(existing.quantity + qty);
    } else {
      state.items.push({ id: pantryUid(), name, location: loc, quantity: qty, unit: u });
    }
  }
  savePantry(state);
}
