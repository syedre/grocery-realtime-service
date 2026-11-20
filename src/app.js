import express from "express";
import adminPushRoutes from "./routes/admin-push.js";
import webhookRoutes from "./routes/webhooks.js";

export function createApp(wss) {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.locals.wss = wss;

  app.get("/", (_req, res) => {
    res.status(200).json({ service: "sm-mart-catalog-socket", status: "ok" });
  });

  app.use("/admin", adminPushRoutes);
  app.use("/webhooks", webhookRoutes);
  return app;
}
