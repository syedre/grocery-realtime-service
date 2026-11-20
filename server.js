import http from "node:http";
import { WebSocketServer } from "ws";
import { initializeFirebaseAdmin } from "./src/config/firebase.js";
import { createApp } from "./src/app.js";
import { registerOrderSocket } from "./src/websocket/orders.js";

initializeFirebaseAdmin();

const app = createApp();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/catalog",
  maxPayload: 1024,
  perMessageDeflate: false,
});
app.locals.wss = wss;

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
