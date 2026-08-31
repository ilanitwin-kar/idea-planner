import webpush from "web-push";
import { FALLBACK_VAPID_PRIVATE_KEY, FALLBACK_VAPID_PUBLIC_KEY } from "./push-defaults.js";

function env(name) {
  return String(process.env[name] ?? "").trim();
}

export function vapidFromEnv() {
  const publicKey = env("VAPID_PUBLIC_KEY") || FALLBACK_VAPID_PUBLIC_KEY;
  const privateKey = env("VAPID_PRIVATE_KEY") || FALLBACK_VAPID_PRIVATE_KEY;
  if (publicKey && privateKey) return { publicKey, privateKey };
  return null;
}

export function vapidSubject() {
  return env("VAPID_SUBJECT") || "mailto:ilanit@idea-planner.local";
}

export async function getOrCreateVapidKeys() {
  const keys = vapidFromEnv();
  if (!keys?.publicKey || !keys?.privateKey) throw new Error("vapid_unconfigured");
  return keys;
}

export function configureSender(keys) {
  webpush.setVapidDetails(vapidSubject(), keys.publicKey, keys.privateKey);
  return webpush;
}
