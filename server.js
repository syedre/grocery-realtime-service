import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

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
  let delivered = 0;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      delivered += 1;
    }
  }
  console.info(`Broadcast ${type} to ${delivered} connected catalogue client(s).`);
}

const ORDER_STATUSES = new Set([
  "placed",
  "confirmed",
  "preparing",
  "out_for_delivery",
  "delivered",
  "cancelled",
]);

function firebaseReady() {
  return getApps().length > 0;
}

function initializeFirebaseAdmin() {
  if (firebaseReady()) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    console.warn("Firebase Admin is not configured; admin push notifications are disabled.");
    return;
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON.");
  }
  initializeApp({ credential: cert(serviceAccount) });
}

initializeFirebaseAdmin();

function firestore() {
  if (!firebaseReady()) throw new Error("Firebase Admin is not configured.");
  return getFirestore();
}

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

async function authenticateAdmin(accessToken) {
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
  if (
    typeof user?.id !== "string" ||
    typeof user?.email !== "string" ||
    user.email.trim().toLowerCase() !== "admin@gmail.com"
  ) return null;
  return { id: user.id, email: user.email };
}

async function requireAdmin(req, res) {
  const authorization = req.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const accessToken = match?.[1];
  if (!accessToken || accessToken.length < 20 || accessToken.length > 8192) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  try {
    const admin = await authenticateAdmin(accessToken);
    if (!admin) {
      res.status(403).json({ error: "Admin access only" });
      return null;
    }
    return admin;
  } catch (error) {
    console.error("Admin token authentication failed:", error.message);
    res.status(503).json({ error: "Authentication unavailable" });
    return null;
  }
}

const adminTokens = () => firestore().collection("admin_fcm_tokens");

app.post("/admin/push-tokens", async (req, res) => {
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
    const tokenId = crypto.createHash("sha256").update(token).digest("hex");
    await adminTokens().doc(tokenId).set({
      token,
      uid: admin.id,
      email: "admin@gmail.com",
      platform,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return res.status(200).json({ registered: true });
  } catch (error) {
    console.error("Admin FCM token registration failed:", error.message);
    return res.status(503).json({ error: "Token registration unavailable" });
  }
});

app.delete("/admin/push-tokens", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const token = req.body?.token;
  if (typeof token !== "string" || token.length < 100 || token.length > 4096) {
    return res.status(400).json({ error: "A valid FCM token is required." });
  }
  try {
    const tokenId = crypto.createHash("sha256").update(token).digest("hex");
    const ref = adminTokens().doc(tokenId);
    const snapshot = await ref.get();
    if (snapshot.exists && snapshot.data()?.uid === admin.id) await ref.delete();
    return res.status(200).json({ removed: true });
  } catch (error) {
    console.error("Admin FCM token removal failed:", error.message);
    return res.status(503).json({ error: "Token removal unavailable" });
  }
});

async function sendNewOrderNotification(order) {
  if (!firebaseReady()) {
    console.warn("Skipped new-order push: Firebase Admin is not configured.");
    return;
  }

  const db = firestore();
  const eventId = crypto.createHash("sha256").update(order.id).digest("hex");
  const eventRef = db.collection("admin_push_events").doc(eventId);
  const claim = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(eventRef);
    if (existing.exists) return false;
    transaction.create(eventRef, {
      orderId: order.id,
      status: "sending",
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!claim) {
    console.info(`Skipped duplicate new-order push for order ${order.id}.`);
    return;
  }

  try {
    const snapshot = await adminTokens().get();
    const docs = snapshot.docs;
    if (docs.length === 0) {
      await eventRef.set({ status: "no_registered_devices", completedAt: FieldValue.serverTimestamp() }, { merge: true });
      console.info("No registered admin FCM devices; new-order push was not sent.");
      return;
    }

    const invalidRefs = [];
    let successCount = 0;
    for (let offset = 0; offset < docs.length; offset += 500) {
      const batch = docs.slice(offset, offset + 500);
      const tokens = batch.map((doc) => doc.data().token).filter((value) => typeof value === "string");
      if (tokens.length === 0) continue;
      const response = await getMessaging().sendEachForMulticast({
        tokens,
        notification: {
          title: "New customer order",
          body: order.orderNumber ? `Order #${order.orderNumber} has been placed.` : "A new customer order has been placed.",
        },
        data: {
          type: "new_order",
          orderId: order.id,
          orderNumber: order.orderNumber ?? "",
        },
        android: { priority: "high", notification: { channelId: "sm_mart_orders", sound: "default" } },
        apns: { payload: { aps: { sound: "default" } } },
      });
      successCount += response.successCount;
      response.responses.forEach((result, index) => {
        if (
          !result.success &&
          ["messaging/invalid-registration-token", "messaging/registration-token-not-registered"].includes(result.error?.code)
        ) invalidRefs.push(batch[index].ref);
      });
    }
    if (invalidRefs.length) {
      const batch = db.batch();
      invalidRefs.forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    await eventRef.set({
      status: "sent",
      successCount,
      invalidTokenCount: invalidRefs.length,
      completedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    console.info(`New-order push processed for order ${order.id}: ${successCount} device(s) accepted.`);
  } catch (error) {
    await eventRef.delete().catch(() => {});
    throw error;
  }
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

app.post("/webhooks/catalog", async (req, res) => {
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

    broadcastOrderStatusChanged({
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
