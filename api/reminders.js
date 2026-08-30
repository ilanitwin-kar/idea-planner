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
    const op = String(body?.op || "");
    const userKey = String(body?.userKey ?? "local");
    if (op !== "replace-hourly") {
      res.status(400).json({ error: "unknown_op" });
      return;
    }
    const incoming = Array.isArray(body?.reminders) ? body.reminders : [];
    const state = await loadPushState();
    const keep = (state.reminders || []).filter((r) => {
      if (r.sentAt) return true;
      if (r.userKey !== userKey) return true;
      return !String(r.id || "").startsWith("hourly:");
    });
    for (const r of incoming) {
      const id = String(r?.id || "");
      const title = String(r?.title || "").trim();
      const body = String(r?.body || "").trim();
      const url = String(r?.url || "/");
      const fireAt = Number(r?.fireAt);
      if (!id || !title || !body || !Number.isFinite(fireAt)) continue;
      keep.push({ id, userKey, title, body, url, fireAt, sentAt: null });
    }
    state.reminders = keep;
    await savePushState(state);
    res.status(200).json({ ok: true, count: incoming.length });
  } catch (e) {
    res.status(500).json({ error: "reminders_failed", detail: String(e?.message || e) });
  }
}
