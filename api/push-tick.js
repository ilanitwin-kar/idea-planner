import { loadPushState, savePushState } from "../lib/push-firestore.js";
import { getOrCreateVapidKeys, configureSender } from "../lib/push-vapid.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  try {
    const keys = await getOrCreateVapidKeys();
    const webpush = configureSender(keys);
    const state = await loadPushState();
    const now = Date.now();
    const due = (state.reminders || []).filter((r) => !r.sentAt && Number(r.fireAt) <= now);
    let sent = 0;
    for (const r of due) {
      const payload = JSON.stringify({ title: r.title, body: r.body, url: r.url || "/" });
      let any = false;
      const subs = (state.subscriptions || []).filter((s) => !r.userKey || s.userKey === r.userKey || !s.userKey);
      const targets = subs.length ? subs : state.subscriptions || [];
      for (const s of targets) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
          );
          any = true;
        } catch (err) {
          console.warn("push send failed", String(err?.message || err));
        }
      }
      if (any) {
        r.sentAt = now;
        sent += 1;
      }
    }
    if (sent) await savePushState(state);
    res.status(200).json({ ok: true, due: due.length, sent });
  } catch (e) {
    res.status(500).json({ error: "tick_failed", detail: String(e?.message || e) });
  }
}
