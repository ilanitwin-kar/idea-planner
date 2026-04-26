import express from "express";
import cors from "cors";
import { openDb, run, all } from "./db.js";
import { configureWebPush } from "./push.js";
import { startScheduler } from "./scheduler.js";
import webpush from "web-push";
import path from "node:path";
import { fileURLToPath } from "node:url";

function env(name, fallback = "") {
  return process.env[name] ?? fallback;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadDotEnv() {
  // tiny .env loader (no dependency)
  try {
    const fs = await import("node:fs");
    const candidates = [".env", ".env.txt", "env", "env.", "env.txt"];
    let p = null;
    for (const name of candidates) {
      const candidate = path.resolve(__dirname, name);
      if (fs.existsSync(candidate)) {
        p = candidate;
        break;
      }
    }
    if (!p) return;
    const text = fs.readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // ignore
  }
}

await loadDotEnv();

const PORT = Number(env("PORT", "8787"));
const VAPID_SUBJECT = env("VAPID_SUBJECT", "mailto:you@example.com");
const DATA_DIR = env("DATA_DIR", __dirname);

async function ensureDir(p) {
  try {
    const fs = await import("node:fs");
    fs.mkdirSync(p, { recursive: true });
  } catch {
    // ignore
  }
}

await ensureDir(DATA_DIR);

async function getOrCreateVapidKeys() {
  const fs = await import("node:fs");
  const file = path.resolve(DATA_DIR, "vapid.json");

  // Prefer env vars if present
  const fromEnv = {
    publicKey: env("VAPID_PUBLIC_KEY", ""),
    privateKey: env("VAPID_PRIVATE_KEY", ""),
  };
  if (fromEnv.publicKey && fromEnv.privateKey) return fromEnv;

  // Then vapid.json if present
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      const json = JSON.parse(raw);
      if (json?.publicKey && json?.privateKey) return { publicKey: json.publicKey, privateKey: json.privateKey };
    }
  } catch {
    // ignore
  }

  // Finally auto-generate and persist
  const keys = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(file, JSON.stringify(keys, null, 2), "utf8");
  } catch {
    // ignore
  }
  console.log("Generated VAPID keys (saved to server/vapid.json).");
  return keys;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const db = openDb(path.resolve(DATA_DIR, "data.sqlite"));

const VAPID_KEYS = await getOrCreateVapidKeys();
configureWebPush({ publicKey: VAPID_KEYS.publicKey, privateKey: VAPID_KEYS.privateKey, subject: VAPID_SUBJECT });
startScheduler({ db });

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/vapidPublicKey", (req, res) => {
  res.json({ publicKey: VAPID_KEYS.publicKey });
});

app.post("/subscribe", async (req, res) => {
  const sub = req.body?.subscription;
  const userKey = String(req.body?.userKey ?? "local");
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: "Invalid subscription" });
  await run(
    db,
    `INSERT OR IGNORE INTO subscriptions(endpoint, user_key, p256dh, auth, created_at) VALUES(?,?,?,?,?)`,
    [endpoint, userKey, p256dh, auth, Date.now()],
  );
  res.json({ ok: true });
});

app.post("/reminders/upsert", async (req, res) => {
  const { userKey, subtaskId, reminders } = req.body ?? {};
  if (!subtaskId || !Array.isArray(reminders) || reminders.length === 0) return res.status(400).json({ error: "Missing fields" });
  const u = String(userKey ?? "local");

  await run(db, `DELETE FROM reminders WHERE subtask_id = ? AND user_key = ? AND sent_at IS NULL`, [subtaskId, u]);

  for (const r of reminders) {
    const { key, title, body, url, fireAt } = r ?? {};
    if (!key || !title || !body || !url || !fireAt) continue;
    const fire = Number(fireAt);
    if (!Number.isFinite(fire)) continue;
    await run(
      db,
      `INSERT INTO reminders(subtask_id, reminder_key, user_key, title, body, url, fire_at, created_at) VALUES(?,?,?,?,?,?,?,?)`,
      [subtaskId, String(key), u, String(title), String(body), String(url), fire, Date.now()],
    );
  }

  res.json({ ok: true });
});

app.post("/reminders/delete", async (req, res) => {
  const { userKey, subtaskId } = req.body ?? {};
  if (!subtaskId) return res.status(400).json({ error: "Missing subtaskId" });
  const u = String(userKey ?? "local");
  await run(db, `DELETE FROM reminders WHERE subtask_id = ? AND user_key = ? AND sent_at IS NULL`, [subtaskId, u]);
  res.json({ ok: true });
});

app.get("/debug/reminders", async (req, res) => {
  const rows = await all(db, `SELECT * FROM reminders ORDER BY fire_at ASC LIMIT 200`, []);
  res.json({ reminders: rows });
});

// Serve built web app (after `npm run build`)
const publicDir = path.resolve(__dirname, "public");
app.use(express.static(publicDir));
app.get("*", (req, res) => {
  // Keep API routes above this.
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`מרכז הרעיונות של אילנית — שרת תזכורות: http://localhost:${PORT}`);
});

