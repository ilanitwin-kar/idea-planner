import { FALLBACK_VAPID_PUBLIC_KEY } from "../lib/push-defaults.js";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || FALLBACK_VAPID_PUBLIC_KEY || "").trim();
  if (!publicKey) {
    res.status(503).json({ error: "vapid_unavailable" });
    return;
  }
  res.status(200).json({ publicKey });
}
