import webpush from "web-push";

export function configureWebPush({ publicKey, privateKey, subject }) {
  if (!publicKey || !privateKey) throw new Error("Missing VAPID keys");
  webpush.setVapidDetails(subject || "mailto:example@example.com", publicKey, privateKey);
}

export function toWebPushSubscription(subRow) {
  return {
    endpoint: subRow.endpoint,
    keys: {
      p256dh: subRow.p256dh,
      auth: subRow.auth,
    },
  };
}

export async function sendPush({ subscription, payload }) {
  await webpush.sendNotification(subscription, JSON.stringify(payload));
}

