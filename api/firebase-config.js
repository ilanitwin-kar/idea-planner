/**
 * Vercel Serverless — אותה תצורה כמו ב־Express ‎/api/firebase-config‎.
 * ב-Vercel: Settings → Environment Variables (Production) —
 * ‎FIREBASE_API_KEY‎, ‎FIREBASE_AUTH_DOMAIN‎, ‎FIREBASE_PROJECT_ID‎, ‎FIREBASE_APP_ID‎
 * (או אותם שמות עם ‎VITE_‎).
 *
 * אבחון: ‎GET /api/firebase-config?status=1‎ מחזיר ‎{ ok, missing }‎ בלי ערכים.
 */
function trimEnv(v) {
  return String(v ?? "").trim();
}

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");

  const apiKey = trimEnv(process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY);
  const authDomain = trimEnv(process.env.FIREBASE_AUTH_DOMAIN || process.env.VITE_FIREBASE_AUTH_DOMAIN);
  const projectId = trimEnv(process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID);
  const appId = trimEnv(process.env.FIREBASE_APP_ID || process.env.VITE_FIREBASE_APP_ID);
  const storageBucket = trimEnv(process.env.FIREBASE_STORAGE_BUCKET || process.env.VITE_FIREBASE_STORAGE_BUCKET);
  const messagingSenderId = trimEnv(
    process.env.FIREBASE_MESSAGING_SENDER_ID || process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  );

  let statusProbe = false;
  try {
    const host = req.headers?.host || "localhost";
    const u = new URL(req.url || "/", `https://${host}`);
    statusProbe = u.searchParams.get("status") === "1";
  } catch {
    /* ignore */
  }

  if (statusProbe) {
    const missing = [];
    if (!apiKey) missing.push("apiKey");
    if (!authDomain) missing.push("authDomain");
    if (!projectId) missing.push("projectId");
    if (!appId) missing.push("appId");
    res.status(200).json({ ok: missing.length === 0, missing });
    return;
  }

  if (!apiKey || !authDomain || !projectId || !appId) {
    res.status(404).json({ ok: false, error: "firebase_env_missing" });
    return;
  }

  const body = { apiKey, authDomain, projectId, appId };
  if (storageBucket) body.storageBucket = storageBucket;
  if (messagingSenderId) body.messagingSenderId = messagingSenderId;
  res.status(200).json(body);
}
