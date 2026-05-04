import html2pdf from "html2pdf.js";

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function backupFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `idea-planner-gibui-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.pdf`;
}

/**
 * יוצר קובץ PDF מהטקסט (עברית RTL) — אפשר לשלוח במייל / ווטסאפ / Drive.
 */
export function downloadFullBackupPdf({ title, plainText }) {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("dir", "rtl");
  wrapper.style.cssText = [
    "position:fixed",
    "left:-200vw",
    "top:0",
    "width:190mm",
    "box-sizing:border-box",
    "padding:10mm 12mm",
    "background:#fff",
    "color:#111",
    'font-family:system-ui,"Segoe UI","David","Arial Hebrew",Tahoma,sans-serif',
    "font-size:10.5pt",
    "line-height:1.55",
    "text-align:right",
  ].join(";");

  wrapper.innerHTML = `
    <div style="font-size:14pt;font-weight:700;margin:0 0 5mm;text-align:right;">${escapeHtml(title)}</div>
    <pre style="white-space:pre-wrap;word-wrap:break-word;margin:0;font:inherit;">${escapeHtml(plainText)}</pre>
  `;
  document.body.appendChild(wrapper);

  const opt = {
    margin: [10, 10, 10, 10],
    filename: backupFilename(),
    image: { type: "jpeg", quality: 0.93 },
    html2canvas: { scale: 2, useCORS: true, logging: false },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak: { mode: ["css", "legacy"] },
  };

  return html2pdf()
    .set(opt)
    .from(wrapper)
    .save()
    .finally(() => {
      wrapper.remove();
    });
}
