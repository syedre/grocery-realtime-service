import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/", (_req, res) => {
  res.status(200).json({ service: "sm-mart-catalog-socket", status: "ok" });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/catalog",
  maxPayload: 1024,
  perMessageDeflate: false,
});

function safeSecretMatch(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function broadcastCatalogChanged() {
  const message = JSON.stringify({
    type: "catalog_changed",
    changedAt: new Date().toISOString(),
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

app.post("/webhooks/catalog", (req, res) => {
  const expected = process.env.WEBHOOK_SECRET;
  const received = req.get("x-catalog-webhook-secret");
  if (!expected || !safeSecretMatch(received, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body ?? {};
  if (payload.schema !== "public" || !["products", "product_category"].includes(payload.table)) {
    return res.status(202).json({ ignored: true });
  }
  if (!["INSERT", "UPDATE", "DELETE"].includes(payload.type)) {
    return res.status(202).json({ ignored: true });
  }

  broadcastCatalogChanged();
  return res.status(202).json({ accepted: true });
});

wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    if (data.toString() === "ping" && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "pong" }));
    }
  });
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }
}, 30_000);

const port = Number(process.env.PORT) || 10000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Catalogue WebSocket service listening on port ${port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, "Server shutting down");
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 25_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
