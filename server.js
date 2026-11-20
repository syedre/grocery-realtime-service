import http from "node:http";
import { WebSocketServer } from "ws";
import { initializeFirebaseAdmin } from "./src/config/firebase.js";
import { createApp } from "./src/app.js";
import { registerOrderSocket } from "./src/websocket/orders.js";

initializeFirebaseAdmin();

const wss = new WebSocketServer({
  noServer: true,
  path: "/catalog",
  maxPayload: 1024,
  perMessageDeflate: false,
});

const app = createApp(wss);
const server = http.createServer(app);

// Preserve the existing /catalog WebSocket upgrade path.
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname !== "/catalog") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit("connection", webSocket, request);
  });
});

registerOrderSocket(wss);

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.readyState === 1) socket.ping();
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
