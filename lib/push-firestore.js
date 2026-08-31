/**
 * אחסון תור Push ב-Firestore (מסמך אחד) — ל-Vercel בלי SQLite.
 * דורש כלל: match /ideaPlannerPush/{doc} { allow read, write: if true; }
 */
import { FALLBACK_FIREBASE_API_KEY, FALLBACK_FIREBASE_PROJECT_ID } from "./push-defaults.js";

function env(name) {
  return String(process.env[name] ?? "").trim();
}

export function firebaseProjectId() {
  return env("FIREBASE_PROJECT_ID") || env("VITE_FIREBASE_PROJECT_ID") || FALLBACK_FIREBASE_PROJECT_ID;
}

export function firebaseApiKey() {
  return env("FIREBASE_API_KEY") || env("VITE_FIREBASE_API_KEY") || FALLBACK_FIREBASE_API_KEY;
}

function docUrl() {
  const projectId = firebaseProjectId();
  const key = firebaseApiKey();
  if (!projectId || !key) return null;
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/ideaPlannerPush/state?key=${encodeURIComponent(key)}`;
}

export function emptyPushState() {
  return { subscriptions: [], reminders: [], vapid: null };
}

export async function loadPushState() {
  const url = docUrl();
  if (!url) return emptyPushState();
  try {
    const r = await fetch(url);
    if (r.status === 404) return emptyPushState();
    if (!r.ok) return emptyPushState();
    const j = await r.json();
    const raw = j?.fields?.payload?.stringValue;
    if (!raw) return emptyPushState();
    const parsed = JSON.parse(raw);
    return {
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      vapid: parsed.vapid && parsed.vapid.publicKey && parsed.vapid.privateKey ? parsed.vapid : null,
    };
  } catch {
    return emptyPushState();
  }
}

export async function savePushState(state) {
  const url = docUrl();
  if (!url) throw new Error("firestore_unconfigured");
  const body = {
    fields: {
      payload: { stringValue: JSON.stringify(state) },
    },
  };
  const r2 = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r2.ok) throw new Error(`firestore_write_${r2.status}`);
}

export function firestoreConfigured() {
  return !!(firebaseProjectId() && firebaseApiKey());
}
