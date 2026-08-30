import webpush from "web-push";
import { loadPushState, savePushState, firestoreConfigured } from "./push-firestore.js";

function env(name) {
  return String(process.env[name] ?? "").trim();
}

export function vapidFromEnv() {
  const publicKey = env("VAPID_PUBLIC_KEY");
  const privateKey = env("VAPID_PRIVATE_KEY");
  if (publicKey && privateKey) return { publicKey, privateKey };
  return null;
}

export function vapidSubject() {
  return env("VAPID_SUBJECT") || "mailto:you@example.com";
}

export async function getOrCreateVapidKeys() {
  const fromEnv = vapidFromEnv();
  if (fromEnv) return fromEnv;
  if (!firestoreConfigured()) throw new Error("vapid_unconfigured");
  const state = await loadPushState();
  if (state.vapid?.publicKey && state.vapid?.privateKey) return state.vapid;
  const keys = webpush.generateVAPIDKeys();
  state.vapid = keys;
  await savePushState(state);
  return keys;
}

export function configureSender(keys) {
  webpush.setVapidDetails(vapidSubject(), keys.publicKey, keys.privateKey);
  return webpush;
}
