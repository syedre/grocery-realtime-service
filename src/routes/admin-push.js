import { Router } from "express";
import { registerAdminPushToken, removeAdminPushToken } from "../services/admin-push.js";
import { requireAdmin } from "../services/supabase-auth.js";

const router = Router();

router.post("/push-tokens", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const token = req.body?.token;
  const platform = req.body?.platform;
  if (
    typeof token !== "string" ||
    token.length < 100 ||
    token.length > 4096 ||
    !["android", "ios"].includes(platform)
  ) {
    return res.status(400).json({ error: "A valid FCM token and platform are required." });
  }
  try {
    await registerAdminPushToken(admin, token, platform);
    return res.status(200).json({ registered: true });
  } catch (error) {
    console.error("Admin FCM token registration failed:", error.message);
    return res.status(503).json({ error: "Token registration unavailable" });
  }
});

router.delete("/push-tokens", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const token = req.body?.token;
  if (typeof token !== "string" || token.length < 100 || token.length > 4096) {
    return res.status(400).json({ error: "A valid FCM token is required." });
  }
  try {
    await removeAdminPushToken(admin, token);
    return res.status(200).json({ removed: true });
  } catch (error) {
    console.error("Admin FCM token removal failed:", error.message);
    return res.status(503).json({ error: "Token removal unavailable" });
  }
});

export default router;
