import { loadPushState, savePushState } from "../lib/push-firestore.js";

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  try {
    const body = readBody(req);
    const sub = body?.subscription;
    const userKey = String(body?.userKey ?? "local");
    const endpoint = sub?.endpoint;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ error: "Invalid subscription" });
      return;
    }
    const state = await loadPushState();
    const next = (state.subscriptions || []).filter((s) => s.endpoint !== endpoint);
    next.push({ endpoint, p256dh, auth, userKey, createdAt: Date.now() });
    state.subscriptions = next;
    await savePushState(state);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "subscribe_failed", detail: String(e?.message || e) });
  }
}
