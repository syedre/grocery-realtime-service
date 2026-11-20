import { WebSocket } from "ws";
import { authenticateCustomer } from "../services/supabase-auth.js";

export function broadcastOrderStatusChanged(wss, order) {
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

export function registerOrderSocket(wss) {
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
}
