/**
 * גיבוי אופציונלי ל-Firestore. המקור נשאר ב-localStorage; אין טעינה אוטומטית מהענן.
 */
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, serverTimestamp } from "firebase/firestore";

/** מפתחות שמגובים יחד (תואם לאיפוס מלא מקומי) */
export const CLOUD_SNAPSHOT_STORAGE_KEYS = [
  "idea-planner:v1",
  "idea-planner:settings:v1",
  "idea-planner:app-mode:v1",
  "idea-planner:last-known-calendar-day:v1",
  "idea-planner:day-journal:v1",
  "idea-planner:pantry:v1",
  "idea-planner:daily-timing-log:v1",
];

const SNAPSHOT_VERSION = 1;

/** תצורה שהורדה משרת הפרודקשן (בלי Vite בזמן build) */
let runtimeInjectedConfig = null;

function buildConfigFromViteEnv() {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return {
    apiKey: String(apiKey),
    authDomain: String(authDomain),
    projectId: String(projectId),
    appId: String(appId),
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || undefined,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || undefined,
  };
}

function readFirebaseConfigFromEnv() {
  if (runtimeInjectedConfig) return runtimeInjectedConfig;
  return buildConfigFromViteEnv();
}

/**
 * בפרודקשן לעיתים אין VITE_* בזמן build — אז טוענים מ־GET /api/firebase-config (אותו דומיין).
 */
export async function loadFirebaseConfigIfNeeded() {
  if (buildConfigFromViteEnv()) return true;
  if (runtimeInjectedConfig) return true;
  try {
    const r = await fetch("/api/firebase-config", { credentials: "same-origin" });
    if (!r.ok) return false;
    const j = await r.json();
    if (j?.apiKey && j?.authDomain && j?.projectId && j?.appId) {
      runtimeInjectedConfig = {
        apiKey: String(j.apiKey),
        authDomain: String(j.authDomain),
        projectId: String(j.projectId),
        appId: String(j.appId),
        storageBucket: j.storageBucket ? String(j.storageBucket) : undefined,
        messagingSenderId: j.messagingSenderId ? String(j.messagingSenderId) : undefined,
      };
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** אתחול מאזין + השלמת התחברות redirect אחרי חזרה מגוגל */
export async function setupCloudBackupListeners(onUserChange) {
  await loadFirebaseConfigIfNeeded();
  if (!isCloudBackupConfigured()) {
    onUserChange?.();
    return;
  }
  const r = initCloudBackup();
  if (!r.ok) {
    onUserChange?.();
    return;
  }
  try {
    await getRedirectResult(authRef);
  } catch (e) {
    console.error(e);
  }
  onCloudAuthChanged(onUserChange);
  onUserChange?.();
}

let appRef = null;
let authRef = null;
let dbRef = null;

export function isCloudBackupConfigured() {
  return readFirebaseConfigFromEnv() !== null;
}

export function initCloudBackup() {
  const cfg = readFirebaseConfigFromEnv();
  if (!cfg) return { ok: false, reason: "no-config" };
  if (appRef) return { ok: true };
  try {
    appRef = initializeApp(cfg);
    authRef = getAuth(appRef);
    dbRef = getFirestore(appRef);
    return { ok: true };
  } catch (e) {
    console.error(e);
    return { ok: false, reason: "init-failed" };
  }
}

function snapshotDocRef(uid) {
  if (!dbRef) throw new Error("Firestore not initialized");
  return doc(dbRef, "users", uid, "snapshots", "app");
}

export function collectLocalSnapshotPayload() {
  /** @type {Record<string, string>} */
  const keys = {};
  for (const k of CLOUD_SNAPSHOT_STORAGE_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) keys[k] = v;
    } catch {
      /* ignore */
    }
  }
  return keys;
}

export async function uploadCloudSnapshot(uid) {
  initCloudBackup();
  if (!dbRef || !authRef) throw new Error("Firebase not ready");
  const keys = collectLocalSnapshotPayload();
  await setDoc(snapshotDocRef(uid), {
    schemaVersion: SNAPSHOT_VERSION,
    updatedAt: serverTimestamp(),
    savedAtClient: new Date().toISOString(),
    keys,
  });
}

export async function fetchCloudSnapshot(uid) {
  initCloudBackup();
  if (!dbRef) throw new Error("Firestore not ready");
  const snap = await getDoc(snapshotDocRef(uid));
  if (!snap.exists()) return null;
  return snap.data();
}

/**
 * שחזור מלא למפתחות המעקב: מפתח שחסר בענן נמחק מקומית (כמו איפוס חלקי).
 * @param {unknown} data
 */
export function applyCloudSnapshotToLocalStorage(data) {
  if (!data || typeof data !== "object") throw new Error("נתוני גיבוי לא תקינים");
  const keys = /** @type {any} */ (data).keys;
  if (!keys || typeof keys !== "object") throw new Error("חסר מפתח keys בגיבוי");
  for (const k of CLOUD_SNAPSHOT_STORAGE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(keys, k) && typeof keys[k] === "string") {
      localStorage.setItem(k, keys[k]);
    } else {
      localStorage.removeItem(k);
    }
  }
}

export async function signInCloudWithGoogle() {
  const r = initCloudBackup();
  if (!r.ok) throw new Error("Firebase לא מוגדר");
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(authRef, provider);
  } catch (e) {
    const code = e?.code ?? "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") throw e;
    if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(authRef, provider);
      return;
    }
    throw e;
  }
}

export async function signOutCloud() {
  if (!authRef) return;
  await signOut(authRef);
}

export function getCloudUser() {
  return authRef?.currentUser ?? null;
}

/** @param {(user: import("firebase/auth").User | null) => void} callback */
export function onCloudAuthChanged(callback) {
  initCloudBackup();
  if (!authRef) return () => {};
  return onAuthStateChanged(authRef, callback);
}
