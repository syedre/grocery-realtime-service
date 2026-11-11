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

function broadcastChanged(type) {
  const message = JSON.stringify({
    type,
    changedAt: new Date().toISOString(),
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

const ORDER_STATUSES = new Set([
  "placed",
  "confirmed",
  "preparing",
  "out_for_delivery",
  "delivered",
  "cancelled",
]);

async function authenticateCustomer(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const publishableKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Supabase Auth validation is not configured on the realtime service.");
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return null;

  const user = await response.json();
  return typeof user?.id === "string" ? user.id : null;
}

function broadcastOrderStatusChanged(order) {
  const message = JSON.stringify({
    type: "order_status_changed",
    orderId: order.id,
    status: order.status,
    changedAt: new Date().toISOString(),
  });

  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.authenticatedUserId === order.user_id
    ) {
      client.send(message);
    }
  }
}

app.post("/webhooks/catalog", (req, res) => {
  const expected = process.env.WEBHOOK_SECRET;
  const received = req.get("x-catalog-webhook-secret");
  if (!expected || !safeSecretMatch(received, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body ?? {};
  if (payload.schema !== "public") {
    return res.status(202).json({ ignored: true });
  }

  // Order events are sent only to sockets authenticated as the order owner.
  // The webhook contains the row data; no order details are broadcast.
  if (payload.table === "orders") {
    if (payload.type !== "UPDATE") {
      return res.status(202).json({ ignored: true });
    }

    const previous = payload.old_record ?? payload.old ?? {};
    const current = payload.record ?? payload.new ?? {};
    if (
      typeof current.id !== "string" ||
      typeof current.user_id !== "string" ||
      !ORDER_STATUSES.has(current.status) ||
      previous.status === current.status
    ) {
      return res.status(202).json({ ignored: true });
    }

    broadcastOrderStatusChanged({
      id: current.id,
      user_id: current.user_id,
      status: current.status,
    });
    return res.status(202).json({ accepted: true });
  }

  if (!["products", "product_category", "shop_settings"].includes(payload.table)) {
    return res.status(202).json({ ignored: true });
  }
  if (!["INSERT", "UPDATE", "DELETE"].includes(payload.type)) {
    return res.status(202).json({ ignored: true });
  }

  // Keep existing catalogue and shop-availability broadcasts unchanged.
  broadcastChanged(payload.table === "shop_settings" ? "shop_availability_changed" : "catalog_changed");
  return res.status(202).json({ accepted: true });
});

wss.on("connection", (socket) => {
  socket.authenticatedUserId = null;
  socket.authenticating = false;

  socket.on("message", async (data) => {
    const message = data.toString();
    if (message === "ping" && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }

    if (payload?.type !== "authenticate" || socket.authenticatedUserId || socket.authenticating) {
      return;
    }

    const accessToken = payload.accessToken;
    if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 8192) {
      socket.close(4401, "Authentication required");
      return;
    }

    socket.authenticating = true;
    try {
      const userId = await authenticateCustomer(accessToken);
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!userId) {
        socket.close(4401, "Invalid session");
        return;
      }
      socket.authenticatedUserId = userId;
      socket.send(JSON.stringify({ type: "order_socket_ready" }));
    } catch (error) {
      console.error("Order socket authentication failed:", error.message);
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, "Authentication unavailable");
    } finally {
      socket.authenticating = false;
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
  console.log(`Catalogue and order WebSocket service listening on port ${port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, "Server shutting down");
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 25_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
