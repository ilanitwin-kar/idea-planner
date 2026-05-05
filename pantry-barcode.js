/**
 * חיפוש שם מוצר לפי ברקוד (Open Food Facts — מאגר ציבורי).
 * הכמות נשארת אצל המשתמשת באפליקציה.
 */

export function normalizeBarcodeInput(s) {
  return String(s ?? "").replace(/\D/g, "");
}

/**
 * @returns {{ ok: true, name: string, code: string } | { ok: false, error: string, code: string }}
 */
export async function lookupOpenFoodFactsProduct(code) {
  const digits = normalizeBarcodeInput(code);
  if (digits.length < 8 || digits.length > 14) {
    return { ok: false, code: digits, error: "קוד ברקוד צריך בין 8 ל־14 ספרות." };
  }

  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
    digits,
  )}.json?fields=product_name,product_name_he,product_name_en,generic_name,brands`;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) {
      return { ok: false, code: digits, error: "שגיאת רשת בחיפוש. נסי שוב או הקלידי שם ידנית." };
    }
    const j = await r.json();
    if (j.status !== 1 || !j.product) {
      return {
        ok: false,
        code: digits,
        error: "לא נמצא במאגר. אפשר להקליד את שם המוצר מהאריזה.",
      };
    }
    const p = j.product;
    const nameHe = p.product_name_he && String(p.product_name_he).trim();
    const name = p.product_name && String(p.product_name).trim();
    const nameEn = p.product_name_en && String(p.product_name_en).trim();
    const generic = p.generic_name && String(p.generic_name).trim();
    const chosen = nameHe || name || nameEn || generic || "";
    if (!chosen) {
      return { ok: false, code: digits, error: "רשומה ללא שם. הקלידי שם ידנית." };
    }
    return { ok: true, code: digits, name: chosen };
  } catch (e) {
    if (e?.name === "AbortError") {
      return { ok: false, code: digits, error: "החיפוש ארך יותר מדי. נסי שוב." };
    }
    return { ok: false, code: digits, error: "לא ניתן להשלים חיפוש כרגע." };
  } finally {
    clearTimeout(t);
  }
}
