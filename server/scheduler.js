import { all, run } from "./db.js";
import { sendPush, toWebPushSubscription } from "./push.js";

export function startScheduler({ db, intervalMs = 15000, log = console }) {
  let timer = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const due = await all(
        db,
        `SELECT id, user_key, subtask_id, title, body, url, fire_at
         FROM reminders
         WHERE sent_at IS NULL AND fire_at <= ?
         ORDER BY fire_at ASC
         LIMIT 50`,
        [now],
      );
      if (due.length === 0) return;

      for (const r of due) {
        const subs = await all(
          db,
          `SELECT endpoint, p256dh, auth
           FROM subscriptions
           WHERE user_key = ?`,
          [r.user_key ?? "local"],
        );
        if (subs.length === 0) continue;

        const payload = {
          title: r.title,
          body: r.body,
          url: r.url,
        };

        let anySuccess = false;
        for (const s of subs) {
          try {
            await sendPush({ subscription: toWebPushSubscription(s), payload });
            anySuccess = true;
          } catch (e) {
            // Ignore single subscription failures; pruning could be added later.
          }
        }

        if (anySuccess) await run(db, `UPDATE reminders SET sent_at = ? WHERE id = ?`, [Date.now(), r.id]);
      }
    } finally {
      running = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  tick();

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

