/**
 * ייבוא למלאי מ־PDF (תעודת משלוח דמוית שופרסל) או מתמונה (OCR).
 * תוצאות תמיד לבדיקה ידנית לפני שמירה.
 */
import * as pdfjsLib from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createWorker } from "tesseract.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/** שורות מספריים לפני «יח» ואז שם מוצר — כמו בתעודת משלוח דיגיטלית */
export function parseShufersalDeliveryLines(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  const yachRe = /\s(\d+)\s+(\d+)\s+יח(?:['׳]?(?:\s|$))/g;

  for (const raw of lines) {
    yachRe.lastIndex = 0;
    const line = raw.trim();
    if (!line || !line.includes("יח")) continue;
    if (/מבצע\s*:/i.test(line) && /^[\d.-]+\s*[\d.-]+\s*מבצע/i.test(line.replace(/\s+/g, " "))) {
      continue;
    }

    let lastEnd = -1;
    let supplied = 0;
    let m;
    yachRe.lastIndex = 0;
    while ((m = yachRe.exec(line)) !== null) {
      supplied = parseInt(m[2], 10);
      lastEnd = m.index + m[0].length;
    }

    if (lastEnd < 0 || !Number.isFinite(supplied) || supplied <= 0) continue;

    let product = line.slice(lastEnd).trim();
    product = product.replace(/\s+\d{4,}\s*$/u, "").trim();
    if (!product || product.length < 2) continue;
    if (/^מבצע\s*:/i.test(product)) continue;

    out.push({ name: product, qty: supplied });
  }
  return out;
}

function mergeLineIntoBucket(bucket, name, qty) {
  const q = parseInt(String(qty), 10);
  if (!Number.isFinite(q) || q <= 0 || q > 999) return;
  let n = String(name ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\d.,\s₪\-–]+/u, "")
    .replace(/[\d.,\s₪\-–]+$/u, "")
    .trim();
  if (n.length < 2) return;
  const key = n.toLowerCase();
  const prev = bucket.get(key);
  if (prev) prev.qty += q;
  else bucket.set(key, { name: n, qty: q });
}

/** כמות משורת «4 X 7.90 'יח» (קבלות מודפסות) */
function parseNxPriceYachLine(line) {
  const m = line.match(
    /(\d{1,3})\s*[xX×]\s*\d{1,3}[.,]\d{1,2}\s*['׳״"]?\s*יח(?:ידות)?/i,
  );
  if (!m) return null;
  const qty = parseInt(m[1], 10);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 99) return null;
  return { qty, matchIndex: m.index, matchLen: m[0].length };
}

/** ניסיון לחלץ שם + כמות משורת OCR אחת */
function parseOneOcrLine(line) {
  const trimmed = line.trim();
  if (trimmed.length < 4) return null;
  if (/^[\d\s₪.,\-–:]+$/.test(trimmed)) return null;
  if (/^\s*(סה[״\"]?כ|מע[״\"]?מ|מע״מ|סכום)\s*:/i.test(trimmed)) return null;

  const skipShort =
    /^(חסר\s*במלאי|דמי\s*משלוח|תעודת\s*משלוח|מס\.?\s*הזמנה|שם\s*המוצר|מותג|תמונה|הוזמן|התקבל)\s*$/i.test(
      trimmed,
    );
  if (skipShort) return null;

  const nx = parseNxPriceYachLine(trimmed);
  if (nx && nx.matchIndex > 0) {
    let name = trimmed
      .slice(0, nx.matchIndex)
      .replace(/^\s*[\d.,]+\s+/, " ")
      .replace(/₪\s*[\d.,]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (name.length >= 2) return { name, qty: nx.qty };
  }

  const allYach = [
    ...trimmed.matchAll(/(.{2,120}?)\s+(\d{1,4})\s*יח(?:ידות?)?['׳״"]?(?:\s|$|,)/gi),
  ];
  if (allYach.length) {
    const last = allYach[allYach.length - 1];
    return { name: last[1].trim(), qty: last[2] };
  }

  const yachOnly = [...trimmed.matchAll(/(\d{1,4})\s*יח(?:ידות?)?['׳״"]?/gi)];
  if (yachOnly.length) {
    const last = yachOnly[yachOnly.length - 1];
    const qty = last[1];
    let name = trimmed
      .slice(0, last.index)
      .replace(/₪\s*[\d.,]+/g, " ")
      .replace(/[\d.,]+\s*₪?/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (name.length >= 2) return { name, qty };
  }

  const ocrBrokenYach = trimmed.match(
    /(.{3,}?)\s+(\d{1,3})\s*[יי]\s*[חח](?:['׳]|ידות)?/u,
  );
  if (ocrBrokenYach) {
    return { name: ocrBrokenYach[1].trim(), qty: ocrBrokenYach[2] };
  }

  return null;
}

/** היוריסטיקה לטקסט מצילום מסך (שופרסל / חינם פלוס וכו׳) */
export function parseLooseOcrLines(text) {
  const raw = String(text).replace(/\r/g, "");
  const lines = raw.split("\n").map((l) => l.trim());
  const bucket = new Map();

  for (const line of lines) {
    if (!line) continue;
    if (/חסר\s*במלאי|דמי\s*משלוח/i.test(line) && line.length < 40) continue;

    const qtyMatches = [...line.matchAll(/(\d+)\s*יח['׳״"]?/g)];
    if (qtyMatches.length) {
      const qty = parseInt(qtyMatches[qtyMatches.length - 1][1], 10);
      if (Number.isFinite(qty) && qty > 0) {
        let name = line
          .replace(/₪\s*[\d.,]+/g, " ")
          .replace(/[\d.,]+\s*יח['׳״"]?/gi, " ")
          .replace(/^\s*[\d.,\s%\-–]+\s*/u, " ")
          .replace(/\s+/g, " ")
          .trim();
        mergeLineIntoBucket(bucket, name, qty);
        continue;
      }
    }

    const parsed = parseOneOcrLine(line);
    if (parsed) mergeLineIntoBucket(bucket, parsed.name, parsed.qty);
  }

  const paraBlocks = raw.split(/\n{2,}/);
  for (const block of paraBlocks) {
    if (
      block.includes("יח") ||
      block.includes("יחידות") ||
      /\d\s*[xX×]\s*[\d.,]+\s*['׳״"]?\s*יח/i.test(block)
    ) {
      const oneLine = block.replace(/\s+/g, " ").trim();
      const parsed = parseOneOcrLine(oneLine);
      if (parsed) mergeLineIntoBucket(bucket, parsed.name, parsed.qty);
    }
  }

  return [...bucket.values()];
}

function isReceiptDiscountLine(line) {
  return /הנחה/i.test(line) && (/^\s*\*/.test(line) || /\-\d+[.,]\d+/.test(line));
}

function cleanThermalProductChunk(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(?:DELI|SKU)\s+/i, "")
    .replace(/^\d{1,3}[.,]\d{2}\s+/, "")
    .trim();
}

/**
 * קבלה מודפסת: שורה שמתחילה בברקוד (12–13 ספרות), לעיתים המשך שורות לשם,
 * ושורת כמות «סה״כ 4 X 7.90 'יח».
 */
export function parseThermalReceiptLines(text) {
  const raw = normalizeReceiptOcrText(text);
  const lines = raw.split(/\n/).map((l) => l.trim());
  const out = [];
  /** @type {{ parts: string[]; qty: number } | null} */
  let pending = null;

  const flush = () => {
    if (!pending) return;
    const name = cleanThermalProductChunk(pending.parts.join(" ")).replace(
      /\s+\d{1,3}[.,]\d{2}\s*$/u,
      "",
    );
    if (name.length >= 2) out.push({ name: name.trim(), qty: pending.qty });
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (isReceiptDiscountLine(line)) continue;

    const nx = parseNxPriceYachLine(line);
    if (nx) {
      if (pending) {
        pending.qty = nx.qty;
        flush();
      }
      continue;
    }

    const bm = line.match(/^\D{0,2}(\d{12,13})\s+(.+)$/);
    if (bm) {
      flush();
      let rest = cleanThermalProductChunk(bm[2]);
      const singleEnd = rest.match(/^(.+?)\s+(\d{1,3}[.,]\d{2})\s*$/u);
      if (singleEnd && !parseNxPriceYachLine(rest)) {
        rest = singleEnd[1].trim();
      }
      pending = { parts: [rest], qty: 1 };
      continue;
    }

    if (pending) {
      if (/^\d{1,3}[.,]\d{2}\s*$/.test(line)) {
        continue;
      }
      const hasHebrew = /[\u0590-\u05FF]/.test(line);
      const hasLatinWord = /[A-Za-z]{2,}/.test(line);
      const looksLikeBarcodeNext = /^\d{12,13}\s/.test(line);
      if (!looksLikeBarcodeNext && (hasHebrew || hasLatinWord)) {
        pending.parts.push(line.replace(/\s+\d{1,3}[.,]\d{2}\s*$/u, "").trim());
        continue;
      }
    }

    flush();
  }
  flush();
  return out;
}

/** מנקה רווחים בין ספרות (OCR שמפצל ברקוד / מחיר) */
function normalizeReceiptOcrText(t) {
  let s = String(t).replace(/\r/g, "");
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/(\d)\s+(?=\d)/g, "$1");
    if (next === s) break;
    s = next;
  }
  return s;
}

function extractHebrewNearBarcode(chunk, preferEnd) {
  let work = chunk
    .replace(/(?:729\d{10}|69\d{10,11})/g, " ")
    .replace(/\d+\.\d{2}/g, " ")
    .replace(/₪|%|€/g, " ")
    .replace(/[A-Za-z]{2,}/g, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const runs = [
    ...work.matchAll(/[\u0590-\u05FF][\u0590-\u05FF\s/'׳״\-\u002f]{2,}/g),
  ].map((x) => x[0].trim());
  if (!runs.length) return "";
  if (preferEnd) return runs[runs.length - 1];
  return runs.sort((a, b) => b.length - a.length)[0];
}

/**
 * קבלות/מסכים שבהם אין «יח» אבל יש ברקוד (729 או 69x — EAN נפוץ ביבוא).
 * כמות ברירת מחדל 1 — לעריכה בטבלה.
 */
export function parseIsraelBarcodeOcrLines(text) {
  const raw = normalizeReceiptOcrText(text);
  const re = /(?:729\d{10}|69\d{10,11})/g;
  const byCode = new Map();

  let m;
  while ((m = re.exec(raw)) !== null) {
    const code = m[0];
    if (byCode.has(code)) continue;

    const after = raw.slice(m.index + code.length, m.index + code.length + 110);
    const before = raw.slice(Math.max(0, m.index - 110), m.index);

    let name = extractHebrewNearBarcode(after, true);
    if (name.length < 3) name = extractHebrewNearBarcode(before, true);
    if (name.length < 3) continue;

    const lineStart = raw.lastIndexOf("\n", m.index);
    const lineEnd = raw.indexOf("\n", m.index);
    const line = raw
      .slice(lineStart === -1 ? 0 : lineStart + 1, lineEnd === -1 ? raw.length : lineEnd)
      .trim();

    let qty = 1;
    const yach = line.match(/(\d{1,3})\s*יח(?:ידות?)?['׳״"]?/i);
    if (yach) {
      const q = parseInt(yach[1], 10);
      if (Number.isFinite(q) && q > 0 && q <= 999) qty = q;
    } else {
      const nx = parseNxPriceYachLine(line);
      if (nx) qty = nx.qty;
    }

    byCode.set(code, { name, qty });
  }

  return [...byCode.values()];
}

export function autoParseReceiptText(text, isPdf) {
  const shuf = parseShufersalDeliveryLines(text);
  if (shuf.length >= 1) {
    return {
      rows: shuf,
      label: isPdf ? "תעודת משלוח (פורמט מספרים + יח)" : "זוהה פורמט דמוי תעודת משלוח",
    };
  }
  const thermal = parseThermalReceiptLines(text);
  if (thermal.length >= 1) {
    return {
      rows: thermal,
      label: isPdf
        ? "קבלה מודפסת (ברקוד + שורות כמות) — בדקי שמות וכמויות"
        : "קבלה מודפסת (ברקוד + X מחיר יח) — בדקי שמות וכמויות",
    };
  }
  const gen = parseLooseOcrLines(text);
  if (gen.length >= 1) {
    return {
      rows: gen,
      label: isPdf ? "לא זוהה פורמט שופרסל — ניסיון כללי" : "זיהוי כללי ממסך — בדקי את הרשימה",
    };
  }
  const bar = parseIsraelBarcodeOcrLines(text);
  if (bar.length >= 1) {
    return {
      rows: bar,
      label: "זוהו מוצרים לפי ברקוד (729/69…) — כמות לפי שורה אם זוהתה, אחרת 1",
    };
  }
  return {
    rows: [],
    label: isPdf ? "לא זוהה פורמט שופרסל — ניסיון כללי" : "זיהוי כללי ממסך — בדקי את הרשימה",
  };
}

export async function extractPdfPlainText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let out = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      out += it.str;
      out += it.hasEOL ? "\n" : " ";
    }
    out += "\n";
  }
  return out;
}

/**
 * הגדלת תמונה לרזולוציה שמקלה על Tesseract + רקע לבן (סריקות כהות).
 */
export async function imageToCanvasForOcr(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });
      bmp = await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const w = bmp.width;
  const h = bmp.height;
  const longEdge = Math.max(w, h);
  const targetMin = 1500;
  const maxDim = 2800;
  let scale = Math.max(1, targetMin / longEdge);
  if (longEdge * scale > maxDim) scale = maxDim / longEdge;
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bmp.close?.();
    throw new Error("canvas");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, cw, ch);
  bmp.close?.();
  return canvas;
}

export async function ocrImageToText(file, onStatus) {
  const canvas = await imageToCanvasForOcr(file);
  const worker = await createWorker("heb+eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text" && typeof onStatus === "function") {
        onStatus(`מזהים טקסט… ${Math.round((m.progress ?? 0) * 100)}%`);
      }
    },
  });

  const psms = ["4", "6", "3", "11"];
  let best = "";

  try {
    for (let i = 0; i < psms.length; i++) {
      if (typeof onStatus === "function") {
        onStatus(`סריקת תמונה ${i + 1}/${psms.length} (מצב ${psms[i]})…`);
      }
      await worker.setParameters({
        tessedit_pageseg_mode: psms[i],
        preserve_interword_spaces: "1",
      });
      const {
        data: { text },
      } = await worker.recognize(canvas);
      const t = String(text ?? "").trim();
      if (t.length > best.length) best = t;
    }
    return best;
  } finally {
    await worker.terminate();
  }
}
