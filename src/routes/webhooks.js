import { Router } from "express";
import { ORDER_STATUSES } from "../config/constants.js";
import { safeSecretMatch } from "../utils/security.js";
import { sendNewOrderNotification } from "../services/admin-push.js";
import { broadcastChanged } from "../websocket/catalog.js";
import { broadcastOrderStatusChanged } from "../websocket/orders.js";

const router = Router();

router.post("/catalog", async (req, res) => {
  const expected = process.env.WEBHOOK_SECRET;
  const received = req.get("x-catalog-webhook-secret");
  if (!expected || !safeSecretMatch(received, expected)) {
    console.warn("Rejected catalogue webhook: invalid or missing secret.");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body ?? {};
  console.info("Received database webhook:", {
    schema: payload.schema,
    table: payload.table,
    event: payload.type,
  });
  if (payload.schema !== "public") {
    return res.status(202).json({ ignored: true });
  }

  if (payload.table === "orders") {
    const previous = payload.old_record ?? payload.old ?? {};
    const current = payload.record ?? payload.new ?? {};
    if (payload.type === "INSERT") {
      if (typeof current.id !== "string" || current.status !== "placed") {
        return res.status(202).json({ ignored: true });
      }
      try {
        await sendNewOrderNotification({
          id: current.id,
          orderNumber: current.order_number == null ? null : String(current.order_number),
        });
        return res.status(202).json({ accepted: true, notification: "processed" });
      } catch (error) {
        console.error("New-order push notification failed:", error.message);
        return res.status(503).json({ error: "Push notification delivery failed" });
      }
    }

    if (payload.type !== "UPDATE") {
      return res.status(202).json({ ignored: true });
    }
    if (
      typeof current.id !== "string" ||
      typeof current.user_id !== "string" ||
      !ORDER_STATUSES.has(current.status) ||
      previous.status === current.status
    ) {
      return res.status(202).json({ ignored: true });
    }

    broadcastOrderStatusChanged(req.app.locals.wss, {
      id: current.id,
      user_id: current.user_id,
      status: current.status,
    });
    return res.status(202).json({ accepted: true });
  }

  if (!["products", "product_variants", "product_category", "shop_settings"].includes(payload.table)) {
    return res.status(202).json({ ignored: true });
  }
  if (!["INSERT", "UPDATE", "DELETE"].includes(payload.type)) {
    return res.status(202).json({ ignored: true });
  }

  broadcastChanged(req.app.locals.wss, payload.table === "shop_settings" ? "shop_availability_changed" : "catalog_changed");
  return res.status(202).json({ accepted: true });
});

export default router;
