import { getOrCreateVapidKeys } from "../lib/push-vapid.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  try {
    const keys = await getOrCreateVapidKeys();
    res.status(200).json({ publicKey: keys.publicKey });
  } catch (e) {
    res.status(503).json({ error: "vapid_unavailable", detail: String(e?.message || e) });
  }
}
